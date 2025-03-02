import { WASIAbi } from "../abi.js";
import { WASIFeatureProvider } from "../options.js";
import { defaultRandomFillSync } from "../platforms/crypto.js";

/**
 * Create a feature provider that provides `random_get` with `crypto` APIs as backend by default.
 */
export function useRandom(
  useOptions: {
    randomFillSync?: (buffer: Uint8Array) => void;
  } = {},
): WASIFeatureProvider {
  const randomFillSync = useOptions.randomFillSync || defaultRandomFillSync;
  return (options, abi, memoryView) => {
    return {
      random_get: (bufferOffset: number, length: number) => {
        const view = memoryView();

        const buffer = new Uint8Array(view.buffer, bufferOffset, length);
        randomFillSync(buffer);

        return WASIAbi.WASI_ESUCCESS;
      },
    };
  };
}
