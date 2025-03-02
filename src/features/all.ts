import { WASIAbi } from "../abi.js";
import { WASIFeatureProvider, WASIOptions } from "../options.js";
import { useArgs } from "./args.js";
import { useClock } from "./clock.js";
import { useEnviron } from "./environ.js";
import { useMemoryFS } from "./fd.js";
import { useProc } from "./proc.js";
import { useRandom } from "./random.js";

type Options = Parameters<typeof useMemoryFS>[0] &
  Parameters<typeof useRandom>[0];

export function useAll(useOptions: Options = {}): WASIFeatureProvider {
  return (options: WASIOptions, abi: WASIAbi, memoryView: () => DataView) => {
    const features = [
      useMemoryFS(useOptions),
      useEnviron,
      useArgs,
      useClock,
      useProc,
      useRandom(useOptions),
    ];
    return features.reduce((acc, fn) => {
      return { ...acc, ...fn(options, abi, memoryView) };
    }, {});
  };
}
