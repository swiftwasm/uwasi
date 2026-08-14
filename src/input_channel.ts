import { WASIFdReadiness } from "./features/poll.js";

// Int32 header slots in front of the data ring.
const HEAD = 0; // total bytes ever written (wraps as uint32)
const TAIL = 1; // total bytes ever read (wraps as uint32)
const CLOSED = 2; // producer closed the channel
const EVENT_SEQ = 3; // bumped on every push, consume, and close; wait target
const HEADER_BYTES = 4 * Int32Array.BYTES_PER_ELEMENT;

function roundUpToPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

/**
 * A single-producer single-consumer byte channel over a `SharedArrayBuffer`,
 * connecting a thread that produces input (a worker pumping a pipe, a UI
 * thread collecting keystrokes) to the thread running the WASI guest.
 *
 * The consumer side plugs into uwasi:
 *
 * ```js
 * const channel = new SharedInputChannel();
 * const wasi = new WASI({
 *   features: [
 *     useStdio({ stdin: channel.stdin() }),
 *     usePoll({ fdReadiness: channel.fdReadiness() }),
 *   ],
 * });
 * ```
 *
 * The producer side runs on any other thread with access to
 * `channel.sharedBuffer`:
 *
 * ```js
 * const producer = new SharedInputChannel(sharedBuffer);
 * producer.push(new TextEncoder().encode("hello"));
 * producer.close(); // end of file
 * ```
 *
 * With this wiring, `poll_oneoff` genuinely parks the guest (via
 * `Atomics.wait`) until input arrives, end of file, or a clock deadline, and
 * guest reads consume buffered bytes without blocking. Producer close is
 * reported as an fd hangup event, which libc `poll()` maps to `POLLHUP`.
 *
 * Exactly one thread may produce and one thread may consume; the consumer
 * must be the thread running the guest. `Atomics.wait` is unavailable on a
 * browser main thread, so run the guest in a worker there (waits degrade to
 * a busy-wait otherwise).
 */
export class SharedInputChannel {
  readonly sharedBuffer: SharedArrayBuffer;
  private readonly header: Int32Array;
  private readonly data: Uint8Array;
  private readonly capacity: number;

  /**
   * @param bufferOrCapacity An existing channel's `sharedBuffer` to attach
   * to (producer side), or a ring capacity in bytes for a new channel
   * (rounded up to a power of two, default 64 KiB).
   */
  constructor(bufferOrCapacity: SharedArrayBuffer | number = 64 * 1024) {
    if (typeof bufferOrCapacity === "number") {
      const capacity = roundUpToPowerOfTwo(Math.max(1, bufferOrCapacity));
      this.sharedBuffer = new SharedArrayBuffer(HEADER_BYTES + capacity);
    } else {
      this.sharedBuffer = bufferOrCapacity;
    }
    this.header = new Int32Array(this.sharedBuffer, 0, 4);
    this.data = new Uint8Array(this.sharedBuffer, HEADER_BYTES);
    this.capacity = this.data.length;
  }

  /** Bytes currently buffered and readable. */
  bytesReadable(): number {
    return (
      (Atomics.load(this.header, HEAD) - Atomics.load(this.header, TAIL)) >>> 0
    );
  }

  /** The producer has closed the channel (end of file once drained). */
  isClosed(): boolean {
    return Atomics.load(this.header, CLOSED) !== 0;
  }

  /**
   * Consume up to `maxBytes` buffered bytes without blocking. Returns an
   * empty array when nothing is buffered.
   */
  consume(maxBytes: number = this.capacity): Uint8Array {
    const available = this.bytesReadable();
    const count = Math.min(available, maxBytes);
    const result = new Uint8Array(count);
    if (count === 0) return result;
    const tail = Atomics.load(this.header, TAIL) >>> 0;
    for (let i = 0; i < count; i++) {
      result[i] = this.data[(tail + i) & (this.capacity - 1)];
    }
    Atomics.store(this.header, TAIL, (tail + count) | 0);
    this.bumpEventSeq();
    return result;
  }

  /**
   * Park the calling thread until input arrives, the producer closes, or
   * `timeoutMilliseconds` elapses (`null` waits indefinitely). Returns
   * immediately if input is already buffered. Falls back to a busy-wait on
   * threads where `Atomics.wait` is not allowed.
   */
  waitForInput(timeoutMilliseconds: number | null): void {
    const deadline =
      timeoutMilliseconds === null
        ? null
        : performance.now() + timeoutMilliseconds;
    while (this.bytesReadable() === 0 && !this.isClosed()) {
      const remaining =
        deadline === null ? Infinity : deadline - performance.now();
      if (remaining <= 0) return;
      // Sample the sequence counter before re-checking state: a push or
      // close between the check and the wait changes the counter, so the
      // wait returns immediately instead of missing the wakeup.
      const seq = Atomics.load(this.header, EVENT_SEQ);
      if (this.bytesReadable() > 0 || this.isClosed()) return;
      try {
        Atomics.wait(this.header, EVENT_SEQ, seq, remaining);
      } catch {
        // Blocking is not allowed on this thread (browser main thread);
        // degrade to a bounded busy-wait re-checking state.
        const spinUntil = Math.min(
          performance.now() + 10,
          deadline === null ? Infinity : deadline,
        );
        while (
          performance.now() < spinUntil &&
          this.bytesReadable() === 0 &&
          !this.isClosed()
        ) {
          // Busy-wait.
        }
      }
    }
  }

  /**
   * Producer side: append bytes, blocking in bounded slices while the ring
   * is full. Throws if the channel is closed.
   */
  push(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.isClosed()) {
        throw new Error("SharedInputChannel is closed");
      }
      const head = Atomics.load(this.header, HEAD) >>> 0;
      const free = this.capacity - this.bytesReadable();
      if (free === 0) {
        const seq = Atomics.load(this.header, EVENT_SEQ);
        if (this.capacity - this.bytesReadable() === 0) {
          try {
            Atomics.wait(this.header, EVENT_SEQ, seq, 50);
          } catch {
            // Busy-loop; the consumer will drain eventually.
          }
        }
        continue;
      }
      const count = Math.min(free, bytes.length - offset);
      for (let i = 0; i < count; i++) {
        this.data[(head + i) & (this.capacity - 1)] = bytes[offset + i];
      }
      Atomics.store(this.header, HEAD, (head + count) | 0);
      this.bumpEventSeq();
      offset += count;
    }
  }

  /** Producer side: signal end of file. Buffered bytes stay readable. */
  close(): void {
    Atomics.store(this.header, CLOSED, 1);
    this.bumpEventSeq();
  }

  /**
   * A non-blocking `stdin` handler for `useStdio`/`useMemoryFS`: drains
   * whatever is buffered. Combined with `fdReadiness()`, the guest blocks in
   * `poll_oneoff` — never in `fd_read`.
   */
  stdin(): () => Uint8Array {
    return () => this.consume();
  }

  /**
   * A readiness provider for `usePoll` reporting this channel's state for
   * `fd` (stdin by default): ready when bytes are buffered, hangup after the
   * producer closes, parked otherwise.
   */
  fdReadiness(fd: number = 0): WASIFdReadiness {
    return {
      read: (subscribedFd: number) => {
        if (subscribedFd !== fd) return null;
        const available = this.bytesReadable();
        if (available > 0) return { ready: true, nbytes: available };
        if (this.isClosed()) return { ready: true, nbytes: 0, hangup: true };
        return { ready: false };
      },
      wait: (timeoutMilliseconds: number | null) =>
        this.waitForInput(timeoutMilliseconds),
    };
  }

  private bumpEventSeq(): void {
    Atomics.add(this.header, EVENT_SEQ, 1);
    Atomics.notify(this.header, EVENT_SEQ);
  }
}
