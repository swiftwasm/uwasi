import {
  DirectoryNode,
  FileNode,
  FSBackend,
  FSNode,
  FileHandle,
  MemoryFileSystem,
  OpenMode,
  SymlinkNode,
  FSErrno,
  FSError,
} from "../filesystem/index.js";
import {
  ByteWriter,
  NsRecord,
  Op,
  ROOT_DIR_ID,
  Snapshot,
  UnknownFormatError,
  beginSnapshot,
  decodeLog,
  decodeSnapshot,
  encodeFrame,
  encodeLogHeader,
  encodeRecord,
  finishSnapshot,
} from "./format.js";

/**
 * The slice of the OPFS API surface the backend uses, typed structurally so
 * uwasi does not depend on newer DOM lib definitions. A real
 * `FileSystemDirectoryHandle` from `navigator.storage.getDirectory()`
 * satisfies `OPFSDirectoryHandle` in a worker.
 */
export interface OPFSSyncAccessHandle {
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

export interface OPFSFileHandle {
  readonly kind: "file";
  readonly name: string;
  createSyncAccessHandle(): Promise<OPFSSyncAccessHandle>;
}

export interface OPFSDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OPFSFileHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OPFSDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<
    [string, OPFSFileHandle | OPFSDirectoryHandle]
  >;
}

// ---------------------------------------------------------------------------
// Store layout
// ---------------------------------------------------------------------------

const META_NAMES = [".uwasi.meta.0", ".uwasi.meta.1"];
/** The change log; named under `.uwasi.meta.` as part of the record. */
const LOG_NAME = ".uwasi.meta.log";
/**
 * Compact once the log outgrows both this floor and `LOG_RATIO` times the
 * last snapshot. A snapshot costs time proportional to the namespace, and
 * it comes due only after proportionally many appends, so recording a
 * namespace change costs amortized constant time. (The syscall making the
 * change may cost more: renaming a directory searches its subtree.)
 */
const MIN_LOG_BYTES = 64 * 1024;
const LOG_RATIO = 2;
const DATA_PREFIX = ".uwasi.data.";

function dataName(id: number): string {
  return DATA_PREFIX + id;
}

function readAll(handle: OPFSSyncAccessHandle): Uint8Array {
  const buffer = new Uint8Array(handle.getSize());
  if (buffer.byteLength > 0) handle.read(buffer, { at: 0 });
  return buffer;
}

/** Live state while records rebuild the namespace at `init`. */
type ReplayState = {
  dirs: Map<number, DirectoryNode>;
  files: Map<number, FileNode>;
  maxDir: number;
  maxFile: number;
};

/** The errno of an internal step that succeeded. */
const ESUCCESS = 0;

/**
 * `data` resized to `size` bytes, zero-filled, or `null` if the engine
 * refuses to allocate that much. The guest picks the size (a write offset
 * or a truncate length), and an exception thrown inside a WASI import
 * traps the guest, so callers report a refusal as a full device, as the
 * memory backend does.
 */
function resizedContent(data: Uint8Array, size: number): Uint8Array | null {
  let next: Uint8Array;
  try {
    next = new Uint8Array(size);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  next.set(data.subarray(0, Math.min(size, data.byteLength)));
  return next;
}

/**
 * Whether a namespace change naming `node` involves a device node: the
 * node is one, or is a directory holding one (`/dev`). Device nodes belong
 * to the runtime: the `MemoryFileSystem` constructor creates them at every
 * open and no record stores them, so such a change would quietly come
 * undone at a later open. The backend refuses it instead.
 */
function involvesDevice(node: FSNode | undefined): boolean {
  if (node === undefined) return false;
  if (node.type === "character") return true;
  if (node.type !== "dir") return false;
  for (const name in node.entries) {
    if (node.entries[name].type === "character") return true;
  }
  return false;
}

/**
 * A namespace change the syscall layer applies after the backend persists
 * it: `remove` deletes a name, then `add` sets one.
 */
type PendingChange = {
  remove?: { dir: DirectoryNode; name: string };
  add?: { dir: DirectoryNode; name: string; node: FSNode };
};

/**
 * `dir`'s entries in listing order, as they will be once the syscall layer
 * applies `change`. A name set again keeps its place; a new one goes last.
 */
function entriesAfter(
  dir: DirectoryNode,
  change: PendingChange | undefined,
): [string, FSNode][] {
  const { remove, add } = change ?? {};
  const list: [string, FSNode][] = [];
  for (const name of Object.keys(dir.entries)) {
    if (remove?.dir === dir && remove.name === name) continue;
    const replaced = add?.dir === dir && add.name === name;
    list.push([name, replaced ? add.node : dir.entries[name]]);
  }
  if (add?.dir === dir && dir.entries[add.name] === undefined) {
    list.push([add.name, add.node]);
  }
  return list;
}

/**
 * OPFS handle operations in flight at once. Each is an async round trip
 * to the browser's storage backend; issuing them together overlaps that
 * latency, and the bound keeps a large store from flooding it.
 */
const HANDLE_CONCURRENCY = 32;

/**
 * Run `task` over `items`, at most `HANDLE_CONCURRENCY` at a time. After
 * the first failure no new task starts; the ones in flight finish (their
 * side effects, such as recording an acquired handle, still happen), then
 * the first failure is thrown.
 */
async function forEachConcurrently<T>(
  items: T[],
  task: (item: T) => Promise<void>,
): Promise<void> {
  const state = { next: 0, failed: false, error: undefined as unknown };
  const worker = async (): Promise<void> => {
    while (!state.failed && state.next < items.length) {
      const item = items[state.next++];
      try {
        await task(item);
      } catch (error) {
        if (!state.failed) {
          state.failed = true;
          state.error = error;
        }
      }
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(HANDLE_CONCURRENCY, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (state.failed) throw state.error;
}

/**
 * Write all of `data` at `at`. OPFS reports partial writes (e.g. under
 * quota pressure) only through the return value; a short write must never
 * pass as success, so it becomes a `RangeError` - which `errnoOf` maps to
 * `NOSPC`, the same way a full device surfaces.
 */
function writeFully(
  handle: OPFSSyncAccessHandle,
  data: Uint8Array,
  at: number,
): void {
  const written = handle.write(data, { at });
  if (written !== data.byteLength) {
    throw new RangeError(
      `uwasi: short write: ${written} of ${data.byteLength} bytes`,
    );
  }
}

/**
 * An OPFS-backed `FSBackend` for workers.
 *
 * OPFS namespace calls (`getFileHandle`, `removeEntry`, `move`) are async
 * while the WASI syscall path is synchronous, so guest names cannot be
 * mapped 1:1 onto OPFS names at syscall time. The backend owns the whole
 * directory it is given instead:
 *
 * - `.uwasi.data.<id>`: one content file per guest file, each held open
 *   through a sync access handle for the backend's whole life. Releasing a
 *   handle is unsafe, because re-acquiring one is async.
 * - `.uwasi.meta.0/1`: namespace snapshots mapping guest names to data
 *   file ids, alternating between the two slots with a generation number
 *   and a checksum, so a torn snapshot falls back to the previous one.
 * - `.uwasi.meta.log`: the change log on top of the newest snapshot. Each
 *   namespace change appends and flushes one record, so its cost does not
 *   grow with the namespace; the log is folded into a fresh snapshot once
 *   it outgrows the last one. A torn append loses at most that change.
 * - a bounded pool of spare data files with open handles, so creating a
 *   guest file is a synchronous claim.
 *
 * Other entries in the directory are ignored and left untouched.
 *
 * Creating more files than the pool holds still succeeds: the record maps
 * the name immediately and the physical file follows on the next event
 * loop turn. Until it does, `fd_sync` reports `NOSPC` rather than claiming
 * durability it cannot provide, and `settle()` clears the backlog.
 *
 * Unlink and rename over an existing target record the change first, and
 * only then destroy the content that no name maps any more. A failed
 * change leaves the file as it was, and a crash in between leaves a data
 * file no record names, which re-init reclaims rather than resurrects.
 * While fds are still open, destruction waits for the last handle to
 * close (dangling-fd semantics).
 *
 * Limits: hard links are refused with `NOTSUP`, as are changes naming a
 * device node (see `involvesDevice`), inode numbers and timestamps are
 * not persisted, and the store needs exactly one live backend, since sync
 * access handles are exclusive locks.
 */
export class OPFSBackend implements FSBackend {
  /**
   * The node tree the syscall layer resolves paths against. Grafted from
   * the namespace record at `create()`; from then on the backend keeps it
   * exact while persisting every namespace change.
   */
  readonly fileSystem: MemoryFileSystem;

  private metaHandles: OPFSSyncAccessHandle[] = [];
  /** Generation of the newest snapshot known durable: the log builds on it. */
  private generation = 0;
  /**
   * The highest generation any slot may hold. A failed snapshot write can
   * leave a complete snapshot in its slot that a later flush (or the
   * storage itself) makes durable, so its generation is not used again
   * in this session. `create()` restarts the count from the generation
   * it loaded, which may reuse a failed one's; that is harmless, since a
   * slot it did not load is torn or older, and init's own snapshot
   * overwrites it.
   */
  private attemptedGeneration = 0;
  private nextId = 0;
  /**
   * Directory node -> its id in the namespace records. Ids are assigned
   * when a directory is first recorded and never reused. A directory that
   * left the tree (removed, or moved into one that was) keeps its id only
   * until the next snapshot, which does not record it: replay would drop
   * any later record naming that id, such as the rename of a file the
   * guest moves out of it through an fd it kept. Changes there take a
   * snapshot instead.
   */
  private dirIds = new WeakMap<DirectoryNode, number>();
  private nextDirId = ROOT_DIR_ID + 1;
  /** Reused across snapshots to avoid regrowing the encode buffer. */
  private encoder = new ByteWriter();
  private snapshotBytes = 0;
  private logHandle!: OPFSSyncAccessHandle;
  private logWriter = new ByteWriter(64);
  /** Offset just past the last durable frame: where the next one goes. */
  private logEnd = 0;
  /**
   * The log does not build on the current snapshot (its reset failed after
   * a compaction), so changes are recorded by full snapshots until a
   * compaction resets it.
   */
  private logStale = true;
  /** Guest file node -> data-file id, for every persisted file. */
  private physByNode = new Map<FileNode, number>();
  /** Data-file id -> its always-open sync access handle. */
  private handleById = new Map<number, OPFSSyncAccessHandle>();
  /** Ids of pre-created, empty, claimable data files. */
  private spares: number[] = [];
  /**
   * Ids of emptied data files that a namespace record may still name: the
   * snapshot or log record a failed create left behind, which a later
   * flush (or the storage itself) can still make durable. A spare gets new
   * content, so handing one of these out would let that name show another
   * file's bytes. They rejoin the pool once a snapshot is durable: it
   * names none of them, and it overwrites the slot any failed snapshot was
   * left in.
   */
  private quarantine: number[] = [];
  /**
   * Files created past the spare pool: their id is already durable in the
   * namespace record, their content still lives in `node.content` until
   * the background materializer creates the physical file.
   */
  private pendingIds = new Map<FileNode, number>();
  /**
   * File and symlink nodes a durable namespace record names (directories
   * have `dirIds`). A node joins only once a record naming it is flushed:
   * an id alone proves nothing, since `adopt` hands one out before the
   * record that would name it is written, and that write can fail.
   * `ensureStored`, `sync` and the choice between a log record
   * and a snapshot rely on it.
   */
  private known = new WeakSet<FileNode | SymlinkNode>();
  /**
   * Open handles per file. OPFS sync access handles are exclusive locks,
   * so all of a file's handles share its one data-file handle, and an
   * unlinked file's bytes may go only when the last of them closes.
   */
  private openCounts = new Map<FileNode, number>();
  private background: Promise<void> = Promise.resolve();
  private replenishScheduled = false;
  private closed = false;

  private constructor(
    private readonly store: OPFSDirectoryHandle,
    private readonly spareTarget: number,
    preopens?: { [guestPath: string]: string },
  ) {
    this.fileSystem = new MemoryFileSystem(preopens);
  }

  /**
   * Open (or initialize) a store inside `store` - typically
   * `await navigator.storage.getDirectory()` or a subdirectory of it - and
   * finish every piece of async setup, so that all `FSBackend` methods are
   * synchronous afterwards.
   */
  static async create(
    store: OPFSDirectoryHandle,
    options: {
      /** Guest preopen directories, as for `MemoryFileSystem`. */
      preopens?: { [guestPath: string]: string };
      /**
       * Spare data files to keep pre-created (default 16): the number of
       * files one guest call can back with a data file right away, so
       * `fd_sync` works. Files past it keep their content in memory until
       * background work creates their data files, which runs only between
       * guest calls; see `settle()`. Each spare holds an open sync access
       * handle, so a larger pool costs open time. Size it to the most
       * spares one guest call claims: one per file it creates or seeded
       * file it first writes to or syncs, one per unpersisted seeded file
       * a snapshot takes along, and one per failed create, whose data file
       * waits in quarantine until the next snapshot.
       */
      spareFiles?: number;
    } = {},
  ): Promise<OPFSBackend> {
    const backend = new OPFSBackend(
      store,
      options.spareFiles ?? 16,
      options.preopens,
    );
    try {
      await backend.init();
    } catch (error) {
      // Sync access handles are exclusive locks: any left held would make
      // every later attempt to open the store in this worker fail. Mark the
      // backend closed first: background work the open queued may still be
      // waiting on OPFS, and must release whatever it acquires afterwards.
      backend.closed = true;
      backend.releaseHandles();
      throw error;
    }
    return backend;
  }

  private async init(): Promise<void> {
    // Scan the (flat) physical store. Foreign entries are left untouched.
    const dataFiles = new Map<number, OPFSFileHandle>();
    let maxSeenId = -1;
    for await (const [name, handle] of this.store.entries()) {
      if (handle.kind !== "file" || !name.startsWith(DATA_PREFIX)) continue;
      const id = Number(name.slice(DATA_PREFIX.length));
      if (!Number.isInteger(id) || id < 0) continue;
      dataFiles.set(id, handle);
      maxSeenId = Math.max(maxSeenId, id);
    }

    // Read both namespace-record slots; the highest intact generation wins.
    // A slot this version cannot read stops the open before anything is
    // changed (see `readSlot`).
    let snapshot: Snapshot | null = null;
    for (const name of META_NAMES) {
      const fileHandle = await this.store.getFileHandle(name, { create: true });
      const handle = await fileHandle.createSyncAccessHandle();
      this.metaHandles.push(handle);
      const slot = this.readSlot(name, handle);
      if (slot && (!snapshot || slot.gen > snapshot.gen)) snapshot = slot;
    }
    this.generation = snapshot ? snapshot.gen : 0;
    this.attemptedGeneration = this.generation;

    // Rebuild the guest namespace from the records alone. Data files the
    // records do not reference belong to unlinked files, so they stay
    // invisible to the guest whatever bytes they still hold.
    const root = this.fileSystem.lookup("/") as DirectoryNode;
    this.dirIds.set(root, ROOT_DIR_ID);
    const replay: ReplayState = {
      dirs: new Map([[ROOT_DIR_ID, root]]),
      files: new Map(),
      maxDir: ROOT_DIR_ID,
      maxFile: -1,
    };
    for (const record of snapshot ? snapshot.records : []) {
      this.applyRecord(record, replay);
    }
    const logFile = await this.store.getFileHandle(LOG_NAME, { create: true });
    this.logHandle = await logFile.createSyncAccessHandle();
    let logged: NsRecord[] | null;
    try {
      logged = decodeLog(readAll(this.logHandle), snapshot && snapshot.gen);
    } catch (error) {
      if (!(error instanceof UnknownFormatError)) throw error;
      throw new Error(
        `uwasi: ${LOG_NAME} holds a namespace log this version does not understand (${error.message}); refusing to open the store rather than discard it`,
      );
    }
    for (const record of logged ?? []) this.applyRecord(record, replay);
    // Ids may have been handed out after the records were last written
    // (background pool refills are not recorded); never reuse one.
    this.nextId = Math.max(maxSeenId, replay.maxFile) + 1;
    this.nextDirId = replay.maxDir + 1;

    // Claim every referenced data file's handle for life.
    const referenced = [...this.physByNode.values()];
    for (const id of referenced) dataFiles.delete(id);
    await forEachConcurrently(referenced, async (id) => {
      // A referenced file that is physically missing (a foreign actor
      // removed it, or `close()` did for a file it reported lost) is
      // recreated: it surfaces as an empty file rather than failing the
      // whole store. Only a failed open closes the backend, once this has
      // finished, so a handle always arrives.
      this.handleById.set(id, (await this.openDataFile(id))!);
    });

    // Reclaim tombstones: destroy any leftover content, reuse as spares.
    // Only as many as the pool needs are opened; the rest are removed
    // without ever taking their (lock-holding) handles.
    const leftovers = [...dataFiles.keys()].sort((a, b) => a - b);
    const reused = leftovers.slice(0, this.spareTarget);
    await forEachConcurrently(reused, async (id) => {
      const handle = await dataFiles.get(id)!.createSyncAccessHandle();
      this.handleById.set(id, handle);
      handle.truncate(0);
      handle.flush();
    });
    this.spares.push(...reused);
    await forEachConcurrently(leftovers.slice(this.spareTarget), (id) =>
      this.store.removeEntry(dataName(id)),
    ).catch(() => {
      // Best effort: the files are unreferenced, and the next open
      // reclaims them again.
    });

    // Pre-create whatever the pool still lacks.
    await this.refillSpares();

    // Fold the replayed log into a fresh snapshot and start an empty log.
    // A failed log reset leaves the backend correct but snapshotting on
    // every change; see `compact`.
    this.compact();
  }

  /**
   * Decode the snapshot in slot `name`; `null` if it is empty or torn.
   * Throws if the slot holds intact bytes in a format this version cannot
   * read, such as one a later uwasi wrote. Opening anyway, from the other
   * slot or as an empty store, would reclaim as unreferenced the data
   * files of every file only that slot names, destroying their content.
   */
  private readSlot(
    name: string,
    handle: OPFSSyncAccessHandle,
  ): Snapshot | null {
    try {
      return decodeSnapshot(readAll(handle));
    } catch (error) {
      if (!(error instanceof UnknownFormatError)) throw error;
      throw new Error(
        `uwasi: ${name} holds a namespace snapshot this version does not understand (${error.message}); refusing to open the store rather than discard it`,
      );
    }
  }

  /**
   * Apply one namespace record to the tree being rebuilt. Records come
   * from a snapshot or, in order, from later changes, so each mirrors what
   * the live `FSBackend` hook did to `entries` - including where a name
   * lands in insertion order, which keeps `entries` (and with it
   * readdir cookie indexing) stable across re-init. A record naming a
   * parent or source that does not exist is skipped.
   */
  private applyRecord(record: NsRecord, replay: ReplayState): void {
    switch (record.op) {
      case Op.Mkdir: {
        const parent = replay.dirs.get(record.parent);
        if (!parent) return;
        const existing = parent.entries[record.name];
        let dir: DirectoryNode;
        if (existing !== undefined && existing.type === "dir") {
          // Preopens and /dev already exist in a fresh namespace.
          dir = existing;
        } else {
          this.forget(existing, replay);
          // Null-prototype entries, as `makeDir` creates them.
          dir = {
            type: "dir",
            entries: Object.create(null),
          } as DirectoryNode;
          parent.entries[record.name] = this.fileSystem.stamp(dir);
        }
        replay.dirs.set(record.dir, dir);
        this.dirIds.set(dir, record.dir);
        replay.maxDir = Math.max(replay.maxDir, record.dir);
        return;
      }
      case Op.File: {
        const parent = replay.dirs.get(record.parent);
        if (!parent) return;
        this.forget(parent.entries[record.name], replay);
        const holder = replay.files.get(record.file);
        if (holder) {
          // Hard links are refused and a data file is reused only once no
          // durable record names it, so a second live name for one id
          // should never be logged. If one ever is, the id must have been
          // reused: give the newer name the data file and leave the older
          // one empty, rather than letting it show the other file's bytes.
          this.physByNode.delete(holder);
        }
        const node = {
          type: "file",
          content: new Uint8Array(0),
          nlink: 1,
        } as FileNode;
        replay.files.set(record.file, node);
        this.physByNode.set(node, record.file);
        parent.entries[record.name] = this.fileSystem.stamp(node);
        this.known.add(node);
        replay.maxFile = Math.max(replay.maxFile, record.file);
        return;
      }
      case Op.Symlink: {
        const parent = replay.dirs.get(record.parent);
        if (!parent) return;
        this.forget(parent.entries[record.name], replay);
        const node = { type: "symlink", target: record.target } as SymlinkNode;
        parent.entries[record.name] = this.fileSystem.stamp(node);
        this.known.add(node);
        return;
      }
      case Op.Remove: {
        const parent = replay.dirs.get(record.parent);
        if (!parent) return;
        const node = parent.entries[record.name];
        if (node === undefined) return;
        delete parent.entries[record.name];
        this.forget(node, replay);
        return;
      }
      case Op.Rename: {
        const from = replay.dirs.get(record.fromParent);
        const to = replay.dirs.get(record.toParent);
        if (!from || !to) return;
        const node = from.entries[record.fromName];
        if (node === undefined) return;
        const replaced = to.entries[record.toName];
        delete from.entries[record.fromName];
        to.entries[record.toName] = node;
        if (replaced !== undefined && replaced !== node) {
          this.forget(replaced, replay);
        }
        return;
      }
    }
  }

  /**
   * A replayed record dropped `node`'s last name: release its data-file id
   * so a later record may map the recycled id to a new file.
   */
  private forget(node: FSNode | undefined, replay: ReplayState): void {
    if (node === undefined || node.type !== "file") return;
    const id = this.physByNode.get(node);
    if (id === undefined) return;
    this.physByNode.delete(node);
    this.known.delete(node);
    if (replay.files.get(id) === node) replay.files.delete(id);
  }

  // -------------------------------------------------------------------
  // Namespace persistence
  // -------------------------------------------------------------------

  /**
   * Make one namespace change durable by appending its record to the log;
   * `null` (a change no record can express, such as one under a directory
   * or of a node that was never recorded) takes a full snapshot instead.
   * Throws when the change could not be made durable (though the failed
   * write may still have recorded it).
   *
   * The syscall layer applies the change to the live tree only after this
   * returns, so any snapshot this takes encodes the tree as `change` will
   * leave it, without touching the tree.
   */
  private persist(record: NsRecord | null, change: PendingChange): void {
    if (record === null || this.logStale) {
      this.compact(change);
      return;
    }
    const frame = encodeFrame(
      this.logWriter,
      record,
      this.generation,
      this.logEnd,
    );
    try {
      writeFully(this.logHandle, frame, this.logEnd);
      this.logHandle.flush();
    } catch (error) {
      try {
        // Leave no frame behind: a complete one would verify, so a later
        // flush, or the storage itself, could still make the failed
        // change durable.
        this.logHandle.truncate(this.logEnd);
      } catch {
        // The next append overwrites it in place. Until then it may still
        // become durable, so any data file the change freed stays out of
        // the spare pool (see `quarantine`).
      }
      throw error;
    }
    this.logEnd += frame.byteLength;
    if (
      this.logEnd > MIN_LOG_BYTES &&
      this.logEnd > LOG_RATIO * this.snapshotBytes
    ) {
      try {
        // The snapshot must hold this change: the log it resets does.
        this.compact(change);
      } catch {
        // The change is durable in the log already; a failed compaction
        // leaves the log in place and is retried on the next change.
      }
    }
  }

  /**
   * Write a full snapshot, then reset the log to build on it. Throws only
   * if the snapshot fails. The failed snapshot may still become durable
   * (see `snapshotFlush`), and re-init would then ignore the log, so the
   * log takes no more appends: later changes take full snapshots until one
   * succeeds. If the reset fails after a good snapshot, the snapshot
   * already covers every change: the stale log is ignored at re-init (its
   * header names the older generation), and later changes take full
   * snapshots until a compaction resets it.
   */
  private compact(change?: PendingChange): void {
    this.logStale = true;
    this.snapshotFlush(change);
    try {
      const header = encodeLogHeader(this.generation);
      writeFully(this.logHandle, header, 0);
      this.logHandle.truncate(header.byteLength);
      this.logHandle.flush();
      this.logEnd = header.byteLength;
      this.logStale = false;
    } catch {
      // Stays stale; see above.
    }
  }

  /**
   * Serialize the live node tree into the slot not holding the current
   * snapshot and flush it. It also adopts any reachable file the backend
   * has not persisted yet (files seeded through the `MemoryFileSystem`
   * tree-builder), claiming spares - or overdraft ids - for them.
   *
   * A failure after the write may leave a complete snapshot in the slot,
   * and the storage may keep it however the call failed. It records the
   * live tree as of this call, the failed change included, which a failed
   * syscall allows. Re-init would load it and ignore the log, so the log
   * takes no appends after it (see `compact`), and any data file the
   * change freed stays out of the spare pool (see `quarantine`). Its
   * generation is not used again in this session (see
   * `attemptedGeneration`), and the retry goes to the same slot, so
   * the current snapshot stays intact whatever the retry leaves behind,
   * and a retry that succeeds replaces it.
   */
  private snapshotFlush(change?: PendingChange): void {
    const root = this.fileSystem.lookup("/") as DirectoryNode;
    let generation = this.attemptedGeneration + 1;
    if (generation % 2 === this.generation % 2) generation++;
    this.attemptedGeneration = generation;
    const handle = this.metaHandles[generation % 2];
    const out = this.encoder;
    const assigned: DirectoryNode[] = [];
    const named: (FileNode | SymlinkNode)[] = [];
    // The directories the snapshot records: once it is durable, the only
    // ones with an id (see `dirIds`).
    const reached = new WeakMap([[root, ROOT_DIR_ID]]);
    let buffer: Uint8Array;
    try {
      beginSnapshot(out, generation);
      this.encodeDir(root, ROOT_DIR_ID, out, {
        assigned,
        named,
        reached,
        change,
      });
      buffer = finishSnapshot(out);
      writeFully(handle, buffer, 0);
      handle.truncate(buffer.byteLength);
      handle.flush();
    } catch (error) {
      // A directory is recorded only once a durable record names it: log
      // records under an id the snapshot never stored would be dropped.
      for (const dir of assigned) this.dirIds.delete(dir);
      try {
        // The snapshot may include the change that failed. Empty the slot
        // so that nothing publishes it later, such as storage persisting
        // the slot when `close()` releases its handle; the current snapshot
        // and log still hold everything. A crash before then may keep it
        // (see above).
        handle.truncate(0);
      } catch {
        // Then a later flush may publish it, with the same effect.
      }
      throw error;
    }
    this.generation = generation;
    this.snapshotBytes = buffer.byteLength;
    this.dirIds = reached;
    for (const node of named) this.known.add(node);
    this.spares.push(...this.quarantine.splice(0));
  }

  /**
   * Emit the records that recreate `dir`'s subtree, in `entries` order as
   * `seen.change` will leave it,
   * collecting the directories given new ids, every directory recorded
   * with its id, and the file and symlink nodes named.
   */
  private encodeDir(
    dir: DirectoryNode,
    dirId: number,
    out: ByteWriter,
    seen: {
      assigned: DirectoryNode[];
      named: (FileNode | SymlinkNode)[];
      reached: WeakMap<DirectoryNode, number>;
      change?: PendingChange;
    },
  ): void {
    for (const [name, child] of entriesAfter(dir, seen.change)) {
      switch (child.type) {
        case "dir": {
          let id = this.dirIds.get(child);
          if (id === undefined) {
            id = this.nextDirId++;
            this.dirIds.set(child, id);
            seen.assigned.push(child);
          }
          seen.reached.set(child, id);
          encodeRecord(out, { op: Op.Mkdir, parent: dirId, name, dir: id });
          this.encodeDir(child, id, out, seen);
          break;
        }
        case "file": {
          this.adopt(child);
          seen.named.push(child);
          const file =
            this.physByNode.get(child) ?? this.pendingIds.get(child)!;
          encodeRecord(out, { op: Op.File, parent: dirId, name, file });
          break;
        }
        case "symlink":
          seen.named.push(child);
          encodeRecord(out, {
            op: Op.Symlink,
            parent: dirId,
            name,
            target: child.target,
          });
          break;
        case "character":
          // Recreated by the MemoryFileSystem constructor on re-init.
          break;
      }
    }
  }

  /**
   * Give `node` a physical data file, synchronously, by claiming a spare.
   * Any in-memory content (tree-builder seeded files) moves into it. With
   * the pool dry the node overdrafts: it gets an id now and a physical
   * file later, and until then its content stays in memory (and `sync`
   * refuses to pretend otherwise).
   */
  private adopt(node: FileNode): void {
    if (this.physByNode.has(node) || this.pendingIds.has(node)) return;
    const id = this.spares.shift();
    if (id === undefined) {
      this.pendingIds.set(node, this.nextId++);
      this.scheduleBackground();
      return;
    }
    // Spares are durably empty - every path into the pool creates the
    // file or truncates and flushes it - so an empty node needs no I/O.
    if (node.content.byteLength > 0) {
      const handle = this.handleById.get(id)!;
      try {
        writeFully(handle, node.content, 0);
        handle.flush();
      } catch (error) {
        try {
          // Keep the invariant before handing the spare back.
          handle.truncate(0);
          handle.flush();
          this.spares.unshift(id);
        } catch {
          // Leave it out of the pool; re-init reclaims the data file.
        }
        throw error;
      }
    }
    this.physByNode.set(node, id);
    node.content = new Uint8Array(0);
    this.scheduleBackground();
  }

  /**
   * Destroy a file's durable content and recycle its data file. Deferred
   * to the last handle closing while fds are open (dangling-fd semantics).
   * `mayBeNamed` says a record that may yet become durable still names the
   * file (see `recycle`). Returns an errno; on failure nothing is recycled.
   */
  private tombstone(node: FileNode, mayBeNamed: boolean): number {
    const pendingId = this.pendingIds.get(node);
    if (pendingId !== undefined) {
      // Never materialized: nothing durable exists to destroy, and the
      // materializer will notice the cancellation and recycle the file it
      // may already have created. Open fds keep working on the in-memory
      // content.
      this.pendingIds.delete(node);
      this.known.delete(node);
      this.recycleAbandoned(pendingId, mayBeNamed);
      return ESUCCESS;
    }
    if (!this.physByNode.has(node)) return ESUCCESS;
    // Open fds keep the bytes: `closeFile` destroys them at the last close,
    // once the syscall layer has dropped `nlink` to 0.
    if ((this.openCounts.get(node) ?? 0) > 0) return ESUCCESS;
    return this.destroyContent(node, mayBeNamed);
  }

  /**
   * Return an emptied data file to the spare pool, or, while a record that
   * may yet become durable still names it, to `quarantine`.
   */
  private recycle(id: number, mayBeNamed: boolean): void {
    if (mayBeNamed) this.quarantine.push(id);
    else this.spares.push(id);
  }

  /**
   * A failed materialization leaves its handle tracked for the retry, but
   * a cancelled id is never retried, so recycle that handle here. (An
   * attempt still acquiring one has not tracked it yet, and recycles it
   * itself.)
   */
  private recycleAbandoned(id: number, mayBeNamed: boolean): void {
    const handle = this.handleById.get(id);
    if (handle === undefined) return;
    try {
      handle.truncate(0);
      handle.flush();
      this.recycle(id, mayBeNamed);
    } catch {
      // It may still hold content, so it cannot be a spare. Release its
      // lock instead; re-init reclaims the unreferenced data file.
      this.handleById.delete(id);
      try {
        handle.close();
      } catch {
        // Already closed or revoked.
      }
    }
  }

  private destroyContent(node: FileNode, mayBeNamed: boolean): number {
    const id = this.physByNode.get(node)!;
    const handle = this.handleById.get(id)!;
    // No durable record names the file any more; see the class comment.
    try {
      handle.truncate(0);
      handle.flush();
    } catch (error) {
      // The data file may still hold live bytes: keep it mapped to the
      // node rather than recycling a spare with content in it, and let
      // the caller decide what the failure means.
      return this.errnoOf(error);
    }
    this.physByNode.delete(node);
    this.known.delete(node);
    this.recycle(id, mayBeNamed);
    return ESUCCESS;
  }

  private scheduleBackground(): void {
    if (this.replenishScheduled || this.closed) return;
    this.replenishScheduled = true;
    // A round starts even after a failed one: it retries whatever that
    // round left undone.
    this.background = this.background
      .catch(() => {})
      .then(async () => {
        this.replenishScheduled = false;
        // Materialize overdrafted files first: each waits on a durability
        // guarantee (`sync` fails until its physical file exists). Files
        // overdrafted meanwhile are picked up by the next batch. One
        // failure does not hold the others back.
        const failures: unknown[] = [];
        const tried = new Set<FileNode>();
        for (;;) {
          const batch = [...this.pendingIds].filter(
            ([node]) => !tried.has(node),
          );
          if (batch.length === 0) break;
          for (const [node] of batch) tried.add(node);
          await forEachConcurrently(batch, async ([node, id]) => {
            try {
              await this.materialize(node, id);
            } catch (error) {
              failures.push(error);
            }
          });
        }
        if (failures.length > 0) throw failures[0];
        // Then refill the spare pool.
        if (!this.closed) await this.refillSpares();
      });
    // `settle()` and `close()` report a failure; nothing else awaits it.
    this.background.catch(() => {});
  }

  /**
   * Acquire the sync access handle of data file `id`, creating the file if
   * needed. Background work can outlive the backend - a failed `create()`
   * releases every handle while work it queued still waits on OPFS - so a
   * handle that arrives after shutdown is released at once, and nothing is
   * returned in its place.
   */
  private async openDataFile(
    id: number,
  ): Promise<OPFSSyncAccessHandle | undefined> {
    const fileHandle = await this.store.getFileHandle(dataName(id), {
      create: true,
    });
    if (this.closed) return undefined;
    const handle = await fileHandle.createSyncAccessHandle();
    if (this.closed) {
      try {
        handle.close();
      } catch {
        // Already closed or revoked.
      }
      return undefined;
    }
    return handle;
  }

  /**
   * Give an overdrafted file its physical data file. A handle left by an
   * earlier failed attempt is reused: it still holds the file's exclusive
   * lock, so acquiring another would fail.
   */
  private async materialize(node: FileNode, id: number): Promise<void> {
    // Unlinked before its turn: `tombstone` recycled any handle it had.
    if (this.pendingIds.get(node) !== id) return;
    let handle = this.handleById.get(id);
    const retry = handle !== undefined;
    if (handle === undefined) {
      handle = await this.openDataFile(id);
      if (handle === undefined) return;
      // Tracked at once, so a failure below leaves it for the next attempt
      // and for `close()` to release.
      this.handleById.set(id, handle);
    }
    if (this.pendingIds.get(node) !== id || this.closed) {
      // Unlinked (or shut down) while we were acquiring the handle:
      // recycle the physical file. Whether the record that dropped the id
      // became durable is no longer known here, so assume it did not.
      if (this.pendingIds.get(node) === id) this.pendingIds.delete(node);
      this.recycleAbandoned(id, true);
      return;
    }
    try {
      if (node.content.byteLength > 0) {
        writeFully(handle, node.content, 0);
      }
      // An earlier attempt may have written more than the content now holds.
      if (retry) handle.truncate(node.content.byteLength);
      handle.flush();
    } catch (error) {
      try {
        // A failed write may leave part of the content in the file, and
        // releasing the handle at `close()` may persist it. Empty the
        // file, so nothing publishes a prefix the file never held as a
        // whole; the content stays in memory for the retry.
        handle.truncate(0);
      } catch {
        // Then a later flush, or the storage itself before a crash, may
        // still publish that prefix; `close()` removes the data file of a
        // file it reports lost.
      }
      throw error;
    }
    this.pendingIds.delete(node);
    this.physByNode.set(node, id);
    node.content = new Uint8Array(0);
  }

  /** Create spare data files until the pool reaches its target. */
  private async refillSpares(): Promise<void> {
    const ids: number[] = [];
    while (this.spares.length + ids.length < this.spareTarget) {
      ids.push(this.nextId++);
    }
    await forEachConcurrently(ids, async (id) => {
      const handle = await this.openDataFile(id);
      if (handle === undefined) return;
      this.handleById.set(id, handle);
      this.spares.push(id);
    });
  }

  /**
   * Report a storage failure to the syscall layer as `FSError`. A
   * `TypeError` is a bug, not a storage failure, so it propagates.
   */
  private storageError(error: unknown): never {
    if (error instanceof TypeError) throw error;
    throw new FSError(this.errnoOf(error), error);
  }

  private errnoOf(error: unknown): number {
    if (error instanceof RangeError) return FSErrno.NOSPC;
    if ((error as { name?: string } | null)?.name === "QuotaExceededError") {
      return FSErrno.NOSPC;
    }
    return FSErrno.IO;
  }

  // -------------------------------------------------------------------
  // Public lifecycle helpers
  // -------------------------------------------------------------------

  /**
   * Wait until background work is quiescent - no round queued or
   * running, no file waiting for its data file: files created past the
   * spare pool get their data files (until then their content lives only
   * in memory and `fd_sync` on them fails), and the pool is refilled to
   * `spareFiles`. Background work runs only between guest calls, so a
   * host that starts calls back to back should await this between them
   * whenever created files should survive a crash, or before a call that
   * creates many files. Guest calls may still run while it waits, and it
   * waits for the work they queue too, so no file reachable when it
   * resolves still waits for its data file; a guest that keeps creating
   * files past the pool during every wait can delay that indefinitely.
   * Rejects as soon as a round fails; the files it left keep their
   * content in memory, and the next `settle()` (or file creation)
   * retries.
   */
  async settle(): Promise<void> {
    // A fresh round retries what an earlier failed one left, rather than
    // reporting its stale failure.
    this.scheduleBackground();
    for (;;) {
      const round = this.background;
      await round;
      // A guest call during the wait queued another round: wait for it.
      if (this.background !== round) continue;
      // Only a closed backend leaves files pending after a clean round.
      if (this.pendingIds.size === 0 || this.closed) return;
      this.scheduleBackground();
    }
  }

  /**
   * Make every file reachable in the tree durable, name and content alike,
   * including files seeded through the `MemoryFileSystem` tree-builder
   * after `create()`: once it resolves, a crash keeps each one with the
   * content it held then. Guest calls may run while it waits; it resolves
   * once background work is quiescent (see `settle()`), and covers every
   * file reachable at that point except files seeded while it waited. A
   * guest that keeps creating files past the spare pool during every wait
   * can delay that indefinitely. Being async it does not draw on the
   * spare pool; call it after seeding to keep the pool free for the
   * guest. Rejects if any of it failed.
   */
  async persistAll(): Promise<void> {
    const root = this.fileSystem.lookup("/") as DirectoryNode;
    await this.adoptSubtree(root);
    this.compact();
    // A guest call may overdraft another file once `settle()` has resolved
    // but before this resumes: settle again until none is pending. No
    // await separates that check from the flush, so no guest call can
    // slip in between.
    do {
      await this.settle();
    } while (this.pendingIds.size > 0);
    // Files that had a data file already may hold writes no flush has
    // covered yet.
    const failure = this.flushDataFiles();
    if (failure !== undefined) throw failure;
  }

  private async adoptSubtree(root: DirectoryNode): Promise<void> {
    const unadopted: FileNode[] = [];
    const walk = (dir: DirectoryNode): void => {
      for (const name of Object.keys(dir.entries)) {
        const child = dir.entries[name];
        if (child.type === "dir") {
          walk(child);
        } else if (
          child.type === "file" &&
          !this.physByNode.has(child) &&
          // Overdrafted files already have an id; settle() materializes them.
          !this.pendingIds.has(child)
        ) {
          unadopted.push(child);
        }
      }
    };
    walk(root);
    await forEachConcurrently(unadopted, async (child) => {
      const id = this.nextId++;
      const handle = await this.openDataFile(id);
      if (handle === undefined) return;
      this.handleById.set(id, handle);
      if (
        this.physByNode.has(child) ||
        this.pendingIds.has(child) ||
        child.nlink === 0
      ) {
        // Adopted while the handle was on its way, by a guest open or a
        // snapshot, and maybe written and synced since; or unlinked (or
        // replaced by a rename), so no name needs its bytes. The new data
        // file is empty and no record names it: keep it as a spare.
        this.spares.push(id);
        return;
      }
      try {
        if (child.content.byteLength > 0) {
          writeFully(handle, child.content, 0);
        }
        handle.flush();
      } catch (error) {
        // No record names the new data file: empty it for the pool.
        this.recycleAbandoned(id, false);
        throw error;
      }
      this.physByNode.set(child, id);
      child.content = new Uint8Array(0);
    });
  }

  /**
   * Make the content of every stored file durable and release every
   * handle; the backend is unusable afterwards. Seeded files that nothing
   * has stored yet are not saved; see `persistAll()`. Rejects, once
   * everything is released, if a file created past the spare pool still
   * could not get its data file (its name is recorded, but the content it
   * held only in memory is lost), or if flushing a file's content failed
   * (what was written to it since its last successful `fd_sync` may be
   * lost).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    // Let pending materializations and refills finish first (retrying any
    // that failed), so files created past the spare pool become durable on
    // a clean shutdown. Settling again if a guest call overdrafted a file
    // after `settle()` resolved means only a failure loses content.
    let failure: unknown = undefined;
    do {
      failure = await this.settle().then(
        () => undefined,
        (error: unknown) => error,
      );
    } while (failure === undefined && this.pendingIds.size > 0);
    const lost = new Set(this.pendingIds.keys());
    // Data files that failed attempts acquired for the files lost.
    const abandoned = [...this.pendingIds.values()].filter((id) =>
      this.handleById.has(id),
    );
    this.closed = true;
    await this.background.catch(() => {});
    // Leave the pool at its target, so the next `create()` does not have
    // to open and remove data files freed by this session's unlinks.
    const excess = this.spares.splice(this.spareTarget);
    for (const id of excess) {
      try {
        this.handleById.get(id)!.close();
      } catch {
        // Already closed or revoked; the removal below may still work.
      }
      this.handleById.delete(id);
    }
    await forEachConcurrently(excess, (id) =>
      this.store.removeEntry(dataName(id)),
    ).catch(() => {
      // Best effort: re-init reclaims whatever is left.
    });
    // A guest call during those waits may have overdrafted a file that no
    // round can give a data file any more.
    for (const node of this.pendingIds.keys()) lost.add(node);
    // Closing a sync access handle only releases it: the File System
    // Standard leaves persisting its writes to `flush()`.
    const flushFailure = this.flushDataFiles();
    this.releaseHandles();
    // A failed attempt that could not empty its data file left part of a
    // lost file's content there, and closing the handle may have
    // persisted it. Remove those data files, so the next open recreates
    // them empty rather than showing a prefix the file never held. Best
    // effort: if the removal fails, or a crash comes first, the prefix may
    // remain.
    for (const id of abandoned) {
      try {
        await this.store.removeEntry(dataName(id));
      } catch {
        // See above.
      }
    }
    if (lost.size > 0) {
      throw (
        failure ??
        new Error(`uwasi: ${lost.size} files lost their content at close`)
      );
    }
    if (flushFailure !== undefined) throw flushFailure;
  }

  /**
   * Flush the data file of every file the guest may still reach; unlinked
   * files awaiting their last close are skipped. The namespace slots and
   * the log are not flushed: every successful change flushed its record
   * already, and a failed one may have left bytes there that a flush would
   * publish.
   * Every file is tried; returns the first failure.
   */
  private flushDataFiles(): unknown {
    let failure: unknown = undefined;
    for (const [node, id] of this.physByNode) {
      // An unlinked file waiting for its last close.
      if (node.nlink === 0) continue;
      try {
        this.handleById.get(id)!.flush();
      } catch (error) {
        failure ??= error;
      }
    }
    return failure;
  }

  private releaseHandles(): void {
    const handles = [...this.handleById.values(), ...this.metaHandles];
    // Unset when opening failed before it reached the log.
    if (this.logHandle !== undefined) handles.push(this.logHandle);
    for (const handle of handles) {
      try {
        handle.close();
      } catch {
        // Already closed or revoked; nothing left to release.
      }
    }
  }

  // -------------------------------------------------------------------
  // File content, through the handles `openFile` returns
  // -------------------------------------------------------------------

  fileSize(node: FileNode): number {
    const id = this.physByNode.get(node);
    if (id === undefined) return node.content.byteLength;
    try {
      return this.handleById.get(id)!.getSize();
    } catch (error) {
      this.storageError(error);
    }
  }

  private readAt(node: FileNode, buf: Uint8Array, offset: number): number {
    const id = this.physByNode.get(node);
    if (id === undefined) {
      const data = node.content;
      if (offset >= data.byteLength) return 0;
      const count = Math.min(buf.byteLength, data.byteLength - offset);
      buf.set(data.subarray(offset, offset + count));
      return count;
    }
    if (buf.byteLength === 0) return 0;
    try {
      return this.handleById.get(id)!.read(buf, { at: offset });
    } catch (error) {
      this.storageError(error);
    }
  }

  private writeAt(node: FileNode, data: Uint8Array, offset: number): number {
    this.ensureStored(node);
    const id = this.physByNode.get(node);
    if (id === undefined) {
      // Created past the spare pool: plain in-memory write; the content
      // moves to OPFS wholesale when the background work gives the file
      // its data file.
      const end = offset + data.byteLength;
      if (end > node.content.byteLength) {
        const grown = resizedContent(node.content, end);
        if (grown === null) throw new FSError(FSErrno.NOSPC);
        node.content = grown;
      }
      node.content.set(data, offset);
      return data.byteLength;
    }
    let written: number;
    try {
      // A write past the end zero-fills the gap, as the File System spec
      // says. OPFS reports a partial write, for example under quota
      // pressure, only through the count, which the syscall reports in turn.
      written = this.handleById.get(id)!.write(data, { at: offset });
    } catch (error) {
      this.storageError(error);
    }
    if (written === 0) throw new FSError(FSErrno.NOSPC);
    return written;
  }

  /**
   * A file not stored yet (seeded, or created past the spare pool) resizes
   * in memory: a truncate needs nothing from storage, and the change is
   * stored with the file's first write or sync.
   */
  private resize(node: FileNode, size: number): void {
    const id = this.physByNode.get(node);
    if (id === undefined) {
      const next = resizedContent(node.content, size);
      if (next === null) throw new FSError(FSErrno.NOSPC);
      node.content = next;
      return;
    }
    try {
      this.handleById.get(id)!.truncate(size);
    } catch (error) {
      this.storageError(error);
    }
  }

  private sync(node: FileNode): void {
    // A sync asks for durability, so it stores a seeded file first.
    this.ensureStored(node);
    if (this.pendingIds.has(node)) {
      // The physical file has not materialized yet, so content durability
      // cannot be guaranteed. Report the failure, as fsync may fail with
      // ENOSPC on POSIX too.
      throw new FSError(FSErrno.NOSPC);
    }
    const id = this.physByNode.get(node);
    // No data file and no pending id after `ensureStored`: the file is
    // unlinked, so no name keeps its content and there is nothing to flush.
    if (id === undefined) return;
    try {
      this.handleById.get(id)!.flush();
    } catch (error) {
      this.storageError(error);
    }
  }

  /**
   * A directory needs nothing: every namespace change flushed its record
   * before its syscall returned. Flushing the slots or the log again could
   * only make durable what a failed change left behind.
   */
  syncDirectory(_dir: DirectoryNode): void {}

  // -------------------------------------------------------------------
  // FSBackend: fd lifecycle
  // -------------------------------------------------------------------

  /**
   * Store a file the record does not name yet, or one that lost its data
   * file: give it a data file, and record it with a snapshot. This covers
   * files seeded through `fileSystem`, and retries after recording them
   * failed. A file the guest created is stored already: `createChild`
   * recorded it. An overdrafted file needs no new record: its id is in it.
   */
  private ensureStored(node: FileNode): void {
    // An unlinked file has no name to record: its writes stay where they
    // are, in its data file or in memory, until its last fd closes.
    if (node.nlink === 0) return;
    if (
      this.known.has(node) &&
      (this.physByNode.has(node) || this.pendingIds.has(node))
    ) {
      return;
    }
    try {
      this.adopt(node);
      this.compact();
    } catch (error) {
      this.storageError(error);
    }
  }

  /**
   * Opening writes nothing: a seeded file is stored on its first write or
   * sync (see `ensureStored`), so reading it never needs storage. Every
   * data file keeps one read-write sync access handle for the backend's
   * life, since those are exclusive locks; the returned handle works
   * through it.
   */
  openFile(node: FileNode, _mode: OpenMode): FileHandle {
    this.openCounts.set(node, (this.openCounts.get(node) ?? 0) + 1);
    let closed = false;
    return {
      readAt: (buf, offset) => this.readAt(node, buf, offset),
      writeAt: (data, offset) => this.writeAt(node, data, offset),
      resize: (size) => this.resize(node, size),
      sync: () => this.sync(node),
      datasync: () => this.sync(node),
      close: () => {
        if (closed) return;
        closed = true;
        this.closeFile(node);
      },
    };
  }

  private closeFile(node: FileNode): void {
    const count = this.openCounts.get(node) ?? 0;
    if (count > 1) {
      this.openCounts.set(node, count - 1);
      return;
    }
    this.openCounts.delete(node);
    // The last fd on an unlinked file: hard links are refused, so a file
    // with no names left is one the guest unlinked or replaced. A failure
    // here has nowhere to be reported; the data file stays mapped and
    // unreferenced, and re-init reclaims it, since no record names it.
    if (node.nlink === 0 && this.physByNode.has(node)) {
      this.destroyContent(node, false);
    }
  }

  // -------------------------------------------------------------------
  // FSBackend: namespace
  // -------------------------------------------------------------------

  createChild(parent: DirectoryNode, name: string, node: FSNode): void {
    try {
      this.persist(this.createRecord(parent, name, node), {
        add: { dir: parent, name, node },
      });
    } catch (error) {
      if (node.type === "file") {
        // Hand back the data file (or overdraft id) the record would have
        // named. The failed record - a snapshot left in its slot, or a log
        // record past the end of the log - may still become durable, so
        // the data file waits in quarantine rather than backing the next
        // file at once.
        this.tombstone(node, true);
      }
      this.storageError(error);
    }
    if (node.type === "file" || node.type === "symlink") this.known.add(node);
  }

  /**
   * Hard links are not supported: the namespace record maps each data file
   * to exactly one name, and stores each symlink name as a node of its own.
   */
  linkChild(_parent: DirectoryNode, _name: string, _node: FSNode): void {
    throw new FSError(FSErrno.NOTSUP);
  }

  /**
   * Whether a durable record names `node`, so that a log record referring
   * to it replays. Replay skips a record whose node it does not find, so a
   * change touching an unrecorded node (one seeded through the tree-builder,
   * or one whose recording failed) takes a full snapshot instead.
   */
  private recorded(node: FSNode): boolean {
    switch (node.type) {
      case "dir":
        return this.dirIds.has(node);
      case "file":
      case "symlink":
        return this.known.has(node);
      default:
        // No record names a device node; changes naming one are refused
        // before they get here (see `involvesDevice`).
        return false;
    }
  }

  private createRecord(
    parent: DirectoryNode,
    name: string,
    node: FSNode,
  ): NsRecord | null {
    const dirId = this.dirIds.get(parent);
    if (dirId === undefined) return null;
    switch (node.type) {
      case "dir": {
        if (Object.keys(node.entries).length > 0) return null;
        const id = this.nextDirId++;
        this.dirIds.set(node, id);
        return { op: Op.Mkdir, parent: dirId, name, dir: id };
      }
      case "file": {
        this.adopt(node);
        const file = this.physByNode.get(node) ?? this.pendingIds.get(node)!;
        return { op: Op.File, parent: dirId, name, file };
      }
      case "symlink":
        return { op: Op.Symlink, parent: dirId, name, target: node.target };
      default:
        return null;
    }
  }

  removeChild(parent: DirectoryNode, name: string): void {
    const node = parent.entries[name];
    if (involvesDevice(node)) throw new FSError(FSErrno.NOTSUP);
    const dirId = this.dirIds.get(parent);
    try {
      // Record the removal first. If that fails, nothing has changed: the
      // name and its bytes stay. A failed record may still become durable
      // (see `persist`); a crash then drops the name, and re-init reclaims
      // the data file, which no record names any more.
      this.persist(
        dirId === undefined ? null : { op: Op.Remove, parent: dirId, name },
        { remove: { dir: parent, name } },
      );
    } catch (error) {
      this.storageError(error);
    }
    // No durable record names the file now, so its data file can be
    // reused at once. Open fds keep the bytes until their last close.
    if (node !== undefined && node.type === "file") this.tombstone(node, false);
  }

  renameChild(
    fromParent: DirectoryNode,
    fromName: string,
    toParent: DirectoryNode,
    toName: string,
  ): void {
    const node = fromParent.entries[fromName];
    const replaced = toParent.entries[toName];
    if (involvesDevice(node) || involvesDevice(replaced)) {
      throw new FSError(FSErrno.NOTSUP);
    }
    const fromId = this.dirIds.get(fromParent);
    const toId = this.dirIds.get(toParent);
    try {
      // Record the new mapping first, so that a crash here shows either
      // the old target or the renamed node at the destination, never a
      // truncated file in between.
      this.persist(
        fromId === undefined ||
          toId === undefined ||
          !this.recorded(node) ||
          (replaced !== undefined && !this.recorded(replaced))
          ? null
          : {
              op: Op.Rename,
              fromParent: fromId,
              fromName,
              toParent: toId,
              toName,
            },
        {
          remove: { dir: fromParent, name: fromName },
          add: { dir: toParent, name: toName, node },
        },
      );
    } catch (error) {
      this.storageError(error);
    }
    if (
      replaced !== undefined &&
      replaced !== node &&
      replaced.type === "file"
    ) {
      // The record no longer references the replaced target, so this is
      // cleanup rather than a durability point: a failure here leaves an
      // unreferenced data file that re-init reclaims.
      this.tombstone(replaced, false);
    }
  }
}
