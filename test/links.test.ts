// Chat links (the protocol, "Chat links"): the case table, topics, the address bar, the queue before configure,
// and that handling a link sends nothing by itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/core/engine";
import { parseChatLink, withoutLinkParams } from "../src/core/links";
import { memoryStore } from "../src/core/storage";
import { KEY, fakeApi, message, session, thread, type Route } from "./helpers";

const look = (topics: unknown[] = []) => ({ theme: {}, header: {}, welcome: {}, topics, composer: {}, messages: {} });
const config = (topics: unknown[] = []) => ({ schema: 1, revision: 1, draft: false, appName: "Clockwise", look: look(topics), team: [], features: { photos: true, reports: true, translation: false, ai: false }, liveUrl: "http://api.test/v1/live" });
const BILLING = { id: "billing", label: "Ask about billing", prefill: "About my bill: " };

function setup(opts: { topics?: (typeof BILLING)[]; remoteTopics?: unknown[]; link?: string } = {}) {
  const routes: Record<string, Route> = {
    "POST /sessions": () => ({ status: 201, body: session(1) }),
    "GET /config": () => ({ status: 200, body: config(opts.remoteTopics) }),
    "GET /thread": () => ({ status: 200, body: thread([message(1)]) }),
  };
  const api = fakeApi(routes);
  const engine = new Engine(KEY, { baseUrl: "http://api.test/v1", runtime: api.rt, store: memoryStore(), logLevel: "off", topics: opts.topics }, opts.link);
  engines.push(engine);
  return { engine, api };
}

const engines: Engine[] = [];
const page = (path: string, state: unknown = null) => history.replaceState(state, "", path);
const here = () => location.pathname + location.search + location.hash;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  page("/");
});
afterEach(() => {
  for (const e of engines.splice(0)) e.destroy();
  vi.useRealTimers();
  page("/");
});

const H = "https://example.com";
// [url, result]: "chat", "chat:<topic candidate>", "report", "false".
const TABLE: [string, string][] = [
  [`${H}/help?pingfront=chat`, "chat"],
  ["myapp://support?pingfront=chat", "chat"],
  ["HTTPS://example.com/?utm_source=mail&pingfront=chat", "chat"],
  [`${H}/?pingfront=ch%61t`, "chat"],
  [`${H}/?p%69ngfront=chat`, "chat"],
  ["myapp://support?pingfront=report", "report"],
  [`${H}/?pingfront=chat&topic=billing`, "chat:billing"],
  [`${H}/?pingfront=chat&topic=nope`, "chat:nope"],
  [`${H}/?pingfront=chat&topic=BILLING`, "chat"],
  [`${H}/?pingfront=chat&topic=billing&topic=bug`, "chat"],
  [`${H}/?pingfront=chat&topic=${"a".repeat(40)}`, "chat"],
  [`${H}/?pingfront=report&topic=billing`, "report"],
  [`${H}/?pingfront=chat&text=Cancel%20my%20plan`, "chat"],
  [`${H}/?pingfront=Chat`, "false"],
  [`${H}/?pingfront=`, "false"],
  [`${H}/?pingfront`, "false"],
  [`${H}/?pingfront=open`, "false"],
  [`${H}/?pingfront=chat%00`, "false"],
  [`${H}/?pingfront=chat&pingfront=chat`, "false"],
  [`${H}/?pingfront=chat&pingfront=report`, "false"],
  [`${H}/#pingfront=chat`, "false"],
  [`${H}/?a=1#?pingfront=chat`, "false"],
  [`${H}/pingfront=chat`, "false"],
  ["https://pingfront.example.com/chat", "false"],
  ["javascript:alert(1)//?pingfront=chat", "false"],
  ["JavaScript://x?pingfront=chat", "false"],
  ["javascript://example.com/%0Aalert(1)?pingfront=chat", "false"],
  ["data:text/html,?pingfront=chat", "false"],
  ["data://x?pingfront=chat", "false"],
  ["vbscript://x?pingfront=chat", "false"],
  ["file:///etc/hosts?pingfront=chat", "false"],
  ["blob://x?pingfront=chat", "false"],
  ["about://blank?pingfront=chat", "false"],
  ["content://x?pingfront=chat", "false"],
  ["intent://x?pingfront=chat", "false"],
  ["myapp:support?pingfront=chat", "false"],
  ["/help?pingfront=chat", "false"],
  ["?pingfront=chat", "false"],
  [" https://example.com/?pingfront=chat", "false"],
  ["", "false"],
  [`${H}/?pingfront=chat&pad=${"x".repeat(2048)}`, "false"],
  [`${H}/?pingfront=chat&topic=${"b".repeat(2100)}`, "false"],
];

const label = (l: ReturnType<typeof parseChatLink>) => (l.kind === "chat" ? (l.topic ? `chat:${l.topic}` : "chat") : l.kind === "report" ? "report" : "false");

describe("the case table", () => {
  it.each(TABLE)("%s → %s", (url, want) => {
    expect(label(parseChatLink(url))).toBe(want);
  });

  it("a URL of exactly 2,048 characters is still read; one more is refused", () => {
    const base = `${H}/?pingfront=chat&pad=`;
    expect(label(parseChatLink(base + "x".repeat(2048 - base.length)))).toBe("chat");
    expect(label(parseChatLink(base + "x".repeat(2049 - base.length)))).toBe("false");
  });

  it("takes URL objects, and nothing for non-strings", () => {
    expect(label(parseChatLink(new URL(`${H}/?pingfront=report`)))).toBe("report");
    expect(label(parseChatLink(undefined))).toBe("false");
    expect(label(parseChatLink(null))).toBe("false");
    expect(label(parseChatLink(42 as unknown as string))).toBe("false");
  });

  it("handleUrl returns true exactly for the table's chat and report rows", () => {
    const { engine } = setup({ topics: [BILLING] });
    for (const [url, want] of TABLE) {
      expect(engine.handleUrl(url), url).toBe(want !== "false");
      engine.close();
    }
  });
});

describe("what a link opens", () => {
  it("chat opens the chat with an empty composer", async () => {
    const { engine } = setup({ topics: [BILLING] });
    const opened: unknown[] = [];
    engine.events.on("open", (e) => opened.push(e));
    expect(engine.handleUrl(`${H}/?pingfront=chat`)).toBe(true);
    expect(engine.state.visible).toBe(true);
    expect(engine.state.prefill).toBeUndefined();
    expect(opened).toHaveLength(1);
  });

  it("report opens the chat (the web's bug report is the composer)", () => {
    const { engine } = setup();
    expect(engine.handleUrl("myapp://support?pingfront=report")).toBe(true);
    expect(engine.state.visible).toBe(true);
    expect(engine.state.prefill).toBeUndefined();
  });

  it("a topic the chat shows does what open({ topic }) does: its own prefill, nothing else", () => {
    const { engine } = setup({ topics: [BILLING] });
    expect(engine.handleUrl(`${H}/?pingfront=chat&topic=billing`)).toBe(true);
    expect(engine.state.prefill).toBe("About my bill: ");
  });

  it("an unknown, repeated or differently cased topic is ignored and the chat still opens", () => {
    for (const q of ["topic=nope", "topic=BILLING", "topic=billing&topic=billing", `topic=${"billing".repeat(6)}`]) {
      const { engine } = setup({ topics: [BILLING] });
      expect(engine.handleUrl(`${H}/?pingfront=chat&${q}`), q).toBe(true);
      expect(engine.state.visible, q).toBe(true);
      expect(engine.state.prefill, q).toBeUndefined();
    }
  });

  it("a report link ignores its topic", () => {
    const { engine } = setup({ topics: [BILLING] });
    expect(engine.handleUrl(`${H}/?pingfront=report&topic=billing`)).toBe(true);
    expect(engine.state.prefill).toBeUndefined();
  });

  it("text in a link never reaches the composer", () => {
    const { engine } = setup({ topics: [BILLING] });
    expect(engine.handleUrl(`${H}/?pingfront=chat&text=Cancel%20my%20plan&message=Refund&prefill=x`)).toBe(true);
    expect(engine.state.prefill).toBeUndefined();
  });

  it("a dashboard topic is matched once the app's config has loaded", async () => {
    const alarms = { id: "alarms", label: { default: "Alarms" }, symbol: "other", prefill: { default: "My alarm didn't ring" } };
    const { engine } = setup({ remoteTopics: [alarms] });
    expect(engine.handleUrl(`${H}/?pingfront=chat&topic=alarms`)).toBe(true);
    expect(engine.state.prefill).toBeUndefined();
    await vi.advanceTimersByTimeAsync(50);
    expect(engine.state.look.topics.map((t) => t.id)).toEqual(["alarms"]);
    expect(engine.state.prefill).toBe("My alarm didn't ring");
  });

  it("a topic the dashboard doesn't have either stays ignored after the config loads", async () => {
    const { engine } = setup({ remoteTopics: [{ id: "alarms", label: { default: "Alarms" }, symbol: "other" }] });
    engine.handleUrl(`${H}/?pingfront=chat&topic=nope`);
    await vi.advanceTimersByTimeAsync(50);
    expect(engine.state.prefill).toBeUndefined();
  });
});

describe("nothing is sent", () => {
  it("refused URLs send nothing and open nothing", async () => {
    const { engine, api } = setup({ topics: [BILLING] });
    for (const [url, want] of TABLE) if (want === "false") engine.handleUrl(url);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.calls).toHaveLength(0);
    expect(engine.state.visible).toBe(false);
  });

  it("a chat link only does what opening the chat does: a chat_opened session, the config and the thread", async () => {
    const { engine, api } = setup({ topics: [BILLING] });
    engine.handleUrl(`${H}/?pingfront=chat&topic=billing&text=hi`);
    await vi.advanceTimersByTimeAsync(50);
    expect(api.calls.find((c) => c.path === "/sessions")?.body).toMatchObject({ reason: "chat_opened" });
    expect(api.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`).sort()).toEqual(["GET /config", "GET /thread", "POST /sessions"]);
  });

  it("a page whose URL is a chat link sends nothing until the chat opens on the next tick", async () => {
    page("/?pingfront=chat");
    const { engine, api } = setup();
    expect(api.calls).toHaveLength(0);
    expect(engine.state.visible).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.state.visible).toBe(true);
  });

  it("a page without a link sends nothing at all", async () => {
    page("/app?topic=42");
    const { engine, api } = setup();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.calls).toHaveLength(0);
    expect(engine.state.visible).toBe(false);
    expect(here()).toBe("/app?topic=42");
  });
});

describe("the address bar", () => {
  it("configure handles the page's link and removes pingfront and topic, keeping the rest and history.state", async () => {
    page("/app?a=b%20c&pingfront=chat&topic=billing&z=1#section", { route: "app" });
    const replace = vi.spyOn(history, "replaceState");
    const { engine } = setup({ topics: [BILLING] });
    expect(here()).toBe("/app?a=b%20c&z=1#section");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith({ route: "app" }, "", "/app?a=b%20c&z=1#section");
    expect(history.state).toEqual({ route: "app" });
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.state.visible).toBe(true);
    expect(engine.state.prefill).toBe("About my bill: ");
    replace.mockRestore();
  });

  it("removes the query entirely when the link was all of it", () => {
    page("/?pingfront=report");
    setup();
    expect(here()).toBe("/");
  });

  it("removes percent-encoded names too", () => {
    page("/?p%69ngfront=chat&keep=1");
    setup();
    expect(here()).toBe("/?keep=1");
  });

  it("leaves a refused link in the address bar", async () => {
    for (const q of ["/?pingfront=open&topic=billing", "/?pingfront=chat&pingfront=chat", "/#pingfront=chat"]) {
      page(q);
      const replace = vi.spyOn(history, "replaceState");
      const { engine } = setup();
      await vi.advanceTimersByTimeAsync(0);
      expect(here(), q).toBe(q);
      expect(replace, q).not.toHaveBeenCalled();
      expect(engine.state.visible, q).toBe(false);
      replace.mockRestore();
    }
  });

  it("handleUrl() after configure reads the page and cleans it; another URL leaves the address bar alone", () => {
    const { engine } = setup();
    page("/inbox?pingfront=chat&tab=2");
    expect(engine.handleUrl()).toBe(true);
    expect(here()).toBe("/inbox?tab=2");
    engine.close();
    page("/inbox?pingfront=chat&tab=3");
    expect(engine.handleUrl("myapp://support?pingfront=chat")).toBe(true);
    expect(here()).toBe("/inbox?pingfront=chat&tab=3");
  });

  it("the notification fragment still opens the chat", async () => {
    page("/?from=notification#pingfront-open");
    const { engine } = setup();
    expect(location.hash).toBe("");
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.state.visible).toBe(true);
  });

  it("withoutLinkParams keeps malformed escapes and empty segments out of the way", () => {
    expect(withoutLinkParams({ pathname: "/p", search: "?%E0%A4%A=1&&pingfront=chat&topic=x", hash: "" })).toBe("/p?%E0%A4%A=1");
    expect(withoutLinkParams({ pathname: "/p", search: "", hash: "#h" })).toBe("/p#h");
  });
});

describe("before configure", () => {
  // A fresh module per test: the singleton and its queue start empty.
  // `opened` records each open's topic, from the same module instance the fresh SDK uses.
  let opened: (string | undefined)[] = [];
  async function sdk() {
    vi.resetModules();
    // Headless: the chat element (element.test.ts covers it) needs layout APIs jsdom lacks.
    vi.stubGlobal("customElements", undefined);
    const { Engine: Fresh } = await import("../src/core/engine");
    const open = Fresh.prototype.open;
    opened = [];
    vi.spyOn(Fresh.prototype, "open").mockImplementation(function (this: Engine, topic?: string) {
      opened.push(topic);
      open.call(this, topic);
    });
    return (await import("../src/index")).PingFront;
  }
  const options = () => {
    const api = fakeApi({
      "POST /sessions": () => ({ status: 201, body: session(1) }),
      "GET /config": () => ({ status: 200, body: config() }),
      "GET /thread": () => ({ status: 200, body: thread([]) }),
    });
    return { api, options: { baseUrl: "http://api.test/v1", runtime: api.rt, store: memoryStore(), logLevel: "off" as const, launcher: false, topics: [BILLING, { id: "bug", label: "Report a bug" }] } };
  };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a link is kept, sends nothing, and configure applies it once", async () => {
    const PingFront = await sdk();
    expect(PingFront.handleUrl("myapp://support?pingfront=chat&topic=billing")).toBe(true);
    const { api, options: o } = options();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.calls).toHaveLength(0);
    const instance = PingFront.configure(KEY, o);
    const opens: unknown[] = [];
    instance.on("open", (e) => opens.push(e));
    expect(instance.isOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.isOpen).toBe(true);
    expect(opens).toHaveLength(1);
    expect(opened).toEqual(["billing"]);
    instance.close();
    // Configuring again doesn't apply it a second time.
    const again = PingFront.configure(KEY, options().options);
    await vi.advanceTimersByTimeAsync(10);
    expect(again.isOpen).toBe(false);
    again.destroy();
  });

  it("the last link wins", async () => {
    const PingFront = await sdk();
    expect(PingFront.handleUrl(`${H}/?pingfront=chat&topic=bug`)).toBe(true);
    expect(PingFront.handleUrl(`${H}/?pingfront=chat&topic=billing`)).toBe(true);
    const instance = PingFront.configure(KEY, options().options);
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.isOpen).toBe(true);
    expect(opened).toEqual(["billing"]);
    instance.destroy();
  });

  it("a refused URL returns false and is not kept", async () => {
    const PingFront = await sdk();
    expect(PingFront.handleUrl(`${H}/?pingfront=open`)).toBe(false);
    expect(PingFront.handleUrl("javascript:alert(1)//?pingfront=chat")).toBe(false);
    const instance = PingFront.configure(KEY, options().options);
    await vi.advanceTimersByTimeAsync(10);
    expect(instance.isOpen).toBe(false);
    instance.destroy();
  });

  it("a queued link wins over the page's own link, which is still removed from the address bar", async () => {
    page("/app?pingfront=chat&topic=bug&x=1");
    const PingFront = await sdk();
    expect(PingFront.handleUrl("myapp://support?pingfront=chat&topic=billing")).toBe(true);
    const instance = PingFront.configure(KEY, options().options);
    expect(here()).toBe("/app?x=1");
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.isOpen).toBe(true);
    expect(opened).toEqual(["billing"]);
    instance.destroy();
  });

  it("handleUrl() before configure reads the page's address, and the link is applied once", async () => {
    page("/?pingfront=chat");
    const PingFront = await sdk();
    expect(PingFront.handleUrl()).toBe(true);
    const instance = PingFront.configure(KEY, options().options);
    const opens: unknown[] = [];
    instance.on("open", (e) => opens.push(e));
    await vi.advanceTimersByTimeAsync(10);
    expect(opens).toHaveLength(1);
    expect(opened).toEqual([undefined]);
    expect(here()).toBe("/");
    instance.destroy();
  });

  it("after configure the singleton hands links to the chat", async () => {
    const PingFront = await sdk();
    const instance = PingFront.configure(KEY, options().options);
    expect(PingFront.handleUrl(`${H}/?pingfront=report`)).toBe(true);
    expect(PingFront.isOpen).toBe(true);
    expect(PingFront.handleUrl(`${H}/?pingfront=nope`)).toBe(false);
    instance.destroy();
  });
});
