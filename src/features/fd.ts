import { WASIAbi } from "../abi";
import { WASIFeatureProvider, WASIOptions } from "../options";

interface FdEntry {
    writev(iovs: Uint8Array[]): number
    readv(iovs: Uint8Array[]): number
    close(): void
}

class WritableTextProxy implements FdEntry {
    private decoder = new TextDecoder('utf-8');
    constructor(private readonly handler: (lines: string) => void) { }

    writev(iovs: Uint8Array[]): number {
        const totalBufferSize = iovs.reduce((acc, iov) => acc + iov.byteLength, 0);
        let offset = 0;
        const concatBuffer = new Uint8Array(totalBufferSize);
        for (const buffer of iovs) {
            concatBuffer.set(buffer, offset);
            offset += buffer.length;
        }

        const lines = this.decoder.decode(concatBuffer);
        this.handler(lines);
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
    constructor(private readonly consume: () => string) { }

    writev(_iovs: Uint8Array[]): number {
        return 0;
    }
    consumePending(pending: Uint8Array, requestLength: number): Uint8Array {
        if (pending.byteLength < requestLength) {
            this.pending = null
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
                const newText = this.consume();
                const bytes = this.encoder.encode(newText);
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
 * This provides `fd_write`, `fd_prestat_get` and `fd_prestat_dir_name` implementations to make libc work with minimal effort.
 */
export function useStdio(
    useOptions: {
        stdin?: () => string,
        stdout?: (lines: string) => void,
        stderr?: (lines: string) => void,
    } = {}
): WASIFeatureProvider {
    return (options, abi, memoryView) => {
        const fdTable = [
            new ReadableTextProxy(useOptions.stdin || (() => { return "" })),
            new WritableTextProxy(useOptions.stdout || console.log),
            new WritableTextProxy(useOptions.stderr || console.error),
        ]
        return {
            fd_prestat_get: (fd: number, buf: number) => {
                return WASIAbi.WASI_ERRNO_BADF;
            },
            fd_prestat_dir_name: (fd: number, buf: number) => {
                return WASIAbi.WASI_ERRNO_BADF;
            },
            fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number) => {
                const fdEntry = fdTable[fd];
                if (!fdEntry) return WASIAbi.WASI_ERRNO_BADF;
                const view = memoryView();
                const iovsBuffers = abi.iovViews(view, iovs, iovsLen);
                const writtenValue = fdEntry.writev(iovsBuffers);
                view.setUint32(nwritten, writtenValue, true);
                return WASIAbi.WASI_ESUCCESS;
            },
            fd_read: (fd: number, iovs: number, iovsLen: number, nread: number) => {
                const fdEntry = fdTable[fd];
                if (!fdEntry) return WASIAbi.WASI_ERRNO_BADF;
                const view = memoryView();
                const iovsBuffers = abi.iovViews(view, iovs, iovsLen);
                const readValue = fdEntry.readv(iovsBuffers);
                view.setUint32(nread, readValue, true);
                return WASIAbi.WASI_ESUCCESS;
            }
        }
    };
}

export function useFS(useOptions: { fs: any }): WASIFeatureProvider {
    return (options: WASIOptions, abi: WASIAbi, memoryView: () => DataView) => {
        // TODO: implement fd_* syscalls using `useOptions.fs`
        return {}
    }
}
