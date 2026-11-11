// pingfront-sw.js: the service worker for web push, served by the host from its own origin (a service
// worker can't come from a CDN). It shows each push as a notification and, on a click, focuses an open
// page of the site and opens the chat there, or opens the page enablePush() ran on with the chat open.
// It holds no state, keys or tokens and makes no requests of its own.
import { decodeWebPushPayload, isObj } from "./core/decode.js";
import { OPEN_FRAGMENT, OPEN_MESSAGE } from "./constants.js";

/** What a notification carries for its click. */
type Data = { threadId?: string };

// The few ServiceWorkerGlobalScope members install() uses, so tests can pass a fake scope (sw-entry.ts passes the real one).
type Client = { url: string; focus(): Promise<unknown>; postMessage(m: unknown): void };
type Scope = {
  location: { href: string };
  registration: { scope: string; showNotification(title: string, options: NotificationOptions): Promise<void> };
  clients: { matchAll(o: { type: "window"; includeUncontrolled: boolean }): Promise<readonly Client[]>; openWindow(url: string): Promise<unknown> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", fn: (e: { waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(type: "push", fn: (e: { data: { json(): unknown } | null; waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(type: "notificationclick", fn: (e: { notification: Notification; waitUntil(p: Promise<unknown>): void }) => void): void;
};

/** The notification for a push, or undefined for a payload this version can't read or never shows. */
export function notificationFor(raw: unknown): { title: string; options: NotificationOptions } | undefined {
  const p = decodeWebPushPayload(raw);
  if (!p || p.kind === "config") return undefined;
  const data: Data = p.threadId ? { threadId: p.threadId } : {};
  const tag = p.tag ?? (p.threadId ? `pf-${p.threadId}` : undefined);
  // The app turned notification sound off (PersonWebPushPayload.silent): no sound or vibration.
  return { title: p.title, options: { body: p.body, tag, data, ...(p.silent ? { silent: true } : {}) } };
}

/** The page a click opens when no page of the site is open: where enablePush() ran, with the chat open. */
export function pageToOpen(workerHref: string, scope: string): string {
  const page = new URL(workerHref).searchParams.get("pf_open") ?? "/";
  const url = new URL(page, scope);
  // Only this origin: the parameter comes from the registration URL, never from a push.
  if (url.origin !== new URL(scope).origin) return new URL(OPEN_FRAGMENT, scope).href;
  url.hash = OPEN_FRAGMENT;
  return url.href;
}

/** Wires the worker; exported so tests can run it on a fake scope. */
export function install(self: Scope): void {
  self.addEventListener("install", (e) => e.waitUntil(self.skipWaiting()));
  self.addEventListener("push", (e) => {
    let raw: unknown;
    try {
      raw = e.data?.json();
    } catch {
      raw = undefined;
    }
    const n = notificationFor(raw);
    if (n) e.waitUntil(self.registration.showNotification(n.title, n.options));
  });
  self.addEventListener("notificationclick", (e) => {
    e.notification.close();
    const origin = new URL(self.registration.scope).origin;
    e.waitUntil(
      (async () => {
        const pages = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter((c) => new URL(c.url).origin === origin);
        const page = pages[0];
        if (page) {
          await page.focus();
          const data: unknown = e.notification.data;
          page.postMessage({ type: OPEN_MESSAGE, threadId: isObj(data) && typeof data.threadId === "string" ? data.threadId : undefined });
          return;
        }
        await self.clients.openWindow(pageToOpen(self.location.href, self.registration.scope));
      })(),
    );
  });
}
