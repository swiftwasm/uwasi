/** Whether `buffer` can be resized after the fact. Typed here to avoid a newer lib. */
export function isResizable(buffer: ArrayBufferLike): boolean {
  return (buffer as { resizable?: boolean }).resizable === true;
}

/** Buffers allocated here, whose spare room is safe to grow into. */
export const ownBuffers = new WeakSet<ArrayBufferLike>();

/** Spare room after `data` in a buffer this module owns, or 0. */
function ownCapacity(data: Uint8Array): number {
  if (!ownBuffers.has(data.buffer) || data.byteOffset !== 0) return 0;
  return data.buffer.byteLength;
}

/**
 * Return a `Uint8Array` of `newSize` bytes holding as much of `data` as fits.
 *
 * Files are stored in a buffer with room to spare, and the view describes only
 * the part in use. An append then re-views the same buffer instead of copying
 * the file, so N bytes of small writes cost O(N) rather than O(N^2).
 *
 * Solves the problem reported in #12, which Cheng Shao also fixed for
 * bjorn3/browser_wasi_shim in #95. That fix reserves the spare room with a
 * resizable `ArrayBuffer`; this one uses a plain oversized buffer, because Web
 * IDL rejects a view backed by a resizable buffer wherever it expects a
 * `BufferSource` (https://webidl.spec.whatwg.org/#AllowResizable). A plain
 * buffer needs no such guard, so nothing has to be copied before an embedder
 * reads it.
 */
export function resizeContent(data: Uint8Array, newSize: number): Uint8Array {
  if (data.byteLength === newSize) return data;

  const capacity = ownCapacity(data);

  // Growing into spare room. Zero what a previous shrink may have left there.
  // Past roughly a doubling a fresh buffer is cheaper: its pages arrive zeroed.
  if (
    newSize > data.byteLength &&
    newSize <= capacity &&
    newSize - data.byteLength <= data.byteLength
  ) {
    const grown = new Uint8Array(data.buffer, 0, newSize);
    grown.fill(0, data.byteLength);
    return grown;
  }

  // Shrinking. Re-view in place, unless most of the buffer would go to waste.
  if (newSize < data.byteLength && capacity !== 0 && newSize * 4 >= capacity) {
    return new Uint8Array(data.buffer, 0, newSize);
  }

  const buffer = new ArrayBuffer(
    newSize < data.byteLength
      ? newSize
      : Math.max(newSize, data.byteLength * 2),
  );
  ownBuffers.add(buffer);
  const next = new Uint8Array(buffer, 0, newSize);
  next.set(newSize < data.byteLength ? data.subarray(0, newSize) : data);
  return next;
}
