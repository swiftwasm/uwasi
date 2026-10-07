import { WASIAbi } from "../abi.js";
import { WASIFeatureProvider, WASIOptions } from "../options.js";
import { MemoryFileSystem } from "../filesystem/namespace.js";
import { StdioOptions } from "../filesystem/stdio.js";
import { bindFSSyscalls } from "../filesystem/handlers.js";
import { MemoryFSBackend } from "./backend.js";

/**
 * Creates a feature provider that implements a complete in-memory file system.
 *
 * This provides implementations for all file descriptor and path-related WASI
 * functions, including `fd_read`, `fd_write`, `fd_seek`, `fd_tell`, `fd_close`,
 * `path_open`, and more to support a full featured file system environment.
 *
 * ```js
 * const wasi = new WASI({
 *   features: [useMemoryFS()],
 * });
 * ```
 *
 * You can provide a pre-configured file system instance:
 *
 * ```js
 * const fs = new MemoryFileSystem();
 * fs.addFile("/hello.txt", "Hello, world!");
 *
 * const wasi = new WASI({
 *   features: [useMemoryFS({ withFileSystem: fs })],
 * });
 * ```
 *
 * You can also combine it with standard IO:
 *
 * ```js
 * const wasi = new WASI({
 *   features: [
 *     useMemoryFS({
 *       withStdio: {
 *         stdout: (lines) => document.write(lines),
 *         stderr: (lines) => document.write(lines),
 *       }
 *     })
 *   ],
 * });
 * ```
 *
 * @param useOptions - Configuration options for the memory file system
 * @param useOptions.withFileSystem - Optional pre-configured file system instance
 * @param useOptions.withStdio - Optional standard I/O configuration
 * @returns A WASI feature provider implementing file system functionality
 */
export function useMemoryFS(
  useOptions: {
    withFileSystem?: MemoryFileSystem;
    withStdio?: StdioOptions;
  } = {},
): WASIFeatureProvider {
  return (
    wasiOptions: WASIOptions,
    abi: WASIAbi,
    memoryView: () => DataView,
  ) => {
    const fileSystem =
      useOptions.withFileSystem || new MemoryFileSystem(wasiOptions.preopens);
    return bindFSSyscalls(
      new MemoryFSBackend(),
      fileSystem,
      useOptions.withStdio || {},
      abi,
      memoryView,
    );
  };
}
