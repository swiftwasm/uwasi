import { WASIAbi } from "../abi.js";
import { FSBackend } from "./backend.js";
import { FSError } from "./error.js";
import {
  DirectoryNode,
  FileNode,
  FSNode,
  MemoryFileSystem,
  nowNs,
  stampMeta,
  makeDir,
  makeFile,
  makeSymlink,
  resolvePath,
  ResolveSuccess,
} from "./namespace.js";
import { bindStdio, StdioOptions } from "./stdio.js";

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

/** Whether `dir` is `root` itself or lies anywhere inside its subtree. */
function isWithin(dir: DirectoryNode, root: DirectoryNode): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === dir) return true;
    for (const name of Object.keys(current.entries)) {
      const child = current.entries[name];
      if (child.type === "dir") pending.push(child);
    }
  }
  return false;
}

const MEMFS_DEV = BigInt(1);

function statOf(
  backend: FSBackend,
  node: FSNode,
): {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  atim: bigint;
  mtim: bigint;
  ctim: bigint;
} {
  let size = 0;
  const nlink = node.type === "dir" ? 1 : node.nlink;
  if (node.type === "file") {
    size = backend.fileSize(node);
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

const MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER;

/**
 * Resize a file to `size` bytes, zero-filling any growth. Returns an errno
 * for a size that no file can have; the backend throws `FSError` when the
 * storage fails.
 *
 * A guest chooses this size, so it can ask for any value. Every failure
 * reaches the guest as an errno: an exception raised inside an import
 * unwinds through the guest and traps the module, which leaves the guest
 * no way to see the error or recover from it.
 */
function resizeFile(backend: FSBackend, node: FileNode, size: number): number {
  // Anything that is not a whole, non-negative count of bytes is a bad
  // argument, whatever its magnitude: `NaN`, a fraction, `Infinity`, or a
  // negative. Only a well-formed size that is simply too big is a large file.
  if (!Number.isInteger(size) || size < 0) return WASIAbi.WASI_ERRNO_INVAL;
  // Above 2^53 a size no longer survives the trip through a JS number, so it
  // can be neither honoured nor reported back accurately.
  if (size > MAX_FILE_SIZE) return WASIAbi.WASI_ERRNO_FBIG;
  if (size === backend.fileSize(node)) return WASIAbi.WASI_ESUCCESS;
  backend.resize(node, size);
  node.mtim = nowNs();
  return WASIAbi.WASI_ESUCCESS;
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
 * Bind the file-system syscalls to `backend`, which holds the bytes and
 * persists namespace changes, and to `fileSystem`, which supplies the node
 * tree and preopens. Path resolution, rights, the fd table and errno
 * mapping are the same for every backend.
 */
export function bindFSSyscalls(
  backend: FSBackend,
  fileSystem: MemoryFileSystem,
  withStdio: StdioOptions,
  abi: WASIAbi,
  memoryView: () => DataView,
): WebAssembly.ModuleImports {
  const files = new Map<FileDescriptor, OpenFile>();

  bindStdio(withStdio).forEach((entry, fd) => {
    files.set(fd, {
      node: stampMeta({ type: "character", kind: "stdio", entry, nlink: 1 }),
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

  // wasi-libc finds preopens by probing fd_prestat_get upward from 3 and
  // stops at the first fd that is not one, so preopens must be contiguous
  // from 3 and extra stdio fds cannot sit among them.
  let nextFd = 3;
  for (const preopenPath of fileSystem.getPreopenPaths()) {
    const node = fileSystem.lookup(preopenPath);
    if (node && node.type === "dir") {
      if (files.has(nextFd)) {
        throw new RangeError(
          `extraFds must be above the preopened directories, got ${nextFd}, which is taken by preopen "${preopenPath}"`,
        );
      }
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

  /**
   * Write `iovViews` to `node` from `position`, and return the end position.
   * The backend extends the file itself, so there is no resize first: that
   * would cost a backend with real files an extra truncate. Each iovec is
   * one `writeAt`. When a later one fails, the earlier ones stay written,
   * and the syscall reports only the errno.
   */
  const writeIovecs = (
    node: FileNode,
    iovViews: Uint8Array[],
    position: number,
  ): number => {
    for (const buf of iovViews) {
      if (buf.byteLength === 0) continue;
      backend.writeAt(node, buf, position);
      position += buf.byteLength;
    }
    node.mtim = nowNs();
    return position;
  };

  /** Read into `iovViews` from `position`; returns the bytes read. */
  const readIovecs = (
    node: FileNode,
    iovViews: Uint8Array[],
    position: number,
  ): number => {
    let totalRead = 0;
    for (const buf of iovViews) {
      const count = backend.readAt(node, buf, position + totalRead);
      totalRead += count;
      if (count < buf.byteLength) break;
    }
    return totalRead;
  };

  /** Release an fd's hold on its node: close stdio, or tell the backend. */
  const release = (file: OpenFile): void => {
    if (file.node.type === "character" && file.node.kind === "stdio") {
      file.node.entry.close();
    } else if (file.node.type === "file") {
      backend.closeFile(file.node);
    }
  };

  const syscalls: WebAssembly.ModuleImports = {
    fd_advise: (fd: number, _offset: bigint, _len: bigint, advice: number) => {
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
      if (end > backend.fileSize(file.node)) {
        return resizeFile(backend, file.node, end);
      }
      return WASIAbi.WASI_ESUCCESS;
    },

    fd_close: (fd: number) => {
      const file = getFile(fd);
      if (!file) return WASIAbi.WASI_ERRNO_BADF;
      // Release the fd first, so that it is gone even if the close fails.
      files.delete(fd);
      release(file);
      return WASIAbi.WASI_ESUCCESS;
    },

    fd_datasync: (fd: number) => {
      const file = getFile(fd);
      if (!file) return WASIAbi.WASI_ERRNO_BADF;
      if (file.node.type === "file" || file.node.type === "dir") {
        backend.datasync(file.node);
      }
      return WASIAbi.WASI_ESUCCESS;
    },

    fd_sync: (fd: number) => {
      const file = getFile(fd);
      if (!file) return WASIAbi.WASI_ERRNO_BADF;
      if (file.node.type === "file" || file.node.type === "dir") {
        backend.sync(file.node);
      }
      return WASIAbi.WASI_ESUCCESS;
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
      abi.writeFilestat(
        view,
        buf,
        filetypeOf(file.node),
        statOf(backend, file.node),
      );
      return WASIAbi.WASI_ESUCCESS;
    },

    fd_filestat_set_size: (fd: number, size: bigint) => {
      const file = getFile(fd);
      if (!file) return WASIAbi.WASI_ERRNO_BADF;
      if (file.node.type !== "file") return WASIAbi.WASI_ERRNO_INVAL;
      return resizeFile(backend, file.node, Number(size));
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
      const totalRead = readIovecs(file.node, iovViews, Number(offset));
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
      const position = Number(offset);
      const total = iovViews.reduce((acc, b) => acc + b.byteLength, 0);
      // Writing nothing changes nothing, not even the size past EOF.
      if (total === 0) {
        view.setUint32(nwritten, 0, true);
        return WASIAbi.WASI_ESUCCESS;
      }
      if (position + total > MAX_FILE_SIZE) return WASIAbi.WASI_ERRNO_FBIG;
      writeIovecs(file.node, iovViews, position);
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

      const totalRead = readIovecs(file.node, iovViews, file.position);
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
      files.set(to, source);
      files.delete(from);
      release(target);
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
          position = backend.fileSize(file.node) + delta;
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

    fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number) => {
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

      const position =
        (file.fdflags & WASIAbi.WASI_FDFLAGS_APPEND) !== 0
          ? backend.fileSize(file.node)
          : file.position;
      const total = iovViews.reduce((acc, b) => acc + b.byteLength, 0);
      // Writing nothing changes nothing, not even the size past EOF.
      if (total === 0) {
        view.setUint32(nwritten, 0, true);
        return WASIAbi.WASI_ESUCCESS;
      }
      if (position + total > MAX_FILE_SIZE) return WASIAbi.WASI_ERRNO_FBIG;
      file.position = writeIovecs(file.node, iovViews, position);
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
      backend.createChild(resolved.parent, resolved.name, makeDir());
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
        statOf(backend, resolved.node),
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
      backend.linkChild(target.parent, target.name, source.node);
      source.node.nlink++;
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
      const follow = (dirflags & WASIAbi.WASI_LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0;
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
      let truncate = false;
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
          truncate = true;
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
        backend.createChild(resolved.parent, resolved.name, created);
        node = created;
      }

      if (node.type === "file") {
        backend.openFile(node);
        // Truncate only once the file is open, so that a backend can hold
        // its handle for the resize. If the resize fails, nothing holds it.
        try {
          if (truncate) resizeFile(backend, node, 0);
        } catch (error) {
          backend.closeFile(node);
          throw error;
        }
      }

      const typeMask = node.type === "dir" ? DIRECTORY_RIGHTS : FILE_RIGHTS;
      while (files.has(nextFd)) nextFd++;
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
      backend.removeChild(resolved.parent, resolved.name);
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
      // POSIX: when both names already link the same node, rename succeeds
      // and does nothing else.
      if (target.node === source.node) return WASIAbi.WASI_ESUCCESS;
      // A directory cannot move into its own subtree: it would detach
      // itself, and everything in it, from the tree.
      if (source.node.type === "dir" && isWithin(target.parent, source.node)) {
        return WASIAbi.WASI_ERRNO_INVAL;
      }
      if (target.node) {
        if (source.node.type === "dir") {
          if (target.node.type !== "dir") return WASIAbi.WASI_ERRNO_NOTDIR;
          if (Object.keys(target.node.entries).length > 0) {
            return WASIAbi.WASI_ERRNO_NOTEMPTY;
          }
        } else {
          if (target.node.type === "dir") return WASIAbi.WASI_ERRNO_ISDIR;
        }
      }
      backend.renameChild(
        source.parent,
        source.name,
        target.parent,
        target.name,
      );
      if (target.node && target.node.type !== "dir") target.node.nlink--;
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
      backend.createChild(
        resolved.parent,
        resolved.name,
        makeSymlink(targetPath),
      );
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
      backend.removeChild(resolved.parent, resolved.name);
      resolved.node.nlink--;
      return WASIAbi.WASI_ESUCCESS;
    },

    sock_shutdown: (fd: number, _how: number) => {
      const file = getFile(fd);
      if (!file) return WASIAbi.WASI_ERRNO_BADF;
      // Nothing in this file system is a socket.
      return WASIAbi.WASI_ERRNO_NOTSOCK;
    },
  };

  // A backend reports a storage failure by throwing `FSError`. Return its
  // errno to the guest; let any other exception through, as a bug.
  for (const [name, syscall] of Object.entries(syscalls)) {
    if (typeof syscall !== "function") continue;
    syscalls[name] = (...args: (number | bigint)[]) => {
      try {
        return syscall(...args);
      } catch (error) {
        if (error instanceof FSError) return error.errno;
        throw error;
      }
    };
  }
  return syscalls;
}
