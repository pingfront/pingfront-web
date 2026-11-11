// @vitest-environment node
// The built script on hosts that are harder than the example page, in real Chrome:
// - a strict Content-Security-Policy (no 'unsafe-inline' styles): the chat must still be styled;
// - the script tag in <head> without defer: it must wait for <body> instead of throwing;
// - the photo lightbox is a modal dialog: Tab must stay inside it;
// - the lazy modules (locales/<name>.js) run under that CSP, checked against the integrity manifest, and a nonce-only
//   policy still runs them with the script tag's nonce; a changed module never runs.
// Opt-in: pnpm build && WIDGET_BROWSER=1 pnpm vitest run test/hosting.browser.test.ts
import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";

const RUN = process.env.WIDGET_BROWSER === "1";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const KEY = "pk_test_abcdefghijklmnopqrstuvvd";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'";

describe.skipIf(!RUN)("hosting", () => {
  let server: Server;
  let browser: Browser;
  let base = "";
  const pages: Record<string, { body: string; type?: string; csp?: boolean | "nonce" }> = {};

  beforeAll(async () => {
    const script = readFileSync(new URL("../dist/pingfront.js", import.meta.url), "utf8");
    pages["/pingfront.js"] = { body: script, type: "text/javascript" };
    pages["/strict"] = { csp: true, body: `<!doctype html><html><head><script src="/pingfront.js"></script></head><body><p>Host</p><script src="/open.js"></script></body></html>` };
    pages["/open.js"] = { type: "text/javascript", body: `PingFront.configure("${KEY}", { baseUrl: location.origin + "/v1", logLevel: "off" }); PingFront.open();` };
    // A Latin-1 page, and the script served with no charset (so it is decoded as Latin-1 too).
    pages["/latin1"] = { type: "text/html; charset=windows-1252", body: `<!doctype html><html><head><script src="/pingfront.js"></script></head><body><p>Host</p></body></html>` };
    pages["/rtl"] = { body: `<!doctype html><html dir="rtl" lang="ar"><head><script src="/pingfront.js"></script></head><body><p>مضيف</p></body></html>` };
    // The build's locales/ folder (packs, lockup, lazy modules) next to the script, as a self-hosting page serves it.
    const locales = new URL("../dist/locales/", import.meta.url);
    for (const f of readdirSync(locales)) pages[`/locales/${f}`] = { body: readFileSync(new URL(f, locales), "utf8"), type: f.endsWith(".js") ? "text/javascript" : "application/json" };
    pages["/nonce"] = { csp: "nonce", body: `<!doctype html><html><head><script nonce="n0nce" src="/pingfront.js"></script></head><body><p>Host</p></body></html>` };
    pages["/head"] = { body: `<!doctype html><html><head><script src="/pingfront.js" data-app-key="${KEY}" data-base-url="/v1" data-log-level="off"></script></head><body><p>Host</p></body></html>` };
    server = createServer((req, res) => {
      const p = pages[(req.url ?? "/").split("?")[0]!];
      if (!p) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_found", message: "no", docs: "" } }));
        return;
      }
      const csp = p.csp === "nonce" ? "default-src 'self'; script-src 'nonce-n0nce'; style-src 'self'; connect-src 'self'" : CSP;
      res.writeHead(200, { "Content-Type": p.type ?? "text/html", ...(p.csp ? { "Content-Security-Policy": csp } : {}) });
      res.end(p.body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it("is styled under a CSP without 'unsafe-inline' styles", { timeout: 60_000 }, async () => {
    const page = await browser.newPage();
    const violations: string[] = [];
    page.on("console", (m) => /Content Security Policy/i.test(m.text()) && violations.push(m.text()));
    await page.goto(`${base}/strict`, { waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("pingfront-chat")?.shadowRoot?.querySelector(".panel:not([hidden])"));
    const look = await page.evaluate(() => {
      const root = document.querySelector("pingfront-chat")!.shadowRoot!;
      const panel = getComputedStyle(root.querySelector(".panel")!);
      // With no conversation the header keeps only its close button (the welcome carries the face): measure that.
      const close = root.querySelector<HTMLElement>(".head .x");
      return { position: panel.position, radius: panel.borderTopLeftRadius, faceWidth: close ? getComputedStyle(close).width : "" };
    });
    expect(look.position).toBe("fixed");
    expect(look.radius).not.toBe("0px");
    expect(look.faceWidth).toBe("44px");
    expect(violations).toEqual([]);
    await page.close();
  });

  it("runs its lazy modules under a strict CSP and a nonce-only one, and never a changed one", { timeout: 60_000 }, async () => {
    // The self-check is a lazy module: module_blocked means it didn't run. This test server answers every API call 404.
    const check = async (path: string) => {
      const page = await browser.newPage();
      const violations: string[] = [];
      page.on("console", (m) => /Content Security Policy/i.test(m.text()) && violations.push(m.text()));
      await page.goto(`${base}${path}`, { waitUntil: "load" });
      const code = await page.evaluate(async (key) => {
        const pf = (globalThis as unknown as { PingFront: { configure: (k: string, o: object) => void; selfCheck: () => Promise<{ code?: string }> } }).PingFront;
        pf.configure(key, { baseUrl: "/v1", logLevel: "off", launcher: false });
        return (await pf.selfCheck()).code;
      }, KEY);
      await page.close();
      return { code, violations };
    };
    expect(await check("/strict")).toEqual({ code: "not_found", violations: [] });
    expect(await check("/nonce")).toEqual({ code: "not_found", violations: [] });
    const original = pages["/locales/selfcheck.js"]!.body;
    pages["/locales/selfcheck.js"]!.body = original.replace("Setup check from", "Setup check by");
    try {
      expect((await check("/strict")).code).toBe("module_blocked");
    } finally {
      pages["/locales/selfcheck.js"]!.body = original;
    }
  });

  it("waits for <body> when the tag sits in <head> without defer", { timeout: 60_000 }, async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/head`, { waitUntil: "load" });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => Boolean(document.querySelector("body > pingfront-chat")))).toBe(true);
    await page.close();
  });

  it("works when a page holds a second copy of the widget (a custom element tag already taken)", { timeout: 60_000 }, async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/head`, { waitUntil: "load" });
    // A second copy is a different class: before 2026-11-06 constructing it threw "Illegal constructor".
    const script = await (await fetch(`${base}/pingfront.js`)).text();
    await page.addScriptTag({ content: script });
    const tags = await page.evaluate((key) => {
      (globalThis as unknown as { PingFront: { configure: (k: string, o: object) => void } }).PingFront.configure(key, { baseUrl: "/v1", logLevel: "off" });
      return [...document.body.children].map((e) => e.tagName.toLowerCase()).filter((t) => t.startsWith("pingfront"));
    }, KEY);
    expect(errors).toEqual([]);
    // The first copy keeps its chat; the second registers the next free tag and draws its own.
    expect(tags).toEqual(["pingfront-chat", "pingfront-chat-2"]);
    expect(await page.evaluate(() => Boolean(document.querySelector("pingfront-chat-2")?.shadowRoot?.querySelector(".launch")))).toBe(true);
    await page.close();
  });

  it("draws its own text right on a page in another charset (the script is ASCII)", { timeout: 60_000 }, async () => {
    const script = await (await fetch(`${base}/pingfront.js`)).text();
    expect([...script].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.host !== "api.test") return r.continue();
      if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PATCH, DELETE" } });
      const k = `${r.method()} ${u.pathname}`;
      if (k === "POST /v1/sessions") return r.respond(json({ installId: "11111111-1111-4111-8111-000000000001", accessToken: "t", accessExpiresIn: 3600, installSecret: "s", person: { id: "per_1", level: "guest" } }, 201));
      if (k === "GET /v1/thread") return r.respond(json({ thread: null, messages: [], hasOlder: false, team: [], policy: { canSend: true } }));
      if (k === "POST /v1/thread/messages") return; // never answers: the message stays "Sending…"
      return r.respond(json({ error: { code: "not_found", message: "", docs: "" } }, 404));
    });
    // Without the escapes, "Sending…" would read "Sendingâ€¦" here.
    await page.goto(`${base}/latin1`, { waitUntil: "load" });
    await page.evaluate((key) => {
      const pf = (globalThis as unknown as { PingFront: { configure: (k: string, o: object) => void; open: () => void } }).PingFront;
      pf.configure(key, { baseUrl: "http://api.test/v1", logLevel: "off" });
      pf.open();
    }, KEY);
    await page.waitForFunction(() => document.querySelector("pingfront-chat")?.shadowRoot?.querySelector("textarea:not([disabled])"));
    await page.evaluate(() => {
      const ta = document.querySelector("pingfront-chat")!.shadowRoot!.querySelector("textarea")!;
      ta.value = "Hello";
      ta.dispatchEvent(new Event("input"));
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector("pingfront-chat")!.shadowRoot!.querySelector(".pend .meta"));
    expect(await page.evaluate(() => document.querySelector("pingfront-chat")!.shadowRoot!.querySelector(".pend .meta")!.textContent)).toBe("Sending\u2026");
    await page.close();
  });

  it("lays out an English card question left to right in a right-to-left chat", { timeout: 60_000 }, async () => {
    // Its own context: an install saved by an earlier test on this origin would take the refresh path.
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setRequestInterception(true);
    const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    const question = "How was this conversation?";
    const msg = { id: "m1", seq: 1, author: { kind: "team", id: "mem_1", name: "Deniz" }, parts: [{ type: "card", card: { kind: "rating", id: "c1", question } }], createdAt: new Date().toISOString() };
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.host !== "api.test") return r.continue();
      if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PATCH, DELETE" } });
      const k = `${r.method()} ${u.pathname}`;
      if (k === "POST /v1/sessions") return r.respond(json({ installId: "11111111-1111-4111-8111-000000000001", accessToken: "t", accessExpiresIn: 3600, installSecret: "s", person: { id: "per_1", level: "guest" } }, 201));
      if (k === "GET /v1/config") return r.respond(json({ schema: 1, revision: 1, draft: false, appName: "Clockwise", look: { theme: {}, header: {}, welcome: {}, topics: [], composer: {}, messages: {} }, team: [], features: { photos: true, reports: true, translation: false, ai: false } }));
      if (k === "GET /v1/thread") return r.respond(json({ thread: { id: "thr_1", status: "open", lastSeq: 1, readSeq: 1, teamReadSeq: 0, unread: 0, rev: 1 }, messages: [msg], hasOlder: false, team: [], policy: { canSend: true } }));
      return r.respond(json({ error: { code: "not_found", message: "", docs: "" } }, 404));
    });
    await page.goto(`${base}/rtl`, { waitUntil: "load" });
    await page.evaluate((key) => {
      const pf = (globalThis as unknown as { PingFront: { configure: (k: string, o: object) => void; open: () => void } }).PingFront;
      pf.configure(key, { baseUrl: "http://api.test/v1", logLevel: "off", locale: "en" });
      pf.open();
    }, KEY);
    await page.waitForFunction(() => document.querySelector("pingfront-chat")?.shadowRoot?.querySelector(".cb strong"));
    // The question mark ends an English sentence, so it sits right of the first word, even in a right-to-left chat
    // (before 2026-11-06 it read "?How was this conversation").
    const x = await page.evaluate(() => {
      const el = document.querySelector("pingfront-chat")!.shadowRoot!.querySelector(".cb strong")!.firstChild as Text;
      const at = (i: number) => {
        const r = document.createRange();
        r.setStart(el, i);
        r.setEnd(el, i + 1);
        return r.getBoundingClientRect().left;
      };
      return { first: at(0), mark: at(el.length - 1) };
    });
    expect(x.mark).toBeGreaterThan(x.first);
    await ctx.close();
  });

  it("keeps Tab inside the photo lightbox", { timeout: 60_000 }, async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/strict`, { waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("pingfront-chat")?.shadowRoot?.querySelector(".panel:not([hidden])"));
    // The lightbox as a tapped photo opens it.
    await page.evaluate(() => {
      const root = document.querySelector("pingfront-chat")!.shadowRoot!;
      const el = document.querySelector("pingfront-chat") as unknown as { lightbox(src: string): void };
      (root.querySelector(".head .x") as HTMLElement).focus();
      el.lightbox("data:image/gif;base64,R0lGODlhAQABAAAAACw=");
    });
    const where = () => page.evaluate(() => {
      const a = document.querySelector("pingfront-chat")!.shadowRoot!.activeElement;
      return a?.closest(".lb") ? "lightbox" : a?.className ?? "none";
    });
    expect(await where()).toBe("lightbox");
    await page.keyboard.press("Tab");
    expect(await where()).toBe("lightbox");
    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");
    expect(await where()).toBe("lightbox");
    await page.close();
  });
});
