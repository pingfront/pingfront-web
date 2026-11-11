// @vitest-environment node
// The composer in real Chrome, from the built script: the + and the field share one center line (within 0.5 px)
// at 100% and 200% zoom, left to right and right to left; the + is as tall as the field's single line; the
// leading inset matches the messages' (12 px); the placeholder sits centered in the line.
// Opt-in: pnpm build && WIDGET_BROWSER=1 pnpm vitest run test/composer-align.browser.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import puppeteer from "puppeteer-core";

const RUN = process.env.WIDGET_BROWSER === "1";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe.skipIf(!RUN)("composer alignment", () => {
  it("centers the + on the field's line at 100% and 200%, LTR and RTL", { timeout: 120_000 }, async () => {
    const script = readFileSync(new URL("../dist/pingfront.js", import.meta.url), "utf8");
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
    const found: string[] = [];
    try {
      for (const zoom of [1, 2])
        for (const dir of ["ltr", "rtl"]) {
          // A fresh page each time: setContent rewrites the document but keeps the window's custom element registry.
          const page = await browser.newPage();
          await page.setViewport({ width: 1280, height: 900 });
          // The API isn't reachable: the panel and its composer still draw; nothing here needs the network.
          await page.setContent(`<!doctype html><html dir="${dir}" style="zoom:${zoom}"><body><script>${script}</script></body></html>`);
          await page.evaluate(() => {
            const pf = (globalThis as unknown as { PingFront: { configure: (k: string, o: object) => void; open: () => void } }).PingFront;
            pf.configure("pk_test_abcdefghijklmnopqrstuvvd", { baseUrl: "http://127.0.0.1:9/v1", logLevel: "none" });
            pf.open();
          });
          // Wait for the panel to be on screen (it opens with a transition).
          await page.waitForFunction(() => (document.querySelector("pingfront-chat")?.shadowRoot?.querySelector(".comp")?.getBoundingClientRect().height ?? 0) > 0, { timeout: 10_000 });
          await new Promise((r) => setTimeout(r, 400));
          const m = await page.evaluate(() => {
            const root = document.querySelector("pingfront-chat")!.shadowRoot!;
            const comp = root.querySelector<HTMLElement>(".comp")!;
            const plus = root.querySelector<HTMLElement>(".plus")!;
            plus.hidden = false; // shown when the look allows photos; measured either way
            const p = plus.getBoundingClientRect();
            const f = root.querySelector(".field")!.getBoundingClientRect();
            const ta = root.querySelector("textarea")!;
            const cs = getComputedStyle(ta);
            const c = comp.getBoundingClientRect();
            const rtl = getComputedStyle(comp).direction === "rtl";
            return {
              delta: Math.abs(p.top + p.height / 2 - (f.top + f.height / 2)),
              heights: Math.abs(p.height - f.height),
              plusRight: p.left > f.left,
              lead: rtl ? c.right - p.right : p.left - c.left,
              padTop: parseFloat(cs.paddingTop),
              padBottom: parseFloat(cs.paddingBottom),
              scale: c.width / comp.offsetWidth,
              empty: p.height === 0 || f.height === 0,
            };
          });
          const at = `${zoom * 100}% ${dir}`;
          if (m.empty) found.push(`${at}: the composer isn't drawn`);
          if (m.delta > 0.5) found.push(`${at}: centers ${m.delta.toFixed(2)} px apart`);
          if (m.heights > 0.5) found.push(`${at}: + and field heights differ by ${m.heights.toFixed(2)} px`);
          if (m.plusRight !== (dir === "rtl")) found.push(`${at}: the + is on the wrong side`);
          if (Math.abs(m.lead / m.scale - 12) > 0.5) found.push(`${at}: leading inset ${(m.lead / m.scale).toFixed(1)} px, not 12`);
          if (m.padTop !== m.padBottom) found.push(`${at}: the placeholder isn't centered (${m.padTop} above, ${m.padBottom} below)`);
        }
    } finally {
      await browser.close();
    }
    expect(found).toEqual([]);
  });
});
