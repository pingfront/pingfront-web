// Web push for people, the flows (the protocol, "Web push for people"): subscribing after the browser's prompt,
// registering the subscription as the install's push address, and removing it. Most pages never turn push on, so this
// is a lazy module (core/modules.ts): it works through the engine it is given.
import { isObj } from "../core/decode.js";
import type { Engine, PushOptions } from "../core/engine.js";
import type { PushEnv, PushStatus } from "../core/push.js";

/** A browser that can take web push: it has notifications, a service worker container and the Push API. */
type PushReady = PushEnv & { notification: NonNullable<PushEnv["notification"]>; serviceWorker: ServiceWorkerContainer };
const supported = (env: PushEnv): env is PushReady => env.notification !== undefined && env.serviceWorker !== undefined && env.hasPushManager;

/** The VAPID key from GET /config (base64url, no padding) as applicationServerKey bytes. */
export function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The service worker URL, carrying the page a notification click should open. */
export function workerUrl(script: string, page: string): string {
  const sep = script.includes("?") ? "&" : "?";
  return `${script}${sep}pf_open=${encodeURIComponent(page)}`;
}

/** The page's subscription, if this origin's widget worker has one. */
async function currentSubscription(env: PushEnv): Promise<PushSubscription | null> {
  if (!supported(env)) return null;
  const regs: readonly ServiceWorkerRegistration[] = await env.serviceWorker.getRegistrations().catch(() => []);
  for (const reg of regs) {
    const sub = await reg.pushManager.getSubscription().catch(() => null);
    if (sub && isWidgetWorker(reg)) return sub;
  }
  return null;
}

const isWidgetWorker = (reg: ServiceWorkerRegistration) => {
  const url = reg.active?.scriptURL ?? reg.waiting?.scriptURL ?? reg.installing?.scriptURL ?? "";
  return /[?&]pf_open=/.test(url);
};

/**
 * Asks for notification permission unless the engine already did (`asked`, the prompt's answer: the engine asks before
 * loading this module, inside the person's gesture), subscribes this browser and registers it as the install's push address.
 */
export async function enable(e: Engine, options: PushOptions, asked?: NotificationPermission): Promise<PushStatus> {
  const env = e.pushEnv;
  if (!supported(env)) return "unsupported";
  const permission = asked ?? (env.notification.permission === "granted" ? "granted" : await env.notification.requestPermission());
  if (permission !== "granted") return "denied";
  try {
    await e.session.token("prepare");
    await e.loadConfig(false);
    const key = e.state.config?.webPushKey;
    if (!key) {
      e.log.error("The server has no web push key.");
      return "unavailable";
    }
    const page = typeof location === "undefined" ? "/" : location.pathname + location.search;
    await env.serviceWorker.register(workerUrl(options.serviceWorker ?? "/pingfront-sw.js", page));
    const reg = await env.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes(key) }));
    return await register(e, sub);
  } catch (x) {
    e.log.error(`Web push failed: ${e.apiError(x)?.logLine ?? "service worker or push service"}.`);
    return "failed";
  }
}

/** Stops pushes to this browser: the server forgets the subscription and the browser drops it (the engine then forgets it). */
export async function disable(e: Engine): Promise<void> {
  const sub = await currentSubscription(e.pushEnv);
  if (e.session.active) await e.api.send({ method: "PATCH", path: "/me", auth: "bearer", body: { push: null } }).catch(() => undefined);
  await sub?.unsubscribe().catch(() => false);
}

async function register(e: Engine, sub: PushSubscription): Promise<PushStatus> {
  const token = JSON.stringify(sub.toJSON());
  const res = await e.api.send({ method: "PATCH", path: "/me", auth: "bearer", body: { push: { provider: "webpush", token } } });
  const rejected = isObj(res.data) && Array.isArray(res.data.rejected) ? res.data.rejected : [];
  if (rejected.some((r) => isObj(r) && r.field === "push")) {
    e.log.error("Push subscription refused; removed.");
    await sub.unsubscribe().catch(() => false);
    await (await e.store()).delete("push").catch(() => undefined);
    return "rejected";
  }
  await (await e.store()).set("push", token).catch(() => undefined);
  return "enabled";
}

/** A new session (after a refresh too) re-sends a subscription that changed since it was registered (`saved`). */
export async function resync(e: Engine, saved: string): Promise<void> {
  const sub = await currentSubscription(e.pushEnv);
  if (sub && JSON.stringify(sub.toJSON()) !== saved) await register(e, sub).catch(() => undefined);
}

/** Logout and erase: the server drops the subscription with the install; the browser drops it here (the engine then forgets it). */
export async function drop(e: Engine): Promise<void> {
  const sub = await currentSubscription(e.pushEnv).catch(() => null);
  await sub?.unsubscribe().catch(() => false);
}
