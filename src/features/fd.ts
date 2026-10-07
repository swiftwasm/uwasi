import { WASIAbi } from "../abi.js";
import { WASIFeatureProvider, WASIOptions } from "../options.js";

export {
  ReadableTextProxy,
  lineBuffered,
  useStdio,
  StdioOptions,
  CharacterDeviceHandler,
} from "../filesystem/stdio.js";
export { MemoryFileSystem } from "../filesystem/namespace.js";
export { useMemoryFS } from "../memory/index.js";

export function useFS(useOptions: { fs: any }): WASIFeatureProvider {
  return (options: WASIOptions, abi: WASIAbi, memoryView: () => DataView) => {
    // TODO: implement fd_* syscalls using `useOptions.fs`
    return {};
  };
}
