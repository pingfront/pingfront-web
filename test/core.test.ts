// The core against a scripted API: lazy sessions, the outbox, the live socket, read receipts, profile
// coalescing, logout and erase.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PingFrontError } from "../src/core/api";
import { decodeMessage } from "../src/core/decode";
import { Engine } from "../src/core/engine";
import { accentAdjusted, bestText, contrast, resolveLook } from "../src/core/look";
import { Outbox, type OutboxItem } from "../src/core/outbox";
import { tokenSubject } from "../src/core/profile";
import { backoff } from "../src/core/runtime";
import { memoryStore } from "../src/core/storage";
import { buildTimeline } from "../src/core/timeline";
import { KEY, fakeApi, flush, message, session, thread, type Route } from "./helpers";

const config = { schema: 1, revision: 1, draft: false, appName: "Clockwise", look: { theme: {}, header: {}, welcome: {}, topics: [], composer: {}, messages: {} }, team: [{ id: "mem_1", name: "Deniz Kaya" }], features: { photos: true, reports: true, translation: false, ai: false }, liveUrl: "http://api.test/v1/live" };

function engineWith(routes: Record<string, Route>, store = memoryStore()) {
  const api = fakeApi({
    "POST /sessions": () => ({ status: 201, body: session(1) }),
    "POST /sessions/refresh": () => ({ status: 200, body: { ...session(1), installId: undefined, installSecret: undefined } }),
    "GET /config": () => ({ status: 200, body: config, headers: { ETag: '"r1"' } }),
    "GET /thread": () => ({ status: 200, body: thread([message(1)]) }),
    "POST /thread/messages": (c) => ({ status: 201, body: { threadId: "thr_1", message: { ...message(2, "person", (c.body as { text: string }).text), clientId: (c.body as { clientId: string }).clientId } } }),
    "POST /thread/read": (c) => ({ status: 200, body: { readSeq: (c.body as { upToSeq: number }).upToSeq, unread: 0 } }),
    ...routes,
  });
  const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: api.rt, store, logLevel: "off" });
  return { engine, api };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
afterEach(() => vi.useRealTimers());

describe("sessions are lazy", () => {
  it("configure sends nothing; the first open creates the session, then config and thread", async () => {
    const { engine, api } = engineWith({});
    await flush();
    expect(api.calls).toHaveLength(0);
    engine.identify({ userId: "u1", name: "Riley" });
    engine.setTraits({ plan: "pro", seats: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.calls).toHaveLength(0);
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    const create = api.calls.find((c) => c.path === "/sessions")!;
    expect(create.body).toMatchObject({ reason: "chat_opened", identity: { userId: "u1", name: "Riley" }, traits: { plan: "pro", seats: "3" }, device: { platform: "web", sdk: { name: "pingfront-web" } } });
    expect(create.headers["PF-App-Key"]).toBe(KEY);
    expect(create.headers["PF-SDK"]).toMatch(/^pingfront-web\//);
    expect(create.headers["PF-Protocol"]).toBe("1.0.0");
    expect(api.count("GET /thread")).toBe(1);
    expect(engine.state.messages.map((m) => m.id)).toEqual(["msg_1"]);
    // Staged before the session: sent with it, never again as a PATCH.
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.count("PATCH /me")).toBe(0);
  });

  it("a bad key is loud and offline: a problem, no requests", async () => {
    const api = fakeApi({});
    const problems: unknown[] = [];
    const engine = new Engine("pk_test_abcdefghijklmnopqrstuwvd", { runtime: api.rt, store: memoryStore(), logLevel: "off" });
    expect(engine.state.problem?.code).toBe("key_invalid");
    engine.events.on("problem", (p) => problems.push(p));
    engine.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.calls).toHaveLength(0);
    expect((await engine.selfCheck()).line).toMatch(/FAIL key_invalid/);
  });

  it("a stored install refreshes, and concurrent callers share one request", async () => {
    const store = memoryStore();
    await store.set("creds", { installId: "11111111-1111-4111-8111-000000000009", installSecret: "s9" });
    const { engine, api } = engineWith({}, store);
    await Promise.all([engine.session.token(), engine.session.token(), engine.session.token()]);
    expect(api.count("POST /sessions/refresh")).toBe(1);
    expect(api.count("POST /sessions")).toBe(0);
    expect(api.calls[0]!.body).toMatchObject({ installId: "11111111-1111-4111-8111-000000000009", installSecret: "s9", device: { timeZone: expect.any(String) } });
  });

  it("an unknown install (401 on refresh) starts a new guest and wipes the old one", async () => {
    const store = memoryStore();
    await store.set("creds", { installId: "11111111-1111-4111-8111-000000000009", installSecret: "old" });
    const { engine, api } = engineWith({ "POST /sessions/refresh": () => ({ status: 401, body: { error: { code: "session_revoked", message: "Gone", docs: "" } } }) }, store);
    await engine.session.token();
    expect(api.count("POST /sessions")).toBe(1);
    expect(await store.get("creds")).toEqual({ installId: session(1).installId, installSecret: "secret-1" });
  });

  it("a revoked install emits sessionRevoked once, after the wipe, as the native SDKs do", async () => {
    const store = memoryStore();
    await store.set("creds", { installId: "11111111-1111-4111-8111-000000000009", installSecret: "old" });
    const { engine } = engineWith({ "POST /sessions/refresh": () => ({ status: 401, body: { error: { code: "session_revoked", message: "Gone", docs: "" } } }) }, store);
    const seen: { messages: number; pending: number }[] = [];
    engine.events.on("sessionRevoked", () => seen.push({ messages: engine.state.messages.length, pending: engine.outbox.items.length }));
    engine.update({ messages: [decodeMessage(message(1))!] });
    await engine.session.token();
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([{ messages: 0, pending: 0 }]);
  });

  it("session_revoked on a bearer route emits sessionRevoked", async () => {
    let revoked = true;
    const { engine } = engineWith({
      "GET /unread": () => (revoked ? ((revoked = false), { status: 401, body: { error: { code: "session_revoked", message: "", docs: "" } } }) : { status: 200, body: { unread: 0, lastSeq: 0, live: false } }),
    });
    await engine.prepare();
    const seen: unknown[] = [];
    engine.events.on("sessionRevoked", (e) => seen.push(e));
    await engine.api.send({ method: "GET", path: "/unread", auth: "bearer" }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([undefined]);
  });

  it("logout and eraseMyData don't emit sessionRevoked: the app asked for them", async () => {
    const { engine } = engineWith({ "POST /me/logout": () => ({ status: 204 }), "DELETE /me": () => ({ status: 204 }) });
    const seen: unknown[] = [];
    engine.events.on("sessionRevoked", (e) => seen.push(e));
    await engine.prepare();
    await engine.logout();
    await engine.prepare();
    await engine.eraseMyData();
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([]);
  });

  it("a 401 unauthorized refreshes once and retries", async () => {
    let first = true;
    const { engine, api } = engineWith({ "GET /unread": () => (first ? ((first = false), { status: 401, body: { error: { code: "unauthorized", message: "", docs: "" } } }) : { status: 200, body: { unread: 2, lastSeq: 3, live: false } }) });
    // A bearer request never starts a session itself: the person's action (here prepare) does.
    await expect(engine.api.send({ method: "GET", path: "/unread", auth: "bearer" })).rejects.toMatchObject({ code: "cancelled" });
    expect(api.calls).toHaveLength(0);
    await engine.prepare();
    const res = await engine.api.send({ method: "GET", path: "/unread", auth: "bearer" });
    expect(res.data).toMatchObject({ unread: 2 });
    expect(api.count("GET /unread")).toBe(2);
    expect(api.count("POST /sessions") + api.count("POST /sessions/refresh")).toBe(2);
  });

  it("identity tokens name their user locally", () => {
    const payload = btoa(JSON.stringify({ sub: "user_42", iat: 1 })).replace(/=+$/, "");
    expect(tokenSubject(`eyJhbGciOiJIUzI1NiJ9.${payload}.sig`)).toBe("user_42");
    expect(tokenSubject("nope")).toBeUndefined();
  });
});

describe("the outbox", () => {
  const item = (id: string, text: string): OutboxItem => ({ clientId: id, text, photos: [], createdAt: "2026-10-31T12:00:00.000Z", state: "queued", attempts: 0 });

  it("keeps the clientId through retries and delivers in order", async () => {
    const api = fakeApi({});
    const box = new Outbox(async () => memoryStore(), api.rt, () => undefined);
    const seen: string[] = [];
    let fail = 2;
    box.enqueue(item("a", "first"));
    box.enqueue(item("b", "second"));
    const done = box.drain(
      async (i) => {
        seen.push(i.clientId);
        if (i.clientId === "a" && fail-- > 0) return { ok: false, error: new PingFrontError("network", "offline") };
        return { ok: true, message: {} };
      },
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(seen).toEqual(["a", "a", "a", "b"]);
    expect(box.items).toHaveLength(0);
  });

  it("a permanent error marks the item failed and moves on; retry queues it again", async () => {
    const api = fakeApi({});
    const box = new Outbox(async () => memoryStore(), api.rt, () => undefined);
    box.enqueue(item("a", "x"));
    box.enqueue(item("b", "y"));
    await box.drain(async (i) => (i.clientId === "a" ? { ok: false, error: new PingFrontError("server", "Too long", 422, "invalid_request") } : { ok: true, message: {} }), () => undefined);
    // The reason is a key the chat translates, never the error's English message.
    expect(box.items).toMatchObject([{ clientId: "a", state: "failed", failure: "other" }]);
    box.retry("a");
    await box.drain(async () => ({ ok: true, message: {} }), () => undefined);
    expect(box.items).toHaveLength(0);
  });

  it("survives a reload through the store (IndexedDB)", async () => {
    const { indexedDbStore } = await import("../src/core/storage");
    vi.useRealTimers();
    const store = await indexedDbStore("test-ns");
    const api = fakeApi({});
    const a = new Outbox(async () => store, api.rt, () => undefined);
    a.enqueue({ ...item("persisted", "hello"), state: "sending" });
    await new Promise((r) => setTimeout(r, 20));
    const b = new Outbox(async () => store, api.rt, () => undefined);
    await b.load();
    expect(b.items).toMatchObject([{ clientId: "persisted", state: "queued", text: "hello" }]);
  });

  it("sends through the engine with an idempotent clientId and shows the result", async () => {
    let attempts = 0;
    const { engine, api } = engineWith({
      "POST /thread/messages": (c) => (++attempts === 1 ? { status: 0 } : { status: 201, body: { threadId: "thr_1", message: { ...message(2, "person", "Hi"), clientId: (c.body as { clientId: string }).clientId } } }),
    });
    engine.send("Hi");
    await vi.advanceTimersByTimeAsync(5000);
    const sends = api.calls.filter((c) => c.path === "/thread/messages");
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sends.map((c) => (c.body as { clientId: string }).clientId)).size).toBe(1);
    expect(engine.state.pending).toHaveLength(0);
    expect(engine.state.messages.map((m) => m.id)).toContain("msg_2");
  });
});

describe("live", () => {
  it("delivers messages, repairs seq gaps, shows typing and team reads", async () => {
    const { engine, api } = engineWith({
      "GET /thread/messages": () => ({ status: 200, body: { messages: [message(2), message(3)], hasMore: false } }),
    });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    const ws = api.sockets[0]!;
    expect(ws.url).toBe("ws://api.test/v1/live");
    expect(ws.protocols).toEqual(["pingfront.v1", "bearer.token-1"]);
    ws.open();
    ws.receive({ type: "hello", threadId: "thr_1", rev: 1, status: "open", lastSeq: 1, readSeq: 1, teamReadSeq: 0 });
    ws.receive({ type: "typing", author: { kind: "team", name: "Deniz" }, on: true });
    expect(engine.state.typing).toEqual({ name: "Deniz" });
    ws.receive({ type: "message", seq: 4, message: message(4) });
    await vi.advanceTimersByTimeAsync(10);
    expect(api.calls.some((c) => c.path.startsWith("/thread/messages?after=1"))).toBe(true);
    expect(engine.state.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(engine.state.typing).toBeNull();
    ws.receive({ type: "read", by: "team", upToSeq: 4 });
    expect(engine.state.teamReadSeq).toBe(4);
    await vi.advanceTimersByTimeAsync(500);
    expect(api.calls.filter((c) => c.path === "/thread/read").at(-1)?.body).toEqual({ upToSeq: 4 });
  });

  it("a reload the socket asks for (reset, a new rev, close 4000) that fails is reported, never an unhandled rejection", async () => {
    let up = true;
    const { engine, api } = engineWith({ "GET /thread": () => (up ? { status: 200, body: thread([message(1)]) } : { status: 0 }) });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      engine.open();
      await vi.advanceTimersByTimeAsync(10);
      const ws = api.sockets[0]!;
      ws.open();
      up = false;
      ws.receive({ type: "reset" });
      ws.receive({ type: "hello", threadId: "thr_1", rev: 7, status: "open", lastSeq: 1, readSeq: 1, teamReadSeq: 0 });
      ws.close(4000);
      await vi.advanceTimersByTimeAsync(100);
      // The browser is online, so the service is what can't be reached.
      expect(engine.state.notice).toEqual({ kind: "unreachable" });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("delivers each team action once (live and catch-up) and acks the first answer only", async () => {
    const action = (id: string) => ({ id, actionId: "extend_trial", name: "Extend trial", fields: {}, days: 7, ackRequired: true, createdAt: "2026-10-31T10:00:00Z", expiresAt: "2026-11-07T10:00:00Z" });
    let ackStatus = 503;
    const { engine, api } = engineWith({
      "GET /team-actions": () => ({ status: 200, body: { actions: [action("ta_1"), action("ta_2")] } }),
      "POST /team-actions/ta_1/ack": () => ({ status: ackStatus === 503 ? ((ackStatus = 204), 503) : 204 }),
      "POST /team-actions/ta_2/ack": () => ({ status: 409, body: { error: { code: "conflict", message: "", docs: "" } } }),
    });
    const got: { id: string; complete(): Promise<void>; fail(m: string): Promise<void> }[] = [];
    engine.events.on("teamAction", (a: (typeof got)[number]) => got.push(a));
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    const ws = api.sockets[0]!;
    ws.open();
    ws.receive({ type: "team_action", action: action("ta_1") });
    ws.receive({ type: "hello", threadId: "thr_1", rev: 1, status: "open", lastSeq: 1, readSeq: 1, teamReadSeq: 0 });
    await vi.advanceTimersByTimeAsync(10);
    // ta_1 came live, then again in the catch-up: delivered once. ta_2 only in the catch-up.
    expect(got.map((a) => a.id)).toEqual(["ta_1", "ta_2"]);
    void got[0]!.complete();
    void got[0]!.fail("second answer is ignored");
    void got[1]!.fail("x".repeat(300));
    await vi.advanceTimersByTimeAsync(5000);
    // A 503 retries; a 409 (expired) drops without retrying; the second answer to ta_1 is never sent.
    expect(api.count("POST /team-actions/ta_1/ack")).toBe(2);
    expect(api.calls.filter((c) => c.path === "/team-actions/ta_1/ack").every((c) => (c.body as { ok: boolean }).ok)).toBe(true);
    expect(api.count("POST /team-actions/ta_2/ack")).toBe(1);
    expect((api.calls.find((c) => c.path === "/team-actions/ta_2/ack")!.body as { message: string }).message).toHaveLength(200);
  });

  it("passes unknown events to on('live') and reconnects with backoff after a drop", async () => {
    const { engine, api } = engineWith({});
    const live: unknown[] = [];
    engine.events.on("live", (e) => live.push(e));
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    api.sockets[0]!.open();
    api.sockets[0]!.receive({ type: "poll_started", id: "p" });
    expect(live).toEqual([{ type: "unknown", name: "poll_started", raw: { type: "poll_started", id: "p" } }]);
    api.sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(999);
    expect(api.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.sockets).toHaveLength(2);
  });

  it("4001 refreshes the token before reconnecting; 4004 wipes the person", async () => {
    const { engine, api } = engineWith({});
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    api.sockets[0]!.open();
    api.sockets[0]!.close(4001);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.count("POST /sessions/refresh")).toBe(1);
    api.sockets[1]!.open();
    const revoked: unknown[] = [];
    engine.events.on("sessionRevoked", (e) => revoked.push(e));
    api.sockets[1]!.close(4004);
    await vi.advanceTimersByTimeAsync(10);
    expect(engine.state.messages).toHaveLength(0);
    // Erased elsewhere: the server revoked this install too, and the app hears it once.
    expect(revoked).toEqual([undefined]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.sockets).toHaveLength(2);
  });

  it("backoff is min(1 s · 2ⁿ, 30 s) with ±20 % jitter", () => {
    expect(backoff(0, () => 0.5)).toBe(1000);
    expect(backoff(3, () => 0.5)).toBe(8000);
    expect(backoff(10, () => 0.5)).toBe(30_000);
    expect(backoff(0, () => 0)).toBe(800);
    expect(backoff(0, () => 1)).toBe(1200);
  });
});

describe("profile, moments, logout, erase", () => {
  it("coalesces changes after the session into one PATCH /me", async () => {
    const { engine, api } = engineWith({ "PATCH /me": () => ({ status: 200, body: { person: { id: "per_1", level: "named" }, rejected: [] } }) });
    await engine.prepare();
    engine.setTraits({ a: "1" });
    engine.setTraits({ b: "2" });
    engine.identify({ userId: "u1" });
    await vi.advanceTimersByTimeAsync(300);
    expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(api.calls.find((c) => c.method === "PATCH")!.body).toEqual({ traits: { a: "1", b: "2" }, identity: { userId: "u1" } });
  });

  it("a refused identity is dropped and reported", async () => {
    const { engine } = engineWith({ "PATCH /me": () => ({ status: 200, body: { person: { id: "per_1", level: "guest" }, rejected: [{ field: "identity", code: "identity_user_mismatch", message: "x" }] } }) });
    await engine.prepare();
    engine.identify({ userId: "someone_else" });
    await vi.advanceTimersByTimeAsync(300);
    expect(engine.state.problem?.code).toBe("identity_user_mismatch");
  });

  it("only listened moments are sent; an open request opens the chat", async () => {
    const { engine, api } = engineWith({
      "GET /moments/listened": () => ({ status: 200, body: { names: ["paywall_closed"], storeEvents: [] } }),
      "POST /moments": () => ({ status: 200, body: { outcome: "delivered", open: true } }),
    });
    expect(await engine.moment("Bad Name")).toMatchObject({ outcome: "invalid_name" });
    expect(api.calls).toHaveLength(0);
    expect(await engine.moment("something_else")).toMatchObject({ outcome: "not_listened" });
    expect(api.count("POST /sessions")).toBe(0);
    expect(await engine.moment("paywall_closed", { screen: "plans" })).toEqual({ outcome: "delivered", open: true, presented: true });
    expect(api.calls.find((c) => c.path === "/sessions")!.body).toMatchObject({ reason: "moment" });
    expect(engine.state.visible).toBe(true);
    await engine.moment("something_else");
    expect(api.count("GET /moments/listened")).toBe(1);
  });

  it("logout queues POST /me/logout and starts over as a new guest", async () => {
    const store = memoryStore();
    const { engine, api } = engineWith({ "POST /me/logout": () => ({ status: 204 }) }, store);
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    await engine.logout();
    await vi.advanceTimersByTimeAsync(10);
    expect(api.calls.find((c) => c.path === "/me/logout")!.body).toEqual({ installId: session(1).installId, installSecret: "secret-1" });
    expect(await store.get("creds")).toBeUndefined();
    expect(engine.state.messages).toHaveLength(0);
    expect(engine.session.active).toBe(false);
  });

  it("eraseMyData deletes on the server, then wipes; an unknown install counts as erased", async () => {
    const store = memoryStore();
    const { engine, api } = engineWith({ "DELETE /me": () => ({ status: 204 }) }, store);
    await engine.prepare();
    await engine.eraseMyData();
    expect(api.calls.find((c) => c.method === "DELETE")!.body).toEqual({ installId: session(1).installId, installSecret: "secret-1" });
    expect(await store.get("creds")).toBeUndefined();
  });

  it("a 429 pauses only its scope", async () => {
    const { engine } = engineWith({ "POST /moments": () => ({ status: 429, body: { error: { code: "rate_limited", message: "Slow down", docs: "", retryAfter: 30, scope: "moments" } } }) });
    await engine.prepare();
    await expect(engine.api.send({ method: "POST", path: "/moments", auth: "bearer", scope: "moments", body: {} })).rejects.toMatchObject({ status: 429 });
    expect(engine.api.coolingDown("moments")).toBe(30);
    expect(engine.api.coolingDown("messages")).toBe(0);
    await expect(engine.api.send({ method: "POST", path: "/moments", auth: "bearer", scope: "moments", body: {} })).rejects.toMatchObject({ kind: "cooling_down" });
  });

  it("unreadOnLoad: a known install refreshes and checks the unread count; a new browser sends nothing", async () => {
    const store = memoryStore();
    await store.set("creds", { installId: "11111111-1111-4111-8111-000000000009", installSecret: "s9" });
    const routes = { "GET /unread": () => ({ status: 200, body: { unread: 3, lastSeq: 3, live: false } }) };
    const known = fakeApi({ "POST /sessions/refresh": () => ({ status: 200, body: session(1) }), ...routes });
    const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: known.rt, store, logLevel: "off", unreadOnLoad: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(known.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /sessions/refresh", "GET /unread"]);
    expect(engine.state.unread).toBe(3);
    const fresh = fakeApi(routes);
    new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: fresh.rt, store: memoryStore(), logLevel: "off", unreadOnLoad: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fresh.calls).toHaveLength(0);
  });

  it("a second thread_reset during the reset's own reload fails the open instead of hanging it", async () => {
    const reset = () => ({ status: 409, body: { error: { code: "thread_reset", message: "Reset", docs: "" } } });
    const { engine, api } = engineWith({ "GET /thread": reset });
    engine.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.count("GET /thread")).toBe(2);
    expect(engine.state.loading).toBe(false);
    // The next reset is not stuck behind the first.
    let n = 0;
    const later = engineWith({ "GET /thread": () => (++n <= 2 ? reset() : { status: 200, body: thread([message(1)]) }) });
    later.engine.open();
    await vi.advanceTimersByTimeAsync(100);
    await later.engine.resetThread();
    expect(later.engine.state.messages.map((m) => m.id)).toEqual(["msg_1"]);
  });

  it("destroy stops everything: no retry, poll or receipt goes out afterwards", async () => {
    const { engine, api } = engineWith({ "POST /thread/messages": () => ({ status: 0 }), "GET /unread": () => ({ status: 200, body: { unread: 0, lastSeq: 1, live: false } }) });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    engine.send("Hi");
    await vi.advanceTimersByTimeAsync(10);
    engine.close();
    engine.setTraits({ plan: "pro" });
    const before = api.calls.length;
    engine.destroy();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(api.calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([]);
  });

  it("selfCheck maps an origin the app doesn't list to advice", async () => {
    const { engine } = engineWith({ "POST /sessions": () => ({ status: 403, body: { error: { code: "origin_not_allowed", message: "no", docs: "" } } }) });
    const r = await engine.selfCheck();
    expect(r.passed).toBe(false);
    expect(r.code).toBe("origin_not_allowed");
    expect(r.line).toMatch(/^PingFront self-check: FAIL origin_not_allowed: .*Web origins/);
  });
});

describe("look and timeline", () => {
  it("dashboard beats code beats defaults, field by field", () => {
    const look = resolveLook({ appName: "A", team: [], features: { photos: false }, look: { theme: { corners: "soft" }, header: {}, welcome: {}, topics: [], composer: {}, messages: {} } }, { corners: "square", font: "serif", accent: "#FF0000" });
    expect(look.radius).toBe(12);
    expect(look.font).toBe("serif");
    expect(look.photos).toBe(false);
    expect(contrast(look.light.onAccent, look.light.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it("accent text and secondary text on bubbles read at 4.5:1 in both schemes (axe, 2026-11-06)", () => {
    // The default dark accent deepened for white text was 3.7:1 as capsule text on the dark background, and the
    // muted ink was 4.27:1 on the light team bubble (a card's subtitle, "Photo removed").
    for (const look of [resolveLook(undefined), resolveLook(undefined, { accent: { light: "#FFCC00", dark: "#0A3D91" }, teamBubble: "#D0D0D8" })]) {
      for (const c of [look.light, look.dark]) {
        expect(contrast(c.accentText!, c.background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c.bubbleMuted!, c.teamBubble)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("values set in code that aren't in the contract fall back to the defaults", () => {
    const look = resolveLook(undefined, { corners: "pill", font: "Comic Sans", scheme: "sepia", density: 3, headerStyle: "big", timestamps: "never", accent: "#fff", showNames: "no", aiName: "  " } as never);
    expect(look).toMatchObject({ radius: 18, tails: true, font: "system", scheme: "auto", compact: false, headerStyle: "person", timestamps: "grouped", showNames: true, aiName: "Assistant" });
    expect(look.light.accent).toBe(resolveLook(undefined).light.accent);
  });

  it("code sets the same look fields as the iOS ChatAppearance, under the dashboard's", () => {
    const code = { showNames: false, showAvatars: false, timestamps: "always", showLocalTime: false, showReplyExpectation: false, showFaces: false, headerTitle: "Support", headerMemberId: "mem_2" } as const;
    expect(resolveLook(undefined, code)).toMatchObject({ showNames: false, showAvatars: false, timestamps: "always", showLocalTime: false, showReplyExpectation: false, showFaces: false, headerTitle: { default: "Support" }, headerMemberId: "mem_2" });
    const remote = { appName: "A", team: [], features: { photos: true }, look: { theme: {}, header: { showLocalTime: true }, welcome: {}, topics: [], composer: {}, messages: { showNames: true } } };
    expect(resolveLook(remote, code)).toMatchObject({ showLocalTime: true, showNames: true, showAvatars: false });
  });

  it("contrast: white on the accent from 3:1, the accent deepened to AA", () => {
    expect(bestText("#007AFF")).toBe("#FFFFFF");
    expect(contrast("#FFFFFF", accentAdjusted("#007AFF"))).toBeGreaterThanOrEqual(4.5);
    expect(bestText("#FFD60A")).toBe("#000000");
    const pale = resolveLook(undefined, { background: "#777777" });
    expect(contrast(pale.light.text, pale.light.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(pale.light.muted, pale.light.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("groups bubbles, adds times, the ping line, receipts and Delivered or Read", () => {
    const ping = { ...message(1), ping: { kind: "manual", explanation: "Deniz wrote first." } };
    const receipt = { ...message(4), author: { kind: "system" }, parts: [{ type: "receipt", action: "trial_extended", text: "Trial extended to 14 Nov" }] };
    const rows = buildTimeline({ messages: [ping, message(2), message(3, "person"), receipt].map((m) => m as never), pending: [], teamReadSeq: 3, timestamps: "grouped" });
    expect(rows.map((r) => r.kind)).toEqual(["time", "ping", "group", "group", "status", "system"]);
    expect(rows[2]).toMatchObject({ side: "team", items: [{ text: "m1", tail: false }, { text: "m2", tail: true }] });
    expect(rows[4]).toMatchObject({ read: true });
  });

  it("the AI teammate's hand-off line is a system line without the check", () => {
    const handoff = { ...message(2), author: { kind: "system" }, parts: [{ type: "receipt", action: "handed_off", text: "Deniz will reply" }] };
    const rows = buildTimeline({ messages: [message(1, "person"), handoff].map((m) => m as never), pending: [], teamReadSeq: 0, timestamps: "grouped" });
    expect(rows.find((r) => r.kind === "system")).toMatchObject({ text: "Deniz will reply", receipt: false });
  });
});
