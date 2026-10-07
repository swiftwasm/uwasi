import { WASIAbi } from "../abi.js";
import { WASIFeatureProvider } from "../options.js";
import { FSBackend } from "./backend.js";
import { bindFSSyscalls } from "./handlers.js";
import { MemoryFileSystem } from "./namespace.js";
import { StdioOptions } from "./stdio.js";

export { FSBackend } from "./backend.js";
export { FSError } from "./error.js";
export {
  DirectoryNode,
  FileNode,
  FSNode,
  SymlinkNode,
  MemoryFileSystem,
} from "./namespace.js";
export { CharacterDeviceHandler, StdioOptions } from "./stdio.js";
export { MemoryFSBackend } from "../memory/backend.js";

/** WASI errno values that a backend can throw in an `FSError`. */
export const FSErrno = {
  IO: WASIAbi.WASI_ERRNO_IO,
  NOSPC: WASIAbi.WASI_ERRNO_NOSPC,
  NOTSUP: WASIAbi.WASI_ERRNO_NOTSUP,
  INVAL: WASIAbi.WASI_ERRNO_INVAL,
  FBIG: WASIAbi.WASI_ERRNO_FBIG,
} as const;

/**
 * Creates a feature provider that implements the filesystem syscalls over
 * `withBackend`, a storage backend, and `withFileSystem`, its namespace.
 *
 * The namespace supplies the node tree and the preopened directories;
 * `WASIOptions.preopens` is not used. Finish any asynchronous setup of the
 * backend before the guest starts.
 *
 * ```js
 * const wasi = new WASI({
 *   features: [
 *     useFS({
 *       withBackend: backend,
 *       withFileSystem: fileSystem,
 *       withStdio: { stdout: (lines) => console.log(lines) },
 *     }),
 *   ],
 * });
 * ```
 */
export function useFS(useOptions: {
  withBackend: FSBackend;
  withFileSystem: MemoryFileSystem;
  withStdio?: StdioOptions;
}): WASIFeatureProvider {
  return (_options, abi, memoryView) =>
    bindFSSyscalls(
      useOptions.withBackend,
      useOptions.withFileSystem,
      useOptions.withStdio || {},
      abi,
      memoryView,
    );
}
