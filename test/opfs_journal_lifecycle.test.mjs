// Regression suite for the sidecar (rollback-journal) lifecycle over OPFS -
// the scenario the bjorn3/browser_wasi_shim OPFS mapping got wrong: a stale
// rollback journal surviving into a fresh worker rolled back a committed
// write. wasi-testsuite has NO fd_sync case, so the sync-ordering and
// fresh-worker semantics are pinned down here.
//
// SQLite in delete-journal mode commits like this:
//   write db pages -> fd_sync(db) -> path_unlink_file(journal)
// The unlink IS the commit point. The backend must therefore guarantee, in
// order:
//   1. fd_sync really flushes to durable storage before returning;
//   2. unlink destroys the journal's *content* durably before the unlink
//      itself becomes durable (so no crash window shows a stale journal);
//   3. a fresh worker (re-init from the same store) never resurrects an
//      unlinked journal - and conversely still sees a journal that was NOT
//      unlinked (hot journal), byte-for-byte.
import { OPFSBackend } from "../lib/esm/index.js";
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
  sysUnlink,
  sysStat,
} from "./syscall_harness.mjs";
import { describe, it } from "node:test";
import assert from "node:assert";

const ESUCCESS = 0;
const NOENT = WASIAbi.WASI_ERRNO_NOENT;

async function makeWorker(store) {
  const backend = await OPFSBackend.create(store.root);
  return { backend, h: bindImports(backend, backend.fileSystem) };
}

/** write db pages, sync, journal the old content, sync, then commit. */
function commitLikeSQLite(h, { dbText, journalText }) {
  const journal = sysCreate(h, "main.db-journal");
  assert.strictEqual(journal.errno, ESUCCESS);
  assert.strictEqual(sysWrite(h, journal.fd, journalText).errno, ESUCCESS);
  assert.strictEqual(sysSync(h, journal.fd), ESUCCESS);

  const db = sysCreate(h, "main.db");
  assert.strictEqual(db.errno, ESUCCESS);
  assert.strictEqual(sysWrite(h, db.fd, dbText).errno, ESUCCESS);
  assert.strictEqual(sysSync(h, db.fd), ESUCCESS);

  assert.strictEqual(sysClose(h, journal.fd), ESUCCESS);
  // The commit point: delete the rollback journal.
  assert.strictEqual(sysUnlink(h, "main.db-journal"), ESUCCESS);
  assert.strictEqual(sysClose(h, db.fd), ESUCCESS);
}

describe("OPFS journal lifecycle", () => {
  it("create -> write -> sync -> unlink -> crash -> re-init: NOENT, no stale content", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    commitLikeSQLite(w1.h, {
      dbText: "committed database image",
      journalText: "OLD PAGE CONTENT",
    });
    // Fresh-worker semantics: the first worker dies with pending background
    // work unfinished; nothing may depend on it.
    store.simulateCrash();

    const w2 = await makeWorker(store);
    assert.strictEqual(
      sysStat(w2.h, "main.db-journal").errno,
      NOENT,
      "the unlinked journal must NOT be resurrected in a fresh worker",
    );
    assert.strictEqual(sysOpen(w2.h, "main.db-journal").errno, NOENT);
    const db = sysOpen(w2.h, "main.db");
    assert.strictEqual(db.errno, ESUCCESS);
    assert.strictEqual(
      sysReadText(w2.h, db.fd).text,
      "committed database image",
      "the committed write must survive the fresh worker",
    );

    // Belt and braces: no physical file in the store still carries the
    // journal's bytes, so not even a corrupted namespace could roll back.
    const journalBytes = "OLD PAGE CONTENT";
    for (const name of store.rootNames()) {
      const content = store.durableContent(name);
      if (content === null) continue;
      assert.ok(
        !new TextDecoder().decode(content).includes(journalBytes),
        `stale journal content must be destroyed, found in ${name}`,
      );
    }
    await w2.backend.close();
  });

  it("re-init must not resurrect the journal even after a clean shutdown", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    commitLikeSQLite(w1.h, { dbText: "db", journalText: "journal" });
    await w1.backend.close();

    const w2 = await makeWorker(store);
    assert.strictEqual(sysStat(w2.h, "main.db-journal").errno, NOENT);
    await w2.backend.close();

    // And a third init, after all deferred cleanup had every chance to run.
    const w3 = await makeWorker(store);
    assert.strictEqual(sysStat(w3.h, "main.db-journal").errno, NOENT);
    await w3.backend.close();
  });

  it("hot journal: crash before unlink leaves the journal visible and intact", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    const journal = sysCreate(w1.h, "main.db-journal");
    assert.strictEqual(journal.errno, ESUCCESS);
    assert.strictEqual(
      sysWrite(w1.h, journal.fd, "hot journal payload").errno,
      ESUCCESS,
    );
    assert.strictEqual(sysSync(w1.h, journal.fd), ESUCCESS);
    // Crash mid-transaction: no unlink. The journal IS the rollback state.
    store.simulateCrash();

    const w2 = await makeWorker(store);
    const reopened = sysOpen(w2.h, "main.db-journal");
    assert.strictEqual(
      reopened.errno,
      ESUCCESS,
      "a hot journal must survive into the fresh worker",
    );
    assert.strictEqual(
      sysReadText(w2.h, reopened.fd).text,
      "hot journal payload",
      "hot journal content must be byte-for-byte intact",
    );
    await w2.backend.close();
  });

  it("fd_datasync is as durable as fd_sync for journal content", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    const journal = sysCreate(w1.h, "main.db-journal");
    sysWrite(w1.h, journal.fd, "datasynced");
    assert.strictEqual(w1.h.imports.fd_datasync(journal.fd), ESUCCESS);
    store.simulateCrash();

    const w2 = await makeWorker(store);
    const reopened = sysOpen(w2.h, "main.db-journal");
    assert.strictEqual(sysReadText(w2.h, reopened.fd).text, "datasynced");
    await w2.backend.close();
  });

  it("unflushed journal writes are lost on crash (sync is not a no-op)", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    const journal = sysCreate(w1.h, "main.db-journal");
    assert.strictEqual(journal.errno, ESUCCESS);
    assert.strictEqual(sysSync(w1.h, journal.fd), ESUCCESS);
    // Written but never synced: a crash may discard it...
    assert.strictEqual(
      sysWrite(w1.h, journal.fd, "never synced").errno,
      ESUCCESS,
    );
    store.simulateCrash();

    const w2 = await makeWorker(store);
    const stat = sysStat(w2.h, "main.db-journal");
    assert.strictEqual(
      stat.errno,
      ESUCCESS,
      "the file itself was created durably",
    );
    assert.strictEqual(
      stat.size,
      0,
      "unflushed content must not survive: durability comes from fd_sync only",
    );
    await w2.backend.close();
  });

  it("commit ordering: journal content is destroyed durably before the unlink is recorded", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    const journal = sysCreate(w1.h, "main.db-journal");
    sysWrite(w1.h, journal.fd, "OLD PAGE CONTENT");
    sysSync(w1.h, journal.fd);
    sysClose(w1.h, journal.fd);

    store.opLog.length = 0;
    assert.strictEqual(sysUnlink(w1.h, "main.db-journal"), ESUCCESS);

    // Within the unlink syscall, the journal's physical file must be
    // truncated AND flushed before any metadata write records the unlink.
    // Otherwise a crash between the two leaves a stale, fully-intact
    // journal whose unlink was already observable to the guest.
    const log = store.opLog;
    const truncateAt = log.findIndex(
      (op) =>
        op.op === "truncate" && op.size === 0 && !op.path.includes("meta"),
    );
    const contentFlushAt = log.findIndex(
      (op, i) =>
        i > truncateAt && op.op === "flush" && op.path === log[truncateAt].path,
    );
    const metaWriteAt = log.findIndex(
      (op) => op.op === "write" && op.path.includes("meta"),
    );
    assert.ok(
      truncateAt !== -1,
      "unlink must truncate the journal's physical file",
    );
    assert.ok(contentFlushAt !== -1, "the truncate must be flushed");
    assert.ok(metaWriteAt !== -1, "unlink must persist the namespace change");
    assert.ok(
      contentFlushAt < metaWriteAt,
      `content destruction (op ${contentFlushAt}) must precede the durable ` +
        `unlink record (op ${metaWriteAt}): ${JSON.stringify(log)}`,
    );
    await w1.backend.close();
  });

  it("an unlinked-but-open file stays usable via its fd (dangling fd), and is gone after re-init", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    const file = sysCreate(w1.h, "victim");
    assert.strictEqual(
      sysWrite(w1.h, file.fd, "still readable").errno,
      ESUCCESS,
    );
    assert.strictEqual(sysUnlink(w1.h, "victim"), ESUCCESS);
    // POSIX: the open fd keeps the bytes alive...
    assert.strictEqual(w1.h.imports.fd_seek(file.fd, 0n, 0, 4160), ESUCCESS);
    assert.strictEqual(sysReadText(w1.h, file.fd).text, "still readable");
    // ...and writes through it still work.
    assert.strictEqual(sysWrite(w1.h, file.fd, "!").errno, ESUCCESS);
    assert.strictEqual(sysClose(w1.h, file.fd), ESUCCESS);
    store.simulateCrash();

    const w2 = await makeWorker(store);
    assert.strictEqual(sysStat(w2.h, "victim").errno, NOENT);
    await w2.backend.close();
  });
});
