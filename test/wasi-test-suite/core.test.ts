import { readdirSync, statSync } from "fs";
import { join as pathJoin } from "path";
import { runTest } from "./harness";

describe("wasi-test-suite-core", () => {
  const suiteDir = pathJoin(
    __dirname,
    "../../third_party/wasi-test-suite/core",
  );
  const entries = readdirSync(suiteDir);
  const UNSUPPORTED = [
    "fd_stat_get-stderr.wasm",
    "fd_stat_get-stdin.wasm",
    "fd_stat_get-stdout.wasm",
    "sched_yield.wasm",
  ];

  for (const entry of entries) {
    const filePath = pathJoin(suiteDir, entry);
    const stat = statSync(filePath);
    if (!entry.endsWith(".wasm") || !stat.isFile()) {
      continue;
    }
    const defineCase = UNSUPPORTED.includes(entry) ? it.skip : it;
    defineCase(entry, async () => {
      await runTest(filePath);
    });
  }
});
