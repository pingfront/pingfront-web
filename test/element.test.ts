// The chat element in jsdom: shadow DOM, ARIA, every part renders (unknown ones as their fallback),
// and the keyboard paths. Real layout and pixels are covered by e2e/run.mjs in Chrome.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { create, type Instance } from "../src/index";
import { memoryStore } from "../src/core/storage";
import { KEY, fakeApi, message, session, thread, type Route } from "./helpers";
import type { Options } from "../src/core/engine";
import { CSS } from "../src/ui/styles";

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
});

let chat: Instance | undefined;
afterEach(() => {
  chat?.destroy();
  chat = undefined;
});

const frames = () => new Promise((r) => setTimeout(r, 50));
const app = (c: { body: unknown } | undefined) => (c?.body as { device?: { app?: unknown } } | undefined)?.device?.app;
const root = () => document.querySelector("pingfront-chat")!.shadowRoot!;

function mount(messages: unknown[], o: { branding?: boolean; webPushKey?: string; policy?: unknown; options?: Partial<Options>; routes?: Record<string, Route> } = {}) {
  const api = fakeApi({
    "POST /sessions": () => ({ status: 201, body: session(1) }),
    "GET /config": () => ({ status: 200, body: { schema: 1, revision: 1, draft: false, appName: "Clockwise", look: { theme: {}, header: {}, welcome: {}, topics: [{ id: "billing", label: { default: "Ask about billing" }, symbol: "billing" }], composer: {}, messages: {} }, team: [{ id: "mem_1", name: "Deniz Kaya" }], features: { photos: true, reports: true, translation: false, ai: true, branding: o.branding }, ...(o.webPushKey ? { webPushKey: o.webPushKey } : {}) } }),
    "GET /thread": () => ({ status: 200, body: { ...thread(messages), ...(o.policy ? { policy: o.policy } : {}) } }),
    "POST /thread/read": () => ({ status: 200, body: { readSeq: 9, unread: 0 } }),
    "POST /thread/cards/c_choice/act": () => ({ status: 204 }),
    "POST /thread/cards/c_offer/act": () => ({ status: 204 }),
    ...o.routes,
  });
  chat = create(KEY, { baseUrl: "http://api.test/v1", runtime: { ...api.rt, webSocket: () => undefined }, store: memoryStore(), logLevel: "off", ...o.options });
  return api;
}

describe("the chat element", () => {
  it("a production page names a configuration problem neutrally, in the page's language", async () => {
    const api = fakeApi({ "POST /sessions": () => ({ status: 403, body: { error: { code: "origin_not_allowed", message: "no", docs: "" } } }), "GET /config": () => ({ status: 403, body: { error: { code: "origin_not_allowed", message: "no", docs: "" } } }) });
    chat = create(KEY, { baseUrl: "http://api.test/v1", runtime: { ...api.rt, webSocket: () => undefined }, store: memoryStore(), logLevel: "off", locale: "de", debug: false });
    chat.open();
    await frames();
    await frames();
    // Said once, centered in the thread's place, with no welcome promising an answer and no composer to type in.
    expect(root().querySelector(".failed")!.textContent).toBe("Der Chat ist gerade nicht verfügbar.");
    expect(root().querySelector(".note")!.hasAttribute("hidden")).toBe(true);
    expect(root().querySelector(".welcome")).toBeNull();
    expect(root().querySelector(".again")).toBeNull();
    expect(root().querySelector(".comp")!.hasAttribute("hidden")).toBe(true);
  });

  it("renders a launcher in a shadow root and sends nothing until opened", async () => {
    const api = mount([]);
    await frames();
    const launch = root().querySelector<HTMLButtonElement>(".launch")!;
    expect(launch.getAttribute("aria-label")).toBe("Open chat");
    expect(launch.getAttribute("aria-expanded")).toBe("false");
    expect(root().querySelector(".panel")!.hasAttribute("hidden")).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("opens as a modal dialog with the welcome and topics", async () => {
    mount([]);
    chat!.open();
    await frames();
    await frames();
    const panel = root().querySelector(".panel")!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(root().getElementById("pf-title")!.textContent).toBe("Deniz Kaya");
    expect(root().querySelector(".topic")!.textContent).toBe("Ask about billing");
    root().querySelector<HTMLButtonElement>(".topic")!.click();
    await frames();
    expect(root().querySelector("textarea")!.value).toBe("Ask about billing");
  });

  it("shows the branding lockup above the composer only on the Free plan", async () => {
    mount([], { branding: true });
    chat!.open();
    await frames();
    await frames();
    // The brand's own outlines in the chat's muted ink, not a line of text in the host's font.
    const bar = root().querySelector(".brand")!;
    expect(bar.hasAttribute("hidden")).toBe(false);
    const mark = bar.querySelector("svg")!;
    expect(mark.getAttribute("aria-label")).toBe("Chat by pingfront");
    expect(mark.getAttribute("height")).toBe("14");
    chat!.destroy();
    mount([message(1)], { branding: true });
    chat!.open();
    await frames();
    await frames();
    expect(root().querySelector(".brand")!.hasAttribute("hidden")).toBe(true);
    chat!.destroy();
    mount([]);
    chat!.open();
    await frames();
    await frames();
    expect(root().querySelector(".brand")!.hasAttribute("hidden")).toBe(true);
  });

  it("asks a person who isn't verified to sign in, instead of the composer", async () => {
    mount([], { policy: { canSend: false, reason: "verification_required" } });
    chat!.open();
    await frames();
    await frames();
    expect(root().querySelector(".note")!.textContent).toBe("Sign in to the app to message the team.");
    expect(root().querySelector(".comp")!.hasAttribute("hidden")).toBe(true);
  });

  it("shows a photo removed by retention as a quiet placeholder and never fetches it", async () => {
    const removed = { ...message(2), parts: [{ type: "image", attachmentId: "att_gone", width: 1170, height: 2532, removed: true }] };
    const api = mount([removed]);
    chat!.open();
    await frames();
    await frames();
    const gone = root().querySelector(".gone")!;
    expect(gone.textContent).toBe("Photo removed");
    expect(gone.getAttribute("role")).toBe("img");
    expect(root().querySelector(".img")).toBeNull();
    expect(api.calls.some((c) => c.path.startsWith("/attachments/"))).toBe(false);
  });

  it("renders every part, unknown ones as the message's fallback, and the AI label", async () => {
    const ai = { ...message(2), author: { kind: "ai" }, parts: [{ type: "text", text: "From the assistant" }] };
    const unknown = { ...message(3), parts: [{ type: "hologram" }], fallback: "Update the app to see this." };
    const cards = {
      ...message(4),
      parts: [
        { type: "card", card: { kind: "choices", id: "c_choice", options: [{ id: "a", label: "Sync" }, { id: "b", label: "Widgets" }] } },
        { type: "card", card: { kind: "rating", id: "c_rate", question: "How did we do?", scale: 5 } },
        { type: "card", card: { kind: "store_action", id: "c_store", action: "billing_issue" } },
        { type: "card", card: { kind: "poll", id: "c_poll" } },
        { type: "receipt", action: "trial_extended", text: "Trial extended to 14 Nov" },
      ],
      fallback: "A card this version can't show.",
    };
    const ping = { ...message(1), ping: { kind: "manual", explanation: "Deniz wrote first." } };
    const api = mount([ping, ai, unknown, cards, message(5, "person", "Thanks")]);
    chat!.open();
    await frames();
    await frames();
    const text = root().querySelector(".panel")!.textContent!;
    expect(text).toContain("Deniz messaged you first");
    expect(root().querySelector(".dot")).not.toBeNull();
    expect(root().querySelector(".ai")!.textContent).toBe("AI");
    expect(text).toContain("Update the app to see this.");
    expect(text).toContain("A card this version can't show.");
    expect(text).toContain("Update your payment method");
    expect(text).toContain("Trial extended to 14 Nov");
    expect(root().querySelector(".chk")).not.toBeNull();
    expect(text).toContain("Delivered");
    expect(root().querySelectorAll(".star")).toHaveLength(5);
    expect(root().querySelector(".stars")!.getAttribute("role")).toBe("group");
    root().querySelector<HTMLButtonElement>(".cap")!.click();
    await frames();
    expect(root().querySelector(".cap")!.getAttribute("aria-pressed")).toBe("true");
    // Each report carries its own clientId (the protocol, "Retrying writes").
    expect(api.calls.find((c) => c.path.startsWith("/thread/cards/"))!.body).toEqual({ clientId: expect.any(String), messageId: "msg_4", action: "chosen", choiceId: "a" });
  });

  it("Escape closes the dialog", async () => {
    mount([]);
    chat!.open();
    await frames();
    root().querySelector(".panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await frames();
    expect(chat!.isOpen).toBe(false);
    expect(root().querySelector(".panel")!.hasAttribute("hidden")).toBe(true);
  });

  it("the launcher toggles the chat and says what it does", async () => {
    mount([]);
    await frames();
    const launch = root().querySelector<HTMLButtonElement>(".launch")!;
    launch.click();
    await frames();
    expect(chat!.isOpen).toBe(true);
    expect(launch.getAttribute("aria-label")).toBe("Close chat");
    launch.click();
    await frames();
    expect(chat!.isOpen).toBe(false);
    expect(launch.getAttribute("aria-label")).toBe("Open chat");
  });

  it("the composer field draws the one focus ring by :focus-visible, with no pointer heuristics", async () => {
    mount([]);
    chat!.open();
    await frames();
    expect(CSS).toMatch(/\.field:has\(textarea:focus-visible\)/);
    expect(root().querySelector(".pf")!.classList.contains("kb")).toBe(false);
  });

  it("the rating is a group of star buttons with a roving tabindex: one tab stop, arrows move focus, a press rates once", async () => {
    const rating = { ...message(1), parts: [{ type: "card", card: { kind: "rating", id: "c_rate", question: "How did we do?", scale: 5 } }] };
    const api = mount([rating], { routes: { "POST /thread/cards/c_rate/act": () => ({ status: 204 }) } });
    chat!.open();
    await frames();
    await frames();
    const stars = () => [...root().querySelectorAll<HTMLButtonElement>(".star")];
    expect(root().querySelector(".stars")!.getAttribute("role")).toBe("group");
    expect(stars().map((b) => b.getAttribute("role"))).toEqual([null, null, null, null, null]);
    expect(stars().map((b) => b.getAttribute("aria-label"))).toEqual(["1 of 5 stars", "2 of 5 stars", "3 of 5 stars", "4 of 5 stars", "5 of 5 stars"]);
    expect(stars().map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    stars()[0]!.focus();
    stars()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(root().activeElement).toBe(stars()[1]);
    expect(stars().map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    // Moving focus doesn't rate.
    expect(stars().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false", "false"]);
    stars()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    stars()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(root().activeElement).toBe(stars()[4]);
    stars()[3]!.click();
    await frames();
    expect(stars()[3]!.getAttribute("aria-pressed")).toBe("true");
    expect(stars().map((b) => b.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
    stars()[0]!.click();
    expect(api.calls.filter((c) => c.path === "/thread/cards/c_rate/act")).toHaveLength(1);
  });


  it("a screen link card's button opens the registered screen through onScreen and reports once", async () => {
    const link = { kind: "link", id: "c_link", title: "Sound settings", url: "", button: "Open", screen: { id: "settings.sound", params: { tab: "alerts" } }, savedLinkId: "sl_1" };
    const api = mount([{ ...message(1), parts: [{ type: "card", card: link }] }], { routes: { "POST /thread/cards/c_link/act": () => ({ status: 204 }) } });
    const seen: unknown[] = [];
    chat!.registerScreens([{ id: "settings.sound", title: "Sound settings" }]);
    chat!.onScreen(async (s) => (seen.push(s), true));
    chat!.open();
    await frames();
    await frames();
    expect(app(api.calls.find((c) => c.path === "/sessions"))).toMatchObject({ screens: [{ id: "settings.sound", title: "Sound settings" }] });
    const button = root().querySelector<HTMLButtonElement>(".card .cta")!;
    expect(button.textContent).toBe("Open");
    button.click();
    await frames();
    expect(seen).toEqual([{ id: "settings.sound", params: { tab: "alerts" } }]);
    expect(api.calls.filter((c) => c.path === "/thread/cards/c_link/act").map((c) => c.body)).toEqual([{ clientId: expect.any(String), messageId: "msg_1", action: "opened" }]);
  });

  it("onUnreadCount reports now and on change", async () => {
    mount([]);
    const seen: number[] = [];
    chat!.onUnreadCount((n) => seen.push(n));
    expect(seen).toEqual([0]);
  });
});

describe("the chat element after the 2026-11-06 visual pass", () => {
  const offerMessage = { ...message(1), parts: [{ type: "card", card: { kind: "offer", id: "c_offer", offerId: "off_1", title: "A month of Pro", button: "Claim the month" } }] };
  const choiceMessage = { ...message(2), parts: [{ type: "card", card: { kind: "choices", id: "c_choice", options: [{ id: "a", label: "Sync" }, { id: "b", label: "Widgets" }] } }] };

  it("emits cardOpened with the card's kind and ids, never its text (as iOS and Android)", async () => {
    mount([offerMessage, choiceMessage]);
    const seen: unknown[] = [];
    chat!.on("cardOpened", (e) => seen.push(e));
    chat!.onOffer(() => undefined);
    chat!.open();
    await frames();
    await frames();
    root().querySelector<HTMLButtonElement>(".cta")!.click();
    root().querySelector<HTMLButtonElement>(".cap")!.click();
    expect(seen).toEqual([
      { kind: "offer", cardId: "c_offer", messageId: "msg_1" },
      { kind: "choices", cardId: "c_choice", messageId: "msg_2" },
    ]);
  });

  it("an offer card without a paywall handler shows no button that would do nothing", async () => {
    mount([offerMessage]);
    chat!.open();
    await frames();
    await frames();
    expect(root().querySelector(".card")!.textContent).toContain("A month of Pro");
    expect(root().querySelector(".cta")).toBeNull();
    expect(root().querySelector(".card .na")!.textContent).toBe("Not available in this app");
    chat!.onOffer(() => undefined);
    await frames();
    expect(root().querySelector(".cta")!.textContent).toBe("Claim the month");
  });

  it("setLocale re-renders the open chat in the new language without configuring again", async () => {
    const api = mount([message(1)], { options: { locale: "en" } });
    chat!.open();
    await frames();
    await frames();
    expect(root().querySelector("textarea")!.getAttribute("aria-label")).toBe("Message");
    const calls = api.calls.length;
    chat!.setLocale("de");
    for (let i = 0; i < 5; i++) await frames();
    expect(chat!.locale).toBe("de");
    expect(root().querySelector(".pf")!.getAttribute("lang")).toBe("de");
    expect(root().querySelector("textarea")!.getAttribute("aria-label")).toBe("Nachricht");
    expect(root().querySelector(".launch")!.getAttribute("aria-label")).toBe("Chat schließen");
    // Only the read receipt the open chat sends on its own timer; the language change itself sends nothing.
    expect(api.calls.slice(calls).map((c) => c.path).filter((p) => p !== "/thread/read")).toEqual([]);
    chat!.setLocale("ar");
    for (let i = 0; i < 5; i++) await frames();
    expect(root().querySelector(".pf")!.getAttribute("dir")).toBe("rtl");
    chat!.setLocale("not a tag!");
    expect(chat!.locale).toBe("ar");
  });

  it("follows the on-screen keyboard: the panel sits on it, so the composer stays visible", async () => {
    const vv = Object.assign(new EventTarget(), { height: window.innerHeight, width: window.innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
    const before = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    try {
      mount([message(1)]);
      chat!.open();
      await frames();
      await frames();
      const panel = root().querySelector<HTMLElement>(".panel")!;
      expect(panel.classList.contains("kbup")).toBe(false);
      vv.height = window.innerHeight - 300;
      vv.offsetTop = 120;
      vv.dispatchEvent(new Event("resize"));
      expect(panel.classList.contains("kbup")).toBe(true);
      expect(panel.style.getPropertyValue("--vt")).toBe("120px");
      expect(panel.style.getPropertyValue("--kb")).toBe("180px");
      expect(panel.style.getPropertyValue("--vh")).toBe(`${window.innerHeight - 300}px`);
      vv.height = window.innerHeight;
      vv.offsetTop = 0;
      vv.dispatchEvent(new Event("resize"));
      expect(panel.classList.contains("kbup")).toBe(false);
      chat!.close();
      await frames();
      vv.height = 100;
      vv.dispatchEvent(new Event("resize"));
      expect(panel.style.getPropertyValue("--kb")).toBe("");
    } finally {
      if (before) Object.defineProperty(window, "visualViewport", before);
      else delete (window as { visualViewport?: unknown }).visualViewport;
    }
  });

  it("embeds in a container: no launcher, not modal, Escape doesn't close it", async () => {
    const slot = document.createElement("div");
    document.body.append(slot);
    mount([message(1)], { options: { container: slot } });
    const el = slot.querySelector("pingfront-chat") as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.hasAttribute("data-embedded")).toBe(true);
    expect(root().querySelector(".launch")!.hasAttribute("hidden")).toBe(true);
    chat!.open();
    await frames();
    await frames();
    const panel = root().querySelector(".panel")!;
    expect(panel.getAttribute("role")).toBe("region");
    expect(panel.hasAttribute("aria-modal")).toBe(false);
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await frames();
    expect(chat!.isOpen).toBe(true);
    expect(document.documentElement.style.overflow).toBe("");
    slot.remove();
  });

  it("moves the launcher off the page's own controls with launcherOffset", async () => {
    mount([], { options: { launcherOffset: { bottom: 88, end: 24 } } });
    const pf = root().querySelector<HTMLElement>(".pf")!;
    expect(pf.style.getPropertyValue("--lb")).toBe("88px");
    expect(pf.style.getPropertyValue("--le")).toBe("24px");
  });

  it("a server failure while online says so once, with Try again, instead of the welcome", async () => {
    let fail = true;
    mount([], { routes: { "GET /thread": () => (fail ? { status: 404, body: { error: { code: "not_found", message: "", docs: "" } } } : { status: 200, body: thread([message(1)]) }) } });
    chat!.open();
    for (let i = 0; i < 4; i++) await frames();
    expect(root().querySelector(".welcome")).toBeNull();
    const failed = root().querySelector(".failed")!;
    expect(failed.textContent).toBe("Couldn't load the conversation.Try again");
    expect(root().querySelector(".note")!.hasAttribute("hidden")).toBe(true);
    fail = false;
    root().querySelector<HTMLButtonElement>(".again")!.click();
    for (let i = 0; i < 4; i++) await frames();
    expect(root().querySelector(".failed")).toBeNull();
    expect(root().querySelector(".panel")!.textContent).toContain("m1");
  });

  it("unreachable with no thread: one notice, the welcome and a usable composer, no Try again", async () => {
    mount([], { routes: { "POST /sessions": () => ({ status: 0 }), "GET /config": () => ({ status: 0 }) } });
    chat!.open();
    for (let i = 0; i < 4; i++) await frames();
    // The browser is online: the service is what can't be reached, which "offline" would misdirect. As on iOS and
    // Android, it is a bar under the header, not a box above the composer.
    expect(root().querySelector(".head .ban")!.textContent).toBe("Can't reach the chat right now. Messages will send when it's back.");
    expect(root().querySelector(".note")!.hasAttribute("hidden")).toBe(true);
    expect(root().querySelector(".welcome")).not.toBeNull();
    expect(root().querySelector(".failed")).toBeNull();
    expect(root().querySelector("textarea")!.disabled).toBe(false);
  });

  it("the welcome isn't announced as a list; rows are list items", async () => {
    mount([]);
    chat!.open();
    await frames();
    await frames();
    expect(root().querySelector(".list")!.hasAttribute("role")).toBe(false);
  });
});

describe("round 2 of the 2026-11-06 pass: each fact once, no dead ends", () => {
  const send = async (status: number, body: unknown) => {
    mount([message(1)], { routes: { "POST /thread/messages": () => ({ status, body }) } });
    chat!.open();
    for (let i = 0; i < 3; i++) await frames();
    const ta = root().querySelector("textarea")!;
    ta.value = "Is there a family plan?";
    ta.dispatchEvent(new Event("input"));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    for (let i = 0; i < 6; i++) await frames();
    const g = root().querySelector(".fail")!;
    return { text: g.querySelector("[role=alert]")!.textContent, buttons: [...g.querySelectorAll(".meta button")].map((b) => b.textContent) };
  };
  const err = (code: string) => ({ error: { code, message: "x", docs: "" } });

  it("the welcome carries who and when, once; the header keeps only its controls until there is a conversation", async () => {
    mount([]);
    chat!.open();
    for (let i = 0; i < 3; i++) await frames();
    const panel = root().querySelector(".panel")!;
    expect(panel.textContent!.split("Usually replies within a day").length - 1).toBe(1);
    expect(root().querySelector(".head")!.classList.contains("min")).toBe(true);
    expect(root().querySelector(".head .face")).toBeNull();
    expect(root().getElementById("pf-title")!.textContent).toBe("Deniz Kaya");
    expect(root().querySelector(".welcome h2")!.textContent).toBe("Deniz Kaya");
    expect(root().querySelector(".head .x")).not.toBeNull();
  });

  it("with a conversation the header carries the identity", async () => {
    mount([message(1)]);
    chat!.open();
    for (let i = 0; i < 3; i++) await frames();
    expect(root().querySelector(".head")!.classList.contains("min")).toBe(false);
    expect(root().querySelector(".head .face")).not.toBeNull();
  });

  it("a refusal sending again can't change gives its reason and no Try again", async () => {
    // As native: plain "Not delivered", no invented reason.
    expect(await send(422, { ...err("invalid_request"), fields: [{ path: "text", message: "x" }] })).toEqual({ text: "Not delivered", buttons: ["Delete"] });
  });

  it("an unknown refusal (402 plan_limit, which SDK routes never send) reads the same", async () => {
    expect(await send(402, err("plan_limit"))).toEqual({ text: "Not delivered", buttons: ["Delete"] });
  });



  it("a review card with no store page says it's not available here instead of offering nothing", async () => {
    const review = { ...message(1), parts: [{ type: "card", card: { kind: "review", id: "c_rev", mode: "store_page", button: "Rate Clockwise" } }] };
    const restore = { ...message(2), parts: [{ type: "card", card: { kind: "store_action", id: "c_res", action: "restore_purchases" } }] };
    mount([review, restore]);
    chat!.open();
    for (let i = 0; i < 3; i++) await frames();
    const cards = [...root().querySelectorAll(".card")];
    expect(cards.map((c) => c.querySelector(".cta"))).toEqual([null, null]);
    // The review card says it can't act here; restoring purchases already says where to do it (said once).
    expect(cards.map((c) => c.querySelector(".na")?.textContent)).toEqual(["Not available in this app", undefined]);
    expect(cards[0]!.querySelector("strong")!.textContent).toBe("Enjoying Clockwise?");
  });

  it("topics show only when the person can send", async () => {
    mount([], { policy: { canSend: false, reason: "blocked" } });
    chat!.open();
    for (let i = 0; i < 3; i++) await frames();
    expect(root().querySelector(".welcome")).not.toBeNull();
    expect(root().querySelector(".topic")).toBeNull();
  });

  it("the composer's focus ring replaces its border (inset), it doesn't stack outside it", () => {
    expect(CSS).toMatch(/\.field:has\(textarea:focus-visible\)\{outline:var\(--focus-width\) solid var\(--sky\);outline-offset:calc\(-1 \* var\(--focus-width\)\)\}/);
  });
});

describe("round 3: the send policy is the one source of truth, and focus follows the APG dialog pattern", () => {
  const err = (code: string) => ({ error: { code, message: "x", docs: "" } });
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i++) await frames();
  };
  const type = async (text: string) => {
    const ta = root().querySelector("textarea")!;
    ta.value = text;
    ta.dispatchEvent(new Event("input"));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(6);
  };
  const row = () => {
    const g = root().querySelector(".fail");
    return g && { text: g.querySelector("[role=alert]")!.textContent, buttons: [...g.querySelectorAll(".meta button")].map((b) => b.textContent) };
  };
  const held = () => [...root().querySelectorAll(".pend .meta:not([hidden])")].map((m) => m.textContent);
  const composer = () => !root().querySelector(".comp")!.hasAttribute("hidden");
  const note = () => (root().querySelector(".note")!.hasAttribute("hidden") ? "" : root().querySelector(".note")!.textContent);

  it("a send refused as paused closes the policy and holds the message: no error mark, a muted line, Delete on the bubble", async () => {
    mount([message(1)], { routes: { "POST /thread/messages": () => ({ status: 403, body: err("app_paused") }) } });
    chat!.open();
    await settle();
    await type("Hello");
    expect(note()).toBe("This chat is paused for now.");
    expect(root().querySelector(".note")!.classList.contains("bar")).toBe(true);
    expect(composer()).toBe(false);
    expect(row()).toBeNull();
    expect(root().querySelector(".bang")).toBeNull();
    expect(held()).toEqual(["Not sent yet. It will send when the chat is back."]);
    // WAI-ARIA APG Disclosure: the bubble shows and hides Delete.
    const bubble = root().querySelector<HTMLButtonElement>(".pend button.col")!;
    expect(bubble.getAttribute("aria-expanded")).toBe("false");
    bubble.click();
    expect(bubble.getAttribute("aria-expanded")).toBe("true");
    expect([...root().querySelectorAll(".pend .meta:not([hidden]) button")].map((b) => b.textContent)).toEqual(["Delete"]);
  });

  it("reopening with GET /thread canSend:true sends the held message by itself", async () => {
    let paused = true;
    const api = mount([message(1)], { routes: { "POST /thread/messages": () => (paused ? { status: 403, body: err("app_paused") } : { status: 201, body: { threadId: "thr_1", message: message(2, "person", "Hello") } }) } });
    chat!.open();
    await settle();
    await type("Hello");
    expect(composer()).toBe(false);
    paused = false;
    chat!.close();
    chat!.open();
    await settle(8);
    expect(note()).toBe("");
    expect(composer()).toBe(true);
    expect(api.count("POST /thread/messages")).toBe(2);
    expect(root().querySelector(".pend, .fail")).toBeNull();
  });

  it("a thread whose policy is closed shows its reason; a reload that opens it leaves no stale notice", async () => {
    let policy: unknown = { canSend: false, reason: "blocked" };
    mount([message(1)], { routes: { "GET /thread": () => ({ status: 200, body: { ...thread([message(1)]), policy } }) } });
    chat!.open();
    await settle();
    expect(note()).toBe("You can't send messages in this chat.");
    expect(composer()).toBe(false);
    policy = { canSend: true };
    chat!.close();
    chat!.open();
    await settle();
    expect(note()).toBe("");
    expect(composer()).toBe(true);
  });

  it("a person who can't send gets no promise of a reply in the welcome", async () => {
    mount([], { policy: { canSend: false, reason: "blocked" } });
    chat!.open();
    await settle();
    const welcome = root().querySelector(".welcome")!.textContent!;
    expect(welcome).not.toContain("Usually replies within a day");
    expect(welcome).not.toContain("reply here");
    expect(note()).toBe("You can't send messages in this chat.");
  });

  it("the welcome line names the app, in native wording", async () => {
    mount([]);
    chat!.open();
    await settle();
    expect(root().querySelector(".welcome")!.textContent).toContain("Questions, bugs or ideas: the people who make Clockwise read every message and reply here.");
  });

  it("opening moves focus to the dialog itself, not the composer", async () => {
    mount([message(1)]);
    chat!.open();
    await settle();
    expect(root().activeElement).toBe(root().querySelector(".panel"));
    expect(root().querySelector(".panel")!.getAttribute("tabindex")).toBe("-1");
  });

  it("a topic puts the caret in the composer", async () => {
    mount([]);
    chat!.open();
    await settle();
    root().querySelector<HTMLButtonElement>(".topic")!.click();
    await settle(2);
    expect(root().activeElement).toBe(root().querySelector("textarea"));
  });

  it("embedded, open() leaves focus where the page had it", async () => {
    const field = document.createElement("input");
    const slot = document.createElement("div");
    document.body.append(field, slot);
    field.focus();
    mount([message(1)], { options: { container: slot } });
    chat!.open();
    await settle();
    expect(document.activeElement).toBe(field);
    field.remove();
    slot.remove();
  });

  it("when the focused composer goes away (the chat became blocked), focus stays in the dialog", async () => {
    mount([message(1)], { routes: { "POST /thread/messages": () => ({ status: 403, body: err("blocked") }) } });
    chat!.open();
    await settle();
    root().querySelector("textarea")!.focus();
    await type("Hello");
    expect(composer()).toBe(false);
    expect(root().activeElement).toBe(root().querySelector(".panel"));
  });

  it("the rate-limit countdown is announced once and its ticking digits stay out of the live region", async () => {
    mount([message(1)], { routes: { "POST /thread/messages": () => ({ status: 429, headers: { "Retry-After": "40" }, body: { ...err("rate_limited"), retryAfter: 40, scope: "messages" } }) } });
    chat!.open();
    await settle();
    await type("Hello");
    const n = root().querySelector(".note")!;
    expect(n.textContent).toMatch(/^You can send again in 0:(40|39)\.$/);
    expect(n.hasAttribute("aria-live") || n.hasAttribute("role")).toBe(false);
    const live = () => [...root().querySelectorAll(".sr[aria-live] p")].map((p) => p.textContent).filter((t) => t!.startsWith("You can send again"));
    expect(live()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1100));
    await settle(2);
    expect(live()).toHaveLength(1);
  });

  it("a message written offline waits for the connection, as native says", async () => {
    mount([message(1)], { routes: { "POST /thread/messages": () => ({ status: 0 }) } });
    chat!.open();
    await settle();
    window.dispatchEvent(new Event("offline"));
    await type("Hello");
    expect(root().querySelector(".pend .meta")!.textContent).toBe("Waiting for connection");
    window.dispatchEvent(new Event("online"));
  });
});

describe("round 4: rows say only what is true, photos wait without holding text back", () => {
  const err = (code: string) => ({ error: { code, message: "x", docs: "" } });
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i++) await frames();
  };
  const type = async (text: string) => {
    const ta = root().querySelector("textarea")!;
    ta.value = text;
    ta.dispatchEvent(new Event("input"));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(6);
  };
  const metas = () => [...root().querySelectorAll(".g.me .meta")].map((m) => m.textContent);

  it("blocked, then unblocked: the row reads \"Not delivered\" with Retry, never the old reason", async () => {
    let blocked = true;
    mount([message(1)], {
      routes: {
        "POST /thread/messages": () => (blocked ? { status: 403, body: err("blocked") } : { status: 201, body: { threadId: "thr_1", message: message(2, "person", "Hello") } }),
        "GET /thread": () => ({ status: 200, body: { ...thread([message(1)]), policy: blocked ? { canSend: false, reason: "blocked" } : { canSend: true } } }),
      },
    });
    chat!.open();
    await settle();
    // Open at first (a fresh GET reports blocked only after the refusal).
    blocked = false;
    chat!.close();
    chat!.open();
    await settle();
    blocked = true;
    await type("Hello");
    expect(root().querySelector(".fail [role=alert]")!.textContent).toBe("Not delivered");
    // Blocked: Delete only, no Try again.
    expect([...root().querySelectorAll(".fail .meta button")].map((b) => b.textContent)).toEqual(["Delete"]);
    blocked = false;
    chat!.close();
    chat!.open();
    await settle();
    const g = root().querySelector(".fail")!;
    expect(g.querySelector("[role=alert]")!.textContent).toBe("Not delivered");
    expect([...g.querySelectorAll(".meta button")].map((b) => b.textContent)).toEqual(["Try again", "Delete"]);
  });

  it("a message waiting out a rate limit says it will be tried again soon, not \"Sending…\"", async () => {
    mount([message(1)], { routes: { "POST /thread/messages": () => ({ status: 429, body: { error: { code: "rate_limited", message: "x", docs: "", retryAfter: 40, scope: "messages" } } }) } });
    chat!.open();
    await settle();
    await type("Hello");
    expect(metas()).toContain("Not sent yet. Trying again soon.");
  });

  it("a message waiting out a server error's backoff says the same", async () => {
    mount([message(1)], { routes: { "POST /thread/messages": () => ({ status: 503, body: err("unavailable") }) } });
    chat!.open();
    await settle();
    await type("Hello");
    expect(metas()).toContain("Not sent yet. Trying again soon.");
  });

  it("while photos are rate limited, text still sends and the notice says so", async () => {
    const sent: unknown[] = [];
    mount([message(1)], {
      routes: {
        "POST /uploads": () => ({ status: 429, body: { error: { code: "rate_limited", message: "x", docs: "", retryAfter: 60, scope: "uploads" } } }),
        "POST /thread/messages": (c) => (sent.push(c.body), { status: 201, body: { threadId: "thr_1", message: { ...message(9, "person", "Text after the photo"), clientId: (c.body as { clientId: string }).clientId } } }),
      },
    });
    chat!.open();
    await settle();
    // A photo first (jsdom can't decode images: stub what preparePhoto needs), then text.
    const g = globalThis as unknown as { createImageBitmap?: unknown };
    g.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
    const canvas = HTMLCanvasElement.prototype as unknown as { getContext: unknown; toBlob: unknown };
    canvas.getContext = () => ({ drawImage() {} });
    canvas.toBlob = (done: (b: Blob) => void) => done(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
    const input = root().querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("change"));
    root().querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(6);
    await type("Text after the photo");
    await settle(6);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { text: string }).text).toBe("Text after the photo");
    expect(root().querySelector(".note")!.textContent).toMatch(/^Photos can be sent again in [01]:\d\d\. Text still sends\.$/);
  });

  it("signing in where the chat asked for it loads the thread again and opens sending", async () => {
    let verified = false;
    mount([message(1)], {
      routes: {
        "GET /thread": () => ({ status: 200, body: { ...thread([message(1)]), policy: verified ? { canSend: true } : { canSend: false, reason: "verification_required" } } }),
        "PATCH /me": () => ((verified = true), { status: 200, body: {} }),
      },
    });
    chat!.open();
    await settle();
    expect(root().querySelector(".note")!.textContent).toBe("Sign in to the app to message the team.");
    chat!.identify("header.eyJzdWIiOiJ1XzEifQ.sig");
    await new Promise((r) => setTimeout(r, 400));
    await settle(6);
    expect(root().querySelector(".note")!.hasAttribute("hidden")).toBe(true);
    expect(root().querySelector(".comp")!.hasAttribute("hidden")).toBe(false);
  });

  it("the character counter isn't a live region; crossing the limit is announced once", async () => {
    mount([message(1)]);
    chat!.open();
    await settle();
    expect(root().querySelector(".count")!.hasAttribute("aria-live")).toBe(false);
    const ta = root().querySelector("textarea")!;
    const said = () => [...root().querySelectorAll(".sr[aria-live] p")].map((p) => p.textContent).filter((t) => t!.includes("over the limit"));
    for (const n of [3990, 4001, 4002, 4003]) {
      ta.value = "a".repeat(n);
      ta.dispatchEvent(new Event("input"));
    }
    expect(said()).toEqual(["1 character over the limit"]);
  });

  it("the thread is a tab stop only when it has something to scroll", async () => {
    mount([]);
    chat!.open();
    await settle();
    // jsdom lays nothing out: no scroll height, so the welcome's thread is not a tab stop.
    expect(root().querySelector(".scroll")!.hasAttribute("tabindex")).toBe(false);
  });
});

describe("round 5: what each queued row and each notice says, to everyone", () => {
  const err = (code: string) => ({ error: { code, message: "x", docs: "" } });
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i++) await frames();
  };
  const type = async (text: string) => {
    const ta = root().querySelector("textarea")!;
    ta.value = text;
    ta.dispatchEvent(new Event("input"));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(6);
  };
  const said = (needle: string) => [...root().querySelectorAll(".sr[aria-live] p")].map((p) => p.textContent).filter((t) => t === needle);

  it("messages waiting out a rate limit say they will be tried again soon, once, under the last", async () => {
    mount([message(1)], { routes: { "POST /thread/messages": () => ({ status: 429, body: { error: { code: "rate_limited", message: "x", docs: "", retryAfter: 40, scope: "messages" } } }) } });
    chat!.open();
    await settle();
    await type("First");
    await type("Second");
    const metas = [...root().querySelectorAll(".pend .meta")].map((m) => m.textContent);
    expect(metas).toEqual(["Not sent yet. Trying again soon."]);
    expect(root().querySelectorAll(".pend")).toHaveLength(2);
  });

  it("a send refusal's policy line is announced once when it appears", async () => {
    mount([message(1)], { routes: { "POST /thread/messages": () => ({ status: 403, body: err("app_paused") }) } });
    chat!.open();
    await settle();
    await type("Hello");
    await settle(4);
    expect(said("This chat is paused for now.")).toHaveLength(1);
  });

  it("the offline line is announced once when it appears", async () => {
    mount([message(1)]);
    chat!.open();
    await settle();
    window.dispatchEvent(new Event("offline"));
    await settle(4);
    window.dispatchEvent(new Event("offline"));
    await settle(4);
    expect(said("You're offline. Messages will send when you're back online.")).toHaveLength(1);
    window.dispatchEvent(new Event("online"));
  });

  it("a 429 outside sending (loading the thread) never says \"You can send again\"", async () => {
    mount([], { routes: { "GET /thread": () => ({ status: 429, body: { error: { code: "rate_limited", message: "x", docs: "", retryAfter: 40, scope: "api" } } }) } });
    chat!.open();
    await settle(6);
    const note = root().querySelector(".note")!;
    expect(note.hasAttribute("hidden") ? "" : note.textContent).not.toMatch(/send again|Sending is paused/);
  });


});

describe("X1: iOS's rows, notices and cards", () => {
  const err = (code: string) => ({ error: { code, message: "x", docs: "" } });
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i++) await frames();
  };
  const type = async (text: string) => {
    const ta = root().querySelector("textarea")!;
    ta.value = text;
    ta.dispatchEvent(new Event("input"));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(6);
  };
  const offer = (seq: number, id: string, offerId = "pro") => ({ ...message(seq), parts: [{ type: "card", card: { kind: "offer", id, offerId, title: `Offer ${seq}`, button: "See the offer" } }] });

  it("a plain failure has the mark beside the bubble, a disclosure (APG) of Try again and Delete", async () => {
    mount([message(1)], { routes: { "POST /thread/messages": () => ({ status: 413, body: err("too_large") }) } });
    chat!.onOffer(() => undefined);
    chat!.open();
    await settle();
    await type("Hello");
    const mark = root().querySelector<HTMLButtonElement>(".fail .bang")!;
    expect(mark.getAttribute("aria-label")).toBe("Not delivered");
    expect(mark.getAttribute("aria-expanded")).toBe("false");
    const acts = root().querySelector<HTMLElement>(".fail .meta:not([role])")!;
    expect(acts.hidden).toBe(true);
    mark.click();
    expect(mark.getAttribute("aria-expanded")).toBe("true");
    expect(acts.hidden).toBe(false);
    // Too long fails the same way again: Delete only.
    expect([...acts.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Delete"]);
    acts.querySelector("button")!.click();
    await settle();
    expect(root().querySelector(".fail")).toBeNull();
    expect(root().activeElement).toBe(root().querySelector(".panel"));
  });

  it("the close hint follows the person's first message, never while one still waits to send", async () => {
    let up = false;
    mount([message(1, "person", "Hi")], { routes: { "POST /thread/messages": () => (up ? { status: 201, body: { threadId: "thr_1", message: message(2, "person", "More") } } : { status: 503, body: err("unavailable") }) } });
    chat!.open();
    await settle();
    const hint = () => root().querySelector(".hint")?.textContent;
    expect(hint()).toBe("You can close this; the reply waits here.");
    await type("More");
    expect(hint()).toBeUndefined();
  });

  describe("the notifications offer under the first message", () => {
    const pushEnv = (permission: NotificationPermission) => {
      const notification = { permission, requestPermission: vi.fn(async () => "default" as NotificationPermission) };
      return { notification, serviceWorker: { addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as ServiceWorkerContainer, hasPushManager: true };
    };
    const open = async (env: ReturnType<typeof pushEnv>, options: Partial<Options>) => {
      mount([message(1, "person", "Hi")], { webPushKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U", options: { pushEnv: env, ...options } });
      chat!.open();
      await settle();
    };
    const button = () => root().querySelector<HTMLButtonElement>(".hint button");

    it("offers it when the host set push and the browser hasn't decided; the tap is the prompt's gesture, then it goes", async () => {
      const env = pushEnv("default");
      await open(env, { push: { serviceWorker: "/pingfront-sw.js" } });
      expect(root().querySelector(".hint p")?.textContent).toBe("You can close this; the reply waits here.");
      expect(button()?.textContent).toBe("Turn on notifications");
      button()!.click();
      // Asked inside the click, before anything loads.
      expect(env.notification.requestPermission).toHaveBeenCalledTimes(1);
      await settle();
      expect(button()).toBeNull();
      expect(root().querySelector(".hint")?.textContent).toBe("You can close this; the reply waits here.");
      // The button went: focus stays in the chat (WCAG 2.4.3), not on the page behind it.
      expect(root().activeElement).toBe(root().querySelector(".panel"));
    });

    it("never offers it without the host's push option, or once the browser decided", async () => {
      await open(pushEnv("default"), {});
      expect(button()).toBeNull();
      expect(root().querySelector(".hint")?.textContent).toBe("You can close this; the reply waits here.");
      chat!.destroy();
      document.querySelector("pingfront-chat")?.remove();
      await open(pushEnv("denied"), { push: {} });
      expect(button()).toBeNull();
    });
  });

  it("a team reply ends the close hint", async () => {
    mount([message(1, "person", "Hi"), message(2)]);
    chat!.open();
    await settle();
    expect(root().querySelector(".hint")).toBeNull();
  });

  it("older offer cards collapse to one line; only the newest stands", async () => {
    mount([offer(1, "c_old"), offer(2, "c_new")]);
    chat!.onOffer(() => undefined);
    chat!.open();
    await settle();
    expect([...root().querySelectorAll(".gone")].map((r) => r.textContent)).toEqual(["Replaced by a newer offer"]);
    expect([...root().querySelectorAll(".card strong")].map((s) => s.textContent)).toEqual(["Offer 2"]);
  });

  it("an offer whose paywall the app reports unavailable keeps no button, a muted title and the reason", async () => {
    mount([offer(1, "c_offer")]);
    chat!.onOffer(() => undefined);
    chat!.open();
    await settle();
    expect(root().querySelector<HTMLButtonElement>(".card .cta")!.disabled).toBe(false);
    chat!.setOffers([{ id: "pro", title: "Pro", kind: "standard", available: false }]);
    await settle();
    const card = root().querySelector(".card")!;
    expect(card.classList.contains("off")).toBe(true);
    expect(card.querySelector(".cta")).toBeNull();
    expect(card.querySelector(".na")!.textContent).toBe("This offer is no longer available.");
    chat!.setOffers([{ id: "pro", title: "Pro", kind: "standard", available: true }]);
    await settle();
    expect(root().querySelector(".card")!.classList.contains("off")).toBe(false);
  });

  it("with no teammate known, the header shows the app's icon, as iOS does", async () => {
    const api = fakeApi({
      "POST /sessions": () => ({ status: 201, body: session(1) }),
      "GET /config": () => ({ status: 200, body: { schema: 1, revision: 1, draft: false, appName: "Clockwise", look: { theme: {}, header: {}, welcome: {}, topics: [], composer: {}, messages: {} }, team: [], features: { photos: true, reports: true, translation: false, ai: true } } }),
      "GET /thread": () => ({ status: 200, body: { ...thread([message(1, "person")]), team: [] } }),
      "POST /thread/read": () => ({ status: 200, body: { readSeq: 1, unread: 0 } }),
    });
    chat = create(KEY, { baseUrl: "http://api.test/v1", runtime: { ...api.rt, webSocket: () => undefined }, store: memoryStore(), logLevel: "off" });
    chat.open();
    await settle();
    expect(root().querySelector(".head .face")).toBeNull();
    // No store icon: the site's own icon, and the app's first letter when that doesn't load.
    const icon = root().querySelector<HTMLImageElement>(".head img.appicon")!;
    expect(icon.src).toBe(new URL("/favicon.ico", document.baseURI).href);
    icon.dispatchEvent(new Event("error"));
    expect(root().querySelector(".head .appicon")!.textContent).toBe("C");
  });

  it("store cards read as iOS does", async () => {
    const card = (seq: number, action: string) => ({ ...message(seq), parts: [{ type: "card", card: { kind: "store_action", id: `c_${seq}`, action } }] });
    mount([card(1, "manage_subscriptions"), card(2, "billing_issue")]);
    chat!.open();
    await settle();
    const cards = [...root().querySelectorAll(".card")].map((c) => [c.querySelector("strong")!.textContent, c.querySelector("span")!.textContent, c.querySelector(".cta")!.textContent]);
    expect(cards).toEqual([
      ["Your subscription", "Change your plan, payment method or renewal.", "Manage subscription"],
      ["Payment didn't go through", "Update your payment method to keep your subscription.", "Update payment method"],
    ]);
  });
});

describe("the Free plan's lockup loads on demand", () => {
  afterEach(async () => {
    const { setLockupSource } = await import("../src/ui/brand");
    const { LOCKUP } = await import("../src/ui/lockup");
    setLockupSource(async () => LOCKUP);
  });

  it("the welcome waits for it behind the skeleton, then both show at once", async () => {
    const { setLockupSource } = await import("../src/ui/brand");
    const { LOCKUP } = await import("../src/ui/lockup");
    let release!: () => void;
    let asked = 0;
    setLockupSource(() => (asked++, new Promise((r) => (release = () => r(LOCKUP)))));
    mount([], { branding: true });
    chat!.open();
    for (let i = 0; i < 4; i++) await frames();
    expect(asked).toBe(1);
    // No welcome without its lockup: the still skeleton stays.
    expect(root().querySelector(".welcome")).toBeNull();
    expect(root().querySelector(".skel")).not.toBeNull();
    expect(root().querySelector(".brand")!.hasAttribute("hidden")).toBe(true);
    release();
    for (let i = 0; i < 2; i++) await frames();
    expect(root().querySelector(".welcome")).not.toBeNull();
    expect(root().querySelector(".brand svg")!.getAttribute("aria-label")).toBe("Chat by pingfront");
  });

  it("isn't loaded on a paid plan", async () => {
    const { setLockupSource } = await import("../src/ui/brand");
    let asked = 0;
    setLockupSource(async () => (asked++, undefined));
    mount([]);
    chat!.open();
    for (let i = 0; i < 4; i++) await frames();
    expect(asked).toBe(0);
    expect(root().querySelector(".welcome")).not.toBeNull();
  });

  it("outlines that can't load leave the same words in text", async () => {
    const { setLockupSource } = await import("../src/ui/brand");
    setLockupSource(async () => {
      throw new TypeError("Failed to fetch");
    });
    mount([], { branding: true });
    chat!.open();
    for (let i = 0; i < 4; i++) await frames();
    expect(root().querySelector(".welcome")).not.toBeNull();
    expect(root().querySelector(".brand")!.textContent).toBe("Chat by pingfront");
    expect(root().querySelector(".brand svg")).toBeNull();
  });
});
