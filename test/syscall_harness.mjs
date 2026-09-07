// Drive `bindFSSyscalls`'s imports directly against a backend, the way a
// wasm guest would, without instantiating a module. Mirrors the seam
// harness in fs_backend.test.mjs but works for any backend + file system
// pair (the OPFS tests bind the backend's own MemoryFileSystem mirror).
import { bindFSSyscalls } from "../lib/esm/features/fd.js";
import { WASIAbi } from "../lib/esm/abi.js";

export const PREOPEN_FD = 3;

const PATH_PTR = 0;
const PATH2_PTR = 128;
const IOVEC_PTR = 256;
const DATA_PTR = 512;
const OUT_PTR = 4096;
const FILESTAT_PTR = 4224;

const ALL_RIGHTS = BigInt((1 << 30) - 1);

export function bindImports(backend, fileSystem, withStdio = {}) {
  const memory = new ArrayBuffer(65536);
  const view = new DataView(memory);
  const bytes = new Uint8Array(memory);
  const imports = bindFSSyscalls(
    backend,
    fileSystem,
    withStdio,
    new WASIAbi(),
    () => view,
  );
  return { imports, view, bytes };
}

function putPath(h, name, ptr = PATH_PTR) {
  const path = new TextEncoder().encode(name);
  h.bytes.set(path, ptr);
  return path.length;
}

export function sysOpen(h, name, oflags = 0, dirfd = PREOPEN_FD) {
  const len = putPath(h, name);
  const errno = h.imports.path_open(
    dirfd,
    0,
    PATH_PTR,
    len,
    oflags,
    ALL_RIGHTS,
    ALL_RIGHTS,
    0,
    OUT_PTR,
  );
  return { errno, fd: h.view.getUint32(OUT_PTR, true) };
}

export function sysCreate(h, name, dirfd = PREOPEN_FD) {
  return sysOpen(h, name, WASIAbi.WASI_OFLAGS_CREAT, dirfd);
}

export function sysWrite(h, fd, data) {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  h.bytes.set(bytes, DATA_PTR);
  h.view.setUint32(IOVEC_PTR, DATA_PTR, true);
  h.view.setUint32(IOVEC_PTR + 4, bytes.length, true);
  const errno = h.imports.fd_write(fd, IOVEC_PTR, 1, OUT_PTR + 8);
  return { errno, written: h.view.getUint32(OUT_PTR + 8, true) };
}

export function sysRead(h, fd, length) {
  h.view.setUint32(IOVEC_PTR, DATA_PTR, true);
  h.view.setUint32(IOVEC_PTR + 4, length, true);
  const errno = h.imports.fd_read(fd, IOVEC_PTR, 1, OUT_PTR + 8);
  const count = h.view.getUint32(OUT_PTR + 8, true);
  return {
    errno,
    data: h.bytes.slice(DATA_PTR, DATA_PTR + count),
  };
}

export function sysReadText(h, fd, length = 256) {
  const { errno, data } = sysRead(h, fd, length);
  return { errno, text: new TextDecoder().decode(data) };
}

export function sysSeekStart(h, fd) {
  return h.imports.fd_seek(fd, 0n, WASIAbi.WASI_WHENCE_SET, OUT_PTR + 16);
}

export function sysClose(h, fd) {
  return h.imports.fd_close(fd);
}

export function sysSync(h, fd) {
  return h.imports.fd_sync(fd);
}

export function sysDatasync(h, fd) {
  return h.imports.fd_datasync(fd);
}

export function sysUnlink(h, name, dirfd = PREOPEN_FD) {
  const len = putPath(h, name);
  return h.imports.path_unlink_file(dirfd, PATH_PTR, len);
}

export function sysMkdir(h, name, dirfd = PREOPEN_FD) {
  const len = putPath(h, name);
  return h.imports.path_create_directory(dirfd, PATH_PTR, len);
}

export function sysRename(h, from, to, dirfd = PREOPEN_FD) {
  const fromLen = putPath(h, from, PATH_PTR);
  const toLen = putPath(h, to, PATH2_PTR);
  return h.imports.path_rename(
    dirfd,
    PATH_PTR,
    fromLen,
    dirfd,
    PATH2_PTR,
    toLen,
  );
}

export function sysLink(h, from, to, dirfd = PREOPEN_FD) {
  const fromLen = putPath(h, from, PATH_PTR);
  const toLen = putPath(h, to, PATH2_PTR);
  return h.imports.path_link(
    dirfd,
    0,
    PATH_PTR,
    fromLen,
    dirfd,
    PATH2_PTR,
    toLen,
  );
}

/** path_filestat_get following symlinks; returns errno and the file size. */
export function sysStat(h, name, dirfd = PREOPEN_FD) {
  const len = putPath(h, name);
  const errno = h.imports.path_filestat_get(
    dirfd,
    WASIAbi.WASI_LOOKUPFLAGS_SYMLINK_FOLLOW,
    PATH_PTR,
    len,
    FILESTAT_PTR,
  );
  // filestat layout: dev(8) ino(8) filetype(1+7) nlink(8) size(8) ...
  const size = errno === 0 ? h.view.getBigUint64(FILESTAT_PTR + 32, true) : 0n;
  return { errno, size: Number(size) };
}
