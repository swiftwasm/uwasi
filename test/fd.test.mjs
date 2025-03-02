import { ReadableTextProxy } from "../lib/esm/features/fd.js";
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe("fd.ReadableTextProxy", () => {
  it("readv single buffer", () => {
    const input = "hello";
    const inputs = [input];
    const proxy = new ReadableTextProxy(() => inputs.shift() || "");
    const buffer = new Uint8Array(10);
    const read = proxy.readv([buffer]);
    assert.strictEqual(read, 5);
    const expected = new TextEncoder().encode(input);
    assert.deepStrictEqual(buffer.slice(0, 5), expected);
  });

  it("readv 2 buffer", () => {
    const input = "hello";
    const inputs = [input];
    const proxy = new ReadableTextProxy(() => inputs.shift() || "");
    const buf0 = new Uint8Array(2);
    const buf1 = new Uint8Array(2);
    const read = proxy.readv([buf0, buf1]);
    assert.strictEqual(read, 4);
    const expected = new TextEncoder().encode(input);
    assert.deepStrictEqual(buf0, expected.slice(0, 2));
    assert.deepStrictEqual(buf1, expected.slice(2, 4));
  });
});
