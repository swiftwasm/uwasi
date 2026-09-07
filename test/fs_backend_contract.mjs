import { WASIAbi } from "../lib/esm/abi.js";
import { describe, it } from "node:test";
import assert from "node:assert";

const ESUCCESS = 0;

/**
 * Contract every `FSBackend` implementation must satisfy. The syscall layer in
 * `fd.ts` owns path resolution, rights, errno mapping and fd bookkeeping; a
 * backend owns file bytes and namespace persistence. Each backend runs this
 * same suite with its own fixture.
 *
 * `createFixture` returns (or resolves to, for backends that need async
 * setup):
 * - `backend`: the implementation under test
 * - `makeFileNode(content?)`: a fresh `FileNode` registered with the backend
 * - `makeDirNode()`: a fresh `DirectoryNode` registered with the backend
 */
export function fsBackendContractSuite(name, createFixture) {
  describe(`FSBackend contract: ${name}`, () => {
    it("fileSize reports the byte length", async () => {
      const { backend, makeFileNode } = await createFixture();
      const node = makeFileNode(new Uint8Array([1, 2, 3]));
      assert.strictEqual(backend.fileSize(node), 3);
    });

    it("readAt reads at an offset", async () => {
      const { backend, makeFileNode } = await createFixture();
      const node = makeFileNode(new TextEncoder().encode("hello world"));
      const buf = new Uint8Array(5);
      assert.strictEqual(backend.readAt(node, buf, 6), 5);
      assert.strictEqual(new TextDecoder().decode(buf), "world");
    });

    it("readAt returns a short count at end of file", async () => {
      const { backend, makeFileNode } = await createFixture();
      const node = makeFileNode(new TextEncoder().encode("hello world"));
      const buf = new Uint8Array(10);
      assert.strictEqual(backend.readAt(node, buf, 6), 5);
    });

    it("readAt returns 0 past end of file and for empty buffers", async () => {
      const { backend, makeFileNode } = await createFixture();
      const node = makeFileNode(new Uint8Array([1, 2]));
      assert.strictEqual(backend.readAt(node, new Uint8Array(4), 2), 0);
      assert.strictEqual(backend.readAt(node, new Uint8Array(4), 100), 0);
      assert.strictEqual(backend.readAt(node, new Uint8Array(0), 0), 0);
    });

    it("writeAt overwrites in place without resizing", async () => {
      const { backend, makeFileNode } = await createFixture();
      const node = makeFileNode(new Uint8Array([1, 1, 1, 1]));
      assert.strictEqual(
        backend.writeAt(node, new Uint8Array([9, 9]), 1),
        ESUCCESS,
      );
      assert.strictEqual(backend.fileSize(node), 4);
      const buf = new Uint8Array(4);
      backend.readAt(node, buf, 0);
      assert.deepStrictEqual(Array.from(buf), [1, 9, 9, 1]);
    });

    it("writeAt past the end extends the file and zero-fills the gap", async () => {
      const { backend, makeFileNode } = await createFixture();
      const node = makeFileNode(new Uint8Array(0));
      assert.strictEqual(
        backend.writeAt(node, new Uint8Array([7, 7]), 4),
        ESUCCESS,
      );
      assert.strictEqual(backend.fileSize(node), 6);
      const buf = new Uint8Array(6);
      backend.readAt(node, buf, 0);
      assert.deepStrictEqual(Array.from(buf), [0, 0, 0, 0, 7, 7]);
    });

    it("resize grows with zero fill and shrinks keeping the prefix", async () => {
      const { backend, makeFileNode } = await createFixture();
      const node = makeFileNode(new Uint8Array([7, 7]));
      assert.strictEqual(backend.resize(node, 4), ESUCCESS);
      assert.strictEqual(backend.fileSize(node), 4);
      let buf = new Uint8Array(4);
      backend.readAt(node, buf, 0);
      assert.deepStrictEqual(Array.from(buf), [7, 7, 0, 0]);

      assert.strictEqual(backend.resize(node, 1), ESUCCESS);
      assert.strictEqual(backend.fileSize(node), 1);
      buf = new Uint8Array(1);
      backend.readAt(node, buf, 0);
      assert.deepStrictEqual(Array.from(buf), [7]);
    });

    it("resize zero-fills bytes re-exposed by a shrink then a grow", async () => {
      const { backend, makeFileNode } = await createFixture();
      const node = makeFileNode(new Uint8Array(8).fill(200));
      assert.strictEqual(backend.resize(node, 4), ESUCCESS);
      assert.strictEqual(backend.resize(node, 8), ESUCCESS);
      const buf = new Uint8Array(8);
      backend.readAt(node, buf, 0);
      assert.deepStrictEqual(Array.from(buf), [200, 200, 200, 200, 0, 0, 0, 0]);
    });

    it("resize rejects sizes that are not whole non-negative counts", async () => {
      const { backend, makeFileNode } = await createFixture();
      const node = makeFileNode(new Uint8Array([1]));
      assert.strictEqual(backend.resize(node, -1), WASIAbi.WASI_ERRNO_INVAL);
      assert.strictEqual(backend.resize(node, 1.5), WASIAbi.WASI_ERRNO_INVAL);
      assert.strictEqual(backend.resize(node, NaN), WASIAbi.WASI_ERRNO_INVAL);
      assert.strictEqual(backend.fileSize(node), 1);
    });

    it("sync and datasync succeed on files and directories", async () => {
      const { backend, makeFileNode, makeDirNode } = await createFixture();
      const file = makeFileNode(new Uint8Array([1]));
      const dir = makeDirNode();
      assert.strictEqual(backend.sync(file), ESUCCESS);
      assert.strictEqual(backend.datasync(file), ESUCCESS);
      assert.strictEqual(backend.sync(dir), ESUCCESS);
      assert.strictEqual(backend.datasync(dir), ESUCCESS);
    });

    it("openFile succeeds and closeFile releases without error", async () => {
      const { backend, makeFileNode } = await createFixture();
      const node = makeFileNode(new Uint8Array([1]));
      assert.strictEqual(backend.openFile(node), ESUCCESS);
      backend.closeFile(node);
    });

    it("createChild links the node into the parent's live entries", async () => {
      const { backend, makeFileNode, makeDirNode } = await createFixture();
      const parent = makeDirNode();
      const child = makeFileNode(new Uint8Array([1]));
      assert.strictEqual(backend.createChild(parent, "a", child), ESUCCESS);
      // The syscall layer resolves paths through `entries`, so the backend
      // must keep that in-memory namespace mirror exact.
      assert.strictEqual(parent.entries["a"], child);
      assert.deepStrictEqual(backend.listChildren(parent), ["a"]);
    });

    it("removeChild unlinks the name", async () => {
      const { backend, makeFileNode, makeDirNode } = await createFixture();
      const parent = makeDirNode();
      const child = makeFileNode(new Uint8Array([1]));
      backend.createChild(parent, "a", child);
      assert.strictEqual(backend.removeChild(parent, "a"), ESUCCESS);
      assert.strictEqual(parent.entries["a"], undefined);
      assert.deepStrictEqual(backend.listChildren(parent), []);
    });

    it("renameChild moves the same node between directories", async () => {
      const { backend, makeFileNode, makeDirNode } = await createFixture();
      const from = makeDirNode();
      const to = makeDirNode();
      const child = makeFileNode(new Uint8Array([1]));
      backend.createChild(from, "a", child);
      assert.strictEqual(backend.renameChild(from, "a", to, "b"), ESUCCESS);
      assert.strictEqual(from.entries["a"], undefined);
      assert.strictEqual(to.entries["b"], child);
    });

    it("renameChild replaces an existing target", async () => {
      const { backend, makeFileNode, makeDirNode } = await createFixture();
      const dir = makeDirNode();
      const winner = makeFileNode(new Uint8Array([1]));
      const loser = makeFileNode(new Uint8Array([2]));
      backend.createChild(dir, "a", winner);
      backend.createChild(dir, "b", loser);
      assert.strictEqual(backend.renameChild(dir, "a", dir, "b"), ESUCCESS);
      assert.strictEqual(dir.entries["a"], undefined);
      assert.strictEqual(dir.entries["b"], winner);
      assert.deepStrictEqual(backend.listChildren(dir), ["b"]);
    });

    it("listChildren is stable across calls while unchanged", async () => {
      const { backend, makeFileNode, makeDirNode } = await createFixture();
      const dir = makeDirNode();
      backend.createChild(dir, "a", makeFileNode(new Uint8Array(0)));
      backend.createChild(dir, "b", makeFileNode(new Uint8Array(0)));
      const first = backend.listChildren(dir);
      assert.deepStrictEqual([...first].sort(), ["a", "b"]);
      // fd_readdir cookies index into this listing across separate syscalls.
      assert.deepStrictEqual(backend.listChildren(dir), first);
    });
  });
}
