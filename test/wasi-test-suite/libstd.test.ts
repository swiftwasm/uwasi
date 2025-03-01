import { readdirSync, statSync } from "fs";
import { join as pathJoin } from "path";
import { runTest } from "./harness";

describe("wasi-test-suite-libstd", () => {
  const suiteDir = pathJoin(
    __dirname,
    "../../third_party/wasi-test-suite/libstd",
  );
  const entries = readdirSync(suiteDir);
  const UNSUPPORTED = [
    "fs_create_dir-new-directory.wasm",
    "fs_file_create.wasm",
    "fs_metadata-directory.wasm",
    "fs_metadata-file.wasm",
    "fs_rename-directory.wasm",
    "fs_rename-file.wasm",
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
