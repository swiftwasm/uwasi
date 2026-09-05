import {
  MemoryFileSystem,
  ReadableTextProxy,
  useMemoryFS,
  lineBuffered,
} from "../lib/esm/features/fd.js";
import { WASIAbi } from "../lib/esm/abi.js";
import { describe, it } from "node:test";
import assert from "node:assert";

describe("fd.ReadableTextProxy", () => {
  it("readv single buffer", () => {
    const input = "hello";
    const inputs = [input];
    const proxy = new ReadableTextProxy(() => inputs.shift() || "");
    const buffer = new Uint8Array(10);
    const read = proxy.readv([buffer]);
    assert.strictEqual(read, 5);
    const expected = new TextEncoder().encode(input);
    assert.deepStrictEqual(buffer.slice(0, 5), expected);
  });

  it("readv 2 buffer", () => {
    const input = "hello";
    const inputs = [input];
    const proxy = new ReadableTextProxy(() => inputs.shift() || "");
    const buf0 = new Uint8Array(2);
    const buf1 = new Uint8Array(2);
    const read = proxy.readv([buf0, buf1]);
    assert.strictEqual(read, 4);
    const expected = new TextEncoder().encode(input);
    assert.deepStrictEqual(buf0, expected.slice(0, 2));
    assert.deepStrictEqual(buf1, expected.slice(2, 4));
  });
});

const PATH_PTR = 0;
const IOVEC_PTR = 256;
const DATA_PTR = 512;
const OUT_PTR = 1024;

const PREOPEN_FD = 3;
const OFLAGS_CREAT = 1 << 0;
const FDFLAGS_APPEND = 1 << 0;
const ALL_RIGHTS = BigInt((1 << 30) - 1);
const ESUCCESS = 0;

const isResizable = (buffer) => buffer.resizable === true;

/** Drive `useMemoryFS`'s imports directly, as `poll.test.mjs` drives `usePoll`. */
function makeFS(fileSystem = new MemoryFileSystem({ "/": "/" })) {
  const memory = new ArrayBuffer(65536);
  const view = new DataView(memory);
  const bytes = new Uint8Array(memory);
  const imports = useMemoryFS({ withFileSystem: fileSystem })(
    {},
    new WASIAbi(),
    () => view,
  );
  return { fs: fileSystem, imports, view, bytes };
}

/** Keep the node itself, so growth tests see the buffer as the filesystem holds it. */
function trackFile(h, name) {
  return h.fs.createFile(`/${name}`, new Uint8Array(0));
}

function openFile(
  { imports, view, bytes },
  name,
  oflags = OFLAGS_CREAT,
  fdflags = 0,
) {
  const path = new TextEncoder().encode(name);
  bytes.set(path, PATH_PTR);
  const ret = imports.path_open(
    PREOPEN_FD,
    0,
    PATH_PTR,
    path.length,
    oflags,
    ALL_RIGHTS,
    ALL_RIGHTS,
    fdflags,
    OUT_PTR,
  );
  assert.strictEqual(ret, ESUCCESS, `path_open(${name}) errno ${ret}`);
  return view.getUint32(OUT_PTR, true);
}

function write({ imports, view, bytes }, fd, length, fill) {
  bytes.fill(fill, DATA_PTR, DATA_PTR + length);
  view.setUint32(IOVEC_PTR, DATA_PTR, true);
  view.setUint32(IOVEC_PTR + 4, length, true);
  const ret = imports.fd_write(fd, IOVEC_PTR, 1, OUT_PTR + 8);
  assert.strictEqual(ret, ESUCCESS, `fd_write errno ${ret}`);
}

describe("fd.useMemoryFS growth", () => {
  it("keeps content correct across many small appends", () => {
    const h = makeFS();
    const node = trackFile(h, "log");
    const fd = openFile(h, "log");
    for (let i = 0; i < 512; i++) write(h, fd, 64, 65 + (i % 26));

    assert.strictEqual(node.content.byteLength, 512 * 64);
    for (let i = 0; i < 512; i++) {
      const chunk = node.content.subarray(i * 64, (i + 1) * 64);
      assert.ok(
        chunk.every((b) => b === 65 + (i % 26)),
        `chunk ${i} was not written verbatim`,
      );
    }
  });

  it("reallocates a logarithmic number of times, not once per write", () => {
    // Count buffers, not elapsed time: deterministic, and cannot flake.
    const h = makeFS();
    const node = trackFile(h, "log");
    const fd = openFile(h, "log");

    const buffers = new Set();
    for (let i = 0; i < 512; i++) {
      write(h, fd, 64, 88);
      buffers.add(node.content.buffer);
    }

    assert.ok(
      buffers.size <= 24,
      `expected O(log n) reallocations for 512 appends, saw ${buffers.size}`,
    );
  });

  it("reuses the same buffer while reserved capacity remains", () => {
    const h = makeFS();
    const node = trackFile(h, "log");
    const fd = openFile(h, "log");

    // First growth is an exact fit; there is no capacity yet to double.
    write(h, fd, 1024, 65);
    assert.strictEqual(node.content.buffer.maxByteLength, 1024);

    write(h, fd, 16, 66);
    const reserved = node.content.buffer;
    assert.ok(
      reserved.maxByteLength > node.content.byteLength,
      `expected reserved capacity, got ${reserved.maxByteLength} for ${node.content.byteLength} bytes`,
    );

    write(h, fd, 16, 67);
    assert.strictEqual(
      node.content.buffer,
      reserved,
      "buffer should be reused",
    );
    assert.strictEqual(
      node.content.byteLength,
      1056,
      "view should track the resize",
    );
  });

  it("truncation keeps the prefix and releases most of the waste", () => {
    const h = makeFS();
    const node = trackFile(h, "log");
    const fd = openFile(h, "log");
    write(h, fd, 1024, 90);
    write(h, fd, 3072, 90);

    assert.strictEqual(h.imports.fd_filestat_set_size(fd, 10n), ESUCCESS);
    assert.strictEqual(node.content.byteLength, 10);
    assert.ok(
      node.content.every((b) => b === 90),
      "truncation should keep the original bytes",
    );
    // A large truncation must not hold on to the whole old buffer.
    assert.ok(
      node.content.buffer.byteLength <= 64,
      `expected the buffer to shrink, got ${node.content.buffer.byteLength}`,
    );
  });

  it("zero-fills when fd_filestat_set_size grows a file", () => {
    const h = makeFS();
    const node = trackFile(h, "log");
    const fd = openFile(h, "log");
    write(h, fd, 4, 67);

    assert.strictEqual(h.imports.fd_filestat_set_size(fd, 12n), ESUCCESS);
    assert.deepStrictEqual(
      Array.from(node.content),
      [67, 67, 67, 67, 0, 0, 0, 0, 0, 0, 0, 0],
    );
  });

  it("zero-fills bytes re-exposed by a shrink then a grow", () => {
    // Growth reuses spare room in the same buffer, so a region that a previous
    // shrink cut off still holds its old bytes. It must read back as zero.
    const h = makeFS();
    const node = trackFile(h, "log");
    const fd = openFile(h, "log");
    write(h, fd, 64, 200);

    assert.strictEqual(h.imports.fd_filestat_set_size(fd, 32n), ESUCCESS);
    assert.strictEqual(h.imports.fd_filestat_set_size(fd, 64n), ESUCCESS);

    assert.strictEqual(node.content.byteLength, 64);
    assert.ok(
      node.content.subarray(0, 32).every((b) => b === 200),
      "the surviving prefix must be intact",
    );
    assert.ok(
      node.content.subarray(32).every((b) => b === 0),
      "re-exposed bytes must be zero, not the old contents",
    );
  });

  it("zero-fills the gap left by a pwrite past the end", () => {
    const h = makeFS();
    const node = trackFile(h, "log");
    const fd = openFile(h, "log");
    write(h, fd, 2, 68);

    h.bytes.fill(69, DATA_PTR, DATA_PTR + 2);
    h.view.setUint32(IOVEC_PTR, DATA_PTR, true);
    h.view.setUint32(IOVEC_PTR + 4, 2, true);
    assert.strictEqual(
      h.imports.fd_pwrite(fd, IOVEC_PTR, 1, 6n, OUT_PTR + 8),
      ESUCCESS,
    );

    assert.deepStrictEqual(
      Array.from(node.content),
      [68, 68, 0, 0, 0, 0, 69, 69],
    );
  });

  it("grows a file whose view has an explicit length", () => {
    // Explicit-length views are copied in, not adopted.
    const fs = new MemoryFileSystem({ "/": "/" });
    const buffer = new ArrayBuffer(4, { maxByteLength: 8 });
    const view = new Uint8Array(buffer, 0, 4);
    view.set([1, 2, 3, 4]);
    const node = fs.createFile("/explicit", view);

    const h = makeFS(fs);
    const fd = openFile(h, "explicit", 0);
    h.imports.fd_seek(fd, 4n, 0, OUT_PTR + 8);
    write(h, fd, 1, 9);

    assert.deepStrictEqual(Array.from(node.content), [1, 2, 3, 4, 9]);
  });

  it("grows correctly from a file whose view has a byte offset", () => {
    // Offset views cannot use reserved capacity.
    const fs = new MemoryFileSystem({ "/": "/" });
    const backing = new Uint8Array(64).fill(1);
    const node = fs.createFile("/offset", new Uint8Array(backing.buffer, 8, 4));

    const h = makeFS(fs);
    const fd = openFile(h, "offset", 0);
    h.imports.fd_seek(fd, 4n, 0, OUT_PTR + 8);
    write(h, fd, 4, 70);

    assert.deepStrictEqual(
      Array.from(node.content),
      [1, 1, 1, 1, 70, 70, 70, 70],
    );
  });
});

describe("fd.useMemoryFS read-boundary compaction", () => {
  it("lookup returns contents on a plain buffer, without copying", () => {
    const h = makeFS();
    const node = trackFile(h, "log");
    const fd = openFile(h, "log");
    write(h, fd, 1024, 71);
    write(h, fd, 1024, 71);

    const seen = h.fs.lookup("/log");
    assert.strictEqual(isResizable(seen.content.buffer), false);
    assert.strictEqual(seen.content.byteLength, 2048);
    assert.ok(seen.content.every((b) => b === 71));
    assert.strictEqual(seen.content, node.content);
  });

  it("resolve returns contents on a non-resizable buffer", () => {
    const h = makeFS();
    trackFile(h, "log");
    const fd = openFile(h, "log");
    write(h, fd, 1024, 72);
    write(h, fd, 1024, 72);

    const root = h.fs.lookup("/");
    const seen = h.fs.resolve(root, "log");
    assert.strictEqual(isResizable(seen.content.buffer), false);
    assert.ok(seen.content.every((b) => b === 72));
  });

  it("is safe however the descriptor went away", () => {
    const h = makeFS();
    trackFile(h, "victim");
    const victim = openFile(h, "victim");
    const other = openFile(h, "other");
    write(h, victim, 1024, 73);
    write(h, victim, 1024, 73);

    assert.strictEqual(h.imports.fd_renumber(other, victim), ESUCCESS);
    assert.strictEqual(
      isResizable(h.fs.lookup("/victim").content.buffer),
      false,
    );
  });

  it("copies a caller-supplied resizable buffer", () => {
    const fs = new MemoryFileSystem({ "/": "/" });
    const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
    new Uint8Array(buffer).set([0, 1, 2, 3, 4, 5, 6, 7]);
    fs.createFile("/supplied", new Uint8Array(buffer, 1, 3));

    const seen = fs.lookup("/supplied");
    assert.strictEqual(isResizable(seen.content.buffer), false);
    assert.deepStrictEqual(Array.from(seen.content), [1, 2, 3]);
  });

  it("does not let one file grow into another file's buffer", () => {
    // `lookup` hands back the live view, which a caller can pass straight to
    // `createFile`. The two files must not then share spare room: growth or a
    // shrink-then-grow in one would rewrite the other.
    const h = makeFS();
    const fd = openFile(h, "a");
    write(h, fd, 512, 65);
    write(h, fd, 512, 65);
    write(h, fd, 512, 65);

    h.fs.createFile("/b", h.fs.lookup("/a").content);
    const b = h.fs.lookup("/b");
    assert.strictEqual(b.content.byteLength, 1536);

    h.imports.fd_filestat_set_size(fd, 1400n);
    h.imports.fd_filestat_set_size(fd, 1500n);

    assert.ok(
      b.content.every((byte) => byte === 65),
      "/b must be untouched by /a's resize",
    );
  });

  it("does not stop the guest appending after a read", () => {
    const h = makeFS();
    const node = trackFile(h, "log");
    const fd = openFile(h, "log");
    write(h, fd, 512, 74);
    h.fs.lookup("/log");

    write(h, fd, 512, 75);
    assert.strictEqual(node.content.byteLength, 1024);
    assert.strictEqual(node.content[0], 74);
    assert.strictEqual(node.content[1023], 75);
  });

  it("open/append/close does not reallocate on every cycle", () => {
    const h = makeFS();
    const node = trackFile(h, "log");

    const buffers = new Set();
    for (let i = 0; i < 300; i++) {
      const fd = openFile(h, "log", OFLAGS_CREAT, FDFLAGS_APPEND);
      write(h, fd, 64, 76);
      assert.strictEqual(h.imports.fd_close(fd), ESUCCESS);
      buffers.add(node.content.buffer);
    }

    assert.strictEqual(node.content.byteLength, 300 * 64);
    assert.ok(
      buffers.size <= 24,
      `expected O(log n) reallocations across 300 open/append/close cycles, saw ${buffers.size}`,
    );
  });
});

describe("fd.lineBuffered", () => {
  const encode = (text) => new TextEncoder().encode(text);
  const collect = (chunks) => {
    const lines = [];
    const write = lineBuffered((line) => lines.push(line));
    for (const chunk of chunks) write(chunk);
    return lines;
  };

  it("emits whole lines without the newline", () => {
    assert.deepStrictEqual(collect([encode("one\ntwo\n")]), ["one", "two"]);
  });

  it("holds an unterminated fragment until a newline arrives", () => {
    assert.deepStrictEqual(collect([encode("par")]), []);
    assert.deepStrictEqual(collect([encode("par"), encode("tial\n")]), [
      "partial",
    ]);
  });

  it("keeps empty lines", () => {
    assert.deepStrictEqual(collect([encode("\n\n")]), ["", ""]);
  });

  it("joins a character split across two writes", () => {
    // "✓" is E2 9C 93, cut between the second and third byte.
    assert.deepStrictEqual(
      collect([new Uint8Array([0xe2, 0x9c]), new Uint8Array([0x93, 0x0a])]),
      ["✓"],
    );
  });

  it("accepts already-decoded strings", () => {
    assert.deepStrictEqual(collect(["a\nb\n"]), ["a", "b"]);
  });

  it("flush emits text with no trailing newline", () => {
    const lines = [];
    const write = lineBuffered((line) => lines.push(line));
    write(encode("no newline here"));
    assert.deepStrictEqual(lines, [], "held until asked for");
    write.flush();
    assert.deepStrictEqual(lines, ["no newline here"]);
  });

  it("flush on an empty buffer writes nothing", () => {
    const lines = [];
    const write = lineBuffered((line) => lines.push(line));
    write(encode("done\n"));
    write.flush();
    assert.deepStrictEqual(lines, ["done"]);
  });

  it("a string does not let pending bytes span it", () => {
    // Half of "✓" (E2 9C), then text, then the byte that would complete it.
    // A string cannot continue a byte sequence, so the half character
    // resolves where it arrived instead of reordering after the text.
    assert.deepStrictEqual(
      collect([
        new Uint8Array([0xe2, 0x9c]),
        "x\n",
        new Uint8Array([0x93, 0x0a]),
      ]),
      ["\ufffdx", "\ufffd"],
    );
  });
});
