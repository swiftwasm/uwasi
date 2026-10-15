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

The host-side helpers on `MemoryFileSystem`, such as `addFile` and `removeEntry`, change only the in-memory tree. They do not call the backend. `createFile` keeps the buffer it is given, without a copy, so to create a file from another filesystem's file, pass a copy of its content.

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

## The OPFS backend

`uwasi/opfs` exports `OPFSBackend`, which implements `FSBackend` over the Origin Private File System, and `useOPFS`, which is `useFS` with that backend and its namespace. The OPFS code imports the core only through `src/filesystem/index.ts`, the source of `uwasi/filesystem`, so it uses nothing that another backend could not.

`OPFSBackend.create(directory, options)` is asynchronous: it opens the store, rebuilds the namespace and opens a sync access handle for every data file. Create it before the guest starts. `settle()`, `persistAll()` and `close()` are also asynchronous, and run between guest calls.

Limits:

- Sync access handles exist only in workers, and each is an exclusive lock, so a store has one live backend at a time.
- Hard links return `NOTSUP`: the namespace record maps each data file to one name. Links, renames and removals of device nodes such as `/dev/null` also return `NOTSUP`, because the runtime recreates them at every start.
- Inode numbers and timestamps are not persisted.
- `create()` refuses a store whose namespace it cannot read, and leaves it unchanged (see [Namespace record](#namespace-record)).
- Opening a file writes nothing to storage. A host-seeded file that `persistAll()` has not saved is copied into OPFS on its first write or sync, which can return `NOSPC` on a full store. Call `persistAll()` after seeding.

Each namespace change appends one record to a change log and flushes it, so its cost does not grow with the namespace. Periodic compaction rewrites the whole tree, amortized over the changes before it.

The OPFS tests run against an in-memory mock of the OPFS API. They check the backend's logic, including crash recovery in the mock, but not the durability of a real browser.

## Sizing the OPFS spare pool

Guest syscalls are synchronous, but creating an OPFS file is not. The backend bridges the two with a pool of pre-created, empty data files, each held open: a guest file create claims one synchronously. When a guest call creates more files than the pool holds, the excess files _overdraft_:

- Their names are recorded durably as usual, but their bytes stay in memory until the backend creates their data files in the background.
- `fd_sync` and `fd_datasync` on them return `NOSPC` until then.
- A crash before that happens leaves those names mapped to empty files.

Background work (creating overdrafted files and refilling the pool) runs only when the event loop gets a turn, which means between guest calls, never during one. A host that starts the next guest call as soon as the last returns, for example from a message handler, may never let it finish.

A host controls this with two things:

- **`spareFiles`** (default 16) sets the pool size. Set it to at least the number of spares one guest call claims; files beyond it overdraft. A call claims one spare per file it creates and per host-seeded file it first writes to or syncs. A snapshot of the namespace (every compaction, and any change no log record can express, such as renaming a seeded file) also claims one for every reachable seeded file not yet persisted; `persistAll()` after seeding avoids that. A failed create's spare waits in quarantine until the next snapshot succeeds, since the failed record may still name it. Each spare is an open sync access handle on an empty data file, created at `create()`, so a large pool costs open time and handles. In one Chromium measurement, 1,024 spares added about 130 ms to `create()`.
- **`await backend.settle()`** waits for the background work: overdrafted files get their data files and the pool is refilled to `spareFiles`. Await it between guest calls whenever files created so far should survive a crash, and before a call that will create many files. It costs time proportional to the files created since the last settle. Guest calls may still run while it waits, and it waits for the work they queue too: it resolves once no work is queued or running and no file is waiting for its data file, so no file reachable at that point still waits for one. A guest that keeps creating files past the pool during every wait can delay it indefinitely. It rejects as soon as storage refuses any of that work; the files it left keep their bytes in memory, and the next `settle()` retries. `persistAll()` waits the same way, then flushes every reachable file.

With `spareFiles` at least the largest burst and `settle()` between calls, no file overdrafts. Without `settle()`, a large pool helps only the first call, since the refill may not finish before the next. A single call that creates more files than the pool always overdrafts the excess; await `settle()` after it to make them durable. `close()` also finishes the background work and flushes every file, so a clean shutdown keeps every file's bytes, overdrafted ones included; if storage refuses any of it, `close()` still releases every handle, then rejects, since those bytes may be lost. (Seeded files that nothing has recorded yet are not saved by `close()`; see `persistAll()`.)

Fewer, larger files avoid the problem altogether: each file costs a spare, while bytes written to an existing file do not.

## Namespace record

The OPFS backend persists guest names separately from file content. Each `.uwasi.data.<id>` file holds one guest file's bytes; the namespace record maps names to those ids. It is a sequence of binary records over directory ids and data-file ids:

| Record    | Fields                               |
| --------- | ------------------------------------ |
| `MKDIR`   | parent dir, name, new dir id         |
| `FILE`    | parent dir, name, data-file id       |
| `SYMLINK` | parent dir, name, target             |
| `REMOVE`  | parent dir, name                     |
| `RENAME`  | from dir, from name, to dir, to name |

Ids are LEB128 varints and names are length-prefixed UTF-8. The root directory is id 0. A snapshot is the `MKDIR`, `FILE`, and `SYMLINK` records that rebuild the tree from an empty root, in `entries` order, so re-init preserves directory listing order. Snapshots alternate between `.uwasi.meta.0` and `.uwasi.meta.1`, each framed as `"UWS2" | u32 body length | u32 checksum | body`, where the body is a varint generation followed by the records and the checksum is FNV-1a over the first 8 bytes (magic and length) continued over the body. Re-init loads the highest intact generation. A slot whose length or checksum does not verify is torn, and re-init falls back to the other one. A slot that verifies but that this version cannot read, under an unknown magic or as a `"UWS2"` body that does not decode, is intact: no torn write passes the checksum, since it covers the header. It may hold the newest namespace, so `create()` rejects without changing the store rather than fall back or open it as empty. So it does for a magic of four nonzero bytes it does not know, even if the checksum fails: a torn write of a known magic leaves a known magic or a zero byte, never that.

Changes after a snapshot go to `.uwasi.meta.log`, one record per namespace change, appended and flushed before the syscall returns. The log header is `"UWL2" | u32 check | u64 generation`: it names the snapshot generation the log builds on, and its check is FNV-1a over the magic continued over the generation. As for a snapshot slot, a header that verifies under a magic this version does not know, or that has an unknown magic of four nonzero bytes, makes `create()` reject. Each frame is `u32 body length | u32 check | record`, where the check is FNV-1a of the record seeded with the generation and the frame's offset, so bytes left over from an earlier generation, or from a frame at another offset, never verify. Re-init replays the log on top of the snapshot it names, stopping at the first frame that does not verify. A frame that verifies was written whole, so if it does not decode to exactly one record, `create()` rejects: stopping there would drop the changes after it for good, since every open compacts. A failed append is truncated away where possible. A complete frame left behind at the end of the log does verify, and may still become durable, so the failed change may take effect after all, which a failed syscall allows.

Every later format of these files must keep their header: a 4-byte magic first, new for any change in format, and a checksum that covers it. That is what lets an older version tell a store it must refuse from one it may recover.

Once the log exceeds both 64 KiB and twice the last snapshot, the backend writes the next snapshot and then resets the log to build on it. A crash between those steps leaves a log naming the older generation, which re-init ignores because the new snapshot already holds its changes. If the reset itself fails, changes are recorded by full snapshots until a later compaction resets the log. If the snapshot fails, the slot may still hold it, and storage may keep it however the write failed, with the same effect. Its generation is not used again in that session and the log takes no further appends, so changes are again recorded by full snapshots (into the same slot) until one succeeds and replaces it. Every `create()` also compacts, so a store opens with an empty log. It counts generations on from the one it loaded, which may reuse a failed snapshot's generation; that is harmless, since a slot it did not load is torn or older, and its first snapshot overwrites that slot.

A failed create can thus leave a record that names a data file the backend has freed. Such a data file stays out of the spare pool until a later snapshot succeeds, since a new file claiming it would make that name show the new file's bytes. Unlink and replacing rename record the change before they destroy any content, so a failed one leaves the file as it was. A data file whose name a durable record already dropped is reused at once: replay forgets it at that record. A directory `fd_sync` flushes nothing, since every guest change was flushed before its syscall returned; it does not record host-seeded files either (see `persistAll()`).
