// The size budget: the single-script build must stay at or under the budget below (40 KB) gzipped (level 9), and the
// ES module build is reported next to it. Run after `pnpm build`; exits 1 over budget. The budget rose
// from 35 KB when the Free plan's brand lockup (its own vector outlines, ~1.2 KB gzipped) joined the widget.
// It rose to 37 KB on 2 November 2026 for the native-parity calls (export, reports, plan, offers, log
// handler, person values: about 0.5 KB gzipped).
// It rose to 38 KB with web push for people (enablePush, the subscription sync, the click hand-off).
// It rose to 40 KB on 6 November 2026 for the keyboard-aware panel, the embedded chat, setLocale, cardOpened,
// the loading, failure and problem states, the native SDKs' wording and the APG rating keys: 2,017 B gzipped
// (38,912 B before, 40,929 B at its peak). Shorter developer messages in the logs and the self-check paid some back.
// On 6 November 2026 the lockup's outlines left the script: they load on demand next to it (locales/lockup.json,
// in the packs' integrity manifest), which made room for the cross-SDK pass with iOS (held messages, the unreachable
// notice, the close hint, superseded and unavailable offers) within 40 KB: 40,424 B gzipped after it.
// Saved links into app screens (registerScreens, onScreen, the failed-link report) fit on 6 November 2026 by
// shortening developer log and self-check lines: 40,954 B gzipped, 6 B under.
// Headroom came back on 6 November 2026 without dropping anything, from 40,960 B to 38,759 B gzipped: class members
// became ES private fields (#name), which the minifier renames (614 B); the live socket, the self-check, the web push
// flows and the cookie store became lazy modules, loaded the first time they run (locales/<name>.js next to the
// script, in the packs' integrity manifest; chunks in the npm build). Lazy modules are listed below, outside the budget.
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync, brotliCompressSync } from "node:zlib";

const BUDGET = 40 * 1024;
const files = { script: "dist/pingfront.js", module: "dist/index.js" };
let over = false;
for (const [name, path] of Object.entries(files)) {
  const raw = readFileSync(new URL(`../${path}`, import.meta.url));
  const gz = gzipSync(raw, { level: 9 }).length;
  const br = brotliCompressSync(raw).length;
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const budget = name === "script" ? ` (budget ${kb(BUDGET)}${gz > BUDGET ? ", OVER" : ""})` : "";
  console.log(`${name.padEnd(6)} ${path.padEnd(18)} ${kb(raw.length).padStart(9)} raw  ${kb(gz).padStart(8)} gzip  ${kb(br).padStart(8)} brotli${budget}`);
  if (name === "script" && gz > BUDGET) over = true;
}
const dir = new URL("../dist/locales/", import.meta.url);
for (const f of readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
  const raw = readFileSync(new URL(f, dir));
  console.log(`lazy   ${`locales/${f}`.padEnd(20)}${`${(raw.length / 1024).toFixed(1)} KB`.padStart(8)} raw  ${`${(gzipSync(raw, { level: 9 }).length / 1024).toFixed(1)} KB`.padStart(8)} gzip  loaded when it runs`);
}
if (over) {
  console.error("The script build is over its size budget. Trim it before merging.");
  process.exit(1);
}
