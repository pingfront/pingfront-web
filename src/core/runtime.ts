// The environment the core runs in. Everything time-, network- or randomness-dependent goes through it,
// so tests inject fakes (see test/helpers.ts). Globals are read at call time, so fake timers apply.

export interface Runtime {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Undefined where WebSockets are unavailable (the SDK then stays on polling). */
  webSocket(url: string, protocols: string[]): WebSocket | undefined;
  /** Monotonic milliseconds, for token lifetimes and backoff (never the device clock). */
  now(): number;
  /** Wall-clock milliseconds, for timestamps shown to people and 429 countdowns. */
  wall(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
  uuid(): string;
  /** The channel this origin's tabs coordinate on (logout, a new install); undefined where there is none. */
  channel?(name: string): BroadcastChannel | undefined;
}

export const browserRuntime = (): Runtime => ({
  fetch: (input, init) => globalThis.fetch(input, init),
  webSocket: (url, protocols) => (typeof WebSocket === "undefined" ? undefined : new WebSocket(url, protocols)),
  now: () => globalThis.performance.now(),
  wall: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
  uuid: () => globalThis.crypto.randomUUID().toLowerCase(),
  channel: (name) => (typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(name)),
});

/** The cap for queued writes: min(1 s · 2ⁿ, 5 min) (the protocol, Retrying writes). */
export const WRITE_CAP = 300_000;

/** Backoff: min(1 s · 2ⁿ, cap) ±20 % jitter; the cap is 30 s for the live reconnect (the protocol, Live channel), WRITE_CAP for writes. */
export function backoff(attempt: number, random: () => number, base = 1000, cap = 30_000): number {
  const raw = Math.min(base * 2 ** Math.max(0, attempt), cap);
  return Math.round(raw * (0.8 + 0.4 * random()));
}

/** A cancellable pause on the runtime's timers. Resolves false when cancelled. */
export function pause(rt: Runtime, ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const h = rt.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      rt.clearTimeout(h);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
