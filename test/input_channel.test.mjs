import { usePoll, SharedInputChannel } from "../lib/esm/index.js";
import { WASIAbi } from "../lib/esm/abi.js";
import { Worker } from "node:worker_threads";
import { describe, it } from "node:test";
import assert from "node:assert";

const EVENTTYPE_FD_READ = 1;

function makeImports(channel) {
  const memory = new ArrayBuffer(65536);
  const view = new DataView(memory);
  const abi = new WASIAbi();
  const imports = usePoll({ fdReadiness: channel.fdReadiness() })(
    {},
    abi,
    () => view,
  );
  return { view, imports };
}

function writeClockSubscription(view, ptr, { userdata, timeoutNs }) {
  view.setBigUint64(ptr, BigInt(userdata), true);
  view.setUint8(ptr + 8, 0); // clock
  view.setUint32(ptr + 16, 1, true); // monotonic
  view.setBigUint64(ptr + 24, BigInt(timeoutNs), true);
  view.setBigUint64(ptr + 32, BigInt(0), true);
  view.setUint16(ptr + 40, 0, true);
}

function writeFdReadSubscription(view, ptr, { userdata, fd }) {
  view.setBigUint64(ptr, BigInt(userdata), true);
  view.setUint8(ptr + 8, EVENTTYPE_FD_READ);
  view.setUint32(ptr + 16, fd, true);
}

// A worker that attaches to the shared buffer, pushes `text` after `delayMs`,
// and optionally closes the channel.
function producerWorker(channel, { delayMs, text, close = false }) {
  const libUrl = new URL("../lib/esm/index.js", import.meta.url).href;
  return new Worker(
    `
    const { workerData } = require("node:worker_threads");
    (async () => {
      const { SharedInputChannel } = await import(workerData.libUrl);
      const producer = new SharedInputChannel(workerData.sharedBuffer);
      await new Promise((resolve) => setTimeout(resolve, workerData.delayMs));
      if (workerData.text) producer.push(new TextEncoder().encode(workerData.text));
      if (workerData.close) producer.close();
    })();
    `,
    {
      eval: true,
      workerData: {
        libUrl,
        sharedBuffer: channel.sharedBuffer,
        delayMs,
        text,
        close,
      },
    },
  );
}

describe("SharedInputChannel", () => {
  it("same-thread push, consume, and EOF", () => {
    const channel = new SharedInputChannel(16);
    assert.strictEqual(channel.bytesReadable(), 0);
    channel.push(new TextEncoder().encode("abcdef"));
    assert.strictEqual(channel.bytesReadable(), 6);
    assert.deepStrictEqual(
      channel.consume(4),
      new TextEncoder().encode("abcd"),
    );
    assert.deepStrictEqual(channel.consume(), new TextEncoder().encode("ef"));
    assert.strictEqual(channel.isClosed(), false);
    channel.close();
    assert.strictEqual(channel.isClosed(), true);
  });

  it("wraps around a small ring", () => {
    const channel = new SharedInputChannel(8);
    for (let round = 0; round < 5; round++) {
      const text = `r${round}xyz`;
      channel.push(new TextEncoder().encode(text));
      assert.deepStrictEqual(channel.consume(), new TextEncoder().encode(text));
    }
  });

  it("poll_oneoff parks until a worker pushes input", async () => {
    const channel = new SharedInputChannel();
    const { view, imports } = makeImports(channel);
    const worker = producerWorker(channel, { delayMs: 100, text: "ping" });
    try {
      writeClockSubscription(view, 0, {
        userdata: 1,
        timeoutNs: 2_000_000_000,
      });
      writeFdReadSubscription(view, 48, { userdata: 2, fd: 0 });
      const before = performance.now();
      const errno = imports.poll_oneoff(0, 1024, 2, 2048);
      const elapsed = performance.now() - before;
      assert.strictEqual(errno, 0);
      assert.strictEqual(view.getUint32(2048, true), 1);
      assert.strictEqual(view.getBigUint64(1024, true), BigInt(2)); // fd event
      assert.strictEqual(view.getUint8(1024 + 10), EVENTTYPE_FD_READ);
      assert.strictEqual(view.getBigUint64(1024 + 16, true), BigInt(4)); // nbytes
      assert.ok(
        elapsed >= 80 && elapsed < 1500,
        `expected ~100ms park, took ${elapsed}ms`,
      );
      // The subsequent read is non-blocking and served from the buffer.
      assert.deepStrictEqual(
        channel.consume(),
        new TextEncoder().encode("ping"),
      );
    } finally {
      await worker.terminate();
    }
  });

  it("producer close wakes the park and reports hangup", async () => {
    const channel = new SharedInputChannel();
    const { view, imports } = makeImports(channel);
    const worker = producerWorker(channel, { delayMs: 80, close: true });
    try {
      writeClockSubscription(view, 0, {
        userdata: 1,
        timeoutNs: 2_000_000_000,
      });
      writeFdReadSubscription(view, 48, { userdata: 2, fd: 0 });
      const before = performance.now();
      const errno = imports.poll_oneoff(0, 1024, 2, 2048);
      const elapsed = performance.now() - before;
      assert.strictEqual(errno, 0);
      assert.strictEqual(view.getUint32(2048, true), 1);
      assert.strictEqual(view.getBigUint64(1024, true), BigInt(2));
      assert.strictEqual(view.getUint16(1024 + 24, true), 1); // hangup flag
      assert.ok(
        elapsed >= 60 && elapsed < 1500,
        `expected ~80ms park, took ${elapsed}ms`,
      );
    } finally {
      await worker.terminate();
    }
  });

  it("clock deadline still fires while parked with no input", () => {
    const channel = new SharedInputChannel();
    const { view, imports } = makeImports(channel);
    writeClockSubscription(view, 0, { userdata: 1, timeoutNs: 60_000_000 });
    writeFdReadSubscription(view, 48, { userdata: 2, fd: 0 });
    const before = performance.now();
    const errno = imports.poll_oneoff(0, 1024, 2, 2048);
    const elapsed = performance.now() - before;
    assert.strictEqual(errno, 0);
    assert.strictEqual(view.getUint32(2048, true), 1);
    assert.strictEqual(view.getBigUint64(1024, true), BigInt(1)); // clock event
    assert.ok(
      elapsed >= 50 && elapsed < 1000,
      `expected ~60ms park, took ${elapsed}ms`,
    );
  });
});
