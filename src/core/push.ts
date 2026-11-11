// Web push for people (the protocol, "Web push for people"): the browser's PushSubscription is this
// install's PushRegistration with provider webpush. The permission prompt appears only inside
// enablePush(), which the host calls from a person's action; nothing here runs on page load.
// The browser APIs come through PushEnv so tests can stand in for them. The flows themselves (enable, disable,
// resync, drop) are in src/lazy/push.ts, loaded only when one runs.

export type PushStatus =
  /** Subscribed, and the server accepted the subscription. */
  | "enabled"
  /** The person declined (or dismissed) the browser's prompt, or blocked notifications earlier. */
  | "denied"
  /** This browser has no service workers, Push API or notifications (or the page is not a secure context). */
  | "unsupported"
  /** The server has no web push key (GET /config carried no webPushKey). */
  | "unavailable"
  /** The server refused the subscription (PATCH /me rejected push); the browser subscription was removed. */
  | "rejected"
  /** Something else failed (the service worker did not register, the network, the push service). */
  | "failed";

export type PushEnv = {
  notification: { readonly permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> } | undefined;
  serviceWorker: ServiceWorkerContainer | undefined;
  hasPushManager: boolean;
};

export function browserPushEnv(): PushEnv {
  const secure = globalThis.isSecureContext !== false;
  return {
    notification: secure && typeof Notification !== "undefined" ? Notification : undefined,
    serviceWorker: secure && typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
    hasPushManager: secure && typeof PushManager !== "undefined",
  };
}
