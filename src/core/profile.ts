// Identity and traits: staged in memory, sent with the session create, or coalesced for 250 ms into one
// PATCH /me with only what changed, and only once a session exists (the protocol, Lifecycle).
import { isObj } from "./decode.js";
import { PingFrontError } from "./api.js";
import { backoff, WRITE_CAP, type Runtime } from "./runtime.js";
import type * as W from "./wire.js";

export type Identity = { userId: string; name?: string; email?: string; token?: string };
export type Traits = Record<string, string>;
/** The person's plan, for apps with web billing (for example Stripe). An `environment` other than "production" marks a test plan. */
export type Entitlement = W.Entitlement;
/** A paywall the team can send as an offer card. */
export type OfferSlot = Omit<W.OfferSlot, "products"> & { products?: W.OfferSlot["products"] };
/** Identity and traits ride on the session create; the plan and the offers only on PATCH /me. */
type Pending = { identity?: Identity; traits?: Traits; entitlement?: Entitlement; offers?: OfferSlot[] };

const COALESCE_MS = 250;

const stripUndefined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** The `sub` of an identity token, read locally (the server verifies the signature). */
export function tokenSubject(token: string): string | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub.length > 0 ? sub : undefined;
  } catch {
    return undefined;
  }
}

export type ProfileHooks = {
  active(): boolean;
  patch(body: Pending): Promise<unknown>;
  identityProblem(problem: string): void;
};

export class Profile {
  #pending: Pending = {};
  #timer: unknown;
  #sending = false;
  #attempts = 0;
  /** After the server refused the identity as another user's, it stays dropped until logout. */
  #refused = false;

  constructor(private readonly rt: Runtime, private readonly hooks: ProfileHooks) {}

  stage(change: Pending): void {
    if (change.identity && !this.#refused) this.#pending.identity = change.identity;
    if (change.traits) this.#pending.traits = { ...this.#pending.traits, ...change.traits };
    if (change.entitlement) this.#pending.entitlement = change.entitlement;
    if (change.offers) this.#pending.offers = change.offers;
    this.#schedule(COALESCE_MS);
  }

  /** What goes into POST /sessions. */
  forSession(): Pick<Pending, "identity" | "traits"> {
    return { identity: this.#pending.identity, traits: this.#pending.traits };
  }

  /** The session create carried everything staged before it. */
  sentWithSession(sent: Pending): void {
    if (sent.identity && this.#pending.identity === sent.identity) delete this.#pending.identity;
    if (sent.traits && this.#pending.traits === sent.traits) delete this.#pending.traits;
  }

  refuseIdentity(problem: string): void {
    this.#refused = true;
    delete this.#pending.identity;
    this.hooks.identityProblem(problem);
  }

  /** Called when a session becomes active: anything staged meanwhile goes out. */
  wake(): void {
    this.#schedule(COALESCE_MS);
  }

  clear(): void {
    this.#pending = {};
    this.#refused = false;
    this.#attempts = 0;
    this.rt.clearTimeout(this.#timer);
  }

  get hasPending(): boolean {
    return Object.values(this.#pending).some((v) => v !== undefined);
  }

  #schedule(ms: number): void {
    if (!this.hooks.active() || !this.hasPending) return;
    this.rt.clearTimeout(this.#timer);
    this.#timer = this.rt.setTimeout(() => void this.flush(), ms);
  }

  async flush(): Promise<void> {
    if (this.#sending || !this.hasPending || !this.hooks.active()) return;
    this.#sending = true;
    const sent = this.#pending;
    this.#pending = {};
    try {
      const res = await this.hooks.patch(sent);
      this.#attempts = 0;
      const rejected = isObj(res) && Array.isArray(res.rejected) ? res.rejected : [];
      for (const r of rejected) {
        if (isObj(r) && r.field === "identity" && r.code === "identity_user_mismatch") this.refuseIdentity("user_mismatch");
      }
      if (isObj(res) && typeof res.identityProblem === "string") this.hooks.identityProblem(res.identityProblem);
    } catch (e) {
      // A 422 lists the fields; anything else is put back and retried with backoff.
      if (!(e instanceof PingFrontError) || e.retryable) {
        // Values staged since win over the ones that failed.
        const traits = { ...sent.traits, ...this.#pending.traits };
        this.#pending = { ...sent, ...stripUndefined(this.#pending), traits: Object.keys(traits).length ? traits : undefined };
        this.#attempts++;
        this.#sending = false;
        this.#schedule(backoff(this.#attempts, this.rt.random, 1000, WRITE_CAP));
        return;
      }
    }
    this.#sending = false;
    if (this.hasPending) this.#schedule(COALESCE_MS);
  }
}
