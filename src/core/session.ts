// The session: lazy (nothing until token() is first called), single-flight create or refresh, the install
// secret in storage and the access token in memory only. A generation, bumped by wipe() and by a revoke, drops any
// answer that arrives after the person changed (logout, erase, a revoked install, another tab's new install).
import { crc32 } from "./keys.js";
import type { AppScreen } from "./wire.js";
import { Api, PingFrontError, type TokenSource } from "./api.js";
import { decodePerson, isObj } from "./decode.js";
import { deviceFacts, type AppFacts } from "./device.js";
import type { Logger } from "./log.js";
import type { PersonSummary } from "./model.js";
import type { Profile } from "./profile.js";
import { backoff, WRITE_CAP, type Runtime } from "./runtime.js";
import type { Store } from "./storage.js";

export type Creds = { installId: string; installSecret: string };
export type SessionReason = "chat_opened" | "moment" | "prepare" | "push_opened" | "report";

export type SessionInfo = { person?: PersonSummary; testDevice: boolean; storeAccountToken?: string };

export type SessionHooks = {
  started(info: SessionInfo): void;
  identityProblem(problem: string): void;
  /** The install is unknown or revoked: drop the old person's local state. */
  revoked(): void;
  /** A new install was saved (other tabs hear of it). */
  saved(installId: string): void;
};

const changed = () => new PingFrontError("cancelled", "The session changed.", 0, "cancelled");

/** Refresh a little before the server's expiry, measured on the monotonic clock. */
const EARLY_MS = 60_000;

export class Session implements TokenSource {
  generation = 0;
  /** True once a session exists in this page (created or refreshed). */
  active = false;
  /** Erase in progress: no request may create the person again. */
  erasing = false;
  info: SessionInfo = { testDevice: false };
  #creds: Creds | null | undefined;
  #access: { token: string; expires: number } | undefined;
  #inflight: { p: Promise<string>; create: boolean } | undefined;
  #reason: SessionReason = "chat_opened";
  /** The app's screens (registerScreens), once it registered any. App metadata, not person data. */
  screens: AppScreen[] | undefined;

  constructor(
    private readonly api: Api,
    private readonly store: () => Promise<Store>,
    private readonly rt: Runtime,
    private readonly profile: Profile,
    private readonly app: AppFacts,
    private readonly hooks: SessionHooks,
    private readonly log: Logger,
  ) {}

  async credentials(): Promise<Creds | null> {
    if (this.#creds === undefined) {
      const saved = await (await this.store()).get<Creds>("creds").catch(() => undefined);
      this.#creds = saved && typeof saved.installId === "string" && typeof saved.installSecret === "string" ? saved : null;
    }
    return this.#creds;
  }

  /** The install this page uses, once read. */
  get installId(): string | undefined {
    return this.#creds?.installId;
  }

  /**
   * A token, single-flight. `reason` is what the next session create carries (the first thing that needed one);
   * `mayCreate` false only refreshes an existing install, for anything that isn't a person's action.
   */
  token(reason?: SessionReason, mayCreate = true): Promise<string> {
    if (reason) this.#reason = reason;
    if (this.erasing) return Promise.reject(new PingFrontError("cancelled", "The data is being erased.", 0, "cancelled"));
    if (this.#access && this.rt.now() < this.#access.expires) return Promise.resolve(this.#access.token);
    const running = this.#inflight;
    // A person's action that finds a refresh-only attempt running starts a session if that attempt can't.
    if (running) return mayCreate && !running.create ? running.p.catch(() => this.token(reason, true)) : running.p;
    const p: Promise<string> = this.#obtain(this.generation, mayCreate).finally(() => {
      if (this.#inflight?.p === p) this.#inflight = undefined;
    });
    this.#inflight = { p, create: mayCreate };
    return p;
  }

  /** After a 401: refresh, but never create a new install in the middle of the old one's request. */
  renew(): Promise<string> {
    return this.token(undefined, false);
  }

  invalidate(token: string): void {
    if (this.#access?.token === token) this.#access = undefined;
  }

  revoked(gen: number): void {
    void this.#revoke(gen, this.#creds);
  }

  /**
   * The server refused the install `refused` to a request of generation `gen`. Nothing happens if the person changed
   * since (logout, another tab): that answer is about an install this page no longer uses. Otherwise the generation
   * moves on (the old person's answers in flight are dropped), the stored install goes unless another tab replaced it,
   * and the old person's local state goes. True when it was revoked here.
   */
  async #revoke(gen: number, refused: Creds | null | undefined): Promise<boolean> {
    if (gen !== this.generation) return false;
    const mine = ++this.generation;
    this.#access = undefined;
    this.active = false;
    if (refused) await this.#forget(refused);
    if (mine !== this.generation) return false;
    this.hooks.revoked();
    return true;
  }

  /** Forgets `c` here, and in storage only if it is still the stored install (another tab may have saved a newer one). */
  async #forget(c: Creds): Promise<void> {
    if (this.#creds?.installId === c.installId) this.#creds = null;
    try {
      await (await this.store()).update<Creds>("creds", (saved) => (saved?.installId === c.installId ? undefined : saved));
    } catch {
      // Not stored: nothing to forget.
    }
  }

  /**
   * Logout and erase: forget everything; answers still in flight are dropped. `remote`: another tab logged out or
   * saved another install, so only this page's memory goes and the install is read from storage again.
   */
  async wipe(remote = false): Promise<void> {
    const had = this.#creds;
    this.generation++;
    this.#access = undefined;
    this.#inflight = undefined;
    this.active = false;
    this.info = { testDevice: false };
    this.#creds = remote ? undefined : null;
    if (!remote && had) await this.#forget(had);
  }

  async #saveCreds(c: Creds): Promise<void> {
    this.#creds = c;
    try {
      await (await this.store()).set("creds", c);
    } catch {
      this.log.error("Install not saved: it ends with the page.");
    }
  }

  #check(gen: number): void {
    if (gen !== this.generation) throw changed();
  }

  async #obtain(gen: number, mayCreate: boolean): Promise<string> {
    const creds = await this.credentials();
    this.#check(gen);
    if (creds) {
      try {
        return await this.#refresh(creds, gen);
      } catch (e) {
        if (!(e instanceof PingFrontError) || e.status !== 401) throw e;
        // Unknown or revoked install: the old person's local state goes, and a new guest starts. If the person changed
        // while the refresh was out (logout, then open), the refusal is the old install's: nothing here changes.
        if (!(await this.#revoke(gen, creds))) throw changed();
        this.log.info("Saved install invalid: starting a new one.");
        if (!mayCreate) throw new PingFrontError("server", "Session revoked: a new one starts on next use.", 401, "session_revoked");
        return this.#create(this.generation, true);
      }
    }
    // Not a person's action: nothing to refresh, and nothing may start a session.
    if (!mayCreate) throw new PingFrontError("cancelled", "No session yet.", 0, "cancelled");
    return this.#create(gen, true);
  }

  /**
   * `device.app` with the screens, when the app registered some and they (or the app version) changed since they
   * were last sent, or `always`; with the hash to keep once they were sent (the protocol, Saved links). Every
   * install starts with a create, which always sends them, so the hash is always the current install's.
   */
  async withScreens(always?: boolean): Promise<[app: object, sent: () => Promise<unknown>] | undefined> {
    if (!this.screens) return undefined;
    const app = { ...deviceFacts("", this.app).app, screens: this.screens };
    const hash = crc32(JSON.stringify(app));
    const store = await this.store();
    if (always || (await store.get("screens").catch(() => 0)) !== hash) return [app, () => store.set("screens", hash).catch(() => 0)];
    return undefined;
  }

  async #refresh(creds: Creds, gen: number): Promise<string> {
    const { installId: _ignored, platform: _p, ...device } = deviceFacts(creds.installId, this.app);
    const s = await this.withScreens();
    const res = await this.api.send({ method: "POST", path: "/sessions/refresh", auth: "key", scope: "sessions", idempotent: true, body: { ...creds, device: s ? { ...device, app: s[0] } : device } });
    this.#check(gen);
    await s?.[1]();
    return this.#adopt(res.data, creds);
  }

  async #create(gen: number, withIdentity: boolean): Promise<string> {
    const staged = this.profile.forSession();
    const device = deviceFacts(this.rt.uuid(), this.app);
    const s = await this.withScreens(true);
    const body: Record<string, unknown> = { device: s ? { ...device, app: s[0] } : device, reason: this.#reason };
    if (withIdentity && staged.identity) body.identity = staged.identity;
    if (staged.traits) body.traits = staged.traits;
    let res;
    try {
      res = await this.api.send({ method: "POST", path: "/sessions", auth: "key", scope: "sessions", body });
    } catch (e) {
      if (withIdentity && e instanceof PingFrontError && e.code === "identity_user_mismatch") {
        this.profile.refuseIdentity("user_mismatch");
        this.#check(gen);
        return this.#create(gen, false);
      }
      throw e;
    }
    this.#check(gen);
    const d = isObj(res.data) ? res.data : {};
    if (typeof d.installId !== "string" || typeof d.installSecret !== "string") throw new PingFrontError("server", "The session answer was incomplete.", res.status, "unavailable");
    await this.#saveCreds({ installId: d.installId, installSecret: d.installSecret });
    await s?.[1]();
    this.#check(gen);
    this.hooks.saved(d.installId);
    this.profile.sentWithSession({ identity: withIdentity ? staged.identity : undefined, traits: staged.traits });
    return this.#adopt(d, null);
  }

  #adopt(data: unknown, refreshed: Creds | null): string {
    const d = isObj(data) ? data : {};
    const token = typeof d.accessToken === "string" ? d.accessToken : "";
    const seconds = typeof d.accessExpiresIn === "number" ? d.accessExpiresIn : 3600;
    if (!token) throw new PingFrontError("server", "The session answer had no token.", 0, "unavailable");
    this.#access = { token, expires: this.rt.now() + Math.max(5_000, seconds * 1000 - EARLY_MS) };
    this.info = {
      person: decodePerson(d.person),
      testDevice: d.testDevice === true,
      storeAccountToken: typeof d.storeAccountToken === "string" ? d.storeAccountToken : undefined,
    };
    if (typeof d.identityProblem === "string") this.hooks.identityProblem(d.identityProblem);
    this.log.debug(refreshed ? "Session refreshed." : "Session created.");
    this.active = true;
    this.hooks.started(this.info);
    return token;
  }
}

/** POST /me/logout, persisted and retried until the server accepts it (204 also when already logged out). */
export class LogoutQueue {
  #running = false;
  #attempt = 0;
  #timer: unknown;
  constructor(
    private readonly api: Api,
    private readonly store: () => Promise<Store>,
    private readonly rt: Runtime,
  ) {}

  // The queue is shared with other tabs: every change is one read-and-write of it, so none is lost.
  async add(c: Creds): Promise<void> {
    await (await this.store()).update<Creds[]>("logout", (l = []) => (l.some((x) => x.installId === c.installId) ? l : [...l, c])).catch(() => undefined);
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const s = await this.store();
      const list = (await s.get<Creds[]>("logout").catch(() => undefined)) ?? [];
      const done = new Set<string>();
      for (const c of list) {
        try {
          await this.api.send({ method: "POST", path: "/me/logout", auth: "key", idempotent: true, body: c });
          done.add(c.installId);
        } catch (e) {
          if (!(e instanceof PingFrontError) || !e.retryable) done.add(c.installId);
        }
      }
      await s
        .update<Creds[]>("logout", (l) => {
          const left = l?.filter((c) => !done.has(c.installId));
          return left?.length ? left : undefined;
        })
        .catch(() => undefined);
      if (done.size < list.length) {
        this.#attempt++;
        this.rt.clearTimeout(this.#timer);
        this.#timer = this.rt.setTimeout(() => void this.flush(), backoff(this.#attempt, this.rt.random, 1000, WRITE_CAP));
      } else this.#attempt = 0;
    } finally {
      this.#running = false;
    }
  }

  /** No more retries from this page (destroy); the persisted queue is flushed by the next one. */
  stop(): void {
    this.rt.clearTimeout(this.#timer);
  }
}
