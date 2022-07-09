import { readdirSync, statSync } from "fs";
import { join as pathJoin } from "path";
import { runTest } from "./harness";

describe("wasi-test-suite-libc", () => {
    const suiteDir = pathJoin(__dirname, "../../third_party/wasi-test-suite/libc");
    const entries = readdirSync(suiteDir);
    const UNSUPPORTED = [
        "clock_getres-monotonic.wasm",
        "clock_gettime-monotonic.wasm",
        "stdin-hello.wasm",
        "ftruncate.wasm",
    ]

    for (const entry of entries) {
        const filePath = pathJoin(suiteDir, entry)
        const stat = statSync(filePath);
        if (!entry.endsWith(".wasm") || !stat.isFile()) {
            continue;
        }
        const defineCase = UNSUPPORTED.includes(entry) ? it.skip : it;
        defineCase(entry, async () => {
            await runTest(filePath);
        })
    }
})
