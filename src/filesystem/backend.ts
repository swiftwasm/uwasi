import { DirectoryNode, FileNode, FSNode } from "./namespace.js";

/**
 * The storage behind the filesystem syscalls.
 *
 * The syscall layer owns path resolution, rights, the fd table, seek
 * positions, link counts and timestamps. A backend owns two things: the
 * bytes of each file, and the changes to the namespace. The syscall layer
 * never reads or writes `FileNode.content`; only `MemoryFSBackend` keeps
 * the bytes there.
 *
 * Every method is synchronous, because the syscalls are synchronous. Finish
 * any asynchronous setup before the guest starts.
 *
 * To report a storage failure, a method throws `FSError` with a WASI errno.
 * The syscall returns that errno to the guest.
 *
 * Path resolution and `fd_readdir` read `DirectoryNode.entries` directly.
 * So the namespace methods must update `entries`, as well as any copy the
 * backend keeps. If a namespace method throws, every `entries` it touched
 * must keep the same names, the same node objects and the same order as
 * before; the order is the `fd_readdir` order. The syscall layer does not
 * repair `entries`.
 *
 * An fd can outlive the name of its file. After `removeChild`, or a
 * `renameChild` that replaces the file, open fds still read and write it.
 * Keep the file's bytes until its last `closeFile`.
 */
export interface FSBackend {
  /** The size of the file, in bytes. */
  fileSize(node: FileNode): number;

  /**
   * Read into `buf` from `offset`. Return the number of bytes read. It is
   * less than `buf.byteLength` only at the end of the file, and 0 past it.
   */
  readAt(node: FileNode, buf: Uint8Array, offset: number): number;

  /**
   * Write all of `data` at `offset`. `data` is never empty. If the write
   * ends past the end of the file, extend the file, and fill any gap with
   * zeros. The syscall layer does not resize the file first.
   *
   * A write that throws can still have changed the file. `fd_write` and
   * `fd_pwrite` call this once for each iovec, in order. When a later call
   * throws, the earlier iovecs stay written.
   */
  writeAt(node: FileNode, data: Uint8Array, offset: number): void;

  /**
   * Truncate the file to `size` bytes, or extend it with zeros. `size` is a
   * whole number, at most `Number.MAX_SAFE_INTEGER`, and is not the current
   * size.
   */
  resize(node: FileNode, size: number): void;

  /**
   * Make the file durable, for `fd_sync`. For a directory, make every
   * namespace change that has succeeded durable.
   */
  sync(node: FileNode | DirectoryNode): void;

  /** Make the data of the file durable, for `fd_datasync`. */
  datasync(node: FileNode | DirectoryNode): void;

  /**
   * A new fd refers to the file. There is one call for each fd, so two fds
   * on one file give two calls. A backend that holds a handle for each file
   * must count them. `path_open` calls this before it truncates the file.
   * If this throws after `path_open` created the file, the file stays,
   * empty and without an fd.
   */
  openFile(node: FileNode): void;

  /**
   * An fd that refers to the file closed. There is one call for each
   * `openFile`. The fd is released even if this throws.
   */
  closeFile(node: FileNode): void;

  /** Add `node`, which is new, to `parent` under `name`. */
  createChild(parent: DirectoryNode, name: string, node: FSNode): void;

  /**
   * Add `name` in `parent` as another name for `node`, for `path_link`.
   * `node` already has a name, and is not a directory. A backend without
   * hard links throws `FSError` with `NOTSUP`.
   */
  linkChild(parent: DirectoryNode, name: string, node: FSNode): void;

  /** Remove `name` from `parent`. */
  removeChild(parent: DirectoryNode, name: string): void;

  /**
   * Move the node at `fromName` in `fromParent` to `toName` in `toParent`.
   * Replace any node that is already at `toName`.
   */
  renameChild(
    fromParent: DirectoryNode,
    fromName: string,
    toParent: DirectoryNode,
    toName: string,
  ): void;
}
