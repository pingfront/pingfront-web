// Device facts for POST /sessions (`Device`, platform "web"). Coarse on purpose: the OS family and
// version and the browser name, never a fingerprint.
import { SDK_NAME, SDK_VERSION } from "../constants.js";

export type AppFacts = { version?: string; build?: string };

function browserFacts(ua: string): { os: string; model: string } {
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)[_.](\d+)/.exec(ua);
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua);
  const mac = /Mac OS X (\d+)[_.](\d+)/.exec(ua);
  const win = /Windows NT (\d+\.\d+)/.exec(ua);
  const os = ios ? `iOS ${ios[1]}.${ios[2]}` : android ? `Android ${android[1]}` : mac ? "macOS" : win ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "Web";
  const model = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return { os, model };
}

export function deviceFacts(installId: string, app: AppFacts = {}) {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const { os, model } = browserFacts(nav?.userAgent ?? "");
  const locale = (nav?.language || "en-US").slice(0, 40);
  let timeZone = "UTC";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    // Keep UTC.
  }
  const host = typeof location === "undefined" ? "" : location.hostname;
  return {
    installId,
    platform: "web" as const,
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    app: { version: (app.version ?? "1.0").slice(0, 40), build: (app.build ?? "1").slice(0, 40), bundleId: (host || "web").slice(0, 200) },
    os,
    model,
    locale,
    language: locale.split("-")[0]!.toLowerCase().slice(0, 20),
    timeZone: timeZone.slice(0, 60),
  };
}
