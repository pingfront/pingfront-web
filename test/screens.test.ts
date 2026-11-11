// Saved links into app screens (the protocol, "Saved links"): the screens registry rides on requests the SDK
// makes anyway, and a link card's tap goes to the app's screen handler, then `url`, with one report per tap.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeCard } from "../src/core/decode";
import { memoryStore } from "../src/core/storage";
import { acts, app, card, engineWith, tapped } from "./link-tap";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("registerScreens", () => {
  it("keeps valid ids once, at most 200, and trims titles to 60 code points", () => {
    const { engine } = engineWith();
    const many = Array.from({ length: 205 }, (_, i) => ({ id: `s${i}` }));
    engine.registerScreens([{ id: "settings.sound", title: "🔔".repeat(70) }, { id: "settings.sound" }, { id: "-bad" }, { id: "has space" }, { id: "x".repeat(101) }, ...many]);
    const screens = engine.session.screens!;
    expect(screens).toHaveLength(200);
    expect(screens[0]).toEqual({ id: "settings.sound", title: "🔔".repeat(60) });
    expect(screens.filter((s) => s.id === "settings.sound")).toHaveLength(1);
    expect(screens.map((s) => s.id)).not.toContain("-bad");
    expect(screens.at(-1)).toEqual({ id: "s198" });
  });

  it("accepts the documented shapes of ids", () => {
    const { engine } = engineWith({}, { debug: true });
    engine.registerScreens([{ id: "plans/yearly" }, { id: "a:b-c_d.e" }, { id: "0" }, { id: "x".repeat(100) }]);
    expect(engine.session.screens).toHaveLength(4);
  });

  it("throws on a bad id in debug", () => {
    const { engine } = engineWith({}, { debug: true });
    expect(() => engine.registerScreens([{ id: "/settings" }])).toThrow(/registerScreens/);
    expect(() => engine.registerScreens([{ id: "a" }, { id: "a" }])).toThrow(/registerScreens/);
    expect(() => engine.registerScreens(Array.from({ length: 201 }, (_, i) => ({ id: `s${i}` })))).toThrow(/registerScreens/);
  });
});

describe("the screens registry on the wire", () => {
  it("sends nothing by itself, then rides on the session create", async () => {
    const { engine, api } = engineWith();
    engine.registerScreens([{ id: "settings.sound", title: "Sound settings" }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.calls).toHaveLength(0);
    await engine.prepare();
    expect(app(api.calls.find((c) => c.path === "/sessions"))).toEqual({ version: "2.0", build: "10", bundleId: "localhost", screens: [{ id: "settings.sound", title: "Sound settings" }] });
  });

  it("sends [] when the app registered none, and no field when it never called", async () => {
    const a = engineWith();
    a.engine.registerScreens([]);
    await a.engine.prepare();
    expect(app(a.api.calls[0])).toMatchObject({ screens: [] });
    const b = engineWith();
    await b.engine.prepare();
    expect(app(b.api.calls[0])).not.toHaveProperty("screens");
  });

  it("a refresh sends them only when the list or the app version changed", async () => {
    const store = memoryStore();
    const first = engineWith({}, { store });
    first.engine.registerScreens([{ id: "home" }]);
    await first.engine.prepare();
    first.engine.destroy();

    const same = engineWith({}, { store });
    same.engine.registerScreens([{ id: "home" }]);
    await same.engine.prepare();
    expect(same.api.calls[0]!.path).toBe("/sessions/refresh");
    expect(app(same.api.calls[0])).not.toHaveProperty("screens");
    same.engine.destroy();

    const changed = engineWith({}, { store });
    changed.engine.registerScreens([{ id: "home" }, { id: "plans" }]);
    await changed.engine.prepare();
    expect(app(changed.api.calls[0])).toMatchObject({ screens: [{ id: "home" }, { id: "plans" }] });
    changed.engine.destroy();

    const upgraded = engineWith({}, { store, version: "2.1" });
    upgraded.engine.registerScreens([{ id: "home" }, { id: "plans" }]);
    await upgraded.engine.prepare();
    expect(app(upgraded.api.calls[0])).toMatchObject({ version: "2.1", screens: [{ id: "home" }, { id: "plans" }] });
    upgraded.engine.destroy();

    const again = engineWith({}, { store, version: "2.1" });
    again.engine.registerScreens([{ id: "home" }, { id: "plans" }]);
    await again.engine.prepare();
    expect(app(again.api.calls[0])).not.toHaveProperty("screens");
  });

  it("a change after the session goes on the next PATCH /me, never on its own", async () => {
    const { engine, api } = engineWith();
    engine.registerScreens([{ id: "home" }]);
    await engine.prepare();
    engine.registerScreens([{ id: "home" }, { id: "plans" }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.count("PATCH /me")).toBe(0);
    engine.setTraits({ plan: "pro" });
    await vi.advanceTimersByTimeAsync(300);
    const patch = api.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ traits: { plan: "pro" }, device: { app: { version: "2.0", build: "10", bundleId: "localhost", screens: [{ id: "home" }, { id: "plans" }] } } });
    engine.setTraits({ plan: "max" });
    await vi.advanceTimersByTimeAsync(300);
    expect(api.calls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({ traits: { plan: "max" } });
  });
});

describe("a link card's tap", () => {
  it("opens a registered screen through onScreen, with its params", async () => {
    const seen: unknown[] = [];
    const out = await tapped(card({ screen: { id: "settings.sound", params: { tab: "alerts" } }, url: "https://example.com/sound" }), (e) => {
      e.onScreen = (s) => (seen.push(s), Promise.resolve(true));
    });
    expect(seen).toEqual([{ id: "settings.sound", params: { tab: "alerts" } }]);
    expect(out).toEqual([{ messageId: "msg_1", action: "opened" }]);
  });

  it("reports not_handled when the handler returns false, throws, or isn't set (no fallback to url)", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const c = card({ screen: { id: "settings.sound" }, url: "https://example.com/sound" });
    expect(await tapped(c, (e) => (e.onScreen = () => false))).toEqual([{ messageId: "msg_1", action: "failed", failure: "not_handled" }]);
    expect(await tapped(c, (e) => (e.onScreen = () => Promise.reject(new Error("no"))))).toEqual([{ messageId: "msg_1", action: "failed", failure: "not_handled" }]);
    expect(await tapped(c)).toEqual([{ messageId: "msg_1", action: "failed", failure: "not_handled" }]);
    expect(open).not.toHaveBeenCalled();
  });

  it("waits 10 s for onScreen, then reports not_handled and ignores the late answer", async () => {
    const { engine, api } = engineWith();
    engine.registerScreens([{ id: "settings.sound" }]);
    await engine.prepare();
    let answer: (ok: boolean) => void = () => undefined;
    engine.onScreen = () => new Promise<boolean>((r) => (answer = r));
    let done = false;
    const tap = engine.tapLink(card({ screen: { id: "settings.sound" } }), "msg_1").then(() => (done = true));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    expect(acts(api)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await tap;
    await vi.advanceTimersByTimeAsync(0);
    expect(acts(api)).toEqual([{ messageId: "msg_1", action: "failed", failure: "not_handled" }]);
    answer(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(acts(api)).toEqual([{ messageId: "msg_1", action: "failed", failure: "not_handled" }]);
  });

  it("an answer inside 10 s wins, and leaves no timer behind", async () => {
    const { engine, api } = engineWith();
    engine.registerScreens([{ id: "settings.sound" }]);
    await engine.prepare();
    engine.onScreen = () => new Promise<boolean>((r) => setTimeout(() => r(true), 9_000));
    const tap = engine.tapLink(card({ screen: { id: "settings.sound" } }), "msg_1");
    await vi.advanceTimersByTimeAsync(9_000);
    await tap;
    await vi.advanceTimersByTimeAsync(0);
    expect(acts(api)).toEqual([{ messageId: "msg_1", action: "opened" }]);
    // The 10 s deadline was cancelled: no timer but the engine's own remains for it.
    const pending = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acts(api)).toEqual([{ messageId: "msg_1", action: "opened" }]);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(pending);
  });

  it("a late rejection after the deadline is ignored too", async () => {
    const { engine, api } = engineWith();
    engine.registerScreens([{ id: "settings.sound" }]);
    await engine.prepare();
    let fail: (e: Error) => void = () => undefined;
    engine.onScreen = () => new Promise<boolean>((_, r) => (fail = r));
    const tap = engine.tapLink(card({ screen: { id: "settings.sound" } }), "msg_1");
    await vi.advanceTimersByTimeAsync(10_000);
    await tap;
    fail(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(acts(api)).toEqual([{ messageId: "msg_1", action: "failed", failure: "not_handled" }]);
  });

  it("falls back to url for a screen this build didn't register", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const onScreen = vi.fn(() => true);
    const out = await tapped(card({ screen: { id: "plans.yearly" }, url: "https://example.com/plans" }), (e) => (e.onScreen = onScreen));
    expect(onScreen).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("https://example.com/plans", "_blank", "noopener,noreferrer");
    expect(out).toEqual([{ messageId: "msg_1", action: "opened" }]);
  });

  it("reports unknown_screen with nothing to fall back to", async () => {
    expect(await tapped(card({ screen: { id: "plans.yearly" }, url: "" }), (e) => (e.onScreen = () => true))).toEqual([{ messageId: "msg_1", action: "failed", failure: "unknown_screen" }]);
  });

  it("reports cannot_open for a URL nothing opens, and opened when onLink takes it", async () => {
    expect(await tapped(card({ url: "myapp://plans" }))).toEqual([{ messageId: "msg_1", action: "failed", failure: "cannot_open" }]);
    expect(await tapped(card({ url: "myapp://plans" }), (e) => (e.onLink = () => true))).toEqual([{ messageId: "msg_1", action: "opened" }]);
  });

  it("opens the app's own scheme through onLink, with the URL cleaned", async () => {
    const seen: string[] = [];
    const out = await tapped(card({ url: " myapp://plans\n" }), (e) => (e.onLink = (u) => (seen.push(u.href), true)));
    expect(seen).toEqual(["myapp://plans"]);
    expect(out).toEqual([{ messageId: "msg_1", action: "opened" }]);
  });

  it("emits cardOpened once per tap", async () => {
    const { engine } = engineWith();
    await engine.prepare();
    const seen: unknown[] = [];
    engine.events.on("cardOpened", (e) => seen.push(e));
    await engine.tapLink(card({ url: "myapp://x" }), "msg_1");
    expect(seen).toEqual([{ kind: "link", cardId: "c_link", messageId: "msg_1" }]);
  });
});

describe("decoding", () => {
  it("keeps screen and savedLinkId, and ignores what it can't use", () => {
    const base = { kind: "link", id: "c_link", title: "Sound", url: "", button: "Open" };
    expect(decodeCard({ ...base, screen: { id: "settings.sound", params: { tab: "a" }, extra: 1 }, savedLinkId: "sl_1", future: true })).toEqual({ ...base, screen: { id: "settings.sound", params: { tab: "a" } }, savedLinkId: "sl_1" });
    expect(decodeCard({ ...base, screen: { params: {} } })).toEqual(base);
    expect(decodeCard({ ...base, screen: "settings", savedLinkId: 7 })).toEqual(base);
  });
});
