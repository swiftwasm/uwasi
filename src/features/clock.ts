import { WASIAbi } from "../abi";
import { WASIOptions } from "../options";

/**
 * A feature provider that provides `clock_res_get` and `clock_time_get` by JavaScript's Date.
 */
export function useClock(options: WASIOptions, abi: WASIAbi, memoryView: () => DataView): WebAssembly.ModuleImports {
    return {
        clock_res_get: (clockId: number, resolution: number) => {
            // There is no standard way to guarantee monotonicity in JavaScript,
            if (clockId !== WASIAbi.WASI_CLOCK_REALTIME) {
                return WASIAbi.WASI_ENOSYS;
            }
            const view = memoryView();
            view.setBigUint64(resolution, BigInt(1000), true);
            return WASIAbi.WASI_ESUCCESS;
        },
        clock_time_get: (clockId: number, precision: number, time: number) => {
            // There is no standard way to guarantee monotonicity in JavaScript,
            if (clockId !== WASIAbi.WASI_CLOCK_REALTIME) {
                return WASIAbi.WASI_ENOSYS;
            }
            const view = memoryView();
            if (BigInt) {
                const msToNs = (ms: number) => {
                    const msInt = Math.trunc(ms);
                    const decimal = BigInt(Math.round((ms - msInt) * 1_000_000));
                    const ns = BigInt(msInt) * BigInt(1_000_000);
                    return ns + decimal;
                };
                const now = BigInt(msToNs(Date.now()));
                view.setBigUint64(time, now, true);
            } else {
                // Fallback to two 32-bit numbers losing precision
                const now = Date.now() * 1_000_000;
                view.setUint32(time, now & 0x0000ffff, true);
                view.setUint32(time + 4, now & 0xffff0000, true);
            }
            return WASIAbi.WASI_ESUCCESS;
        },
    }
}
