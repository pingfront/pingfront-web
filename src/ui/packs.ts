// The script build's language packs: static JSON files in a `locales/` folder next to pingfront.js
// (README.md, "Languages"). A pack carries no key, cookie or identifier, and is fetched without
// credentials. The `v<major>` alias loads the packs of its exact version, so an alias that moves never pairs
// a script with another release's packs. Integrity: the script carries the SHA-384 of locales/manifest.json,
// which lists every pack's SHA-384; both fetches are checked (Subresource Integrity), so a changed file is
// dropped and the chat stays in English.
// The same folder and manifest carry the lazy modules (core/modules.ts) as `<name>.js`: each runs as a script element
// with its integrity (and the widget's own nonce, for a nonce-based Content-Security-Policy), and hands its exports to
// the loader through a MODULE_EVENT on that element, so nothing is added to the page's globals.
import { DEFAULT_CDN_BASE, MODULE_EVENT, SDK_VERSION } from "../constants.js";
import type { Locale, PackSource } from "./strings.js";

declare const __PF_PACKS__: string;

/** The folder the packs load from, for the script's own URL (the CDN's version folder when it has none). */
export function packBase(scriptSrc: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(".", scriptSrc || DEFAULT_CDN_BASE);
  } catch {
    url = new URL(DEFAULT_CDN_BASE);
  }
  url.pathname = url.pathname.replace(/\/v\d+\/$/, `/${SDK_VERSION}/`);
  return new URL("locales/", url);
}

type Files = PackSource & ((name: string) => Promise<unknown>) & { module(name: string): Promise<unknown> };

/**
 * Loads a file of the manifest by its name: a language pack, or "lockup", the Free plan's lockup outlines. Its
 * `module(name)` runs `<name>.js`, a lazy module, and resolves to its exports.
 */
export function scriptPackSource(scriptSrc: string | undefined, integrity: string = __PF_PACKS__, fetchImpl: typeof fetch = (i, o) => fetch(i, o), nonce = ""): Files {
  const base = packBase(scriptSrc);
  const get = async (file: string, sri: string) => {
    const res = await fetchImpl(new URL(file, base), { credentials: "omit", integrity: sri });
    return res.ok ? ((await res.json()) as unknown) : undefined;
  };
  let manifest: Promise<Record<string, string> | undefined> | undefined;
  const sriOf = async (key: string) => {
    manifest ??= get("manifest.json", integrity).then((m) => (m && typeof m === "object" ? (m as Record<string, string>) : undefined));
    return (await manifest)?.[key];
  };
  const files = async (locale: Locale | string) => {
    const sri = await sriOf(locale);
    return sri ? get(`${locale}.json`, sri) : undefined;
  };
  files.module = async (name: string) => {
    const sri = await sriOf(`${name}.js`);
    if (!sri) return undefined;
    return new Promise<unknown>((resolve) => {
      const el = document.createElement("script");
      el.src = new URL(`${name}.js`, base).href;
      el.integrity = sri;
      el.crossOrigin = "anonymous";
      el.nonce = nonce;
      // The module's script dispatches its exports on its own element as it runs, before load fires.
      el.addEventListener(MODULE_EVENT, (e) => resolve((e as CustomEvent<unknown>).detail), { once: true });
      el.onload = el.onerror = () => {
        el.remove();
        resolve(undefined);
      };
      document.head.append(el);
    });
  };
  return files;
}
