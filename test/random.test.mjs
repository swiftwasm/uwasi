import { useRandom } from "../lib/esm/index.js";
import { WASIAbi } from "../lib/esm/abi.js";
import { describe, it } from "node:test";
import assert from "node:assert";

function makeImports(size) {
  const memory = new ArrayBuffer(size);
  const view = new DataView(memory);
  const abi = new WASIAbi();
  const imports = useRandom()({}, abi, () => view);
  return { memory, imports };
}

describe("random.useRandom default backend", () => {
  it("fills the requested range with random bytes", () => {
    const { memory, imports } = makeImports(1024);
    assert.strictEqual(imports.random_get(16, 64), 0);
    const filled = new Uint8Array(memory, 16, 64);
    assert.ok(
      filled.some((b) => b !== 0),
      "expected at least one nonzero random byte",
    );
    // Bytes outside the range stay untouched.
    const before = new Uint8Array(memory, 0, 16);
    assert.ok(before.every((b) => b === 0));
  });

  it("handles requests larger than the 65536-byte getRandomValues cap", () => {
    const size = 100_000;
    const { memory, imports } = makeImports(size + 16);
    assert.strictEqual(imports.random_get(8, size), 0);
    const filled = new Uint8Array(memory, 8, size);
    // The tail past the first chunk boundary must be filled too.
    const tail = filled.subarray(65536);
    assert.ok(
      tail.some((b) => b !== 0),
      "expected random bytes after the 65536-byte boundary",
    );
  });
});
