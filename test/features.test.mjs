import {
  WASI,
  useAll,
  useArgs,
  useClock,
  useEnviron,
  useProc,
  useRandom,
  useStdio,
} from "../lib/esm/index.js";
import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * Whether `syscall` is still the constructor's ENOSYS default.
 *
 * A WASI built with no features has nothing but defaults, so its import for a
 * syscall is exactly what an unregistered one looks like. Comparing against
 * that is exact; the shape of the default is not guessed at.
 */
function isUnregistered(wasi, syscall) {
  const bare = new WASI({ args: [], env: {}, features: [] });
  return String(wasi.wasiImport[syscall]) === String(bare.wasiImport[syscall]);
}

/** Every feature, in the one spelling the features array accepts. */
const called = {
  useArgs,
  useClock,
  useEnviron,
  useProc,
  useRandom,
  useStdio,
  useAll,
};

describe("WASI features", () => {
  for (const [name, feature] of Object.entries(called)) {
    it(`${name}() registers its syscalls`, () => {
      const wasi = new WASI({ args: [], env: {}, features: [feature()] });
      const registered = Object.keys(wasi.wasiImport).filter(
        (key) => !isUnregistered(wasi, key),
      );
      assert.ok(
        registered.length > 0,
        `${name}() left every syscall on the ENOSYS default`,
      );
    });

    it(`${name} without the call is rejected`, () => {
      // Uncalled, a feature hands the constructor its provider rather than an
      // import object, and none of its syscalls would be registered. That is
      // the failure behind #11, where a guest saw only ENOSYS and recursed
      // reporting it. Rejecting outright makes the cause visible at once.
      assert.throws(
        () => new WASI({ args: [], env: {}, features: [feature] }),
        (error) =>
          error instanceof TypeError &&
          error.message.includes(name) &&
          error.message.includes(`${name}(...)`),
        `${name} passed uncalled should throw and name itself`,
      );
    });
  }

  it("gives usable advice for a feature that has no name", () => {
    // Written inline: a function assigned to a `const` would take that
    // variable's name, and would not be anonymous at all.
    const anonymous = [() => () => ({ sched_yield: () => 0 })];
    assert.strictEqual(anonymous[0].name, "");
    assert.throws(
      () => new WASI({ args: [], env: {}, features: anonymous }),
      (error) =>
        /a feature was passed to the features array without being called/.test(
          error.message,
        ) &&
        // There is no name to offer, so the advice must not invent one.
        !/`.*\(\.\.\.\)`/.test(error.message),
    );
  });

  it("accepts a function that carries its imports as properties", () => {
    // Unusual, but a valid import map: `for...in` over it yields the syscalls.
    // The rejection above must test whether anything would be registered, not
    // the type alone, or this stops working.
    const provider = () => Object.assign(() => {}, { sched_yield: () => 0 });
    const wasi = new WASI({ args: [], env: {}, features: [provider] });
    assert.strictEqual(wasi.wasiImport.sched_yield(), 0);
  });

  it("accepts a provider written by hand", () => {
    // The features array takes providers. A caller can supply one directly,
    // which is what every feature's call returns.
    const provider = () => ({ sched_yield: () => 0 });
    const wasi = new WASI({ args: [], env: {}, features: [provider] });
    assert.strictEqual(wasi.wasiImport.sched_yield(), 0);
  });

  it("useAll() composes the features it wraps", () => {
    // `useAll` calls each feature internally. Passing one of them uncalled in
    // there would drop its syscalls silently, which the constructor cannot
    // catch because it only sees `useAll`'s result.
    const wasi = new WASI({
      args: ["prog"],
      env: { A: "1" },
      features: [useAll()],
    });
    for (const syscall of [
      "args_get",
      "environ_get",
      "clock_time_get",
      "proc_exit",
      "random_get",
      "fd_write",
      "path_open",
      "poll_oneoff",
    ]) {
      assert.ok(
        !isUnregistered(wasi, syscall),
        `useAll() left ${syscall} on the ENOSYS default`,
      );
    }
  });

  it("registers working stdio, the case from #11", () => {
    const written = [];
    const original = console.log;
    console.log = (line) => written.push(String(line));
    let ret;
    let nwritten;
    try {
      const wasi = new WASI({ args: [], env: {}, features: [useStdio()] });
      wasi.instance = {
        exports: { memory: new WebAssembly.Memory({ initial: 1 }) },
      };
      const view = new DataView(wasi.instance.exports.memory.buffer);
      const bytes = new Uint8Array(wasi.instance.exports.memory.buffer);
      bytes.set(new TextEncoder().encode("hi"), 64);
      view.setUint32(0, 64, true);
      view.setUint32(4, 2, true);
      ret = wasi.wasiImport.fd_write(1, 0, 1, 128);
      nwritten = view.getUint32(128, true);
    } finally {
      console.log = original;
    }
    assert.strictEqual(ret, 0, "fd_write must not report ENOSYS");
    assert.strictEqual(nwritten, 2);
    assert.deepStrictEqual(written, ["hi"]);
  });
});

describe("WASI.setInstance", () => {
  it("binds an instance without invoking an entry point", () => {
    const wasi = new WASI({ args: ["prog"], env: {}, features: [useArgs()] });
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.setInstance({ exports: { memory } });

    assert.strictEqual(wasi.wasiImport.args_sizes_get(0, 4), 0);
    const view = new DataView(memory.buffer);
    assert.strictEqual(view.getUint32(0, true), 1);
    assert.strictEqual(view.getUint32(4, true), "prog\0".length);
  });

  it("can rebind a second instance, which initialize() forbids", () => {
    const wasi = new WASI({ args: ["prog"], env: {}, features: [useArgs()] });
    wasi.setInstance({
      exports: { memory: new WebAssembly.Memory({ initial: 1 }) },
    });
    const second = new WebAssembly.Memory({ initial: 1 });
    wasi.setInstance({ exports: { memory: second } });

    assert.strictEqual(wasi.wasiImport.args_sizes_get(0, 4), 0);
    assert.strictEqual(new DataView(second.buffer).getUint32(0, true), 1);
  });
});
