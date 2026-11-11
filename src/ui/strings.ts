/// <reference types="vite/client" />
// (import.meta.glob below is Vite's: the reference keeps it typed for any project that type-checks this
// source without Vite's client types, such as a docs site's snippet check.)
//
// The SDK's own text for everything a customer leaves unset. Customer text from the dashboard (welcome,
// placeholder, topics, …) always wins over these.
//
// English is built in. Every other language is a pack, `src/locales/<tag>.json`, with the same keys:
// templates with {app}, {name}, {time} and {n}, and plurals as objects keyed by Intl.PluralRules category.
// Packs load lazily: the npm build imports them as chunks the host's bundler serves, and the script build
// fetches them from the folder it was loaded from (see `packSource`). The list of languages is on
// https://pingfront.sh/docs/localization.
import en from "../locales/en.json";

type Plural = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
export type Pack = { [K in keyof typeof en]: (typeof en)[K] extends string ? string : Plural };
type Key = keyof Pack;

/** Every language the widget ships, as the tags of its packs (docs/localization-locales.md). */
export const LOCALES = [
  "en", "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "es", "es-419", "fa", "fi", "fr", "fr-CA", "gu", "he", "hi", "hr", "hu", "id",
  "it", "ja", "kn", "ko", "ml", "mr", "ms", "nb", "nl", "or", "pa", "pl", "pt-BR", "pt-PT", "ro", "ru", "sk", "sl", "sv", "ta", "te",
  "th", "tr", "uk", "ur", "vi", "zh-Hans", "zh-Hant", "zh-HK",
] as const;
export type Locale = (typeof LOCALES)[number];

const RTL = new Set<string>(["ar", "fa", "he", "ur"]);
const ALIAS: Record<string, string> = { iw: "he", in: "id", no: "nb", nn: "nb" };
const PT_PT = new Set(["PT", "AO", "MZ", "CV", "GW", "ST", "TL", "MO", "LU", "CH"]);

/**
 * The shipped language for a BCP 47 tag: the regional variant (Chinese by script, with zh-HK for Traditional Chinese in
 * Hong Kong and Macau; es-419, pt-PT, fr-CA), the base language, then English.
 */
export function resolveLocale(tag: string): Locale {
  let loc: Intl.Locale;
  try {
    loc = new Intl.Locale(tag);
  } catch {
    return "en";
  }
  const lang = ALIAS[loc.language] ?? loc.language;
  const region = loc.region ?? "";
  if (lang === "zh") {
    if (loc.script !== "Hant" && (loc.script || !["TW", "HK", "MO"].includes(region))) return "zh-Hans";
    return region === "HK" || region === "MO" ? "zh-HK" : "zh-Hant";
  }
  if (lang === "pt") return PT_PT.has(region) ? "pt-PT" : "pt-BR";
  if (lang === "es") return region && region !== "ES" && region !== "GQ" ? "es-419" : "es";
  const known = LOCALES as readonly string[];
  if (known.includes(`${lang}-${region}`)) return `${lang}-${region}` as Locale;
  return known.includes(lang) ? (lang as Locale) : "en";
}

export const isRtl = (locale: string): boolean => RTL.has(locale);

export type Strings = {
  /** The shipped language these strings are in. */
  locale: Locale;
  /** The welcome's line under the name, with the app's name when it is known (native wording). */
  welcomeBody: (app: string) => string;
  placeholder: string;
  replyExpectation: string;
  teamTitle: (app: string) => string;
  localTime: (time: string, name: string) => string;
  reachedOut: (name: string) => string;
  someone: string;
  open: string;
  openUnread: (n: number) => string;
  close: string;
  chat: string;
  messages: string;
  message: string;
  send: string;
  addPhoto: string;
  removePhoto: string;
  photo: string;
  photoRemoved: string;
  delivered: string;
  read: string;
  sending: string;
  /** A queued message while the browser is offline (native: "Waiting for connection"). */
  waitingConnection: string;
  /** A queued message waiting out a backoff, a rate limit or an unreachable service (native wording). */
  retrying: string;
  /** Online, but the service can't be reached (native wording, distinct from offline). */
  unreachable: string;
  /** The line under messages a closed policy holds: they send by themselves when it reopens (native wording). */
  held: (reason: string) => string;
  /** After the person's first message, before any reply (native wording; the header already says when to expect one). */
  closeHint: string;
  /** Under the close hint, when the host turned on the chat's offer and this browser hasn't decided (native wording). */
  turnOnNotifications: string;
  /** An offer card a newer offer card replaced (native wording). */
  replaced: string;
  /** An offer card whose offer is gone or unavailable to the person (native wording). */
  offerGone: string;
  notDelivered: string;
  /**
   * "Not delivered", with the reason for a send failure (a SendFailure key) when there is one to give. Only
   * these translated strings reach people, never an error's own (English) message.
   */
  notDeliveredBecause: (reason: string | undefined) => string;
  /** Sending a failed message again, and reloading after the conversation failed to load (native wording). */
  tryAgain: string;
  /** Discarding a failed message (iOS "Delete"). */
  remove: string;
  /** In place of a card's button when the card can't act on this page (iOS: "Not available in this app"). */
  notAvailable: string;
  offline: string;
  /** A configuration problem on a production page (the details go to the console). */
  unavailable: string;
  /** The thread didn't load while online. */
  loadFailed: string;
  /** Sending is rate limited for 5 minutes or more (native wording). */
  rateLimited: string;
  /** Sending is rate limited for less: "You can send again in 0:40." (native wording and m:ss format). */
  rateCountdown: (time: string) => string;
  /** Photos are rate limited; text still sends (native wording): under 5 minutes with m:ss, then plain. */
  photosCountdown: (time: string) => string;
  photosPaused: string;
  blocked: string;
  paused: string;
  verification: string;
  branding: string;
  older: string;
  typing: (name?: string) => string;
  today: string;
  yesterday: string;
  you: string;
  said: (name: string) => string;
  ai: string;
  over: (n: number) => string;
  unsupported: string;
  stars: (n: number, total: number) => string;
  dropHere: string;
  /** The review card's title and line (native "Enjoying {app}?"); without an app name, "Leave a review" and none. */
  review: (app: string) => { title: string; body?: string };
  /**
   * Default copy for a store action card on the web, where each opens the store's own web page: iOS's words where
   * they hold for either store's page (refund and redeem keep store-neutral lines). An unknown action reads as
   * managing the subscription, as on iOS.
   */
  storeAction: (action: string) => { title: string; body: string; button?: string };
};

/** The strings whose name is a pack key and whose value is that key's text. */
type PlainKey = { [K in keyof Strings & Key]: Strings[K] extends string ? K : never }[keyof Strings & Key];

const fill = (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

/**
 * The stars line agrees with the number its noun counts: the rating in these languages, whose noun follows it
 * ("1 étoile sur 5"), else the total ("1 of 5 stars"). Android's pf_stars_plural_on and iOS's catalog pick the same
 * (scripts/locales-check.mjs).
 */
const STARS_ON_RATING = new Set<string>(["fr", "fr-CA", "it", "bn", "gu", "hi", "kn", "ml", "mr", "or", "pa", "te"]);

/** The strings for a shipped language from its pack; a key the pack lacks uses English. */
export function build(locale: Locale, pack: Partial<Pack> = {}): Strings {
  const rules = new Intl.PluralRules(locale);
  const num = new Intl.NumberFormat(locale);
  const s = (k: Key, vars: Record<string, string> = {}) => {
    const v = pack[k] ?? en[k];
    return fill(typeof v === "string" ? v : v.other, vars);
  };
  // The form for `n` (the count the sentence agrees with), filled with `vars` (default: n itself).
  const p = (k: Key, n: number, vars: Record<string, string> = { n: num.format(n) }) => {
    const v = (pack[k] ?? en[k]) as Plural;
    return fill(v[rules.select(n)] ?? v.other, vars);
  };
  // A store action's copy is <prefix>Title, <prefix>Body and <prefix>Button (restoring has no button on the web).
  const store: Record<string, string> = { manage_subscriptions: "manage", billing_issue: "billing", request_refund: "refund", redeem_code: "redeem", restore_purchases: "restore" };
  // A failure's reason: fail<Reason> (photo_type is failPhotoType); a policy refusal names its notice.
  const why = (f: string) => (/^(blocked|paused|verification)$/.test(f) ? f : `fail${f.replace(/(?:^|_)(\w)/g, (_, c: string) => c.toUpperCase())}`) as Key;
  // Every plain string whose name is its key comes straight from the pack (English where the pack lacks it).
  const plain = Object.fromEntries(Object.keys(en).map((k) => [k, s(k as Key)])) as Pick<Strings, PlainKey>;
  return {
    ...plain,
    locale,
    welcomeBody: (app) => (app ? s("welcomeBodyApp", { app }) : s("welcomeBody")),
    teamTitle: (app) => (app ? s("teamTitle", { app }) : s("theTeam")),
    localTime: (time, name) => s("localTime", { time, name }),
    reachedOut: (name) => s("reachedOut", { name }),
    someone: s("theTeam"),
    openUnread: (n) => p("openUnread", n),
    held: (reason) => s(reason === "verification_required" ? "heldVerification" : "heldPaused"),
    notDeliveredBecause: (reason) => (reason && why(reason) in en ? s("notDeliveredWhy", { reason: s(why(reason)) }) : s("notDelivered")),
    rateCountdown: (time) => s("rateCountdown", { time }),
    photosCountdown: (time) => s("photosCountdown", { time }),
    typing: (name) => (name ? s("typingName", { name }) : s("typing")),
    said: (name) => s("said", { name }),
    over: (n) => p("over", n),
    stars: (n, total) => p("stars", STARS_ON_RATING.has(locale) ? n : total, { n: num.format(n), total: num.format(total) }),
    review: (app) => (app ? { title: s("reviewTitle", { app }), body: s("reviewBody", { app }) } : { title: s("rate") }),
    storeAction: (action) => {
      const p = store[action] ?? "manage";
      return { title: s(`${p}Title` as Key), body: s(`${p}Body` as Key), button: p === "restore" ? undefined : s(`${p}Button` as Key) };
    },
  };
}

/** Where packs come from: resolves to a pack's JSON, or undefined when it can't be loaded. */
export type PackSource = (locale: Locale) => Promise<unknown>;

declare const __PF_SCRIPT__: boolean;
// The npm build: each pack is its own chunk, fetched by the host's bundler from the host's origin. The
// script build replaces this (script.ts) and the chunks are not part of it.
const chunks = __PF_SCRIPT__ ? {} : import.meta.glob<unknown>(["../locales/*.json", "!../locales/en.json"], { import: "default" });
let source: PackSource = (locale) => chunks[`../locales/${locale}.json`]?.() ?? Promise.resolve(undefined);

/** Replaces where packs load from (the script build fetches them next to itself). */
export function setPackSource(fn: PackSource): void {
  source = fn;
  cache.clear();
}

const isPack = (v: unknown): v is Partial<Pack> => {
  if (!v || typeof v !== "object") return false;
  for (const [k, x] of Object.entries(v)) {
    if (!(k in en)) continue;
    const want = typeof en[k as Key];
    if (want === "string" ? typeof x !== "string" : !x || typeof x !== "object" || typeof (x as Plural).other !== "string") return false;
  }
  return true;
};

const english = build("en", en);
const cache = new Map<Locale, Promise<Strings>>();

/** The strings for a language tag. English is immediate; other languages load their pack once, and use English if it can't load. */
export function loadStrings(tag: string): Promise<Strings> {
  const locale = resolveLocale(tag);
  if (locale === "en") return Promise.resolve(english);
  let hit = cache.get(locale);
  if (!hit) {
    hit = source(locale).then(
      (pack) => (isPack(pack) ? build(locale, pack) : english),
      () => english,
    );
    cache.set(locale, hit);
  }
  return hit;
}

/** English, the strings the widget shows until a language's pack has loaded. */
export const ENGLISH: Strings = english;
