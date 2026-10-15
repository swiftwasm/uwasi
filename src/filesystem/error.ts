/**
 * A storage failure. The filesystem syscalls return its `errno` to the
 * guest. Any other exception from a backend is a bug, and propagates.
 */
export class FSError extends Error {
  constructor(
    public readonly errno: number,
    public readonly cause?: unknown,
  ) {
    super(`Filesystem error: ${errno}`);
    this.name = "FSError";
  }
}
