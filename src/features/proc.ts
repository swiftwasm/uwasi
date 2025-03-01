import { WASIAbi, WASIProcExit } from "../abi";
import { WASIOptions } from "../options";

/**
 * A feature provider that provides `proc_exit` and `proc_raise` by JavaScript's exception.
 */
export function useProc(
  options: WASIOptions,
  abi: WASIAbi,
  memoryView: () => DataView,
): WebAssembly.ModuleImports {
  return {
    proc_exit: (code: number) => {
      throw new WASIProcExit(code);
    },
    proc_raise: (signal: number) => {
      // TODO: Implement
      return WASIAbi.WASI_ESUCCESS;
    },
  };
}
