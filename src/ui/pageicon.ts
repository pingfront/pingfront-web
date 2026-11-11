/**
 * The host page's own icon, for the chat's app icon when the dashboard has no store icon (`appIconUrl`): the
 * apple-touch-icon, else the largest PNG or SVG `link[rel=icon]` (an SVG counts as largest), else /favicon.ico.
 */
export function pageIcon(doc: Document = document): string {
  const touch = doc.querySelector<HTMLLinkElement>("link[rel~=apple-touch-icon][href]");
  if (touch) return touch.href;
  let best = "";
  let most = -1;
  for (const l of doc.querySelectorAll<HTMLLinkElement>("link[rel~=icon][href]")) {
    const svg = /svg/i.test(l.type + l.href);
    const size = svg ? 1e9 : /png/i.test(l.type + l.href) ? parseInt(l.getAttribute("sizes") ?? "") || 0 : -1;
    if (size > most) [best, most] = [l.href, size];
  }
  return best || new URL("/favicon.ico", doc.baseURI).href;
}
