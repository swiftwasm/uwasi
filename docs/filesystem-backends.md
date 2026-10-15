# Filesystem backends

`useFS({ withBackend, withFileSystem, withStdio })` serves the WASI filesystem syscalls from a storage backend. It is exported from `uwasi` and from `uwasi/filesystem`. `useMemoryFS` is `useFS` with the built-in `MemoryFSBackend`; its options and `useAll()` are unchanged.

## Who does what

The syscall layer owns path resolution, rights, the fd table, seek positions, link counts, timestamps and the live node tree. It reads guest memory and writes the results.

A backend owns two things: the bytes of each file, and persisting changes to the namespace. It implements `FSBackend` and never sees guest memory or the WASI ABI.

`withFileSystem` is a `MemoryFileSystem`. It is the live namespace: the node tree that path resolution and `fd_readdir` read, and the list of preopened directories. `WASIOptions.preopens` is not used.

## The interface

Every method is synchronous, because the syscalls are synchronous. Finish any asynchronous setup, such as opening storage, before the guest starts.

`FSBackend` has the methods that work without an fd:

| Method | Called for |
|--------|------------|
| `fileSize(node)` | `stat`, seeks from the end, appends |
| `openFile(node, mode)` | each new fd on a regular file. Returns the fd's `FileHandle`; `mode` says whether the fd can read and write. |
| `syncDirectory(dir)` | `fd_sync`, `fd_datasync` on a directory |
| `createChild(parent, name, node)` | creating a file, directory or symlink |
| `linkChild(parent, name, node)` | `path_link` |
| `removeChild(parent, name)` | `path_unlink_file`, `path_remove_directory` |
| `renameChild(fromParent, fromName, toParent, toName)` | `path_rename` |

A `FileHandle` belongs to one fd, so a backend can keep per-fd state, such as a real file descriptor, in it:

| Method | Called for |
|--------|------------|
| `readAt(buf, offset)` | `fd_read`, `fd_pread`. Returns the bytes read: fewer than asked only at the end of the file. |
| `writeAt(data, offset)` | `fd_write`, `fd_pwrite`. Returns the bytes written; extends the file and zero-fills any gap. `data` is never empty. |
| `resize(size)` | `fd_filestat_set_size`, `fd_allocate`, `O_TRUNC` |
| `sync()`, `datasync()` | `fd_sync`, `fd_datasync` |
| `close()` | `fd_close`, or `fd_renumber` replacing the fd |

See [`src/filesystem/backend.ts`](../src/filesystem/backend.ts) for the exact contract of each method.

## Errors

A method reports a storage failure by throwing `FSError` with a WASI errno, for example `new FSError(FSErrno.NOSPC)`. The syscall returns that errno to the guest. Any other exception is treated as a bug and propagates to the host.

The syscall layer recognizes `FSError` by its class. Import it from the same copy of uwasi as `useFS`.

## Namespace changes

`createChild`, `linkChild`, `removeChild` and `renameChild` persist a change; they do not apply it. The syscall layer calls them first, so they see the tree as it was, and updates `DirectoryNode.entries` only after they return. If one of them throws, the tree stays as it was, and there is nothing to undo. A backend must not change `entries` itself. What survives a crash is up to the backend.

The syscall layer checks the request before it calls the backend: the target exists or not, a directory is empty, a directory does not move into itself. It updates `nlink` only after the backend call succeeds. A backend without hard links throws `FSError(FSErrno.NOTSUP)` from `linkChild`.

The host-side helpers on `MemoryFileSystem`, such as `addFile` and `removeEntry`, change only the in-memory tree. They do not call the backend.

## File contents

The syscall layer never reads or writes `FileNode.content`. Only `MemoryFSBackend` keeps the bytes there.

For another backend, `content` holds only what the host put there, for example with `addFile`. The backend can take it as initial data, or ignore it. Either way it is not the file's current content, and `MemoryFileSystem.lookup()` does not give the file's data. Read and write those files through the backend.

## Writes

`fd_write` and `fd_pwrite` call `writeAt` once for each iovec, in order. There is no resize before the write. `writeAt` returns the bytes it wrote, and throws `FSError` only when it wrote nothing. As with POSIX `write`, a write that stops part of the way through, because `writeAt` wrote less or a later call threw, succeeds with the count so far, and `fd_write` moves the cursor by that count. Only a write that wrote nothing returns the errno. A write that would end past `Number.MAX_SAFE_INTEGER` fails with `FBIG` before anything is written. A zero-length write returns at once, and does not call the backend.

## Open files

Each fd gets its own `openFile` call and its own handle, and the handle's `close` is called once, when the fd goes away.

`mode.read` and `mode.write` come from the fd's rights when it is opened; `write` is also set when `path_open` truncates. The syscall layer calls `writeAt` and `resize` only on a handle opened with `write`, so a backend can open a read-only handle otherwise. A read-only backend can refuse a write open with `FSError(FSErrno.ROFS)`.

`path_open` truncates through the new handle, so a failed `openFile` leaves the file as it was. If the truncate fails, `path_open` closes the handle. `fd_close` and `fd_renumber` release the fd even if `close` throws.

With `O_CREAT`, `path_open` calls `createChild` before `openFile`. If `openFile` then fails, the new file stays, empty and without an fd.

An fd can outlive the name of its file. After an unlink, or a rename that replaces the file, open handles still read and write it. Keep the file's bytes until its last handle closes.
