// The headless chat: session, profile, outbox, live socket, look, unread and cards, wired together.
// Nothing here touches the network until something needs a session (open, a listened moment, prepare,
// selfCheck) or the app opted into unread checks on load. The UI renders `state` and calls the actions.
import { checkKey, KEY_PROBLEM_MESSAGES, crc32 } from "./keys.js";
import type { AppScreen, CardActionRequest, LinkCard, LinkFailure, ReplyToCard } from "./wire.js";
import { DASHBOARD_ORIGINS_PATH, DEFAULT_BASE_URL, GLOBAL_NAME, OPEN_FRAGMENT, OPEN_MESSAGE, STORAGE_NAME } from "../constants.js";
import { Api, PingFrontError } from "./api.js";
import { decodeConfig, decodeMessage, decodeMessagesPage, decodeTeamAction, decodeThreadResponse, isObj } from "./decode.js";
import type { AppFacts } from "./device.js";
import { Emitter } from "./events.js";
import { Live } from "./live.js";
import { createLogger, type LogHandler, type LogLevel, type Logger } from "./log.js";
import { resolveLook, type Appearance, type CodeTopic, type ResolvedLook } from "./look.js";
import type { AppConfig, Card, Message, OfferCard, SendPolicy, ServerEvent, StoreOffer, TeamActionPayload, TeamMember } from "./model.js";
import { Outbox, type Delivery, type HoldReason, type OutboxItem } from "./outbox.js";
import { Profile, tokenSubject, type Entitlement, type Identity, type OfferSlot } from "./profile.js";
import { browserRuntime, pause, type Runtime } from "./runtime.js";
import { LogoutQueue, Session, type SessionReason } from "./session.js";
import { Acts } from "./acts.js";
import { openStore, type Store } from "./storage.js";
import { mergeMessages } from "./timeline.js";
import { preparePhoto, uploadPhoto } from "./uploads.js";
import { allowedLink, isOpenable, parseChatLink, withoutLinkParams, type ChatLink } from "./links.js";
import { browserPushEnv, type PushEnv, type PushStatus } from "./push.js";
import { loadModule } from "./modules.js";
import type { Outcome } from "../lazy/selfcheck.js";

export type Options = {
  /** The API, ending in /v1. Default: production (https://api.pingfront.sh/v1). */
  baseUrl?: string;
  /** Show the floating launcher button (default true). Set false to open the chat from your own button. */
  launcher?: boolean;
  /** Language for the SDK's own text and customer text lookups (default: the browser's). */
  locale?: string;
  /** Up to six topics, used when the dashboard has none. */
  topics?: CodeTopic[];
  /** Look values used when the dashboard leaves a field unset. */
  appearance?: Appearance;
  /** Your app's name for the self-check message (default: the page title). */
  appName?: string;
  app?: AppFacts;
  logLevel?: LogLevel;
  /** Routes the SDK's (already redacted) log lines into your own logger, in addition to the console. */
  logHandler?: LogHandler;
  /** Open the chat when a moment's play asks for it (default true). */
  presentsChatForMoments?: boolean;
  /** Check the unread count on page load when this browser already has a session (default false: nothing is sent on load). */
  unreadOnLoad?: boolean;
  /** Show configuration problems (bad key, origin not allowed) in the chat itself. Default: on localhost or with logLevel "debug". */
  debug?: boolean;
  /**
   * Embeds the chat in this element instead of floating it over the page: it fills the element (give it a height),
   * with no launcher and no close button, like the iOS SDK's embeddable view. `open()` shows it and starts the
   * session, as the launcher would. Default: a floating launcher and panel on document.body.
   */
  container?: HTMLElement;
  /** Moves the floating launcher (and the panel above it) off your page's own bottom controls, in px. Default 20 and 20. */
  launcherOffset?: { bottom?: number; end?: number };
  /**
   * Web push for the chat's own offer: with it, the chat offers "Turn on notifications" under the person's first
   * message while this browser hasn't decided, as the iOS and Android chats do, and `enablePush()` uses it by default.
   * Set it only where your site serves pingfront-sw.js (see Web push in the README). Default: no offer.
   */
  push?: PushOptions;
  /** Tests and custom environments. */
  runtime?: Runtime;
  pushEnv?: PushEnv;
  store?: Store;
};

export type OfferRequest = { offerId: string; cardId: string; messageId: string; storeOffer?: StoreOffer; title: string };
export type Problem = { code: string; message: string };
/**
 * Passing conditions of this browser or this session: offline, online but the service can't be reached
 * (`unreachable`, cleared by the next answer from it), or rate limited until `until` (wall clock). Whether
 * the person may send at all (blocked, paused, sign in) is `policy`, the one source of truth for that.
 */
export type Notice = { kind: "offline" | "unreachable" | "rate_limited"; until?: number; scope?: string };
export type MomentResult =
  | { outcome: "ignored" | "scheduled" | "delivered" | "held_out"; open: boolean; presented: boolean }
  | { outcome: "not_listened" | "invalid_name" | "failed"; open: false; presented: false; error?: string };
export type PushOptions = {
  /** Where your site serves pingfront-sw.js (default "/pingfront-sw.js"); its folder is the worker's scope. */
  serviceWorker?: string;
};
export type ReportOptions = { screenshots?: Blob[]; logTail?: string; state?: Record<string, string> };
export type SelfCheckResult = { passed: boolean; code?: string; advice?: string; line: string };
/** A link card's screen of your app (one you registered) and its parameters, as the team saved the link. */
export type ScreenTarget = { id: string; params: Record<string, string> };

const SCREEN_ID = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,99}$/;
/** How long a link card's tap waits for the app's onScreen answer before it counts as not handled. */
const SCREEN_ANSWER_MS = 10_000;
/** A failure for the log: the request's line, never its payload. */
const why = (e: unknown) => (e instanceof PingFrontError ? e.logLine : "unexpected");

export type ChatState = {
  visible: boolean;
  loading: boolean;
  look: ResolvedLook;
  config?: AppConfig;
  messages: Message[];
  pending: OutboxItem[];
  team: TeamMember[];
  policy: SendPolicy;
  replyExpectation?: string;
  threadId?: string;
  readSeq: number;
  teamReadSeq: number;
  lastSeq: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  typing: { name?: string } | null;
  live: "connecting" | "open" | "closed";
  unread: number;
  problem?: Problem;
  notice?: Notice;
  /** A topic to start the composer with (open({ topic })). */
  prefill?: string;
  /** The thread didn't load while online (a server error): the chat offers "Try again". Offline is a notice instead. */
  failed?: boolean;
};

const CONFIG_TTL = 5 * 60_000;
const LISTENED_TTL = 5 * 60_000;
const MOMENT_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const TYPING_IDLE_MS = 5_000;
const TYPING_SHOW_MS = 8_000;

export class Engine {
  readonly events = new Emitter();
  readonly rt: Runtime;
  readonly log: Logger;
  readonly api: Api;
  readonly session: Session;
  readonly profile: Profile;
  readonly outbox: Outbox;
  readonly live: Live;
  readonly #logoutQueue: LogoutQueue;
  /** Card action reports, queued and retried with their clientId (core/acts.ts). */
  readonly acts: Acts;
  #storePromise: Promise<Store> | undefined;
  readonly keyOk: boolean;
  state: ChatState;
  onOffer: ((r: OfferRequest) => void) | undefined;
  onLink: ((url: URL) => boolean | void) | undefined;
  onScreen: ((screen: ScreenTarget) => boolean | Promise<boolean>) | undefined;
  #listeners = new Set<() => void>();
  #configAt = -Infinity;
  #etag: string | undefined;
  #listened: { names: Set<string>; at: number } | undefined;
  #unreadTimer: unknown;
  #watch: unknown;
  #unreadSince = 0;
  #readTimer: unknown;
  private typingTimer: unknown;
  #typingShowTimer: unknown;
  private opening: Promise<void> | undefined;
  #repairing = false;
  /** Team action ids already handed to the app (live and catch-up deliver each once). */
  #teamActionsSeen = new Set<string>();
  /** Team action ids already answered; the first answer wins. */
  #teamActionsAnswered = new Set<string>();
  private online = true;
  #resetting: Promise<void> | undefined;
  // What the lazy modules (src/lazy) use besides the members above: they take the engine itself.
  readonly pushEnv: PushEnv;
  readonly store: () => Promise<Store>;
  /** The chat's own advice for its problems, which the self-check gives too. */
  readonly advice = { keyUnknown: KEY_UNKNOWN, origin: originAdvice, identity: identityAdvice };
  private destroyed = false;
  /** The paywalls the app last reported (setOffers), if it ever did. */
  offers: OfferSlot[] | undefined;
  /** A chat link's topic waiting for the dashboard's topics (GET /config arrives as the chat opens). */
  #linkTopic: string | undefined;
  /** The open fragment's or a chat link's open, due on the next tick (destroy() clears it). */
  #openTimer: unknown;
  /** Aborted when the person changes or the engine is destroyed: team action answers stop retrying. */
  #quit = new AbortController();
  /** This origin's other tabs, which share the stored install, outbox and reports (opened with IndexedDB). */
  #tabs: BroadcastChannel | undefined;

  /** `link`: a chat link handled before configure; it wins over the page's own URL. */
  constructor(
    readonly appKey: string,
    readonly options: Options = {},
    link?: string,
  ) {
    this.#locale = options.locale;
    this.rt = options.runtime ?? browserRuntime();
    this.log = createLogger(options.logLevel ?? "info", options.logHandler);
    const base = options.baseUrl ?? DEFAULT_BASE_URL;
    this.api = new Api(base, appKey, this.rt, this.log);
    const key = checkKey(appKey);
    this.keyOk = key.ok;
    const ns = key.ok ? `${key.key.mode}-${crc32(appKey).toString(16)}` : "invalid";
    const store = () =>
      (this.#storePromise ??= (options.store ? Promise.resolve(options.store) : openStore(ns)).then((s) => {
        // Tabs share only what IndexedDB holds; the first use of it starts listening to them.
        if (s.kind === "indexeddb" && !this.#tabs && !this.destroyed) {
          this.#tabs = this.rt.channel?.(`${STORAGE_NAME}:${ns}`);
          if (this.#tabs) this.#tabs.onmessage = this.#fromTab;
        }
        return s;
      }));
    this.store = store;
    this.pushEnv = options.pushEnv ?? browserPushEnv();
    this.profile = new Profile(this.rt, {
      active: () => this.session.active,
      patch: async (body) => {
        // Changed screens ride along on a PATCH that goes anyway, never on one of their own.
        const s = await this.session.withScreens();
        const data = (await this.api.send({ method: "PATCH", path: "/me", auth: "bearer", body: s ? { ...body, device: { app: s[0] } } : body })).data;
        await s?.[1]();
        // The person just signed in where the chat asked them to: load the thread again for its new send policy.
        if (body.identity && this.state.visible && this.state.policy.reason === "verification_required") this.#reload();
        // Verified now: messages held for a sign-in go, even with the chat closed (refused again, they are held again).
        if (isObj(data) && isObj(data.person) && data.person.level === "verified") this.#reopen("verification_required");
        return data;
      },
      identityProblem: (p) => this.#problem("identity_" + p, identityAdvice(p)),
    });
    this.session = new Session(this.api, store, this.rt, this.profile, options.app ?? {}, {
      started: () => {
        this.profile.wake();
        this.#scheduleUnread(true);
        void this.#resyncPush();
        // Reports a page queued before it closed go once a session exists anyway (nothing is sent to start one).
        void this.acts.flush();
      },
      identityProblem: (p) => this.#problem("identity_" + p, identityAdvice(p)),
      // The server revoked the install: the old person's state goes, then the app hears it (as on iOS and Android).
      revoked: () => void this.#localWipe(false).finally(() => this.events.emit("sessionRevoked", undefined)),
      saved: (installId) => this.#tabs?.postMessage({ installId }),
    }, this.log);
    this.api.tokens = this.session;
    this.api.onThreadReset = () => void this.resetThread().catch((e: unknown) => this.fail(e));
    // Any answer from the service, even an error, means it can be reached again: the open chat catches up.
    this.api.onAnswer = () => {
      if (this.state.notice?.kind !== "unreachable") return;
      this.notice(undefined);
      this.rt.setTimeout(this.#recover, 0);
    };
    this.#logoutQueue = new LogoutQueue(this.api, store, this.rt);
    this.acts = new Acts(this.api, store, this.rt, async (id) => (await this.resetThread().catch(() => undefined), this.state.messages.some((m) => m.id === id)));
    this.outbox = new Outbox(store, this.rt, () => this.update({ pending: [...this.outbox.items] }));
    this.live = new Live(this.rt, {
      url: () => liveUrl(this.state.config?.liveUrl, base),
      // The chat's open got the session first; a reconnect only refreshes it.
      token: () => this.session.token(undefined, false),
      expired: (t) => this.session.invalidate(t),
      event: (e, raw) => this.#onLive(e, raw),
      reset: () => this.#reload(),
      // 4004: the person was erased elsewhere, so the server revoked this install too.
      erased: () => void this.#localWipe(true).finally(() => this.events.emit("sessionRevoked", undefined)),
      state: (s) => this.update({ live: s }),
    }, this.log);
    this.state = {
      visible: false,
      loading: false,
      look: resolveLook(undefined, options.appearance, options.topics),
      messages: [],
      pending: [],
      team: [],
      policy: { canSend: true },
      readSeq: 0,
      teamReadSeq: 0,
      lastSeq: 0,
      hasOlder: false,
      loadingOlder: false,
      typing: null,
      live: "closed",
      unread: 0,
    };
    if (!key.ok) {
      // Loud, never silent: a banner in the chat, an error in the console, and a problem event.
      this.#problem("key_invalid", KEY_PROBLEM_MESSAGES[key.problem]);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.#onOnline);
      window.addEventListener("offline", this.#onOffline);
      document.addEventListener("visibilitychange", this.#onVisibility);
      this.online = navigator.onLine !== false;
    }
    if (options.unreadOnLoad && key.ok) void this.#checkUnreadIfKnown();
    this.pushEnv.serviceWorker?.addEventListener("message", this.#onWorkerMessage);
    // A notification click opened this page: open the chat (a person's action, so a session may start).
    if (key.ok && typeof location !== "undefined" && location.hash === OPEN_FRAGMENT) {
      history.replaceState(history.state, "", location.pathname + location.search);
      this.#openTimer = this.rt.setTimeout(() => this.open(), 0);
    }
    // A chat link (?pingfront=chat): the page's own URL, unless one was handled before configure.
    const page = typeof location === "undefined" ? undefined : parseChatLink(location.href);
    if (page && isOpenable(page)) this.#cleanAddressBar();
    const queued = link === undefined ? undefined : parseChatLink(link);
    const apply = queued && isOpenable(queued) ? queued : page;
    if (apply && isOpenable(apply)) this.#openTimer = this.rt.setTimeout(() => this.#applyLink(apply), 0);
  }

  // ---------------------------------------------------------------------------
  // Chat links
  // ---------------------------------------------------------------------------

  /**
   * Opens the chat for a chat link (the protocol, "Chat links") and returns true; returns false for any other
   * URL. Sends nothing itself: the chat opening starts the session, as open() does.
   */
  handleUrl(url?: string | URL): boolean {
    const target = url ?? (typeof location === "undefined" ? undefined : location.href);
    const link = parseChatLink(target);
    if (!isOpenable(link) || this.destroyed) return false;
    if (typeof location !== "undefined" && new URL(String(target)).href === location.href) this.#cleanAddressBar();
    this.#applyLink(link);
    return true;
  }

  #applyLink(link: ChatLink): void {
    if (this.destroyed) return;
    // The web's bug report is the composer, so a report link opens the chat.
    if (link.kind !== "chat" || !link.topic) return this.open();
    const topic = link.topic;
    if (this.state.look.topics.some((t) => t.id === topic)) return this.open(topic);
    // Before the app's config has loaded, the dashboard's topics aren't known: check again once it has.
    this.#linkTopic = this.state.config ? undefined : topic;
    this.open();
  }

  /** Removes a chat link's parameters from the address bar, so a reload doesn't open the chat again. */
  #cleanAddressBar(): void {
    if (typeof history === "undefined" || typeof location === "undefined") return;
    try {
      history.replaceState(history.state, "", withoutLinkParams(location));
    } catch {
      // A sandboxed page may not rewrite its address; the link was still handled.
    }
  }

  #onWorkerMessage = (e: MessageEvent) => {
    if (isObj(e.data) && e.data.type === OPEN_MESSAGE) this.open();
  };

  // ---------------------------------------------------------------------------
  // Web push
  // ---------------------------------------------------------------------------

  /**
   * Asks for notification permission (the browser's prompt, so call it from a person's action),
   * subscribes this browser and registers it as the install's push address (src/lazy/push.ts).
   */
  async enablePush(options: PushOptions = this.options.push ?? {}): Promise<PushStatus> {
    this.#requireKey();
    // The browser's prompt first, while the click that called this still counts as the person's gesture: loading
    // push.js before it could outlast that gesture, and Safari then refuses the prompt (MDN, Notification.requestPermission).
    const env = this.pushEnv;
    const asked = env.notification?.permission === "default" && env.serviceWorker && env.hasPushManager ? await env.notification.requestPermission() : undefined;
    return (await this.#push())?.enable(this, options, asked) ?? "failed";
  }

  /**
   * Whether the chat may offer "Turn on notifications": the host set `push`, the server has a web push key, and this
   * browser can take push and hasn't decided (a person who declined or blocked is never asked again).
   */
  get canOfferPush(): boolean {
    const env = this.pushEnv;
    return Boolean(this.options.push && this.state.config?.webPushKey && env.serviceWorker && env.hasPushManager && env.notification?.permission === "default");
  }

  /** Stops pushes to this browser: the server forgets the subscription and the browser drops it. */
  async disablePush(): Promise<void> {
    await (await this.#push())?.disable(this);
    await this.#forgetPush();
  }

  /** A new session (after a refresh too) re-sends a subscription that changed since it was registered. */
  async #resyncPush(): Promise<void> {
    if (this.pushEnv.notification?.permission !== "granted") return;
    const saved = await (await this.store()).get<string>("push").catch(() => undefined);
    if (saved) await (await this.#push())?.resync(this, saved);
  }

  /**
   * Logout and erase: the server drops the subscription with the install; the browser drops it here. Without
   * notification permission there is no subscription, so the push flows load only when it was granted.
   */
  async #dropPush(): Promise<void> {
    if (this.pushEnv.notification?.permission === "granted") await (await this.#push())?.drop(this);
    await this.#forgetPush();
  }

  #forgetPush(): Promise<unknown> {
    return this.store().then((s) => s.delete("push")).catch(() => undefined);
  }

  async #push() {
    const m = await loadModule("push");
    if (!m) this.log.error("Web push failed: push.js did not load.");
    return m;
  }

  /** `e` as an API error: a lazy module can't use instanceof, since the script build runs it as a script of its own. */
  apiError(e: unknown): PingFrontError | undefined {
    return e instanceof PingFrontError ? e : undefined;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  update(patch: Partial<ChatState>): void {
    const prevUnread = this.state.unread;
    this.state = { ...this.state, ...patch };
    for (const fn of this.#listeners) fn();
    if (this.state.unread !== prevUnread) this.events.emit("unread", this.state.unread);
  }

  #problem(code: string, message: string): void {
    const problem = { code, message };
    this.log.error(`${message} (${code})`);
    this.update({ problem });
    this.events.emit("problem", problem);
  }

  private notice(n: Notice | undefined): void {
    this.update({ notice: n });
  }

  private fail(e: unknown): void {
    if (!(e instanceof PingFrontError)) {
      this.log.error("Unexpected error.");
      return;
    }
    this.log.info(`Request failed: ${e.logLine}`);
    if (e.code === "invalid_app_key") this.#problem("key_unknown", KEY_UNKNOWN);
    else if (e.code === "origin_not_allowed") this.#problem("origin_not_allowed", originAdvice());
    // The server says the person can't send now: that is the send policy (the next GET /thread confirms or clears it).
    else if (e.code === "app_paused" || e.code === "blocked" || e.code === "verification_required") this.#closed({ canSend: false, reason: e.code });
    // Only sending has a line for it: a 429 on another scope (loading the thread, older messages) isn't "send again".
    else if ((e.kind === "cooling_down" || e.status === 429) && (e.extra.scope === "messages" || e.extra.scope === "uploads")) this.notice({ kind: "rate_limited", until: this.rt.wall() + (e.extra.retryAfter ?? 30) * 1000, scope: e.extra.scope });
    // Online, but the service can't be reached: saying "offline" would send the person to their Wi-Fi.
    else if (e.kind === "network" || e.kind === "timeout") this.notice({ kind: this.online ? "unreachable" : "offline" });
  }

  /** A new send policy. Blocked promises nothing: messages a pause or a sign-in held become plain failures. */
  #closed(policy: SendPolicy): void {
    this.update({ policy });
    // An open, paused chat notices a resume: GET /thread once a minute, and nothing else (the protocol, "Paused apps").
    if (policy.reason === "app_paused") this.#later(60_000, () => this.state.policy.reason === "app_paused" && this.#reload());
    if (policy.reason === "blocked") this.outbox.releaseHeld();
  }

  /** One check later, while the chat shows: a paused app's next GET /thread, or another try at an unreachable open. */
  #later(ms: number, run: () => void): void {
    this.rt.clearTimeout(this.#watch);
    // destroy() clears it.
    this.#watch = this.rt.setTimeout(() => this.state.visible && run(), ms);
  }

  /** The service or the network is back: load what the open chat is missing (the config, then the thread or its gap). */
  #recover = () => {
    if (!this.state.visible || this.destroyed) return;
    this.#configAt = -Infinity;
    if (!this.state.threadId) return this.retryOpen();
    void this.loadConfig(false).catch(() => undefined);
    void this.#repair();
  };

  /** What closed sending for `reason` is over: if it was closed for it, it opens; messages it held go. */
  #reopen(reason: HoldReason): void {
    const was = this.state.policy.reason === reason;
    if (was) this.update({ policy: { canSend: true } });
    this.#release(was ? undefined : reason);
  }

  /** Sending reopened (for `reason`, or any): held messages go again, first, in order. */
  #release(reason?: HoldReason): void {
    if (this.outbox.retryHeld(reason)) void this.drain();
  }

  // ---------------------------------------------------------------------------
  // Opening and closing
  // ---------------------------------------------------------------------------

  open(topic?: string): void {
    if (this.destroyed) return;
    if (this.state.visible) {
      if (topic) this.update({ prefill: this.#topicText(topic) });
      return;
    }
    this.update({ visible: true, prefill: topic ? this.#topicText(topic) : undefined });
    this.events.emit("open", {});
    this.#stopUnread();
    if (!this.keyOk) return;
    this.opening ??= this.#openThread().finally(() => (this.opening = undefined));
  }

  close(): void {
    this.#linkTopic = undefined;
    if (!this.state.visible) return;
    this.update({ visible: false, typing: null });
    this.live.stop();
    this.live.typing(false);
    this.events.emit("close", {});
    this.#scheduleUnread(true);
  }

  #topicText(id: string): string | undefined {
    const t = this.state.look.topics.find((x) => x.id === id);
    if (!t) return undefined;
    const lang = this.lang;
    const pick = (l: Record<string, string> | undefined) => l?.[lang] ?? l?.[lang.split("-")[0]!] ?? l?.default;
    return pick(t.prefill) ?? pick(t.label);
  }

  get debug(): boolean {
    if (this.options.debug !== undefined) return this.options.debug;
    const host = typeof location === "undefined" ? "" : location.hostname;
    return this.log.level === "debug" || host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
  }

  get lang(): string {
    return this.#locale ?? (typeof navigator === "undefined" ? "en" : navigator.language || "en");
  }

  #locale: string | undefined;

  /**
   * Changes the chat's language at runtime (a BCP 47 tag such as "de" or "pt-BR"; undefined follows the browser).
   * The open chat re-renders in it; nothing is reconfigured and nothing is sent. Returns false for an invalid tag,
   * which is ignored and logged.
   */
  setLocale(tag: string | undefined): boolean {
    if (tag !== undefined) {
      try {
        tag = Intl.getCanonicalLocales(tag)[0];
      } catch {
        tag = undefined;
      }
      if (!tag) {
        this.log.error(`setLocale: ignored, not a BCP 47 tag.`);
        return false;
      }
    }
    if (tag === this.#locale) return true;
    this.#locale = tag;
    this.events.emit("locale", this.lang);
    this.update({});
    return true;
  }

  /** Loads the thread again after it failed (the chat's "Try again", or the network coming back). */
  retryOpen(): void {
    if (!this.state.visible || !this.keyOk || this.destroyed) return;
    this.opening ??= this.#openThread().finally(() => (this.opening = undefined));
  }

  async #openThread(): Promise<void> {
    this.update({ loading: this.state.messages.length === 0, failed: false });
    await this.outbox.load();
    void this.#logoutQueue.flush();
    try {
      await Promise.all([this.loadConfig(false), this.session.token("chat_opened")]);
      if (!this.state.visible) return;
      const topic = this.#linkTopic;
      this.#linkTopic = undefined;
      if (topic && this.state.look.topics.some((t) => t.id === topic)) this.update({ prefill: this.#topicText(topic) });
      await this.reloadThread();
      if (!this.state.visible || this.destroyed) return;
      this.live.start();
      void this.drain();
      if (this.state.notice?.kind === "offline") this.notice(undefined);
    } catch (e) {
      const { notice, problem, policy } = this.state;
      this.fail(e);
      // Nothing more specific was said (offline, paused, a key problem…): the server failed. Say so and offer a retry.
      const unexplained = this.state.notice === notice && this.state.problem === problem && this.state.policy === policy;
      if (e instanceof PingFrontError && e.kind !== "cancelled" && unexplained && this.online) this.update({ failed: true });
      // The service couldn't be reached: try again in a while (any answer before then catches up at once).
      if (this.state.notice?.kind === "unreachable") this.#later(10_000, () => this.retryOpen());
    } finally {
      this.update({ loading: false });
    }
  }

  async loadConfig(force: boolean): Promise<void> {
    if (!force && this.rt.now() - this.#configAt < CONFIG_TTL) return;
    const draft = this.session.info.testDevice;
    const res = await this.api.send({ method: "GET", path: "/config", auth: draft ? "bearer" : "key", query: draft ? { draft: "1" } : undefined, etag: draft ? undefined : this.#etag });
    this.#configAt = this.rt.now();
    if (res.status === 304) return;
    const etag = res.headers.get("ETag");
    if (etag && !draft) this.#etag = etag;
    const config = decodeConfig(res.data);
    this.update({ config, look: resolveLook(config, this.options.appearance, this.options.topics) });
  }

  /** `resetOnce` false: this is the reset's own reload, so another thread_reset fails instead of awaiting itself. */
  async reloadThread(resetOnce = true): Promise<void> {
    const gen = this.session.generation;
    try {
      const res = await this.api.send({ method: "GET", path: "/thread", auth: "bearer" });
      if (gen !== this.session.generation) return;
      const t = decodeThreadResponse(res.data);
      if (t.thread) this.api.rev = t.thread.rev;
      const local = this.state.messages.filter((m) => m.id.startsWith("local_"));
      this.#closed(t.policy);
      this.update({
        messages: mergeMessages(t.messages, local),
        team: t.team,
        replyExpectation: t.replyExpectation,
        threadId: t.thread?.id,
        readSeq: t.thread?.readSeq ?? 0,
        teamReadSeq: t.thread?.teamReadSeq ?? 0,
        lastSeq: t.thread?.lastSeq ?? 0,
        hasOlder: t.hasOlder,
        unread: t.thread?.unread ?? 0,
      });
      // Every load that allows sending releases what a closed policy held, also before a reload of the page.
      if (t.policy.canSend) this.#release();
      this.markRead();
    } catch (e) {
      // The Api already dropped the stale rev; the reload goes out without one.
      if (resetOnce && e instanceof PingFrontError && e.code === "thread_reset") return this.resetThread();
      throw e;
    }
  }

  /** A reload nobody awaits (the socket asked for it): a failure becomes a notice, not an unhandled rejection. */
  #reload(): void {
    this.reloadThread().catch((e: unknown) => this.fail(e));
  }

  /** 409 thread_reset: drop the message cache (the draft and the outbox stay) and reload once, shared by every caller. */
  resetThread(): Promise<void> {
    return (this.#resetting ??= (async () => {
      this.update({ messages: this.state.messages.filter((m) => m.id.startsWith("local_")) });
      await this.reloadThread(false);
    })().finally(() => (this.#resetting = undefined)));
  }

  async loadOlder(): Promise<void> {
    const first = this.state.messages.find((m) => !m.id.startsWith("local_"));
    if (!first || this.state.loadingOlder || !this.state.hasOlder) return;
    this.update({ loadingOlder: true });
    try {
      const res = await this.api.send({ method: "GET", path: "/thread/messages", auth: "bearer", query: { before: first.seq, limit: 50 } });
      const page = decodeMessagesPage(res.data);
      this.update({ messages: mergeMessages(this.state.messages, page.messages), hasOlder: page.hasMore });
    } catch (e) {
      this.fail(e);
    } finally {
      this.update({ loadingOlder: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Live
  // ---------------------------------------------------------------------------

  #onLive(e: ServerEvent, raw: unknown): void {
    this.events.emit("live", e.type === "unknown" ? e : raw);
    switch (e.type) {
      case "hello":
        if (e.rev !== undefined && this.api.rev !== undefined && e.rev !== this.api.rev) {
          this.#reload();
          return;
        }
        this.update({ teamReadSeq: Math.max(this.state.teamReadSeq, e.teamReadSeq ?? 0) });
        if (e.lastSeq > this.state.lastSeq) void this.#repair();
        // Every (re)connect catches up on team actions sent while the socket was down.
        void this.#catchUpTeamActions();
        return;
      case "team_action":
        // No seq: it doesn't change the thread, so it never triggers gap repair.
        this.#deliverTeamAction(e.action);
        return;
      case "message":
        this.#receive(e.seq, e.message);
        return;
      case "message_updated":
        this.update({ messages: mergeMessages(this.state.messages, [e.message]) });
        return;
      case "typing":
        // Dots only for a human teammate.
        if (e.author.kind !== "team") return;
        this.rt.clearTimeout(this.#typingShowTimer);
        if (e.on) this.#typingShowTimer = this.rt.setTimeout(() => this.update({ typing: null }), TYPING_SHOW_MS);
        this.update({ typing: e.on ? { name: e.author.name } : null });
        return;
      case "read":
        this.update({ teamReadSeq: Math.max(this.state.teamReadSeq, e.upToSeq) });
        return;
      case "reset":
        this.#reload();
        return;
      case "thread_reset":
        // The team reset the conversation (the protocol, "Live"): drop the thread, its messages, the stored rev and
        // the unread count, keep the draft and the outbox (an unsent message starts the new thread), show the empty
        // chat, and load it again. The socket stays open.
        this.api.rev = undefined;
        this.update({ messages: [], threadId: undefined, readSeq: 0, teamReadSeq: 0, lastSeq: 0, hasOlder: false, unread: 0, typing: null });
        this.#reload();
        return;
      case "config":
        void this.loadConfig(true).catch((x) => this.fail(x));
        return;
      case "reauth":
      case "thread":
      case "unknown":
        return;
    }
  }

  async #catchUpTeamActions(): Promise<void> {
    try {
      const res = await this.api.send({ method: "GET", path: "/team-actions", auth: "bearer" });
      const list = isObj(res.data) && Array.isArray(res.data.actions) ? res.data.actions : [];
      for (const raw of list) {
        const action = decodeTeamAction(raw);
        if (action) this.#deliverTeamAction(action);
      }
    } catch (e) {
      this.log.info(`Team action catch-up failed: ${why(e)}`);
    }
  }

  #deliverTeamAction(action: TeamActionPayload): void {
    if (this.#teamActionsSeen.has(action.id)) return;
    this.#teamActionsSeen.add(action.id);
    this.events.emit("teamAction", {
      ...action,
      complete: () => this.#answerTeamAction(action.id, { ok: true }),
      fail: (message: string) => this.#answerTeamAction(action.id, { ok: false, message: [...message].slice(0, 200).join("") }),
    });
  }

  /** Confirms or fails a team action. Retries transient failures; 404 and 409 (not this person's, or expired) drop it. */
  async #answerTeamAction(id: string, body: { ok: true } | { ok: false; message: string }): Promise<void> {
    if (this.#teamActionsAnswered.has(id)) return;
    this.#teamActionsAnswered.add(id);
    // Logout, erase or destroy end the retries, and the request in flight.
    const signal = this.#quit.signal;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.api.send({ method: "POST", path: `/team-actions/${encodeURIComponent(id)}/ack`, auth: "bearer", body, signal });
        return;
      } catch (e) {
        if (!(e instanceof PingFrontError) || !e.retryable || !(await pause(this.rt, Math.min(30_000, 1000 * 2 ** attempt), signal))) return;
      }
    }
  }

  #receive(seq: number, message: Message): void {
    const gap = seq > this.state.lastSeq + 1 && this.state.lastSeq > 0;
    const known = this.state.messages.some((m) => m.id === message.id);
    this.update({
      messages: mergeMessages(this.state.messages, [message]),
      lastSeq: gap ? this.state.lastSeq : Math.max(this.state.lastSeq, seq),
      typing: message.author.kind === "person" ? this.state.typing : null,
    });
    if (gap) void this.#repair();
    if (!known && message.author.kind !== "person") {
      this.events.emit("message", message);
      if (this.state.visible && isPageVisible()) this.markRead();
      else this.update({ unread: this.state.unread + 1 });
    }
  }

  /** Seq gap: fetch what was missed (the tracker moves only on success). */
  async #repair(): Promise<void> {
    if (this.#repairing) return;
    this.#repairing = true;
    try {
      const res = await this.api.send({ method: "GET", path: "/thread/messages", auth: "bearer", query: { after: this.state.lastSeq, limit: 200 } });
      const page = decodeMessagesPage(res.data);
      const last = page.messages.reduce((n, m) => Math.max(n, m.seq), this.state.lastSeq);
      this.update({ messages: mergeMessages(this.state.messages, page.messages), lastSeq: last });
      this.markRead();
    } catch (e) {
      this.log.info(`Gap repair failed: ${why(e)}`);
    } finally {
      this.#repairing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Read receipts, unread
  // ---------------------------------------------------------------------------

  markRead(): void {
    // A paused app refuses read receipts.
    if (!this.state.visible || !isPageVisible() || this.destroyed || this.state.policy.reason === "app_paused") return;
    const upTo = this.state.messages.reduce((n, m) => (m.id.startsWith("local_") ? n : Math.max(n, m.seq)), 0);
    if (upTo <= this.state.readSeq) {
      if (this.state.unread) this.update({ unread: 0 });
      return;
    }
    this.rt.clearTimeout(this.#readTimer);
    this.#readTimer = this.rt.setTimeout(async () => {
      try {
        const res = await this.api.send({ method: "POST", path: "/thread/read", auth: "bearer", body: { upToSeq: upTo } });
        const d = isObj(res.data) ? res.data : {};
        this.update({ readSeq: typeof d.readSeq === "number" ? d.readSeq : upTo, unread: typeof d.unread === "number" ? d.unread : 0 });
      } catch (e) {
        this.log.info(`Read receipt failed: ${why(e)}`);
      }
    }, 300);
  }

  /** Polling while the chat is closed: every 20 s for 2 minutes after activity, then every 2 minutes for an hour. */
  #scheduleUnread(activity: boolean): void {
    if (!this.session.active || this.state.visible || this.destroyed) return;
    if (activity) this.#unreadSince = this.rt.now();
    this.rt.clearTimeout(this.#unreadTimer);
    const since = this.rt.now() - this.#unreadSince;
    if (since > 3_600_000 || !isPageVisible()) return;
    this.#unreadTimer = this.rt.setTimeout(() => void this.#pollUnread(), since < 120_000 ? 20_000 : 120_000);
  }

  #stopUnread(): void {
    this.rt.clearTimeout(this.#unreadTimer);
  }

  async #pollUnread(): Promise<void> {
    if (this.state.visible || !this.session.active) return;
    try {
      const res = await this.api.send({ method: "GET", path: "/unread", auth: "bearer" });
      const d = isObj(res.data) ? res.data : {};
      if (typeof d.unread === "number" && !this.state.visible) this.update({ unread: d.unread });
      // A paused app refuses GET /unread, so it is not paused: messages a pause held go (any other reason is the
      // thread's to say, on its next load).
      this.#reopen("app_paused");
    } catch (e) {
      this.log.debug(`Unread check failed: ${why(e)}`);
    }
    this.#scheduleUnread(false);
  }

  /** unreadOnLoad: an install this browser already has refreshes (never creates) and checks the count. */
  async #checkUnreadIfKnown(): Promise<void> {
    if (!(await this.session.credentials())) return;
    try {
      await this.session.renew();
    } catch (e) {
      this.log.debug(`Unread check failed: ${why(e)}`);
      return;
    }
    await this.#pollUnread();
  }

  #onVisibility = () => {
    if (isPageVisible()) {
      if (this.session.active) void this.acts.flush(true);
      if (this.state.visible) this.markRead();
      else this.#scheduleUnread(true);
    }
  };
  #onOnline = () => {
    this.online = true;
    if (this.state.notice?.kind === "offline") this.notice(undefined);
    this.outbox.poke();
    if (this.session.active) void this.acts.flush(true);
    // Back online: catch up, or load the thread the chat opened without.
    this.#recover();
  };
  #onOffline = () => {
    this.online = false;
    this.notice({ kind: "offline" });
  };

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  send(text: string, files: Blob[] = [], replyToCard?: ReplyToCard): void {
    const body = text.trim() ? text : undefined;
    if (!body && files.length === 0 && !replyToCard) return;
    this.live.typing(false);
    this.rt.clearTimeout(this.typingTimer);
    const item: OutboxItem = {
      clientId: this.rt.uuid(),
      photos: [],
      createdAt: new Date(this.rt.wall()).toISOString(),
      state: "queued",
      attempts: 0,
    };
    if (body) item.text = body;
    if (files.length) item.files = files.slice(0, 6);
    if (replyToCard) item.replyToCard = replyToCard;
    this.outbox.enqueue(item);
    void this.drain();
  }

  retry(clientId: string): void {
    this.outbox.retry(clientId);
    void this.drain();
  }

  discard(clientId: string): void {
    this.outbox.discard(clientId);
    // A deleted held message no longer keeps the ones behind it waiting.
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (!this.keyOk || this.destroyed) return;
    await this.outbox.load();
    if (this.destroyed) return;
    await this.outbox.drain(
      (item, signal) => this.deliver(item, signal),
      (_item, message) => {
        const m = decodeMessage(message);
        if (m) this.update({ messages: mergeMessages(this.state.messages, [m]), lastSeq: Math.max(this.state.lastSeq, m.seq), readSeq: Math.max(this.state.readSeq, m.seq) });
        this.events.emit("sent", m);
        if (this.state.visible && !this.live.running && !this.destroyed) this.live.start();
        // A text that went out clears its own waits; a photo cooldown still holds the photos back.
        const n = this.state.notice;
        if (n?.kind === "offline" || (n?.kind === "rate_limited" && n.scope !== "uploads")) this.notice(undefined);
      },
    );
  }

  private async deliver(item: OutboxItem, signal: AbortSignal): Promise<Delivery> {
    const gen = this.session.generation;
    try {
      if (!this.online) throw new PingFrontError("network", "Offline.");
      await this.session.token("chat_opened");
      if (item.files?.length) {
        const prepared = [];
        for (const f of item.files) prepared.push(await preparePhoto(f, this.rt));
        item.photos = prepared;
        delete item.files;
      }
      const attachmentIds: string[] = [];
      for (const p of item.photos) attachmentIds.push(await uploadPhoto(this.api, this.rt, p, signal));
      if (gen !== this.session.generation) throw new PingFrontError("cancelled", "The session changed.", 0, "cancelled");
      const body: Record<string, unknown> = { clientId: item.clientId };
      if (item.text) body.text = item.text;
      if (attachmentIds.length) body.attachmentIds = attachmentIds;
      if (item.replyToCard) body.replyToCard = item.replyToCard;
      const res = await this.api.send({ method: "POST", path: "/thread/messages", auth: "bearer", scope: "messages", idempotent: true, body, signal });
      const d = isObj(res.data) ? res.data : {};
      if (typeof d.threadId === "string" && !this.state.threadId) this.update({ threadId: d.threadId });
      return { ok: true, message: d.message };
    } catch (e) {
      const err = e instanceof PingFrontError ? e : new PingFrontError("network", "The message could not be sent.");
      // Reload the thread and send again, once per message: a second thread_reset fails it (the protocol, Retrying writes).
      if (err.code === "thread_reset" && !item.reset) {
        item.reset = true;
        await this.resetThread().catch(() => undefined);
        return { ok: false, error: new PingFrontError("network", "The thread changed; sending again.") };
      }
      if (err.code === "upload_incomplete") {
        for (const p of item.photos) delete p.attachmentId;
        return { ok: false, error: new PingFrontError("network", "The photo upload did not finish; trying again.") };
      }
      this.fail(err);
      return { ok: false, error: err };
    }
  }

  /** Typing out: on while the person types, off after 5 s idle or on send. */
  draftChanged(text: string): void {
    if (!this.state.visible) return;
    const on = text.trim().length > 0;
    this.live.typing(on);
    this.rt.clearTimeout(this.typingTimer);
    if (on) this.typingTimer = this.rt.setTimeout(() => this.live.typing(false), TYPING_IDLE_MS);
  }

  // ---------------------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------------------

  act(card: Card, messageId: string, answer?: { choiceId?: string; rating?: number }, failure?: LinkFailure): void {
    if (card.kind === "unknown") return;
    // As on iOS and Android: the card's kind and ids, never its text, for the host's own analytics.
    this.events.emit("cardOpened", { kind: card.kind, cardId: card.id, messageId });
    let action: CardActionRequest["action"] = failure ? "failed" : "opened";
    if (card.kind === "choices" || card.kind === "rating") {
      action = card.kind === "choices" ? "chosen" : "rated";
      this.setLocalResult(messageId, card.id, { at: new Date(this.rt.wall()).toISOString(), ...answer });
    } else if (card.kind === "offer") this.openOffer(card, messageId);
    // Queued with its own clientId and retried safely (the protocol, "Retrying writes").
    void this.acts.add(card.id, { messageId, action, ...answer, failure });
  }

  private openOffer(card: OfferCard, messageId: string): void {
    const request: OfferRequest = { offerId: card.offerId, cardId: card.id, messageId, storeOffer: card.offer, title: card.title };
    this.events.emit("offer", request);
    if (this.onOffer) this.onOffer(request);
    else this.log.error(`No offer handler: call ${GLOBAL_NAME}.onOffer(fn).`);
  }

  private setLocalResult(messageId: string, cardId: string, result: { at: string; choiceId?: string; rating?: number }): void {
    this.update({
      messages: this.state.messages.map((m) =>
        m.id !== messageId ? m : { ...m, parts: m.parts.map((p) => (p.type === "card" && p.card.kind !== "unknown" && p.card.id === cardId ? { ...p, result } : p)) },
      ),
    });
  }

  /**
   * Opens a link: the link card URL rule first (the protocol, "Link card URLs"), so a refused URL never reaches the
   * `link` event or onLink; then the app's onLink handler, else a new tab (http and https only). False when nothing
   * opened it.
   */
  openLink(href: string): boolean {
    const allowed = allowedLink(href);
    let url: URL;
    try {
      if (!allowed) return false;
      url = new URL(allowed);
    } catch {
      return false;
    }
    this.events.emit("link", url);
    if (this.onLink?.(url) === true) return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    window.open(url.href, "_blank", "noopener,noreferrer");
    return true;
  }

  /**
   * A link card's tap (the protocol, Saved links): a registered screen goes to onScreen, else `url` as any link.
   * One report once the outcome is known: opened, or failed with why.
   */
  async tapLink(card: LinkCard, messageId: string): Promise<void> {
    const s = card.screen;
    let failure: LinkFailure | undefined;
    if (s && this.session.screens?.some((x) => x.id === s.id)) {
      let ok = false;
      const deadline = new AbortController();
      try {
        // The first to finish wins: the app's answer, or SCREEN_ANSWER_MS (as on iOS and Android). A late answer is ignored.
        const answer = Promise.resolve(this.onScreen?.({ id: s.id, params: s.params ?? {} }));
        ok = (await Promise.race([answer, pause(this.rt, SCREEN_ANSWER_MS, deadline.signal).then(() => false)])) === true;
      } catch {
        // A handler that throws didn't open the screen.
      } finally {
        deadline.abort();
      }
      if (!ok) failure = "not_handled";
    } else if (s && !card.url) failure = "unknown_screen";
    else if (!this.openLink(card.url)) failure = "cannot_open";
    this.act(card, messageId, undefined, failure);
  }

  /**
   * The app's screens for saved links: each id once, at most 200, ids matching SCREEN_ID. A bad entry throws
   * in debug and is dropped (and logged) otherwise. Sent only with requests the SDK makes anyway.
   */
  registerScreens(list: AppScreen[]): void {
    const out = new Map<string, AppScreen>();
    for (const { id, title } of list) {
      if (typeof id != "string" || !SCREEN_ID.test(id) || out.has(id) || out.size > 199) {
        // Debug fails loudly; a release build drops the entry (the protocol, Saved links).
        if (this.debug) throw new Error(`registerScreens: bad id ${id}`);
      } else out.set(id, title ? { id, title: [...String(title)].slice(0, 60).join("") } : { id });
    }
    this.session.screens = [...out.values()];
  }

  /** A fresh URL for an attachment whose signed URL expired. */
  async attachmentUrl(id: string): Promise<string | undefined> {
    try {
      const res = await this.api.send({ method: "GET", path: `/attachments/${encodeURIComponent(id)}`, auth: "bearer" });
      return isObj(res.data) && typeof res.data.url === "string" ? res.data.url : undefined;
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Identity, moments, lifecycle
  // ---------------------------------------------------------------------------

  identify(identity: string | Identity): void {
    let id: Identity;
    if (typeof identity === "string") {
      const sub = tokenSubject(identity);
      if (!sub) {
        this.#problem("identity_token_invalid", "identify(token): not a JWT with a sub claim. Sign it on your server (HS256).");
        return;
      }
      id = { userId: sub, token: identity };
    } else id = identity;
    this.profile.stage({ identity: id });
  }

  setTraits(traits: Record<string, string | number | boolean>): void {
    const t: Record<string, string> = {};
    for (const [k, v] of Object.entries(traits)) t[k] = String(v);
    this.profile.stage({ traits: t });
  }

  async prepare(reason: SessionReason = "prepare"): Promise<void> {
    await this.session.token(reason);
  }

  async moment(name: string, props?: Record<string, string | number | boolean>): Promise<MomentResult> {
    if (!MOMENT_NAME.test(name)) {
      this.log.error(`moment: bad name. Use ${MOMENT_NAME.source}`);
      return { outcome: "invalid_name", open: false, presented: false };
    }
    if (!this.keyOk) return { outcome: "failed", open: false, presented: false, error: "key_invalid" };
    try {
      if (!this.#listened || this.rt.now() - this.#listened.at > LISTENED_TTL) {
        const res = await this.api.send({ method: "GET", path: "/moments/listened", auth: "key" });
        const names = isObj(res.data) && Array.isArray(res.data.names) ? res.data.names.filter((n): n is string => typeof n === "string") : [];
        this.#listened = { names: new Set(names), at: this.rt.now() };
      }
      if (!this.#listened.names.has(name)) return { outcome: "not_listened", open: false, presented: false };
      await this.session.token("moment");
      const body: Record<string, unknown> = { name, clientId: this.rt.uuid(), occurredAt: new Date(this.rt.wall()).toISOString() };
      if (props && Object.keys(props).length) body.props = props;
      const res = await this.api.send({ method: "POST", path: "/moments", auth: "bearer", scope: "moments", idempotent: true, body });
      const d = isObj(res.data) ? res.data : {};
      const outcome = (["ignored", "scheduled", "delivered", "held_out"] as const).find((o) => o === d.outcome) ?? "ignored";
      const open = d.open === true;
      const present = open && this.options.presentsChatForMoments !== false;
      if (present) this.open();
      return { outcome, open, presented: present };
    } catch (e) {
      this.fail(e);
      return { outcome: "failed", open: false, presented: false, error: e instanceof PingFrontError ? e.code : "unexpected" };
    }
  }

  /**
   * Clears everything this browser knows about the person. `session` false: the session store is already
   * replacing a revoked install (its new session must survive), so only the old person's state goes. `remote`:
   * another tab logged out, erased or saved another install; this page forgets the person from memory only, since
   * the stored state is now that tab's.
   */
  async #localWipe(session: boolean, remote = false): Promise<void> {
    this.live.stop();
    this.#stopUnread();
    this.rt.clearTimeout(this.#readTimer);
    this.rt.clearTimeout(this.#watch);
    this.#quit.abort();
    this.#quit = new AbortController();
    await this.outbox.clear(remote);
    await this.acts.clear(remote);
    // The install is gone (logout, erase, revoked): its push subscription goes with it.
    if (!remote) await this.#dropPush();
    if (session) {
      if (!remote) this.profile.clear();
      await this.session.wipe(remote);
    }
    this.api.reset();
    this.#configAt = -Infinity;
    this.#teamActionsSeen.clear();
    this.#teamActionsAnswered.clear();
    // The next guest's session starts only when it is needed (their first message). The old person's send policy and
    // identity problem go with them; a problem with the key or the origin is the app's and stays.
    const problem = this.state.problem?.code.startsWith("identity_") ? undefined : this.state.problem;
    this.update({ messages: [], pending: [], threadId: undefined, readSeq: 0, teamReadSeq: 0, lastSeq: 0, hasOlder: false, typing: null, unread: 0, notice: undefined, prefill: undefined, policy: { canSend: true }, replyExpectation: undefined, failed: false, problem });
  }

  /** Another tab logged out, erased or saved an install other than this page's: this page's person is gone. */
  #fromTab = (e: MessageEvent) => {
    const id: unknown = isObj(e.data) ? e.data.installId : undefined;
    if (this.destroyed || (id !== undefined && id === this.session.installId)) return;
    void this.#localWipe(true, true).then(() => id && this.retryOpen());
  };

  async logout(): Promise<void> {
    const creds = await this.session.credentials();
    if (creds) await this.#logoutQueue.add(creds);
    await this.#localWipe(true);
    this.#tabs?.postMessage({});
  }

  async eraseMyData(): Promise<void> {
    const creds = await this.session.credentials();
    this.session.erasing = true;
    this.live.stop();
    try {
      if (creds) {
        try {
          await this.api.send({ method: "DELETE", path: "/me", auth: "key", idempotent: true, body: creds });
        } catch (e) {
          // 401: the install is unknown, so there is nothing left on the server to erase.
          if (!(e instanceof PingFrontError) || e.status !== 401) throw e;
        }
      }
      await this.#localWipe(true);
      this.#tabs?.postMessage({});
    } finally {
      this.session.erasing = false;
    }
  }

  /** Reports the person's plan (web billing). Sent with the next PATCH /me once a session exists. */
  setEntitlement(entitlement: Entitlement): void {
    this.profile.stage({ entitlement });
  }

  /** Reports the paywalls the team can send as offer cards; replaces the earlier list. */
  setOffers(offers: OfferSlot[]): void {
    // Kept for the chat: an offer card whose paywall the app reports gone or unavailable shows as such.
    this.offers = offers;
    this.update({});
    this.profile.stage({ offers: offers.slice(0, 20).map((o) => ({ ...o, source: o.source ?? "app" })) });
  }

  /** Everything the server stores about this person, as the JSON document GET /me/export returns. */
  async exportMyData(): Promise<unknown> {
    this.#requireKey();
    await this.session.token("prepare");
    return (await this.api.send({ method: "GET", path: "/me/export", auth: "bearer" })).data;
  }

  /**
   * Files a bug report (POST /reports): it becomes a thread message with a receipt. Up to three
   * screenshots (image files) are prepared and uploaded like photos. `state` is short key/value context.
   */
  async reportBug(text: string, options: ReportOptions = {}): Promise<void> {
    this.#requireKey();
    if ([...text].length > 4000) throw new PingFrontError("server", "The report is longer than 4000 characters.", 0, "invalid_request");
    await this.session.token("prepare");
    const screenshotIds: string[] = [];
    for (const shot of (options.screenshots ?? []).slice(0, 3)) screenshotIds.push(await uploadPhoto(this.api, this.rt, await preparePhoto(shot, this.rt)));
    const body: Record<string, unknown> = { clientId: this.rt.uuid(), text, screenshotIds };
    if (options.logTail) body.logTail = utf8Tail(options.logTail, 65536);
    if (options.state) body.state = options.state;
    const res = await this.api.send({ method: "POST", path: "/reports", auth: "bearer", scope: "messages", idempotent: true, body });
    const m = isObj(res.data) ? decodeMessage(res.data.message) : undefined;
    if (m) this.update({ messages: mergeMessages(this.state.messages, [m]), lastSeq: Math.max(this.state.lastSeq, m.seq), readSeq: Math.max(this.state.readSeq, m.seq) });
    this.events.emit("reportSent", m);
  }

  #requireKey(): void {
    if (!this.keyOk) throw new PingFrontError("server", "Invalid app key: copy it from Dashboard > App > Connect.", 0, "invalid_app_key");
  }

  async selfCheck(timeoutMs = 20_000): Promise<SelfCheckResult> {
    const result = await this.#runSelfCheck(timeoutMs);
    const line = result.passed ? `${GLOBAL_NAME} self-check: PASS` : `${GLOBAL_NAME} self-check: FAIL ${result.code}: ${result.advice}`;
    console.info(line);
    return { ...result, line };
  }

  async #runSelfCheck(timeoutMs: number): Promise<Outcome> {
    const key = checkKey(this.appKey);
    if (!key.ok) return { passed: false, code: "key_invalid", advice: KEY_PROBLEM_MESSAGES[key.problem] };
    // A page that blocks the module (src/lazy/selfcheck.ts) gets a FAIL that says so.
    return (await loadModule("selfcheck"))?.run(this, timeoutMs) ?? { passed: false, code: "module_blocked", advice: "selfcheck.js did not load: serve locales/ next to the script and allow it in script-src." };
  }

  /** Nothing outlives destroy: the socket, retries, polls, receipts and coalesced profile changes stop. */
  destroy(): void {
    this.destroyed = true;
    this.#quit.abort();
    this.#tabs?.close();
    this.live.stop();
    this.#stopUnread();
    this.outbox.stop();
    this.#logoutQueue.stop();
    this.acts.stop();
    this.profile.clear();
    for (const t of [this.#readTimer, this.typingTimer, this.#typingShowTimer, this.#watch, this.#openTimer]) this.rt.clearTimeout(t);
    this.#listeners.clear();
    this.events.clear();
    this.pushEnv.serviceWorker?.removeEventListener("message", this.#onWorkerMessage);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.#onOnline);
      window.removeEventListener("offline", this.#onOffline);
      document.removeEventListener("visibilitychange", this.#onVisibility);
    }
  }
}

/** The last `max` UTF-8 bytes of `s`, cut at a character boundary. */
export function utf8Tail(s: string, max: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= max) return s;
  let start = bytes.length - max;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

function isPageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** The socket URL: config.liveUrl when the server sent one, else {baseUrl}/live, on ws(s). */
export function liveUrl(configured: string | undefined, base: string): string {
  const u = configured ?? `${base.replace(/\/+$/, "")}/live`;
  return u.replace(/^http(s?):/, "ws$1:");
}

const KEY_UNKNOWN = "Unknown app key: copy it from Dashboard > App > Connect (test and live keys differ).";

function identityAdvice(p: string): string {
  if (p === "user_mismatch") return `Another verified user owns this browser: call ${GLOBAL_NAME}.logout() first.`;
  if (p === "token_expired") return "Identity token expired: issue a new one (exp at most 24 h after iat).";
  if (p === "token_invalid") return "Identity token signature invalid: sign it with the identity secret (HS256).";
  return "Identity refused: check the token and user id.";
}

function originAdvice(): string {
  const origin = typeof location === "undefined" ? "this site" : location.origin;
  return `${origin} isn't allowed: add it under ${DASHBOARD_ORIGINS_PATH}.`;
}
