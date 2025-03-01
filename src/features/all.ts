import { WASIAbi } from "../abi";
import { WASIFeatureProvider, WASIOptions } from "../options";
import { useArgs } from "./args";
import { useClock } from "./clock";
import { useEnviron } from "./environ";
import { useFS, useStdio } from "./fd";
import { useProc } from "./proc";
import { useRandom } from "./random";

type Options = (Parameters<typeof useFS>[0] | Parameters<typeof useStdio>[0]) &
  Parameters<typeof useRandom>[0];

export function useAll(useOptions: Options = {}): WASIFeatureProvider {
  return (options: WASIOptions, abi: WASIAbi, memoryView: () => DataView) => {
    const features = [
      useEnviron,
      useArgs,
      useClock,
      useProc,
      useRandom(useOptions),
    ];
    if ("fs" in useOptions) {
      features.push(useFS({ fs: useOptions.fs }));
    } else {
      features.push(useStdio(useOptions));
    }
    return features.reduce((acc, fn) => {
      return { ...acc, ...fn(options, abi, memoryView) };
    }, {});
  };
}
