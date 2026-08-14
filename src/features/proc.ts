import { WASIAbi, WASIProcExit } from "../abi.js";
import { WASIOptions } from "../options.js";

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
      // There is no signal handling machinery on this host; treat every
      // raised signal as fatal rather than silently continuing. The exit
      // code follows the POSIX shell convention of 128 + signal number.
      throw new WASIProcExit(128 + signal);
    },
  };
}
