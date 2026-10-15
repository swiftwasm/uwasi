import { useFS, StdioOptions } from "../filesystem/index.js";
import { OPFSBackend } from "./backend.js";
export * from "./backend.js";

/**
 * Creates a feature provider backed by an OPFS store. It serves the same
 * syscalls as `useMemoryFS`, except that hard links and changes to device
 * nodes return `NOTSUP`. Names are durable when a syscall returns; file
 * content is durable after `fd_sync`, `fd_datasync` or `backend.close()`.
 *
 * The backend needs async setup (acquiring OPFS access handles), so it is
 * constructed up front and handed in; preopens are fixed at that point and
 * `WASIOptions.preopens` is ignored by this feature:
 *
 * ```js
 * const backend = await OPFSBackend.create(
 *   await navigator.storage.getDirectory(),
 * );
 * const wasi = new WASI({
 *   features: [useOPFS({ withBackend: backend })],
 * });
 * ```
 *
 * Combine it with standard IO exactly as with `useMemoryFS`:
 *
 * ```js
 * useOPFS({
 *   withBackend: backend,
 *   withStdio: { stdout: (lines) => console.log(lines) },
 * })
 * ```
 *
 * Browser note: OPFS sync access handles only exist in workers, so run the
 * guest (and this feature) in a worker.
 *
 * @param useOptions - Configuration options for the OPFS file system
 * @param useOptions.withBackend - The pre-constructed OPFS backend
 * @param useOptions.withStdio - Optional standard I/O configuration
 * @returns A WASI feature provider implementing file system functionality
 */
export function useOPFS(useOptions: {
  withBackend: OPFSBackend;
  withStdio?: StdioOptions;
}): ReturnType<typeof useFS> {
  return (...args) => {
    const backend = useOptions.withBackend;
    return useFS({
      withBackend: backend,
      withFileSystem: backend.fileSystem,
      withStdio: useOptions.withStdio,
    })(...args);
  };
}
