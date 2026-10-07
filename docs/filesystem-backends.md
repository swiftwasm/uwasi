# Filesystem backends

`useFS({ withBackend, withFileSystem, withStdio })` serves the WASI filesystem syscalls from a storage backend. It is exported from `uwasi` and from `uwasi/filesystem`. `useMemoryFS` is `useFS` with the built-in `MemoryFSBackend`; its options and `useAll()` are unchanged.

## Who does what

The syscall layer owns path resolution, rights, the fd table, seek positions, link counts and timestamps. It reads guest memory and writes the results.

A backend owns two things: the bytes of each file, and the changes to the namespace. It implements `FSBackend` and never sees guest memory or the WASI ABI.

`withFileSystem` is a `MemoryFileSystem`. It is the live namespace: the node tree that path resolution and `fd_readdir` read, and the list of preopened directories. `WASIOptions.preopens` is not used.

## The interface

Every method is synchronous, because the syscalls are synchronous. Finish any asynchronous setup, such as opening storage, before the guest starts.

| Method | Called for |
|--------|------------|
| `fileSize(node)` | `stat`, seeks from the end, appends |
| `readAt(node, buf, offset)` | `fd_read`, `fd_pread`. Returns the bytes read: fewer than asked only at the end of the file. |
| `writeAt(node, data, offset)` | `fd_write`, `fd_pwrite`. Extends the file and zero-fills any gap. `data` is never empty. |
| `resize(node, size)` | `fd_filestat_set_size`, `fd_allocate`, `O_TRUNC` |
| `sync(node)`, `datasync(node)` | `fd_sync`, `fd_datasync`, on a file or a directory |
| `openFile(node)`, `closeFile(node)` | each fd on a regular file |
| `createChild(parent, name, node)` | creating a file, directory or symlink |
| `linkChild(parent, name, node)` | `path_link` |
| `removeChild(parent, name)` | `path_unlink_file`, `path_remove_directory` |
| `renameChild(fromParent, fromName, toParent, toName)` | `path_rename` |

See [`src/filesystem/backend.ts`](../src/filesystem/backend.ts) for the exact contract of each method.

## Errors

A method reports a storage failure by throwing `FSError` with a WASI errno, for example `new FSError(FSErrno.NOSPC)`. The syscall returns that errno to the guest. Any other exception is treated as a bug and propagates to the host.

The syscall layer recognizes `FSError` by its class. Import it from the same copy of uwasi as `useFS`.

## Namespace changes

Path resolution reads `DirectoryNode.entries` directly. So `createChild`, `linkChild`, `removeChild` and `renameChild` must update `entries`, as well as any copy that the backend keeps.

If one of them throws, every `entries` it touched must keep the same names, the same node objects and the same order as before. The order is the `fd_readdir` order. The syscall layer does not repair `entries`: a backend that changes the tree and then fails to persist the change must undo the change itself. This is about the live tree only; what survives a crash is up to the backend.

The syscall layer checks the request before it calls the backend: the target exists or not, a directory is empty, a directory does not move into itself. It updates `nlink` only after the backend call succeeds. A backend without hard links throws `FSError(FSErrno.NOTSUP)` from `linkChild`.

The host-side helpers on `MemoryFileSystem`, such as `addFile` and `removeEntry`, change only the in-memory tree. They do not call the backend.

## File contents

The syscall layer never reads or writes `FileNode.content`. Only `MemoryFSBackend` keeps the bytes there.

For another backend, `content` holds only what the host put there, for example with `addFile`. The backend can take it as initial data, or ignore it. Either way it is not the file's current content, and `MemoryFileSystem.lookup()` does not give the file's data. Read and write those files through the backend.

## Writes

`fd_write` and `fd_pwrite` call `writeAt` once for each iovec, in order. There is no resize before the write. If a later `writeAt` throws, the earlier iovecs stay written, and the syscall returns only the errno. A write that would end past `Number.MAX_SAFE_INTEGER` fails with `FBIG` before anything is written. A zero-length write returns at once, and does not call the backend.

## Open files

`openFile` and `closeFile` are called once for each fd, so two fds on one file give two calls of each. A backend that holds a handle for each file must count them.

`path_open` calls `openFile` before an `O_TRUNC` truncate, so a failed `openFile` leaves the file as it was. If the truncate fails, `path_open` calls `closeFile`. `fd_close` and `fd_renumber` release the fd even if `closeFile` throws.

With `O_CREAT`, `path_open` calls `createChild` before `openFile`. If `openFile` then fails, the new file stays, empty and without an fd.

An fd can outlive the name of its file. After an unlink, or a rename that replaces the file, open fds still read and write it. Keep the file's bytes until its last `closeFile`.
