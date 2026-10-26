// @ts-check
import {
  useRandom,
  useEnviron,
  useArgs,
  useClock,
  usePoll,
  useProc,
  useFS,
} from "../lib/esm/index.js";
import { ExclusiveOPFSBackend } from "uwasi/opfs";
import { MockOPFS } from "./opfs_mock.mjs";
import * as crypto from "crypto";
import { cloneDirectories, wasiSuite } from "./wasi_suite.mjs";

/**
 * Cases that fail on OPFS for a documented, principled reason. The runner
 * asserts they DO fail, so this list cannot silently go stale.
 *
 * @type {Record<string, Record<string, { reason: string, stderrIncludes: string }>>}
 */
const opfsExpectedFailures = {
  "WASI Rust tests": {
    path_link: {
      reason:
        "hard links return NOTSUP on OPFS: the durable namespace record " +
        "maps each data file to exactly one name",
      // Pin the failure to the first path_link call so an unrelated
      // breakage in the same case cannot masquerade as the known one.
      stderrIncludes:
        'creating a link in the same directory: Errno { code: 58, name: "NOTSUP"',
    },
  },
};

wasiSuite(
  "opfs",
  async (testCase, preopens, withStdio) => {
    // The OPFS backend over a mock store: same syscall surface, but every
    // namespace change round-trips through the durable namespace record.
    const store = new MockOPFS();
    const backend = await ExclusiveOPFSBackend.create(store.root, { preopens });
    try {
      await cloneDirectories(backend.fileSystem, testCase);
      // Seeded files are persisted up front so the spare pool stays free
      // for the files the guest creates.
      await backend.persistAll();
    } catch (error) {
      await backend.close();
      throw error;
    }
    return {
      features: [
        useFS({ withFileSystem: backend.fileSystem, withStdio }),
        useEnviron(),
        useArgs(),
        useClock(),
        usePoll({}),
        useProc(),
        useRandom({ randomFillSync: crypto.randomFillSync }),
      ],
      cleanup: () => backend.close(),
    };
  },
  opfsExpectedFailures,
);
