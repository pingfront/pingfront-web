// pingfront for the web: the public API. `configure()` checks the key offline and sends nothing; the
// first request happens when the chat opens, a listened moment is reported, or prepare()/selfCheck() runs.
import { GLOBAL_NAME } from "./constants.js";
import { Engine, type MomentResult, type OfferRequest, type Options, type Problem, type PushOptions, type ReportOptions, type ScreenTarget, type SelfCheckResult } from "./core/engine.js";
import type { AppScreen } from "./core/wire.js";
import type { PushStatus } from "./core/push.js";
import type { Entitlement, Identity, OfferSlot } from "./core/profile.js";
import { isOpenable, parseChatLink } from "./core/links.js";
import { ChatElement, defineElement } from "./ui/element.js";

export type { Options, OfferRequest, Problem, MomentResult, PushOptions, ReportOptions, ScreenTarget, SelfCheckResult } from "./core/engine.js";
export type { AppScreen } from "./core/wire.js";
export type { PushStatus } from "./core/push.js";
export type { Entitlement, Identity, OfferSlot, Traits } from "./core/profile.js";
export type { LogEntry, LogHandler, LogLevel } from "./core/log.js";
export type { Appearance, CodeTopic } from "./core/look.js";
export type { Message, Part, Card, PersonSummary, ServerEvent, TeamActionPayload, WebPushPayload } from "./core/model.js";
import type { PersonSummary } from "./core/model.js";
import type { TeamActionPayload } from "./core/model.js";
export { PingFrontError } from "./core/api.js";
export { SDK_VERSION } from "./constants.js";

/**
 * Events for `on()`. Any other name works too: "live" carries every server frame, including unknown ones.
 * `chatOpened` and `messageSent`, the native SDKs' names, are the same events as `open` and `sent`.
 */
export type EventName = "message" | "unread" | "open" | "close" | "offer" | "link" | "problem" | "sent" | "reportSent" | "cardOpened" | "teamAction" | "sessionRevoked" | "chatOpened" | "messageSent" | "live" | "*" | (string & {});

/** The native SDKs' event names that are another name for a web event. */
const NATIVE_NAMES = new Map([["chatOpened", "open"], ["messageSent", "sent"]]);

/** Delivered on `on("cardOpened")` when the person taps a card or answers one (choices, rating), as on iOS and Android. */
export type OpenedCard = { kind: "offer" | "review" | "link" | "choices" | "rating" | "report" | "store_action" | (string & {}); cardId: string; messageId: string };

/**
 * Delivered on `on("teamAction")` when a teammate runs a "Fix it for them" action. Do the work, then call
 * `complete()` or `fail(message)` once. Each action arrives once, live or caught up after a reconnect.
 */
export type TeamAction = TeamActionPayload & { complete(): Promise<void>; fail(message: string): Promise<void> };

export type Instance = {
  /** Set or change the person. A verified identity token (HS256, signed by your server) gives one thread across devices. */
  identify(identity: string | Identity): void;
  setTraits(traits: Record<string, string | number | boolean>): void;
  /** Forgets this browser's person (the server is told, with retries). The next session is a new guest. */
  logout(): Promise<void>;
  /** Erases every server-side record of this person, then wipes this browser. */
  eraseMyData(): Promise<void>;
  /** Everything the server stores about this person (GET /me/export), as parsed JSON. */
  exportMyData(): Promise<unknown>;
  /** Reports the person's plan from your web billing (for example Stripe). */
  setEntitlement(entitlement: Entitlement): void;
  /** Reports the paywalls the team can send as offer cards. */
  setOffers(offers: OfferSlot[]): void;
  /** Files a bug report with up to three screenshots; it appears in the thread with a receipt. */
  reportBug(text: string, options?: ReportOptions): Promise<void>;
  /**
   * Turns on web push for this browser. Shows the browser's permission prompt, so call it from a
   * person's action (a button), never on load. Serve pingfront-sw.js from your origin first.
   */
  enablePush(options?: PushOptions): Promise<PushStatus>;
  /** Turns web push off for this browser. */
  disablePush(): Promise<void>;
  open(options?: { topic?: string }): void;
  close(): void;
  /**
   * The chat's language, for apps with their own language picker: a BCP 47 tag such as "de" or "pt-BR", or
   * undefined to follow the browser. The chat re-renders in it at once, without configuring again. An invalid tag
   * is ignored and logged.
   */
  setLocale(tag: string | undefined): void;
  /** The language the chat uses now. */
  readonly locale: string;
  /**
   * Opens the chat for a chat link, a URL whose query has `pingfront=chat` or `pingfront=report` (the web's bug
   * report is the composer), with an optional `topic` that applies only when it is one of the chat's topics.
   * Returns true when it handled the link and false for any other URL, which you route yourself. Sends nothing
   * itself: the chat opening starts the session, as `open()` does. `configure` already runs it for the page's
   * own URL; when `url` is the page's address, `pingfront` and `topic` are removed from the address bar.
   */
  handleUrl(url?: string | URL): boolean;
  /** Reports a moment; only moments a play listens to are sent. */
  moment(name: string, props?: Record<string, string | number | boolean>): Promise<MomentResult>;
  /** Called now with the current count and on every change. Returns an unsubscribe function. */
  onUnreadCount(fn: (count: number) => void): () => void;
  on<T = unknown>(event: EventName, fn: (event: T) => void): () => void;
  /** Opens your paywall for an offer card. */
  onOffer(fn: ((request: OfferRequest) => void) | null): void;
  /** Return true to handle a link yourself (deep links); otherwise it opens in a new tab. */
  onLink(fn: ((url: URL) => boolean | void) | null): void;
  /**
   * Your app's screens, so the team's saved links can open them: `{ id, title? }`, ids like "settings.sound"
   * (`^[A-Za-z0-9][A-Za-z0-9_./:-]{0,99}$`), each once, at most 200. The title is what your team sees, never
   * the person. A bad entry throws in debug (localhost, or `debug: true`) and is dropped otherwise. Sent only
   * with requests the chat makes anyway; call it again to replace the list.
   */
  registerScreens(screens: AppScreen[]): void;
  /**
   * Opens one of your registered screens for a link card. Return true (or a Promise of true) once it opened;
   * false reports the link as not handled. Cards for screens you didn't register open their web address instead.
   */
  onScreen(fn: ((screen: ScreenTarget) => boolean | Promise<boolean>) | null): void;
  /** Sends "Setup check from <app>" and prints `PingFront self-check: PASS` or `FAIL <code>: <what to do>`. */
  selfCheck(): Promise<SelfCheckResult>;
  /** Creates the session now (for example right after sign-in). */
  prepare(): Promise<void>;
  readonly unreadCount: number;
  readonly isOpen: boolean;
  /** The person this browser's session belongs to, once a session exists. */
  readonly person: PersonSummary | undefined;
  /** The team marked this browser as a test device (it sees the draft look). */
  readonly isTestDevice: boolean;
  /** The token your server passes to Stripe or the stores to tie purchases to this person, once a session exists. */
  readonly storeAccountToken: string | undefined;
  readonly problem: Problem | undefined;
  /** Removes the chat from the page and stops everything. */
  destroy(): void;
};

/** One chat for one app key. Most pages use the `PingFront` singleton instead. */
export function create(appKey: string, options: Options = {}): Instance {
  return build(appKey, options);
}

/** `link`: a chat link the page handled before configure, applied once instead of the page's own URL. */
function build(appKey: string, options: Options, link?: string): Instance {
  const engine = new Engine(appKey, options, link);
  let element: ChatElement | undefined;
  if (typeof document !== "undefined" && typeof customElements !== "undefined") {
    defineElement();
    const el = (element = new ChatElement());
    el.attach(engine, options.launcher !== false, Boolean(options.container), options.launcherOffset);
    // A script tag in <head> without defer runs before <body> exists: mount once it does.
    const mount = () => element && (options.container ?? document.body).appendChild(el);
    if (options.container || document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount, { once: true });
  }
  return {
    identify: (i) => engine.identify(i),
    setTraits: (t) => engine.setTraits(t),
    logout: () => engine.logout(),
    eraseMyData: () => engine.eraseMyData(),
    exportMyData: () => engine.exportMyData(),
    setEntitlement: (e) => engine.setEntitlement(e),
    setOffers: (o) => engine.setOffers(o),
    reportBug: (t, o) => engine.reportBug(t, o),
    enablePush: (o) => engine.enablePush(o),
    disablePush: () => engine.disablePush(),
    open: (o) => engine.open(o?.topic),
    close: () => engine.close(),
    setLocale: (t) => void engine.setLocale(t),
    get locale() {
      return engine.lang;
    },
    handleUrl: (u) => engine.handleUrl(u),
    moment: (n, p) => engine.moment(n, p),
    onUnreadCount: (fn) => {
      fn(engine.state.unread);
      return engine.events.on<number>("unread", fn);
    },
    on: (name, fn) => {
      const e = NATIVE_NAMES.get(name) ?? name;
      const off = engine.events.on(e, fn);
      // Offer and link buttons show once something handles them: draw the chat again.
      if (e === "offer" || e === "link" || e === "*") engine.update({});
      return off;
    },
    onOffer: (fn) => {
      engine.onOffer = fn ?? undefined;
      engine.update({});
    },
    onLink: (fn) => {
      engine.onLink = fn ?? undefined;
      engine.update({});
    },
    registerScreens: (s) => engine.registerScreens(s),
    onScreen: (fn) => void (engine.onScreen = fn ?? undefined),
    selfCheck: () => engine.selfCheck(),
    prepare: () => engine.prepare(),
    get unreadCount() {
      return engine.state.unread;
    },
    get isOpen() {
      return engine.state.visible;
    },
    get person() {
      return engine.session.info.person;
    },
    get isTestDevice() {
      return engine.session.info.testDevice;
    },
    get storeAccountToken() {
      return engine.session.info.storeAccountToken;
    },
    get problem() {
      return engine.state.problem;
    },
    destroy: () => {
      engine.destroy();
      element?.remove();
      element = undefined;
    },
  };
}

let current: Instance | undefined;
/** A chat link handled before configure: kept in memory only, the last one wins, applied once. */
let queuedLink: string | undefined;
const need = (): Instance | undefined => {
  if (!current) console.error(`${GLOBAL_NAME}: call ${GLOBAL_NAME}.configure("pk_…") first.`);
  return current;
};

/** The chat for this page. `PingFront.configure("pk_live_…")` once, then call the rest anywhere. */
export const PingFront = {
  /** Checks the key offline and adds the launcher. Sends nothing. Calling it again replaces the chat. */
  configure(appKey: string, options: Options = {}): Instance {
    current?.destroy();
    const link = queuedLink;
    queuedLink = undefined;
    current = build(appKey, options, link);
    return current;
  },
  /**
   * Opens the chat for a chat link (`?pingfront=chat` or `?pingfront=report`, optional `topic`) and returns
   * true; false for any other URL. Before `configure`, a chat link is kept and applied once by `configure`.
   * Default: the page's own address.
   */
  handleUrl(url?: string | URL): boolean {
    if (current) return current.handleUrl(url);
    const target = url ?? (typeof location === "undefined" ? undefined : location.href);
    if (!isOpenable(parseChatLink(target))) return false;
    queuedLink = String(target instanceof URL ? target.href : target);
    return true;
  },
  identify: (i: string | Identity) => need()?.identify(i),
  setTraits: (t: Record<string, string | number | boolean>) => need()?.setTraits(t),
  logout: async () => need()?.logout(),
  eraseMyData: async () => need()?.eraseMyData(),
  exportMyData: async (): Promise<unknown> => need()?.exportMyData(),
  setEntitlement: (e: Entitlement) => need()?.setEntitlement(e),
  setOffers: (o: OfferSlot[]) => need()?.setOffers(o),
  reportBug: async (t: string, o?: ReportOptions) => need()?.reportBug(t, o),
  enablePush: async (o?: PushOptions): Promise<PushStatus> => need()?.enablePush(o) ?? "failed",
  disablePush: async () => need()?.disablePush(),
  open: (o?: { topic?: string }) => need()?.open(o),
  close: () => need()?.close(),
  setLocale: (t: string | undefined) => need()?.setLocale(t),
  get locale(): string | undefined {
    return current?.locale;
  },
  moment: async (n: string, p?: Record<string, string | number | boolean>): Promise<MomentResult> =>
    need()?.moment(n, p) ?? { outcome: "failed", open: false, presented: false, error: "not_configured" },
  onUnreadCount: (fn: (count: number) => void) => need()?.onUnreadCount(fn) ?? (() => undefined),
  on: <T = unknown>(e: EventName, fn: (event: T) => void) => need()?.on(e, fn) ?? (() => undefined),
  onOffer: (fn: ((r: OfferRequest) => void) | null) => need()?.onOffer(fn),
  onLink: (fn: ((url: URL) => boolean | void) | null) => need()?.onLink(fn),
  registerScreens: (s: AppScreen[]) => need()?.registerScreens(s),
  onScreen: (fn: ((s: ScreenTarget) => boolean | Promise<boolean>) | null) => need()?.onScreen(fn),
  selfCheck: async (): Promise<SelfCheckResult> =>
    need()?.selfCheck() ?? { passed: false, code: "not_configured", advice: `Call ${GLOBAL_NAME}.configure("pk_…") first.`, line: `${GLOBAL_NAME} self-check: FAIL not_configured` },
  prepare: async () => need()?.prepare(),
  get unreadCount() {
    return current?.unreadCount ?? 0;
  },
  get isOpen() {
    return current?.isOpen ?? false;
  },
  get person() {
    return current?.person;
  },
  get isTestDevice() {
    return current?.isTestDevice ?? false;
  },
  get storeAccountToken() {
    return current?.storeAccountToken;
  },
  get problem() {
    return current?.problem;
  },
};

export default PingFront;
