import { usePoll } from "../lib/esm/index.js";
import { WASIAbi } from "../lib/esm/abi.js";
import { describe, it } from "node:test";
import assert from "node:assert";

const EVENTTYPE_CLOCK = 0;
const EVENTTYPE_FD_READ = 1;
const EVENTTYPE_FD_WRITE = 2;
const SUBCLOCKFLAGS_ABSTIME = 1;
const CLOCK_REALTIME = 0;
const CLOCK_MONOTONIC = 1;

const SUBSCRIPTION_SIZE = 48;
const EVENT_SIZE = 32;

function makeImports(useOptions = {}) {
  const memory = new ArrayBuffer(65536);
  const view = new DataView(memory);
  const abi = new WASIAbi();
  const imports = usePoll(useOptions)({}, abi, () => view);
  return { view, imports };
}

function writeClockSubscription(
  view,
  ptr,
  { userdata, clockId, timeoutNs, flags = 0 },
) {
  view.setBigUint64(ptr, BigInt(userdata), true);
  view.setUint8(ptr + 8, EVENTTYPE_CLOCK);
  view.setUint32(ptr + 16, clockId, true);
  view.setBigUint64(ptr + 24, BigInt(timeoutNs), true);
  view.setBigUint64(ptr + 32, BigInt(0), true); // precision
  view.setUint16(ptr + 40, flags, true);
}

function writeFdSubscription(view, ptr, { userdata, eventType, fd }) {
  view.setBigUint64(ptr, BigInt(userdata), true);
  view.setUint8(ptr + 8, eventType);
  view.setUint32(ptr + 16, fd, true);
}

function readEvent(view, ptr) {
  return {
    userdata: view.getBigUint64(ptr, true),
    error: view.getUint16(ptr + 8, true),
    type: view.getUint8(ptr + 10),
  };
}

describe("poll.usePoll", () => {
  it("sched_yield returns success", () => {
    const { imports } = makeImports();
    assert.strictEqual(imports.sched_yield(), 0);
  });

  it("poll_oneoff with zero subscriptions returns EINVAL", () => {
    const { imports } = makeImports();
    assert.strictEqual(imports.poll_oneoff(0, 0, 0, 1024), 28);
  });

  it("relative monotonic clock subscription sleeps until the deadline", () => {
    const { view, imports } = makeImports();
    const subsPtr = 0;
    const eventsPtr = 1024;
    const neventsPtr = 2048;
    writeClockSubscription(view, subsPtr, {
      userdata: 42,
      clockId: CLOCK_MONOTONIC,
      timeoutNs: 50_000_000, // 50ms
    });
    const before = performance.now();
    const errno = imports.poll_oneoff(subsPtr, eventsPtr, 1, neventsPtr);
    const elapsed = performance.now() - before;
    assert.strictEqual(errno, 0);
    assert.strictEqual(view.getUint32(neventsPtr, true), 1);
    const event = readEvent(view, eventsPtr);
    assert.strictEqual(event.userdata, BigInt(42));
    assert.strictEqual(event.error, 0);
    assert.strictEqual(event.type, EVENTTYPE_CLOCK);
    assert.ok(elapsed >= 45, `slept only ${elapsed}ms, expected ~50ms`);
  });

  it("absolute realtime deadline in the past returns immediately", () => {
    const { view, imports } = makeImports();
    writeClockSubscription(view, 0, {
      userdata: 7,
      clockId: CLOCK_REALTIME,
      timeoutNs: BigInt(Date.now() - 1000) * BigInt(1_000_000),
      flags: SUBCLOCKFLAGS_ABSTIME,
    });
    const before = performance.now();
    const errno = imports.poll_oneoff(0, 1024, 1, 2048);
    const elapsed = performance.now() - before;
    assert.strictEqual(errno, 0);
    assert.strictEqual(view.getUint32(2048, true), 1);
    assert.ok(elapsed < 25, `expected immediate return, took ${elapsed}ms`);
  });

  it("fd_write readiness wins over a pending clock timeout", () => {
    const { view, imports } = makeImports();
    writeClockSubscription(view, 0, {
      userdata: 1,
      clockId: CLOCK_MONOTONIC,
      timeoutNs: 1_000_000_000, // 1s; must not be awaited
    });
    writeFdSubscription(view, SUBSCRIPTION_SIZE, {
      userdata: 2,
      eventType: EVENTTYPE_FD_WRITE,
      fd: 1,
    });
    const before = performance.now();
    const errno = imports.poll_oneoff(0, 1024, 2, 2048);
    const elapsed = performance.now() - before;
    assert.strictEqual(errno, 0);
    assert.strictEqual(view.getUint32(2048, true), 1);
    const event = readEvent(view, 1024);
    assert.strictEqual(event.userdata, BigInt(2));
    assert.strictEqual(event.type, EVENTTYPE_FD_WRITE);
    assert.ok(elapsed < 100, `expected immediate return, took ${elapsed}ms`);
  });

  it("fd_read subscriptions are immediately ready", () => {
    const { view, imports } = makeImports();
    writeFdSubscription(view, 0, {
      userdata: 3,
      eventType: EVENTTYPE_FD_READ,
      fd: 0,
    });
    const errno = imports.poll_oneoff(0, 1024, 1, 2048);
    assert.strictEqual(errno, 0);
    assert.strictEqual(view.getUint32(2048, true), 1);
    const event = readEvent(view, 1024);
    assert.strictEqual(event.userdata, BigInt(3));
    assert.strictEqual(event.type, EVENTTYPE_FD_READ);
  });

  it("earliest of several clock subscriptions fires", () => {
    const { view, imports } = makeImports();
    writeClockSubscription(view, 0, {
      userdata: 10,
      clockId: CLOCK_MONOTONIC,
      timeoutNs: 1_000_000_000, // 1s
    });
    writeClockSubscription(view, SUBSCRIPTION_SIZE, {
      userdata: 11,
      clockId: CLOCK_MONOTONIC,
      timeoutNs: 30_000_000, // 30ms
    });
    const before = performance.now();
    const errno = imports.poll_oneoff(0, 1024, 2, 2048);
    const elapsed = performance.now() - before;
    assert.strictEqual(errno, 0);
    assert.strictEqual(view.getUint32(2048, true), 1);
    const event = readEvent(view, 1024);
    assert.strictEqual(event.userdata, BigInt(11));
    assert.ok(
      elapsed >= 25 && elapsed < 500,
      `expected ~30ms sleep, took ${elapsed}ms`,
    );
  });

  it("a custom sleep function is used for clock waits", () => {
    let sleptMs = 0;
    const { view, imports } = makeImports({
      sleep: (ms) => {
        sleptMs += ms;
      },
    });
    writeClockSubscription(view, 0, {
      userdata: 1,
      clockId: CLOCK_MONOTONIC,
      timeoutNs: 40_000_000, // 40ms
    });
    // The no-op sleep forces the wait loop to spin on the real clock, so
    // total requested sleep will exceed the original 40ms; just assert the
    // custom function was called with a sensible initial value.
    const errno = imports.poll_oneoff(0, 1024, 1, 2048);
    assert.strictEqual(errno, 0);
    assert.ok(sleptMs >= 40, `expected >=40ms requested, got ${sleptMs}ms`);
  });
});
