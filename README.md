[![.github/workflows/test.yml](https://github.com/swiftwasm/uwasi/actions/workflows/test.yml/badge.svg)](https://github.com/swiftwasm/uwasi/actions/workflows/test.yml)

# μWASI

This library provides a WASI implementation for Node.js and browsers in a tree-shaking friendly way.
The system calls provided by this library are configurable.

With minimal configuration, it provides WASI system calls which just return `WASI_ENOSYS`.

## Example

### With all system calls enabled

```js
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
```

### With no system calls enabled

```js
import { WASI, useAll } from "uwasi";

const wasi = new WASI({
    features: [],
});
```

### With `args` and `clock` enabled

```js
import { WASI, useArgs, useClock } from "uwasi";

const wasi = new WASI({
    args: ["./a.out", "hello", "world"],
    features: [useArgs, useClock],
});
```

### With `fd` (file descriptor) enabled only for stdio

```js
import { WASI, useStdio } from "uwasi";

const wasi = new WASI({
    features: [useStdio()],
});
```

## Implementation Status

| `API` | `Status` | `Notes` |
|-------|----------|---------|
| `args_XXX` | ✅ | |
| `clock_XXX` | ✅ | Monotonic clock is unavailable due to JS API limitation |
| `environ_XXX` | ✅ | |
| `fd_XXX` | 🚧 | stdin/stdout/stderr are supported |
| `path_XXX` | ❌ | |
| `poll_oneoff` | ❌ | |
| `proc_XXX` | ✅ | |
| `random_get` | ✅ | |
| `sched_yield` | ❌ | |
| `sock_XXX` | ❌ | |
