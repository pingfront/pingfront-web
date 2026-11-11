// The engine and fake API the saved-link and link card tests share (screens.test.ts, screens.contract.test.ts).
import { expect, vi } from "vitest";
import type { LinkCard } from "../src/core/wire";
import { Engine } from "../src/core/engine";
import { memoryStore, type Store } from "../src/core/storage";
import { KEY, fakeApi, session, type Call, type Route } from "./helpers";

export function engineWith(routes: Record<string, Route> = {}, opts: { store?: Store; debug?: boolean; version?: string } = {}) {
  const api = fakeApi({
    "POST /sessions": () => ({ status: 201, body: session(1) }),
    "POST /sessions/refresh": () => ({ status: 200, body: { ...session(1), installId: undefined, installSecret: undefined } }),
    "POST /thread/cards/c_link/act": () => ({ status: 204 }),
    "PATCH /me": () => ({ status: 200, body: { person: { id: "per_1", level: "guest" } } }),
    ...routes,
  });
  const engine = new Engine(KEY, {
    baseUrl: "http://api.test/v1",
    runtime: api.rt,
    store: opts.store ?? memoryStore(),
    logLevel: "off",
    debug: opts.debug ?? false,
    app: { version: opts.version ?? "2.0", build: "10" },
  });
  return { engine, api };
}

export const app = (c: Call | undefined) => (c?.body as { device?: { app?: { screens?: unknown } } } | undefined)?.device?.app;
// Each report carries its own clientId (the protocol, "Retrying writes"); the rest of the body is what is checked.
export const acts = (api: ReturnType<typeof fakeApi>) =>
  api.calls.filter((c) => c.path === "/thread/cards/c_link/act").map((c) => {
    const { clientId, ...body } = c.body as Record<string, unknown>;
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
    return body;
  });
export const card = (extra: Partial<LinkCard> = {}): LinkCard => ({ kind: "link", id: "c_link", title: "Sound", url: "", button: "Open", ...extra });

/** Taps a link card once (with "settings.sound" registered) and returns the act reports it sent. */
export async function tapped(c: LinkCard, setup: (e: Engine) => void = () => undefined) {
  const { engine, api } = engineWith();
  engine.registerScreens([{ id: "settings.sound" }]);
  await engine.prepare();
  setup(engine);
  await engine.tapLink(c, "msg_1");
  await vi.advanceTimersByTimeAsync(0);
  return acts(api);
}
