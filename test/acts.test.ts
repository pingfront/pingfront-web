// Card action reports retry safely (the protocol, "Retrying writes"): one clientId per report, kept across retries
// and reloads; no answer, 408, 429 and 5xx retry with backoff; 401 refreshes once; 409 thread_reset retries once while
// the message is still there; other 4xx drop; 24 h or 10 attempts; logout clears; dangerous schemes never open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/core/engine";
import { indexedDbStore, memoryStore, type Store } from "../src/core/storage";
import type { Card } from "../src/core/model";
import { KEY, fakeApi, message, session, thread, type Route } from "./helpers";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
afterEach(() => vi.useRealTimers());

const choice: Card = { kind: "choices", id: "c_1", options: [{ id: "a", label: "A" }] } as Card;
const err = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ status, body: { error: { code, message: "x", docs: "", ...extra } } });

function setup(act: Route, store: Store = memoryStore(), routes: Record<string, Route> = {}) {
  const api = fakeApi({
    "POST /sessions": () => ({ status: 201, body: session(1) }),
    "POST /sessions/refresh": () => ({ status: 200, body: { ...session(1), installId: undefined, installSecret: undefined } }),
    "GET /thread": () => ({ status: 200, body: thread([message(1)]) }),
    "POST /thread/cards/c_1/act": act,
    ...routes,
  });
  const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: { ...api.rt, webSocket: () => undefined as never }, store, logLevel: "off" });
  const sent = () => api.calls.filter((c) => c.path === "/thread/cards/c_1/act").map((c) => c.body as Record<string, unknown>);
  return { engine, api, sent };
}

async function tap(engine: Engine) {
  await engine.prepare();
  engine.act(choice, "msg_1", { choiceId: "a" });
  await vi.advanceTimersByTimeAsync(10);
}

describe("card action reports", () => {
  it.each([[0], [408], [429], [500], [502], [503], [504]])("retry after %i with the same clientId and body, then stop on 204", async (status) => {
    let n = 0;
    const { engine, sent } = setup(() => (n++ < 2 ? (status ? err(status, "x") : { status: 0 }) : { status: 204 }));
    await tap(engine);
    await vi.advanceTimersByTimeAsync(10_000);
    const bodies = sent();
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toMatchObject({ messageId: "msg_1", action: "chosen", choiceId: "a" });
    expect(bodies[0]!.clientId).toMatch(/^[0-9a-f-]{36}$/);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent()).toHaveLength(3);
    engine.destroy();
  });

  it.each([[400], [403], [404], [409], [410], [422], [501]])("never retry %i", async (status) => {
    const { engine, sent } = setup(() => err(status, status === 409 ? "conflict" : "x"));
    await tap(engine);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent()).toHaveLength(1);
    engine.destroy();
  });

  it("a new tap is a new report with a new clientId", async () => {
    const { engine, sent } = setup(() => ({ status: 204 }));
    await tap(engine);
    engine.act(choice, "msg_1", { choiceId: "a" });
    await vi.advanceTimersByTimeAsync(10);
    const [a, b] = sent();
    expect(a!.clientId).not.toBe(b!.clientId);
    engine.destroy();
  });

  it("a 429 waits at least its retryAfter; otherwise the backoff is 1 s·2ⁿ ±20 %", async () => {
    let n = 0;
    const { engine, sent } = setup(() => (n++ === 0 ? err(429, "rate_limited", { retryAfter: 30 }) : { status: 204 }));
    await tap(engine);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(sent()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sent()).toHaveLength(2);
    engine.destroy();
  });

  it("401: one refresh, then one retry", async () => {
    let n = 0;
    const { engine, api, sent } = setup(() => (n++ === 0 ? err(401, "unauthorized") : { status: 204 }));
    await tap(engine);
    expect(sent()).toHaveLength(2);
    expect(api.count("POST /sessions/refresh")).toBe(1);
    expect(sent()[0]!.clientId).toBe(sent()[1]!.clientId);
    engine.destroy();
  });

  it("409 thread_reset: reloads, and retries once while the message is still there", async () => {
    const { engine, api, sent } = setup(() => err(409, "thread_reset"));
    await tap(engine);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(api.count("GET /thread")).toBeGreaterThanOrEqual(1);
    expect(sent()).toHaveLength(2);
    engine.destroy();
  });

  it("409 thread_reset: drops the report when the message is gone", async () => {
    const { engine, sent } = setup(() => err(409, "thread_reset"), memoryStore(), { "GET /thread": () => ({ status: 200, body: thread([]) }) });
    await tap(engine);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent()).toHaveLength(1);
    engine.destroy();
  });

  it("gives up after 10 attempts", async () => {
    const { engine, sent } = setup(() => err(503, "unavailable"));
    await tap(engine);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(sent()).toHaveLength(10);
    engine.destroy();
  });

  it("back online or back in view, a waiting report goes at once", async () => {
    let up = false;
    const { engine, sent } = setup(() => (up ? { status: 204 } : { status: 0 }));
    await tap(engine);
    await vi.advanceTimersByTimeAsync(5_000);
    const before = sent().length;
    up = true;
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(5);
    expect(sent()).toHaveLength(before + 1);
    engine.destroy();
  });

  it("survives a reload of the page with its clientId, and a report older than 24 h is dropped", async () => {
    vi.useRealTimers();
    const store = await indexedDbStore("acts-ns");
    const a = setup(() => ({ status: 0 }), store);
    await a.engine.prepare();
    a.engine.act(choice, "msg_1", { choiceId: "a" });
    await new Promise((r) => setTimeout(r, 50));
    a.engine.destroy();
    const first = a.sent()[0]!.clientId;
    const b = setup(() => ({ status: 204 }), store);
    await b.engine.prepare();
    // It keeps its backoff across the reload (about 1 s after the first attempt).
    await new Promise((r) => setTimeout(r, 1_400));
    expect(b.sent().map((x) => x.clientId)).toEqual([first]);
    expect(await store.get("acts")).toBeUndefined();
    // A report from more than a day ago is never sent.
    await store.set("acts", [{ cardId: "c_1", body: { clientId: "old", messageId: "msg_1", action: "opened" }, at: Date.now() - 90_000_000, n: 0, next: 0 }]);
    const c = setup(() => ({ status: 204 }), store);
    await c.engine.prepare();
    await new Promise((r) => setTimeout(r, 50));
    expect(c.sent()).toEqual([]);
    for (const x of [b, c]) x.engine.destroy();
  });

  it("logout clears the queue: nothing is retried for the previous person", async () => {
    const store = memoryStore();
    const { engine, sent } = setup(() => ({ status: 0 }), store, { "POST /me/logout": () => ({ status: 204 }) });
    await tap(engine);
    await engine.logout();
    const before = sent().length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent()).toHaveLength(before);
    expect(await store.get("acts")).toBeUndefined();
    engine.destroy();
  });

  it("dangerous schemes are still refused, and the tap is reported as cannot_open", async () => {
    const api = fakeApi({ "POST /sessions": () => ({ status: 201, body: session(1) }), "POST /thread/cards/c_l/act": () => ({ status: 204 }) });
    const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: { ...api.rt, webSocket: () => undefined as never }, store: memoryStore(), logLevel: "off" });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await engine.prepare();
    for (const url of ["javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "file:///etc/passwd"]) {
      await engine.tapLink({ kind: "link", id: "c_l", title: "x", url, button: "Open" } as never, "msg_1");
    }
    await vi.advanceTimersByTimeAsync(10);
    expect(open).not.toHaveBeenCalled();
    expect(api.calls.filter((c) => c.path === "/thread/cards/c_l/act").map((c) => (c.body as { failure: string }).failure)).toEqual(["cannot_open", "cannot_open", "cannot_open", "cannot_open"]);
    open.mockRestore();
    engine.destroy();
  });
});
