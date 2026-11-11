// Code a page runs only once someone opens the chat, or hardly ever, is not part of the widget's first load: the live
// socket, the self-check, and the web push flows. Each is a lazy module in src/lazy, loaded the first
// time it runs. The npm build imports it as a chunk the host's bundler serves; the script build loads
// `locales/<name>.js` next to itself, checked against the language packs' integrity manifest (ui/packs.ts, script.ts).
// That copy is a separate script, so a module takes the widget's classes and state as arguments (the engine itself)
// and imports only types and stateless helpers (vite.config.ts checks this).
import type * as LiveSocket from "../lazy/live.js";
import type * as Push from "../lazy/push.js";
import type * as SelfCheck from "../lazy/selfcheck.js";

export type Modules = { live: typeof LiveSocket; push: typeof Push; selfcheck: typeof SelfCheck };
export type ModuleName = keyof Modules;

declare const __PF_SCRIPT__: boolean;

// The script build has no chunks: this whole table is dropped from it, and script.ts sets the source.
const chunks: { [K in ModuleName]: () => Promise<Modules[K]> } | undefined = __PF_SCRIPT__
  ? undefined
  : { live: () => import("../lazy/live.js"), push: () => import("../lazy/push.js"), selfcheck: () => import("../lazy/selfcheck.js") };

let source: (name: ModuleName) => Promise<unknown> = (name) => chunks?.[name]() ?? Promise.resolve(undefined);
const loaded = new Map<ModuleName, Promise<unknown>>();

/** Replaces where lazy modules load from (the script build runs them from its own folder). */
export function setModuleSource(fn: (name: ModuleName) => Promise<unknown>): void {
  source = fn;
  loaded.clear();
}

/** A lazy module, loaded once; undefined when it can't be loaded (blocked, offline), and tried again next time. */
export async function loadModule<K extends ModuleName>(name: K): Promise<Modules[K] | undefined> {
  let hit = loaded.get(name);
  if (!hit) {
    hit = source(name).catch(() => undefined);
    loaded.set(name, hit);
  }
  const m = await hit;
  if (m && typeof m === "object") return m as Modules[K];
  loaded.delete(name);
  return undefined;
}
