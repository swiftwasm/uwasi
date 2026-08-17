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
  const imports = useClock({}, abi, () => view);
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
      assert.strictEqual(imports.clock_res_get(clockId, 0), 0);
      assert.ok(view.getUint32(0, true) > 0, `clock ${clockId} resolution`);
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
