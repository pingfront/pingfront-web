// The session's edges: logout racing a refresh or a 401 retry, revokes followed by background work, tabs sharing
// one install, write backoff, the thread_reset resend limit, log redaction, destroy, and logout's send policy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api, routeName } from "../src/core/api";
import { decodeCard } from "../src/core/decode";
import { Engine } from "../src/core/engine";
import { createLogger } from "../src/core/log";
import { Outbox, type OutboxItem } from "../src/core/outbox";
import { indexedDbStore, memoryStore, type Store } from "../src/core/storage";
import { KEY, fakeApi, message, session, thread, type Route } from "./helpers";

const config = { schema: 1, revision: 1, draft: false, appName: "Clockwise", look: { theme: {}, header: {}, welcome: {}, topics: [], composer: {}, messages: {} }, team: [], features: { photos: true, reports: true, translation: false, ai: false }, liveUrl: "http://api.test/v1/live" };
const refused = (code: string) => ({ status: 401, body: { error: { code, message: "", docs: "" } } });
const refreshed = (n: number) => ({ status: 200, body: { ...session(n), installId: undefined, installSecret: undefined } });
const creds = (n: number) => ({ installId: session(n).installId, installSecret: session(n).installSecret });

/** An answer the test releases when it wants. */
function held<T>() {
  let release!: (v: T) => void;
  const answer = new Promise<T>((r) => (release = r));
  return { answer, release };
}

/** BroadcastChannel stand-in: what one tab posts reaches the others on the same name, on a later task. */
class Tabs {
  static open = new Set<Tabs>();
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(readonly name: string) {
    Tabs.open.add(this);
  }
  postMessage(data: unknown) {
    for (const t of Tabs.open) if (t !== this && t.name === this.name) setTimeout(() => t.onmessage?.({ data } as MessageEvent), 0);
  }
  close() {
    Tabs.open.delete(this);
  }
}

function tab(routes: Record<string, Route>, store: Store, extra: { channel?: boolean } = {}) {
  const api = fakeApi({
    "POST /sessions": () => ({ status: 201, body: session(2) }),
    "POST /sessions/refresh": () => refreshed(1),
    "POST /me/logout": () => ({ status: 204 }),
    "GET /config": () => ({ status: 200, body: config }),
    "GET /thread": () => ({ status: 200, body: thread([message(1)]) }),
    "POST /thread/read": () => ({ status: 200, body: { readSeq: 1, unread: 0 } }),
    "GET /team-actions": () => ({ status: 200, body: { actions: [] } }),
    ...routes,
  });
  const rt = extra.channel ? { ...api.rt, channel: (name: string) => new Tabs(name) as unknown as BroadcastChannel } : api.rt;
  const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: rt, store, logLevel: "off" });
  const revoked: unknown[] = [];
  engine.events.on("sessionRevoked", (e) => revoked.push(e));
  return { engine, api, revoked };
}

async function seeded(n: number): Promise<Store> {
  const s = memoryStore();
  await s.set("creds", creds(n));
  return s;
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
afterEach(() => {
  vi.useRealTimers();
  Tabs.open.clear();
});

describe("a refused refresh after logout", () => {
  it("leaves the next install alone: its credentials, its outbox, and no sessionRevoked", async () => {
    const refresh = held<{ status: number; body: unknown }>();
    const store = await seeded(1);
    const { engine, api, revoked } = tab({ "POST /sessions/refresh": () => refresh.answer, "POST /thread/messages": () => new Promise(() => {}) }, store);
    const old = engine.prepare().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.count("POST /sessions/refresh")).toBe(1);
    await engine.logout();
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(api.count("POST /sessions")).toBe(1);
    engine.send("hello from the new guest");
    await vi.advanceTimersByTimeAsync(10);
    // The old install's refresh is refused only now.
    refresh.release(refused("session_revoked"));
    await vi.advanceTimersByTimeAsync(10);
    expect(await old).toMatchObject({ code: "cancelled" });
    expect(await store.get("creds")).toEqual(creds(2));
    expect(engine.outbox.items.map((i) => i.text)).toEqual(["hello from the new guest"]);
    expect(engine.session.active).toBe(true);
    expect(revoked).toEqual([]);
  });

  it("a stale page doesn't delete the install another tab saved since", async () => {
    const store = await seeded(1);
    const { engine, revoked } = tab({ "POST /sessions/refresh": () => refused("session_revoked") }, store);
    await engine.session.credentials();
    // Another tab replaced the install meanwhile (no channel between them here).
    await store.set("creds", creds(3));
    // A refresh that isn't a person's action (unreadOnLoad's): refused, and nothing is created in its place.
    await expect(engine.session.renew()).rejects.toMatchObject({ code: "session_revoked" });
    await vi.advanceTimersByTimeAsync(10);
    expect(revoked).toEqual([undefined]);
    expect(await store.get("creds")).toEqual(creds(3));
  });
});

describe("the 401 retry", () => {
  it("is never sent as the next person after a logout during the refresh", async () => {
    const refresh = held<{ status: number; body: unknown }>();
    let refreshes = 0;
    const store = await seeded(1);
    const { engine, api } = tab(
      {
        "POST /sessions/refresh": () => (++refreshes === 1 ? refreshed(1) : refresh.answer),
        "GET /unread": (c) => (c.headers.Authorization === "Bearer token-1" ? refused("unauthorized") : { status: 200, body: { unread: 0, lastSeq: 0, live: false } }),
      },
      store,
    );
    await engine.prepare();
    const request = engine.api.send({ method: "GET", path: "/unread", auth: "bearer" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.count("POST /sessions/refresh")).toBe(2);
    await engine.logout();
    await engine.prepare();
    refresh.release(refreshed(1));
    expect(await request).toMatchObject({ code: "cancelled" });
    expect(api.calls.filter((c) => c.path === "/unread").map((c) => c.headers.Authorization)).toEqual(["Bearer token-1"]);
  });

  it("is never sent as the next person when the 401 arrives after logout and a new session", async () => {
    const answer = held<{ status: number; body: unknown }>();
    const store = await seeded(1);
    const { engine, api } = tab({ "GET /unread": (c) => (c.headers.Authorization === "Bearer token-1" ? answer.answer : { status: 200, body: { unread: 0, lastSeq: 0, live: false } }) }, store);
    await engine.prepare();
    const request = engine.api.send({ method: "GET", path: "/unread", auth: "bearer" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    await engine.logout();
    await engine.prepare();
    expect(api.count("POST /sessions")).toBe(1);
    answer.release(refused("unauthorized"));
    expect(await request).toMatchObject({ code: "cancelled" });
    expect(api.calls.filter((c) => c.path === "/unread").map((c) => c.headers.Authorization)).toEqual(["Bearer token-1"]);
  });

  it("answered session_revoked revokes the install", async () => {
    let n = 0;
    const store = await seeded(1);
    const { engine, revoked } = tab({ "GET /unread": () => (++n === 1 ? refused("unauthorized") : refused("session_revoked")) }, store);
    await engine.prepare();
    await expect(engine.api.send({ method: "GET", path: "/unread", auth: "bearer" })).rejects.toMatchObject({ code: "session_revoked" });
    await vi.advanceTimersByTimeAsync(10);
    expect(revoked).toEqual([undefined]);
    expect(engine.session.active).toBe(false);
    expect(await store.get("creds")).toBeUndefined();
  });
});

describe("after a revoke", () => {
  it("background work starts no session: profile changes, card reports, read receipts, unread", async () => {
    const store = await seeded(1);
    const { engine, api, revoked } = tab({ "GET /unread": () => refused("session_revoked"), "POST /thread/cards/crd_1/act": () => ({ status: 204 }) }, store);
    await engine.prepare();
    await expect(engine.api.send({ method: "GET", path: "/unread", auth: "bearer" })).rejects.toMatchObject({ code: "session_revoked" });
    await vi.advanceTimersByTimeAsync(10);
    expect(revoked).toHaveLength(1);
    engine.setTraits({ plan: "pro" });
    await engine.acts.add("crd_1", { messageId: "msg_1", action: "opened" });
    await engine.acts.flush(true);
    engine.markRead();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(api.count("POST /sessions")).toBe(0);
    expect(api.count("PATCH /me")).toBe(0);
    expect(api.count("POST /thread/cards/crd_1/act")).toBe(0);
    // The person's next action starts the new guest, and the queued report goes with it.
    await engine.prepare();
    await vi.advanceTimersByTimeAsync(10);
    expect(api.count("POST /sessions")).toBe(1);
    expect(api.count("POST /thread/cards/crd_1/act")).toBe(1);
  });
});

/** IndexedDB (fake-indexeddb) settles on real timers. */
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("tabs", () => {
  beforeEach(() => vi.useRealTimers());

  it("a logout in one tab forgets the person in the other, which keeps the stored state as that tab left it", async () => {
    const store = await indexedDbStore(`tabs-${Math.random()}`);
    await store.set("creds", creds(1));
    const a = tab({}, store, { channel: true });
    const b = tab({}, store, { channel: true });
    b.engine.open();
    await settle();
    expect(b.engine.session.active).toBe(true);
    a.engine.open();
    await settle();
    await a.engine.logout();
    await settle();
    expect(b.engine.session.active).toBe(false);
    expect(b.engine.state.messages).toEqual([]);
    expect(b.revoked).toEqual([]);
    // A's next guest: B hears of the new install and loads its thread (a refresh, never a create of its own).
    a.engine.send("hi");
    await settle();
    expect(await store.get("creds")).toEqual(creds(2));
    await settle();
    expect(b.engine.session.installId).toBe(creds(2).installId);
    expect(b.api.count("POST /sessions")).toBe(0);
    a.engine.destroy();
    b.engine.destroy();
  });

  it("the stored outbox and card reports are merged, never overwritten by another tab", async () => {
    const store = await indexedDbStore(`merge-${Math.random()}`);
    const item = (id: string): OutboxItem => ({ clientId: id, text: id, photos: [], createdAt: "2026-11-08T12:00:00.000Z", state: "failed", failure: "other", attempts: 0 });
    const one = new Outbox(async () => store, fakeApi({}).rt, () => {});
    const two = new Outbox(async () => store, fakeApi({}).rt, () => {});
    await one.load();
    await two.load();
    one.enqueue(item("a"));
    await settle();
    two.enqueue(item("b"));
    await settle();
    expect((await store.get<OutboxItem[]>("outbox"))!.map((i) => i.clientId).sort()).toEqual(["a", "b"]);
    two.discard("b");
    await settle();
    expect((await store.get<OutboxItem[]>("outbox"))!.map((i) => i.clientId)).toEqual(["a"]);
    const routes = { "POST /thread/cards/crd_1/act": () => ({ status: 0 }) };
    const a = tab(routes, store);
    const b = tab(routes, store);
    await a.engine.acts.add("crd_1", { messageId: "msg_1", action: "opened" });
    await b.engine.acts.add("crd_1", { messageId: "msg_1", action: "rated", rating: 5 });
    expect((await store.get<unknown[]>("acts"))!).toHaveLength(2);
  });
});

describe("retries", () => {
  it("the outbox backs off up to 5 minutes, not 30 s", async () => {
    let sends = 0;
    const box = new Outbox(async () => memoryStore(), fakeApi({}).rt, () => {});
    box.items.push({ clientId: "c1", text: "hi", photos: [], createdAt: "2026-11-08T12:00:00.000Z", state: "queued", attempts: 20 });
    void box.drain(
      async () => (sends++, { ok: false, error: new (await import("../src/core/api")).PingFrontError("network", "down") }),
      () => {},
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(sends).toBe(1);
    await vi.advanceTimersByTimeAsync(299_000);
    expect(sends).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sends).toBe(2);
    box.stop();
  });

  it("a message refused with thread_reset is sent again once, then fails", async () => {
    const { engine, api } = tab({ "POST /thread/messages": () => ({ status: 409, body: { error: { code: "thread_reset", message: "", docs: "" } } }) }, memoryStore());
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    engine.send("hi");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.count("POST /thread/messages")).toBe(2);
    expect(engine.outbox.items.map((i) => [i.state, i.failure])).toEqual([["failed", "other"]]);
  });

  it("a team action's answer stops retrying at logout", async () => {
    const action = { id: "ta_9", actionId: "extend_trial", name: "Extend trial", fields: {}, ackRequired: true, createdAt: "2026-11-08T10:00:00Z", expiresAt: "2026-11-09T10:00:00Z" };
    const { engine, api } = tab({ "GET /team-actions": () => ({ status: 200, body: { actions: [action] } }), "POST /team-actions/ta_9/ack": () => ({ status: 503 }) }, memoryStore());
    const got: { complete(): Promise<void> }[] = [];
    engine.events.on("teamAction", (a: (typeof got)[number]) => got.push(a));
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    api.sockets[0]!.open();
    api.sockets[0]!.receive({ type: "hello", threadId: "thr_1", rev: 1, status: "open", lastSeq: 1, readSeq: 1, teamReadSeq: 0 });
    await vi.advanceTimersByTimeAsync(10);
    const done = got[0]!.complete();
    await vi.advanceTimersByTimeAsync(10);
    expect(api.count("POST /team-actions/ta_9/ack")).toBe(1);
    await engine.logout();
    await done;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.count("POST /team-actions/ta_9/ack")).toBe(1);
  });
});

describe("requests", () => {
  it("log route patterns only: every id is redacted, team actions' too", async () => {
    expect(routeName("/team-actions/ta_secret/ack")).toBe("/team-actions/{id}/ack");
    expect(routeName("/thread/cards/crd_1/act")).toBe("/thread/cards/{id}/act");
    expect(routeName("/attachments/abcdef")).toBe("/attachments/{id}");
    expect(routeName("/things/0b6f3c1e-8a52-4c1f-9d7e-2f4a6b8c0d1e")).toBe("/things/{id}");
    expect(routeName("/thread/messages")).toBe("/thread/messages");
    const lines: string[] = [];
    const api = fakeApi({ "POST /team-actions/ta_secret/ack": () => ({ status: 204 }) });
    await new Api("http://api.test/v1", KEY, api.rt, createLogger("debug", (e) => lines.push(e.message))).send({ method: "POST", path: "/team-actions/ta_secret/ack", auth: "key" });
    expect(lines.join("\n")).toContain("/team-actions/{id}/ack");
    expect(lines.join("\n")).not.toContain("ta_secret");
  });

  it("an already aborted signal sends nothing", async () => {
    const api = fakeApi({ "GET /config": () => ({ status: 200, body: config }) });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(new Api("http://api.test/v1", KEY, api.rt, createLogger("off")).send({ method: "GET", path: "/config", auth: "key", signal: ctrl.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(api.calls).toHaveLength(0);
  });

  it("a link card's screen keeps string parameters only", () => {
    const card = decodeCard({ kind: "link", id: "crd_1", title: "Sound", url: "https://x.test", button: "Open", screen: { id: "settings.sound", params: { tab: "tones", n: 3, deep: { a: 1 } } } });
    expect(card).toMatchObject({ kind: "link", screen: { id: "settings.sound", params: { tab: "tones" } } });
  });
});

describe("lifecycle", () => {
  it("a destroyed engine opens nothing: not the notification fragment's open, not open()", async () => {
    history.replaceState(null, "", "/#pingfront-open");
    const { engine, api } = tab({}, memoryStore());
    engine.destroy();
    await vi.advanceTimersByTimeAsync(60_000);
    engine.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.calls).toHaveLength(0);
    expect(api.sockets).toHaveLength(0);
    expect(engine.state.visible).toBe(false);
  });

  it("logout gives the next guest an open send policy, and drops the old person's identity problem", async () => {
    const { engine } = tab({ "GET /thread": () => ({ status: 200, body: { ...thread([message(1)]), policy: { canSend: false, reason: "blocked" } } }) }, memoryStore());
    engine.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(engine.state.policy).toEqual({ canSend: false, reason: "blocked" });
    engine.identify("not-a-token");
    expect(engine.state.problem?.code).toBe("identity_token_invalid");
    await engine.logout();
    expect(engine.state.policy).toEqual({ canSend: true });
    expect(engine.state.problem).toBeUndefined();
  });
});
