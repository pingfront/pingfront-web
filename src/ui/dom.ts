// A tiny element builder: attributes as strings, `on*` as listeners, children as nodes or text.
type Kid = Node | string | number | false | null | undefined | Kid[];
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  // Every button the widget draws is an action, never a form's submit.
  if (tag === "button") el.setAttribute("type", "button");
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    // The CSSOM, never the style attribute: a host's CSP without 'unsafe-inline' would block that.
    else if (k === "style") el.style.cssText = String(v);
    // properties, not attributes: a value set after typing, and booleans that toggle
    else if (k === "value" || k === "hidden" || k === "disabled") Reflect.set(el, k, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, kids);
  return el;
}

function append(el: Node, kids: Kid[]): void {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.appendChild(typeof k === "object" ? k : document.createTextNode(String(k)));
  }
}

const NS = "http://www.w3.org/2000/svg";

/** An inline icon from one or more 24×24 path strings; decorative unless labelled by its control. */
export function icon(paths: string, size = 20, cls = "ic"): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", cls);
  for (const d of paths.split("|")) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

/** Moves `want` into `parent` in order, reusing nodes in place so focus and scroll survive. */
export function reconcile(parent: Element, want: Node[]): void {
  let cur = parent.firstChild;
  for (const node of want) {
    if (node !== cur) parent.insertBefore(node, cur);
    else cur = cur.nextSibling;
  }
  while (cur) {
    const next = cur.nextSibling;
    parent.removeChild(cur);
    cur = next;
  }
}

/**
 * Styles for a shadow root, in call order. A constructed stylesheet is not inline style, so it applies under
 * a host's Content-Security-Policy without 'unsafe-inline'; browsers without adoptedStyleSheets get a
 * <style>. Returns a setter for the sheet's text.
 */
export function adoptCss(root: ShadowRoot, css: string): (css: string) => void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    return (next) => sheet.replaceSync(next);
  } catch {
    const el = h("style", { text: css });
    root.append(el);
    return (next) => void (el.textContent = next);
  }
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]!.toUpperCase())
    .join("") || "?";
