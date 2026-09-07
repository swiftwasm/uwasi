import { OPFSBackend, useOPFS } from "../lib/esm/index.js";
import { WASIAbi } from "../lib/esm/abi.js";
import { fsBackendContractSuite } from "./fs_backend_contract.mjs";
import { MockOPFS } from "./opfs_mock.mjs";
import {
  bindImports,
  sysCreate,
  sysOpen,
  sysWrite,
  sysReadText,
  sysClose,
  sysSync,
  sysLink,
  sysStat,
  sysMkdir,
  sysRename,
  sysUnlink,
} from "./syscall_harness.mjs";
import { describe, it } from "node:test";
import assert from "node:assert";

const ESUCCESS = 0;

// ---------------------------------------------------------------------------
// Sanity checks for the mock itself: the journal-lifecycle tests are only as
// strong as these semantics.
// ---------------------------------------------------------------------------
describe("MockOPFS semantics", () => {
  it("flushed writes survive a crash, unflushed writes do not", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    const handle = await file.createSyncAccessHandle();
    handle.write(new Uint8Array([1, 2]), { at: 0 });
    handle.flush();
    handle.write(new Uint8Array([9, 9, 9]), { at: 2 });
    store.simulateCrash();
    assert.deepStrictEqual(
      Array.from(store.durableContent("f")),
      [1, 2],
      "only the flushed prefix must be durable",
    );
  });

  it("close() flushes; the lock is exclusive until released", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    const handle = await file.createSyncAccessHandle();
    await assert.rejects(
      () => file.createSyncAccessHandle(),
      (err) => err.name === "NoModificationAllowedError",
    );
    handle.write(new Uint8Array([7]), { at: 0 });
    handle.close();
    assert.deepStrictEqual(Array.from(store.durableContent("f")), [7]);
    const again = await file.createSyncAccessHandle();
    again.close();
  });

  it("a crash releases locks so a fresh worker can reacquire them", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    await file.createSyncAccessHandle();
    store.simulateCrash();
    // The fresh worker starts from a fresh root handle.
    const fresh = await store.root.getFileHandle("f");
    const handle = await fresh.createSyncAccessHandle();
    handle.close();
  });

  it("handles held by the crashed worker are dead, even for new operations", async () => {
    const store = new MockOPFS();
    const preCrashRoot = store.root;
    const file = await preCrashRoot.getFileHandle("f", { create: true });
    store.simulateCrash();
    // A dead worker cannot act anymore; anything it had scheduled fails.
    await assert.rejects(
      () => preCrashRoot.getFileHandle("g", { create: true }),
      (err) => err.name === "InvalidStateError",
    );
    await assert.rejects(
      () => file.createSyncAccessHandle(),
      (err) => err.name === "InvalidStateError",
    );
  });

  it("injectShortWrite makes exactly one matching write short", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    const handle = await file.createSyncAccessHandle();
    store.injectShortWrite("f", 2);
    assert.strictEqual(
      handle.write(new Uint8Array([1, 2, 3, 4]), { at: 0 }),
      2,
    );
    // The injection is consumed; the next write is whole again.
    assert.strictEqual(handle.write(new Uint8Array([9, 9]), { at: 2 }), 2);
    handle.close();
    assert.deepStrictEqual(Array.from(store.durableContent("f")), [1, 2, 9, 9]);
  });

  it("injectTruncateError makes exactly one matching truncate throw", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    const handle = await file.createSyncAccessHandle();
    handle.write(new Uint8Array([1, 2]), { at: 0 });
    store.injectTruncateError("f");
    assert.throws(
      () => handle.truncate(0),
      (err) => err.name === "QuotaExceededError",
    );
    // The failed truncate must not have touched the content.
    assert.strictEqual(handle.getSize(), 2);
    handle.truncate(0); // consumed: works again
    handle.close();
  });

  it("removeEntry refuses locked files and missing names", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    const handle = await file.createSyncAccessHandle();
    await assert.rejects(
      () => store.root.removeEntry("f"),
      (err) => err.name === "NoModificationAllowedError",
    );
    handle.close();
    await store.root.removeEntry("f");
    await assert.rejects(
      () => store.root.removeEntry("f"),
      (err) => err.name === "NotFoundError",
    );
  });
});

// ---------------------------------------------------------------------------
// The OPFS backend must satisfy the same contract as the memory backend.
// ---------------------------------------------------------------------------
async function opfsFixture() {
  const store = new MockOPFS();
  const backend = await OPFSBackend.create(store.root);
  const fs = backend.fileSystem;
  let serial = 0;
  return {
    backend,
    makeFileNode: (content = new Uint8Array(0)) =>
      fs.createFile(`/scratch/f${serial++}`, content),
    makeDirNode: () => fs.ensureDir(`/scratch/d${serial++}`),
  };
}

fsBackendContractSuite("opfs (mock store)", opfsFixture);

// ---------------------------------------------------------------------------
// OPFS-specific behavior, driven through the shared syscall layer.
// ---------------------------------------------------------------------------
async function makeWorker(store, options = {}) {
  const backend = await OPFSBackend.create(store.root, options);
  return { backend, h: bindImports(backend, backend.fileSystem) };
}

describe("OPFSBackend", () => {
  it("a created and written file survives a clean shutdown and re-init", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    const { errno, fd } = sysCreate(w1.h, "data.db");
    assert.strictEqual(errno, ESUCCESS);
    assert.strictEqual(sysWrite(w1.h, fd, "hello opfs").errno, ESUCCESS);
    assert.strictEqual(sysSync(w1.h, fd), ESUCCESS);
    assert.strictEqual(sysClose(w1.h, fd), ESUCCESS);
    await w1.backend.close();

    const w2 = await makeWorker(store);
    const open2 = sysOpen(w2.h, "data.db");
    assert.strictEqual(
      open2.errno,
      ESUCCESS,
      "file must be visible after re-init",
    );
    assert.strictEqual(sysReadText(w2.h, open2.fd).text, "hello opfs");
    await w2.backend.close();
  });

  it("file creation is metadata-durable at syscall return, even on crash", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    assert.strictEqual(sysCreate(w1.h, "journal").errno, ESUCCESS);
    // No close, no settle: the worker dies right after path_open returned.
    store.simulateCrash();

    const w2 = await makeWorker(store);
    const stat = sysStat(w2.h, "journal");
    assert.strictEqual(
      stat.errno,
      ESUCCESS,
      "creation must already be durable",
    );
    assert.strictEqual(stat.size, 0);
    await w2.backend.close();
  });

  it("directories and renames are metadata-durable across a crash", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    assert.strictEqual(sysMkdir(w1.h, "sub"), ESUCCESS);
    const { fd } = sysCreate(w1.h, "a");
    sysWrite(w1.h, fd, "payload");
    sysSync(w1.h, fd);
    sysClose(w1.h, fd);
    assert.strictEqual(sysRename(w1.h, "a", "sub/b"), ESUCCESS);
    store.simulateCrash();

    const w2 = await makeWorker(store);
    assert.strictEqual(sysStat(w2.h, "a").errno, WASIAbi.WASI_ERRNO_NOENT);
    const open2 = sysOpen(w2.h, "sub/b");
    assert.strictEqual(open2.errno, ESUCCESS);
    assert.strictEqual(sysReadText(w2.h, open2.fd).text, "payload");
    await w2.backend.close();
  });

  it("hard links are refused with NOTSUP", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    const { fd } = sysCreate(w.h, "orig");
    sysClose(w.h, fd);
    assert.strictEqual(
      sysLink(w.h, "orig", "alias"),
      WASIAbi.WASI_ERRNO_NOTSUP,
    );
    assert.strictEqual(sysStat(w.h, "alias").errno, WASIAbi.WASI_ERRNO_NOENT);
    await w.backend.close();
  });

  it("listChildren order is stable across re-init", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    for (const name of ["bravo", "alpha", "charlie"]) {
      sysClose(w1.h, sysCreate(w1.h, name).fd);
    }
    const root1 = w1.backend.fileSystem.lookup("/");
    const order1 = w1.backend.listChildren(root1);
    await w1.backend.close();

    const w2 = await makeWorker(store);
    const root2 = w2.backend.fileSystem.lookup("/");
    assert.deepStrictEqual(w2.backend.listChildren(root2), order1);
    await w2.backend.close();
  });

  it("creates past the spare pool succeed, but fd_sync on them fails until settle()", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    // One synchronous burst, no event-loop turns: only one pre-created
    // spare can back a new file; the second create overdrafts.
    assert.strictEqual(sysCreate(w.h, "f0").errno, ESUCCESS);
    const f1 = sysCreate(w.h, "f1");
    assert.strictEqual(f1.errno, ESUCCESS, "creation itself must not fail");
    assert.strictEqual(sysWrite(w.h, f1.fd, "not yet durable").errno, ESUCCESS);
    assert.strictEqual(
      sysSync(w.h, f1.fd),
      WASIAbi.WASI_ERRNO_NOSPC,
      "sync must not claim durability before the physical file exists",
    );
    await w.backend.settle();
    assert.strictEqual(
      sysSync(w.h, f1.fd),
      ESUCCESS,
      "after the pool caught up, sync must really flush",
    );
    store.simulateCrash();

    const w2 = await makeWorker(store);
    const reopened = sysOpen(w2.h, "f1");
    assert.strictEqual(reopened.errno, ESUCCESS);
    assert.strictEqual(sysReadText(w2.h, reopened.fd).text, "not yet durable");
    await w2.backend.close();
  });

  it("an overdrafted create is namespace-durable; unsynced content dies with a crash", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    assert.strictEqual(sysCreate(w.h, "f0").errno, ESUCCESS);
    const f1 = sysCreate(w.h, "f1");
    assert.strictEqual(f1.errno, ESUCCESS);
    assert.strictEqual(sysWrite(w.h, f1.fd, "vanishes").errno, ESUCCESS);
    // Crash before the materializer ever ran.
    store.simulateCrash();

    const w2 = await makeWorker(store);
    const stat = sysStat(w2.h, "f1");
    assert.strictEqual(stat.errno, ESUCCESS, "the creation itself was durable");
    assert.strictEqual(
      stat.size,
      0,
      "content that was never fd_sync'd may be lost - but only that",
    );
    await w2.backend.close();
  });

  it("unlink recycles the physical file into the spare pool synchronously", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    // create -> unlink -> create in one burst: the delete-journal churn.
    for (let i = 0; i < 5; i++) {
      const { errno, fd } = sysCreate(w.h, "journal");
      assert.strictEqual(errno, ESUCCESS, `create #${i}`);
      assert.strictEqual(sysWrite(w.h, fd, `j${i}`).errno, ESUCCESS);
      assert.strictEqual(sysClose(w.h, fd), ESUCCESS);
      assert.strictEqual(sysUnlink(w.h, "journal"), ESUCCESS, `unlink #${i}`);
    }
    await w.backend.close();
  });

  it("foreign files in the store directory are left alone and stay invisible", async () => {
    const store = new MockOPFS();
    const foreign = await store.root.getFileHandle("foreign.bin", {
      create: true,
    });
    const fh = await foreign.createSyncAccessHandle();
    fh.write(new Uint8Array([42]), { at: 0 });
    fh.close();

    const w = await makeWorker(store);
    assert.strictEqual(
      sysStat(w.h, "foreign.bin").errno,
      WASIAbi.WASI_ERRNO_NOENT,
      "unmanaged files are not part of the guest namespace",
    );
    sysClose(w.h, sysCreate(w.h, "mine").fd);
    await w.backend.close();
    assert.deepStrictEqual(Array.from(store.durableContent("foreign.bin")), [
      42,
    ]);
  });

  it("files seeded through the MemoryFileSystem tree-builder become durable", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    w1.backend.fileSystem.addFile("/seeded.txt", "from the embedder");
    await w1.backend.persistAll();
    await w1.backend.close();

    const w2 = await makeWorker(store);
    const open2 = sysOpen(w2.h, "seeded.txt");
    assert.strictEqual(open2.errno, ESUCCESS);
    assert.strictEqual(sysReadText(w2.h, open2.fd).text, "from the embedder");
    await w2.backend.close();
  });
});

/** Name of the root-level data file whose durable bytes contain `text`. */
function findDataFileContaining(store, text) {
  for (const name of store.rootNames()) {
    const content = store.durableContent(name);
    if (content && new TextDecoder().decode(content).includes(text)) {
      return name;
    }
  }
  return null;
}

/** create + write + sync + close in one go; returns nothing, asserts all. */
function putFile(h, name, text) {
  const { errno, fd } = sysCreate(h, name);
  assert.strictEqual(errno, ESUCCESS, `creating ${name}`);
  assert.strictEqual(sysWrite(h, fd, text).errno, ESUCCESS);
  assert.strictEqual(sysSync(h, fd), ESUCCESS);
  assert.strictEqual(sysClose(h, fd), ESUCCESS);
}

describe("short and failed physical writes", () => {
  it("a short write on the data file surfaces as NOSPC from fd_write", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    const { errno, fd } = sysCreate(w.h, "f");
    assert.strictEqual(errno, ESUCCESS);
    store.injectShortWrite(".uwasi.data.", 1);
    assert.strictEqual(
      sysWrite(w.h, fd, "hello").errno,
      WASIAbi.WASI_ERRNO_NOSPC,
      "a partial write must never report success",
    );
    await w.backend.close();
  });

  it("a short write on the namespace record fails the create and rolls it back", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    store.injectShortWrite(".uwasi.meta.", 4);
    assert.strictEqual(
      sysCreate(w.h, "f").errno,
      WASIAbi.WASI_ERRNO_NOSPC,
      "an unrecorded create must not report success",
    );
    assert.strictEqual(
      sysStat(w.h, "f").errno,
      WASIAbi.WASI_ERRNO_NOENT,
      "the failed create must be rolled back",
    );
    await w.backend.close();
  });

  it("a short write while adopting a seeded file fails the open", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    w.backend.fileSystem.addFile("/seeded", "content");
    store.injectShortWrite(".uwasi.data.", 3);
    assert.strictEqual(
      sysOpen(w.h, "seeded").errno,
      WASIAbi.WASI_ERRNO_NOSPC,
      "truncated adopted content must not open as if intact",
    );
    await w.backend.close();
  });

  it("persistAll rejects on a short write instead of silently dropping content", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    w.backend.fileSystem.addFile("/seeded", "content");
    store.injectShortWrite(".uwasi.data.", 3);
    await assert.rejects(() => w.backend.persistAll(), /short write/);
    await w.backend.close();
  });

  it("a failed namespace flush during unlink keeps the file visible", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "f", "data");
    store.injectShortWrite(".uwasi.meta.", 4);
    assert.strictEqual(sysUnlink(w.h, "f"), WASIAbi.WASI_ERRNO_NOSPC);
    // The unlink did not happen, so the name must still resolve. (Its
    // content may already have died - that is the documented crash
    // window of the unlink protocol, name -> empty file.)
    assert.strictEqual(sysStat(w.h, "f").errno, ESUCCESS);
    await w.backend.close();
  });

  it("a failing content destruction aborts the unlink with an errno, content intact", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "f", "precious");
    const dataFile = findDataFileContaining(store, "precious");
    assert.ok(dataFile, "the synced content must be durable somewhere");
    store.injectTruncateError(dataFile);
    assert.strictEqual(
      sysUnlink(w.h, "f"),
      WASIAbi.WASI_ERRNO_NOSPC,
      "unlink must fail cleanly when step 1 (content death) fails",
    );
    const reopened = sysOpen(w.h, "f");
    assert.strictEqual(reopened.errno, ESUCCESS);
    assert.strictEqual(sysReadText(w.h, reopened.fd).text, "precious");
    await w.backend.close();
  });
});

describe("atomic rename over an existing target", () => {
  it("rename-replace records the new mapping before destroying the replaced content", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "dst", "OLD TARGET");
    putFile(w.h, "src", "NEW CONTENT");
    const dstData = findDataFileContaining(store, "OLD TARGET");
    assert.ok(dstData);

    store.opLog.length = 0;
    assert.strictEqual(sysRename(w.h, "src", "dst"), ESUCCESS);

    // Atomic replace: if the record still maps dst -> old content, that
    // content must be intact; destruction may only follow the flush.
    const log = store.opLog;
    const metaFlushAt = log.findIndex(
      (op) => op.op === "flush" && op.path.includes("meta"),
    );
    const truncateAt = log.findIndex(
      (op) =>
        op.op === "truncate" && op.size === 0 && op.path === `/${dstData}`,
    );
    assert.ok(metaFlushAt !== -1, "the rename must flush the record");
    assert.ok(truncateAt !== -1, "the replaced content must be reclaimed");
    assert.ok(
      metaFlushAt < truncateAt,
      `the new mapping must be durable before the replaced content dies: ` +
        JSON.stringify(log),
    );
    await w.backend.close();
  });

  it("a crash in the rename-replace window leaves the renamed file intact at the destination", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "dst", "OLD TARGET");
    putFile(w.h, "src", "NEW CONTENT");
    const dstData = findDataFileContaining(store, "OLD TARGET");
    assert.ok(dstData);
    // The replaced file's cleanup dies - equivalent to a crash between
    // the record flush and the tombstone. The rename must already be
    // safe: cleanup is not a durability point.
    store.injectTruncateError(dstData);
    assert.strictEqual(sysRename(w.h, "src", "dst"), ESUCCESS);
    store.simulateCrash();

    const w2 = await makeWorker(store);
    const reopened = sysOpen(w2.h, "dst");
    assert.strictEqual(reopened.errno, ESUCCESS);
    assert.strictEqual(
      sysReadText(w2.h, reopened.fd).text,
      "NEW CONTENT",
      "the destination must hold the renamed file, never a truncated husk",
    );
    assert.strictEqual(sysStat(w2.h, "src").errno, WASIAbi.WASI_ERRNO_NOENT);
    // The replaced content became unreferenced and re-init reclaimed it.
    assert.strictEqual(findDataFileContaining(store, "OLD TARGET"), null);
    await w2.backend.close();
  });
});

describe("useOPFS", () => {
  it("mirrors useMemoryFS's provider shape over a constructed backend", async () => {
    const store = new MockOPFS();
    const backend = await OPFSBackend.create(store.root);
    const provider = useOPFS({ withBackend: backend });
    const memory = new ArrayBuffer(65536);
    const view = new DataView(memory);
    const imports = provider({}, new WASIAbi(), () => view);
    for (const name of [
      "path_open",
      "fd_write",
      "fd_read",
      "fd_sync",
      "fd_datasync",
      "path_unlink_file",
      "fd_prestat_get",
    ]) {
      assert.strictEqual(
        typeof imports[name],
        "function",
        `useOPFS must provide ${name}`,
      );
    }
    await backend.close();
  });
});
