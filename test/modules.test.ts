// The lazy modules (core/modules.ts): the script build's loader (a script element with the module's integrity and the
// widget's nonce), the live socket's stand-in, and the memory store where IndexedDB is unavailable.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODULE_EVENT } from "../src/constants";
import { Live } from "../src/core/live";
import { loadModule, setModuleSource } from "../src/core/modules";
import { openStore } from "../src/core/storage";
import { scriptPackSource } from "../src/ui/packs";
import { fakeApi } from "./helpers";

const manifest = (entries: Record<string, string>) =>
  (async (u: URL | string) => new Response(String(u).endsWith("manifest.json") ? JSON.stringify(entries) : "{}")) as typeof fetch;

describe("the script build's lazy modules", () => {
  afterEach(() => document.head.querySelectorAll("script").forEach((s) => s.remove()));

  it("run as a script with the manifest's integrity and the widget's nonce, and hand over their exports", async () => {
    const files = scriptPackSource("https://cdn.test/web/1.0.0/pingfront.js", "sha384-manifest", manifest({ "live.js": "sha384-live" }), "n0nce");
    const loading = files.module("live");
    await vi.waitFor(() => expect(document.head.querySelector("script")).not.toBeNull());
    const el = document.head.querySelector("script")!;
    expect([el.src, el.integrity, el.crossOrigin, el.nonce]).toEqual(["https://cdn.test/web/1.0.0/locales/live.js", "sha384-live", "anonymous", "n0nce"]);
    const exports = { Socket: class {} };
    el.dispatchEvent(new CustomEvent(MODULE_EVENT, { detail: exports }));
    el.dispatchEvent(new Event("load"));
    expect(await loading).toBe(exports);
    expect(el.isConnected).toBe(false);
  });

  it("resolve to nothing when blocked or not in the manifest, and add no script for an unknown name", async () => {
    const files = scriptPackSource("https://cdn.test/web/1.0.0/pingfront.js", "sha384-manifest", manifest({ "push.js": "sha384-push" }));
    expect(await files.module("selfcheck")).toBeUndefined();
    expect(document.head.querySelector("script")).toBeNull();
    const loading = files.module("push");
    await vi.waitFor(() => expect(document.head.querySelector("script")).not.toBeNull());
    document.head.querySelector("script")!.dispatchEvent(new Event("error"));
    expect(await loading).toBeUndefined();
  });

  it("load once, and are tried again after a failure", async () => {
    let calls = 0;
    let up = false;
    setModuleSource(async () => (calls++, up ? { run: () => undefined } : undefined));
    try {
      expect(await loadModule("selfcheck")).toBeUndefined();
      up = true;
      const m = await loadModule("selfcheck");
      expect(m).toBeDefined();
      expect(await loadModule("selfcheck")).toBe(m);
      expect(calls).toBe(2);
    } finally {
      setModuleSource((name) => import(`../src/lazy/${name}.ts`));
    }
  });
});

describe("the live socket's stand-in", () => {
  const hooks = (states: string[]) => ({
    url: () => "ws://api.test/v1/live",
    token: async () => "t",
    expired: () => undefined,
    event: () => undefined,
    reset: () => undefined,
    erased: () => undefined,
    state: (s: string) => void states.push(s),
  });
  const log = { error: () => undefined, info: () => undefined, debug: () => undefined } as never;

  it("connects once the socket has loaded", async () => {
    const api = fakeApi({});
    const live = new Live(api.rt, hooks([]), log);
    live.start();
    expect(live.running).toBe(true);
    await vi.waitFor(() => expect(api.sockets).toHaveLength(1));
  });

  it("stopped before the socket loaded, it never connects", async () => {
    const api = fakeApi({});
    const states: string[] = [];
    const live = new Live(api.rt, hooks(states), log);
    live.start();
    live.stop();
    expect(live.running).toBe(false);
    await loadModule("live");
    await new Promise((r) => setTimeout(r, 0));
    expect(api.sockets).toHaveLength(0);
    expect(states).toEqual(["connecting", "closed"]);
  });

  it("without the socket (blocked), the chat stays usable and says why in the log", async () => {
    const errors: string[] = [];
    setModuleSource(async () => undefined);
    try {
      const live = new Live(fakeApi({}).rt, hooks([]), { ...(log as object), error: (m: string) => void errors.push(m) } as never);
      live.start();
      live.typing(true);
      await vi.waitFor(() => expect(errors).toEqual(["No live updates: live.js did not load."]));
      live.stop();
    } finally {
      setModuleSource((name) => import(`../src/lazy/${name}.ts`));
    }
  });
});

describe("without IndexedDB", () => {
  it("the store is memory for this page, and the install secret never goes in a cookie", async () => {
    const idb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Reflect.deleteProperty(globalThis, "indexedDB");
    try {
      const s = await openStore("test-2");
      expect(s.kind).toBe("memory");
      await s.set("creds", { installId: "ins_1", installSecret: "secret" });
      expect(await s.get("creds")).toEqual({ installId: "ins_1", installSecret: "secret" });
      expect(document.cookie).toBe("");
    } finally {
      if (idb) Object.defineProperty(globalThis, "indexedDB", idb);
    }
  });
});
