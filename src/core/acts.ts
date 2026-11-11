// Card action reports (POST /thread/cards/{id}/act), queued and retried safely (the protocol, "Retrying writes").
// Each report has its own clientId, kept with it in the store and sent unchanged on every retry, so the server
// records it once. No answer, 408, 429 and 500/502/503/504 wait and go again (min(1 s·2ⁿ, 5 min), ±20 %, or a
// longer retryAfter); a 401 has already been refreshed once and retried once by the Api; 409 thread_reset retries
// once if the message is still in the reloaded thread; any other 4xx drops the report. A report is dropped after
// 24 h or 10 attempts, and the queue is cleared with the person's other local data.
import { PingFrontError, type Api } from "./api.js";
import { backoff, WRITE_CAP, type Runtime } from "./runtime.js";
import { mergeList, type Store } from "./storage.js";

export type QueuedAct = { cardId: string; body: Record<string, unknown>; at: number; n: number; next: number; reset?: boolean };

const KEY = "acts";
const DAY = 86_400_000;
const RETRY = [408, 429, 500, 502, 503, 504];
const id = (a: QueuedAct) => String(a.body.clientId);

export class Acts {
  #running = false;
  #timer: unknown;
  /** Bumped by clear(): a report in flight then belongs to the previous person and isn't stored again. */
  #gen = 0;
  #items: QueuedAct[] | undefined;
  /** Reports this page settled (sent or dropped): other tabs' copies of the stored queue don't bring them back. */
  #gone = new Set<string>();

  constructor(
    private readonly api: Api,
    private readonly store: () => Promise<Store>,
    private readonly rt: Runtime,
    /** 409 thread_reset: reloads the thread; true when the message is still in it. */
    private readonly reset: (messageId: string) => Promise<boolean>,
  ) {}

  /** The queue, read from the store once; every change is written back. */
  async #list(): Promise<QueuedAct[]> {
    return (this.#items ??= (await (await this.store()).get<QueuedAct[]>(KEY).catch(() => undefined)) ?? []);
  }

  /** Other tabs share the stored queue: their reports stay in it (merged, never overwritten). */
  async #save(): Promise<void> {
    const t = this.rt.wall();
    await mergeList(await this.store(), KEY, this.#items ?? [], id, (a) => !this.#gone.has(id(a)) && t - a.at < DAY && a.n < 10).catch(() => undefined);
  }

  /** Queues a report with a new clientId and sends it. */
  async add(cardId: string, body: Record<string, unknown>): Promise<void> {
    await this.#list();
    this.#items!.push({ cardId, body: { clientId: this.rt.uuid(), ...body }, at: this.rt.wall(), n: 0, next: 0 });
    await this.#save();
    void this.flush();
  }

  /** Sends what is due; `now` makes everything due (back online, back in view), then the backoff goes on. */
  async flush(now = false): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.rt.clearTimeout(this.#timer);
    const gen = this.#gen;
    try {
      for (;;) {
        const t = this.rt.wall();
        const list = (this.#items = (await this.#list()).filter((a) => t - a.at < DAY && a.n < 10));
        if (now) for (const a of list) a.next = 0;
        now = false;
        const a = list.find((x) => x.next <= t);
        if (!a) {
          await this.#save();
          if (list.length) this.#timer = this.rt.setTimeout(() => void this.flush(), Math.min(...list.map((x) => x.next)) - t);
          return;
        }
        let keep = false;
        try {
          await this.api.send({ method: "POST", path: `/thread/cards/${encodeURIComponent(a.cardId)}/act`, auth: "bearer", body: a.body });
        } catch (e) {
          if (!(e instanceof PingFrontError) || e.kind === "cancelled") return;
          if (e.code === "thread_reset") keep = !a.reset && (await this.reset(String(a.body.messageId)));
          else keep = e.kind === "network" || e.kind === "timeout" || RETRY.includes(e.status);
          a.reset ||= e.code === "thread_reset";
          if (keep && e.code !== "thread_reset") a.next = t + Math.max(backoff(a.n, this.rt.random, 1000, WRITE_CAP), (e.extra.retryAfter ?? 0) * 1000);
          a.n++;
        }
        if (gen !== this.#gen) return;
        if (!keep) {
          this.#gone.add(id(a));
          this.#items = this.#items?.filter((x) => x !== a);
        }
        await this.#save();
      }
    } finally {
      this.#running = false;
    }
  }

  /** No more retries from this page (destroy); what is stored goes on the next page. */
  stop(): void {
    this.rt.clearTimeout(this.#timer);
  }

  /**
   * Forgets the queue (logout, erase). `remote`: another tab changed the person, so only this page's memory goes (the
   * stored queue is that tab's) and it is read again when next needed.
   */
  async clear(remote = false): Promise<void> {
    this.stop();
    this.#gen++;
    this.#items = remote ? undefined : [];
    this.#gone.clear();
    if (!remote) await (await this.store()).delete(KEY).catch(() => undefined);
  }
}
