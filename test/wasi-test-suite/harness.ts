import { WASI, useEnviron, useArgs, useClock, useProc, useRandom, useStdio } from "../../src/index";
import { WASIAbi } from "../../src/abi";
import { existsSync } from "fs";
import { readFile } from "fs/promises";

export async function runTest(filePath: string) {
    let stdout = "";
    let stderr = "";
    const features = [
        useEnviron, useArgs, useClock, useProc,
        useRandom(), useStdio({
            stdout: (lines) => { stdout += lines },
            stderr: (lines) => { stderr += lines },
        })
    ];
    const wasi = new WASI({
        args: [],
        env: {},
        features: features,
    });
    const { instance } = await WebAssembly.instantiate(await readFile(filePath), {
        wasi_snapshot_preview1: wasi.wasiImport,
    });
    const exitCode = wasi.start(instance);
    const expectedExitCode = await (async () => {
        const path = filePath.replace(/\.wasm$/, ".status");
        if (!existsSync(path)) {
            return WASIAbi.WASI_ESUCCESS;
        }
        return parseInt(await readFile(path, { encoding: "utf-8" }), 10);
    })()
    const expectedStdout = await (async () => {
        const path = filePath.replace(/\.wasm$/, ".stdout");
        if (!existsSync(path)) {
            return null;
        }
        return await readFile(path, { encoding: "utf-8" });
    })();
    const expectedStderr = await (async () => {
        const path = filePath.replace(/\.wasm$/, ".stderr");
        if (!existsSync(path)) {
            return null;
        }
        return await readFile(path, { encoding: "utf-8" });
    })();
    expect(exitCode).toBe(expectedExitCode);
    if (expectedStdout) {
        expect(stdout).toBe(expectedStdout);
    }
    if (expectedStderr) {
        expect(stderr).toBe(expectedStderr);
    }
}
