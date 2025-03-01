import { WASIAbi } from "../abi";
import { WASIOptions } from "../options";

/**
 * A feature provider that provides `environ_get` and `environ_sizes_get`
 */
export function useEnviron(
  options: WASIOptions,
  abi: WASIAbi,
  memoryView: () => DataView,
): WebAssembly.ModuleImports {
  return {
    environ_get: (environ: number, environBuf: number) => {
      let offsetOffset = environ;
      let bufferOffset = environBuf;
      const view = memoryView();
      for (const key in options.env) {
        const value = options.env[key];
        view.setUint32(offsetOffset, bufferOffset, true);
        offsetOffset += 4;
        bufferOffset += abi.writeString(
          view,
          `${key}=${value}\0`,
          bufferOffset,
        );
      }
      return WASIAbi.WASI_ESUCCESS;
    },
    environ_sizes_get: (environ: number, environBufSize: number) => {
      const view = memoryView();
      view.setUint32(environ, Object.keys(options.env || {}).length, true);
      view.setUint32(
        environBufSize,
        Object.entries(options.env || {}).reduce((acc, [key, value]) => {
          return (
            acc +
            abi.byteLength(key) /* = */ +
            1 +
            abi.byteLength(value) /* \0 */ +
            1
          );
        }, 0),
        true,
      );
      return WASIAbi.WASI_ESUCCESS;
    },
  };
}
