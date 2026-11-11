// Lenient, allocation-light decoders for what the server sends. They accept everything the contract
// allows (checked against the contract's fixtures), ignore unknown properties,
// and turn unknown enum values, part types, card kinds and live events into "unknown" cases instead of
// throwing. A value that breaks a required field drops only itself (a part, a field, a message).
import type * as M from "./model.js";

type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | undefined => values.find((x) => x === v);
const orUnknown = <T extends string>(v: unknown, values: readonly T[]): T | "unknown" => oneOf(v, values) ?? "unknown";

/** Copies only the defined values (so decoded objects compare equal to the wire value). */
function clean<T extends Obj>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

export function perMode(v: unknown): M.PerMode | undefined {
  if (!isObj(v)) return undefined;
  const light = str(v.light);
  const dark = str(v.dark);
  return light && dark && HEX.test(light) && HEX.test(dark) ? { light, dark } : undefined;
}

export function localized(v: unknown): M.Localized | undefined {
  if (!isObj(v) || typeof v.default !== "string" || !v.default) return undefined;
  const out: M.Localized = { default: v.default };
  for (const [k, x] of Object.entries(v)) if (typeof x === "string" && x) out[k] = x;
  return out;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const STORE_ACTIONS = ["manage_subscriptions", "billing_issue", "request_refund", "redeem_code", "restore_purchases"] as const;
const OFFER_KINDS = ["promotional", "winback", "code", "intro"] as const;
const RECEIPTS = ["trial_extended", "promo_granted", "purchases_restored", "report_filed", "data_exported", "custom", "handed_off"] as const;

function storeOffer(v: unknown): M.StoreOffer | undefined {
  if (!isObj(v) || typeof v.id !== "string" || !v.id) return undefined;
  return clean({
    kind: orUnknown(v.kind, OFFER_KINDS),
    id: v.id,
    productId: str(v.productId),
    basePlanId: str(v.basePlanId),
    offerId: str(v.offerId),
  });
}

export function decodeCard(v: unknown): M.Card {
  const name = isObj(v) ? String(v.kind ?? "") : "";
  const unknown = (): M.UnknownCard => clean({ kind: "unknown" as const, id: isObj(v) ? str(v.id) : undefined, name, raw: v });
  if (!isObj(v)) return unknown();
  const id = str(v.id);
  if (!id) return unknown();
  switch (v.kind) {
    case "offer": {
      const offerId = str(v.offerId);
      const title = str(v.title);
      const button = str(v.button);
      if (offerId === undefined || title === undefined || button === undefined) return unknown();
      return clean({ kind: "offer" as const, id, offerId, title, body: str(v.body), button, offer: storeOffer(v.offer) });
    }
    case "review": {
      const button = str(v.button);
      if (button === undefined) return unknown();
      return clean({ kind: "review" as const, id, mode: orUnknown(v.mode, ["native_prompt", "store_page"] as const), storeUrl: str(v.storeUrl), button });
    }
    case "link": {
      const title = str(v.title);
      const url = str(v.url);
      const button = str(v.button);
      if (title === undefined || url === undefined || button === undefined) return unknown();
      // A screen with an id the SDK can't use is left out, so the card falls back to `url` (the protocol, Saved links).
      const s = isObj(v.screen) && str(v.screen.id) ? v.screen : undefined;
      // Parameters that aren't strings are left out, as on iOS and Android.
      const params = isObj(s?.params) ? Object.fromEntries(Object.entries(s.params).filter((e): e is [string, string] => typeof e[1] === "string")) : undefined;
      return clean({ kind: "link" as const, id, title, url, button, screen: s && clean({ id: s.id as string, params }), savedLinkId: str(v.savedLinkId) });
    }
    case "choices": {
      const options = arr(v.options).flatMap((o) => (isObj(o) && typeof o.id === "string" && o.id && typeof o.label === "string" ? [{ id: o.id, label: o.label }] : []));
      if (options.length < 2) return unknown();
      return { kind: "choices", id, options };
    }
    case "rating": {
      const question = str(v.question);
      if (question === undefined) return unknown();
      return { kind: "rating", id, question, scale: 5 };
    }
    case "report": {
      const title = str(v.title);
      const button = str(v.button);
      if (title === undefined || button === undefined) return unknown();
      return { kind: "report", id, title, button };
    }
    case "store_action":
      return clean({
        kind: "store_action" as const,
        id,
        action: orUnknown(v.action, STORE_ACTIONS),
        title: str(v.title),
        body: str(v.body),
        button: str(v.button),
        productId: str(v.productId),
        subscriptionGroupId: str(v.subscriptionGroupId),
        transactionId: str(v.transactionId),
        store: v.store === undefined ? undefined : orUnknown(v.store, ["app_store", "play"] as const),
      });
    default:
      return unknown();
  }
}

export function decodePart(v: unknown): M.Part {
  const name = isObj(v) ? String(v.type ?? "") : "";
  const unknown = (): M.UnknownPart => ({ type: "unknown", name, raw: v });
  if (!isObj(v)) return unknown();
  switch (v.type) {
    case "text":
      return typeof v.text === "string" ? { type: "text", text: v.text } : unknown();
    case "image": {
      const attachmentId = str(v.attachmentId);
      const width = int(v.width);
      const height = int(v.height);
      if (!attachmentId || !width || !height) return unknown();
      // A photo retention deleted has no bytes: keep the flag, drop any url so nothing fetches it.
      if (v.removed === true) return { type: "image", attachmentId, width, height, removed: true };
      return clean({ type: "image" as const, attachmentId, width, height, url: str(v.url) });
    }
    case "card": {
      if (!isObj(v.card)) return unknown();
      const r = v.result;
      const result = isObj(r) && typeof r.at === "string" && r.at ? clean({ at: r.at, choiceId: str(r.choiceId), rating: int(r.rating) }) : undefined;
      return clean({ type: "card" as const, card: decodeCard(v.card), result });
    }
    case "receipt":
      return typeof v.text === "string" ? { type: "receipt", action: orUnknown(v.action, RECEIPTS), text: v.text } : unknown();
    default:
      return unknown();
  }
}

export function decodeMessage(v: unknown): M.Message | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const seq = int(v.seq);
  const createdAt = str(v.createdAt);
  const a = v.author;
  if (!id || seq === undefined || !createdAt || !isObj(a) || !Array.isArray(v.parts)) return null;
  const author: M.Author = clean({ kind: orUnknown(a.kind, ["person", "team", "ai", "system"] as const), id: str(a.id), name: str(a.name), avatarUrl: str(a.avatarUrl) });
  const p = v.ping;
  const ping: M.PingOrigin | undefined = isObj(p) && typeof p.explanation === "string"
    ? clean({ kind: orUnknown(p.kind, ["manual", "play"] as const), explanation: p.explanation, playId: str(p.playId) })
    : undefined;
  const t = v.translation;
  const translation = isObj(t) && typeof t.language === "string" && t.language
    ? { language: t.language, parts: arr(t.parts).flatMap((x) => (isObj(x) && x.type === "text" && typeof x.text === "string" ? [{ type: "text" as const, text: x.text }] : [])) }
    : undefined;
  return clean({
    id,
    seq,
    clientId: str(v.clientId),
    author,
    parts: v.parts.map(decodePart),
    createdAt,
    ping,
    fallback: str(v.fallback),
    translation,
  });
}

const decodeMessages = (v: unknown): M.Message[] => arr(v).flatMap((m) => decodeMessage(m) ?? []);

function decodeTeamMember(v: unknown): M.TeamMember | null {
  if (!isObj(v) || typeof v.id !== "string" || !v.id || typeof v.name !== "string") return null;
  return clean({ id: v.id, name: v.name, role: str(v.role), avatarUrl: str(v.avatarUrl), timeZone: str(v.timeZone) });
}
const team = (v: unknown) => arr(v).flatMap((m) => decodeTeamMember(m) ?? []);

function decodeThreadState(v: unknown): M.ThreadState | null {
  if (!isObj(v) || typeof v.id !== "string" || !v.id) return null;
  const n = (k: string) => int(v[k]) ?? 0;
  return { id: v.id, status: orUnknown(v.status, ["open", "resolved"] as const), lastSeq: n("lastSeq"), readSeq: n("readSeq"), teamReadSeq: n("teamReadSeq"), unread: n("unread"), rev: n("rev") };
}

function decodePolicy(v: unknown): M.SendPolicy {
  if (!isObj(v)) return { canSend: true };
  return clean({ canSend: bool(v.canSend) ?? true, reason: v.reason === undefined ? undefined : orUnknown(v.reason, ["blocked", "app_paused", "verification_required"] as const) });
}

export function decodeThreadResponse(v: unknown): M.ThreadResponse {
  const o = isObj(v) ? v : {};
  return clean({
    thread: decodeThreadState(o.thread),
    messages: decodeMessages(o.messages),
    hasOlder: bool(o.hasOlder) ?? false,
    team: team(o.team),
    replyExpectation: str(o.replyExpectation),
    policy: decodePolicy(o.policy),
  });
}

export function decodeMessagesPage(v: unknown): M.MessagesPage {
  const o = isObj(v) ? v : {};
  return { messages: decodeMessages(o.messages), hasMore: bool(o.hasMore) ?? false };
}

// ---------------------------------------------------------------------------
// Look and config
// ---------------------------------------------------------------------------

const SYMBOLS = ["billing", "bug", "idea", "question", "account", "feedback", "gift", "restore", "privacy", "other"] as const;
const TOPIC_ID = /^[a-z0-9_-]{1,32}$/;

/** Every field on its own: one unreadable field drops only itself. */
export function decodeLook(v: unknown): M.LookLayer {
  const o = isObj(v) ? v : {};
  const sec = (k: string): Obj => {
    const x = o[k];
    return isObj(x) ? x : {};
  };
  const th = sec("theme");
  const he = sec("header");
  const we = sec("welcome");
  const co = sec("composer");
  const me = sec("messages");
  const topics: M.Topic[] = arr(o.topics).flatMap((t) => {
    if (!isObj(t) || typeof t.id !== "string" || !TOPIC_ID.test(t.id)) return [];
    const label = localized(t.label);
    if (!label) return [];
    return [clean({ id: t.id, label, symbol: oneOf(t.symbol, SYMBOLS) ?? "other", prefill: localized(t.prefill) })];
  });
  const aiName = str(o.aiName);
  return clean({
    theme: clean({
      accent: perMode(th.accent),
      background: perMode(th.background),
      teamBubble: perMode(th.teamBubble),
      scheme: oneOf(th.scheme, ["auto", "light", "dark"] as const),
      font: oneOf(th.font, ["system", "rounded", "serif"] as const),
      corners: oneOf(th.corners, ["round", "soft", "square"] as const),
      density: oneOf(th.density, ["comfortable", "compact"] as const),
    }),
    header: clean({
      style: oneOf(he.style, ["person", "team", "app"] as const),
      memberId: str(he.memberId),
      title: localized(he.title),
      showLocalTime: bool(he.showLocalTime),
      showReplyExpectation: bool(he.showReplyExpectation),
    }),
    welcome: clean({ title: localized(we.title), body: localized(we.body), showFaces: bool(we.showFaces) }),
    topics: topics.slice(0, 6),
    composer: clean({ placeholder: localized(co.placeholder), photos: bool(co.photos), reports: bool(co.reports) }),
    messages: clean({ showNames: bool(me.showNames), showAvatars: bool(me.showAvatars), timestamps: oneOf(me.timestamps, ["grouped", "always"] as const) }),
    replyExpectation: localized(o.replyExpectation),
    aiName: aiName && aiName.length > 0 ? aiName : undefined,
  });
}

export function decodeConfig(v: unknown): M.AppConfig {
  const o = isObj(v) ? v : {};
  const f = isObj(o.features) ? o.features : {};
  return clean({
    revision: int(o.revision) ?? 0,
    draft: bool(o.draft) ?? false,
    appName: str(o.appName) ?? "",
    appIconUrl: str(o.appIconUrl),
    look: decodeLook(o.look),
    team: team(o.team),
    // A missing flag means "allowed": the composer toggles still apply.
    features: { photos: bool(f.photos) ?? true, reports: bool(f.reports) ?? true, translation: bool(f.translation) ?? false, ai: bool(f.ai) ?? false, branding: bool(f.branding) ?? false },
    liveUrl: str(o.liveUrl),
    webPushKey: str(o.webPushKey),
  });
}

/** PersonWebPushPayload: undefined unless it is version 1 with an app, a title and a body. */
export function decodeWebPushPayload(v: unknown): M.WebPushPayload | undefined {
  if (!isObj(v) || v.v !== 1) return undefined;
  const appId = str(v.appId);
  const title = str(v.title);
  const body = str(v.body);
  if (appId === undefined || title === undefined || body === undefined) return undefined;
  const unread = int(v.unread);
  return clean<M.WebPushPayload>({
    kind: orUnknown(v.kind, ["message", "ping", "config"] as const),
    appId,
    threadId: str(v.threadId),
    messageId: str(v.messageId),
    unread: unread !== undefined && unread >= 0 ? unread : undefined,
    title,
    body,
    tag: str(v.tag),
    silent: bool(v.silent) === true ? true : undefined,
  });
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

export function decodeServerEvent(v: unknown): M.ServerEvent {
  const name = isObj(v) ? String(v.type ?? "") : "";
  const unknown = (): M.ServerEvent => ({ type: "unknown", name, raw: v });
  if (!isObj(v)) return unknown();
  switch (v.type) {
    case "hello": {
      const lastSeq = int(v.lastSeq);
      const readSeq = int(v.readSeq);
      if (lastSeq === undefined || readSeq === undefined) return unknown();
      return clean({ type: "hello" as const, threadId: v.threadId === null ? null : str(v.threadId), rev: int(v.rev), status: str(v.status), lastSeq, readSeq, teamReadSeq: int(v.teamReadSeq) });
    }
    case "message":
    case "message_updated": {
      const message = decodeMessage(v.message);
      const seq = int(v.seq);
      if (!message || seq === undefined) return unknown();
      return { type: v.type, seq, message };
    }
    case "typing": {
      const a = isObj(v.author) ? v.author : null;
      const on = bool(v.on);
      if (!a || on === undefined) return unknown();
      return { type: "typing", author: clean({ kind: orUnknown(a.kind, ["team", "ai"] as const), name: str(a.name) }), on };
    }
    case "read": {
      const upToSeq = int(v.upToSeq);
      return upToSeq === undefined ? unknown() : { type: "read", by: String(v.by ?? "team"), upToSeq };
    }
    case "thread":
      return { type: "thread", status: orUnknown(v.status, ["open", "resolved"] as const) };
    case "reset":
    case "reauth":
      return { type: v.type };
    case "thread_reset": {
      const threadId = str(v.threadId);
      return threadId ? { type: "thread_reset", threadId } : unknown();
    }
    case "config":
      return { type: "config", revision: int(v.revision) ?? 0, draft: bool(v.draft) ?? false };
    case "team_action": {
      const action = decodeTeamAction(v.action);
      return action ? { type: "team_action", action } : unknown();
    }
    default:
      return unknown();
  }
}

export function decodeTeamAction(v: unknown): M.TeamActionPayload | undefined {
  if (!isObj(v)) return undefined;
  const id = str(v.id), actionId = str(v.actionId), name = str(v.name), createdAt = str(v.createdAt), expiresAt = str(v.expiresAt);
  const ackRequired = bool(v.ackRequired);
  if (!id || !actionId || name === undefined || !createdAt || !expiresAt || ackRequired === undefined) return undefined;
  const fields: Record<string, string> = {};
  if (isObj(v.fields)) for (const [k, x] of Object.entries(v.fields)) if (typeof x === "string") fields[k] = x;
  return clean({ id, actionId, name, fields, days: int(v.days), until: str(v.until), ackRequired, createdAt, expiresAt });
}

export function decodePerson(v: unknown): M.PersonSummary | undefined {
  if (!isObj(v) || typeof v.id !== "string" || !v.id) return undefined;
  return clean({ id: v.id, level: orUnknown(v.level, ["guest", "named", "verified"] as const), name: str(v.name) });
}
