// The chat's app icon when the dashboard has no store icon: the host page's own (src/ui/pageicon.ts).
import { afterEach, describe, expect, it } from "vitest";
import { pageIcon } from "../src/ui/pageicon";

const link = (rel: string, href: string, extra: Record<string, string> = {}) => {
  const l = document.createElement("link");
  l.rel = rel;
  l.href = href;
  for (const [k, v] of Object.entries(extra)) l.setAttribute(k, v);
  document.head.append(l);
};
const abs = (path: string) => new URL(path, document.baseURI).href;

afterEach(() => document.head.querySelectorAll("link").forEach((l) => l.remove()));

describe("the host page's icon", () => {
  it("prefers the apple-touch-icon", () => {
    link("icon", "/icon-512.png", { type: "image/png", sizes: "512x512" });
    link("apple-touch-icon", "/apple-touch-icon.png");
    expect(pageIcon()).toBe(abs("/apple-touch-icon.png"));
  });

  it("then the largest PNG icon, and an SVG over any PNG", () => {
    link("icon", "/favicon-16.png", { type: "image/png", sizes: "16x16" });
    link("shortcut icon", "/favicon-192.png", { sizes: "192x192" });
    link("icon", "/favicon-32.png", { type: "image/png", sizes: "32x32" });
    expect(pageIcon()).toBe(abs("/favicon-192.png"));
    link("icon", "/icon.svg", { type: "image/svg+xml" });
    expect(pageIcon()).toBe(abs("/icon.svg"));
  });

  it("skips other icon types, and falls back to /favicon.ico", () => {
    link("icon", "/favicon.gif", { type: "image/gif" });
    expect(pageIcon()).toBe(abs("/favicon.ico"));
  });
});
