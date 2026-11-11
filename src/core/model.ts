// The SDK's view of the wire types. Shapes come from the contract (wire.ts, generated from
// https://pingfront.sh/openapi.yaml); every server-extensible enum and union is widened with an "unknown" case,
// which is what the decoders produce for values this version does not know (the contract: "unknown ... must
// decode to an unknown case in every SDK").
import type * as W from "./wire.js";

export type Unknown = "unknown";

export type StoreOffer = Omit<W.StoreOffer, "kind"> & { kind: W.StoreOffer["kind"] | Unknown };
export type OfferCard = Omit<W.OfferCard, "offer"> & { offer?: StoreOffer };
export type ReviewCard = Omit<W.ReviewCard, "mode"> & { mode: W.ReviewCard["mode"] | Unknown };
export type StoreActionCard = Omit<W.StoreActionCard, "action" | "store"> & {
  action: W.StoreAction | Unknown;
  store?: "app_store" | "play" | Unknown;
};
export type UnknownCard = { kind: Unknown; id?: string; name: string; raw: unknown };
export type Card = OfferCard | ReviewCard | W.LinkCard | W.ChoicesCard | W.RatingCard | W.ReportCard | StoreActionCard | UnknownCard;

export type TextPart = W.TextPart;
export type ImagePart = W.ImagePart;
export type CardPart = { type: "card"; card: Card; result?: W.CardResult };
export type ReceiptPart = Omit<W.ReceiptPart, "action"> & { action: W.ReceiptPart["action"] | Unknown };
export type UnknownPart = { type: Unknown; name: string; raw: unknown };
export type Part = TextPart | ImagePart | CardPart | ReceiptPart | UnknownPart;

export type Author = Omit<W.Author, "kind"> & { kind: W.Author["kind"] | Unknown };
export type PingOrigin = { kind: "manual" | "play" | Unknown; explanation: string; playId?: string };
export type Message = {
  id: string;
  seq: number;
  clientId?: string;
  author: Author;
  parts: Part[];
  createdAt: string;
  ping?: PingOrigin;
  fallback?: string;
  translation?: { language: string; parts: TextPart[] };
};

export type TeamMember = W.TeamMember;
export type ThreadState = Omit<W.ThreadState, "status"> & { status: "open" | "resolved" | Unknown };
export type SendPolicy = { canSend: boolean; reason?: "blocked" | "app_paused" | "verification_required" | Unknown };
export type ThreadResponse = {
  thread: ThreadState | null;
  messages: Message[];
  hasOlder: boolean;
  team: TeamMember[];
  replyExpectation?: string;
  policy: SendPolicy;
};
export type MessagesPage = { messages: Message[]; hasMore: boolean };

export type PerMode = W.PerMode;
export type Localized = Record<string, string> & { default: string };
export type TopicSymbol = W.TopicSymbol;
export type Topic = { id: string; label: Localized; symbol: TopicSymbol; prefill?: Localized };
/** A ChatLook with every field optional: the wire carries only what the dashboard set. */
export type LookLayer = {
  theme: Partial<{
    accent: PerMode;
    background: PerMode;
    teamBubble: PerMode;
    scheme: "auto" | "light" | "dark";
    font: "system" | "rounded" | "serif";
    corners: "round" | "soft" | "square";
    density: "comfortable" | "compact";
  }>;
  header: Partial<{ style: "person" | "team" | "app"; memberId: string; title: Localized; showLocalTime: boolean; showReplyExpectation: boolean }>;
  welcome: Partial<{ title: Localized; body: Localized; showFaces: boolean }>;
  topics: Topic[];
  composer: Partial<{ placeholder: Localized; photos: boolean; reports: boolean }>;
  messages: Partial<{ showNames: boolean; showAvatars: boolean; timestamps: "grouped" | "always" }>;
  replyExpectation?: Localized;
  aiName?: string;
};
export type AppConfig = {
  revision: number;
  draft: boolean;
  appName: string;
  appIconUrl?: string;
  look: LookLayer;
  team: TeamMember[];
  features: { photos: boolean; reports: boolean; translation: boolean; ai: boolean; branding: boolean };
  liveUrl?: string;
  /** The deployment's VAPID public key (base64url) for web push; absent when the server has none. */
  webPushKey?: string;
};

/** A web push to the person's browser (PersonWebPushPayload), as the service worker decodes it. */
export type WebPushPayload = {
  kind: "message" | "ping" | "config" | Unknown;
  appId: string;
  threadId?: string;
  messageId?: string;
  unread?: number;
  title: string;
  body: string;
  tag?: string;
  /** The app turned notification sound off: show it with the Notification's `silent` option. */
  silent?: boolean;
};

export type ServerEvent =
  | { type: "hello"; threadId?: string | null; rev?: number; status?: string; lastSeq: number; readSeq: number; teamReadSeq?: number }
  | { type: "message"; seq: number; message: Message }
  | { type: "message_updated"; seq: number; message: Message }
  | { type: "typing"; author: { kind: "team" | "ai" | Unknown; name?: string }; on: boolean }
  | { type: "read"; by: string; upToSeq: number }
  | { type: "thread"; status: "open" | "resolved" | Unknown }
  | { type: "reset" }
  | { type: "thread_reset"; threadId: string }
  | { type: "config"; revision: number; draft: boolean }
  | { type: "reauth" }
  | { type: "team_action"; action: TeamActionPayload }
  | { type: Unknown; name: string; raw: unknown };

/** A "Fix it for them" action a teammate ran; the app does the work, then confirms. */
export type TeamActionPayload = {
  id: string;
  actionId: string;
  name: string;
  fields: Record<string, string>;
  days?: number;
  until?: string;
  ackRequired: boolean;
  createdAt: string;
  expiresAt: string;
};

export type PersonSummary = { id: string; level: "guest" | "named" | "verified" | Unknown; name?: string };
