// The widget's stylesheet, inside its shadow root. Look colors (--a accent, --oa text on it, --bg, --tb
// team bubbles, --tx text, --mu secondary text) come from the resolved ChatLook; pingfront's own touches
// (the ping dot, the leaf check, the AI capsule, the focus ring, radii, shadows, motion) read
// pingfront's design tokens. Bubble metrics are the iOS SDK's iMessage values at 1 pt = 1 px, as in the
// dashboard's PhonePreview: 18 radius, 12 × 7.5 padding, 2 within a group, 9 between groups, 72 % width.
// Composer, as in the SDKs: the + is as tall as the field's single line (--fh, 36), both centered on that line
// and bottom-aligned when the field grows; one 8 px gap; the same 12 px leading inset as the bubbles; the
// placeholder centered in the line. Insets are logical, so RTL mirrors them.
import type { Colors, ResolvedLook } from "../core/look.js";
import { tokenVars } from "./tokens.js";

/* design-lint-allow-start font-family: the in-app chat uses the system font stacks, as the iOS SDK does */
const FONTS = {
  system: "var(--family-ios)",
  rounded: 'ui-rounded, "SF Pro Rounded", var(--family-ios)',
  serif: 'ui-serif, "New York", Georgia, serif',
};
/* design-lint-allow-end */

const vars = (c: Colors, mode: "light" | "dark") =>
  `--a:${c.accent};--oa:${c.onAccent};--at:${c.accentText ?? c.accent};--mb:${c.bubbleMuted ?? c.muted};--bg:${c.background};--tb:${c.teamBubble};--tx:${c.text};--mu:${c.muted};color-scheme:${mode};${tokenVars(mode)}`;

export function lookCss(look: ResolvedLook): string {
  const base = `:host{--font:${FONTS[look.font]};--r:${look.radius}px;--pad:${look.compact ? "6px 11px" : "7.5px 12px"};--grp:${look.compact ? 6 : 9}px}`;
  if (look.scheme !== "auto") return `${base}:host{${vars(look[look.scheme], look.scheme)}}`;
  return `${base}:host{${vars(look.light, "light")}}@media (prefers-color-scheme:dark){:host{${vars(look.dark, "dark")}}}`;
}

// Notes on the stylesheet (here, not in the shipped string):
// - Team text in cards, ping reasons, choices and topics takes its own direction (unicode-bidi: plaintext), as
//   bubbles do: an Arabic question in an English page reads right to left, with its question mark at the end.
// - The panel takes focus as the dialog opens (tabindex -1, not in the tab order, nothing to operate), so it draws
//   no focus outline; every control inside draws the one sky outline.
// - The host element matches the page's :focus rules while focus is inside the chat; the page's ring would wrap an
//   embedded chat around ours, so the host draws none (!important, the only way a shadow style beats the page's).
// - A control drawn smaller than 44 px keeps a 44 px target (brand: 44 pt tap targets).
// - An on-screen keyboard (the visual viewport's --kb covered at the bottom, --vt scrolled at the top, --vh left): the panel sits on the keyboard and fits what is still visible, so the composer stays in view.
// - Embedded (the container option): the chat fills its container in the page's flow, like the iOS SDK's embeddable view. No launcher, scrim, grabber or close button, and it is not modal.
// - The thread's indicator is ours (.sb), drawn the way iOS draws one: a thin rounded thumb in the look's muted ink, inside the panel, shown while the thread moves. The operating system's bar is hidden because it cannot take the app's palette and sat on top of the panel's edge.
// - The error pattern: a stop dot and text in ink (red text at 12 px misses 4.5:1).
// - The field draws the one focus ring for its textarea, which always matches :focus-visible (HTML's rule for text
//   fields). The 3 px sky outline is drawn inset, over the field's own 1 px border, so it replaces the border
//   instead of stacking a second ring outside it; an outline (not a shadow) stays visible in forced-colors mode.
export const CSS = `
:host{all:initial;position:fixed;inset:auto 0 0 auto;z-index:2147483000}
:host(:focus){outline:none !important}
.pf{all:initial;display:contents;font-family:var(--font);font-size:17px;font-weight:400;font-style:normal;line-height:1.3;letter-spacing:normal;word-spacing:normal;text-transform:none;text-align:start;text-indent:0;white-space:normal;color:var(--tx);-webkit-text-size-adjust:100%;--fill:color-mix(in srgb,var(--tx) 9%,transparent);--glass:color-mix(in srgb,var(--bg) 78%,transparent);--edge:color-mix(in srgb,var(--tx) 10%,transparent)}
*,*::before,*::after{box-sizing:border-box}
.hit{position:relative}
.hit::after{content:"";position:absolute;left:50%;top:50%;width:max(100%,44px);height:max(100%,44px);transform:translate(-50%,-50%)}
button{font:inherit;color:inherit;background:none;border:0;margin:0;padding:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
button:disabled{cursor:default}
:focus{outline:none}
:focus-visible{outline:var(--focus-width) solid var(--sky);outline-offset:var(--focus-offset)}
[hidden]{display:none !important}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.ic{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.launch{position:fixed;inset-inline-end:var(--le,20px);bottom:calc(var(--lb,20px) + env(safe-area-inset-bottom,0px));width:56px;height:56px;border-radius:var(--radius-round);background:var(--a);color:var(--oa);display:grid;place-items:center;box-shadow:var(--shadow-float);transition:transform var(--dur-quick) var(--ease-spring)}
.launch:active{transform:scale(.94)}
.launch .ic{width:28px;height:28px}
.launch .off{width:22px;height:22px}
.launch .off,.launch.open .on{display:none}
.launch.open .off{display:block}
.badge{position:absolute;top:-2px;inset-inline-end:-2px;min-width:22px;height:22px;padding:0 6px;border-radius:var(--radius-capsule);background:var(--ping-fill);color:var(--white);font-size:var(--type-13);font-weight:var(--weight-semibold);line-height:22px;text-align:center;box-shadow:0 0 0 2px var(--bg)}
.scrim{display:none}
.panel{position:fixed;inset-inline-end:var(--le,20px);bottom:calc(var(--lb,20px) + 72px + env(safe-area-inset-bottom,0px));width:min(393px,calc(100vw - 40px));height:min(680px,calc(100vh - 112px));height:min(680px,calc(100dvh - 112px));display:flex;flex-direction:column;overflow:hidden;border-radius:var(--radius-card);background:var(--bg);color:var(--tx);box-shadow:var(--shadow-float),0 0 0 .5px var(--edge);transform-origin:bottom right;animation:in var(--dur-base) var(--ease-out)}
.panel.nolaunch{bottom:calc(var(--lb,20px) + env(safe-area-inset-bottom,0px))}
.panel.kbup{bottom:calc(var(--kb) + 12px);height:min(680px,calc(var(--vh) - 24px))}
.kbup .comp{padding-bottom:12px}
@keyframes in{from{opacity:0;transform:translateY(12px) scale(.97)}}
.grab{display:none}
@media (max-width:559.98px){
.scrim{display:block;position:fixed;inset:0;background:var(--scrim)}
.panel,.panel.kbup{inset:calc(8px + var(--vt,0px) + env(safe-area-inset-top,0px)) 0 var(--kb,0px) 0;width:100%;height:auto;border-radius:var(--radius-card) var(--radius-card) 0 0;animation-name:up}
.panel.nolaunch:not(.kbup){bottom:0}
.grab{display:block;position:absolute;top:6px;left:50%;width:36px;height:5px;margin-left:-18px;border-radius:var(--radius-capsule);background:var(--mu);opacity:.45;z-index:4}
.launch.open{display:none}
}
@keyframes up{from{transform:translateY(100%)}}
:host([data-embedded]){position:relative;inset:auto;z-index:auto;display:block;width:100%;height:100%}
.embed .panel{position:relative;inset:auto;width:100%;height:100%;border-radius:inherit;box-shadow:none;animation:none}
.embed .scrim,.embed .grab,.embed .launch,.embed .x{display:none}
.embed .head{padding-top:12px}
@media (prefers-reduced-motion:reduce){.panel,.launch,.typing i{animation:none !important;transition:none !important}}
.head{position:absolute;inset:0 0 auto 0;z-index:3;display:grid;justify-items:center;gap:4px;padding:18px 56px 10px;background:var(--glass);border-bottom:.5px solid var(--edge);-webkit-backdrop-filter:blur(20px) saturate(1.8);backdrop-filter:blur(20px) saturate(1.8);text-align:center}
.head.min{min-height:60px;background:none;border-bottom:0;-webkit-backdrop-filter:none;backdrop-filter:none}
.embed .head.min:not(.bn){display:none}
.ban{justify-self:stretch;margin:6px -56px -10px;padding:8px 16px;background:var(--fill);font-size:var(--type-13);text-align:center}
.min .ban{margin-top:44px}
.x{position:absolute;top:8px;inset-inline-end:8px;width:44px;height:44px;display:grid;place-items:center;border-radius:var(--radius-round)}
.x::before{content:"";position:absolute;inset:6px;border-radius:var(--radius-round);background:var(--fill)}
.x .ic{position:relative;width:16px;height:16px}
.who{margin:0;font-size:var(--type-13);font-weight:var(--weight-semibold);padding:4px 12px;border-radius:var(--radius-capsule);background:var(--fill);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{margin:0;unicode-bidi:plaintext;font-size:var(--type-12);line-height:1.35;color:var(--mu);max-width:100%;text-wrap:balance;overflow-wrap:anywhere}
.face{display:inline-grid;place-items:center;flex:none;border-radius:var(--radius-round);background:var(--mu);color:var(--bg);font-weight:var(--weight-semibold);overflow:hidden;object-fit:cover}
.stack{display:flex}
.stack .face{box-shadow:0 0 0 2px var(--bg)}
.stack .face+.face{margin-inline-start:-12px}
.appicon{border-radius:22.37%;object-fit:cover;display:inline-grid;place-items:center;background:var(--a);color:var(--oa);font-weight:var(--weight-bold)}
.scroll{flex:1;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;padding:var(--hh,132px) 12px 12px;scroll-padding-block:var(--hh,132px) 12px;display:flex;flex-direction:column;scrollbar-width:none}
.scroll::-webkit-scrollbar{display:none}
.sb{position:absolute;inset-inline-end:4px;width:4px;border-radius:var(--radius-capsule);background:color-mix(in srgb,var(--mu) 55%,transparent);opacity:0;transition:opacity var(--dur-base) var(--ease-out);pointer-events:none;z-index:3}
.sb.on{opacity:1}
.list{flex:1 0 auto;display:flex;flex-direction:column}
.olderrow{display:grid;place-items:center}
.older{min-height:36px;margin:4px 0 8px;padding:6px 14px;border-radius:var(--radius-capsule);background:var(--fill);font-size:var(--type-13);font-weight:var(--weight-semibold)}
.welcome,.failed{margin:auto 0;display:grid;justify-items:center;gap:8px;padding:12px;text-align:center}
.welcome h2{margin:6px 0 0;font:inherit;font-size:21px;font-weight:var(--weight-bold);letter-spacing:-.01em}
.welcome p{margin:0;color:var(--mu);font-size:15px;white-space:pre-line}
.skel{margin-top:auto;display:flex;flex-direction:column;gap:9px;padding-bottom:4px}
.skel i{display:block;height:36px;border-radius:var(--r);background:var(--fill)}
.skel .t{width:62%}
.skel .t+.t{width:40%}
.skel .m{width:48%;align-self:flex-end}
.failed{gap:12px;color:var(--mu);font-size:15px}
.failed p{margin:0}
.again{min-height:44px;padding:0 20px;border-radius:var(--radius-capsule);background:var(--fill);color:var(--tx);font-size:15px;font-weight:var(--weight-semibold)}
.brand{display:grid;place-items:center;padding:16px 12px 6px;color:var(--mu);opacity:.65}
.brand[hidden]{display:none}
.brand svg{display:block;width:auto;height:14px}
.topics{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:10px}
.topic{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:8px 16px;border-radius:var(--radius-capsule);background:var(--fill);font-size:15px;font-weight:var(--weight-semibold)}
.topic .ic{width:18px;height:18px;color:var(--a)}
.time{align-self:center;margin:10px 0 4px;color:var(--mu);font-size:var(--type-12);font-weight:var(--weight-medium)}
.sys{align-self:center;display:flex;align-items:center;justify-content:center;gap:6px;max-width:90%;margin:8px 0 2px;color:var(--mu);font-size:var(--type-13);font-weight:var(--weight-semibold);text-align:center}
.dot{width:8px;height:8px;flex:none;border-radius:var(--radius-round);background:var(--ping)}
.chk{width:16px;height:16px;flex:none;display:grid;place-items:center;border-radius:var(--radius-round);background:var(--leaf);color:var(--white)}
.chk .ic{width:11px;height:11px;stroke-width:3}
.why{align-self:center;max-width:85%;margin:0 0 4px;color:var(--mu);font-size:var(--type-13);text-align:center}
.g{display:flex;flex-direction:column;gap:2px;margin-top:var(--grp)}
.g.me{align-items:flex-end}
.name{display:inline-flex;align-items:center;gap:5px;margin:0;margin-inline-start:46px;margin-bottom:1px;color:var(--mu);font-size:var(--type-12);font-weight:var(--weight-medium)}
.g.noav .name{margin-inline-start:12px}
.ai{padding:0 6px;border-radius:var(--radius-capsule);background:var(--fill);color:var(--tx);font-size:11px;font-weight:var(--weight-bold);line-height:16px}
.row{display:flex;align-items:flex-end;gap:6px}
.av{width:28px;height:28px;font-size:11px;position:relative;z-index:1}
.avgap{width:28px;flex:none}
.col{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0;max-width:min(290px,calc(100% - 34px))}
.me .col{align-items:flex-end;max-width:100%}
.b{position:relative;isolation:isolate;unicode-bidi:plaintext;max-width:min(283px,72vw);padding:var(--pad);border-radius:var(--r);overflow-wrap:anywhere;white-space:pre-wrap}
.me .b{background:var(--a);color:var(--oa)}
.team .b{background:var(--tb);color:var(--tx)}
.b a{color:inherit;text-decoration:underline}
.tail::before{content:"";position:absolute;z-index:-1;bottom:0;width:25px;height:17px;background:inherit;-webkit-mask:var(--tm);mask:var(--tm);--tm:linear-gradient(#000 0 0) 0 0/18px 100% no-repeat,radial-gradient(circle 10px at 100% 0,#0000 9.5px,#000 10px) 18px 7px/10px 10px no-repeat}
.me .tail::before{inset-inline-end:-7px}
.team .tail::before,.me .tail:dir(rtl)::before{--tm:linear-gradient(#000 0 0) 100% 0/18px 100% no-repeat,radial-gradient(circle 10px at 0 0,#0000 9.5px,#000 10px) -3px 7px/10px 10px no-repeat}
.team .tail::before{inset-inline-start:-7px}
.team .tail:dir(rtl)::before{--tm:linear-gradient(#000 0 0) 0 0/18px 100% no-repeat,radial-gradient(circle 10px at 100% 0,#0000 9.5px,#000 10px) 18px 7px/10px 10px no-repeat}
.fb{font-style:italic;color:var(--mu)}
.img{display:block;border-radius:var(--r);overflow:hidden;background:var(--fill);max-width:min(240px,62vw)}
.img img{display:block;width:100%;height:auto}
.gone{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:var(--radius-bubble);background:var(--tb);color:var(--mb);font-style:italic}
.card{width:290px;max-width:100%;overflow:hidden;border-radius:var(--radius-bubble);background:var(--tb);color:var(--tx);margin-top:2px}
.media{height:88px;display:grid;place-items:center;background:color-mix(in srgb,var(--a) 22%,var(--tb));color:var(--a)}
.media .ic{width:30px;height:30px}
.cb{display:grid;gap:3px;padding:10px 12px 12px}
.cb>*,.why,.cap,.topic{unicode-bidi:plaintext}
.cb strong{font-size:16px}
.cb span{color:var(--mb);font-size:var(--type-13);overflow-wrap:anywhere}
.na{display:flex;align-items:center;gap:6px;margin:8px 0 0;color:var(--mb);font-size:var(--type-13)}
.na .ic{flex:none}
.cta{min-height:44px;margin-top:8px;border-radius:var(--radius-capsule);background:var(--a);color:var(--oa);font-size:15px;font-weight:var(--weight-semibold);display:grid;place-items:center;padding:0 16px;text-decoration:none}
.quick{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.cap{min-height:36px;padding:5px 14px;border:1.5px solid var(--at);border-radius:var(--radius-capsule);color:var(--at);font-size:15px;font-weight:var(--weight-semibold)}
.cap[aria-pressed=true]{background:var(--a);color:var(--oa)}
.cap:disabled:not([aria-pressed=true]){opacity:.45}
.stars{display:flex;gap:2px;margin-top:6px}
.star{width:44px;height:44px;display:grid;place-items:center;color:var(--caution)}
.star .ic{width:28px;height:28px}
.star.on .ic{fill:currentColor}
.meta{padding:2px 6px 0;color:var(--mu);font-size:var(--type-12);font-weight:var(--weight-medium);text-align:end}
.meta button{color:var(--at);font-weight:var(--weight-semibold);margin-inline-start:8px;min-height:32px}
.fail .meta{color:var(--tx)}
.bang{align-self:center;width:44px;height:44px;margin-inline-end:-10px;display:grid;place-items:center;color:var(--stop)}
.bang svg{transform:scaleY(-1)}
.bang path:first-child{fill:currentColor}
.bang path+path{stroke:var(--white);stroke-width:2.4}
.off strong{color:var(--mu)}
.hint{margin-top:12px}
.ask{display:flex;flex-direction:column;align-items:center;gap:8px}
.ask .why{margin:0}
.fail [role=alert]::before{content:"";display:inline-block;width:8px;height:8px;margin-inline-end:6px;border-radius:var(--radius-round);background:var(--stop);vertical-align:middle}
.typing{display:inline-flex;gap:4px;padding:12px 14px}
.typing i{width:8px;height:8px;border-radius:var(--radius-round);background:var(--mu);animation:blink 1.2s infinite both}
.typing i:nth-child(2){animation-delay:.2s}
.typing i:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.35}40%{opacity:1}}
.note{margin:0 12px 8px;padding:10px 14px;border-radius:var(--radius-md);background:var(--fill);color:var(--tx);font-size:var(--type-13)}
.note.bad{background:color-mix(in srgb,var(--stop) 14%,var(--bg));color:var(--tx)}
.note.bar{margin:0;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px));border-radius:0;background:var(--glass);border-top:.5px solid var(--edge);color:var(--mu);text-align:center}
.panel:focus{outline:none}
.comp{--fh:36px;position:relative;display:flex;align-items:flex-end;gap:8px;padding:8px 12px calc(12px + env(safe-area-inset-bottom,0px));background:var(--glass);border-top:.5px solid var(--edge);-webkit-backdrop-filter:blur(20px) saturate(1.8);backdrop-filter:blur(20px) saturate(1.8)}
.plus{position:relative;width:var(--fh);height:var(--fh);flex:none;display:grid;place-items:center;border-radius:var(--radius-round);background:var(--fill)}
.field{flex:1;min-width:0;display:flex;flex-direction:column;border:1px solid color-mix(in srgb,var(--tx) 16%,transparent);border-radius:20px;background:var(--bg)}
.field:has(textarea:focus-visible){outline:var(--focus-width) solid var(--sky);outline-offset:calc(-1 * var(--focus-width))}
.staged{display:flex;gap:6px;padding:8px 8px 0;overflow-x:auto}
.th{position:relative;flex:none}
.th img{width:64px;height:64px;object-fit:cover;border-radius:var(--radius-md);display:block}
.th button{position:absolute;top:-6px;inset-inline-end:-6px;width:24px;height:24px;border-radius:var(--radius-round);background:var(--tx);color:var(--bg);display:grid;place-items:center}
.th .ic{width:12px;height:12px;stroke-width:3}
.line{display:flex;align-items:flex-end}
.field:has(textarea:disabled){opacity:.5}
textarea:focus,textarea:focus-visible{outline:none}
textarea{flex:1;min-width:0;min-height:calc(var(--fh) - 2px);max-height:120px;resize:none;border:0;background:transparent;color:var(--tx);font:inherit;font-size:17px;line-height:22px;padding-block:6px;padding-inline:14px 6px}
textarea::placeholder{color:var(--mu)}
.send{width:28px;height:28px;margin:3px;flex:none;display:grid;place-items:center;border-radius:var(--radius-round);background:var(--a);color:var(--oa)}
.send .ic{width:18px;height:18px;stroke-width:2.6}
.count{position:absolute;inset-inline-end:20px;top:-22px;font-size:var(--type-12);color:var(--mu)}
.count.over{color:var(--stop)}
.drop{position:absolute;inset:0;z-index:5;display:grid;place-items:center;background:color-mix(in srgb,var(--bg) 88%,transparent);border:2px dashed var(--a);border-radius:inherit;font-weight:var(--weight-semibold)}
.lb{position:fixed;inset:0;z-index:6;display:grid;place-items:center;background:var(--scrim-strong)}
.lb img{max-width:94vw;max-height:88vh;border-radius:var(--radius-md)}
.lb .x{top:12px;inset-inline-end:12px;color:var(--white)}
`;
