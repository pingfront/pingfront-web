// A scripted API for core tests: routes answer from handlers, every request is recorded, timers are
// vitest's fake timers through the runtime's call-time globals.
import { vi } from "vitest";
import type { Runtime } from "../src/core/runtime";

export type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };
export type Route = (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> } | Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;

export function fakeApi(routes: Record<string, Route>) {
  const calls: Call[] = [];
  let n = 0;
  const sockets: FakeSocket[] = [];
  const rt: Runtime = {
    fetch: vi.fn(async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      const call: Call = {
        method: init?.method ?? "GET",
        path: u.pathname.replace(/^\/v1/, "") + u.search,
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      };
      calls.push(call);
      const key = `${call.method} ${u.pathname.replace(/^\/v1/, "")}`;
      const route = routes[key];
      if (!route) return new Response(JSON.stringify({ error: { code: "not_found", message: key, docs: "" } }), { status: 404 });
      const r = await route(call);
      if (r.status === 0) throw new TypeError("Failed to fetch");
      return new Response(r.status === 204 || r.status === 304 ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
    }),
    webSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    now: () => Date.now(),
    wall: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: () => 0.5,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  };
  return { rt, calls, sockets, count: (key: string) => calls.filter((c) => `${c.method} ${c.path.split("?")[0]}` === key).length };
}

export class FakeSocket {
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: ((c: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

export const KEY = "pk_test_abcdefghijklmnopqrstuvvd";

export const session = (n = 1) => ({
  installId: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`,
  accessToken: `token-${n}`,
  accessExpiresAt: "2026-10-31T19:00:00.000Z",
  accessExpiresIn: 3600,
  installSecret: `secret-${n}`,
  person: { id: `per_${n}`, level: "guest" },
  storeAccountToken: "22222222-2222-4222-8222-222222222222",
});

export const message = (seq: number, kind: "person" | "team" = "team", text = `m${seq}`) => ({
  id: `msg_${seq}`,
  seq,
  author: kind === "team" ? { kind, id: "mem_1", name: "Deniz Kaya" } : { kind },
  parts: [{ type: "text", text }],
  createdAt: new Date(Date.UTC(2026, 9, 31, 12, 0, seq)).toISOString(),
});

export const thread = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  thread: { id: "thr_1", status: "open", lastSeq: messages.length, readSeq: 0, teamReadSeq: 0, unread: 0, rev: 1, ...extra },
  messages,
  hasOlder: false,
  team: [{ id: "mem_1", name: "Deniz Kaya" }],
  policy: { canSend: true },
});

export const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
