import { useProc, WASIProcExit } from "../lib/esm/index.js";
import { WASIAbi } from "../lib/esm/abi.js";
import { describe, it } from "node:test";
import assert from "node:assert";

function makeImports() {
  const abi = new WASIAbi();
  return useProc({}, abi, () => {
    throw new Error("memory should not be touched");
  });
}

describe("proc.useProc", () => {
  it("proc_exit throws WASIProcExit with the exit code", () => {
    const imports = makeImports();
    assert.throws(
      () => imports.proc_exit(3),
      (e) => e instanceof WASIProcExit && e.code === 3,
    );
  });

  it("proc_raise terminates with 128 + signal", () => {
    const imports = makeImports();
    // SIGABRT
    assert.throws(
      () => imports.proc_raise(6),
      (e) => e instanceof WASIProcExit && e.code === 134,
    );
  });
});
