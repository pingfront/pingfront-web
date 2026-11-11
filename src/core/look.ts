// The chat look, resolved field by field: the published remote look (GET /config), then values set in
// code (configure options), then SDK defaults. Then contrast is enforced exactly as the iOS SDK does
// (sdks/ios/Sources/PingFrontCore/Look/ResolvedLook.swift): text on the accent is white when it reaches
// 3:1 (the accent then deepens to 4.5:1), backgrounds and team bubbles move until body text reads 4.5:1.
import type { LookLayer, Localized, PerMode, TeamMember, Topic, TopicSymbol } from "./model.js";

/** The SDK defaults: iOS system colors, as in the iOS SDK. Customer looks are data, not brand tokens. */
const LOOK_DEFAULTS = {
  accent: { light: "#007AFF", dark: "#0A84FF" },
  background: { light: "#FFFFFF", dark: "#1C1C1E" },
  teamBubble: { light: "#E9E9EB", dark: "#323236" },
  text: { light: "#000000", dark: "#FFFFFF" },
  muted: { light: "#6C6C78", dark: "#9C9CA8" },
} as const;

/** Mirrors the contract's CHAT_LOOK_DEFAULTS. */
export const FIELD_DEFAULTS = {
  theme: { scheme: "auto", font: "system", corners: "round", density: "comfortable" },
  header: { style: "person", showLocalTime: true, showReplyExpectation: true },
  welcome: { showFaces: true },
  composer: { photos: true, reports: true },
  messages: { showNames: true, showAvatars: true, timestamps: "grouped" },
  aiName: "Assistant",
} as const;

/** What an app can set in code (configure options). Each field is used only when the dashboard left it unset. */
export type Appearance = {
  accent?: string | PerMode;
  background?: string | PerMode;
  teamBubble?: string | PerMode;
  scheme?: "auto" | "light" | "dark";
  font?: "system" | "rounded" | "serif";
  corners?: "round" | "soft" | "square";
  density?: "comfortable" | "compact";
  headerStyle?: "person" | "team" | "app";
  /** The teammate the "person" header shows (a team member id); default the first. */
  headerMemberId?: string;
  /** Replaces the name in the header. */
  headerTitle?: string;
  showLocalTime?: boolean;
  showReplyExpectation?: boolean;
  /** Faces on the welcome screen. */
  showFaces?: boolean;
  showNames?: boolean;
  showAvatars?: boolean;
  timestamps?: "grouped" | "always";
  replyExpectation?: string;
  welcomeTitle?: string;
  welcomeBody?: string;
  placeholder?: string;
  aiName?: string;
  photos?: boolean;
};

export type CodeTopic = { id: string; label: string; symbol?: TopicSymbol; prefill?: string };

/**
 * `accentText`: the accent where it is text or a thin outline on the background (choice capsules, retry), at 4.5:1;
 * `bubbleMuted`: secondary text on a team bubble or card (a card's subtitle, "Photo removed"), at 4.5:1.
 */
export type Colors = { accent: string; onAccent: string; background: string; teamBubble: string; text: string; muted: string; accentText?: string; bubbleMuted?: string };

export type ResolvedLook = {
  appName: string;
  appIconUrl?: string;
  light: Colors;
  dark: Colors;
  scheme: "auto" | "light" | "dark";
  font: "system" | "rounded" | "serif";
  radius: number;
  tails: boolean;
  compact: boolean;
  headerStyle: "person" | "team" | "app";
  headerMemberId?: string;
  headerTitle?: Localized;
  showLocalTime: boolean;
  showReplyExpectation: boolean;
  welcomeTitle?: Localized;
  welcomeBody?: Localized;
  showFaces: boolean;
  topics: Topic[];
  placeholder?: Localized;
  photos: boolean;
  showNames: boolean;
  showAvatars: boolean;
  timestamps: "grouped" | "always";
  replyExpectation?: Localized;
  aiName: string;
  team: TeamMember[];
};

const HEX = /^#[0-9A-Fa-f]{6}$/;
const perMode = (v: string | PerMode | undefined): PerMode | undefined => {
  if (typeof v === "string") return HEX.test(v) ? { light: v, dark: v } : undefined;
  return v && HEX.test(v.light) && HEX.test(v.dark) ? v : undefined;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const text = (v: unknown): Localized | undefined => {
  const s = str(v);
  return s ? { default: s } : undefined;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined);

const CORNERS = { round: 18, soft: 12, square: 6 } as const;

export function resolveLook(remote: { look: LookLayer; appName: string; appIconUrl?: string; team: TeamMember[]; features: { photos: boolean } } | undefined, code: Appearance = {}, codeTopics?: CodeTopic[]): ResolvedLook {
  const look = remote?.look ?? { theme: {}, header: {}, welcome: {}, topics: [], composer: {}, messages: {} };
  const t = look.theme;
  const D = FIELD_DEFAULTS;
  const pick = (mode: "light" | "dark"): Colors => {
    const accent = (t.accent ?? perMode(code.accent) ?? LOOK_DEFAULTS.accent)[mode];
    const background = (t.background ?? perMode(code.background) ?? LOOK_DEFAULTS.background)[mode];
    const teamBubble = (t.teamBubble ?? perMode(code.teamBubble) ?? LOOK_DEFAULTS.teamBubble)[mode];
    return applyContrast({ accent, onAccent: accent, background, teamBubble, text: LOOK_DEFAULTS.text[mode], muted: LOOK_DEFAULTS.muted[mode] });
  };
  const topics: Topic[] = look.topics.length
    ? look.topics
    : (codeTopics ?? []).map((x) => ({ id: x.id, label: { default: x.label }, symbol: x.symbol ?? "other", ...(x.prefill ? { prefill: { default: x.prefill } } : {}) }));
  // Values set in code are checked here, so a typo (or a value from a newer SDK) falls back instead of breaking.
  const c = {
    scheme: oneOf(code.scheme, ["auto", "light", "dark"] as const),
    font: oneOf(code.font, ["system", "rounded", "serif"] as const),
    corners: oneOf(code.corners, ["round", "soft", "square"] as const),
    density: oneOf(code.density, ["comfortable", "compact"] as const),
    headerStyle: oneOf(code.headerStyle, ["person", "team", "app"] as const),
    timestamps: oneOf(code.timestamps, ["grouped", "always"] as const),
  };
  const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  const corners = t.corners ?? c.corners ?? D.theme.corners;
  return {
    appName: remote?.appName ?? "",
    appIconUrl: remote?.appIconUrl,
    light: pick("light"),
    dark: pick("dark"),
    scheme: t.scheme ?? c.scheme ?? D.theme.scheme,
    font: t.font ?? c.font ?? D.theme.font,
    radius: CORNERS[corners],
    tails: corners === "round",
    compact: (t.density ?? c.density ?? D.theme.density) === "compact",
    headerStyle: look.header.style ?? c.headerStyle ?? D.header.style,
    headerMemberId: look.header.memberId ?? str(code.headerMemberId),
    headerTitle: look.header.title ?? text(code.headerTitle),
    showLocalTime: look.header.showLocalTime ?? flag(code.showLocalTime) ?? D.header.showLocalTime,
    showReplyExpectation: look.header.showReplyExpectation ?? flag(code.showReplyExpectation) ?? D.header.showReplyExpectation,
    welcomeTitle: look.welcome.title ?? text(code.welcomeTitle),
    welcomeBody: look.welcome.body ?? text(code.welcomeBody),
    showFaces: look.welcome.showFaces ?? flag(code.showFaces) ?? D.welcome.showFaces,
    topics: topics.slice(0, 6),
    placeholder: look.composer.placeholder ?? text(code.placeholder),
    photos: (remote?.features.photos ?? true) && (look.composer.photos ?? flag(code.photos) ?? D.composer.photos),
    showNames: look.messages.showNames ?? flag(code.showNames) ?? D.messages.showNames,
    showAvatars: look.messages.showAvatars ?? flag(code.showAvatars) ?? D.messages.showAvatars,
    timestamps: look.messages.timestamps ?? c.timestamps ?? D.messages.timestamps,
    replyExpectation: look.replyExpectation ?? text(code.replyExpectation),
    aiName: look.aiName ?? str(code.aiName) ?? D.aiName,
    team: remote?.team ?? [],
  };
}

/** Customer text: exact language tag, then the base language, then "default". */
export function pickText(t: Localized | undefined, lang: string): string | undefined {
  if (!t) return undefined;
  return t[lang] ?? t[lang.split("-")[0]!] ?? t.default;
}

// ---------------------------------------------------------------------------
// WCAG contrast, mirrored from the iOS SDK's Contrast enum.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];
const rgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hex = (c: RGB) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase();
const lum = (c: RGB) => {
  const [r, g, b] = c.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => {
  const la = lum(rgb(a));
  const lb = lum(rgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const mix = (a: string, b: string, t: number) => {
  const x = rgb(a);
  const y = rgb(b);
  return hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
};
const WHITE = "#FFFFFF";
const BLACK = "#000000";
const AA = 4.5;

export function bestText(bg: string): string {
  if (contrast(WHITE, bg) >= 3) return WHITE;
  return contrast(BLACK, bg) >= contrast(WHITE, bg) ? BLACK : WHITE;
}

function moveUntil(start: string, target: string, ok: (c: string) => boolean): string {
  let c = start;
  for (let step = 1; !ok(c) && step <= 40; step++) c = mix(start, target, step * 0.025);
  return c;
}

export function accentAdjusted(accent: string): string {
  const t = bestText(accent);
  return moveUntil(accent, t === WHITE ? BLACK : WHITE, (c) => contrast(t, c) >= AA);
}

function surfaceFor(surface: string, textColor: string): string {
  if (contrast(surface, textColor) >= AA) return surface;
  return moveUntil(surface, lum(rgb(textColor)) > 0.5 ? BLACK : WHITE, (c) => contrast(c, textColor) >= AA);
}

function textOn(textColor: string, bg: string): string {
  if (contrast(textColor, bg) >= AA) return textColor;
  return moveUntil(textColor, contrast(BLACK, bg) >= contrast(WHITE, bg) ? BLACK : WHITE, (c) => contrast(c, bg) >= AA);
}

export function applyContrast(c: Colors): Colors {
  const background = surfaceFor(c.background, c.text);
  const teamBubble = surfaceFor(c.teamBubble, c.text);
  const accent = accentAdjusted(c.accent);
  // The accent deepened for white text can fall under 4.5:1 as text on a dark background: text uses its own value.
  const accentText = textOn(c.accent, background);
  return { accent, onAccent: bestText(accent), background, teamBubble, text: c.text, muted: textOn(c.muted, background), accentText, bubbleMuted: textOn(c.muted, teamBubble) };
}
