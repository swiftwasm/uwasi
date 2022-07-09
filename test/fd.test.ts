import { ReadableTextProxy } from "../src/features/fd"

describe("fd.ReadableTextProxy", () => {
    it("readv single buffer", () => {
        const input = "hello";
        const inputs = [input];
        const proxy = new ReadableTextProxy(() => inputs.shift() || "");
        const buffer = new Uint8Array(10);
        const read = proxy.readv([buffer]);
        expect(read).toBe(5);
        const expected = new TextEncoder().encode(input)
        expect(buffer.slice(0, 5)).toEqual(expected);
    })

    it("readv 2 buffer", () => {
        const input = "hello";
        const inputs = [input];
        const proxy = new ReadableTextProxy(() => inputs.shift() || "");
        const buf0 = new Uint8Array(2);
        const buf1 = new Uint8Array(2);
        const read = proxy.readv([buf0, buf1]);
        expect(read).toBe(4);
        const expected = new TextEncoder().encode(input)
        expect(buf0).toEqual(expected.slice(0, 2));
        expect(buf1).toEqual(expected.slice(2, 4));
    })
})
