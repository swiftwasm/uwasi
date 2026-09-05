import { WASIAbi } from "../abi.js";
import { WASIFeatureProvider, WASIOptions } from "../options.js";

interface FdEntry {
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

export type StdioOptions = {
  stdin?: () => string | Uint8Array;
  stdout?: (lines: string | Uint8Array) => void;
  stderr?: (lines: string | Uint8Array) => void;
  outputBuffers?: boolean;
};

function bindStdio(
  useOptions: StdioOptions = {},
): (ReadableTextProxy | WritableTextProxy)[] {
  const outputBuffers = useOptions.outputBuffers || false;
  return [
    new ReadableTextProxy(
      useOptions.stdin ||
        (() => {
          return "";
        }),
    ),
    new WritableTextProxy(useOptions.stdout || console.log, outputBuffers),
    new WritableTextProxy(useOptions.stderr || console.error, outputBuffers),
  ];
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
export function useStdio(useOptions: StdioOptions = {}): WASIFeatureProvider {
  return (options, abi, memoryView) => {
    const fdTable = bindStdio(useOptions);
    return {
      fd_fdstat_get: (fd: number, buf: number) => {
        const fdEntry = fdTable[fd];
        if (!fdEntry) return WASIAbi.WASI_ERRNO_BADF;
        const view = memoryView();
        abi.writeFdstat(view, buf, WASIAbi.WASI_FILETYPE_CHARACTER_DEVICE, 0);
        return WASIAbi.WASI_ESUCCESS;
      },
      fd_filestat_get: (fd: number, buf: number) => {
        const fdEntry = fdTable[fd];
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
      },
    };
  };
}

type FileDescriptor = number;

// WASI preview1 rights bits. Rights fit in 30 bits, so the bit patterns are
// computed as numbers and widened to bigint (the wire type of `rights`).
const RIGHTS = {
  FD_DATASYNC: BigInt(1 << 0),
  FD_READ: BigInt(1 << 1),
  FD_SEEK: BigInt(1 << 2),
  FD_FDSTAT_SET_FLAGS: BigInt(1 << 3),
  FD_SYNC: BigInt(1 << 4),
  FD_TELL: BigInt(1 << 5),
  FD_WRITE: BigInt(1 << 6),
  FD_ADVISE: BigInt(1 << 7),
  FD_ALLOCATE: BigInt(1 << 8),
  PATH_CREATE_DIRECTORY: BigInt(1 << 9),
  PATH_CREATE_FILE: BigInt(1 << 10),
  PATH_LINK_SOURCE: BigInt(1 << 11),
  PATH_LINK_TARGET: BigInt(1 << 12),
  PATH_OPEN: BigInt(1 << 13),
  FD_READDIR: BigInt(1 << 14),
  PATH_READLINK: BigInt(1 << 15),
  PATH_RENAME_SOURCE: BigInt(1 << 16),
  PATH_RENAME_TARGET: BigInt(1 << 17),
  PATH_FILESTAT_GET: BigInt(1 << 18),
  PATH_FILESTAT_SET_SIZE: BigInt(1 << 19),
  PATH_FILESTAT_SET_TIMES: BigInt(1 << 20),
  FD_FILESTAT_GET: BigInt(1 << 21),
  FD_FILESTAT_SET_SIZE: BigInt(1 << 22),
  FD_FILESTAT_SET_TIMES: BigInt(1 << 23),
  PATH_SYMLINK: BigInt(1 << 24),
  PATH_REMOVE_DIRECTORY: BigInt(1 << 25),
  PATH_UNLINK_FILE: BigInt(1 << 26),
  POLL_FD_READWRITE: BigInt(1 << 27),
  SOCK_SHUTDOWN: BigInt(1 << 28),
  SOCK_ACCEPT: BigInt(1 << 29),
};
const BIG_ZERO = BigInt(0);
const ALL_RIGHTS = BigInt((1 << 30) - 1);
/** Rights that make sense on a regular-file (or device) fd. */
const FILE_RIGHTS =
  RIGHTS.FD_DATASYNC |
  RIGHTS.FD_READ |
  RIGHTS.FD_SEEK |
  RIGHTS.FD_FDSTAT_SET_FLAGS |
  RIGHTS.FD_SYNC |
  RIGHTS.FD_TELL |
  RIGHTS.FD_WRITE |
  RIGHTS.FD_ADVISE |
  RIGHTS.FD_ALLOCATE |
  RIGHTS.FD_FILESTAT_GET |
  RIGHTS.FD_FILESTAT_SET_SIZE |
  RIGHTS.FD_FILESTAT_SET_TIMES |
  RIGHTS.POLL_FD_READWRITE;
/** Rights that make sense on a directory fd (seek/tell/write-shaped rights are dropped). */
const DIRECTORY_RIGHTS =
  ALL_RIGHTS ^
  (RIGHTS.FD_SEEK |
    RIGHTS.FD_TELL |
    RIGHTS.FD_WRITE |
    RIGHTS.FD_ALLOCATE |
    RIGHTS.FD_FILESTAT_SET_SIZE);

interface NodeMeta {
  ino: bigint;
  atim: bigint;
  mtim: bigint;
  ctim: bigint;
}

/**
 * Represents a node in the file system that is a directory.
 */
interface DirectoryNode extends NodeMeta {
  readonly type: "dir";
  entries: Record<string, FSNode>;
}

/**
 * Represents a node in the file system that is a file.
 */
interface FileNode extends NodeMeta {
  readonly type: "file";
  content: Uint8Array;
  nlink: number;
}

/**
 * Represents a symbolic link.
 */
interface SymlinkNode extends NodeMeta {
  readonly type: "symlink";
  target: string;
}

type CharacterDeviceNode = (
  | { readonly type: "character"; kind: "stdio"; entry: FdEntry }
  | { readonly type: "character"; kind: "devnull" }
) &
  NodeMeta;

/**
 * Union type representing any node in the file system.
 */
type FSNode = DirectoryNode | FileNode | SymlinkNode | CharacterDeviceNode;

let nextIno = 1;
function nowNs(): bigint {
  return BigInt(Date.now()) * BigInt(1_000_000);
}
function stampMeta<T extends object>(node: T): T & NodeMeta {
  const meta = node as T & NodeMeta;
  if (meta.ino === undefined) {
    const now = nowNs();
    meta.ino = BigInt(nextIno++);
    meta.atim = now;
    meta.mtim = now;
    meta.ctim = now;
  }
  return meta;
}
function makeDir(): DirectoryNode {
  return stampMeta({ type: "dir" as const, entries: {} });
}
function makeFile(content: Uint8Array): FileNode {
  // Web IDL rejects views over a resizable buffer wherever it expects a
  // `BufferSource`, so those contents could never be handed back out. Copy once.
  if (isResizable(content.buffer)) {
    content = new Uint8Array(content);
  }
  // `lookup` returns the live view, so a caller can build a second file on a
  // buffer the first one owns. Disown it instead of copying: whoever grows
  // first then takes a fresh buffer, and neither can write over the other's
  // bytes by reusing spare room or zeroing after a shrink.
  ownBuffers.delete(content.buffer);
  return stampMeta({ type: "file" as const, content, nlink: 1 });
}
function makeSymlink(target: string): SymlinkNode {
  return stampMeta({ type: "symlink" as const, target });
}

const SYMLOOP_MAX = 32;

type ResolveSuccess = {
  errno?: undefined;
  /** The resolved node, or null when the final component does not exist. */
  node: FSNode | null;
  /** Directory holding the final component, when known. */
  parent: DirectoryNode | null;
  /** Final component name, when known. */
  name: string | null;
  /** The path ended in one or more slashes. */
  trailingSlash: boolean;
};
type ResolveResult = { errno: number } | ResolveSuccess;

/**
 * Resolve `path` relative to `base` with WASI preview1 sandbox semantics:
 * `.`/`..`/`//` normalize, `..` may not escape `base`, absolute paths are
 * rejected, intermediate symlinks always expand, and the final symlink
 * expands only when `followFinal`.
 */
function resolvePath(
  base: DirectoryNode,
  path: string,
  followFinal: boolean,
): ResolveResult {
  if (path.indexOf("\0") !== -1) return { errno: WASIAbi.WASI_ERRNO_INVAL };
  if (path.startsWith("/")) return { errno: WASIAbi.WASI_ERRNO_PERM };
  const trailingSlash = path.endsWith("/");
  const stack: DirectoryNode[] = [base];
  const components = path.split("/").filter((c) => c.length > 0);
  if (components.length === 0) {
    return { node: base, parent: null, name: null, trailingSlash };
  }
  let hops = 0;
  while (components.length > 0) {
    const component = components.shift()!;
    const isFinal = components.length === 0;
    const current = stack[stack.length - 1];
    if (component === ".") {
      if (isFinal) {
        return { node: current, parent: null, name: null, trailingSlash };
      }
      continue;
    }
    if (component === "..") {
      if (stack.length === 1) return { errno: WASIAbi.WASI_ERRNO_PERM };
      stack.pop();
      if (isFinal) {
        return {
          node: stack[stack.length - 1],
          parent: null,
          name: null,
          trailingSlash,
        };
      }
      continue;
    }
    const child: FSNode | undefined = current.entries[component];
    if (isFinal) {
      if (child && child.type === "symlink" && followFinal) {
        if (++hops > SYMLOOP_MAX) return { errno: WASIAbi.WASI_ERRNO_LOOP };
        if (child.target.startsWith("/")) {
          return { errno: WASIAbi.WASI_ERRNO_PERM };
        }
        const targetComponents = child.target
          .split("/")
          .filter((c) => c.length > 0);
        if (targetComponents.length === 0) {
          return { errno: WASIAbi.WASI_ERRNO_NOENT };
        }
        components.push(...targetComponents);
        continue;
      }
      return {
        node: child ?? null,
        parent: current,
        name: component,
        trailingSlash,
      };
    }
    if (!child) return { errno: WASIAbi.WASI_ERRNO_NOENT };
    if (child.type === "symlink") {
      if (++hops > SYMLOOP_MAX) return { errno: WASIAbi.WASI_ERRNO_LOOP };
      if (child.target.startsWith("/")) {
        return { errno: WASIAbi.WASI_ERRNO_PERM };
      }
      components.unshift(
        ...child.target.split("/").filter((c) => c.length > 0),
      );
      continue;
    }
    if (child.type !== "dir") return { errno: WASIAbi.WASI_ERRNO_NOTDIR };
    stack.push(child);
  }
  // Unreachable: the final component always returns above.
  return { errno: WASIAbi.WASI_ERRNO_NOENT };
}

/**
 * Represents an open file in the file system.
 */
interface OpenFile {
  node: FSNode;
  position: number;
  fdflags: number;
  rightsBase: bigint;
  rightsInheriting: bigint;
  isPreopen: boolean;
  preopenPath?: string;
}

/**
 * Type for file content that can be added to the file system.
 */
type FileContent = string | Uint8Array | Blob;

/**
 * In-memory implementation of a file system.
 */
export class MemoryFileSystem {
  private root: DirectoryNode;
  private preopenPaths: string[] = [];

  /**
   * Creates a new memory file system.
   * @param preopens Optional list of directories to pre-open
   */
  constructor(preopens?: { [guestPath: string]: string } | undefined) {
    this.root = makeDir();

    // Setup essential directories and special files
    this.ensureDir("/dev");
    this.setNode(
      "/dev/null",
      stampMeta({ type: "character", kind: "devnull" }),
    );

    // Setup preopened directories
    if (preopens) {
      Object.keys(preopens).forEach((guestPath) => {
        // there are no 'host' paths in a memory file system, so we just use the guest path.
        this.ensureDir(guestPath);
        this.preopenPaths.push(guestPath);
      });
    } else {
      this.preopenPaths.push("/");
    }
  }

  addFile(path: string, content: string | Uint8Array): void;
  addFile(path: string, content: Blob): Promise<void>;
  addFile(path: string, content: FileContent): void | Promise<void> {
    if (typeof content === "string") {
      const data = new TextEncoder().encode(content);
      this.createFile(path, data);
      return;
    } else if (globalThis.Blob && content instanceof Blob) {
      return content.arrayBuffer().then((buffer) => {
        const data = new Uint8Array(buffer);
        this.createFile(path, data);
      });
    } else {
      this.createFile(path, content as Uint8Array);
      return;
    }
  }

  /**
   * Creates a file with the specified content.
   * @param path Path where the file should be created
   * @param content Binary content of the file
   * @returns The created file node
   */
  createFile(path: string, content: Uint8Array): FileNode {
    const fileNode = makeFile(content);
    this.setNode(path, fileNode);
    return fileNode;
  }

  /**
   * Sets a node at the specified path.
   * @param path Path where the node should be set
   * @param node The node to set
   */
  setNode(path: string, node: FSNode): void {
    stampMeta(node);
    const normalizedPath = normalizePath(path);
    const parts = normalizedPath.split("/").filter((p) => p.length > 0);

    if (parts.length === 0) {
      if (node.type !== "dir") {
        throw new Error("Root must be a directory");
      }
      this.root = node;
      return;
    }

    const fileName = parts.pop()!;
    const dirPath = "/" + parts.join("/");
    const dir = this.ensureDir(dirPath);
    dir.entries[fileName] = node;
  }

  /**
   * Gets the /dev/null special device.
   * @returns The /dev/null node
   */
  getDevNull(): FSNode {
    const node = this.lookup("/dev/null");
    if (!node) throw new Error("/dev/null not found");
    return node;
  }

  /**
   * Gets the list of pre-opened paths.
   * @returns Array of pre-opened paths
   */
  getPreopenPaths(): string[] {
    return [...this.preopenPaths];
  }

  /**
   * Looks up a node at the specified path.
   * @param path Path to look up
   * @returns The node at the path, or null if not found
   */
  lookup(path: string): FSNode | null {
    const normalizedPath = normalizePath(path);
    if (normalizedPath === "/") return this.root;

    const parts = normalizedPath.split("/").filter((p) => p.length > 0);
    let current: FSNode = this.root;

    for (const part of parts) {
      if (current.type !== "dir") return null;
      current = current.entries[part];
      if (!current) return null;
    }

    return current;
  }

  /**
   * Resolves a relative path from a directory with full WASI semantics.
   */
  resolve(dir: DirectoryNode, relativePath: string): FSNode | null {
    const result = resolvePath(dir, relativePath, true);
    if ("errno" in result && result.errno !== undefined) return null;
    return (result as ResolveSuccess).node;
  }

  /**
   * Ensures a directory exists at the specified path, creating it if necessary.
   * @param path Path to the directory
   * @returns The directory node
   */
  ensureDir(path: string): DirectoryNode {
    const normalizedPath = normalizePath(path);
    const parts = normalizedPath.split("/").filter((p) => p.length > 0);
    let current: DirectoryNode = this.root;

    for (const part of parts) {
      if (!current.entries[part]) {
        current.entries[part] = makeDir();
      }

      const next = current.entries[part];
      if (next.type !== "dir") {
        throw new Error(`"${part}" is not a directory`);
      }

      current = next;
    }

    return current;
  }

  /**
   * Creates a file in a directory.
   * @param dir Parent directory
   * @param relativePath Path relative to the directory
   * @returns The created file node
   */
  createFileIn(dir: DirectoryNode, relativePath: string): FileNode {
    const normalizedPath = normalizePath(relativePath);
    const parts = normalizedPath.split("/").filter((p) => p.length > 0);

    if (parts.length === 0) {
      throw new Error("Cannot create a file with an empty name");
    }

    const fileName = parts.pop()!;
    let current = dir;

    for (const part of parts) {
      if (!current.entries[part]) {
        current.entries[part] = makeDir();
      }

      const next = current.entries[part];
      if (next.type !== "dir") {
        throw new Error(`"${part}" is not a directory`);
      }

      current = next;
    }

    const fileNode = makeFile(new Uint8Array(0));
    current.entries[fileName] = fileNode;
    return fileNode;
  }

  removeEntry(path: string): void {
    const normalizedPath = normalizePath(path);
    const parts = normalizedPath.split("/").filter((p) => p.length > 0);
    let parentDir = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (parentDir.type !== "dir") return;
      parentDir = parentDir.entries[part] as DirectoryNode;
    }

    const fileName = parts[parts.length - 1];
    delete parentDir.entries[fileName];
  }
}

/**
 * Normalizes a path by removing duplicate slashes and trailing slashes.
 * @param path Path to normalize
 * @returns Normalized path
 */
function normalizePath(path: string): string {
  // Handle empty path
  if (!path) return "/";

  const parts = path.split("/").filter((p) => p.length > 0);
  const normalizedParts: string[] = [];

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      normalizedParts.pop();
      continue;
    }
    normalizedParts.push(part);
  }
  if (normalizedParts.length === 0) return "/";

  const normalized = "/" + normalizedParts.join("/");
  return normalized;
}

function filetypeOf(node: FSNode): number {
  switch (node.type) {
    case "dir":
      return WASIAbi.WASI_FILETYPE_DIRECTORY;
    case "file":
      return WASIAbi.WASI_FILETYPE_REGULAR_FILE;
    case "symlink":
      return WASIAbi.WASI_FILETYPE_SYMBOLIC_LINK;
    case "character":
      return WASIAbi.WASI_FILETYPE_CHARACTER_DEVICE;
  }
}

const MEMFS_DEV = BigInt(1);

function statOf(node: FSNode): {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  atim: bigint;
  mtim: bigint;
  ctim: bigint;
} {
  let size = 0;
  let nlink = 1;
  if (node.type === "file") {
    size = node.content.byteLength;
    nlink = node.nlink;
  } else if (node.type === "symlink") {
    size = new TextEncoder().encode(node.target).byteLength;
  }
  return {
    dev: MEMFS_DEV,
    ino: node.ino,
    nlink: BigInt(nlink),
    size: BigInt(size),
    atim: node.atim,
    mtim: node.mtim,
    ctim: node.ctim,
  };
}

/**
 * Resize a file's backing buffer, zero-filling any growth. Returns an errno.
 *
 * A guest chooses this size, so it can ask for one no JavaScript engine will
 * allocate. Both failures return an errno rather than throw: an exception
 * raised inside an import unwinds through the guest and traps the module,
 * which leaves the guest no way to see the error or recover from it.
 */
const MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER;

function resizeFile(node: FileNode, size: number): number {
  // Anything that is not a whole, non-negative count of bytes is a bad
  // argument, whatever its magnitude: `NaN`, a fraction, `Infinity`, or a
  // negative. Only a well-formed size that is simply too big is a large file.
  if (!Number.isInteger(size) || size < 0) return WASIAbi.WASI_ERRNO_INVAL;
  // Above 2^53 a size no longer survives the trip through a JS number, so it
  // can be neither honoured nor reported back accurately.
  if (size > MAX_FILE_SIZE) return WASIAbi.WASI_ERRNO_FBIG;
  if (size === node.content.byteLength) return WASIAbi.WASI_ESUCCESS;

  try {
    node.content = resizeContent(node.content, size);
  } catch (error) {
    // The engine refused the allocation. For a filesystem held in memory,
    // that is the same condition as a full disk.
    if (error instanceof RangeError) return WASIAbi.WASI_ERRNO_NOSPC;
    throw error;
  }
  node.mtim = nowNs();
  return WASIAbi.WASI_ESUCCESS;
}

/** Whether `buffer` can be resized after the fact. Typed here to avoid a newer lib. */
function isResizable(buffer: ArrayBufferLike): boolean {
  return (buffer as { resizable?: boolean }).resizable === true;
}

/** Buffers allocated here, whose spare room is safe to grow into. */
const ownBuffers = new WeakSet<ArrayBufferLike>();

/** Spare room after `data` in a buffer this module owns, or 0. */
function ownCapacity(data: Uint8Array): number {
  if (!ownBuffers.has(data.buffer) || data.byteOffset !== 0) return 0;
  return data.buffer.byteLength;
}

/**
 * Return a `Uint8Array` of `newSize` bytes holding as much of `data` as fits.
 *
 * Files are stored in a buffer with room to spare, and the view describes only
 * the part in use. An append then re-views the same buffer instead of copying
 * the file, so N bytes of small writes cost O(N) rather than O(N^2).
 *
 * Solves the problem reported in #12, which Cheng Shao also fixed for
 * bjorn3/browser_wasi_shim in #95. That fix reserves the spare room with a
 * resizable `ArrayBuffer`; this one uses a plain oversized buffer, because Web
 * IDL rejects a view backed by a resizable buffer wherever it expects a
 * `BufferSource` (https://webidl.spec.whatwg.org/#AllowResizable). A plain
 * buffer needs no such guard, so nothing has to be copied before an embedder
 * reads it.
 */
function resizeContent(data: Uint8Array, newSize: number): Uint8Array {
  if (data.byteLength === newSize) return data;

  const capacity = ownCapacity(data);

  // Growing into spare room. Zero what a previous shrink may have left there.
  // Past roughly a doubling a fresh buffer is cheaper: its pages arrive zeroed.
  if (
    newSize > data.byteLength &&
    newSize <= capacity &&
    newSize - data.byteLength <= data.byteLength
  ) {
    const grown = new Uint8Array(data.buffer, 0, newSize);
    grown.fill(0, data.byteLength);
    return grown;
  }

  // Shrinking. Re-view in place, unless most of the buffer would go to waste.
  if (newSize < data.byteLength && capacity !== 0 && newSize * 4 >= capacity) {
    return new Uint8Array(data.buffer, 0, newSize);
  }

  const buffer = new ArrayBuffer(
    newSize < data.byteLength
      ? newSize
      : Math.max(newSize, data.byteLength * 2),
  );
  ownBuffers.add(buffer);
  const next = new Uint8Array(buffer, 0, newSize);
  next.set(newSize < data.byteLength ? data.subarray(0, newSize) : data);
  return next;
}

/** fstflags validation shared by fd/path filestat_set_times. */
function validateFstflags(fstflags: number): boolean {
  const atimBoth =
    (fstflags & WASIAbi.WASI_FSTFLAGS_ATIM) !== 0 &&
    (fstflags & WASIAbi.WASI_FSTFLAGS_ATIM_NOW) !== 0;
  const mtimBoth =
    (fstflags & WASIAbi.WASI_FSTFLAGS_MTIM) !== 0 &&
    (fstflags & WASIAbi.WASI_FSTFLAGS_MTIM_NOW) !== 0;
  return !(atimBoth || mtimBoth);
}

function applyTimes(
  node: FSNode,
  atim: bigint,
  mtim: bigint,
  fstflags: number,
): void {
  const now = nowNs();
  if (fstflags & WASIAbi.WASI_FSTFLAGS_ATIM) node.atim = atim;
  if (fstflags & WASIAbi.WASI_FSTFLAGS_ATIM_NOW) node.atim = now;
  if (fstflags & WASIAbi.WASI_FSTFLAGS_MTIM) node.mtim = mtim;
  if (fstflags & WASIAbi.WASI_FSTFLAGS_MTIM_NOW) node.mtim = now;
}

/**
 * Creates a feature provider that implements a complete in-memory file system.
 *
 * This provides implementations for all file descriptor and path-related WASI
 * functions, including `fd_read`, `fd_write`, `fd_seek`, `fd_tell`, `fd_close`,
 * `path_open`, and more to support a full featured file system environment.
 *
 * ```js
 * const wasi = new WASI({
 *   features: [useMemoryFS()],
 * });
 * ```
 *
 * You can provide a pre-configured file system instance:
 *
 * ```js
 * const fs = new MemoryFileSystem();
 * fs.addFile("/hello.txt", "Hello, world!");
 *
 * const wasi = new WASI({
 *   features: [useMemoryFS({ withFileSystem: fs })],
 * });
 * ```
 *
 * You can also combine it with standard IO:
 *
 * ```js
 * const wasi = new WASI({
 *   features: [
 *     useMemoryFS({
 *       withStdio: {
 *         stdout: (lines) => document.write(lines),
 *         stderr: (lines) => document.write(lines),
 *       }
 *     })
 *   ],
 * });
 * ```
 *
 * @param useOptions - Configuration options for the memory file system
 * @param useOptions.withFileSystem - Optional pre-configured file system instance
 * @param useOptions.withStdio - Optional standard I/O configuration
 * @returns A WASI feature provider implementing file system functionality
 */
export function useMemoryFS(
  useOptions: {
    withFileSystem?: MemoryFileSystem;
    withStdio?: StdioOptions;
  } = {},
): WASIFeatureProvider {
  return (
    wasiOptions: WASIOptions,
    abi: WASIAbi,
    memoryView: () => DataView,
  ) => {
    const fileSystem =
      useOptions.withFileSystem || new MemoryFileSystem(wasiOptions.preopens);
    const files = new Map<FileDescriptor, OpenFile>();

    bindStdio(useOptions.withStdio || {}).forEach((entry, fd) => {
      files.set(fd, {
        node: stampMeta({ type: "character", kind: "stdio", entry }),
        position: 0,
        fdflags: 0,
        rightsBase:
          RIGHTS.FD_READ |
          RIGHTS.FD_WRITE |
          RIGHTS.FD_FDSTAT_SET_FLAGS |
          RIGHTS.FD_FILESTAT_GET |
          RIGHTS.POLL_FD_READWRITE,
        rightsInheriting: BIG_ZERO,
        isPreopen: false,
      });
    });

    let nextFd = 3;
    for (const preopenPath of fileSystem.getPreopenPaths()) {
      const node = fileSystem.lookup(preopenPath);
      if (node && node.type === "dir") {
        files.set(nextFd, {
          node,
          position: 0,
          fdflags: 0,
          rightsBase: DIRECTORY_RIGHTS,
          rightsInheriting: ALL_RIGHTS,
          isPreopen: true,
          preopenPath,
        });
        nextFd++;
      }
    }

    const getFile = (fd: FileDescriptor): OpenFile | null =>
      files.get(fd) ?? null;

    /** Resolve a path syscall's dirfd + path pair. */
    const resolveAt = (
      fd: number,
      pathPtr: number,
      pathLen: number,
      followFinal: boolean,
    ):
      | { errno: number }
      | ({ errno?: undefined; dir: OpenFile } & ResolveSuccess) => {
      const dir = getFile(fd);
      if (!dir) return { errno: WASIAbi.WASI_ERRNO_BADF };
      if (dir.node.type !== "dir") {
        return { errno: WASIAbi.WASI_ERRNO_NOTDIR };
      }
      const view = memoryView();
      const path = abi.readString(view, pathPtr, pathLen);
      const result = resolvePath(dir.node, path, followFinal);
      if (result.errno !== undefined) return { errno: result.errno };
      return { dir, ...result };
    };

    return {
      fd_advise: (
        fd: number,
        _offset: bigint,
        _len: bigint,
        advice: number,
      ) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        if (advice > 5) return WASIAbi.WASI_ERRNO_INVAL;
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_allocate: (fd: number, offset: bigint, len: bigint) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        if (file.node.type === "dir") return WASIAbi.WASI_ERRNO_ISDIR;
        if (file.node.type !== "file") return WASIAbi.WASI_ERRNO_NOTSUP;
        const end = Number(offset) + Number(len);
        if (end > file.node.content.byteLength) {
          const errno = resizeFile(file.node, end);
          if (errno !== WASIAbi.WASI_ESUCCESS) return errno;
        }
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_close: (fd: number) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        if (file.node.type === "character" && file.node.kind === "stdio") {
          file.node.entry.close();
        }
        files.delete(fd);
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_datasync: (fd: number) => {
        return getFile(fd) ? WASIAbi.WASI_ESUCCESS : WASIAbi.WASI_ERRNO_BADF;
      },

      fd_sync: (fd: number) => {
        return getFile(fd) ? WASIAbi.WASI_ESUCCESS : WASIAbi.WASI_ERRNO_BADF;
      },

      fd_fdstat_get: (fd: number, buf: number) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        const view = memoryView();
        view.setUint8(buf, filetypeOf(file.node));
        view.setUint16(buf + 2, file.fdflags, true);
        view.setBigUint64(buf + 8, file.rightsBase, true);
        view.setBigUint64(buf + 16, file.rightsInheriting, true);
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_fdstat_set_flags: (fd: number, flags: number) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        file.fdflags = flags;
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_fdstat_set_rights: (fd: number, base: bigint, inheriting: bigint) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        // Rights may only shrink, never grow.
        if (
          (base & (ALL_RIGHTS ^ file.rightsBase)) !== BIG_ZERO ||
          (inheriting & (ALL_RIGHTS ^ file.rightsInheriting)) !== BIG_ZERO
        ) {
          return WASIAbi.WASI_ERRNO_NOTCAPABLE;
        }
        file.rightsBase = base;
        file.rightsInheriting = inheriting;
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_filestat_get: (fd: number, buf: number) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        const view = memoryView();
        abi.writeFilestat(view, buf, filetypeOf(file.node), statOf(file.node));
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_filestat_set_size: (fd: number, size: bigint) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        if (file.node.type !== "file") return WASIAbi.WASI_ERRNO_INVAL;
        const errno = resizeFile(file.node, Number(size));
        if (errno !== WASIAbi.WASI_ESUCCESS) return errno;
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_filestat_set_times: (
        fd: number,
        atim: bigint,
        mtim: bigint,
        fstflags: number,
      ) => {
        if (!validateFstflags(fstflags)) return WASIAbi.WASI_ERRNO_INVAL;
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        applyTimes(file.node, atim, mtim, fstflags);
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_pread: (
        fd: number,
        iovs: number,
        iovsLen: number,
        offset: bigint,
        nread: number,
      ) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        if (file.node.type === "dir") return WASIAbi.WASI_ERRNO_ISDIR;
        if (file.node.type !== "file") return WASIAbi.WASI_ERRNO_SPIPE;
        if ((file.rightsBase & RIGHTS.FD_READ) === BIG_ZERO) {
          return WASIAbi.WASI_ERRNO_NOTCAPABLE;
        }
        const view = memoryView();
        const iovViews = abi.iovViews(view, iovs, iovsLen);
        const data = file.node.content;
        let position = Number(offset);
        let totalRead = 0;
        for (const buf of iovViews) {
          const available = data.byteLength - position;
          if (available <= 0) break;
          const count = Math.min(buf.byteLength, available);
          buf.set(data.subarray(position, position + count));
          position += count;
          totalRead += count;
          if (count < buf.byteLength) break;
        }
        view.setUint32(nread, totalRead, true);
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_pwrite: (
        fd: number,
        iovs: number,
        iovsLen: number,
        offset: bigint,
        nwritten: number,
      ) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        if (file.node.type === "dir") return WASIAbi.WASI_ERRNO_ISDIR;
        if (file.node.type !== "file") return WASIAbi.WASI_ERRNO_SPIPE;
        if ((file.rightsBase & RIGHTS.FD_WRITE) === BIG_ZERO) {
          return WASIAbi.WASI_ERRNO_NOTCAPABLE;
        }
        const view = memoryView();
        const iovViews = abi.iovViews(view, iovs, iovsLen);
        // pwrite writes at the explicit offset, ignoring APPEND and the
        // current cursor, and never moves the cursor.
        let position = Number(offset);
        const total = iovViews.reduce((acc, b) => acc + b.byteLength, 0);
        if (position + total > file.node.content.byteLength) {
          const errno = resizeFile(file.node, position + total);
          if (errno !== WASIAbi.WASI_ESUCCESS) return errno;
        }
        for (const buf of iovViews) {
          file.node.content.set(buf, position);
          position += buf.byteLength;
        }
        file.node.mtim = nowNs();
        view.setUint32(nwritten, total, true);
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_read: (fd: number, iovs: number, iovsLen: number, nread: number) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        if (file.node.type === "dir") return WASIAbi.WASI_ERRNO_ISDIR;
        const view = memoryView();
        const iovViews = abi.iovViews(view, iovs, iovsLen);

        if (file.node.type === "character") {
          if (file.node.kind === "stdio") {
            const bytesRead = file.node.entry.readv(iovViews);
            view.setUint32(nread, bytesRead, true);
          } else {
            view.setUint32(nread, 0, true);
          }
          return WASIAbi.WASI_ESUCCESS;
        }
        if (file.node.type !== "file") return WASIAbi.WASI_ERRNO_INVAL;
        if ((file.rightsBase & RIGHTS.FD_READ) === BIG_ZERO) {
          return WASIAbi.WASI_ERRNO_NOTCAPABLE;
        }

        const data = file.node.content;
        let totalRead = 0;
        for (const buf of iovViews) {
          const available = data.byteLength - file.position - totalRead;
          if (available <= 0) break;
          const count = Math.min(buf.byteLength, available);
          const start = file.position + totalRead;
          buf.set(data.subarray(start, start + count));
          totalRead += count;
          if (count < buf.byteLength) break;
        }
        file.position += totalRead;
        view.setUint32(nread, totalRead, true);
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_readdir: (
        fd: number,
        buf: number,
        bufLen: number,
        cookie: bigint,
        bufusedPtr: number,
      ) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        if (file.node.type !== "dir") return WASIAbi.WASI_ERRNO_NOTDIR;
        const view = memoryView();
        const dir = file.node;
        const names = Object.keys(dir.entries);
        const entries: { name: string; ino: bigint; type: number }[] = [
          {
            name: ".",
            ino: dir.ino,
            type: WASIAbi.WASI_FILETYPE_DIRECTORY,
          },
          {
            name: "..",
            ino: dir.ino,
            type: WASIAbi.WASI_FILETYPE_DIRECTORY,
          },
          ...names.map((name) => ({
            name,
            ino: dir.entries[name].ino,
            type: filetypeOf(dir.entries[name]),
          })),
        ];
        const bufferEnd = buf + bufLen;
        let ptr = buf;
        for (let i = Number(cookie); i < entries.length; i++) {
          const written = abi.writeDirent(view, ptr, bufferEnd, {
            nextCookie: BigInt(i + 1),
            ino: entries[i].ino,
            name: entries[i].name,
            type: entries[i].type,
          });
          ptr += written;
          if (ptr >= bufferEnd) break;
        }
        view.setUint32(bufusedPtr, ptr - buf, true);
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_renumber: (from: number, to: number) => {
        const source = getFile(from);
        if (!source) return WASIAbi.WASI_ERRNO_BADF;
        if (from === to) return WASIAbi.WASI_ESUCCESS;
        // The destination must be an already-open fd; renumber replaces it.
        const target = getFile(to);
        if (!target) return WASIAbi.WASI_ERRNO_BADF;
        if (target.node.type === "character" && target.node.kind === "stdio") {
          target.node.entry.close();
        }
        files.set(to, source);
        files.delete(from);
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_seek: (
        fd: number,
        offset: bigint,
        whence: number,
        newOffsetPtr: number,
      ) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        if (file.node.type === "dir") return WASIAbi.WASI_ERRNO_ISDIR;
        if (file.node.type !== "file") return WASIAbi.WASI_ERRNO_SPIPE;
        const delta = Number(offset);
        let position: number;
        switch (whence) {
          case WASIAbi.WASI_WHENCE_SET:
            position = delta;
            break;
          case WASIAbi.WASI_WHENCE_CUR:
            position = file.position + delta;
            break;
          case WASIAbi.WASI_WHENCE_END:
            position = file.node.content.byteLength + delta;
            break;
          default:
            return WASIAbi.WASI_ERRNO_INVAL;
        }
        if (position < 0) return WASIAbi.WASI_ERRNO_INVAL;
        file.position = position;
        const view = memoryView();
        view.setBigUint64(newOffsetPtr, BigInt(position), true);
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_tell: (fd: number, offsetPtr: number) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        if (file.node.type === "dir") return WASIAbi.WASI_ERRNO_ISDIR;
        if (file.node.type !== "file") return WASIAbi.WASI_ERRNO_SPIPE;
        const view = memoryView();
        view.setBigUint64(offsetPtr, BigInt(file.position), true);
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_write: (
        fd: number,
        iovs: number,
        iovsLen: number,
        nwritten: number,
      ) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        if (file.node.type === "dir") return WASIAbi.WASI_ERRNO_ISDIR;
        const view = memoryView();
        const iovViews = abi.iovViews(view, iovs, iovsLen);

        if (file.node.type === "character") {
          if (file.node.kind === "stdio") {
            const bytesWritten = file.node.entry.writev(iovViews);
            view.setUint32(nwritten, bytesWritten, true);
          } else {
            const total = iovViews.reduce((acc, b) => acc + b.byteLength, 0);
            view.setUint32(nwritten, total, true);
          }
          return WASIAbi.WASI_ESUCCESS;
        }
        if (file.node.type !== "file") return WASIAbi.WASI_ERRNO_INVAL;
        if ((file.rightsBase & RIGHTS.FD_WRITE) === BIG_ZERO) {
          return WASIAbi.WASI_ERRNO_NOTCAPABLE;
        }

        let position =
          (file.fdflags & WASIAbi.WASI_FDFLAGS_APPEND) !== 0
            ? file.node.content.byteLength
            : file.position;
        const total = iovViews.reduce((acc, b) => acc + b.byteLength, 0);
        if (position + total > file.node.content.byteLength) {
          const errno = resizeFile(file.node, position + total);
          if (errno !== WASIAbi.WASI_ESUCCESS) return errno;
        }
        for (const buf of iovViews) {
          file.node.content.set(buf, position);
          position += buf.byteLength;
        }
        file.position = position;
        file.node.mtim = nowNs();
        view.setUint32(nwritten, total, true);
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_prestat_get: (fd: number, buf: number) => {
        const file = getFile(fd);
        if (!file || !file.isPreopen) return WASIAbi.WASI_ERRNO_BADF;
        const view = memoryView();
        view.setUint8(buf, 0); // preopentype::dir
        view.setUint32(buf + 4, abi.byteLength(file.preopenPath || ""), true);
        return WASIAbi.WASI_ESUCCESS;
      },

      fd_prestat_dir_name: (fd: number, pathPtr: number, pathLen: number) => {
        const file = getFile(fd);
        if (!file || !file.isPreopen) return WASIAbi.WASI_ERRNO_BADF;
        const view = memoryView();
        const name = file.preopenPath || "";
        if (pathLen < abi.byteLength(name)) return WASIAbi.WASI_ERRNO_INVAL;
        abi.writeString(view, name, pathPtr);
        return WASIAbi.WASI_ESUCCESS;
      },

      path_create_directory: (fd: number, pathPtr: number, pathLen: number) => {
        const resolved = resolveAt(fd, pathPtr, pathLen, false);
        if (resolved.errno !== undefined) return resolved.errno;
        if (resolved.node) return WASIAbi.WASI_ERRNO_EXIST;
        if (!resolved.parent || !resolved.name) {
          return WASIAbi.WASI_ERRNO_NOENT;
        }
        resolved.parent.entries[resolved.name] = makeDir();
        return WASIAbi.WASI_ESUCCESS;
      },

      path_filestat_get: (
        fd: number,
        flags: number,
        pathPtr: number,
        pathLen: number,
        buf: number,
      ) => {
        const follow = (flags & WASIAbi.WASI_LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0;
        const resolved = resolveAt(fd, pathPtr, pathLen, follow);
        if (resolved.errno !== undefined) return resolved.errno;
        if (!resolved.node) return WASIAbi.WASI_ERRNO_NOENT;
        const view = memoryView();
        abi.writeFilestat(
          view,
          buf,
          filetypeOf(resolved.node),
          statOf(resolved.node),
        );
        return WASIAbi.WASI_ESUCCESS;
      },

      path_filestat_set_times: (
        fd: number,
        flags: number,
        pathPtr: number,
        pathLen: number,
        atim: bigint,
        mtim: bigint,
        fstflags: number,
      ) => {
        if (!validateFstflags(fstflags)) return WASIAbi.WASI_ERRNO_INVAL;
        const follow = (flags & WASIAbi.WASI_LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0;
        const resolved = resolveAt(fd, pathPtr, pathLen, follow);
        if (resolved.errno !== undefined) return resolved.errno;
        if (!resolved.node) return WASIAbi.WASI_ERRNO_NOENT;
        applyTimes(resolved.node, atim, mtim, fstflags);
        return WASIAbi.WASI_ESUCCESS;
      },

      path_link: (
        oldFd: number,
        oldFlags: number,
        oldPathPtr: number,
        oldPathLen: number,
        newFd: number,
        newPathPtr: number,
        newPathLen: number,
      ) => {
        // Following the source symlink for a hard link is not supported.
        if ((oldFlags & WASIAbi.WASI_LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0) {
          return WASIAbi.WASI_ERRNO_INVAL;
        }
        const source = resolveAt(oldFd, oldPathPtr, oldPathLen, false);
        if (source.errno !== undefined) return source.errno;
        if (!source.node) return WASIAbi.WASI_ERRNO_NOENT;
        if (source.node.type === "dir") return WASIAbi.WASI_ERRNO_PERM;
        const target = resolveAt(newFd, newPathPtr, newPathLen, false);
        if (target.errno !== undefined) return target.errno;
        if (target.trailingSlash) return WASIAbi.WASI_ERRNO_NOENT;
        if (target.node) return WASIAbi.WASI_ERRNO_EXIST;
        if (!target.parent || !target.name) return WASIAbi.WASI_ERRNO_NOENT;
        target.parent.entries[target.name] = source.node;
        if (source.node.type === "file") source.node.nlink++;
        return WASIAbi.WASI_ESUCCESS;
      },

      path_open: (
        dirfd: number,
        dirflags: number,
        pathPtr: number,
        pathLen: number,
        oflags: number,
        fsRightsBase: bigint,
        fsRightsInheriting: bigint,
        fdflags: number,
        openedFdPtr: number,
      ) => {
        const follow =
          (dirflags & WASIAbi.WASI_LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0;
        const resolved = resolveAt(dirfd, pathPtr, pathLen, follow);
        if (resolved.errno !== undefined) return resolved.errno;
        const dir = resolved.dir;
        // Requested rights must not exceed what the directory can bequeath.
        if (
          ((fsRightsBase | fsRightsInheriting) &
            (ALL_RIGHTS ^ dir.rightsInheriting)) !==
          BIG_ZERO
        ) {
          return WASIAbi.WASI_ERRNO_NOTCAPABLE;
        }

        let node = resolved.node;
        if (node) {
          if (node.type === "symlink") {
            // An unfollowed final symlink cannot be opened.
            return WASIAbi.WASI_ERRNO_LOOP;
          }
          if ((oflags & WASIAbi.WASI_OFLAGS_EXCL) !== 0) {
            return WASIAbi.WASI_ERRNO_EXIST;
          }
          if (node.type !== "dir") {
            if (resolved.trailingSlash) return WASIAbi.WASI_ERRNO_NOTDIR;
            if ((oflags & WASIAbi.WASI_OFLAGS_DIRECTORY) !== 0) {
              return WASIAbi.WASI_ERRNO_NOTDIR;
            }
          }
          if (
            node.type === "dir" &&
            (fsRightsBase & RIGHTS.FD_WRITE) !== BIG_ZERO
          ) {
            return WASIAbi.WASI_ERRNO_ISDIR;
          }
          if ((oflags & WASIAbi.WASI_OFLAGS_TRUNC) !== 0) {
            if (node.type !== "file") return WASIAbi.WASI_ERRNO_ISDIR;
            if ((dir.rightsBase & RIGHTS.PATH_FILESTAT_SET_SIZE) === BIG_ZERO) {
              return WASIAbi.WASI_ERRNO_NOTCAPABLE;
            }
            const errno = resizeFile(node, 0);
            if (errno !== WASIAbi.WASI_ESUCCESS) return errno;
          }
        } else {
          if ((oflags & WASIAbi.WASI_OFLAGS_CREAT) === 0) {
            return WASIAbi.WASI_ERRNO_NOENT;
          }
          if (resolved.trailingSlash) return WASIAbi.WASI_ERRNO_NOENT;
          if (!resolved.parent || !resolved.name) {
            return WASIAbi.WASI_ERRNO_NOENT;
          }
          const created = makeFile(new Uint8Array(0));
          resolved.parent.entries[resolved.name] = created;
          node = created;
        }

        const typeMask = node.type === "dir" ? DIRECTORY_RIGHTS : FILE_RIGHTS;
        files.set(nextFd, {
          node,
          position: 0,
          fdflags,
          rightsBase: fsRightsBase & typeMask,
          rightsInheriting:
            node.type === "dir"
              ? fsRightsInheriting
              : fsRightsInheriting & FILE_RIGHTS,
          isPreopen: false,
        });
        const view = memoryView();
        view.setUint32(openedFdPtr, nextFd, true);
        nextFd++;
        return WASIAbi.WASI_ESUCCESS;
      },

      path_readlink: (
        fd: number,
        pathPtr: number,
        pathLen: number,
        buf: number,
        bufLen: number,
        bufusedPtr: number,
      ) => {
        const resolved = resolveAt(fd, pathPtr, pathLen, false);
        if (resolved.errno !== undefined) return resolved.errno;
        if (!resolved.node) return WASIAbi.WASI_ERRNO_NOENT;
        if (resolved.node.type !== "symlink") return WASIAbi.WASI_ERRNO_INVAL;
        const view = memoryView();
        const bytes = new TextEncoder().encode(resolved.node.target);
        // Silently truncate to the buffer; no NUL terminator is written.
        const count = Math.min(bytes.byteLength, bufLen);
        new Uint8Array(view.buffer, buf, count).set(bytes.subarray(0, count));
        view.setUint32(bufusedPtr, count, true);
        return WASIAbi.WASI_ESUCCESS;
      },

      path_remove_directory: (fd: number, pathPtr: number, pathLen: number) => {
        const resolved = resolveAt(fd, pathPtr, pathLen, false);
        if (resolved.errno !== undefined) return resolved.errno;
        if (!resolved.node) return WASIAbi.WASI_ERRNO_NOENT;
        if (resolved.node.type !== "dir") return WASIAbi.WASI_ERRNO_NOTDIR;
        if (!resolved.parent || !resolved.name) {
          return WASIAbi.WASI_ERRNO_INVAL;
        }
        if (Object.keys(resolved.node.entries).length > 0) {
          return WASIAbi.WASI_ERRNO_NOTEMPTY;
        }
        delete resolved.parent.entries[resolved.name];
        return WASIAbi.WASI_ESUCCESS;
      },

      path_rename: (
        fd: number,
        oldPathPtr: number,
        oldPathLen: number,
        newFd: number,
        newPathPtr: number,
        newPathLen: number,
      ) => {
        const source = resolveAt(fd, oldPathPtr, oldPathLen, false);
        if (source.errno !== undefined) return source.errno;
        if (!source.node) return WASIAbi.WASI_ERRNO_NOENT;
        if (!source.parent || !source.name) return WASIAbi.WASI_ERRNO_INVAL;
        if (source.trailingSlash && source.node.type !== "dir") {
          return WASIAbi.WASI_ERRNO_NOTDIR;
        }
        const target = resolveAt(newFd, newPathPtr, newPathLen, false);
        if (target.errno !== undefined) return target.errno;
        if (!target.parent || !target.name) return WASIAbi.WASI_ERRNO_INVAL;
        if (target.trailingSlash && source.node.type !== "dir") {
          return WASIAbi.WASI_ERRNO_NOTDIR;
        }
        if (target.node) {
          if (source.node.type === "dir") {
            if (target.node.type !== "dir") return WASIAbi.WASI_ERRNO_NOTDIR;
            if (Object.keys(target.node.entries).length > 0) {
              return WASIAbi.WASI_ERRNO_NOTEMPTY;
            }
          } else {
            if (target.node.type === "dir") return WASIAbi.WASI_ERRNO_ISDIR;
            if (target.node.type === "file") target.node.nlink--;
          }
        }
        delete source.parent.entries[source.name];
        target.parent.entries[target.name] = source.node;
        return WASIAbi.WASI_ESUCCESS;
      },

      path_symlink: (
        oldPathPtr: number,
        oldPathLen: number,
        fd: number,
        newPathPtr: number,
        newPathLen: number,
      ) => {
        const view = memoryView();
        const targetPath = abi.readString(view, oldPathPtr, oldPathLen);
        if (targetPath.indexOf("\0") !== -1) return WASIAbi.WASI_ERRNO_INVAL;
        // Absolute symlink targets could escape the sandbox.
        if (targetPath.startsWith("/")) return WASIAbi.WASI_ERRNO_PERM;
        const resolved = resolveAt(fd, newPathPtr, newPathLen, false);
        if (resolved.errno !== undefined) return resolved.errno;
        if (resolved.node) {
          if (resolved.node.type !== "dir" && resolved.trailingSlash) {
            return WASIAbi.WASI_ERRNO_NOTDIR;
          }
          return WASIAbi.WASI_ERRNO_EXIST;
        }
        if (resolved.trailingSlash) return WASIAbi.WASI_ERRNO_NOENT;
        if (!resolved.parent || !resolved.name) {
          return WASIAbi.WASI_ERRNO_NOENT;
        }
        resolved.parent.entries[resolved.name] = makeSymlink(targetPath);
        return WASIAbi.WASI_ESUCCESS;
      },

      path_unlink_file: (fd: number, pathPtr: number, pathLen: number) => {
        const resolved = resolveAt(fd, pathPtr, pathLen, false);
        if (resolved.errno !== undefined) return resolved.errno;
        if (!resolved.node) return WASIAbi.WASI_ERRNO_NOENT;
        if (resolved.node.type === "dir") return WASIAbi.WASI_ERRNO_ISDIR;
        if (resolved.trailingSlash) return WASIAbi.WASI_ERRNO_NOTDIR;
        if (!resolved.parent || !resolved.name) {
          return WASIAbi.WASI_ERRNO_INVAL;
        }
        if (resolved.node.type === "file") resolved.node.nlink--;
        delete resolved.parent.entries[resolved.name];
        return WASIAbi.WASI_ESUCCESS;
      },

      sock_shutdown: (fd: number, _how: number) => {
        const file = getFile(fd);
        if (!file) return WASIAbi.WASI_ERRNO_BADF;
        // Nothing in this file system is a socket.
        return WASIAbi.WASI_ERRNO_NOTSOCK;
      },
    };
  };
}

export function useFS(useOptions: { fs: any }): WASIFeatureProvider {
  return (options: WASIOptions, abi: WASIAbi, memoryView: () => DataView) => {
    // TODO: implement fd_* syscalls using `useOptions.fs`
    return {};
  };
}
