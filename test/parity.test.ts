// The calls the native SDKs have that the web gained for parity: plan and offers, data export,
// bug reports and the log handler.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/core/engine";
import { create } from "../src/index";
import { memoryStore } from "../src/core/storage";
import { KEY, fakeApi, message, session, thread, type Route } from "./helpers";

const BAD_KEY = "pk_test_abcdefghijklmnopqrstuwvd";

function engineWith(routes: Record<string, Route>) {
  const api = fakeApi({ "POST /sessions": () => ({ status: 201, body: session(1) }), ...routes });
  const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: api.rt, store: memoryStore(), logLevel: "off" });
  return { engine, api };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parity calls", () => {
  it("setEntitlement and setOffers wait for a session, then go out in one PATCH /me", async () => {
    const patches: unknown[] = [];
    const { engine } = engineWith({ "PATCH /me": (c) => (patches.push(c.body), { status: 200, body: { person: { id: "per_1", level: "guest" } } }) });
    engine.setEntitlement({ state: "active", productId: "pro_monthly", source: "stripe", environment: "sandbox" });
    engine.setOffers([{ id: "annual", title: "Annual", kind: "discount", available: true }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(patches).toHaveLength(0);
    await engine.prepare();
    engine.profile.wake();
    await vi.advanceTimersByTimeAsync(300);
    expect(patches).toEqual([
      { entitlement: { state: "active", productId: "pro_monthly", source: "stripe", environment: "sandbox" }, offers: [{ id: "annual", title: "Annual", kind: "discount", available: true, source: "app" }] },
    ]);
  });

  it("a failed PATCH keeps the plan for the retry, and newer values win", async () => {
    const patches: unknown[] = [];
    let fail = true;
    const { engine } = engineWith({
      "PATCH /me": (c) => {
        patches.push(c.body);
        if (fail) return (fail = false), { status: 503, body: { error: { code: "unavailable", message: "", docs: "" } } };
        return { status: 200, body: { person: { id: "per_1", level: "guest" } } };
      },
    });
    await engine.prepare();
    engine.setEntitlement({ state: "trial" });
    await vi.advanceTimersByTimeAsync(300);
    engine.setTraits({ plan: "pro" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(patches.at(-1)).toEqual({ entitlement: { state: "trial" }, traits: { plan: "pro" } });
  });

  it("exportMyData returns the server's document", async () => {
    const { engine, api } = engineWith({ "GET /me/export": () => ({ status: 200, body: { person: { id: "per_1" }, messages: [] } }) });
    expect(await engine.exportMyData()).toMatchObject({ person: { id: "per_1" } });
    expect(api.calls.at(-1)!.headers.Authorization).toBe("Bearer token-1");
  });

  it("reportBug posts the report and adds its message to the thread", async () => {
    const { engine, api } = engineWith({
      "POST /reports": (c) => ({ status: 201, body: { threadId: "thr_1", message: { ...message(5, "person", "It crashed"), clientId: (c.body as { clientId: string }).clientId } } }),
    });
    const sent: unknown[] = [];
    engine.events.on("reportSent", (m) => sent.push(m));
    await engine.reportBug("It crashed", { logTail: "é".repeat(40_000), state: { screen: "settings" } });
    const body = api.calls.find((c) => c.path === "/reports")!.body as { text: string; screenshotIds: string[]; logTail: string };
    expect(body).toMatchObject({ text: "It crashed", screenshotIds: [], state: { screen: "settings" } });
    expect(new TextEncoder().encode(body.logTail).length).toBeLessThanOrEqual(65536);
    expect(body.logTail.startsWith("é")).toBe(true);
    expect(engine.state.messages.map((m) => m.id)).toContain("msg_5");
    expect(sent).toHaveLength(1);
    await expect(engine.reportBug("x".repeat(4001))).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("logHandler receives the lines at or above the level, and a throwing handler is harmless", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lines: { level: string; message: string }[] = [];
    const api = fakeApi({});
    const engine = new Engine(BAD_KEY, { runtime: api.rt, store: memoryStore(), logLevel: "error", logHandler: (e) => lines.push(e) });
    expect(engine.state.problem?.code).toBe("key_invalid");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.level === "error")).toBe(true);
    const throwing = new Engine(BAD_KEY, {
      runtime: api.rt,
      store: memoryStore(),
      logLevel: "error",
      logHandler: () => {
        throw new Error("host bug");
      },
    });
    expect(throwing.state.problem?.code).toBe("key_invalid");
  });
});

describe("native event names", () => {
  it("chatOpened and messageSent are open and sent under the native SDKs' names; `*` sees each once", async () => {
    vi.useRealTimers();
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
    const api = fakeApi({
      "POST /sessions": () => ({ status: 201, body: session(1) }),
      "GET /thread": () => ({ status: 200, body: thread([]) }),
      "POST /thread/read": () => ({ status: 200, body: { readSeq: 0, unread: 0 } }),
      "POST /thread/messages": (c) => ({ status: 201, body: { threadId: "thr_1", message: { ...message(1, "person", "Hello"), clientId: (c.body as { clientId: string }).clientId } } }),
    });
    const chat = create(KEY, { baseUrl: "http://api.test/v1", runtime: { ...api.rt, webSocket: () => undefined }, store: memoryStore(), logLevel: "off", launcher: false });
    const seen: string[] = [];
    chat.on("chatOpened", () => seen.push("chatOpened"));
    chat.on("open", () => seen.push("open"));
    chat.on("messageSent", () => seen.push("messageSent"));
    chat.on("sent", () => seen.push("sent"));
    const all: string[] = [];
    chat.on<{ type: string }>("*", (e) => all.push(e.type));
    chat.open();
    const frames = () => new Promise((r) => setTimeout(r, 50));
    await frames();
    const root = document.querySelector("pingfront-chat")!.shadowRoot!;
    const box = root.querySelector("textarea")!;
    box.value = "Hello";
    box.dispatchEvent(new Event("input"));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    for (let i = 0; i < 20 && !seen.includes("sent"); i++) await frames();
    chat.destroy();
    expect(seen).toEqual(["chatOpened", "open", "messageSent", "sent"]);
    expect(all.filter((t) => t === "open" || t === "sent")).toEqual(["open", "sent"]);
    expect(all).not.toContain("chatOpened");
    expect(all).not.toContain("messageSent");
  });
});
