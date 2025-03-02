import { WASIAbi } from "../abi.js";
import { WASIOptions } from "../options.js";

/**
 * A feature provider that provides `args_get` and `args_sizes_get`
 */
export function useArgs(
  options: WASIOptions,
  abi: WASIAbi,
  memoryView: () => DataView,
): WebAssembly.ModuleImports {
  const args = options.args || [];
  return {
    args_get: (argv: number, argvBuf: number) => {
      let offsetOffset = argv;
      let bufferOffset = argvBuf;
      const view = memoryView();
      for (const arg of args) {
        view.setUint32(offsetOffset, bufferOffset, true);
        offsetOffset += 4;
        bufferOffset += abi.writeString(view, `${arg}\0`, bufferOffset);
      }
      return WASIAbi.WASI_ESUCCESS;
    },
    args_sizes_get: (argc: number, argvBufSize: number) => {
      const view = memoryView();
      view.setUint32(argc, args.length, true);
      const bufferSize = args.reduce(
        (acc, arg) => acc + abi.byteLength(arg) + 1,
        0,
      );
      view.setUint32(argvBufSize, bufferSize, true);
      return WASIAbi.WASI_ESUCCESS;
    },
  };
}
