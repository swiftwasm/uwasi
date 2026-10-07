// Call the filesystem syscalls the way a wasm guest would, against any
// backend and namespace, without a wasm module.
import { bindFSSyscalls } from "../lib/esm/filesystem/handlers.js";
import { WASIAbi } from "../lib/esm/abi.js";

export const PREOPEN_FD = 3;

const PATH_PTR = 0;
const PATH2_PTR = 128;
const IOVEC_PTR = 256;
const DATA_PTR = 512;
const OUT_PTR = 4096;
const FILESTAT_PTR = 4224;

const ALL_RIGHTS = BigInt((1 << 30) - 1);

export function bindImports(backend, fileSystem) {
  const memory = new ArrayBuffer(65536);
  const view = new DataView(memory);
  const bytes = new Uint8Array(memory);
  const imports = bindFSSyscalls(
    backend,
    fileSystem,
    {},
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

export function sysOpen(h, name, oflags = 0) {
  const len = putPath(h, name);
  const errno = h.imports.path_open(
    PREOPEN_FD,
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

export function sysCreate(h, name) {
  return sysOpen(h, name, WASIAbi.WASI_OFLAGS_CREAT);
}

/** fd_write with one iovec per string in `chunks`. */
export function sysWrite(h, fd, ...chunks) {
  const encoder = new TextEncoder();
  let data = DATA_PTR;
  chunks.forEach((chunk, i) => {
    const bytes = encoder.encode(chunk);
    h.bytes.set(bytes, data);
    h.view.setUint32(IOVEC_PTR + i * 8, data, true);
    h.view.setUint32(IOVEC_PTR + i * 8 + 4, bytes.length, true);
    data += bytes.length;
  });
  h.view.setUint32(OUT_PTR + 8, 0, true);
  const errno = h.imports.fd_write(fd, IOVEC_PTR, chunks.length, OUT_PTR + 8);
  return { errno, written: h.view.getUint32(OUT_PTR + 8, true) };
}

export function sysReadText(h, fd, length = 256) {
  h.view.setUint32(IOVEC_PTR, DATA_PTR, true);
  h.view.setUint32(IOVEC_PTR + 4, length, true);
  const errno = h.imports.fd_read(fd, IOVEC_PTR, 1, OUT_PTR + 8);
  const count = errno === 0 ? h.view.getUint32(OUT_PTR + 8, true) : 0;
  const data = h.bytes.slice(DATA_PTR, DATA_PTR + count);
  return { errno, text: new TextDecoder().decode(data) };
}

export function sysSeekStart(h, fd) {
  return h.imports.fd_seek(fd, 0n, WASIAbi.WASI_WHENCE_SET, OUT_PTR + 16);
}

export function sysClose(h, fd) {
  return h.imports.fd_close(fd);
}

export function sysUnlink(h, name) {
  const len = putPath(h, name);
  return h.imports.path_unlink_file(PREOPEN_FD, PATH_PTR, len);
}

export function sysLink(h, from, to) {
  const fromLen = putPath(h, from, PATH_PTR);
  const toLen = putPath(h, to, PATH2_PTR);
  return h.imports.path_link(
    PREOPEN_FD,
    0,
    PATH_PTR,
    fromLen,
    PREOPEN_FD,
    PATH2_PTR,
    toLen,
  );
}

/** path_filestat_get without following a final symlink. */
export function sysLstat(h, name) {
  const len = putPath(h, name);
  const errno = h.imports.path_filestat_get(
    PREOPEN_FD,
    0,
    PATH_PTR,
    len,
    FILESTAT_PTR,
  );
  if (errno !== 0) return { errno };
  // filestat layout: dev(8) ino(8) filetype(1+7) nlink(8) size(8) ...
  return {
    errno,
    nlink: Number(h.view.getBigUint64(FILESTAT_PTR + 24, true)),
    size: Number(h.view.getBigUint64(FILESTAT_PTR + 32, true)),
  };
}
