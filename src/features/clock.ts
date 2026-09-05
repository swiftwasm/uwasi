import { WASIAbi } from "../abi.js";
import { WASIFeatureProvider, WASIOptions } from "../options.js";

/**
 * A feature provider that provides `clock_res_get` and `clock_time_get` by JavaScript's Date.
 */
export function useClock(): WASIFeatureProvider {
  return (
    options: WASIOptions,
    abi: WASIAbi,
    memoryView: () => DataView,
  ): WebAssembly.ModuleImports => {
    return {
      clock_res_get: (clockId: number, resolution: number) => {
        let resolutionValue: number;
        switch (clockId) {
          case WASIAbi.WASI_CLOCK_MONOTONIC:
          case WASIAbi.WASI_CLOCK_PROCESS_CPUTIME_ID:
          case WASIAbi.WASI_CLOCK_THREAD_CPUTIME_ID: {
            // https://developer.mozilla.org/en-US/docs/Web/API/Performance/now
            resolutionValue = 5000;
            break;
          }
          case WASIAbi.WASI_CLOCK_REALTIME: {
            // Date.now() is millisecond-granular.
            resolutionValue = 1_000_000;
            break;
          }
          default:
            return WASIAbi.WASI_ENOSYS;
        }
        const view = memoryView();
        // A u64: writing only the low half leaves the guest's stale upper bytes.
        view.setBigUint64(resolution, BigInt(resolutionValue), true);
        return WASIAbi.WASI_ESUCCESS;
      },
      clock_time_get: (clockId: number, precision: number, time: number) => {
        let nowMs: number = 0;
        switch (clockId) {
          // CPU-time clocks are approximated with the monotonic clock: JS
          // hosts expose no CPU-time source, and on a single-threaded host
          // uptime is the closest observable value. This mirrors wasi-libc's
          // own compatibility strategy after preview2 dropped these clocks
          // (https://github.com/WebAssembly/wasi-clocks).
          case WASIAbi.WASI_CLOCK_MONOTONIC:
          case WASIAbi.WASI_CLOCK_PROCESS_CPUTIME_ID:
          case WASIAbi.WASI_CLOCK_THREAD_CPUTIME_ID: {
            nowMs = performance.now();
            break;
          }
          case WASIAbi.WASI_CLOCK_REALTIME: {
            nowMs = Date.now();
            break;
          }
          default:
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
          const now = BigInt(msToNs(nowMs));
          view.setBigUint64(time, now, true);
        } else {
          // Fallback to two 32-bit numbers losing precision
          const now = Date.now() * 1_000_000;
          view.setUint32(time, now & 0x0000ffff, true);
          view.setUint32(time + 4, now & 0xffff0000, true);
        }
        return WASIAbi.WASI_ESUCCESS;
      },
    };
  };
}
