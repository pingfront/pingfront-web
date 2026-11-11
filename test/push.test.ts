// Web push for people: the payload decoder, the service worker on a fake scope, and
// enablePush / disablePush / logout against a fake browser (permission, worker, PushManager).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeWebPushPayload } from "../src/core/decode";
import { Engine } from "../src/core/engine";
import type { PushEnv } from "../src/core/push";
import { vapidKeyBytes, workerUrl } from "../src/lazy/push";
import { memoryStore } from "../src/core/storage";
import { install, notificationFor, pageToOpen } from "../src/sw";
import { KEY, fakeApi, session, type Route } from "./helpers";

const VAPID = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

describe("PersonWebPushPayload", () => {
  it("an unknown kind decodes to unknown and still shows", () => {
    expect(decodeWebPushPayload({ v: 1, kind: "nudge", appId: "a", title: "t", body: "b" })?.kind).toBe("unknown");
    expect(notificationFor({ v: 1, kind: "nudge", appId: "a", title: "t", body: "b" })?.title).toBe("t");
  });

  it("shows silently only when the app turned the sound off", () => {
    const base = { v: 1, kind: "message", appId: "a", title: "t", body: "b" };
    expect(notificationFor({ ...base, silent: true })?.options.silent).toBe(true);
    expect(notificationFor(base)?.options).not.toHaveProperty("silent");
    expect(notificationFor({ ...base, silent: false })?.options).not.toHaveProperty("silent");
    expect(notificationFor({ ...base, silent: "yes" })?.options).not.toHaveProperty("silent");
  });
});

describe("the service worker", () => {
  const scopeUrl = "https://app.example.com/";
  function fakeScope(pages: { url: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }[]) {
    const handlers: Record<string, (e: unknown) => void> = {};
    const shown: { title: string; options: NotificationOptions }[] = [];
    const opened: string[] = [];
    const waits: Promise<unknown>[] = [];
    const scope = {
      location: { href: `${scopeUrl}pingfront-sw.js?pf_open=${encodeURIComponent("/app?tab=2")}` },
      registration: { scope: scopeUrl, showNotification: async (title: string, options: NotificationOptions) => void shown.push({ title, options }) },
      clients: { matchAll: async () => pages, openWindow: async (u: string) => void opened.push(u) },
      skipWaiting: async () => undefined,
      addEventListener: (t: string, fn: (e: unknown) => void) => void (handlers[t] = fn),
    };
    install(scope as never);
    const fire = async (t: string, e: object) => {
      handlers[t]!({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    };
    return { fire, shown, opened };
  }

  it("shows a push with its tag and thread", async () => {
    const s = fakeScope([]);
    const value = { v: 1, kind: "message", appId: "app_1", threadId: "thr_1", messageId: "msg_1", unread: 1, title: "Deniz from Clockwise", body: "Yes, your streak is back", tag: "pf-thr_1" };
    await s.fire("push", { data: { json: () => value } });
    expect(s.shown).toEqual([{ title: "Deniz from Clockwise", options: { body: "Yes, your streak is back", tag: "pf-thr_1", data: { threadId: "thr_1" } } }]);
  });

  it("ignores a payload it can't read, and config pushes", async () => {
    const s = fakeScope([]);
    await s.fire("push", { data: { json: () => { throw new SyntaxError("not json"); } } });
    await s.fire("push", { data: { json: () => ({ v: 1, kind: "config", appId: "a", title: "t", body: "b" }) } });
    expect(s.shown).toEqual([]);
  });

  it("a click focuses an open page and asks it to open the chat", async () => {
    const page = { url: "https://app.example.com/app", focus: vi.fn(async () => undefined), postMessage: vi.fn() };
    const s = fakeScope([page]);
    await s.fire("notificationclick", { notification: { close: vi.fn(), data: { threadId: "thr_1" } } });
    expect(page.focus).toHaveBeenCalled();
    expect(page.postMessage).toHaveBeenCalledWith({ type: "pingfront-open", threadId: "thr_1" });
    expect(s.opened).toEqual([]);
  });

  it("with no page open, a click opens the page enablePush ran on, with the chat open", async () => {
    const other = { url: "https://elsewhere.example/", focus: vi.fn(), postMessage: vi.fn() };
    const s = fakeScope([other]);
    await s.fire("notificationclick", { notification: { close: vi.fn(), data: null } });
    expect(s.opened).toEqual(["https://app.example.com/app?tab=2#pingfront-open"]);
    expect(other.postMessage).not.toHaveBeenCalled();
  });

  it("never opens another origin, whatever the worker URL says", () => {
    expect(pageToOpen(`${scopeUrl}sw.js?pf_open=${encodeURIComponent("https://evil.example/")}`, scopeUrl)).toBe("https://app.example.com/#pingfront-open");
    expect(pageToOpen(`${scopeUrl}sw.js`, scopeUrl)).toBe("https://app.example.com/#pingfront-open");
  });
});

describe("enablePush", () => {
  type Sub = { toJSON(): unknown; unsubscribe: ReturnType<typeof vi.fn> };
  function fakeEnv(permission: NotificationPermission, answer: NotificationPermission = "granted") {
    let sub: Sub | null = null;
    const subscribe = vi.fn(async (o: { applicationServerKey: Uint8Array }) => {
      expect(o.applicationServerKey).toEqual(vapidKeyBytes(VAPID));
      sub = { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p", auth: "a" } }), unsubscribe: vi.fn(async () => ((sub = null), true)) };
      return sub;
    });
    const pushManager = { getSubscription: async () => sub, subscribe };
    let scriptURL = "";
    const reg = { pushManager, get active() {
      return { scriptURL };
    } };
    const listeners: ((e: MessageEvent) => void)[] = [];
    const notification = { permission, requestPermission: vi.fn(async () => answer) };
    const env: PushEnv = {
      notification,
      hasPushManager: true,
      serviceWorker: {
        register: vi.fn(async (u: string) => ((scriptURL = `https://app.example.com${u}`), reg)),
        ready: Promise.resolve(reg),
        getRegistrations: async () => [reg],
        addEventListener: (_t: string, fn: (e: MessageEvent) => void) => void listeners.push(fn),
        removeEventListener: () => undefined,
      } as unknown as ServiceWorkerContainer,
    };
    return { env, notification, subscribe, sub: () => sub, message: (data: unknown) => listeners.forEach((l) => l({ data } as MessageEvent)) };
  }

  function engineWith(env: PushEnv, routes: Record<string, Route> = {}, config: Record<string, unknown> = { webPushKey: VAPID }) {
    const patches: unknown[] = [];
    const api = fakeApi({
      "POST /sessions": () => ({ status: 201, body: session(1) }),
      "GET /config": () => ({ status: 200, body: { revision: 1, appName: "Clockwise", look: {}, team: [], features: {}, ...config } }),
      "PATCH /me": (c) => (patches.push(c.body), { status: 200, body: { person: { id: "per_1", level: "guest" } } }),
      "POST /me/logout": () => ({ status: 204 }),
      ...routes,
    });
    const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: api.rt, store: memoryStore(), logLevel: "off", pushEnv: env });
    return { engine, api, patches };
  }

  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
  afterEach(() => vi.useRealTimers());

  it("never prompts or sends on its own", async () => {
    const f = fakeEnv("default");
    const { api } = engineWith(f.env);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.notification.requestPermission).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });

  it("asks, subscribes with the server's key and registers the subscription", async () => {
    const f = fakeEnv("default");
    const { engine, patches } = engineWith(f.env);
    expect(await engine.enablePush({ serviceWorker: "/sw/pingfront-sw.js" })).toBe("enabled");
    expect(f.notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(f.env.serviceWorker!.register).toHaveBeenCalledWith(workerUrl("/sw/pingfront-sw.js", "/"));
    expect(patches).toEqual([{ push: { provider: "webpush", token: JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p", auth: "a" } }) } }]);
  });

  it("a declined prompt subscribes nothing", async () => {
    const f = fakeEnv("default", "denied");
    const { engine, api } = engineWith(f.env);
    expect(await engine.enablePush()).toBe("denied");
    expect(f.subscribe).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });

  it("asks once, before push.js loads, and uses the push option's worker", async () => {
    const f = fakeEnv("default", "default");
    const { api } = engineWith(f.env);
    const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: api.rt, store: memoryStore(), logLevel: "off", pushEnv: f.env, push: { serviceWorker: "/sw/pingfront-sw.js" } });
    const result = engine.enablePush();
    // Called in the same task as enablePush(), inside the person's gesture.
    expect(f.notification.requestPermission).toHaveBeenCalledTimes(1);
    // A dismissed prompt is not asked again behind the person's back.
    expect(await result).toBe("denied");
    expect(f.notification.requestPermission).toHaveBeenCalledTimes(1);
    const g = fakeEnv("default");
    const second = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: engineWith(g.env).api.rt, store: memoryStore(), logLevel: "off", pushEnv: g.env, push: { serviceWorker: "/sw/pingfront-sw.js" } });
    expect(await second.enablePush()).toBe("enabled");
    expect(g.env.serviceWorker!.register).toHaveBeenCalledWith(workerUrl("/sw/pingfront-sw.js", "/"));
  });

  it("unsupported browsers and servers without a key say so", async () => {
    const f = fakeEnv("granted");
    expect(await engineWith({ ...f.env, hasPushManager: false }).engine.enablePush()).toBe("unsupported");
    expect(await engineWith(f.env, {}, {}).engine.enablePush()).toBe("unavailable");
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it("a rejected subscription is removed from the browser", async () => {
    const f = fakeEnv("granted");
    const { engine } = engineWith(f.env, { "PATCH /me": () => ({ status: 200, body: { person: { id: "per_1", level: "guest" }, rejected: [{ field: "push", code: "invalid" }] } }) });
    expect(await engine.enablePush()).toBe("rejected");
    expect(f.sub()).toBeNull();
  });

  it("disablePush tells the server and unsubscribes; logout and erase unsubscribe", async () => {
    const f = fakeEnv("granted");
    const { engine, patches } = engineWith(f.env, { "DELETE /me": () => ({ status: 204 }) });
    await engine.enablePush();
    await engine.disablePush();
    expect(patches.at(-1)).toEqual({ push: null });
    expect(f.sub()).toBeNull();
    await engine.enablePush();
    await engine.logout();
    expect(f.sub()).toBeNull();
    await engine.enablePush();
    await engine.eraseMyData();
    expect(f.sub()).toBeNull();
  });

  it("a notification click on an open page opens the chat", async () => {
    const f = fakeEnv("granted");
    const { engine } = engineWith(f.env);
    f.message({ type: "pingfront-open", threadId: "thr_1" });
    expect(engine.state.visible).toBe(true);
  });
});
