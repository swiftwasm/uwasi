import { WASIAbi, WASIEvent, WASISubscription } from "../abi.js";
import { WASIFeatureProvider, WASIOptions } from "../options.js";

/**
 * Synchronously block the current thread for the given number of milliseconds.
 *
 * Uses `Atomics.wait` where the host allows blocking (Node.js, worker threads).
 * On hosts that forbid blocking the current thread (e.g. browser main thread),
 * falls back to a busy-wait on `performance.now()`.
 */
function defaultSleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    typeof Atomics !== "undefined"
  ) {
    try {
      const shared = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(shared, 0, 0, milliseconds);
      return;
    } catch {
      // `Atomics.wait` is not allowed on this thread; fall through.
    }
  }
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    // Busy-wait. This is the only remaining way to block on this host.
  }
}

/**
 * Current value of the given WASI clock in nanoseconds, or `null` if the
 * clock is not supported. CPU-time clocks are approximated with the
 * monotonic clock, matching `useClock`'s behavior.
 */
function clockNowNs(clockId: number): bigint | null {
  switch (clockId) {
    case WASIAbi.WASI_CLOCK_MONOTONIC:
    case WASIAbi.WASI_CLOCK_PROCESS_CPUTIME_ID:
    case WASIAbi.WASI_CLOCK_THREAD_CPUTIME_ID:
      return msToNs(performance.now());
    case WASIAbi.WASI_CLOCK_REALTIME:
      return msToNs(Date.now());
    default:
      return null;
  }
}

function msToNs(ms: number): bigint {
  const msInt = Math.trunc(ms);
  const decimal = BigInt(Math.round((ms - msInt) * 1_000_000));
  return BigInt(msInt) * BigInt(1_000_000) + decimal;
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1_000_000;
}

type ClockWait = {
  subscription: WASISubscription & { type: "clock" };
  /** Remaining time in nanoseconds until the subscription's deadline. */
  remainingNs: () => bigint;
};

/**
 * A feature provider that provides `poll_oneoff` and `sched_yield`.
 *
 * Since this runtime is single-threaded and all of its file descriptors are
 * backed by synchronous, non-blocking host calls, `fd_read`/`fd_write`
 * subscriptions are considered immediately ready. Clock subscriptions block
 * the calling thread until the earliest deadline, which is what libc builds
 * on for `nanosleep`, `usleep`, `sem_timedwait`, and friends.
 *
 * ```js
 * const wasi = new WASI({
 *   features: [useStdio(), usePoll()],
 * });
 * ```
 *
 * The blocking strategy can be replaced, e.g. to integrate with a host
 * scheduler or to forbid blocking entirely:
 *
 * ```js
 * const wasi = new WASI({
 *   features: [usePoll({ sleep: (ms) => mySynchronousSleep(ms) })],
 * });
 * ```
 */
export function usePoll(
  useOptions: {
    /**
     * Synchronously block the current thread for the given number of
     * milliseconds. Defaults to `Atomics.wait` where available and a
     * busy-wait otherwise.
     */
    sleep?: (milliseconds: number) => void;
  } = {},
): WASIFeatureProvider {
  return (
    options: WASIOptions,
    abi: WASIAbi,
    memoryView: () => DataView,
  ): WebAssembly.ModuleImports => {
    const sleep = useOptions.sleep || defaultSleep;
    return {
      sched_yield: () => {
        // There is no other thread to yield to.
        return WASIAbi.WASI_ESUCCESS;
      },
      poll_oneoff: (
        subscriptionsPtr: number,
        eventsPtr: number,
        nsubscriptions: number,
        neventsPtr: number,
      ) => {
        if (nsubscriptions === 0) return WASIAbi.WASI_ERRNO_INVAL;
        const view = memoryView();
        const subscriptions = abi.readSubscriptions(
          view,
          subscriptionsPtr,
          nsubscriptions,
        );

        const events: WASIEvent[] = [];
        const clockWaits: ClockWait[] = [];

        for (const subscription of subscriptions) {
          switch (subscription.type) {
            case "fd_read":
              events.push({
                userdata: subscription.userdata,
                error: WASIAbi.WASI_ESUCCESS,
                type: WASIAbi.WASI_EVENTTYPE_FD_READ,
                nbytes: BigInt(1),
              });
              break;
            case "fd_write":
              events.push({
                userdata: subscription.userdata,
                error: WASIAbi.WASI_ESUCCESS,
                type: WASIAbi.WASI_EVENTTYPE_FD_WRITE,
                nbytes: BigInt(65536),
              });
              break;
            case "clock": {
              const now = clockNowNs(subscription.clockId);
              if (now === null) {
                events.push({
                  userdata: subscription.userdata,
                  error: WASIAbi.WASI_ENOSYS,
                  type: WASIAbi.WASI_EVENTTYPE_CLOCK,
                });
                break;
              }
              const isAbsolute =
                (subscription.flags & WASIAbi.WASI_SUBCLOCKFLAGS_ABSTIME) !== 0;
              const deadline = isAbsolute
                ? subscription.timeout
                : now + subscription.timeout;
              clockWaits.push({
                subscription,
                remainingNs: () => {
                  const current = clockNowNs(subscription.clockId);
                  return current === null ? BigInt(0) : deadline - current;
                },
              });
              break;
            }
            case "unknown":
              return WASIAbi.WASI_ERRNO_INVAL;
          }
        }

        const expireElapsedClocks = () => {
          for (let i = clockWaits.length - 1; i >= 0; i--) {
            if (clockWaits[i].remainingNs() <= BigInt(0)) {
              events.push({
                userdata: clockWaits[i].subscription.userdata,
                error: WASIAbi.WASI_ESUCCESS,
                type: WASIAbi.WASI_EVENTTYPE_CLOCK,
              });
              clockWaits.splice(i, 1);
            }
          }
        };

        expireElapsedClocks();

        // Only block when nothing is ready yet. Every wait here has a
        // deadline; an indefinite wait cannot be expressed with clock
        // subscriptions, so this loop always terminates.
        while (events.length === 0 && clockWaits.length > 0) {
          let earliestNs = clockWaits[0].remainingNs();
          for (const wait of clockWaits) {
            const remaining = wait.remainingNs();
            if (remaining < earliestNs) earliestNs = remaining;
          }
          sleep(Math.ceil(nsToMs(earliestNs)));
          expireElapsedClocks();
        }

        for (let i = 0; i < events.length; i++) {
          abi.writeEvent(view, eventsPtr + i * WASIAbi.event_t.size, events[i]);
        }
        view.setUint32(neventsPtr, events.length, true);
        return WASIAbi.WASI_ESUCCESS;
      },
    };
  };
}
