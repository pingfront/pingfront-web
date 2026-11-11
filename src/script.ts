// The single-script build: exposes the global and, with data-app-key on the script tag, configures itself.
//   <script src="pingfront.js" data-app-key="pk_live_…" defer></script>
import { GLOBAL_NAME } from "./constants.js";
import { PingFront } from "./index.js";
import { scriptPackSource } from "./ui/packs.js";
import { setPackSource } from "./ui/strings.js";
import { setLockupSource } from "./ui/brand.js";
import { setModuleSource } from "./core/modules.js";

(globalThis as Record<string, unknown>)[GLOBAL_NAME] = PingFront;

const tag = document.currentScript as HTMLScriptElement | null;
// Language packs live in locales/ next to this file (the CDN's version folder when inlined).
// The Free plan's lockup outlines and the lazy modules too, from the same folder and integrity manifest. A module's
// script carries this tag's nonce, so a page whose Content-Security-Policy trusts this script trusts them too.
const files = scriptPackSource(tag?.src, undefined, undefined, tag?.nonce);
setPackSource(files);
setLockupSource(() => files("lockup"));
setModuleSource((name) => files.module(name));
const key = tag?.dataset.appKey;
if (key) {
  const d = tag.dataset;
  PingFront.configure(key, {
    baseUrl: d.baseUrl,
    launcher: d.launcher !== "false",
    locale: d.locale,
    logLevel: d.logLevel === "off" || d.logLevel === "error" || d.logLevel === "debug" ? d.logLevel : undefined,
  });
}
