// Held messages, as iOS holds them (Outbox.swift, Engine.swift, MessageRow.swift's PendingLine): only a pause or a
// required sign-in holds a message; it goes again by itself, first and in order, when sending reopens, and nothing
// behind it goes before it. A blocked person's message is a plain failure. Then each row's line, once per run.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PingFrontError } from "../src/core/api";
import { Engine } from "../src/core/engine";
import { Outbox, type OutboxItem } from "../src/core/outbox";
import { memoryStore } from "../src/core/storage";
import { pendingLines } from "../src/core/timeline";
import { KEY, fakeApi, message, session, thread, type Route } from "./helpers";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
afterEach(() => vi.useRealTimers());

const item = (id: string, extra: Partial<OutboxItem> = {}): OutboxItem => ({ clientId: id, text: id, photos: [], createdAt: "2026-11-06T12:00:00.000Z", state: "queued", attempts: 0, ...extra });
const refuse = (code: string) => ({ ok: false as const, error: new PingFrontError("server", "x", 403, code) });
const sent = { ok: true as const, message: {} };

function box() {
  const api = fakeApi({});
  return new Outbox(async () => memoryStore(), api.rt, () => undefined);
}

describe("the outbox holds and releases in strict order", () => {
  it("a pause holds the head; nothing behind it is tried, and on release all go, in order", async () => {
    const b = box();
    for (const id of ["a", "b", "c"]) b.enqueue(item(id));
    const tried: string[] = [];
    let paused = true;
    const deliver = async (i: OutboxItem) => (tried.push(i.clientId), paused ? refuse("app_paused") : sent);
    await b.drain(deliver, () => undefined);
    expect(tried).toEqual(["a"]);
    expect(b.items.map((i) => [i.clientId, i.state, i.held])).toEqual([["a", "failed", "app_paused"], ["b", "queued", undefined], ["c", "queued", undefined]]);
    // Another drain (a new message, a reconnect) still sends nothing past the held head.
    b.enqueue(item("d"));
    await b.drain(deliver, () => undefined);
    expect(tried).toEqual(["a"]);
    paused = false;
    expect(b.retryHeld()).toBe(true);
    await b.drain(deliver, () => undefined);
    expect(tried).toEqual(["a", "a", "b", "c", "d"]);
    expect(b.items).toEqual([]);
  });

  it("a sign-in hold waits for its own reason: resuming a paused app doesn't release it", async () => {
    const b = box();
    b.enqueue(item("a"));
    await b.drain(async () => refuse("verification_required"), () => undefined);
    expect(b.items[0]).toMatchObject({ state: "failed", held: "verification_required", failure: "verification" });
    expect(b.retryHeld("app_paused")).toBe(false);
    expect(b.items[0]!.held).toBe("verification_required");
    expect(b.retryHeld("verification_required")).toBe(true);
    expect(b.items[0]).toMatchObject({ state: "queued" });
    expect(b.items[0]!.held).toBeUndefined();
    expect(b.items[0]!.failure).toBeUndefined();
  });

  it("refused again after a release, a message is simply held again", async () => {
    const b = box();
    b.enqueue(item("a"));
    await b.drain(async () => refuse("app_paused"), () => undefined);
    b.retryHeld();
    await b.drain(async () => refuse("app_paused"), () => undefined);
    expect(b.items[0]).toMatchObject({ state: "failed", held: "app_paused" });
  });

  it("blocked is a plain failure for it and everything queued behind it, and nothing is retried by itself", async () => {
    const b = box();
    for (const id of ["a", "b", "c"]) b.enqueue(item(id));
    const tried: string[] = [];
    await b.drain(async (i) => (tried.push(i.clientId), refuse("blocked")), () => undefined);
    expect(tried).toEqual(["a"]);
    expect(b.items.map((i) => [i.state, i.failure, i.held])).toEqual([["failed", "blocked", undefined], ["failed", "blocked", undefined], ["failed", "blocked", undefined]]);
    expect(b.retryHeld()).toBe(false);
    await b.drain(async (i) => (tried.push(i.clientId), sent), () => undefined);
    expect(tried).toEqual(["a"]);
  });

  it("turning blocked releases held items into plain failures, which no longer keep the queue waiting", async () => {
    const b = box();
    b.enqueue(item("a"));
    await b.drain(async () => refuse("app_paused"), () => undefined);
    b.releaseHeld();
    expect(b.items[0]).toMatchObject({ state: "failed", failure: "paused" });
    expect(b.items[0]!.held).toBeUndefined();
    b.enqueue(item("b"));
    const tried: string[] = [];
    await b.drain(async (i) => (tried.push(i.clientId), sent), () => undefined);
    expect(tried).toEqual(["b"]);
  });

  it("a held message is kept across a reload of the page, still held", async () => {
    const { indexedDbStore } = await import("../src/core/storage");
    vi.useRealTimers();
    const store = await indexedDbStore("held-ns");
    const api = fakeApi({});
    const a = new Outbox(async () => store, api.rt, () => undefined);
    a.enqueue(item("a"));
    await a.drain(async () => refuse("app_paused"), () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    const b = new Outbox(async () => store, api.rt, () => undefined);
    await b.load();
    expect(b.items).toMatchObject([{ clientId: "a", state: "failed", held: "app_paused" }]);
  });
});

describe("each unsent message's line, once per run", () => {
  it("a held head and what waits behind it share one line, under the last", () => {
    const lines = pendingLines([item("a", { state: "failed", held: "app_paused", failure: "paused" }), item("b"), item("c")], "app_paused", undefined);
    expect(lines).toEqual([
      { line: "app_paused", held: "app_paused", show: false },
      { line: "app_paused", held: "app_paused", show: false },
      { line: "app_paused", held: "app_paused", show: true },
    ]);
  });

  it("a different wait starts a new run; a plain failure ends one and has no line", () => {
    const lines = pendingLines(
      [item("a", { state: "failed", held: "verification_required" }), item("b", { state: "failed", held: "app_paused" }), item("c", { state: "failed", failure: "other" }), item("d", { state: "sending" })],
      undefined,
      undefined,
    );
    expect(lines.map((l) => [l.line, l.held, l.show])).toEqual([
      ["verification_required", "verification_required", true],
      ["app_paused", "app_paused", true],
      [undefined, undefined, false],
      // Behind a held message (the last one ahead), even past a plain failure: it waits for the same thing.
      ["app_paused", "app_paused", true],
    ]);
  });

  it("offline waits for the connection; an unreachable service and a retry are not sent yet", () => {
    expect(pendingLines([item("a"), item("b")], undefined, "offline").map((l) => [l.line, l.show])).toEqual([["waiting", false], ["waiting", true]]);
    expect(pendingLines([item("a")], undefined, "unreachable")[0]!.line).toBe("retrying");
    // Queued behind one that will be tried again: not "Sending…" either.
    expect(pendingLines([item("a", { attempts: 1 }), item("b")], undefined, undefined).map((l) => [l.line, l.show])).toEqual([["retrying", false], ["retrying", true]]);
    expect(pendingLines([item("a", { state: "sending" }), item("b")], undefined, undefined).map((l) => l.line)).toEqual(["sending", "sending"]);
  });

  it("a blocked chat holds nothing: its failures have no line, and what is queued says what it is doing", () => {
    expect(pendingLines([item("a", { state: "failed", failure: "blocked" }), item("b", { attempts: 1 })], "blocked", undefined).map((l) => [l.line, l.held])).toEqual([[undefined, undefined], ["retrying", undefined]]);
  });
});

describe("the engine releases held messages when sending reopens", () => {
  const config = { schema: 1, revision: 1, draft: false, appName: "Clockwise", look: { theme: {}, header: {}, welcome: {}, topics: [], composer: {}, messages: {} }, team: [], features: { photos: true, reports: true, translation: false, ai: false } };
  function engineWith(routes: Record<string, Route>) {
    const api = fakeApi({
      "POST /sessions": () => ({ status: 201, body: session(1) }),
      "GET /config": () => ({ status: 200, body: config }),
      "GET /thread": () => ({ status: 200, body: thread([message(1)]) }),
      "POST /thread/read": () => ({ status: 200, body: { readSeq: 1, unread: 0 } }),
      ...routes,
    });
    const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: { ...api.rt, webSocket: () => undefined as never }, store: memoryStore(), logLevel: "off" });
    return { engine, api };
  }
  const posted = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.path === "/thread/messages").map((c) => (c.body as { text: string }).text);
  const reply = (policy: { refuse?: string }) => (c: { body: unknown }) =>
    policy.refuse ? { status: 403, body: { error: { code: policy.refuse, message: "x", docs: "" } } } : { status: 201, body: { threadId: "thr_1", message: { ...message(9, "person", (c.body as { text: string }).text), clientId: (c.body as { clientId: string }).clientId } } };

  it("paused: a successful unread check while the chat is closed sends the held messages, in order", async () => {
    const policy = { refuse: "app_paused" as string | undefined };
    let unreadOk = false;
    const { engine, api } = engineWith({
      "POST /thread/messages": reply(policy),
      "GET /unread": () => (unreadOk ? { status: 200, body: { unread: 0, lastSeq: 1, live: false } } : { status: 403, body: { error: { code: "app_paused", message: "x", docs: "" } } }),
    });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    engine.send("first");
    engine.send("second");
    await vi.advanceTimersByTimeAsync(10);
    expect(posted(api)).toEqual(["first"]);
    expect(engine.state.policy).toEqual({ canSend: false, reason: "app_paused" });
    expect(engine.state.pending.map((p) => [p.text, p.state, p.held])).toEqual([["first", "failed", "app_paused"], ["second", "queued", undefined]]);
    engine.close();
    // The app is resumed: the next unread check answers.
    policy.refuse = undefined;
    unreadOk = true;
    await vi.advanceTimersByTimeAsync(21_000);
    expect(posted(api)).toEqual(["first", "first", "second"]);
    expect(engine.state.pending).toEqual([]);
    expect(engine.state.policy).toEqual({ canSend: true });
    engine.destroy();
  });

  it("verification: signing in (identify, then a verified person) sends the held message without reopening the chat", async () => {
    const policy = { refuse: "verification_required" as string | undefined };
    const { engine, api } = engineWith({
      "POST /thread/messages": reply(policy),
      "PATCH /me": () => ((policy.refuse = undefined), { status: 200, body: { person: { id: "per_1", level: "verified" }, rejected: [] } }),
    });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    engine.send("hello");
    await vi.advanceTimersByTimeAsync(10);
    expect(engine.state.pending[0]).toMatchObject({ state: "failed", held: "verification_required" });
    engine.close();
    engine.identify({ userId: "u_1", token: "header.eyJzdWIiOiJ1XzEifQ.sig" });
    await vi.advanceTimersByTimeAsync(400);
    expect(posted(api)).toEqual(["hello", "hello"]);
    expect(engine.state.pending).toEqual([]);
    engine.destroy();
  });

  it("an identify that leaves the person unverified releases nothing", async () => {
    const { engine, api } = engineWith({
      "POST /thread/messages": reply({ refuse: "verification_required" }),
      "PATCH /me": () => ({ status: 200, body: { person: { id: "per_1", level: "named" }, rejected: [] } }),
      "GET /thread": () => ({ status: 200, body: { ...thread([message(1)]), policy: { canSend: false, reason: "verification_required" } } }),
    });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    engine.send("hello");
    await vi.advanceTimersByTimeAsync(10);
    engine.identify({ userId: "u_1" });
    await vi.advanceTimersByTimeAsync(400);
    expect(posted(api)).toEqual(["hello"]);
    expect(engine.state.pending[0]).toMatchObject({ held: "verification_required" });
    engine.destroy();
  });

  it("a thread load that says blocked turns held messages into plain failures", async () => {
    let blocked = false;
    const { engine } = engineWith({
      "POST /thread/messages": reply({ refuse: "app_paused" }),
      "GET /thread": () => ({ status: 200, body: { ...thread([message(1)]), policy: blocked ? { canSend: false, reason: "blocked" } : { canSend: true } } }),
    });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    engine.send("hello");
    await vi.advanceTimersByTimeAsync(10);
    expect(engine.state.pending[0]!.held).toBe("app_paused");
    blocked = true;
    engine.close();
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(engine.state.pending[0]).toMatchObject({ state: "failed" });
    expect(engine.state.pending[0]!.held).toBeUndefined();
    engine.destroy();
  });

  it("deleting a held head lets the messages behind it go once sending reopens, and only they go", async () => {
    const policy = { refuse: "app_paused" as string | undefined };
    const { engine, api } = engineWith({ "POST /thread/messages": reply(policy) });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    engine.send("first");
    engine.send("second");
    await vi.advanceTimersByTimeAsync(10);
    policy.refuse = undefined;
    engine.discard(engine.state.pending[0]!.clientId);
    await vi.advanceTimersByTimeAsync(10);
    expect(posted(api)).toEqual(["first", "second"]);
    expect(engine.state.pending).toEqual([]);
    engine.destroy();
  });

  it("the unreachable notice goes with the next answer from the service", async () => {
    let up = false;
    const { engine } = engineWith({ "GET /config": () => (up ? { status: 200, body: config } : { status: 0 }), "POST /sessions": () => (up ? { status: 201, body: session(1) } : { status: 0 }) });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(engine.state.notice).toEqual({ kind: "unreachable" });
    up = true;
    engine.retryOpen();
    await vi.advanceTimersByTimeAsync(10);
    expect(engine.state.notice).toBeUndefined();
    engine.destroy();
  });
});

describe("thread_reset (the team reset the conversation)", () => {
  it("drops the thread, its rev and unread, keeps the outbox, and loads the empty chat again", async () => {
    let reset = false;
    const api = fakeApi({
      "POST /sessions": () => ({ status: 201, body: session(1) }),
      "GET /config": () => ({ status: 200, body: { schema: 1, revision: 1, draft: false, appName: "Clockwise", look: { theme: {}, header: {}, welcome: {}, topics: [], composer: {}, messages: {} }, team: [], features: { photos: true, reports: true, translation: false, ai: false } } }),
      "GET /thread": () => ({ status: 200, body: reset ? { thread: null, messages: [], hasOlder: false, team: [], policy: { canSend: true } } : thread([message(1), message(2)], { unread: 2 }) }),
      "POST /thread/read": () => ({ status: 200, body: { readSeq: 2, unread: 0 } }),
      "POST /thread/messages": () => ({ status: 503, body: { error: { code: "unavailable", message: "x", docs: "" } } }),
    });
    const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: api.rt, store: memoryStore(), logLevel: "off" });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    api.sockets[0]!.open();
    engine.send("unsent");
    await vi.advanceTimersByTimeAsync(10);
    expect(engine.state.messages).toHaveLength(2);
    expect(engine.api.rev).toBe(1);
    reset = true;
    const reloads = api.count("GET /thread");
    api.sockets[0]!.receive({ type: "thread_reset", threadId: "thr_1" });
    await vi.advanceTimersByTimeAsync(10);
    expect(api.count("GET /thread")).toBe(reloads + 1);
    // The reload went out without the dead revision.
    expect(api.calls.filter((c) => c.path === "/thread").at(-1)!.headers["PF-Thread-Rev"]).toBeUndefined();
    expect(engine.state).toMatchObject({ messages: [], threadId: undefined, unread: 0, lastSeq: 0 });
    expect(engine.state.pending.map((p) => p.text)).toEqual(["unsent"]);
    // The socket stays open.
    expect(api.sockets).toHaveLength(1);
    engine.destroy();
  });
});

describe("the lock's visual pass", () => {
  const config = { schema: 1, revision: 1, draft: false, appName: "Clockwise", look: { theme: {}, header: {}, welcome: {}, topics: [], composer: {}, messages: {} }, team: [{ id: "mem_1", name: "Deniz Kaya" }], features: { photos: true, reports: true, translation: false, ai: false } };

  it("opened while the service is unreachable, the chat loads its config and history once it answers, without reopening", async () => {
    let up = false;
    const down = { status: 0 };
    const api = fakeApi({
      "POST /sessions": () => (up ? { status: 201, body: session(1) } : down),
      "GET /config": () => (up ? { status: 200, body: config } : down),
      "GET /thread": () => (up ? { status: 200, body: thread([message(1), message(2, "person")]) } : down),
      "POST /thread/read": () => ({ status: 200, body: { readSeq: 2, unread: 0 } }),
    });
    const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: { ...api.rt, webSocket: () => undefined as never }, store: memoryStore(), logLevel: "off" });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(engine.state).toMatchObject({ notice: { kind: "unreachable" }, messages: [] });
    expect(engine.state.config).toBeUndefined();
    up = true;
    // No browser event says so: the open chat tries again by itself.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.state.notice).toBeUndefined();
    expect(engine.state.config?.appName).toBe("Clockwise");
    expect(engine.state.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
    expect(engine.state.team.map((m) => m.name)).toEqual(["Deniz Kaya"]);
    engine.destroy();
  });

  it("any answer from the service while unreachable catches the open chat up at once", async () => {
    let up = false;
    const api = fakeApi({
      "POST /sessions": () => (up ? { status: 201, body: session(1) } : { status: 0 }),
      "GET /config": () => (up ? { status: 200, body: config } : { status: 0 }),
      "GET /thread": () => ({ status: 200, body: thread([message(1)]) }),
      "POST /thread/read": () => ({ status: 200, body: { readSeq: 1, unread: 0 } }),
      "GET /unread": () => ({ status: 200, body: { unread: 0 } }),
    });
    const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: { ...api.rt, webSocket: () => undefined as never }, store: memoryStore(), logLevel: "off" });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(engine.state.notice).toEqual({ kind: "unreachable" });
    up = true;
    // An answer to some other request (here the app's own call through the API).
    await engine.api.send({ method: "GET", path: "/config", auth: "key" });
    await vi.advanceTimersByTimeAsync(10);
    expect(engine.state.messages.map((m) => m.id)).toEqual(["msg_1"]);
    expect(engine.state.config?.appName).toBe("Clockwise");
    engine.destroy();
  });

  it("an open, paused chat checks GET /thread once a minute, and nothing else, until the app is resumed", async () => {
    let paused = true;
    const api = fakeApi({
      "POST /sessions": () => ({ status: 201, body: session(1) }),
      "GET /config": () => ({ status: 200, body: config }),
      "GET /thread": () => ({ status: 200, body: { ...thread([message(1)]), policy: paused ? { canSend: false, reason: "app_paused" } : { canSend: true } } }),
      "POST /thread/read": () => ({ status: 200, body: { readSeq: 1, unread: 0 } }),
    });
    const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: { ...api.rt, webSocket: () => undefined as never }, store: memoryStore(), logLevel: "off" });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    const before = api.calls.length;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(api.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual(["GET /thread", "GET /thread"]);
    paused = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine.state.policy).toEqual({ canSend: true });
    const after = api.count("GET /thread");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(api.count("GET /thread")).toBe(after);
    // Closed, it stops checking.
    paused = true;
    engine.destroy();
  });

  it("a closed chat doesn't check for a resume", async () => {
    const api = fakeApi({
      "POST /sessions": () => ({ status: 201, body: session(1) }),
      "GET /config": () => ({ status: 200, body: config }),
      "GET /thread": () => ({ status: 200, body: { ...thread([message(1)]), policy: { canSend: false, reason: "app_paused" } } }),
      "GET /unread": () => ({ status: 403, body: { error: { code: "app_paused", message: "x", docs: "" } } }),
    });
    const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: { ...api.rt, webSocket: () => undefined as never }, store: memoryStore(), logLevel: "off" });
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    engine.close();
    const threads = api.count("GET /thread");
    await vi.advanceTimersByTimeAsync(130_000);
    expect(api.count("GET /thread")).toBe(threads);
    engine.destroy();
  });
});

describe("a message the server already has shows once", () => {
  it("a pending item whose clientId is among the messages is not drawn again", async () => {
    const { buildTimeline } = await import("../src/core/timeline");
    const sent = { ...message(2, "person", "Hello"), clientId: "c1" } as never;
    const rows = buildTimeline({ messages: [message(1) as never, sent], pending: [item("c1", { text: "Hello", state: "sending" }), item("c2")], teamReadSeq: 0, timestamps: "grouped" });
    expect(rows.filter((r) => r.kind === "pending").map((r) => r.key)).toEqual(["o:c2"]);
    const only = buildTimeline({ messages: [message(1) as never, sent], pending: [item("c1", { state: "sending" })], teamReadSeq: 0, timestamps: "grouped" });
    expect(only.some((r) => r.kind === "pending")).toBe(false);
    // Nothing else waits: Delivered shows under it.
    expect(only.some((r) => r.kind === "status")).toBe(true);
  });
});
