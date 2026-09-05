import { useClock } from "../lib/esm/index.js";
import { WASIAbi } from "../lib/esm/abi.js";
import { describe, it } from "node:test";
import assert from "node:assert";

const CLOCK_REALTIME = 0;
const CLOCK_MONOTONIC = 1;
const CLOCK_PROCESS_CPUTIME_ID = 2;
const CLOCK_THREAD_CPUTIME_ID = 3;

function makeImports() {
  const memory = new ArrayBuffer(1024);
  const view = new DataView(memory);
  const abi = new WASIAbi();
  const imports = useClock()({}, abi, () => view);
  return { view, imports };
}

describe("clock.useClock", () => {
  it("clock_res_get supports all four clock IDs", () => {
    const { view, imports } = makeImports();
    for (const clockId of [
      CLOCK_REALTIME,
      CLOCK_MONOTONIC,
      CLOCK_PROCESS_CPUTIME_ID,
      CLOCK_THREAD_CPUTIME_ID,
    ]) {
      // Prefill the u64 so a partial write fails.
      view.setBigUint64(0, 0xffff_ffff_ffff_ffffn, true);
      assert.strictEqual(imports.clock_res_get(clockId, 0), 0);
      assert.ok(view.getBigUint64(0, true) > 0n, `clock ${clockId} resolution`);
      assert.strictEqual(
        view.getUint32(4, true),
        0,
        `clock ${clockId} wrote its upper four bytes`,
      );
    }
  });

  it("clock_time_get supports all four clock IDs", () => {
    const { view, imports } = makeImports();
    for (const clockId of [
      CLOCK_REALTIME,
      CLOCK_MONOTONIC,
      CLOCK_PROCESS_CPUTIME_ID,
      CLOCK_THREAD_CPUTIME_ID,
    ]) {
      assert.strictEqual(imports.clock_time_get(clockId, 0, 8), 0);
      assert.ok(
        view.getBigUint64(8, true) > BigInt(0),
        `clock ${clockId} time`,
      );
    }
  });

  it("monotonic and CPU-time clocks never go backwards", () => {
    const { view, imports } = makeImports();
    for (const clockId of [
      CLOCK_MONOTONIC,
      CLOCK_PROCESS_CPUTIME_ID,
      CLOCK_THREAD_CPUTIME_ID,
    ]) {
      imports.clock_time_get(clockId, 0, 8);
      const first = view.getBigUint64(8, true);
      imports.clock_time_get(clockId, 0, 8);
      const second = view.getBigUint64(8, true);
      assert.ok(second >= first, `clock ${clockId} went backwards`);
    }
  });

  it("unknown clock IDs return ENOSYS", () => {
    const { imports } = makeImports();
    assert.strictEqual(imports.clock_res_get(99, 0), 52);
    assert.strictEqual(imports.clock_time_get(99, 0, 8), 52);
  });
});

describe("clock.useClock resolution values", () => {
  it("clock_res_get reports the resolution of each clock's source", () => {
    const { view, imports } = makeImports();
    // Date.now() is millisecond-granular; performance.now() is capped at 5 us.
    for (const [clockId, expected] of [
      [CLOCK_REALTIME, 1_000_000n],
      [CLOCK_MONOTONIC, 5_000n],
      [CLOCK_PROCESS_CPUTIME_ID, 5_000n],
      [CLOCK_THREAD_CPUTIME_ID, 5_000n],
    ]) {
      assert.strictEqual(imports.clock_res_get(clockId, 0), 0);
      assert.strictEqual(
        view.getBigUint64(0, true),
        expected,
        `clock ${clockId}`,
      );
    }
  });

  it("clock_res_get keeps the resolution readable as a u32", () => {
    // Every resolution fits in 32 bits, and the guest is little-endian, so a
    // caller that reads only the low four bytes sees what it saw before this
    // changed to a full u64 store.
    const { view, imports } = makeImports();
    for (const clockId of [
      CLOCK_REALTIME,
      CLOCK_MONOTONIC,
      CLOCK_PROCESS_CPUTIME_ID,
      CLOCK_THREAD_CPUTIME_ID,
    ]) {
      view.setBigUint64(0, 0xffff_ffff_ffff_ffffn, true);
      assert.strictEqual(imports.clock_res_get(clockId, 0), 0);
      assert.strictEqual(
        BigInt(view.getUint32(0, true)),
        view.getBigUint64(0, true),
        `clock ${clockId} low half carries the whole value`,
      );
    }
  });
});
