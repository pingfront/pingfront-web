// Two builds from one config: `vite build` writes the ES module for npm (dist/index.js), and
// `vite build --mode script` the single script (dist/pingfront.js, an IIFE that sets the global), and
// `vite build --mode sw` the web push service worker (dist/pingfront-sw.js) hosts serve themselves.
// Both get pingfront's design tokens injected as __PF_TOKENS__ (only the ones the widget reads, src/ui/tokens.json).
// The script build also writes the language packs to dist/locales/<tag>.json (minified) and carries each
// pack's SHA-384 as __PF_PACKS__, which it checks on fetch; the npm build imports packs as lazy chunks. The Free
// plan's lockup outlines travel the same way (locales/lockup.json, in the same manifest), loaded only when shown.
// So do the lazy modules (src/lazy, core/modules.ts): the script build builds each into locales/<name>.js first,
// on its own, and lists it in the manifest; the npm build imports them as chunks.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, defineConfig, type Plugin, type Rolldown } from "vite";
import type { ViteUserConfig } from "vitest/config";
import { MODULE_EVENT } from "./src/constants.ts";
import { LOCKUP } from "./src/ui/lockup.ts";

/** The design tokens the widget reads, rem sizes already in px (src/ui/tokens.json). */
const picked = JSON.parse(readFileSync(new URL("src/ui/tokens.json", import.meta.url), "utf8")) as Record<string, string | { light: string; dark: string }>;

const sri = (s: string) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** Every pack but English (built in), minified, with its Subresource Integrity value. */
export const packs = readdirSync(new URL("src/locales/", import.meta.url))
  .filter((f) => f.endsWith(".json") && f !== "en.json")
  .sort()
  .map((f) => {
    const source = JSON.stringify(JSON.parse(readFileSync(new URL(`src/locales/${f}`, import.meta.url), "utf8")));
    return { locale: f.slice(0, -5), source, integrity: sri(source) };
  });

/** The Free plan's lockup outlines, which the script loads on demand from the same folder (src/ui/brand.ts). */
export const lockupFile = { locale: "lockup", source: JSON.stringify(LOCKUP), integrity: sri(JSON.stringify(LOCKUP)) };

/** locales/manifest.json without the lazy modules: each pack's integrity, and the lockup's. */
export const packManifest = JSON.stringify(Object.fromEntries([...packs, lockupFile].map((p) => [p.locale, p.integrity])));

/** The lazy modules (core/modules.ts), by the name the widget loads them with. */
export const LAZY = ["live", "push", "selfcheck"] as const;
/**
 * What a lazy module may take code from besides itself: modules of stateless functions, whose copy in a module's
 * script works the same as the widget's own. Classes and state reach a lazy module only through its arguments.
 */
const LAZY_SHARED = ["src/core/decode.ts", "src/core/runtime.ts"];

type Built = { file: string; source: string; integrity: string };

const define = (script: boolean) => ({
  __PF_TOKENS__: JSON.stringify(picked),
  __PF_SCRIPT__: JSON.stringify(script),
});

/**
 * Builds src/lazy/<name>.ts into one self-contained script (an IIFE, like pingfront.js) that hands its exports to the
 * widget's loader through MODULE_EVENT on its own script element (ui/packs.ts). Fails the build when the module
 * bundles code from anywhere but itself and LAZY_SHARED: a second copy of a class or of module state would differ
 * from the widget's (instanceof, caches).
 */
export async function buildLazy(name: string): Promise<Built> {
  const entry = fileURLToPath(new URL(`src/lazy/${name}.ts`, import.meta.url));
  const id = "\0pingfront-lazy";
  const out = await build({
    configFile: false,
    logLevel: "warn",
    define: define(true),
    plugins: [
      {
        name: "pingfront-lazy-entry",
        resolveId: (s) => (s === id ? id : undefined),
        load: (s) => (s === id ? `import * as m from ${JSON.stringify(entry)};\ndocument.currentScript.dispatchEvent(new CustomEvent(${JSON.stringify(MODULE_EVENT)}, { detail: m }));` : undefined),
      },
    ],
    build: {
      write: false,
      target: "es2022",
      minify: true,
      rolldownOptions: { input: id, output: { format: "iife", entryFileNames: `${name}.js`, charset: "ascii" } },
    },
  });
  // write: false resolves to the output itself (one, for one input).
  const chunk = (out as Rolldown.RolldownOutput).output[0];
  const root = fileURLToPath(new URL(".", import.meta.url));
  const foreign = Object.entries(chunk.modules)
    // The bundler's own helpers have \0 ids.
    .filter(([m, info]) => info.renderedLength > 0 && m !== entry && !m.startsWith("\0") && !LAZY_SHARED.some((f) => m === root + f))
    .map(([m]) => m.replace(root, ""));
  if (foreign.length) throw new Error(`src/lazy/${name}.ts bundles ${foreign.join(", ")}: pass it in as an argument instead (core/modules.ts).`);
  return { file: `${name}.js`, source: chunk.code, integrity: sri(chunk.code) };
}

const emitPacks = (modules: Built[], manifest: string): Plugin => ({
  name: "pingfront-packs",
  generateBundle() {
    for (const p of [...packs, lockupFile]) this.emitFile({ type: "asset", fileName: `locales/${p.locale}.json`, source: p.source });
    for (const m of modules) this.emitFile({ type: "asset", fileName: `locales/${m.file}`, source: m.source });
    this.emitFile({ type: "asset", fileName: "locales/manifest.json", source: manifest });
  },
});

function config(mode: string, modules: Built[]): ViteUserConfig {
  const script = mode === "script";
  // The full manifest: packs, lockup and lazy modules; the script carries only its digest.
  const manifest = JSON.stringify({ ...JSON.parse(packManifest), ...Object.fromEntries(modules.map((m) => [m.file, m.integrity])) });
  return {
    define: {
      ...define(script),
      __PF_PACKS__: JSON.stringify(script ? sri(manifest) : ""),
    },
    plugins: script ? [emitPacks(modules, manifest)] : [],
    build: {
      target: "es2022",
      emptyOutDir: mode !== "script" && mode !== "sw",
      sourcemap: true,
      minify: true,
      lib:
        mode === "script"
          ? { entry: "src/script.ts", formats: ["iife"], name: "PingFrontScript", fileName: () => "pingfront.js" }
          : mode === "sw"
            ? { entry: "src/sw-entry.ts", formats: ["iife"], name: "PingFrontWorker", fileName: () => "pingfront-sw.js" }
            : { entry: "src/index.ts", formats: ["es"], fileName: () => "index.js" },
      // The script is often self-hosted, and a host that serves it without charset=utf-8 (or a page with no charset)
      // would decode "Sending…" as mojibake: the bundler escapes every non-ASCII character in it.
      rolldownOptions: script ? { output: { charset: "ascii" } } : undefined,
    },
    test: {
      environment: "jsdom",
      include: ["test/**/*.test.ts"],
      setupFiles: ["test/setup.ts"],
    },
  };
}

// The script build builds its lazy modules first: their digests go into the manifest the script pins.
export default defineConfig(({ mode }) => (mode === "script" ? Promise.all(LAZY.map(buildLazy)).then((m) => config(mode, m)) : config(mode, [])));
