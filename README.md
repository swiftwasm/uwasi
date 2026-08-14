[![npm version](https://badge.fury.io/js/uwasi.svg)](https://badge.fury.io/js/uwasi)
[![.github/workflows/test.yml](https://github.com/swiftwasm/uwasi/actions/workflows/test.yml/badge.svg)](https://github.com/swiftwasm/uwasi/actions/workflows/test.yml)

# μWASI

This library provides a WASI implementation for Node.js and browsers in a tree-shaking friendly way.
The system calls provided by this library are configurable.

With minimal configuration, it provides WASI system calls which just return `WASI_ENOSYS`.

## Features

- No dependencies
- Tree-shaking friendly
  - 3 KB when minimal configuration
  - 6 KB when all features enabled
- Almost compatible interface with [Node.js WASI implementation](https://nodejs.org/api/wasi.html)
- Well tested, thanks to [wasi-test-suite by Casper Beyer](https://github.com/caspervonb/wasi-test-suite)

## Installation

```bash
npm install uwasi
```

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

/* With Reactor model
    wasi.initialize(instance);
*/
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

### With `environ`, `args`, `clock`, `proc`, and `random` enabled

```js
import { WASI, useArgs, useClock } from "uwasi";

const wasi = new WASI({
    args: ["./a.out", "hello", "world"],
    features: [useEnviron, useArgs, useClock, useProc, useRandom()],
});
```

### With `fd` (file descriptor) enabled only for stdio

By default, `stdin` behaves like `/dev/null`, `stdout` and `stderr` print to the console.

```js
import { WASI, useStdio } from "uwasi";

const wasi = new WASI({
    features: [useStdio()],
});
```

You can use custom backends for stdio by passing handlers to `useStdio`.

```js
import { WASI, useStdio } from "uwasi";

const inputs = ["Y", "N", "Y", "Y"];
const wasi = new WASI({
    features: [useStdio({
        stdin: () => inputs.shift() || "",
        stdout: (str) => document.body.innerHTML += str,
        stderr: (str) => document.body.innerHTML += str,
    })],
});
```

By default, the `stdout` and `stderr` handlers are passed strings. You can pass `outputBuffers: true` to get `Uint8Array` buffers instead. Along with that, you can also pass `Uint8Array` buffers to `stdin`.

```js
import { WASI, useStdio } from "uwasi";
const wasi = new WASI({
    features: [useStdio({
        outputBuffers: true,
        stdin: () => new Uint8Array([1, 2, 3, 4, 5]),
        stdout: (buf) => console.log(buf),
        stderr: (buf) => console.error(buf),
    })],
});
```

### With `poll_oneoff` and `sched_yield` enabled

`usePoll` supplies the blocking primitives that libc sleep functions
(`nanosleep`, `usleep`, timed waits) are built on. Clock subscriptions block
the calling thread until the earliest deadline using `Atomics.wait` where the
host allows it, falling back to a busy-wait (e.g. on the browser main thread).
Since all file descriptors in this runtime are synchronous, `fd_read`/`fd_write`
subscriptions report ready immediately.

```js
import { WASI, useStdio, usePoll } from "uwasi";

const wasi = new WASI({
    features: [useStdio(), usePoll()],
});
```

The blocking strategy is replaceable, e.g. to integrate with a host scheduler:

```js
const wasi = new WASI({
    features: [usePoll({ sleep: (ms) => mySynchronousSleep(ms) })],
});
```

`usePoll` is included in `useAll()`.

### Genuine stdin readiness with `SharedInputChannel`

For readiness-driven guests (e.g. `poll(2)`-based event loops or libdispatch
fd sources), `SharedInputChannel` connects a producing thread — a worker
pumping a pipe, or a UI thread collecting keystrokes — to the guest thread
over a `SharedArrayBuffer` ring. `poll_oneoff` then genuinely parks the guest
(`Atomics.wait`) until input arrives, end of file, or a clock deadline, and
reads drain the buffer without blocking. Producer close is delivered as an
fd hangup event (`POLLHUP` through libc `poll`).

```js
// Guest thread
import { WASI, useStdio, usePoll, SharedInputChannel } from "uwasi";
const channel = new SharedInputChannel();
// hand channel.sharedBuffer to the producing thread...
const wasi = new WASI({
    features: [
        useStdio({ stdin: channel.stdin() }),
        usePoll({ fdReadiness: channel.fdReadiness() }),
    ],
});

// Producing thread (worker or main thread)
const producer = new SharedInputChannel(sharedBufferFromGuestThread);
producer.push(new TextEncoder().encode("hello"));
producer.close(); // end of file
```

`Atomics.wait` is unavailable on a browser main thread, so run the guest in a
worker there; waits degrade to a busy-wait otherwise. In browsers,
`SharedArrayBuffer` additionally requires the page to be cross-origin
isolated (`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` response headers). Node.js and
worker threads need no special setup.

## Implementation Status

Some of WASI system calls are not implemented yet. Contributions are welcome!

| Syscall | Status | Notes |
|-------|----------|---------|
| `args_XXX` | ✅ | |
| `clock_XXX` | ✅ | CPU-time clocks are approximated by the monotonic clock |
| `environ_XXX` | ✅ | |
| `fd_XXX` | 🚧 | stdin/stdout/stderr are supported |
| `path_XXX` | ❌ | |
| `poll_oneoff` | ✅ | Clock subscriptions block the thread (`Atomics.wait`, busy-wait fallback); fd subscriptions report ready immediately by default, or genuine readiness via `SharedInputChannel`/`fdReadiness` |
| `proc_XXX` | ✅ | `proc_raise` exits with `128 + signal` |
| `random_get` | ✅ | |
| `sched_yield` | ✅ | No-op success on a single-threaded host |
| `sock_XXX` | ❌ | |

## Spec conformance notes

uwasi targets WASI preview1. Four behaviors deliberately go beyond or beside
the letter of the preview1 spec; all are defaults chosen for compatibility on
single-threaded JavaScript hosts, and all guest-visible surface remains the
plain `wasi_snapshot_preview1` namespace:

- **CPU-time clocks (`clockid` 2/3) are answered with the monotonic clock.**
  Preview2 dropped these clocks as impractical to implement, and
  [wasi-clocks](https://github.com/WebAssembly/wasi-clocks) documents
  wasi-libc's strategy of emulating them with the monotonic clock — uwasi
  applies the same sanctioned emulation at the host. (wasmtime instead
  rejects these clock IDs.)
- **Without a readiness provider, `poll_oneoff` fd subscriptions report
  ready immediately** with nominal `nbytes` (1 for reads, 65536 for writes)
  rather than actual availability. Wire `usePoll({ fdReadiness })` (e.g. via
  `SharedInputChannel`) for genuine readiness. Preview2 removed byte counts
  from poll results entirely; preview3 removed readiness polling.
- **`poll_oneoff` returns `ENOTSUP` for waits that can never complete**
  (not-ready fds with no way to wait and no clock deadline) instead of
  blocking forever on the only thread. Preview1 does not define this failure
  mode; preview3's completion-based async dissolves the problem.
- **`proc_raise` terminates with exit code `128 + signal` for every
  signal.** There is no signal machinery to deliver to; modern wasi-libc no
  longer calls `proc_raise`, and preview2/preview3 removed signals.

Host-side APIs beyond the preview1 surface (`usePoll`'s `sleep`/
`fdReadiness` options, `SharedInputChannel`) are embedder configuration,
invisible to guests. They intentionally mirror preview2 shapes — a
`WASIFdReadiness` is a `pollable`, a `SharedInputChannel` is an
`input-stream` producer — so a future preview2 host layer can reuse them.
