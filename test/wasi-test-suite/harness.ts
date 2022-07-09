import { WASI, useEnviron, useArgs, useClock, useProc, useRandom, useStdio } from "../../src/index";
import { WASIAbi } from "../../src/abi";
import { existsSync } from "fs";
import { readFile } from "fs/promises";

export async function runTest(filePath: string) {
    let stdout = "";
    let stderr = "";
    let stdin = await (async () => {
        const path = filePath.replace(/\.wasm$/, ".stdin");
        if (!existsSync(path)) {
            return "";
        }
        return await readFile(path, "utf8");
    })()
    const features = [
        useEnviron, useArgs, useClock, useProc,
        useRandom(), useStdio({
            stdin: () => {
                const result = stdin;
                stdin = "";
                return result;
            },
            stdout: (lines) => { stdout += lines },
            stderr: (lines) => { stderr += lines },
        })
    ];
    const env = await (async () => {
        const path = filePath.replace(/\.wasm$/, ".env");
        if (!existsSync(path)) {
            return {};
        }
        const data = await readFile(path, "utf8");
        return data.split("\n").reduce((acc, line) => {
            const components = line.trim().split("=");
            if (components.length < 2) {
                return acc;
            }
            return { ...acc, [components[0]]: components.slice(1).join("=") };
        }, {});
    })()
    const wasi = new WASI({
        args: [],
        env,
        features: features,
    });
    const { instance } = await WebAssembly.instantiate(await readFile(filePath), {
        wasi_snapshot_preview1: wasi.wasiImport,
    });
    let exitCode: number;
    try {
        exitCode = wasi.start(instance);
    } catch (e) {
        if (e instanceof WebAssembly.RuntimeError && e.message == "unreachable") {
            // When unreachable code is executed, many WebAssembly runtimes raise
            // SIGABRT (=0x6) signal. It results in exit code 0x80 + signal number in shell.
            // Reference: https://tldp.org/LDP/abs/html/exitcodes.html#EXITCODESREF
            exitCode = 0x86;
        } else {
            throw e;
        }
    }
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
