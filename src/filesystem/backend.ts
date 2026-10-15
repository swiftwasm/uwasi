import { DirectoryNode, FileNode, FSNode } from "./namespace.js";

/**
 * What an fd may do to its file, from its rights when it is opened. Rights
 * can only shrink later, so this is an upper bound.
 */
export interface OpenMode {
  /** The fd can read the file. */
  read: boolean;
  /**
   * The fd can write or resize the file, or `path_open` truncates it. When
   * no open fd on a file has `write`, the syscall layer calls neither
   * `writeAt` nor `resize` for it.
   */
  write: boolean;
}

/**
 * The storage behind the filesystem syscalls.
 *
 * The syscall layer owns path resolution, rights, the fd table, seek
 * positions, link counts, timestamps and the live node tree. A backend owns
 * two things: the bytes of each file, and persisting namespace changes.
 * The syscall layer
 * never reads or writes `FileNode.content`; only `MemoryFSBackend` keeps
 * the bytes there.
 *
 * Every method is synchronous, because the syscalls are synchronous. Finish
 * any asynchronous setup before the guest starts.
 *
 * To report a storage failure, a method throws `FSError` with a WASI errno.
 * The syscall returns that errno to the guest.
 *
 * The namespace methods persist a change; they do not apply it. The
 * syscall layer calls them before it changes `DirectoryNode.entries`, so
 * they see the tree as it was, and changes `entries` only after they
 * return. A namespace method that throws leaves nothing to undo in the
 * tree. It must not change `entries` itself.
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
   * Write `data` at `offset`, and return the number of bytes written. It is
   * less than `data.byteLength` only when the rest cannot be written now,
   * for example when storage is full. `data` is never empty. If the write
   * ends past the end of the file, extend the file, and fill any gap with
   * zeros. The syscall layer does not resize the file first.
   *
   * Throw `FSError` only when nothing could be written. `fd_write` and
   * `fd_pwrite` call this once for each iovec, in order, and report a short
   * write when a later call writes less, or throws.
   */
  writeAt(node: FileNode, data: Uint8Array, offset: number): number;

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
   * A new fd refers to the file, with what it may do in `mode`. A backend
   * that cannot write, for example a read-only store, can refuse a write
   * open here with `FSError(ROFS)`. There is one call for each fd, so two
   * fds on one file give two calls. A backend that holds a handle for each
   * file must count them. `path_open` calls this before it truncates the
   * file.
   * If this throws after `path_open` created the file, the file stays,
   * empty and without an fd.
   */
  openFile(node: FileNode, mode: OpenMode): void;

  /**
   * An fd that refers to the file closed. There is one call for each
   * `openFile`. The fd is released even if this throws.
   */
  closeFile(node: FileNode): void;

  /** Persist adding `node`, which is new, to `parent` under `name`. */
  createChild(parent: DirectoryNode, name: string, node: FSNode): void;

  /**
   * Persist adding `name` in `parent` as another name for `node`, for
   * `path_link`.
   * `node` already has a name, and is not a directory. A backend without
   * hard links throws `FSError` with `NOTSUP`.
   */
  linkChild(parent: DirectoryNode, name: string, node: FSNode): void;

  /** Persist removing `name` from `parent`. */
  removeChild(parent: DirectoryNode, name: string): void;

  /**
   * Persist moving the node at `fromName` in `fromParent` to `toName` in
   * `toParent`, replacing any node that is already at `toName`.
   */
  renameChild(
    fromParent: DirectoryNode,
    fromName: string,
    toParent: DirectoryNode,
    toName: string,
  ): void;
}
