// @ts-check
import { useAll, MemoryFileSystem, useRandom } from "../lib/esm/index.js";
import * as crypto from "crypto";
import { cloneDirectories, wasiSuite } from "./wasi_suite.mjs";

wasiSuite("memory", async (testCase, preopens, withStdio) => {
  const fileSystem = new MemoryFileSystem(preopens);
  await cloneDirectories(fileSystem, testCase);
  return {
    features: [
      useAll({ withFileSystem: fileSystem, withStdio }),
      useRandom({ randomFillSync: crypto.randomFillSync }),
    ],
  };
});
