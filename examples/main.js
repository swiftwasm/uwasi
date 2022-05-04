import { WASI, useAll } from "uwasi";
import fs from "node:fs/promises";

async function main() {
    const wasi = new WASI({
        args: process.argv.slice(2),
        features: [useAll()],
    });
    const bytes = await fs.readFile(process.argv[2]);
    const { instance } = await WebAssembly.instantiate(bytes, {
        wasi_snapshot_preview1: wasi.wasiImport,
    });
    const exitCode = wasi.start(instance);
    console.log("exit code:", exitCode);
}

main()
