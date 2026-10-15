import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { WASI, useFS } from "uwasi";
import * as filesystem from "uwasi/filesystem";
import { WASIAbi } from "../lib/esm/abi.js";
import { FSError } from "../lib/esm/filesystem/error.js";
import { MemoryFileSystem } from "../lib/esm/filesystem/namespace.js";
import { MemoryFSBackend } from "../lib/esm/memory/backend.js";
import {
  bindImports,
  sysCreate,
  sysOpen,
  sysWrite,
  sysReadText,
  sysSeekStart,
  sysClose,
  sysLink,
  sysLstat,
  sysUnlink,
  sysRename,
} from "./syscall_harness.mjs";

const ESUCCESS = 0;
// fd rights: FD_READ, FD_SEEK, FD_TELL and FD_FILESTAT_GET; or FD_WRITE.
const READ_RIGHTS = (1n << 1n) | (1n << 2n) | (1n << 5n) | (1n << 21n);
const WRITE_RIGHTS = 1n << 6n;
const { WASI_ERRNO_IO: IO, WASI_ERRNO_NOSPC: NOSPC } = WASIAbi;

/** A memory backend that records the calls the syscall layer makes. */
class RecordingBackend extends MemoryFSBackend {
  calls = [];
  constructor() {
    super();
    for (const method of ["openFile", "closeFile", "resize", "linkChild"]) {
      const inner = this[method].bind(this);
      this[method] = (...args) => {
        this.calls.push(method);
        return inner(...args);
      };
    }
  }
}

function setup(backend = new RecordingBackend()) {
  const fs = new MemoryFileSystem({ "/": "/" });
  return { backend, fs, h: bindImports(backend, fs) };
}

describe("FSBackend seam", () => {
  it("returns the errno of an FSError and lets other errors through", () => {
    const { backend, h } = setup();
    const { fd } = sysCreate(h, "file");
    backend.readAt = () => {
      throw new FSError(IO);
    };
    assert.equal(sysReadText(h, fd).errno, IO);

    const bug = new TypeError("backend bug");
    backend.readAt = () => {
      throw bug;
    };
    assert.throws(
      () => sysReadText(h, fd),
      (error) => error === bug,
    );
  });

  /** Make the backend's `writeAt` calls go through `write(call, ...args)`. */
  function wrapWrites(backend, write) {
    const writeAt = backend.writeAt.bind(backend);
    let call = 0;
    backend.writeAt = (...args) => write(++call, writeAt, ...args);
  }
  const tell = (h, fd) => {
    assert.equal(h.imports.fd_tell(fd, 8192), ESUCCESS);
    return h.view.getBigUint64(8192, true);
  };

  it("reports a short write when a later iovec fails", () => {
    const { backend, h } = setup();
    const { fd } = sysCreate(h, "file");
    wrapWrites(backend, (call, writeAt, ...args) => {
      if (call === 2) throw new FSError(NOSPC);
      return writeAt(...args);
    });
    assert.deepEqual(sysWrite(h, fd, "first", "second"), {
      errno: ESUCCESS,
      written: 5,
    });
    assert.equal(tell(h, fd), 5n);
    assert.equal(sysSeekStart(h, fd), ESUCCESS);
    assert.equal(sysReadText(h, fd).text, "first");
  });

  it("stops at a short writeAt and reports what it wrote", () => {
    const { backend, h } = setup();
    const { fd } = sysCreate(h, "file");
    wrapWrites(backend, (call, writeAt, node, data, offset) =>
      writeAt(node, data.subarray(0, 2), offset),
    );
    assert.deepEqual(sysWrite(h, fd, "first", "second"), {
      errno: ESUCCESS,
      written: 2,
    });
    assert.equal(tell(h, fd), 2n);
  });

  it("returns the errno when nothing was written", () => {
    const { backend, h } = setup();
    const { fd } = sysCreate(h, "file");
    wrapWrites(backend, () => {
      throw new FSError(NOSPC);
    });
    assert.deepEqual(sysWrite(h, fd, "first", "second"), {
      errno: NOSPC,
      written: 0,
    });
    assert.equal(tell(h, fd), 0n);
  });

  it("tells openFile whether the fd can read and write", () => {
    const { backend, h } = setup();
    const modes = [];
    const openFile = backend.openFile.bind(backend);
    backend.openFile = (node, mode) => {
      modes.push(mode);
      return openFile(node, mode);
    };
    const TRUNC = WASIAbi.WASI_OFLAGS_TRUNC;
    assert.equal(sysClose(h, sysCreate(h, "file").fd), ESUCCESS);
    for (const [oflags, rights] of [
      [0, READ_RIGHTS],
      [0, WRITE_RIGHTS],
      [TRUNC, READ_RIGHTS],
    ]) {
      assert.equal(sysClose(h, sysOpen(h, "file", oflags, rights).fd), 0);
    }
    assert.deepEqual(modes, [
      { read: true, write: true },
      { read: true, write: false },
      { read: false, write: true },
      { read: true, write: true },
    ]);
  });

  it("resizes only through an fd with the right to", () => {
    const { backend, h } = setup();
    assert.equal(sysClose(h, sysCreate(h, "file").fd), ESUCCESS);
    const { fd } = sysOpen(h, "file", 0, READ_RIGHTS);
    backend.calls.length = 0;
    const NOTCAPABLE = WASIAbi.WASI_ERRNO_NOTCAPABLE;
    assert.equal(h.imports.fd_filestat_set_size(fd, 4n), NOTCAPABLE);
    assert.equal(h.imports.fd_allocate(fd, 0n, 4n), NOTCAPABLE);
    assert.deepEqual(backend.calls, []);
  });

  it("calls openFile and closeFile once for each fd", () => {
    const { backend, h } = setup();
    const first = sysCreate(h, "file");
    const second = sysOpen(h, "file");
    assert.equal(sysClose(h, first.fd), ESUCCESS);
    assert.equal(sysClose(h, second.fd), ESUCCESS);
    assert.deepEqual(backend.calls, [
      "openFile",
      "openFile",
      "closeFile",
      "closeFile",
    ]);
  });

  it("releases the fd even when closeFile fails", () => {
    const { backend, h } = setup();
    const { fd } = sysCreate(h, "file");
    backend.closeFile = () => {
      throw new FSError(IO);
    };
    assert.equal(sysClose(h, fd), IO);
    assert.equal(sysClose(h, fd), WASIAbi.WASI_ERRNO_BADF);
  });

  it("opens a file before it truncates it, and closes it if that fails", () => {
    const { backend, h } = setup();
    assert.equal(sysClose(h, sysCreate(h, "file").fd), ESUCCESS);
    assert.deepEqual(sysWrite(h, sysOpen(h, "file").fd, "data").errno, 0);
    backend.calls.length = 0;

    const trunc = sysOpen(h, "file", WASIAbi.WASI_OFLAGS_TRUNC);
    assert.equal(trunc.errno, ESUCCESS);
    assert.deepEqual(backend.calls, ["openFile", "resize"]);
    assert.equal(sysLstat(h, "file").size, 0);

    assert.deepEqual(sysWrite(h, trunc.fd, "data").errno, 0);
    backend.calls.length = 0;
    backend.resize = (...args) => {
      backend.calls.push("resize");
      throw new FSError(IO);
    };
    assert.equal(sysOpen(h, "file", WASIAbi.WASI_OFLAGS_TRUNC).errno, IO);
    assert.deepEqual(backend.calls, ["openFile", "resize", "closeFile"]);
  });

  it("keeps the file contents when openFile fails before a truncate", () => {
    const fs = new MemoryFileSystem({ "/": "/" });
    fs.addFile("/file", "valuable data");
    const backend = new MemoryFSBackend();
    backend.openFile = () => {
      throw new FSError(IO);
    };
    const h = bindImports(backend, fs);
    assert.equal(sysOpen(h, "file", WASIAbi.WASI_OFLAGS_TRUNC).errno, IO);
    assert.equal(
      new TextDecoder().decode(fs.lookup("/file").content),
      "valuable data",
    );
  });

  it("links through linkChild and keeps the link count when it fails", () => {
    const { backend, h } = setup();
    assert.equal(sysClose(h, sysCreate(h, "src").fd), ESUCCESS);
    assert.equal(sysLink(h, "src", "dst"), ESUCCESS);
    assert.deepEqual(backend.calls.slice(-1), ["linkChild"]);
    assert.equal(sysLstat(h, "src").nlink, 2);

    backend.linkChild = () => {
      throw new FSError(WASIAbi.WASI_ERRNO_NOTSUP);
    };
    assert.equal(sysLink(h, "src", "third"), WASIAbi.WASI_ERRNO_NOTSUP);
    assert.equal(sysLstat(h, "src").nlink, 2);
    assert.equal(sysLstat(h, "third").errno, WASIAbi.WASI_ERRNO_NOENT);
  });
});

/**
 * A backend that keeps file bytes in its own map, never in
 * `FileNode.content`, and never changes node metadata or `entries`. Its
 * namespace methods record the change and the names in place when called.
 */
class MapBackend {
  bytes = new Map();
  changes = [];
  #data(node) {
    return this.bytes.get(node) ?? new Uint8Array(0);
  }
  fileSize(node) {
    return this.#data(node).byteLength;
  }
  readAt(node, buf, offset) {
    const data = this.#data(node).subarray(offset, offset + buf.byteLength);
    buf.set(data);
    return data.byteLength;
  }
  writeAt(node, data, offset) {
    const end = offset + data.byteLength;
    if (end > this.fileSize(node)) this.resize(node, end);
    this.#data(node).set(data, offset);
    return data.byteLength;
  }
  resize(node, size) {
    const next = new Uint8Array(size);
    next.set(this.#data(node).subarray(0, size));
    this.bytes.set(node, next);
  }
  sync() {}
  datasync() {}
  openFile() {}
  closeFile() {}
  createChild(parent, name) {
    this.changes.push(["create", name, Object.keys(parent.entries)]);
  }
  linkChild(parent, name) {
    this.changes.push(["link", name, Object.keys(parent.entries)]);
  }
  removeChild(parent, name) {
    this.changes.push(["remove", name, Object.keys(parent.entries)]);
  }
  renameChild(fromParent, fromName, toParent, toName) {
    const names = Object.keys(toParent.entries);
    this.changes.push(["rename", `${fromName}>${toName}`, names]);
  }
}

describe("a backend that keeps bytes outside FileNode.content", () => {
  function mapSetup() {
    const backend = new MapBackend();
    const fs = new MemoryFileSystem({ "/": "/" });
    return { backend, fs, h: bindImports(backend, fs) };
  }

  it("serves file data and sizes through the backend alone", () => {
    const { backend, fs, h } = mapSetup();
    const { fd } = sysCreate(h, "file");
    assert.deepEqual(sysWrite(h, fd, "hello"), { errno: 0, written: 5 });
    const node = fs.lookup("/file");
    assert.equal(node.content.byteLength, 0);
    assert.equal(backend.bytes.get(node).byteLength, 5);
    assert.equal(sysLstat(h, "file").size, 5);
    assert.equal(sysSeekStart(h, fd), ESUCCESS);
    assert.equal(sysReadText(h, fd).text, "hello");
  });

  it("updates mtim itself when a size changes, and only then", () => {
    const { fs, h } = mapSetup();
    const { fd } = sysCreate(h, "file");
    const node = fs.lookup("/file");
    const changes = (call) => {
      node.mtim = 123n;
      assert.equal(call(), ESUCCESS);
      return node.mtim !== 123n;
    };
    assert.equal(
      changes(() => h.imports.fd_filestat_set_size(fd, 5n)),
      true,
    );
    assert.equal(
      changes(() => h.imports.fd_filestat_set_size(fd, 5n)),
      false,
    );
    assert.equal(
      changes(() => h.imports.fd_allocate(fd, 0n, 8n)),
      true,
    );
    assert.equal(
      changes(() => sysOpen(h, "file", WASIAbi.WASI_OFLAGS_TRUNC).errno),
      true,
    );
    assert.equal(sysLstat(h, "file").size, 0);
  });

  it("applies namespace changes itself, after the backend call", () => {
    const { backend, fs, h } = mapSetup();
    for (const name of ["a", "b"]) {
      assert.equal(sysClose(h, sysCreate(h, name).fd), ESUCCESS);
    }
    const a = fs.lookup("/a");
    assert.equal(sysLink(h, "a", "c"), ESUCCESS);
    assert.equal(sysRename(h, "c", "b"), ESUCCESS);
    assert.equal(sysUnlink(h, "a"), ESUCCESS);
    assert.deepEqual(Object.keys(fs.lookup("/").entries), ["dev", "b"]);
    assert.equal(fs.lookup("/b"), a);
    assert.equal(sysLstat(h, "b").nlink, 1);
    // Each call saw the tree as it was before its own change.
    assert.deepEqual(backend.changes, [
      ["create", "a", ["dev"]],
      ["create", "b", ["dev", "a"]],
      ["link", "c", ["dev", "a", "b"]],
      ["rename", "c>b", ["dev", "a", "b", "c"]],
      ["remove", "a", ["dev", "a", "b"]],
    ]);
  });

  it("keeps an unlinked file readable through an open fd", () => {
    const { h } = mapSetup();
    const { fd } = sysCreate(h, "file");
    assert.equal(sysWrite(h, fd, "kept").errno, ESUCCESS);
    assert.equal(sysUnlink(h, "file"), ESUCCESS);
    assert.equal(sysLstat(h, "file").errno, WASIAbi.WASI_ERRNO_NOENT);
    assert.equal(sysSeekStart(h, fd), ESUCCESS);
    assert.equal(sysReadText(h, fd).text, "kept");
  });
});

describe("useFS and uwasi/filesystem", () => {
  it("export one provider and the backend API, from ESM and CommonJS", () => {
    assert.equal(filesystem.useFS, useFS);
    for (const name of ["MemoryFSBackend", "MemoryFileSystem", "FSError"]) {
      assert.equal(typeof filesystem[name], "function", name);
    }
    assert.equal(filesystem.FSErrno.NOSPC, WASIAbi.WASI_ERRNO_NOSPC);

    const require = createRequire(import.meta.url);
    assert.equal(require("uwasi/filesystem").useFS, require("uwasi").useFS);
  });

  it("serves the syscalls from the backend, with the namespace's preopens", () => {
    const fileSystem = new filesystem.MemoryFileSystem({ "/store": "/" });
    const wasi = new WASI({
      preopens: { "/ignored": "/" },
      features: [
        useFS({
          withBackend: new filesystem.MemoryFSBackend(),
          withFileSystem: fileSystem,
        }),
      ],
    });
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.setInstance({ exports: { memory } });
    const h = {
      imports: wasi.wasiImport,
      view: new DataView(memory.buffer),
      bytes: new Uint8Array(memory.buffer),
    };
    assert.equal(h.imports.fd_prestat_get(3, 4096), ESUCCESS);
    const length = h.view.getUint32(4100, true);
    assert.equal(h.imports.fd_prestat_dir_name(3, 512, length), ESUCCESS);
    assert.equal(
      new TextDecoder().decode(h.bytes.subarray(512, 512 + length)),
      "/store",
    );

    const { errno, fd } = sysCreate(h, "file.txt");
    assert.equal(errno, ESUCCESS);
    assert.deepEqual(sysWrite(h, fd, "stored"), { errno: 0, written: 6 });
    assert.equal(sysSeekStart(h, fd), ESUCCESS);
    assert.equal(sysReadText(h, fd).text, "stored");
    assert.equal(sysClose(h, fd), ESUCCESS);
  });
});

describe("MemoryFSBackend", () => {
  const backend = new filesystem.MemoryFSBackend();
  const fs = new filesystem.MemoryFileSystem();
  const read = (file) => {
    const bytes = new Uint8Array(backend.fileSize(file));
    assert.equal(backend.readAt(file, bytes, 0), bytes.length);
    return [...bytes];
  };

  it("writes and resizes with zero fill, and reads short at the end", () => {
    const file = fs.createFile("/bytes", new Uint8Array([1, 2, 3]));
    backend.writeAt(file, new Uint8Array([9]), 1);
    backend.writeAt(file, new Uint8Array([7]), 5);
    assert.deepEqual(read(file), [1, 9, 3, 0, 0, 7]);
    assert.equal(backend.readAt(file, new Uint8Array(4), 4), 2);
    assert.equal(backend.readAt(file, new Uint8Array(4), 10), 0);
    backend.resize(file, 1);
    backend.resize(file, 3);
    assert.deepEqual(read(file), [1, 0, 0]);
  });
});
