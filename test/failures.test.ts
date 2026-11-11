// A message that is not delivered says why in the page's language: every failure the chat can show is
// rendered in languages other than English, and none of the English (the strings, or the engine's and the
// server's own error messages) reaches the person.
import { canRetry, isPolicyFailure } from "../src/core/api";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import en from "../src/locales/en.json";
import { create, type Instance } from "../src/index";
import { memoryStore } from "../src/core/storage";
import { MAX_BYTES } from "../src/core/uploads";
import { build, LOCALES, type Locale, type Pack } from "../src/ui/strings";
import { KEY, fakeApi, session, thread, type Route } from "./helpers";

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
});

const g = globalThis as unknown as { createImageBitmap?: unknown };
const canvas = HTMLCanvasElement.prototype as unknown as { getContext: unknown; toBlob: unknown };
const saved = { bitmap: g.createImageBitmap, getContext: canvas.getContext, toBlob: canvas.toBlob };
let chat: Instance | undefined;
afterEach(() => {
  chat?.destroy();
  chat = undefined;
  g.createImageBitmap = saved.bitmap;
  canvas.getContext = saved.getContext;
  canvas.toBlob = saved.toBlob;
});

const frames = () => new Promise((r) => setTimeout(r, 50));
const root = () => document.querySelector("pingfront-chat")!.shadowRoot!;
const error = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, docs: "" } } });

/** The English a person must never see: every English string, and every message an error carries. */
const ENGLISH = [
  // Single words that other languages spell the same (Chat, photo, message, open, send) are left out.
  ...Object.entries(en)
    .filter(([k]) => !["chat", "photo", "message", "messages", "placeholder", "open", "send", "ai", "said", "read", "you"].includes(k))
    .flatMap(([, v]) => (typeof v === "string" ? [v] : Object.values(v)))
    .filter((s) => s.length > 3 && !s.includes("{")),
  "Not delivered", "Try again", "Remove", "Retry", "Delete", "Server says no", "The photo upload was refused", "This photo is too large", "This browser could not prepare",
  "format can't be opened", "Only photos", "too long", "blocked", "paused", "sign in",
];

type Case = { reason: string; route?: Route; photo?: "open" | "size" | "upload" };
const HELD = ["paused", "verification"];
const CASES: Case[] = [
  { reason: "other", route: () => error(422, "invalid_request", "Server says no: the text is too long.") },
  { reason: "other", route: () => error(400, "brand_new_code", "Server says no.") },
  { reason: "too_long", route: () => error(413, "too_large", "Server says no: too large.") },
  { reason: "blocked", route: () => error(403, "blocked", "Server says no: blocked.") },
  { reason: "paused", route: () => error(403, "app_paused", "Server says no: paused.") },
  { reason: "verification", route: () => error(403, "verification_required", "Server says no: sign in.") },
  { reason: "photo_open", photo: "open" },
  { reason: "photo_size", photo: "size" },
  { reason: "photo_upload", photo: "upload" },
];

async function fail(locale: Locale, c: Case): Promise<HTMLElement> {
  const api = fakeApi({
    "POST /sessions": () => ({ status: 201, body: session(1) }),
    "GET /config": () => ({ status: 200, body: { schema: 1, revision: 1, draft: false, appName: "Clockwise", look: { theme: {}, header: {}, welcome: {}, topics: [], composer: {}, messages: {} }, team: [], features: { photos: true, reports: false, translation: false, ai: false } } }),
    "GET /thread": () => ({ status: 200, body: thread([]) }),
    "POST /thread/read": () => ({ status: 200, body: { readSeq: 0, unread: 0 } }),
    "POST /thread/messages": c.route ?? (() => error(500, "unavailable", "unexpected")),
    "POST /uploads": () => ({ status: 201, body: { attachmentId: "att_1", putUrl: "http://api.test/put/att_1", headers: {} } }),
    "PUT /put/att_1": () => ({ status: 403, body: {} }),
  });
  chat = create(KEY, { baseUrl: "http://api.test/v1", runtime: { ...api.rt, webSocket: () => undefined }, store: memoryStore(), logLevel: "off", locale, debug: false });
  chat.open();
  await frames();
  await frames();
  if (c.photo) {
    // jsdom has no image decoding: each case stubs as much of it as it needs.
    g.createImageBitmap = c.photo === "open" ? undefined : async () => ({ width: c.photo === "size" ? 4000 : 10, height: 10, close() {} });
    if (c.photo === "size") {
      canvas.getContext = () => ({ drawImage() {} });
      canvas.toBlob = (done: (b: Blob) => void) => done(new Blob([new Uint8Array(MAX_BYTES + 1)], { type: "image/jpeg" }));
    }
    const input = root().querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("change"));
  } else {
    const box = root().querySelector("textarea")!;
    box.value = "Hello";
    box.dispatchEvent(new Event("input"));
  }
  root().querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  // A pause or a required sign-in holds the message (its muted line); anything else fails it.
  const sel = HELD.includes(c.reason) ? ".g.me.pend .meta" : ".g.me.fail [role=alert]";
  const settled = () => root().querySelector(sel) && !root().querySelector(".g.me .meta")!.textContent!.endsWith("…");
  for (let i = 0; i < 20 && !settled(); i++) await frames();
  const meta = root().querySelector<HTMLElement>(sel);
  expect(meta, `${locale} ${c.reason}: no failed message`).not.toBeNull();
  return meta!;
}

/**
 * The row's line. A blocked chat already says why in the notice above the composer, so the row says only "Not
 * delivered" (2026-11-06) and the notice carries the reason, in the same words. A paused or unverified chat holds the
 * message: its line says when it will send, and the notice says why.
 */
function expectReason(meta: HTMLElement, t: ReturnType<typeof build>, reason: string, what: string) {
  if (HELD.includes(reason)) {
    expect(meta.textContent, what).toBe(t.held(reason === "paused" ? "app_paused" : "verification_required"));
    expect(root().querySelector(".note")!.textContent, what).toBe(reason === "paused" ? t.paused : t.verification);
    return;
  }
  const said = reason === "blocked";
  expect(meta.firstChild!.textContent, what).toBe(said ? t.notDelivered : t.notDeliveredBecause(reason));
  if (said) expect(t.notDeliveredBecause(reason), what).toContain(root().querySelector(".note")!.textContent!);
}

const noEnglish = (locale: string, what: string, text: string) => {
  for (const s of ENGLISH) expect(text.toLowerCase(), `${locale} ${what}: "${s}" in "${text}"`).not.toContain(s.toLowerCase());
};

describe("a message that is not delivered", () => {
  // Scripts with no Latin letters of their own, where any letter A–Z (other than the format names) is English.
  const nonLatin = ["ja", "ru", "ar", "zh-Hans"] as const;

  it.each(nonLatin)("says why in %s, with no English", async (locale) => {
    const t = build(locale, (await import(`../src/locales/${locale}.json`)).default as Partial<Pack>);
    for (const c of CASES) {
      const meta = await fail(locale, c);
      const text = meta.textContent!;
      expectReason(meta, t, c.reason, `${locale} ${c.reason}`);
      noEnglish(locale, c.reason, text);
      expect(text.replace(/JPEG|PNG/g, ""), `${locale} ${c.reason}: Latin letters in "${text}"`).not.toMatch(/[A-Za-z]/);
      chat!.destroy();
      chat = undefined;
    }
  });

  it("says why in a language written in Latin letters, with no English", async () => {
    const t = build("tr", (await import("../src/locales/tr.json")).default as Partial<Pack>);
    for (const c of CASES) {
      const meta = await fail("tr", c);
      expectReason(meta, t, c.reason, c.reason);
      noEnglish("tr", c.reason, meta.textContent!);
      chat!.destroy();
      chat = undefined;
    }
  });

  it("has a translated reason for every failure in every language, and none for an unknown one", async () => {
    const reasons = ["photo_type", "photo_open", "photo_size", "photo_upload", "too_long", "blocked", "paused", "verification"];
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      const t = build(locale, (await import(`../src/locales/${locale}.json`)).default as Partial<Pack>);
      const english = build("en");
      for (const r of reasons) {
        const line = t.notDeliveredBecause(r);
        expect(line, `${locale} ${r}`).toContain(t.notDelivered);
        expect(line.length, `${locale} ${r}`).toBeGreaterThan(t.notDelivered.length);
        noEnglish(locale, r, line.replace(english.notDelivered, ""));
      }
      // A failure saved by an older page as English words, or a reason this version doesn't know, shows none.
      for (const r of ["other", "Too long", "toString", undefined]) expect(t.notDeliveredBecause(r), `${locale} ${r}`).toBe(t.notDelivered);
    }
  });

  it("offers Retry apart from the policy only where sending the same message again can work", () => {
    // Policy refusals (blocked, paused, sign in) follow the policy instead (isPolicyFailure).
    const yes = ["photo_upload"];
    const all = ["photo_type", "photo_open", "photo_size", "photo_upload", "too_long", "blocked", "paused", "verification", "other"] as const;
    expect(all.filter((f) => canRetry(f))).toEqual(yes);
    expect(canRetry(undefined)).toBe(false);
    expect(all.filter((f) => isPolicyFailure(f))).toEqual(["blocked", "paused", "verification"]);
  });
});
