import {
  ExclusiveOPFSBackend,
  ExclusiveOPFSFileSystem,
  OPFSStoreBusyError,
} from "uwasi/opfs";
import { FSError, useFS } from "uwasi/filesystem";
import { WASIAbi } from "../lib/esm/abi.js";
import { MockOPFS } from "./opfs_mock.mjs";
import {
  bindImports,
  sysCreate,
  sysOpen,
  sysWrite,
  sysReadText,
  sysClose,
  sysSync,
  sysDatasync,
  sysStat,
  sysMkdir,
  sysRename,
  sysUnlink,
  sysSeekStart,
} from "./syscall_harness.mjs";
import { describe, it } from "node:test";
import assert from "node:assert";

const ESUCCESS = 0;
const {
  WASI_ERRNO_NOENT: NOENT,
  WASI_ERRNO_NOSPC: NOSPC,
  WASI_ERRNO_NOTSUP: NOTSUP,
} = WASIAbi;

describe("ExclusiveOPFSBackend", () => {
  async function open(t) {
    const backend = await ExclusiveOPFSBackend.create(new MockOPFS().root);
    t.after(() => backend.close());
    return { backend, root: backend.fileSystem.lookup("/") };
  }
  // A fresh file node, as the syscall layer builds it, not yet in the tree.
  const newFile = (backend, bytes = []) =>
    backend.fileSystem.stamp({
      type: "file",
      content: new Uint8Array(bytes),
      nlink: 1,
    });
  const read = (backend, file, handle) => {
    const bytes = new Uint8Array(backend.fileSize(file));
    assert.strictEqual(handle.readAt(bytes, 0), bytes.length);
    return [...bytes];
  };
  const refuses = (call, errno) =>
    assert.throws(
      call,
      (error) => error instanceof FSError && error.errno === errno,
    );

  it("writes and resizes with zero fill, and reads short at the end", async (t) => {
    const { backend, root } = await open(t);
    const file = newFile(backend, [1, 2, 3]);
    backend.createChild(root, "file", file);
    const handle = backend.openFile(file, { read: true, write: true });
    assert.strictEqual(handle.writeAt(new Uint8Array([9]), 1), 1);
    assert.strictEqual(handle.writeAt(new Uint8Array([7]), 5), 1);
    assert.deepStrictEqual(read(backend, file, handle), [1, 9, 3, 0, 0, 7]);
    assert.strictEqual(handle.readAt(new Uint8Array(4), 4), 2);
    assert.strictEqual(handle.readAt(new Uint8Array(4), 10), 0);
    handle.resize(1);
    handle.resize(3);
    assert.deepStrictEqual(read(backend, file, handle), [1, 0, 0]);
    handle.close();
  });

  it("persists namespace changes without changing the live tree", async () => {
    const store = new MockOPFS();
    const backend = await ExclusiveOPFSBackend.create(store.root);
    const root = backend.fileSystem.lookup("/");
    backend.createChild(root, "file", newFile(backend));
    assert.strictEqual(root.entries.file, undefined);
    store.simulateCrash();
    const fresh = await ExclusiveOPFSBackend.create(store.root);
    assert.strictEqual(fresh.fileSystem.lookup("/file").type, "file");
    await fresh.close();
  });

  it("does not touch the live tree when a change takes a snapshot", async () => {
    const store = new MockOPFS();
    const backend = await ExclusiveOPFSBackend.create(store.root);
    // A seeded directory has no record yet, so renaming it takes a snapshot.
    backend.fileSystem.addFile("/dir/seeded", "seeded");
    const root = backend.fileSystem.lookup("/");
    const writes = [];
    root.entries = new Proxy(root.entries, {
      set(target, name, value) {
        writes.push(name);
        target[name] = value;
        return true;
      },
      deleteProperty(target, name) {
        writes.push(name);
        return delete target[name];
      },
    });
    backend.renameChild(root, "dir", root, "moved");
    assert.deepStrictEqual(writes, []);
    store.simulateCrash();
    const fresh = await makeWorker(store);
    assertFile(fresh.h, "moved/seeded", "seeded");
    await fresh.backend.close();
  });

  it("keeps a change that a compaction after its log record folds in", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "a", "kept");
    // Rename back and forth until the log shrinks: the last rename's record
    // made the log big enough to compact, so the snapshot must hold it.
    const logSize = () => store.durableContent(".uwasi.meta.log").byteLength;
    let name = "a";
    for (let before = logSize(); ; before = logSize()) {
      const next = name === "a" ? "b" : "a";
      assert.strictEqual(sysRename(w.h, name, next), ESUCCESS);
      name = next;
      if (logSize() < before) break;
    }
    store.simulateCrash();
    const fresh = await makeWorker(store);
    assertFile(fresh.h, name, "kept");
    await fresh.backend.close();
  });

  it("refuses hard links and changes to device nodes", async (t) => {
    const { backend, root } = await open(t);
    const file = newFile(backend);
    backend.createChild(root, "file", file);
    refuses(() => backend.linkChild(root, "second", file), NOTSUP);
    assert.strictEqual(root.entries.second, undefined);
    refuses(() => backend.removeChild(root.entries.dev, "null"), NOTSUP);
    refuses(() => backend.renameChild(root, "dev", root, "devices"), NOTSUP);
    assert.strictEqual(root.entries.dev.entries.null.type, "character");
  });
});

async function makeWorker(store, options = {}) {
  const backend = await ExclusiveOPFSBackend.create(store.root, options);
  return { backend, h: bindImports(backend, backend.fileSystem) };
}

function putFile(h, name, text) {
  const { errno, fd } = sysCreate(h, name);
  assert.strictEqual(errno, ESUCCESS, name);
  assert.strictEqual(sysWrite(h, fd, text).errno, ESUCCESS);
  assert.strictEqual(sysSync(h, fd), ESUCCESS);
  assert.strictEqual(sysClose(h, fd), ESUCCESS);
}

function assertFile(h, name, text) {
  const { errno, fd } = sysOpen(h, name);
  assert.strictEqual(errno, ESUCCESS, name);
  assert.deepStrictEqual(sysReadText(h, fd), { errno: ESUCCESS, text });
  assert.strictEqual(sysClose(h, fd), ESUCCESS);
}

describe("OPFS persistence", () => {
  it("creates, writes, reads and reopens through useFS", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const fileSystem = await ExclusiveOPFSFileSystem.create(store.root);
    const h = bindImports(fileSystem.backend, fileSystem);
    h.imports = useFS({ withFileSystem: fileSystem })(
      {},
      new WASIAbi(),
      () => h.view,
    );
    putFile(h, "data.db", "hello opfs");
    assertFile(h, "data.db", "hello opfs");
    await fileSystem.backend.close();
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "data.db", "hello opfs");
    await fresh.backend.close();
  });

  it("sync and datasync survive a crash, unlike unsynced content", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store);
    for (const [name, flush] of [
      ["sync", sysSync],
      ["datasync", sysDatasync],
    ]) {
      const { errno, fd } = sysCreate(w.h, name);
      assert.strictEqual(errno, ESUCCESS);
      assert.strictEqual(sysWrite(w.h, fd, name).errno, ESUCCESS);
      assert.strictEqual(flush(w.h, fd), ESUCCESS);
    }
    const unsynced = sysCreate(w.h, "unsynced");
    assert.strictEqual(unsynced.errno, ESUCCESS);
    assert.strictEqual(sysWrite(w.h, unsynced.fd, "lost").errno, ESUCCESS);
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "sync", "sync");
    assertFile(fresh.h, "datasync", "datasync");
    assertFile(fresh.h, "unsynced", "");
    await fresh.backend.close();
  });

  it("pending file sync returns NOSPC until settle materializes it", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store, { spareFiles: 1 });
    assert.strictEqual(sysCreate(w.h, "first").errno, ESUCCESS);
    const pending = sysCreate(w.h, "pending");
    assert.strictEqual(pending.errno, ESUCCESS);
    assert.strictEqual(sysWrite(w.h, pending.fd, "payload").errno, ESUCCESS);
    assert.strictEqual(sysSync(w.h, pending.fd), NOSPC);
    await w.backend.settle();
    assert.strictEqual(sysSync(w.h, pending.fd), ESUCCESS);
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "pending", "payload");
    await fresh.backend.close();
  });

  it("opens a seeded file without writing to storage until it changes", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store);
    w.backend.fileSystem.addFile("/read", "seeded");
    w.backend.fileSystem.addFile("/trunc", "seeded");
    // Storage is full: any write would fail.
    store.injectFault({ op: "write", times: Infinity });
    const READ = 1n << 1n;
    const read = sysOpen(w.h, "read", 0, READ);
    assert.strictEqual(read.errno, ESUCCESS);
    assert.deepStrictEqual(sysReadText(w.h, read.fd), {
      errno: ESUCCESS,
      text: "seeded",
    });
    // Truncating needs no copy of the old bytes.
    const trunc = sysOpen(w.h, "trunc", WASIAbi.WASI_OFLAGS_TRUNC);
    assert.strictEqual(trunc.errno, ESUCCESS);
    assert.strictEqual(sysStat(w.h, "trunc").size, 0);
    store.clearFaults();
    // The first write stores the file, and sync makes it durable.
    assert.strictEqual(sysWrite(w.h, trunc.fd, "new").errno, ESUCCESS);
    assert.strictEqual(sysSync(w.h, trunc.fd), ESUCCESS);
    store.simulateCrash();
    const fresh = await makeWorker(store);
    assertFile(fresh.h, "trunc", "new");
    await fresh.backend.close();
  });

  it("persistAll saves seeded content and close flushes later writes", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store);
    w.backend.fileSystem.addFile("/seeded.txt", "from the embedder");
    await w.backend.persistAll();
    store.simulateCrash();

    const reopened = await makeWorker(store);
    assertFile(reopened.h, "seeded.txt", "from the embedder");
    const { errno, fd } = sysCreate(reopened.h, "closed.txt");
    assert.strictEqual(errno, ESUCCESS);
    assert.strictEqual(
      sysWrite(reopened.h, fd, "flushed on close").errno,
      ESUCCESS,
    );
    assert.strictEqual(sysClose(reopened.h, fd), ESUCCESS);
    await reopened.backend.close();
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "seeded.txt", "from the embedder");
    assertFile(fresh.h, "closed.txt", "flushed on close");
    await fresh.backend.close();
  });
});

describe("OPFS namespace and errors", () => {
  it("an unlinked file keeps its bytes until its last close", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    const old = sysCreate(w.h, "old");
    assert.strictEqual(sysWrite(w.h, old.fd, "OLD").errno, ESUCCESS);
    assert.strictEqual(sysUnlink(w.h, "old"), ESUCCESS);
    await w.backend.settle();
    // "new" claims the only spare, which must not be the data file of "old".
    putFile(w.h, "new", "NEW");
    assert.strictEqual(sysSeekStart(w.h, old.fd), ESUCCESS);
    assert.deepStrictEqual(sysReadText(w.h, old.fd), {
      errno: ESUCCESS,
      text: "OLD",
    });
    assert.strictEqual(sysClose(w.h, old.fd), ESUCCESS);
    assertFile(w.h, "new", "NEW");
    await w.backend.close();
  });

  it("never stores an unlinked file written through an open fd", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    assert.strictEqual(sysClose(w.h, sysCreate(w.h, "a").fd), ESUCCESS);
    // Past the pool: "b" has no data file yet.
    const b = sysCreate(w.h, "b");
    assert.strictEqual(sysUnlink(w.h, "b"), ESUCCESS);
    assert.strictEqual(sysWrite(w.h, b.fd, "SECRET").errno, ESUCCESS);
    assert.strictEqual(sysClose(w.h, b.fd), ESUCCESS);
    await w.backend.settle();
    for (const name of store.rootNames()) {
      const bytes = new TextDecoder().decode(store.durableContent(name));
      assert.ok(!bytes.includes("SECRET"), name);
    }
    await w.backend.close();
  });

  it("renames, replaces and unlinks across reopen", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store);
    assert.strictEqual(sysMkdir(w.h, "dir"), ESUCCESS);
    putFile(w.h, "source", "new content");
    putFile(w.h, "dir/target", "old content");
    assert.strictEqual(sysRename(w.h, "source", "moved"), ESUCCESS);
    assert.strictEqual(sysRename(w.h, "moved", "dir/target"), ESUCCESS);
    store.simulateCrash();

    const reopened = await makeWorker(store);
    assert.strictEqual(sysStat(reopened.h, "source").errno, NOENT);
    assert.strictEqual(sysStat(reopened.h, "moved").errno, NOENT);
    assertFile(reopened.h, "dir/target", "new content");
    assert.strictEqual(sysUnlink(reopened.h, "dir/target"), ESUCCESS);
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assert.strictEqual(sysStat(fresh.h, "dir/target").errno, NOENT);
    assert.strictEqual(sysStat(fresh.h, "dir").errno, ESUCCESS);
    await fresh.backend.close();
  });

  it("failed metadata persistence returns errno and rolls back the live rename", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "source", "kept");
    const fault = store.injectFault({
      op: "flush",
      match: ".uwasi.meta.log",
      error: "QuotaExceededError",
    });
    assert.strictEqual(sysRename(w.h, "source", "target"), NOSPC);
    assert.strictEqual(fault.fired, 1);
    assert.strictEqual(sysStat(w.h, "target").errno, NOENT);
    assertFile(w.h, "source", "kept");
    store.clearFaults();
    await w.backend.close();
  });

  it("reports a physical short write as a short write", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    const { errno, fd } = sysCreate(w.h, "file");
    assert.strictEqual(errno, ESUCCESS);
    const fault = store.injectFault({
      op: "write",
      match: ".uwasi.data.",
      short: 1,
    });
    assert.deepStrictEqual(sysWrite(w.h, fd, "hello"), {
      errno: ESUCCESS,
      written: 1,
    });
    assert.strictEqual(fault.fired, 1);
    store.clearFaults();
    // Nothing written at all is an error, not a success with 0 bytes.
    store.injectFault({ op: "write", match: ".uwasi.data.", short: 0 });
    assert.strictEqual(sysWrite(w.h, fd, "ello").errno, NOSPC);
    store.clearFaults();
    assertFile(w.h, "file", "h");
    await w.backend.close();
  });

  for (const recovery of ["log", "snapshot"]) {
    it(`keeps plain and U+FEFF-prefixed filenames distinct through ${recovery}`, async () => {
      const store = new MockOPFS({ closeFlushes: false });
      const w = await makeWorker(store);
      assert.strictEqual(sysMkdir(w.h, "dir"), ESUCCESS);
      const files = [
        ["dir/name", "plain"],
        ["dir/\uFEFFname", "prefixed"],
      ];
      for (const [name, content] of files) putFile(w.h, name, content);
      if (recovery === "snapshot") await w.backend.persistAll();
      store.simulateCrash();

      const fresh = await makeWorker(store);
      for (const [name, content] of files) assertFile(fresh.h, name, content);
      await fresh.backend.close();
    });
  }

  it("rejects an unknown metadata format without changing the store", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "kept", "valuable content");
    await w.backend.close();
    const file = await store.root.getFileHandle(".uwasi.meta.log");
    const handle = await file.createSyncAccessHandle();
    handle.write(new TextEncoder().encode("FUTR"), { at: 0 });
    handle.flush();
    handle.close();
    const contents = () =>
      store
        .rootNames()
        .sort()
        .map((name) => [name, Array.from(store.durableContent(name))]);
    const before = contents();
    await assert.rejects(
      ExclusiveOPFSBackend.create(store.root),
      /does not understand/,
    );
    assert.deepStrictEqual(contents(), before);
  });

  it("reports a store another context holds as busy, unchanged", async () => {
    const store = new MockOPFS();
    const contents = () =>
      store
        .rootNames()
        .sort()
        .map((name) => [name, Array.from(store.durableContent(name))]);
    const first = await makeWorker(store);
    putFile(first.h, "kept", "first owner");
    await first.backend.settle();
    // A meta file a live backend holds, then a data file WebKit refuses.
    for (const name of ["NoModificationAllowedError", "InvalidStateError"]) {
      const before = contents();
      await assert.rejects(
        ExclusiveOPFSBackend.create(store.root),
        (error) =>
          error instanceof OPFSStoreBusyError && error.cause.name === name,
      );
      assert.deepStrictEqual(contents(), before);
      await first.backend.close();
      store.injectFault({
        op: "createSyncAccessHandle",
        match: ".uwasi.data.",
        error: "InvalidStateError",
      });
    }
    store.clearFaults();
    const reopened = await makeWorker(store);
    assertFile(reopened.h, "kept", "first owner");
    await reopened.backend.close();
  });
});

describe("OPFS recovery", () => {
  it("a failed log reset loses no subsequent successful changes", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store);
    putFile(w.h, "before", "BEFORE");
    const fault = store.injectFault({
      op: "write",
      match: ".uwasi.meta.log",
    });
    await w.backend.persistAll();
    assert.strictEqual(fault.fired, 1);
    putFile(w.h, "after", "AFTER");
    putFile(w.h, "later", "LATER");
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "before", "BEFORE");
    assertFile(fresh.h, "after", "AFTER");
    assertFile(fresh.h, "later", "LATER");
    await fresh.backend.close();
  });

  it("a torn final log record preserves earlier changes and logging resumes", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store);
    putFile(w.h, "kept", "KEPT");
    putFile(w.h, "torn", "TORN");
    store.simulateCrash();
    const file = await store.root.getFileHandle(".uwasi.meta.log");
    const handle = await file.createSyncAccessHandle();
    handle.truncate(handle.getSize() - 1);
    handle.flush();
    handle.close();

    const reopened = await makeWorker(store);
    assertFile(reopened.h, "kept", "KEPT");
    assert.strictEqual(sysStat(reopened.h, "torn").errno, NOENT);
    putFile(reopened.h, "later", "LATER");
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "kept", "KEPT");
    assertFile(fresh.h, "later", "LATER");
    assert.strictEqual(sysStat(fresh.h, "torn").errno, NOENT);
    await fresh.backend.close();
  });

  it("a failed unlink leaves the file and its data file as they were", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store, { spareFiles: 1 });
    putFile(w.h, "victim", "OLD");
    const dataFile = store
      .rootNames()
      .find(
        (name) =>
          name.startsWith(".uwasi.data.") &&
          new TextDecoder().decode(store.durableContent(name)) === "OLD",
      );
    assert.ok(dataFile);
    const fault = store.injectFault({
      op: "write",
      match: ".uwasi.meta.log",
      short: 4,
    });
    assert.strictEqual(sysUnlink(w.h, "victim"), NOSPC);
    assert.strictEqual(fault.fired, 1);
    assertFile(w.h, "victim", "OLD");
    // The only spare goes to the newcomer, never to the victim's data file.
    await w.backend.settle();
    putFile(w.h, "newcomer", "NEW");
    assert.strictEqual(
      new TextDecoder().decode(store.durableContent(dataFile)),
      "OLD",
    );
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "newcomer", "NEW");
    assertFile(fresh.h, "victim", "OLD");
    await fresh.backend.close();
  });

  it("reopens a store filled to the handle limit", async () => {
    const store = new MockOPFS({ maxHandles: 24 });
    const w = await makeWorker(store, { spareFiles: 4 });
    const synced = [];
    for (let i = 0; i < 30; i++) {
      const { errno, fd } = sysCreate(w.h, `f${i}`);
      assert.strictEqual(errno, ESUCCESS);
      assert.strictEqual(sysWrite(w.h, fd, `file ${i}`).errno, ESUCCESS);
      if (sysSync(w.h, fd) === ESUCCESS) synced.push(i);
      assert.strictEqual(sysClose(w.h, fd), ESUCCESS);
      await w.backend.settle().catch(() => {});
    }
    await w.backend.close().catch(() => {});
    assert.strictEqual(synced.length, 21);

    const fresh = await makeWorker(store, { spareFiles: 4 });
    for (const i of synced) assertFile(fresh.h, `f${i}`, `file ${i}`);
    await fresh.backend.close();
    store.maxHandles = 10;
    await assert.rejects(
      ExclusiveOPFSBackend.create(store.root),
      (error) =>
        /holds 21 files/.test(error.message) &&
        error.cause.name === "UnknownError",
    );
  });
});

describe("MockOPFS durability", () => {
  it("reopen sees cached writes but a crash restores only flushed bytes", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const file = await store.root.getFileHandle("file", { create: true });
    const handle = await file.createSyncAccessHandle();
    handle.write(new Uint8Array([1]), { at: 0 });
    handle.flush();
    handle.write(new Uint8Array([7, 8]), { at: 0 });
    handle.close();
    const reopened = await file.createSyncAccessHandle();
    const cached = new Uint8Array(reopened.getSize());
    reopened.read(cached, { at: 0 });
    assert.deepStrictEqual(Array.from(cached), [7, 8]);
    assert.deepStrictEqual(Array.from(store.durableContent("file")), [1]);
    reopened.close();
    store.simulateCrash();

    const freshFile = await store.root.getFileHandle("file");
    const fresh = await freshFile.createSyncAccessHandle();
    const durable = new Uint8Array(fresh.getSize());
    fresh.read(durable, { at: 0 });
    assert.deepStrictEqual(Array.from(durable), [1]);
    fresh.close();
  });
});
