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
 * Snapshot of a file descriptor's readiness, reported without consuming or
 * producing any data.
 */
export interface WASIFdReadinessState {
  ready: boolean;
  /** Bytes readable (fd_read) or writable (fd_write) right now. */
  nbytes?: number;
  /** Peer closed / end of file; delivered as the event's hangup flag. */
  hangup?: boolean;
}

/**
 * Host-side readiness source for `poll_oneoff` fd subscriptions.
 *
 * `read`/`write` return the fd's current state without blocking, or `null`
 * to fall back to the default always-ready treatment for that fd. `wait`
 * parks the calling thread until fd state may have changed or the timeout
 * elapses (`null` means wait indefinitely); `poll_oneoff` re-checks
 * readiness after every wakeup, so spurious wakeups are harmless.
 */
export interface WASIFdReadiness {
  read?(fd: number): WASIFdReadinessState | null;
  write?(fd: number): WASIFdReadinessState | null;
  wait?(timeoutMilliseconds: number | null): void;
}

/**
 * A feature provider that provides `poll_oneoff` and `sched_yield`.
 *
 * Clock subscriptions block the calling thread until the earliest deadline,
 * which is what libc builds on for `nanosleep`, `usleep`, `sem_timedwait`,
 * and friends.
 *
 * Since this runtime is single-threaded and its file descriptors are backed
 * by synchronous host calls, `fd_read`/`fd_write` subscriptions are
 * considered immediately ready by default. Pass `fdReadiness` (for example
 * from {@link SharedInputChannel}) to report genuine readiness instead: the
 * calling thread then parks until data arrives, end of file, or the earliest
 * clock deadline, whichever comes first.
 *
 * ```js
 * const wasi = new WASI({
 *   features: [useStdio(), usePoll()],
 * });
 * ```
 *
 * With genuine stdin readiness fed from another thread:
 *
 * ```js
 * const channel = new SharedInputChannel();
 * // hand channel.sharedBuffer to the producing thread...
 * const wasi = new WASI({
 *   features: [
 *     useStdio({ stdin: channel.stdin() }),
 *     usePoll({ fdReadiness: channel.fdReadiness() }),
 *   ],
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
    /**
     * Genuine fd readiness for `poll_oneoff` subscriptions. Without it,
     * every fd subscription reports ready immediately.
     */
    fdReadiness?: WASIFdReadiness;
  } = {},
): WASIFeatureProvider {
  return (
    options: WASIOptions,
    abi: WASIAbi,
    memoryView: () => DataView,
  ): WebAssembly.ModuleImports => {
    const sleep = useOptions.sleep || defaultSleep;
    const fdReadiness = useOptions.fdReadiness;
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

        const staticEvents: WASIEvent[] = [];
        const fdSubscriptions: (WASISubscription & {
          type: "fd_read" | "fd_write";
        })[] = [];
        const clockWaits: ClockWait[] = [];

        for (const subscription of subscriptions) {
          switch (subscription.type) {
            case "fd_read":
            case "fd_write":
              fdSubscriptions.push(subscription);
              break;
            case "clock": {
              const now = clockNowNs(subscription.clockId);
              if (now === null) {
                staticEvents.push({
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

        const readyFdEvents = (): WASIEvent[] => {
          const events: WASIEvent[] = [];
          for (const subscription of fdSubscriptions) {
            const isRead = subscription.type === "fd_read";
            // Invoke probes as methods so providers may rely on `this`.
            // No provider, or null from the provider, means the default
            // always-ready treatment for this fd.
            const probed = !fdReadiness
              ? null
              : isRead
                ? fdReadiness.read?.(subscription.fd)
                : fdReadiness.write?.(subscription.fd);
            const state = probed || {
              ready: true,
              nbytes: isRead ? 1 : 65536,
            };
            if (!state.ready) continue;
            events.push({
              userdata: subscription.userdata,
              error: WASIAbi.WASI_ESUCCESS,
              type: isRead
                ? WASIAbi.WASI_EVENTTYPE_FD_READ
                : WASIAbi.WASI_EVENTTYPE_FD_WRITE,
              nbytes: BigInt(state.nbytes ?? (isRead ? 1 : 65536)),
              hangup: state.hangup,
            });
          }
          return events;
        };

        const expiredClockEvents = (): WASIEvent[] => {
          const events: WASIEvent[] = [];
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
          return events;
        };

        let events = [
          ...staticEvents,
          ...readyFdEvents(),
          ...expiredClockEvents(),
        ];

        // Only block when nothing is ready yet. Each iteration parks until
        // the earliest clock deadline or, when a readiness provider is
        // present, until it reports fd state may have changed.
        while (events.length === 0) {
          let timeoutMs: number | null = null;
          if (clockWaits.length > 0) {
            let earliestNs = clockWaits[0].remainingNs();
            for (const wait of clockWaits) {
              const remaining = wait.remainingNs();
              if (remaining < earliestNs) earliestNs = remaining;
            }
            timeoutMs = Math.ceil(nsToMs(earliestNs));
          }
          if (fdSubscriptions.length > 0 && fdReadiness?.wait) {
            fdReadiness.wait(timeoutMs);
          } else if (timeoutMs !== null) {
            sleep(timeoutMs);
          } else {
            // Not-ready fd subscriptions, no way to wait for them, and no
            // clock deadline: this wait can never be satisfied. Fail loudly
            // rather than hanging or spinning.
            return WASIAbi.WASI_ERRNO_NOTSUP;
          }
          events = [...readyFdEvents(), ...expiredClockEvents()];
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
