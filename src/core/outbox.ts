// The send queue. Every message gets its clientId at the tap and keeps it through every retry, so the
// server answers a repeat with the original (idempotent). Items are delivered in tap order, persisted
// (with their photos, in IndexedDB) so a reload loses nothing, and drained only once a session is needed.
import type { ReplyToCard } from "./wire.js";
import { PingFrontError, type SendFailure } from "./api.js";
import { backoff, pause, WRITE_CAP, type Runtime } from "./runtime.js";
import { mergeList, type Store } from "./storage.js";

export type PreparedPhoto = {
  requestId: string;
  blob: Blob;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  attachmentId?: string;
};

export type OutboxItem = {
  clientId: string;
  text?: string;
  photos: PreparedPhoto[];
  /** Picked files not yet prepared (decoded, scaled, hashed); prepared on the first delivery attempt. */
  files?: Blob[];
  replyToCard?: ReplyToCard;
  createdAt: string;
  state: "queued" | "sending" | "failed";
  /** Why a failed item was not delivered, as a key the chat translates (an older page may have saved words: shown as "other"). */
  failure?: SendFailure;
  /**
   * Refused while sending was closed for a reason that ends by itself (the app paused, a sign-in required): it goes
   * again, first, when sending reopens, and nothing behind it goes before it. A blocked person's message is never held.
   */
  held?: HoldReason;
  attempts: number;
  /** Sent again once already after a 409 thread_reset: another one fails it (the protocol, Retrying writes). */
  reset?: boolean;
};

export type HoldReason = "app_paused" | "verification_required";

/** The outcome of one delivery attempt. */
export type Delivery = { ok: true; message: unknown } | { ok: false; error: PingFrontError };

const KEY = "outbox";

/** The reason a permanent error gives a person, from its code: never its message, which is English. */
function sendFailure(err: PingFrontError, item: OutboxItem): SendFailure {
  if (err.extra.reason) return err.extra.reason;
  if (err.code === "too_large") return item.photos.length || item.files?.length ? "photo_size" : "too_long";
  if (err.code === "blocked") return "blocked";
  if (err.code === "app_paused") return "paused";
  if (err.code === "verification_required") return "verification";
  return "other";
}

export class Outbox {
  items: OutboxItem[] = [];
  private loaded = false;
  private draining = false;
  private wake: AbortController | undefined;
  private stopped = new AbortController();
  /** What this page sent or deleted: other tabs' copies of the stored queue don't bring it back. */
  private gone = new Set<string>();

  constructor(
    private readonly store: () => Promise<Store>,
    private readonly rt: Runtime,
    private readonly changed: () => void,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const s = await this.store();
    const saved = s.kind === "indexeddb" ? await s.get<OutboxItem[]>(KEY).catch(() => undefined) : undefined;
    if (Array.isArray(saved)) {
      // An item that was mid-flight when the page closed is queued again (same clientId).
      const known = new Set(this.items.map((i) => i.clientId));
      this.items.push(...saved.filter((i) => !known.has(i.clientId)).map((i) => ({ ...i, state: i.state === "sending" ? ("queued" as const) : i.state })));
      this.changed();
    }
  }

  /** Other tabs share the stored queue: their items stay in it (merged, never overwritten). */
  private async persist(): Promise<void> {
    const s = await this.store();
    if (s.kind !== "indexeddb") return;
    await mergeList(s, KEY, this.items, (i) => i.clientId, (i) => !this.gone.has(i.clientId)).catch(() => undefined);
  }

  enqueue(item: OutboxItem): void {
    this.items.push(item);
    this.changed();
    void this.persist();
    this.poke();
  }

  retry(clientId: string): void {
    const i = this.items.find((x) => x.clientId === clientId);
    if (!i || i.state !== "failed") return;
    i.attempts = 0;
    this.requeue(i);
    this.saved();
  }

  private requeue(i: OutboxItem): void {
    i.state = "queued";
    delete i.failure;
    delete i.held;
  }

  private saved(): void {
    this.changed();
    void this.persist();
    this.poke();
  }

  /** Queues again the items a closed policy held (only those held for `reason`, when given); true when there were any. */
  retryHeld(reason?: HoldReason): boolean {
    const held = this.items.filter((i) => i.held && (!reason || i.held === reason));
    for (const i of held) this.requeue(i);
    if (held.length) this.saved();
    return held.length > 0;
  }

  /** The person is blocked: held items stop waiting and become plain failures, so nothing waits behind them. */
  releaseHeld(): void {
    const held = this.items.filter((i) => i.held);
    for (const i of held) delete i.held;
    if (held.length) this.saved();
  }

  discard(clientId: string): void {
    this.gone.add(clientId);
    this.items = this.items.filter((x) => x.clientId !== clientId);
    this.changed();
    void this.persist();
  }

  /** Ends any wait so the drain runs now (a send, coming online, a retry). */
  poke(): void {
    this.wake?.abort();
  }

  /** Stop draining; what is queued stays persisted for the next page (destroy). */
  stop(): void {
    this.stopped.abort();
    this.stopped = new AbortController();
    this.draining = false;
  }

  /**
   * Stop draining and forget everything (logout, erase). `remote`: another tab changed the person, so only this page's
   * memory goes (the stored queue is that tab's), and the queue is read again when next needed.
   */
  async clear(remote = false): Promise<void> {
    this.stop();
    this.items = [];
    this.gone.clear();
    if (remote) this.loaded = false;
    this.changed();
    const s = await this.store();
    if (!remote && s.kind === "indexeddb") await s.delete(KEY).catch(() => undefined);
  }

  /**
   * Delivers queued items in order until none are left, and is the only place that decides what goes next. A
   * retryable failure waits with backoff and keeps order (later items wait too); a held item stops the drain (nothing
   * behind it goes before it); a plain failure waits for the person (Try again or Delete) and moves on.
   */
  async drain(deliver: (item: OutboxItem, signal: AbortSignal) => Promise<Delivery>, onSent: (item: OutboxItem, message: unknown) => void): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const stop = this.stopped.signal;
    // Items held back by the photo upload cooldown, and how long it runs: text behind them still goes (as on iOS).
    const cooling = new Set<OutboxItem>();
    let heldWait = 0;
    const waitFor = async (ms: number) => {
      this.wake = new AbortController();
      const both = AbortSignal.any ? AbortSignal.any([this.wake.signal, stop]) : this.wake.signal;
      await pause(this.rt, ms, both);
    };
    try {
      for (;;) {
        if (stop.aborted) return;
        let item: OutboxItem | undefined;
        for (const i of this.items) {
          if (i.held) return;
          if (i.state === "queued" && !cooling.has(i)) {
            item = i;
            break;
          }
        }
        if (!item) {
          if (!cooling.size) return;
          await waitFor(heldWait);
          cooling.clear();
          heldWait = 0;
          continue;
        }
        item.state = "sending";
        this.changed();
        const result = await deliver(item, stop);
        if (stop.aborted) return;
        if (result.ok) {
          this.gone.add(item.clientId);
          this.items = this.items.filter((i) => i !== item);
          this.changed();
          void this.persist();
          onSent(item, result.message);
          continue;
        }
        const err = result.error;
        if (err.code === "cancelled") {
          item.state = "queued";
          this.changed();
          return;
        }
        if (err.retryable) {
          item.state = "queued";
          item.attempts++;
          this.changed();
          void this.persist();
          const wait = err.extra.retryAfter ? err.extra.retryAfter * 1000 : backoff(item.attempts - 1, this.rt.random, 1000, WRITE_CAP);
          if (err.extra.scope === "uploads") {
            cooling.add(item);
            heldWait = Math.max(heldWait, wait);
            continue;
          }
          await waitFor(wait);
          continue;
        }
        item.state = "failed";
        item.failure = sendFailure(err, item);
        const code = err.code;
        // The person can't send now: every later item would be refused too. A pause or a sign-in holds this one (it
        // goes by itself, first, when sending reopens); blocked promises nothing, so it and those queued behind it fail.
        if (code === "app_paused" || code === "verification_required") item.held = code;
        else if (code === "blocked") for (const i of this.items) if (i.state === "queued") Object.assign(i, { state: "failed", failure: "blocked" });
        this.changed();
        void this.persist();
        if (code === "blocked" || item.held) return;
      }
    } finally {
      if (stop === this.stopped.signal) this.draining = false;
    }
  }
}
