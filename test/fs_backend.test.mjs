import {
  MemoryFileSystem,
  MemoryFSBackend,
  bindFSSyscalls,
} from "../lib/esm/features/fd.js";
import { WASIAbi } from "../lib/esm/abi.js";
import { fsBackendContractSuite } from "./fs_backend_contract.mjs";
import { describe, it } from "node:test";
import assert from "node:assert";

const ESUCCESS = 0;

function memoryFixture() {
  const fs = new MemoryFileSystem({ "/": "/" });
  let serial = 0;
  return {
    backend: new MemoryFSBackend(),
    makeFileNode: (content = new Uint8Array(0)) =>
      fs.createFile(`/scratch/f${serial++}`, content),
    makeDirNode: () => fs.ensureDir(`/scratch/d${serial++}`),
  };
}

fsBackendContractSuite("memory", memoryFixture);

const PATH_PTR = 0;
const IOVEC_PTR = 256;
const DATA_PTR = 512;
const OUT_PTR = 1024;

const PREOPEN_FD = 3;
const OFLAGS_CREAT = 1 << 0;
const ALL_RIGHTS = BigInt((1 << 30) - 1);

/** Records which backend methods the syscall layer actually reaches. */
class SpyBackend extends MemoryFSBackend {
  calls = [];
  openFile(node) {
    this.calls.push("openFile");
    return super.openFile(node);
  }
  closeFile(node) {
    this.calls.push("closeFile");
    super.closeFile(node);
  }
  sync(node) {
    this.calls.push("sync");
    return super.sync(node);
  }
  datasync(node) {
    this.calls.push("datasync");
    return super.datasync(node);
  }
  readAt(node, buf, offset) {
    this.calls.push("readAt");
    return super.readAt(node, buf, offset);
  }
  writeAt(node, data, offset) {
    this.calls.push("writeAt");
    return super.writeAt(node, data, offset);
  }
  removeChild(parent, name) {
    this.calls.push("removeChild");
    return super.removeChild(parent, name);
  }
}

/** Drive `bindFSSyscalls`'s imports directly, as `fd.test.mjs` drives `useMemoryFS`. */
function makeSeam(backend) {
  const fileSystem = new MemoryFileSystem({ "/": "/" });
  const memory = new ArrayBuffer(65536);
  const view = new DataView(memory);
  const bytes = new Uint8Array(memory);
  const imports = bindFSSyscalls(
    backend,
    fileSystem,
    {},
    new WASIAbi(),
    () => view,
  );
  return { imports, view, bytes };
}

function openFile({ imports, view, bytes }, name) {
  const path = new TextEncoder().encode(name);
  bytes.set(path, PATH_PTR);
  const ret = imports.path_open(
    PREOPEN_FD,
    0,
    PATH_PTR,
    path.length,
    OFLAGS_CREAT,
    ALL_RIGHTS,
    ALL_RIGHTS,
    0,
    OUT_PTR,
  );
  assert.strictEqual(ret, ESUCCESS, `path_open(${name}) errno ${ret}`);
  return view.getUint32(OUT_PTR, true);
}

describe("fd.bindFSSyscalls backend seam", () => {
  it("path_open and fd_close reach openFile and closeFile", () => {
    const backend = new SpyBackend();
    const h = makeSeam(backend);
    const fd = openFile(h, "file.txt");
    assert.ok(backend.calls.includes("openFile"));
    assert.strictEqual(h.imports.fd_close(fd), ESUCCESS);
    assert.ok(backend.calls.includes("closeFile"));
  });

  it("fd_sync and fd_datasync on a file fd reach the backend", () => {
    const backend = new SpyBackend();
    const h = makeSeam(backend);
    const fd = openFile(h, "file.txt");
    assert.strictEqual(h.imports.fd_sync(fd), ESUCCESS);
    assert.strictEqual(h.imports.fd_datasync(fd), ESUCCESS);
    assert.ok(backend.calls.includes("sync"));
    assert.ok(backend.calls.includes("datasync"));
  });

  it("fd_sync on a directory fd reaches the backend", () => {
    const backend = new SpyBackend();
    const h = makeSeam(backend);
    assert.strictEqual(h.imports.fd_sync(PREOPEN_FD), ESUCCESS);
    assert.deepStrictEqual(backend.calls, ["sync"]);
  });

  it("fd_sync on a stdio fd succeeds without touching the backend", () => {
    const backend = new SpyBackend();
    const h = makeSeam(backend);
    assert.strictEqual(h.imports.fd_sync(1), ESUCCESS);
    assert.deepStrictEqual(backend.calls, []);
  });

  it("fd_write and fd_read move bytes through the backend", () => {
    const backend = new SpyBackend();
    const h = makeSeam(backend);
    const fd = openFile(h, "file.txt");

    h.bytes.set(new TextEncoder().encode("hi"), DATA_PTR);
    h.view.setUint32(IOVEC_PTR, DATA_PTR, true);
    h.view.setUint32(IOVEC_PTR + 4, 2, true);
    assert.strictEqual(
      h.imports.fd_write(fd, IOVEC_PTR, 1, OUT_PTR + 8),
      ESUCCESS,
    );
    assert.ok(backend.calls.includes("writeAt"));

    h.view.setBigUint64(OUT_PTR + 16, 0n, true);
    assert.strictEqual(h.imports.fd_seek(fd, 0n, 0, OUT_PTR + 16), ESUCCESS);
    assert.strictEqual(
      h.imports.fd_read(fd, IOVEC_PTR, 1, OUT_PTR + 8),
      ESUCCESS,
    );
    assert.ok(backend.calls.includes("readAt"));
    assert.strictEqual(h.view.getUint32(OUT_PTR + 8, true), 2);
    assert.strictEqual(
      new TextDecoder().decode(h.bytes.subarray(DATA_PTR, DATA_PTR + 2)),
      "hi",
    );
  });

  it("path_unlink_file reaches removeChild", () => {
    const backend = new SpyBackend();
    const h = makeSeam(backend);
    const fd = openFile(h, "gone.txt");
    assert.strictEqual(h.imports.fd_close(fd), ESUCCESS);
    const path = new TextEncoder().encode("gone.txt");
    h.bytes.set(path, PATH_PTR);
    assert.strictEqual(
      h.imports.path_unlink_file(PREOPEN_FD, PATH_PTR, path.length),
      ESUCCESS,
    );
    assert.ok(backend.calls.includes("removeChild"));
  });
});
