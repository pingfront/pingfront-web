// The one way to call the API: PF-App-Key, PF-SDK, PF-Protocol, PF-Thread-Rev on /thread routes, scoped
// 429 cooldowns, one refresh and one retry after a 401 `unauthorized` on bearer routes, and the error envelope.
import { SDK_NAME, SDK_VERSION } from "../constants.js";
import { isObj } from "./decode.js";
import { safeCode, type Logger } from "./log.js";
import type { Runtime } from "./runtime.js";

export const PROTOCOL = "1.0.0";
export type RateScope = "messages" | "uploads" | "sessions" | "moments" | "live" | "offers" | (string & {});

export type ErrorKind = "network" | "server" | "cooling_down" | "invalid_key" | "cancelled" | "timeout";

/**
 * Why a message was not delivered, as a key the chat translates (never the error's own text, which is
 * English). "other" is any other refusal (an unknown 4xx such as plan_limit, conflict or not_found).
 */
export type SendFailure = "photo_type" | "photo_open" | "photo_size" | "photo_upload" | "too_long" | "blocked" | "paused" | "verification" | "other";

/** A refusal by the send policy (blocked, paused, sign in): the policy, not the row, says when sending works again. */
export const isPolicyFailure = (f: SendFailure | undefined): boolean => f === "blocked" || f === "paused" || f === "verification";

/**
 * Whether sending the same message again can work, apart from the policy: after a refused upload (its URL may have
 * expired). The same photo, the same text or an unknown refusal fail the same way again.
 */
export const canRetry = (f: SendFailure | undefined): boolean => f === "photo_upload";

/** Every failure the SDK reports. `code` is the server's ErrorCode (open-ended) or the kind. */
export class PingFrontError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly status = 0,
    readonly code: string = kind,
    readonly extra: { scope?: RateScope; retryAfter?: number; fields?: { path: string; message: string }[]; docs?: string; reason?: SendFailure } = {},
  ) {
    super(message);
    this.name = "PingFrontError";
  }
  /** Worth retrying later: offline, timeouts, 5xx, 429. */
  get retryable(): boolean {
    return this.kind === "network" || this.kind === "timeout" || this.kind === "cooling_down" || this.status >= 500 || this.status === 429;
  }
  /** Safe to log: kind, status and code only. */
  get logLine(): string {
    return `${this.kind} ${this.status || "-"} ${safeCode(this.code)}`;
  }
}

export type Auth = "key" | "bearer";
export type Request = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  auth: Auth;
  /** A 429 for this scope pauses only this scope. */
  scope?: RateScope;
  /** Retried once after a dropped connection (the server dedupes it). */
  idempotent?: boolean;
  etag?: string;
  signal?: AbortSignal;
};
export type Reply = { status: number; data: unknown; headers: Headers };

/** Supplies and renews bearer tokens (the session store). */
export interface TokenSource {
  /** Bumped when the person changes (logout, erase, a revoke, another tab): a request never outlives its person. */
  readonly generation: number;
  /** The current token, refreshed when needed; `mayCreate` false never starts a session (only a person's action does). */
  token(reason: undefined, mayCreate: false): Promise<string>;
  /**
   * A refreshed token after a 401 on a bearer route. A refused refresh wipes the install and throws
   * session_revoked: the request is not retried, and the next trigger starts a new session.
   */
  renew(): Promise<string>;
  /** The server refused this token as expired or unknown; the next token() refreshes. */
  invalidate(token: string): void;
  /** 401 session_revoked to a request of `generation`: the install is gone; wipe local state (unless the person changed since). */
  revoked(generation: number): void;
}

const TIMEOUT_MS = 30_000;

export class Api {
  /** thread.rev as last seen, sent as PF-Thread-Rev on /thread routes. */
  rev: number | undefined;
  tokens: TokenSource | undefined;
  /** 409 thread_reset on any thread call but GET /thread itself: the owner drops its cache and reloads. */
  onThreadReset: (() => void) | undefined;
  /** Called on every answer from the service (any status). */
  onAnswer: (() => void) | undefined;
  #cooldowns = new Map<string, number>();

  constructor(
    private readonly baseUrl: string,
    private readonly appKey: string,
    private readonly rt: Runtime,
    private readonly log: Logger,
  ) {}

  url(path: string, query?: Request["query"]): string {
    const q = query ? Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`) : [];
    return `${this.baseUrl.replace(/\/+$/, "")}${path}${q.length ? `?${q.join("&")}` : ""}`;
  }

  /** Seconds left on a scope's cooldown, 0 when free. */
  coolingDown(scope: RateScope): number {
    const until = this.#cooldowns.get(scope) ?? 0;
    return Math.max(0, Math.ceil((until - this.rt.wall()) / 1000));
  }

  async send(req: Request): Promise<Reply> {
    if (req.scope) {
      const wait = this.coolingDown(req.scope);
      if (wait > 0) throw new PingFrontError("cooling_down", `Too many requests. Try again in ${wait} s.`, 429, "rate_limited", { scope: req.scope, retryAfter: wait });
    }
    if (req.auth === "key") return this.#once(req, undefined);
    const tokens = this.tokens;
    if (!tokens) throw cancelled();
    // The person this request is for. Bearer requests never create a session: the person's action that needs one
    // (opening the chat, a send, a moment) gets it first, so background work can't start one (the protocol, Lifecycle).
    const gen = tokens.generation;
    const token = await tokens.token(undefined, false);
    let err: unknown;
    try {
      return await this.#once(req, token);
    } catch (e) {
      err = e;
      if (e instanceof PingFrontError && e.status === 401 && e.code === "unauthorized") {
        tokens.invalidate(token);
        const next = await tokens.renew();
        // Logged out (or another person's session started) during the refresh: never send this as the new person.
        if (tokens.generation !== gen) throw cancelled();
        try {
          return await this.#once(req, next);
        } catch (again) {
          err = again;
        }
      }
    }
    if (err instanceof PingFrontError && err.code === "session_revoked") tokens.revoked(gen);
    throw err;
  }

  async #once(req: Request, token: string | undefined, resend = req.idempotent ?? false): Promise<Reply> {
    const headers: Record<string, string> = { "PF-App-Key": this.appKey, "PF-SDK": `${SDK_NAME}/${SDK_VERSION}`, "PF-Protocol": PROTOCOL };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    if (req.path.startsWith("/thread") && this.rev !== undefined) headers["PF-Thread-Rev"] = String(this.rev);
    if (req.etag) headers["If-None-Match"] = req.etag;
    if (req.signal?.aborted) throw cancelled();
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = this.rt.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.rt.fetch(this.url(req.path, req.query), {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: ctrl.signal,
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      if (req.signal?.aborted) throw cancelled();
      if (resend) return this.#once(req, token, false);
      throw new PingFrontError(ctrl.signal.aborted ? "timeout" : "network", "The API could not be reached.");
    } finally {
      this.rt.clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
    this.onAnswer?.();
    const rev = res.headers.get("PF-Thread-Rev");
    if (rev && /^\d+$/.test(rev)) this.rev = Number(rev);
    this.log.debug(`${req.method} ${routeName(req.path)} ${res.status}`);
    if (res.status === 204 || res.status === 304) return { status: res.status, data: null, headers: res.headers };
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (res.ok) return { status: res.status, data, headers: res.headers };
    if (res.status === 409 && isObj(data) && isObj(data.error) && data.error.code === "thread_reset") {
      // The old revision is dead: the reload goes out without PF-Thread-Rev and adopts the new one.
      this.rev = undefined;
      if (req.path !== "/thread") this.onThreadReset?.();
    }
    throw this.#error(res, data, req.scope);
  }

  #error(res: Response, data: unknown, scope: RateScope | undefined): PingFrontError {
    const e = isObj(data) && isObj(data.error) ? data.error : {};
    const code = typeof e.code === "string" ? e.code : statusCode(res.status);
    const message = typeof e.message === "string" ? e.message : `The API answered ${res.status}.`;
    const retryAfter = typeof e.retryAfter === "number" ? e.retryAfter : Number(res.headers.get("Retry-After")) || undefined;
    const errScope = typeof e.scope === "string" ? e.scope : scope;
    if (res.status === 429 && errScope) this.#cooldowns.set(errScope, this.rt.wall() + (retryAfter ?? 30) * 1000);
    const fields = Array.isArray(e.fields) ? (e.fields as { path: string; message: string }[]) : undefined;
    return new PingFrontError("server", message, res.status, code, { scope: errScope, retryAfter, fields, docs: typeof e.docs === "string" ? e.docs : undefined });
  }

  /** Forget cooldowns and the thread rev (logout, erase). */
  reset(): void {
    this.#cooldowns.clear();
    this.rev = undefined;
  }
}

/** Unknown codes are treated by HTTP status class (the contract's ErrorCode). */
function statusCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 422) return "invalid_request";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

const cancelled = () => new PingFrontError("cancelled", "Cancelled.", 0, "cancelled");

/**
 * The route pattern for logs, never the raw path: every segment after a collection of ids, and every segment that
 * isn't a plain lowercase word (route words are), becomes {id}.
 */
export const routeName = (path: string) => path.replace(/\/[^/]+/g, (seg, at: number) => (/^\/[a-z-]+$/.test(seg) && !/\/(cards|attachments|team-actions|uploads)$/.test(path.slice(0, at)) ? seg : "/{id}"));
