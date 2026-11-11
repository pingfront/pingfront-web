import type { Lockup } from "./lockup.js";

const NS = "http://www.w3.org/2000/svg";

declare const __PF_SCRIPT__: boolean;

/**
 * Where the lockup's outlines come from. They are drawn only on the Free plan's welcome, so they are not part of the
 * widget's first load: the npm build imports them as a chunk the host's bundler serves, and the script build fetches
 * `locales/lockup.json` next to itself, checked against the same integrity manifest as the language packs (script.ts).
 */
let source: () => Promise<unknown> = () => (__PF_SCRIPT__ ? Promise.resolve(undefined) : import("./lockup.js").then((m) => m.LOCKUP));
let loaded: Promise<Lockup | undefined> | undefined;

export function setLockupSource(fn: () => Promise<unknown>): void {
  source = fn;
  loaded = undefined;
}

const isLockup = (v: unknown): v is Lockup => {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o.aspect === "number" && ["viewBox", "markTransform", "markPath", "wordTransform", "wordPath"].every((k) => typeof o[k] === "string");
};

/** The lockup's outlines, loaded once; undefined when they can't be loaded (the chat then names pingfront in text). */
export function loadLockup(): Promise<Lockup | undefined> {
  return (loaded ??= source().then(
    (v) => (isLockup(v) ? v : undefined),
    () => undefined,
  ));
}

/**
 * pingfront's one-colour lockup, `height` px tall, labelled for screen readers.
 *
 * It is drawn from the brand's own outlines (brand/logo/lockup-mono.svg), so the host's font can never
 * change its letters, and it takes the current `color` so it follows the chat's palette instead of
 * carrying pingfront's pink into a look that may not match it.
 */
export function lockup(height: number, label: string, l: Lockup): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", l.viewBox);
  svg.setAttribute("width", String(Math.round(height * l.aspect * 100) / 100));
  svg.setAttribute("height", String(height));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("focusable", "false");
  for (const { transform, d } of [
    { transform: l.markTransform, d: l.markPath },
    { transform: l.wordTransform, d: l.wordPath },
  ]) {
    const g = document.createElementNS(NS, "g");
    g.setAttribute("transform", transform);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    g.append(path);
    svg.append(g);
  }
  return svg;
}
