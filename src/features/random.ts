import { WASIAbi } from "../abi";
import { WASIFeatureProvider, WASIOptions } from "../options";

export const defaultRandomFillSync = (buffer: Uint8Array) => {
    const crypto = require('crypto')
    if (crypto && crypto.getRandomValues) {
        crypto.getRandomValues(buffer);
    } else if (globalThis.crypto && (globalThis.crypto as any).randomFillSync) {
        (globalThis.crypto as any).randomFillSync(buffer);
    }
}

/**
 * Create a feature provider that provides `random_get` with `crypto` APIs as backend by default.
 */
export function useRandom(
    useOptions: {
        randomFillSync: (buffer: Uint8Array) => void,
    } = {
        randomFillSync: defaultRandomFillSync,
    }
): WASIFeatureProvider {
    return (options, abi, memoryView) => {
        return {
            random_get: (bufferOffset: number, length: number) => {
                const view = memoryView();

                const buffer = new Uint8Array(view.buffer, bufferOffset, length);
                useOptions.randomFillSync(buffer);

                return WASIAbi.WASI_ESUCCESS;
            },
        }
    }
}
