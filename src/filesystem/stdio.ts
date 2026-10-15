import { WASIAbi } from "../abi.js";
import { WASIFeatureProvider } from "../options.js";

export interface FdEntry {
  writev(iovs: Uint8Array[]): number;
  readv(iovs: Uint8Array[]): number;
  close(): void;
}

class WritableTextProxy implements FdEntry {
  private decoder = new TextDecoder("utf-8");
  constructor(
    private readonly handler: (lines: string | Uint8Array) => void,
    private readonly outputBuffers: boolean,
  ) {}

  writev(iovs: Uint8Array[]): number {
    const totalBufferSize = iovs.reduce((acc, iov) => acc + iov.byteLength, 0);
    let offset = 0;
    const concatBuffer = new Uint8Array(totalBufferSize);
    for (const buffer of iovs) {
      concatBuffer.set(buffer, offset);
      offset += buffer.byteLength;
    }

    if (this.outputBuffers) {
      this.handler(concatBuffer);
    } else {
      const lines = this.decoder.decode(concatBuffer);
      this.handler(lines);
    }

    return concatBuffer.length;
  }
  readv(_iovs: Uint8Array[]): number {
    return 0;
  }
  close(): void {}
}

export class ReadableTextProxy implements FdEntry {
  private encoder = new TextEncoder();
  private pending: Uint8Array | null = null;
  constructor(private readonly consume: () => string | Uint8Array) {}

  writev(_iovs: Uint8Array[]): number {
    return 0;
  }
  consumePending(pending: Uint8Array, requestLength: number): Uint8Array {
    if (pending.byteLength < requestLength) {
      this.pending = null;
      return pending;
    } else {
      const result = pending.slice(0, requestLength);
      this.pending = pending.slice(requestLength);
      return result;
    }
  }
  readv(iovs: Uint8Array[]): number {
    let read = 0;
    for (const buffer of iovs) {
      let remaining = buffer.byteLength;
      if (this.pending) {
        const consumed = this.consumePending(this.pending, remaining);
        buffer.set(consumed, 0);
        remaining -= consumed.byteLength;
        read += consumed.byteLength;
      }
      while (remaining > 0) {
        const newData = this.consume();
        let bytes: Uint8Array;

        if (newData instanceof Uint8Array) {
          bytes = newData;
        } else {
          bytes = this.encoder.encode(newData);
        }

        if (bytes.length == 0) {
          return read;
        }
        if (bytes.length > remaining) {
          buffer.set(bytes.slice(0, remaining), buffer.byteLength - remaining);
          this.pending = bytes.slice(remaining);
          read += remaining;
          remaining = 0;
        } else {
          buffer.set(bytes, buffer.byteLength - remaining);
          read += bytes.length;
          remaining -= bytes.length;
        }
      }
    }
    return read;
  }
  close(): void {}
}

/**
 * Wrap a stdio handler so it receives whole lines, without the newline.
 *
 * A handler is called with whatever the guest passed to one `fd_write`, which
 * is not a line: one `printf` can arrive split across writes, and one write
 * can carry several lines. Pass `outputBuffers: true` alongside so the bytes
 * arrive undecoded, and a character split across two writes is joined before
 * decoding instead of becoming replacement characters.
 *
 * Nothing flushes automatically. Text with no trailing newline is held until
 * one arrives, so a guest that exits mid-line leaves it unwritten; call
 * `flush()` to emit it.
 */
export function lineBuffered(
  write: (line: string) => void,
): ((chunk: string | Uint8Array) => void) & { flush(): void } {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let pending = "";

  const emitCompleteLines = () => {
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      write(line);
    }
  };

  const handler = (chunk: string | Uint8Array) => {
    if (typeof chunk === "string") {
      // A string cannot complete a half-decoded character, so drain the
      // decoder first rather than letting those bytes span this text.
      pending += decoder.decode() + chunk;
    } else {
      pending += decoder.decode(chunk, { stream: true });
    }
    emitCompleteLines();
  };

  handler.flush = () => {
    pending += decoder.decode();
    if (pending.length > 0) {
      write(pending);
      pending = "";
    }
  };

  return handler;
}

export type CharacterDeviceHandler =
  | { read: () => string | Uint8Array }
  | { write: (lines: string | Uint8Array) => void };

export type StdioOptions = {
  stdin?: () => string | Uint8Array;
  stdout?: (lines: string | Uint8Array) => void;
  stderr?: (lines: string | Uint8Array) => void;
  outputBuffers?: boolean;
  extraFds?: { [fd: number]: CharacterDeviceHandler };
};

export function bindStdio(useOptions: StdioOptions = {}): Map<number, FdEntry> {
  const outputBuffers = useOptions.outputBuffers || false;
  const fdTable = new Map<number, FdEntry>([
    [
      0,
      new ReadableTextProxy(
        useOptions.stdin ||
          (() => {
            return "";
          }),
      ),
    ],
    [1, new WritableTextProxy(useOptions.stdout || console.log, outputBuffers)],
    [
      2,
      new WritableTextProxy(useOptions.stderr || console.error, outputBuffers),
    ],
  ]);
  for (const [key, handler] of Object.entries(useOptions.extraFds || {})) {
    const fd = Number(key);
    if (!Number.isInteger(fd) || fd < 3 || fd > 0xffffffff) {
      throw new RangeError(
        `extraFds keys must be fd numbers from 3 to 4294967295, got ${key}`,
      );
    }
    fdTable.set(
      fd,
      "read" in handler
        ? new ReadableTextProxy(handler.read)
        : new WritableTextProxy(handler.write, outputBuffers),
    );
  }
  return fdTable;
}

/**
 * Create a feature provider that provides fd related features only for standard output and standard error
 * It uses JavaScript's `console` APIs as backend by default.
 *
 * ```js
 * const wasi = new WASI({
 *   features: [useStdio()],
 * });
 * ```
 *
 * To use a custom backend, you can pass stdout and stderr handlers.
 *
 * ```js
 * const wasi = new WASI({
 *   features: [
 *     useStdio({
 *       stdout: (lines) => document.write(lines),
 *       stderr: (lines) => document.write(lines),
 *     })
 *   ],
 * });
 * ```
 *
 * To give the guest more character devices than stdio, pass `extraFds`:
 *
 * ```js
 * const wasi = new WASI({
 *   features: [
 *     useStdio({
 *       extraFds: { 3: { write: (lines) => report.push(lines) } },
 *     })
 *   ],
 * });
 * ```
 *
 * This provides `fd_write`, `fd_prestat_get` and `fd_prestat_dir_name` implementations to make libc work with minimal effort.
 */
export function useStdio(useOptions: StdioOptions = {}): WASIFeatureProvider {
  return (options, abi, memoryView) => {
    const fdTable = bindStdio(useOptions);
    return {
      fd_fdstat_get: (fd: number, buf: number) => {
        const fdEntry = fdTable.get(fd);
        if (!fdEntry) return WASIAbi.WASI_ERRNO_BADF;
        const view = memoryView();
        abi.writeFdstat(view, buf, WASIAbi.WASI_FILETYPE_CHARACTER_DEVICE, 0);
        return WASIAbi.WASI_ESUCCESS;
      },
      fd_filestat_get: (fd: number, buf: number) => {
        const fdEntry = fdTable.get(fd);
        if (!fdEntry) return WASIAbi.WASI_ERRNO_BADF;
        const view = memoryView();
        abi.writeFilestat(view, buf, WASIAbi.WASI_FILETYPE_CHARACTER_DEVICE);
        return WASIAbi.WASI_ESUCCESS;
      },
      fd_prestat_get: (fd: number, buf: number) => {
        return WASIAbi.WASI_ERRNO_BADF;
      },
      fd_prestat_dir_name: (fd: number, buf: number) => {
        return WASIAbi.WASI_ERRNO_BADF;
      },
      fd_write: (
        fd: number,
        iovs: number,
        iovsLen: number,
        nwritten: number,
      ) => {
        const fdEntry = fdTable.get(fd);
        if (!fdEntry) return WASIAbi.WASI_ERRNO_BADF;
        const view = memoryView();
        const iovsBuffers = abi.iovViews(view, iovs, iovsLen);
        const writtenValue = fdEntry.writev(iovsBuffers);
        view.setUint32(nwritten, writtenValue, true);
        return WASIAbi.WASI_ESUCCESS;
      },
      fd_read: (fd: number, iovs: number, iovsLen: number, nread: number) => {
        const fdEntry = fdTable.get(fd);
        if (!fdEntry) return WASIAbi.WASI_ERRNO_BADF;
        const view = memoryView();
        const iovsBuffers = abi.iovViews(view, iovs, iovsLen);
        const readValue = fdEntry.readv(iovsBuffers);
        view.setUint32(nread, readValue, true);
        return WASIAbi.WASI_ESUCCESS;
      },
    };
  };
}
