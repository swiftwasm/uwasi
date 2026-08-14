import { WASIAbi } from "../abi.js";
import { WASIFeatureProvider } from "../options.js";

/**
 * Create a feature provider that provides `random_get` with `crypto` APIs as backend by default.
 */
export function useRandom(
  useOptions: {
    randomFillSync?: (buffer: Uint8Array) => void;
  } = {},
): WASIFeatureProvider {
  // Keep `crypto` as the receiver: an unbound `getRandomValues` reference
  // throws `ERR_INVALID_THIS` when called. Fill in chunks because
  // `getRandomValues` rejects requests larger than 65536 bytes.
  const randomFillSync =
    useOptions.randomFillSync ||
    ((buffer: Uint8Array) => {
      for (let offset = 0; offset < buffer.length; offset += 65536) {
        crypto.getRandomValues(buffer.subarray(offset, offset + 65536));
      }
    });
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
