// @ts-check
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { useAll, WASI, MemoryFileSystem, useRandom } from "../lib/esm/index.js";
import { describe, it } from "node:test";
import assert from "node:assert";
import * as crypto from "crypto";

/**
 * @typedef {{ exit_code?: number, args?: string[], env?: Record<string, string>, dirs?: string[] }} TestCaseConfig
 * @typedef {{ suite: string, wasmFile: string, testName: string, config: TestCaseConfig }} TestCase
 */

/**
 * Helper function to find test cases directory and files
 *
 * @param {string} testDir - The directory to search for test cases
 * @returns {Array<TestCase>} An array of test cases
 */
function findTestCases(testDir) {
  const testSuites = [
    { path: "rust/testsuite", name: "WASI Rust tests" },
    { path: "c/testsuite", name: "WASI C tests" },
    { path: "assemblyscript/testsuite", name: "WASI AssemblyScript tests" },
  ];

  /** @type {Array<TestCase>} */
  const allTests = [];

  for (const suite of testSuites) {
    const suitePath = path.join(testDir, suite.path);
    try {
      const files = fsSync.readdirSync(suitePath);
      const wasmFiles = files.filter((file) => file.endsWith(".wasm"));

      for (const wasmFile of wasmFiles) {
        // Find corresponding JSON config file
        const jsonFile = wasmFile.replace(".wasm", ".json");
        const jsonPath = path.join(suitePath, jsonFile);

        let config = {};
        try {
          const jsonContent = fsSync.readFileSync(jsonPath, "utf8");
          config = JSON.parse(jsonContent);
        } catch (e) {
          // Use default config if no JSON config file found
          config = {};
        }

        allTests.push({
          suite: suite.name,
          wasmFile: path.join(suitePath, wasmFile),
          testName: path.basename(wasmFile, ".wasm"),
          config,
        });
      }
    } catch (err) {
      console.warn(`Test suite ${suite.name} is not available: ${err.message}`);
    }
  }

  return allTests;
}

// Helper function to run a test
async function runTest(testCase) {
  /** @type {string[]} */
  const args = [];
  /** @type {Record<string, string>} */
  const env = {};

  // Add args if specified
  if (testCase.config.args) {
    args.push(...testCase.config.args);
  }

  // Add env if specified
  if (testCase.config.env) {
    for (const [key, value] of Object.entries(testCase.config.env)) {
      env[key] = value;
    }
  }

  // Setup file system
  const fileSystem = new MemoryFileSystem(
    (testCase.config.dirs || []).reduce((obj, dir) => {
      obj[dir] = dir;
      return obj;
    }, {}),
  );

  // Clone directories to memory file system
  if (testCase.config.dirs) {
    for (const dir of testCase.config.dirs) {
      const dirPath = path.join(path.dirname(testCase.wasmFile), dir);
      await cloneDirectoryToMemFS(fileSystem, dirPath, "/" + dir);
    }
  }

  // Create stdout and stderr buffers
  let stdoutData = "";
  let stderrData = "";

  // Create WASI instance
  const wasi = new WASI({
    args: [path.basename(testCase.wasmFile), ...args],
    env: env,
    features: [
      useAll({
        withFileSystem: fileSystem,
        withStdio: {
          stdout: (data) => {
            if (typeof data === "string") {
              stdoutData += data;
            } else {
              stdoutData += new TextDecoder().decode(data);
            }
          },
          stderr: (data) => {
            if (typeof data === "string") {
              stderrData += data;
            } else {
              stderrData += new TextDecoder().decode(data);
            }
          },
        },
      }),
      useRandom({
        randomFillSync: crypto.randomFillSync,
      }),
    ],
  });

  try {
    const wasmBytes = await fs.readFile(testCase.wasmFile);
    const wasmModule = await WebAssembly.compile(wasmBytes);
    const importObject = { wasi_snapshot_preview1: wasi.wasiImport };
    const instance = await WebAssembly.instantiate(wasmModule, importObject);

    // Start WASI
    const exitCode = wasi.start(instance);

    return {
      exitCode,
      stdout: stdoutData,
      stderr: stderrData,
    };
  } catch (error) {
    return {
      error: error.message,
      exitCode: 1,
      stdout: stdoutData,
      stderr: stderrData,
    };
  }
}

/**
 * Helper function to clone a directory to memory file system
 *
 * @param {MemoryFileSystem} fileSystem
 * @param {string} sourceDir
 * @param {string} targetPath
 * @returns {Promise<void>}
 */
async function cloneDirectoryToMemFS(fileSystem, sourceDir, targetPath) {
  // Check if directory exists
  const stats = await fs.stat(sourceDir);
  if (!stats.isDirectory()) {
    return;
  }

  // Create directory in file system
  fileSystem.ensureDir(targetPath);

  // Read directory contents
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  // Process each entry
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetFilePath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      // Recursively clone directory
      await cloneDirectoryToMemFS(fileSystem, sourcePath, targetFilePath);
    } else if (entry.isFile()) {
      // Read file content and add to file system
      const content = await fs.readFile(sourcePath);
      fileSystem.addFile(targetFilePath, content);
    }
  }
}

// Main test setup
describe("WASI Test Suite", () => {
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  const testDir = path.join(__dirname, "../third_party/wasi-testsuite/tests");
  const testCases = findTestCases(testDir);
  // Load the skip tests list
  let skipTests = {};
  try {
    skipTests = JSON.parse(
      fsSync.readFileSync(path.join(__dirname, "./wasi.skip.json"), "utf8"),
    );
  } catch (err) {
    console.warn("Could not load skip tests file. All tests will be run.");
  }

  // This test will dynamically create and run tests for each test case
  for (const testCase of testCases) {
    const isSkipped =
      skipTests[testCase.suite] && skipTests[testCase.suite][testCase.testName];
    const defineTest = isSkipped ? it.skip : it;
    defineTest(`${testCase.suite} - ${testCase.testName}`, async () => {
      const result = await runTest(testCase);
      assert.strictEqual(result.error, undefined, result.stderr);
      assert.strictEqual(
        result.exitCode,
        testCase.config.exit_code || 0,
        result.stderr,
      );
    });
  }
});
