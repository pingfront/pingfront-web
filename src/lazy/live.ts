// The live socket (GET /v1/live): subprotocols `pingfront.v1, bearer.<token>`, a client ping every 30 s,
// a silence deadline for half-open sockets, and reconnects with min(1 s · 2ⁿ, 30 s) ±20 % backoff forever
// while it is wanted. A run generation makes everything from a stopped run inert.
// Only an open chat uses it, so it is a lazy module (core/modules.ts): core/live.ts stands in for it until it loads.
import { decodeServerEvent } from "../core/decode.js";
import type { Logger } from "../core/log.js";
import type { ServerEvent } from "../core/model.js";
import { backoff, type Runtime } from "../core/runtime.js";

export const SUBPROTOCOL = "pingfront.v1";
const PING_MS = 30_000;
/** No frame (not even the server's) for this long: the socket is dead. */
const SILENCE_MS = 75_000;
const TYPING_MIN_MS = 3_000;

export type LiveHooks = {
  url(): string;
  token(): Promise<string>;
  /** The token in use was refused (4001 after reauth); the next token() must be fresh. */
  expired(token: string): void;
  event(e: ServerEvent, raw: unknown): void;
  /** 4000 after reset: drop the cache and reload. */
  reset(): void;
  /** 4004: the person was erased. */
  erased(): void;
  state(s: "connecting" | "open" | "closed"): void;
};

export class Socket {
  #ws: WebSocket | undefined;
  #run = 0;
  #attempt = 0;
  #timers: unknown[] = [];
  #lastFrame = 0;
  #token = "";
  #typingOn = false;
  #typingAt = -Infinity;

  constructor(
    private readonly rt: Runtime,
    private readonly hooks: LiveHooks,
    private readonly log: Logger,
  ) {}

  get running(): boolean {
    return this.#run % 2 === 1;
  }

  start(): void {
    if (this.running) return;
    this.#run++;
    this.#attempt = 0;
    void this.#connect(this.#run);
  }

  stop(): void {
    if (!this.running) return;
    this.#run++;
    this.#clearTimers();
    const ws = this.#ws;
    this.#ws = undefined;
    if (ws && ws.readyState <= 1) ws.close(1000);
    this.hooks.state("closed");
  }

  /** Typing on and off: a start at most every 3 s while on (repeated starts keep the dashboard's dots alive), a stop at once. */
  typing(on: boolean): void {
    const now = this.rt.now();
    if (on === this.#typingOn && (!on || now - this.#typingAt < TYPING_MIN_MS)) return;
    this.#typingOn = on;
    this.#typingAt = now;
    this.#sendFrame({ type: "typing", on });
  }

  #sendFrame(frame: unknown): void {
    if (this.#ws?.readyState === 1) this.#ws.send(JSON.stringify(frame));
  }

  #clearTimers(): void {
    for (const t of this.#timers) this.rt.clearTimeout(t);
    this.#timers = [];
  }

  #later(fn: () => void, ms: number): void {
    this.#timers.push(this.rt.setTimeout(fn, ms));
  }

  async #connect(run: number): Promise<void> {
    if (run !== this.#run) return;
    this.hooks.state("connecting");
    let token: string;
    try {
      token = await this.hooks.token();
    } catch {
      return this.#retry(run);
    }
    if (run !== this.#run) return;
    this.#token = token;
    const ws = this.rt.webSocket(this.hooks.url(), [SUBPROTOCOL, `bearer.${token}`]);
    if (!ws) {
      this.log.info("No WebSocket: replies arrive on reload.");
      return;
    }
    this.#ws = ws;
    this.#lastFrame = this.rt.now();
    ws.onopen = () => {
      if (run !== this.#run) return;
      this.hooks.state("open");
      this.#typingOn = false;
      this.#heartbeat(run);
    };
    ws.onmessage = (m) => {
      if (run !== this.#run) return;
      this.#lastFrame = this.rt.now();
      let raw: unknown;
      try {
        raw = JSON.parse(typeof m.data === "string" ? m.data : "");
      } catch {
        return;
      }
      const e = decodeServerEvent(raw);
      if (e.type === "hello") this.#attempt = 0;
      this.hooks.event(e, raw);
    };
    ws.onclose = (c) => {
      if (run !== this.#run || this.#ws !== ws) return;
      this.#ws = undefined;
      this.#clearTimers();
      this.hooks.state("closed");
      this.log.debug(`Live closed ${c.code}.`);
      if (c.code === 4004) {
        this.stop();
        this.hooks.erased();
        return;
      }
      if (c.code === 4001) this.hooks.expired(this.#token);
      if (c.code === 4000) this.hooks.reset();
      this.#retry(run);
    };
    ws.onerror = () => undefined;
  }

  #heartbeat(run: number): void {
    this.#later(() => {
      if (run !== this.#run || !this.#ws) return;
      if (this.rt.now() - this.#lastFrame > SILENCE_MS) {
        // Half-open: no frame for too long. Close and reconnect.
        const ws = this.#ws;
        this.#ws = undefined;
        ws.close(4100);
        this.hooks.state("closed");
        this.#retry(run);
        return;
      }
      this.#sendFrame({ type: "ping" });
      this.#heartbeat(run);
    }, PING_MS);
  }

  #retry(run: number): void {
    if (run !== this.#run) return;
    const wait = backoff(this.#attempt++, this.rt.random);
    this.#later(() => void this.#connect(run), wait);
  }
}
