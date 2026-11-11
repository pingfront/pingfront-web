// The chat: a launcher and a panel (a full-screen sheet on narrow screens) in a custom element with a
// shadow root, so host CSS can't reach it. It renders the engine's state and calls its actions. The layout
// follows Messages ("familiar first") with pingfront's touches: the ping line with the
// static pink dot, receipts with the leaf check, and the AI capsule.
import { ELEMENT_TAG } from "../constants.js";
import type { ChatState, Engine } from "../core/engine.js";
import { pickText } from "../core/look.js";
import type { Card, ImagePart, Message, TeamMember } from "../core/model.js";
import type { OutboxItem } from "../core/outbox.js";
import { canRetry, isPolicyFailure } from "../core/api.js";
import { buildTimeline, pendingLines, type Item, type PendingInfo, type Row } from "../core/timeline.js";
import { adoptCss, h, icon, initials, reconcile } from "./dom.js";
import { pageIcon } from "./pageicon.js";
import { loadLockup, lockup } from "./brand.js";
import type { Lockup } from "./lockup.js";
import { I, TOPIC_ICON } from "./icons.js";
import { ENGLISH, isRtl, loadStrings, type Strings } from "./strings.js";
import { CSS, lookCss } from "./styles.js";

const LIMIT = 4000;
/** The lockup's in-app size in px, 14 px (brand/logo/source/inapp.mjs). */
const BRAND_HEIGHT = 14;
const codePoints = (s: string) => [...s].length;
const FOCUSABLE = 'button:not([disabled]),[href],textarea:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

export class ChatElement extends HTMLElement {
  engine!: Engine;
  #root!: ShadowRoot;
  #setLook!: (css: string) => void;
  #launch!: HTMLButtonElement;
  #badge!: HTMLSpanElement;
  #scrim!: HTMLDivElement;
  private panel!: HTMLDivElement;
  #head!: HTMLDivElement;
  #scroller!: HTMLDivElement;
  #list!: HTMLDivElement;
  #note!: HTMLDivElement;
  /** Offline or the service unreachable: a bar under the header, as iOS and Android show it. */
  #ban!: HTMLParagraphElement;
  /** Only the welcome shows: the thread stays at its top instead of following the bottom. */
  #top = false;
  #brand!: HTMLDivElement;
  #bar!: HTMLSpanElement;
  #barTimer = 0;
  #tick: unknown;
  #noteKey = "";
  #overLimit = false;
  #comp!: HTMLDivElement;
  private input!: HTMLTextAreaElement;
  #sendBtn!: HTMLButtonElement;
  #plus!: HTMLButtonElement;
  #file!: HTMLInputElement;
  #stagedEl!: HTMLDivElement;
  #count!: HTMLSpanElement;
  #drop!: HTMLDivElement;
  #live!: HTMLDivElement;
  #staged: Blob[] = [];
  #nodes = new Map<string, { sig: string; el: HTMLElement }>();
  #previews = new WeakMap<Blob, string>();
  #openWhy = new Set<string>();
  #frame = 0;
  #wasVisible = false;
  #returnFocus: HTMLElement | null = null;
  #lastLook = "";
  #headSig = "";
  private t: Strings = ENGLISH;
  #pf!: HTMLDivElement;
  #off: Array<() => void> = [];
  #stuck = true;
  #overflowBefore = "";
  /** Each unsent message's line and hold, by clientId (pendingLines). */
  private lines = new Map<string, PendingInfo>();
  /** Offer cards a newer offer card replaced, and offers the app reported as unavailable (G11). */
  private replaced = new Set<string>();
  #offerSig = "";
  /** The Free plan's lockup: undefined until asked and loaded, false when it couldn't load. */
  #mark: Lockup | false | undefined;
  #markAsked = false;
  /** The thread whose offer was tapped: the next person on this page (after logout or erase) has another thread, and is offered it again. */
  #pushAskedFor: string | undefined;

  #embedded = false;
  #vvOff: (() => void) | undefined;

  /**
   * `embedded`: the chat fills `container` in the page's flow (no launcher, not modal). `launcherOffset` moves the
   * launcher (and the panel above it) off a page's own bottom controls.
   */
  attach(engine: Engine, showLauncher: boolean, embedded = false, launcherOffset?: { bottom?: number; end?: number }): void {
    this.engine = engine;
    this.#embedded = embedded;
    if (embedded) {
      showLauncher = false;
      this.dataset.embedded = "";
    }
    this.#root = this.attachShadow({ mode: "open" });
    const t = this.t;
    this.#badge = h("span", { class: "badge", "aria-hidden": "true", hidden: true });
    this.#launch = h("button", { class: "launch", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-label": t.open, hidden: !showLauncher, onclick: () => (engine.state.visible ? this.engine.close() : engine.open()) }, icon(I.chat, 28, "ic on"), icon(I.close, 22, "ic off"), this.#badge);
    this.#scrim = h("div", { class: "scrim", hidden: true, onclick: () => this.engine.close() });
    this.#head = h("div", { class: "head" });
    this.#list = h("div", { class: "list", role: "list", "aria-label": t.messages });
    this.#scroller = h("div", { class: "scroll", tabindex: "0", role: "region", "aria-label": t.messages, onscroll: () => this.#onScroll() }, this.#list);
    // Our own scroll indicator, as iOS draws one: a thin thumb in the look's ink, only while the thread moves.
    this.#bar = h("span", { class: "sb", "aria-hidden": "true" });
    // The Free plan's line, on its own bar above the composer: it never scrolls with the welcome.
    this.#brand = h("div", { class: "brand", hidden: true });
    // Not a live region: it is shown and filled in one frame, which screen readers can miss, and the countdown ticks.
    // Each new line is announced once through the chat's live region instead (renderNote).
    this.#note = h("div", { class: "note", hidden: true });
    this.#ban = h("p", { class: "ban", hidden: true });
    this.input = h("textarea", { rows: "1", "aria-label": t.message, enterkeyhint: "send", oninput: () => this.#onInput(), onkeydown: (e: KeyboardEvent) => this.#onKey(e), onpaste: (e: ClipboardEvent) => this.#onPaste(e) });
    this.#sendBtn = h("button", { class: "send", "aria-label": t.send, hidden: true, onclick: () => this.#submit() }, icon(I.up, 18));
    this.#file = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, onchange: () => this.#addFiles([...(this.#file.files ?? [])]) });
    this.#plus = h("button", { class: "plus hit", "aria-label": t.addPhoto, onclick: () => this.#file.click() }, icon(I.plus, 20));
    this.#stagedEl = h("div", { class: "staged", hidden: true });
    // Not a live region: it changes on every keystroke. Crossing the limit is announced once (updateSend).
    this.#count = h("span", { class: "count", hidden: true });
    this.#comp = h("div", { class: "comp" }, this.#count, this.#plus, this.#file, h("div", { class: "field" }, this.#stagedEl, h("div", { class: "line" }, this.input, this.#sendBtn)));
    this.#drop = h("div", { class: "drop", hidden: true, text: t.dropHere });
    this.#live = h("div", { class: "sr", "aria-live": "polite", "aria-atomic": "false" });
    this.panel = h(
      "div",
      embedded
        ? { class: "panel", role: "region", "aria-labelledby": "pf-title", id: "pf-panel", tabindex: "-1", hidden: true }
        : { class: `panel${showLauncher ? "" : " nolaunch"}`, role: "dialog", "aria-modal": "true", "aria-labelledby": "pf-title", id: "pf-panel", tabindex: "-1", hidden: true, onkeydown: (e: KeyboardEvent) => this.#trap(e) },
      h("span", { class: "grab", "aria-hidden": "true" }),
      this.#head,
      this.#scroller,
      this.#bar,
      this.#brand,
      this.#note,
      this.#comp,
      this.#drop,
    );
    this.panel.addEventListener("dragover", (e) => this.#onDrag(e, true));
    this.panel.addEventListener("dragleave", (e) => e.target === this.#drop && this.#onDrag(e, false));
    this.panel.addEventListener("drop", (e) => this.#onDrop(e));
    this.#launch.setAttribute("aria-controls", "pf-panel");
    // Host rules such as `* { font-family }` style the element itself and would be inherited; .pf resets them.
    const pf = (this.#pf = h("div", { class: embedded ? "pf embed" : "pf" }, this.#launch, this.#scrim, this.panel, this.#live));
    for (const [name, v] of [["--lb", launcherOffset?.bottom], ["--le", launcherOffset?.end]] as const) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) pf.style.setProperty(name, `${Math.round(v)}px`);
    }
    adoptCss(this.#root, CSS);
    this.#setLook = adoptCss(this.#root, "");
    this.#root.append(pf);
    // The thread starts under the glass header, however tall it wraps (long names, large text).
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        this.#scroller.style.setProperty("--hh", `${Math.ceil(this.#head.offsetHeight) + 8}px`);
        if (this.#stuck) this.#toBottom();
      });
      ro.observe(this.#head);
      // The thread's own height changes too (a keyboard, a rotated phone, the composer growing): stay at the bottom.
      const keep = new ResizeObserver(() => {
        if (this.#stuck) this.#toBottom();
        this.#tabStop();
      });
      keep.observe(this.#scroller);
      this.#off.push(() => keep.disconnect());
      this.#off.push(() => ro.disconnect());
    }
    this.#off.push(engine.subscribe(() => this.#schedule()));
    this.#off.push(engine.events.on<Message>("message", (m) => this.#announce(m)));
    this.#speak(ENGLISH);
    // English is built in; another language's pack loads once, then every label and row re-renders in it.
    let live = true;
    this.#off.push(() => (live = false));
    void loadStrings(engine.lang).then((t) => live && t !== this.t && this.#speak(t));
    // setLocale(): the new language's pack, then every label, row and the team's own texts again (the last call wins).
    let asked = 0;
    this.#off.push(
      engine.events.on("locale", () => {
        const n = ++asked;
        void loadStrings(engine.lang).then((t) => live && n === asked && this.#speak(t));
      }),
    );
  }

  /** Switches the chat's language: its fixed labels, direction, and every row (rows are cached by content). */
  #speak(t: Strings): void {
    this.t = t;
    this.#pf.lang = t.locale;
    // A right-to-left language lays the chat out right to left; otherwise it follows the host page.
    if (isRtl(t.locale)) this.#pf.dir = "rtl";
    else this.#pf.removeAttribute("dir");
    this.#list.setAttribute("aria-label", t.messages);
    this.#scroller.setAttribute("aria-label", t.messages);
    this.input.setAttribute("aria-label", t.message);
    this.#sendBtn.setAttribute("aria-label", t.send);
    this.#plus.setAttribute("aria-label", t.addPhoto);
    this.#drop.textContent = t.dropHere;
    this.#nodes.clear();
    this.#headSig = "";
    delete this.#brand.dataset.label;
    this.#renderStaged();
    this.render();
  }

  disconnectedCallback(): void {
    this.#vvOff?.();
    this.#vvOff = undefined;
    this.engine.rt.clearTimeout(this.#tick);
    for (const f of this.#off) f();
    this.#off = [];
    cancelAnimationFrame(this.#frame);
  }

  /**
   * The chat's "Turn on notifications" was tapped: the browser's prompt, in this tap's gesture; the offer then goes,
   * and focus stays in the chat, on the panel, as when Delete removes a row.
   */
  #askPush(thread: string | undefined): void {
    void this.engine.enablePush().catch(() => undefined);
    this.#pushAskedFor = thread ?? "";
    this.#schedule();
    this.panel.focus();
  }

  #schedule(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.render();
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  render(): void {
    const s = this.engine.state;
    const t = this.t;
    const css = lookCss(s.look);
    if (css !== this.#lastLook) this.#setLook((this.#lastLook = css));
    this.#launch.setAttribute("aria-expanded", String(s.visible));
    this.#launch.classList.toggle("open", s.visible);
    this.#launch.setAttribute("aria-label", s.visible ? t.close : s.unread > 0 ? t.openUnread(s.unread) : t.open);
    this.#badge.hidden = s.unread === 0 || s.visible;
    this.#badge.textContent = s.unread > 99 ? "99+" : String(s.unread);
    this.panel.hidden = !s.visible;
    this.#scrim.hidden = !s.visible;
    const opened = s.visible && !this.#wasVisible;
    if (s.visible !== this.#wasVisible) this.#visibility(s.visible);
    if (!s.visible) return;
    this.#renderHead(s);
    this.#renderList(s);
    this.#renderNote(s);
    // Sending is impossible (blocked, paused, sign in, a key or origin problem): as on iOS and Android, the notice
    // takes the composer's place instead of a disabled field.
    const blocked = !s.policy.canSend || this.#configProblem(s) !== undefined;
    const hadFocus = this.#comp.contains(this.#root.activeElement);
    this.#comp.hidden = blocked;
    this.#note.classList.toggle("bar", blocked);
    this.#plus.hidden = !s.look.photos;
    this.input.placeholder = pickText(s.look.placeholder, this.engine.lang) ?? t.placeholder;
    const inside = this.panel.contains(this.#root.activeElement);
    if (s.prefill !== undefined) {
      if (!this.input.value.trim()) this.input.value = s.prefill;
      this.engine.state.prefill = undefined;
      this.#onInput();
      // A topic or a prefill is the one reason to put the caret in the composer; embedded, only when focus is
      // already in the chat (open() never takes focus from the host's page there).
      if (!blocked && (!this.#embedded || inside)) this.input.focus();
    }
    this.#updateSend();
    // WAI-ARIA APG, Dialog (Modal): focus moves into the dialog as it opens. The dialog itself takes it (tabindex
    // -1), as Messages and the native SDKs don't raise the keyboard on open; Tab then reaches the controls.
    // Embedded, the chat is part of the page and opening it doesn't move focus.
    if (opened && !this.#embedded && !this.panel.contains(this.#root.activeElement)) this.panel.focus();
    // The focused composer went away (the chat became blocked): focus stays in the chat, on the panel.
    if (hadFocus && blocked) this.panel.focus();
  }

  #visibility(visible: boolean): void {
    this.#wasVisible = visible;
    this.#trackViewport(visible);
    if (this.#embedded) {
      if (visible) this.#stuck = true;
      return;
    }
    const narrow = matchMedia("(max-width: 559.98px)").matches;
    if (visible) {
      const active = document.activeElement;
      this.#returnFocus = active instanceof HTMLElement && (active as Element) !== (this as Element) ? active : null;
      if (narrow) {
        this.#overflowBefore = document.documentElement.style.overflow;
        document.documentElement.style.overflow = "hidden";
      }
      this.#stuck = true;
    } else {
      document.documentElement.style.overflow = this.#overflowBefore;
      if (!this.#launch.hidden) this.#launch.focus();
      else this.#returnFocus?.focus();
    }
  }

  /**
   * The on-screen keyboard. Browsers shrink the visual viewport, not the layout viewport position:fixed uses
   * (Chrome on Android by default, Safari on iOS, which also scrolls the page), so a panel pinned to the bottom
   * would keep its composer under the keyboard. While the chat shows, the panel follows the visible area:
   * --vt (scrolled off at the top), --kb (covered at the bottom), --vh (what is left). Pinch zoom is left alone.
   * Embedded, the chat is in the page's flow: the browser scrolls the focused field into view itself.
   */
  #trackViewport(on: boolean): void {
    this.#vvOff?.();
    this.#vvOff = undefined;
    const vv = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!on || !vv || this.#embedded) return;
    const update = () => {
      const zoomed = Math.abs((vv.scale || 1) - 1) > 0.01;
      const top = zoomed ? 0 : Math.max(0, vv.offsetTop);
      const kb = zoomed ? 0 : Math.max(0, Math.round(window.innerHeight - vv.height - top));
      const panel = this.panel;
      panel.style.setProperty("--vt", `${Math.round(top)}px`);
      panel.style.setProperty("--kb", `${kb}px`);
      panel.style.setProperty("--vh", `${Math.round(vv.height)}px`);
      panel.classList.toggle("kbup", kb > 0);
      if (this.#stuck) this.#toBottom();
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    this.#vvOff = () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      this.panel.classList.remove("kbup");
      for (const v of ["--vt", "--kb", "--vh"]) this.panel.style.removeProperty(v);
    };
  }

  #member(s: ChatState): TeamMember | undefined {
    const team = s.team.length ? s.team : s.look.team;
    return team.find((m) => m.id === s.look.headerMemberId) ?? team[0];
  }

  #face(name: string, size: number, url?: string, cls = "face"): HTMLElement {
    const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
    return url ? h("img", { class: cls, src: url, alt: "", style, width: String(size), height: String(size) }) : h("span", { class: cls, style, "aria-hidden": "true", text: initials(name) });
  }

  #identity(s: ChatState, size: number): HTMLElement {
    const look = s.look;
    const team = s.team.length ? s.team : look.team;
    if (look.headerStyle === "team" && team.length > 1) return h("span", { class: "stack" }, team.slice(0, 3).map((m) => this.#face(m.name, Math.round(size * 0.82), m.avatarUrl)));
    const m = look.headerStyle === "app" ? undefined : this.#member(s);
    if (m) return this.#face(m.name, size, m.avatarUrl);
    // The app's icon: the app header, and no teammate known yet (as iOS shows it), not a teammate's initial. Without a
    // store icon it is the site's own; one that doesn't load becomes the app's first letter.
    const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px`;
    const letter = () => h("span", { class: "appicon", style, "aria-hidden": "true", text: [...(look.appName || "?")][0] });
    const img = h("img", { class: "appicon", src: look.appIconUrl || pageIcon(), alt: "", style });
    img.onerror = () => img.replaceWith(letter());
    return img;
  }

  #heading(s: ChatState): string {
    const look = s.look;
    const custom = pickText(look.headerTitle, this.engine.lang);
    if (custom) return custom;
    if (look.headerStyle === "person") return this.#member(s)?.name ?? this.t.teamTitle(look.appName);
    if (look.headerStyle === "team") return this.t.teamTitle(look.appName);
    return look.appName || this.t.chat;
  }

  #expectation(s: ChatState): string | undefined {
    if (!s.look.showReplyExpectation) return undefined;
    return s.replyExpectation ?? pickText(s.look.replyExpectation, this.engine.lang) ?? this.t.replyExpectation;
  }

  #renderHead(s: ChatState): void {
    const m = this.#member(s);
    const lines = [this.#expectation(s)];
    if (s.look.showLocalTime && s.look.headerStyle === "person" && m?.timeZone) {
      try {
        const time = new Intl.DateTimeFormat(this.engine.lang, { hour: "numeric", minute: "2-digit", timeZone: m.timeZone }).format(new Date());
        lines.push(this.t.localTime(time, m.name.split(" ")[0]!));
      } catch {
        // An unknown time zone: no local time line.
      }
    }
    const sub = lines.filter((l): l is string => Boolean(l));
    // As on iOS and Android: with no conversation yet the welcome (or the loading, offline or failure state in its
    // place) is the header, so the bar keeps only its controls. Each fact is said once. The title stays for the
    // dialog's name, visually hidden.
    const minimal = s.messages.length === 0 && s.pending.length === 0 && !s.typing;
    const sig = JSON.stringify([minimal, this.#heading(s), sub, s.look.headerStyle, s.look.appIconUrl, s.team, s.look.team.length]);
    if (sig === this.#headSig) return;
    this.#headSig = sig;
    this.#head.classList.toggle("min", minimal);
    const close = h("button", { class: "x", "aria-label": this.t.close, onclick: () => this.engine.close() }, icon(I.close, 16));
    const title = h("h1", { class: minimal ? "who sr" : "who", id: "pf-title", text: this.#heading(s) });
    this.#head.replaceChildren(close, ...(minimal ? [title] : [this.#identity(s, 44), title, ...sub.map((line) => h("p", { class: "sub", text: line }))]), this.#ban);
  }

  /** A key or origin problem: nothing can work, so the chat says so once, centered, and nothing invites typing. */
  #configProblem(s: ChatState): string | undefined {
    const p = s.problem;
    if (!p || !(p.code === "key_invalid" || p.code === "key_unknown" || p.code === "origin_not_allowed")) return undefined;
    return this.engine.debug ? p.message : this.t.unavailable;
  }

  /** Why the person can't send, from the policy (native wording); undefined when they can. */
  #policyText(s: ChatState): string | undefined {
    if (s.policy.canSend) return undefined;
    const r = s.policy.reason;
    return r === "app_paused" ? this.t.paused : r === "verification_required" ? this.t.verification : this.t.blocked;
  }

  #renderNote(s: ChatState): void {
    const t = this.t;
    const p = s.problem;
    let text = "";
    let bad = false;
    let ticking = false;
    const rt = this.engine.rt;
    if (this.#configProblem(s) !== undefined) {
      // Said in the thread's place instead (renderList).
    } else if (p && p.code.startsWith("identity_")) {
      text = this.engine.debug ? p.message : "";
      bad = true;
    } else if (!s.policy.canSend) {
      text = this.#policyText(s)!;
    } else if (s.notice?.kind === "rate_limited" && (s.notice.until ?? 0) > rt.wall()) {
      // As on iOS: m:ss under 5 minutes, then a plain line. The digits tick, so the line is not a live region;
      // the chat announces it once, when it appears.
      const left = Math.ceil(((s.notice.until ?? 0) - rt.wall()) / 1000);
      const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      // Photos alone (scope uploads): text still sends, and the line says so.
      const photos = s.notice.scope === "uploads";
      text = left < 300 ? (photos ? t.photosCountdown : t.rateCountdown)(time) : photos ? t.photosPaused : t.rateLimited;
      ticking = left < 300;
    }
    const conn = s.notice?.kind === "offline" ? t.offline : s.notice?.kind === "unreachable" ? t.unreachable : "";
    if (conn && conn !== this.#ban.textContent) this.#say(conn);
    this.#ban.textContent = conn;
    this.#ban.hidden = !conn;
    this.#head.classList.toggle("bn", !!conn);
    // Announced once when it appears; a ticking countdown is the same line, so it isn't announced again.
    const key = ticking ? `tick:${s.notice?.scope}` : text;
    if (text && key !== this.#noteKey) this.#say(text);
    this.#noteKey = text ? key : "";
    this.#note.hidden = !text;
    if (this.#note.textContent !== text) this.#note.textContent = text;
    rt.clearTimeout(this.#tick);
    if (ticking) this.#tick = rt.setTimeout(() => this.#schedule(), 1000);
    this.#note.classList.toggle("bad", bad);
  }


  #renderList(s: ChatState): void {
    const rows = buildTimeline({ messages: s.messages, pending: s.pending, teamReadSeq: s.teamReadSeq, timestamps: s.look.timestamps, typing: s.typing });
    const lines = pendingLines(s.pending, s.policy.reason, s.notice?.kind);
    this.lines = new Map(s.pending.map((p, i) => [p.clientId, lines[i]!]));
    // Only the newest offer card stands; older ones collapse to one line, never stacked (as on iOS).
    const offers = s.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "card" && p.card.kind === "offer" ? [p.card.id] : [])));
    this.replaced = new Set(offers.slice(0, -1));
    this.#offerSig = JSON.stringify([offers, this.engine.offers]);
    const want: HTMLElement[] = [];
    if (s.hasOlder) want.push(this.#keyed("older", String(s.loadingOlder), () => h("div", { class: "olderrow", role: "listitem" }, h("button", { class: "older hit", disabled: s.loadingOlder, onclick: () => void this.engine.loadOlder(), text: this.t.older }))));
    // Online but the server failed: one calm line and "Try again", in place of a welcome that would pretend all is well.
    const stop = this.#configProblem(s);
    const noteSays = Boolean(s.problem?.code.startsWith("identity_") && this.engine.debug);
    // Loading a thread: a still skeleton of bubbles (no spinner, no motion), never over a thread that has rows.
    // The Free plan's lockup loads on demand: the welcome waits for it (the still skeleton stays), so the welcome never
    // shows without it and nothing moves when it arrives.
    const free = Boolean(s.config?.features.branding);
    if (free && !this.#markAsked) {
      this.#markAsked = true;
      void loadLockup().then((l) => ((this.#mark = l ?? false), this.#schedule()));
    }
    const loading = s.loading || (free && this.#mark === undefined);
    this.#list.toggleAttribute("aria-busy", loading && rows.length === 0);
    if (rows.length === 0 && loading && stop === undefined) want.push(this.#keyed("loading", "", () => h("div", { class: "skel", "aria-hidden": "true" }, h("i", { class: "t" }), h("i", { class: "t" }), h("i", { class: "m" }))));
    else if (rows.length === 0 && stop !== undefined) want.push(this.#keyed("stop", stop, () => h("div", { class: "failed", role: "status" }, h("p", { text: stop }))));
    else if (rows.length === 0 && !loading && s.failed && !noteSays) want.push(this.#keyed("failed", this.t.loadFailed, () => h("div", { class: "failed", role: "status" }, h("p", { text: this.t.loadFailed }), h("button", { class: "again", onclick: () => this.engine.retryOpen(), text: this.t.tryAgain }))));
    else if (rows.length === 0 && !loading && !s.failed) want.push(this.#keyed("welcome", JSON.stringify([s.policy.canSend, s.look.appName, s.look.topics, s.look.welcomeTitle, s.look.welcomeBody, s.team, s.look.headerStyle, s.look.showFaces, this.#expectation(s)]), () => this.#welcome(s)));
    for (const r of rows) want.push(this.#keyed(r.key, this.#sig(r, s), () => this.#row(r, s)));
    // After the person's first message, before any reply: the reply waits here. Not while one still waits to send.
    // With the host's push option and no decision yet, a way to be told, as on iOS and Android; once tapped it goes,
    // whatever the person chose.
    const first = s.messages.findIndex((m) => m.author.kind === "person");
    if (first >= 0 && !s.pending.length && s.policy.canSend && s.messages.slice(first).every((m) => m.author.kind === "person" || m.author.kind === "system")) {
      const ask = (s.threadId ?? "") !== this.#pushAskedFor && this.engine.canOfferPush;
      want.push(
        this.#keyed("hint", JSON.stringify([this.t.closeHint, ask && this.t.turnOnNotifications]), () =>
          ask
            ? h("div", { class: "hint ask", role: "listitem" }, h("p", { class: "why", text: this.t.closeHint }), h("button", { class: "topic", onclick: () => this.#askPush(s.threadId), text: this.t.turnOnNotifications }))
            : h("p", { class: "why hint", role: "listitem", text: this.t.closeHint }),
        ),
      );
    }
    // On pingfront's Free plan (features.branding): the brand's own lockup above the composer, only while the
    // welcome shows, never in a conversation. One colour, in the chat's muted ink.
    const branding = rows.length === 0 && !loading && !s.failed && stop === undefined && free;
    this.#brand.hidden = !branding;
    if (branding && this.#brand.dataset.label !== this.t.branding) {
      // Outlines that couldn't load: the same words, in text.
      this.#brand.replaceChildren(this.#mark ? lockup(BRAND_HEIGHT, this.t.branding, this.#mark) : h("span", { text: this.t.branding }));
      this.#brand.dataset.label = this.t.branding;
    }
    this.#top = !rows.length;
    const near = this.#stuck;
    // A list only while it holds rows: the welcome isn't a list item.
    if (rows.length || s.hasOlder) {
      this.#list.setAttribute("role", "list");
      this.#list.setAttribute("aria-label", this.t.messages);
    } else {
      this.#list.removeAttribute("role");
      this.#list.removeAttribute("aria-label");
    }
    reconcile(this.#list, want);
    this.#tabStop();
    const keep = new Set<Node>(want);
    for (const [k, v] of this.#nodes) if (!keep.has(v.el)) this.#nodes.delete(k);
    if (near) this.#toBottom();
  }

  #keyed(key: string, sig: string, make: () => HTMLElement): HTMLElement {
    const hit = this.#nodes.get(key);
    if (hit && hit.sig === sig) return hit.el;
    const el = make();
    this.#nodes.set(key, { sig, el });
    return el;
  }

  #sig(r: Row, s: ChatState): string {
    const look = s.look;
    return JSON.stringify([r, look.showNames, look.showAvatars, look.tails, look.aiName, r.kind === "ping" ? this.#openWhy.has(r.key) : 0, this.canOffer(), this.#canLink(), r.kind === "pending" ? [s.policy.canSend, this.lines.get(r.item.clientId)] : 0, r.kind === "group" ? [s.look.appName, this.#offerSig] : 0]);
  }

  /**
   * The thread is a tab stop only when it scrolls (so arrow keys can move it, WCAG 2.1.1); with nothing to scroll,
   * such as the welcome, it would be an empty stop.
   */
  #tabStop(): void {
    const el = this.#scroller;
    if (el.scrollHeight > el.clientHeight + 1) el.tabIndex = 0;
    else el.removeAttribute("tabindex");
  }

  #onScroll(): void {
    const el = this.#scroller;
    this.#stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    this.#scrollbar();
  }

  /// A thin thumb in the look's own ink, shown while the thread moves and gone when it rests, like the overlay
  /// indicators iOS shows. The operating system's scrollbar is hidden: it is the one piece of the chat we cannot
  /// colour, and it sat outside the panel's radius.
  #scrollbar(): void {
    const el = this.#scroller;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) {
      this.#bar.classList.remove("on");
      return;
    }
    const height = Math.max(36, (el.clientHeight * el.clientHeight) / el.scrollHeight);
    this.#bar.style.height = `${Math.round(height)}px`;
    this.#bar.style.top = `${Math.round(el.offsetTop + (el.scrollTop / max) * (el.clientHeight - height))}px`;
    this.#bar.classList.add("on");
    clearTimeout(this.#barTimer);
    this.#barTimer = window.setTimeout(() => this.#bar.classList.remove("on"), 900);
  }

  #toBottom(): void {
    this.#scroller.scrollTop = this.#top ? 0 : this.#scroller.scrollHeight;
  }

  #welcome(s: ChatState): HTMLElement {
    const look = s.look;
    const lang = this.engine.lang;
    const m = this.#member(s);
    const custom = pickText(look.welcomeTitle, lang);
    // A person who can't send gets no promise of a reply: no reply expectation and no "reply here" line (the notice
    // in the composer's place says why).
    const open = s.policy.canSend;
    const lines = [look.headerStyle === "person" && !custom ? m?.role : undefined, open ? this.#expectation(s) : undefined].filter(Boolean).join("\n");
    return h(
      "div",
      { class: "welcome" },
      look.showFaces ? this.#identity(s, 76) : null,
      h("h2", { text: custom ?? (look.headerStyle === "person" ? m?.name ?? this.#heading(s) : this.#heading(s)) }),
      lines ? h("p", { text: lines }) : null,
      open ? h("p", { text: pickText(look.welcomeBody, lang) ?? this.t.welcomeBody(look.appName) }) : null,
      // As on iOS and Android: topics only when the person can send (a topic fills the composer).
      look.topics.length && s.policy.canSend
        ? h(
            "div",
            { class: "topics" },
            look.topics.map((tp) => h("button", { class: "topic", onclick: () => this.engine.open(tp.id) }, icon(TOPIC_ICON[tp.symbol] ?? I.chat, 18), pickText(tp.label, lang) ?? tp.id)),
          )
        : null,
    );
  }

  #row(r: Row, s: ChatState): HTMLElement {
    const t = this.t;
    switch (r.kind) {
      case "time":
        return h("div", { class: "time", role: "listitem", text: this.#when(r.at) });
      case "ping": {
        const open = this.#openWhy.has(r.key);
        const btn = h("button", { class: "sys hit", "aria-expanded": String(open), onclick: () => (open ? this.#openWhy.delete(r.key) : this.#openWhy.add(r.key), this.render()) }, h("span", { class: "dot", "aria-hidden": "true" }), t.reachedOut(r.name || t.someone));
        return h("div", { role: "listitem", style: "display:flex;flex-direction:column" }, btn, open ? h("p", { class: "why", text: r.ping.explanation }) : null);
      }
      case "system":
        return h("div", { class: "sys", role: "listitem" }, r.receipt ? h("span", { class: "chk", "aria-hidden": "true" }, icon(I.check, 11)) : null, r.text);
      case "status":
        return h("div", { class: "meta", role: "listitem", text: r.read ? t.read : t.delivered });
      case "typing":
        return h("div", { class: "g team", role: "listitem" }, h("div", { class: "row" }, s.look.showAvatars ? h("span", { class: "avgap" }) : null, h("div", { class: `b typing${s.look.tails ? " tail" : ""}`, role: "img", "aria-label": t.typing(r.name) }, h("i"), h("i"), h("i"))));
      case "pending":
        return this.pending(r.item, s);
      case "group":
        return this.#group(r, s);
    }
  }

  #when(at: number): string {
    const d = new Date(at);
    const now = new Date();
    const lang = this.engine.lang;
    const time = new Intl.DateTimeFormat(lang, { hour: "numeric", minute: "2-digit" }).format(d);
    const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86_400_000);
    if (diff === 0) return `${this.t.today} ${time}`;
    if (diff === 1) return `${this.t.yesterday} ${time}`;
    if (diff < 7) return `${new Intl.DateTimeFormat(lang, { weekday: "short" }).format(d)} ${time}`;
    return `${new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" }).format(d)} ${time}`;
  }

  #group(r: Extract<Row, { kind: "group" }>, s: ChatState): HTMLElement {
    const look = s.look;
    const me = r.side === "me";
    const name = r.ai ? look.aiName : r.author.name ?? this.t.someone;
    const showName = !me && (look.showNames || r.ai);
    const kids = r.items.map((it) => this.#item(it, look.tails));
    const avatar = !me && look.showAvatars ? (r.ai ? h("span", { class: "face av", "aria-hidden": "true", text: initials(name) }) : this.#face(name, 28, r.author.avatarUrl, "face av")) : null;
    const who = me ? this.t.you : name;
    return h(
      "div",
      { class: `g ${me ? "me" : "team"}${look.showAvatars ? "" : " noav"}`, role: "listitem" },
      showName ? h("div", { class: "name", "aria-hidden": "true" }, name, r.ai ? h("span", { class: "ai" }, this.t.ai) : null) : null,
      h("span", { class: "sr", text: r.ai ? `${this.t.said(name)} (${this.t.ai})` : this.t.said(who) }),
      me ? h("div", { class: "col" }, kids) : h("div", { class: "row" }, avatar, h("div", { class: "col" }, kids)),
    );
  }

  #item(it: Item, tails: boolean): HTMLElement {
    switch (it.kind) {
      case "text":
        return h("div", { class: `b${tails && it.tail ? " tail" : ""}` }, this.#linkify(it.text));
      case "fallback":
        return h("div", { class: `b fb${tails && it.tail ? " tail" : ""}`, text: it.text || this.t.unsupported });
      case "image":
        return this.#image(it.part);
      case "card":
        return this.card(it.card, it.messageId, it.part.result);
    }
  }

  #linkify(text: string): Node[] {
    const out: Node[] = [];
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      const i = m.index ?? 0;
      if (i > last) out.push(document.createTextNode(text.slice(last, i)));
      const href = m[0];
      out.push(h("a", { href, target: "_blank", rel: "noopener noreferrer", onclick: (e: MouseEvent) => (e.preventDefault(), this.engine.openLink(href)), text: href }));
      last = i + href.length;
    }
    if (last < text.length) out.push(document.createTextNode(text.slice(last)));
    return out;
  }

  #image(p: ImagePart): HTMLElement {
    // Retention deleted the photo: a quiet line in its place, never fetched.
    if (p.removed) return h("div", { class: "gone", role: "img", "aria-label": this.t.photoRemoved }, icon(I.photo, 18), this.t.photoRemoved);
    const ratio = `aspect-ratio:${p.width}/${p.height}`;
    const img = h("img", { alt: this.t.photo, width: String(p.width), height: String(p.height), loading: "lazy", style: ratio });
    let retried = false;
    const load = async () => {
      const url = await this.engine.attachmentUrl(p.attachmentId);
      if (url) img.src = url;
    };
    img.addEventListener("error", () => {
      if (!retried) {
        retried = true;
        void load();
      }
    });
    if (p.url) img.src = p.url;
    else void load();
    return h("button", { class: "img", "aria-label": this.t.photo, onclick: () => img.src && this.lightbox(img.src) }, img);
  }

  // TS-private rather than #lightbox: test/hosting.browser.test.ts opens it directly.
  private lightbox(src: string): void {
    const close = () => {
      box.remove();
      btn.focus();
    };
    const btn = this.#root.activeElement as HTMLElement;
    const x = h("button", { class: "x", "aria-label": this.t.close, onclick: close }, icon(I.close, 16));
    const box = h("div", { class: "lb", role: "dialog", "aria-modal": "true", "aria-label": this.t.photo, onclick: (e: MouseEvent) => e.target === box && close(), onkeydown: (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), close()) }, h("img", { src, alt: this.t.photo }), x);
    this.panel.append(box);
    x.focus();
  }

  /** An offer button needs the app's paywall: without a handler it would do nothing, so the card shows without one. */
  private canOffer(): boolean {
    return Boolean(this.engine.onOffer) || this.engine.events.has("offer");
  }

  /** Links other than http(s) (deep links) open only through the app's handler. */
  #canLink(): boolean {
    return Boolean(this.engine.onLink) || this.engine.events.has("link");
  }

  private opensHere(url: string): boolean {
    try {
      const u = new URL(url, location.href);
      return u.protocol === "http:" || u.protocol === "https:" || this.#canLink();
    } catch {
      return false;
    }
  }

  private card(card: Card, messageId: string, result: { choiceId?: string; rating?: number } | undefined): HTMLElement {
    const e = this.engine;
    const t = this.t;
    const media = (path: string) => h("div", { class: "media", "aria-hidden": "true" }, icon(path, 30));
    const body = (title: string, sub: string | undefined, button: HTMLElement | null) => h("div", { class: "cb" }, h("strong", { text: title }), sub ? h("span", { text: sub }) : null, button);
    // A card that can't act on this page says so where its button would be, as iOS does ("Not available in this
    // app"), instead of a button that does nothing or a card that silently has none.
    const cta = (label: string | undefined, run: (() => void) | false) =>
      run && label ? h("button", { class: "cta", onclick: run, text: label }) : h("p", { class: "na" }, icon(I.info, 16), t.notAvailable);
    switch (card.kind) {
      case "offer": {
        // A newer offer card replaced it: one quiet line in its place, as on iOS.
        if (this.replaced.has(card.id)) return h("div", { class: "gone" }, icon(I.restore, 16), t.replaced);
        // The app reported this paywall as gone or unavailable to the person: the card stays with its title muted and
        // says so where its button was, as iOS and Android do, instead of only when tapped.
        const slots = e.offers;
        if (slots && !slots.some((o) => o.id === card.offerId && o.available)) return h("div", { class: "card off" }, media(I.gift), body(card.title, card.body, h("p", { class: "na" }, icon(I.info, 16), t.offerGone)));
        return h("div", { class: "card" }, media(I.gift), body(card.title, card.body, cta(card.button, this.canOffer() && (() => e.act(card, messageId)))));
      }
      case "review": {
        const url = card.storeUrl;
        // Native wording: "Enjoying <app>?" and why a review helps; the button (the server's "Rate <app>") acts.
        const copy = t.review(e.state.look.appName);
        return h("div", { class: "card" }, media(I.star), body(copy.title, copy.body, cta(card.button, Boolean(url) && (() => (e.act(card, messageId), e.openLink(url!))))));
      }
      case "link": {
        let host = card.url;
        try {
          host = new URL(card.url).host;
        } catch {
          // Show the raw text.
        }
        // A screen link's tap always reports its outcome, so its button stays (the protocol, Saved links).
        return h("div", { class: "card" }, media(I.link), body(card.title, host, cta(card.button, (card.screen || this.opensHere(card.url)) && (() => void e.tapLink(card, messageId)))));
      }
      case "report":
        return h("div", { class: "card" }, media(I.bug), body(card.title, undefined, cta(card.button, () => (e.act(card, messageId), this.input.focus()))));
      case "store_action": {
        const copy = t.storeAction(card.action);
        const url = storeUrl(card.action, card.store, card.productId);
        const label = card.button ?? copy.button;
        // Restoring purchases has no web page: its line already says where to do it, so it isn't said twice.
        const action = url ? cta(label, () => (e.act(card, messageId), e.openLink(url))) : card.action === "restore_purchases" && !card.body ? null : cta(label, false);
        return h("div", { class: "card" }, media(I.card), body(card.title ?? copy.title, card.body ?? copy.body, action));
      }
      case "choices": {
        const chosen = result?.choiceId;
        return h(
          "div",
          { class: "quick", role: "group" },
          card.options.map((o) =>
            h("button", { class: "cap", "aria-pressed": String(chosen === o.id), disabled: chosen !== undefined, onclick: () => e.act(card, messageId, { choiceId: o.id }), text: o.label }),
          ),
        );
      }
      case "rating": {
        const rated = result?.rating;
        // A group of five buttons with a roving tabindex (WAI-ARIA APG, "Managing focus within composite
        // widgets"): one tab stop, arrow keys move between stars, Space or Enter rates. Pressing a star is the answer
        // (as a tap is on iOS and Android), so these are buttons, not radios that arrows would check.
        const focusAt = rated ?? 1;
        const stars = h(
          "div",
          { class: "stars", role: "group", "aria-label": card.question, onkeydown: (ev: KeyboardEvent) => this.starKeys(ev) },
          [1, 2, 3, 4, 5].map((n) =>
            h("button", { class: `star${rated !== undefined && n <= rated ? " on" : ""}`, tabindex: n === focusAt ? "0" : "-1", "aria-pressed": String(rated === n), "aria-label": t.stars(n, 5), "aria-disabled": rated !== undefined ? "true" : null, onclick: () => rated === undefined && e.act(card, messageId, { rating: n }) }, icon(I.star, 28)),
          ),
        );
        return h("div", { class: "card" }, h("div", { class: "cb" }, h("strong", { text: card.question }), stars));
      }
      default:
        return h("div", { class: "b fb", text: t.unsupported });
    }
  }

  private starKeys(ev: KeyboardEvent): void {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (!step) return;
    const all = [...(ev.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(".star")];
    const i = all.indexOf(this.#root.activeElement as HTMLButtonElement);
    if (i < 0) return;
    ev.preventDefault();
    // Left and right follow the reading direction.
    const flip = (ev.key === "ArrowLeft" || ev.key === "ArrowRight") && getComputedStyle(all[0]!).direction === "rtl";
    const next = all[(i + (flip ? -step : step) + 5) % 5]!;
    for (const b of all) b.tabIndex = b === next ? 0 : -1;
    next.focus();
  }

  private pending(item: OutboxItem, s: ChatState): HTMLElement {
    const t = this.t;
    const e = this.engine;
    const id = item.clientId;
    const info = this.lines.get(id);
    // A held message goes by itself later: no error mark, only its muted line. A failure that needs the person reads
    // "Not delivered", and a mark beside the bubble shows Try again and Delete, as the "!" does in Messages.
    const failed = item.state === "failed" && !item.held;
    const policy = isPolicyFailure(item.failure);
    // Try again only where sending again can work, and only while the person can send (as on iOS); a policy
    // refusal (blocked) never puts its reason on the row: the notice in the composer's place says it.
    const retry = failed && s.policy.canSend && (policy || canRetry(item.failure));
    const blobs = item.files ?? item.photos.map((p) => p.blob);
    const kids: HTMLElement[] = blobs.map((b) => h("div", { class: "img" }, h("img", { src: this.preview(b), alt: t.photo })));
    if (item.text) kids.push(h("div", { class: `b${s.look.tails ? " tail" : ""}` }, item.text));
    // WAI-ARIA APG Disclosure: the mark (or a held bubble) shows and hides the row's actions, right after it.
    // The row goes away (Delete) or changes (Try again): focus stays in the chat, on the panel.
    const acts = h(
      "div",
      { class: "meta", hidden: true },
      retry ? h("button", { class: "hit", onclick: () => (e.retry(id), this.panel.focus()), text: t.tryAgain }) : null,
      h("button", { class: "hit", onclick: () => (e.discard(id), this.panel.focus()), text: t.remove }),
    );
    const toggle = (btn: HTMLElement) => {
      btn.setAttribute("aria-expanded", "false");
      btn.onclick = () => btn.setAttribute("aria-expanded", String((acts.hidden = !acts.hidden) === false));
      return btn;
    };
    const line = info?.show && info.line;
    // Held, or queued behind a held message: the bubble itself shows Delete.
    const holds = info?.held && item.state !== "sending";
    return h(
      "div",
      { class: `g me ${failed ? "fail" : "pend"}`, role: "listitem" },
      h("span", { class: "sr", text: t.said(t.you) }),
      h("div", { class: "row" }, failed ? toggle(h("button", { class: "bang", "aria-label": t.notDelivered }, icon(I.info, 24))) : null, holds ? toggle(h("button", { class: "col" }, kids)) : h("div", { class: "col" }, kids)),
      failed
        ? h("div", { class: "meta", role: "alert" }, t.notDeliveredBecause(policy ? undefined : item.failure))
        : line && h("div", { class: "meta", text: line === "waiting" ? t.waitingConnection : line === "sending" || line === "retrying" ? t[line] : t.held(line) }),
      failed || holds ? acts : null,
    );
  }

  private preview(b: Blob): string {
    let u = this.#previews.get(b);
    if (!u) this.#previews.set(b, (u = URL.createObjectURL(b)));
    return u;
  }

  #announce(m: Message): void {
    if (!this.engine.state.visible) return;
    const text = m.parts.map((p) => (p.type === "text" ? p.text : p.type === "receipt" ? p.text : p.type === "image" ? this.t.photo : p.type === "card" && p.card.kind !== "unknown" ? ("title" in p.card && p.card.title) || ("question" in p.card && p.card.question) || "" : m.fallback ?? "")).filter(Boolean).join(" ");
    const name = m.author.kind === "ai" ? this.engine.state.look.aiName : m.author.name ?? this.t.someone;
    this.#say(`${this.t.said(name)} ${text}`);
  }

  /** One line for screen readers, through the chat's polite live region. */
  #say(text: string): void {
    this.#live.append(h("p", { text }));
    while (this.#live.childElementCount > 3) this.#live.firstElementChild?.remove();
  }

  // ---------------------------------------------------------------------------
  // Composer
  // ---------------------------------------------------------------------------

  #onInput(): void {
    const ta = this.input;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(120, ta.scrollHeight)}px`;
    this.engine.draftChanged(ta.value);
    this.#updateSend();
  }

  #updateSend(): void {
    const n = codePoints(this.input.value);
    const has = this.input.value.trim().length > 0 || this.#staged.length > 0;
    this.#sendBtn.hidden = !has;
    this.#sendBtn.disabled = n > LIMIT;
    this.#count.hidden = n < LIMIT - 200;
    this.#count.textContent = n > LIMIT ? this.t.over(n - LIMIT) : String(LIMIT - n);
    this.#count.classList.toggle("over", n > LIMIT);
    if (n > LIMIT && !this.#overLimit) this.#say(this.t.over(n - LIMIT));
    this.#overLimit = n > LIMIT;
  }

  #onKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.#submit();
    }
  }

  #submit(): void {
    if (this.#comp.hidden || codePoints(this.input.value) > LIMIT) return;
    const text = this.input.value;
    if (!text.trim() && this.#staged.length === 0) return;
    this.engine.send(text, this.#staged);
    this.input.value = "";
    this.#staged = [];
    this.#renderStaged();
    this.#onInput();
    this.#stuck = true;
    this.input.focus();
  }

  #addFiles(files: File[]): void {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length || !this.engine.state.look.photos) return;
    this.#staged = [...this.#staged, ...imgs].slice(0, 6);
    this.#file.value = "";
    this.#renderStaged();
    this.#updateSend();
  }

  #renderStaged(): void {
    this.#stagedEl.hidden = this.#staged.length === 0;
    this.#stagedEl.replaceChildren(
      ...this.#staged.map((b, i) =>
        h("div", { class: "th" }, h("img", { src: this.preview(b), alt: this.t.photo }), h("button", { "aria-label": this.t.removePhoto, onclick: () => ((this.#staged = this.#staged.filter((_, j) => j !== i)), this.#renderStaged(), this.#updateSend(), this.input.focus()) }, icon(I.close, 12))),
      ),
    );
  }

  #onPaste(e: ClipboardEvent): void {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      this.#addFiles(files);
    }
  }

  #onDrag(e: DragEvent, on: boolean): void {
    if (!this.engine.state.look.photos || !e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    this.#drop.hidden = !on;
  }

  #onDrop(e: DragEvent): void {
    this.#drop.hidden = true;
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    this.#addFiles([...e.dataTransfer.files]);
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  #trap(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      if (this.panel.querySelector(".lb")) return;
      e.preventDefault();
      this.engine.close();
      return;
    }
    if (e.key !== "Tab") return;
    // The photo lightbox is a modal of its own: while it shows, Tab cycles inside it.
    const scope = this.panel.querySelector<HTMLElement>(".lb") ?? this.panel;
    const all = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]") && el.getClientRects().length > 0);
    if (!all.length) return;
    const first = all[0]!;
    const last = all[all.length - 1]!;
    const active = this.#root.activeElement;
    if (!scope.contains(active) || active === scope) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

/** Store pages on the web, for store action cards (the store hint first, else this device's store). */
export function storeUrl(action: string, store: string | undefined, productId?: string): string | undefined {
  const play = store === "play" || (store !== "app_store" && typeof navigator !== "undefined" && /Android/.test(navigator.userAgent));
  if (play) {
    if (action === "request_refund") return "https://play.google.com/store/account/orderhistory";
    if (action === "redeem_code") return "https://play.google.com/redeem";
    if (action === "restore_purchases") return undefined;
    return `https://play.google.com/store/account/subscriptions${productId ? `?sku=${encodeURIComponent(productId)}` : ""}`;
  }
  if (action === "request_refund") return "https://reportaproblem.apple.com";
  if (action === "redeem_code") return "https://apps.apple.com/redeem";
  if (action === "restore_purchases") return undefined;
  return "https://apps.apple.com/account/subscriptions";
}

/**
 * Registers the chat element. A page can hold a second copy of the widget (the script and the npm package, two
 * versions, a document rewritten in place) whose class already owns the tag; constructing our class under its tag
 * throws "Illegal constructor", so this copy takes the next free numbered tag instead. Returns the tag it uses.
 */
export function defineElement(): string {
  for (let n = 1; ; n++) {
    const tag = n === 1 ? ELEMENT_TAG : `${ELEMENT_TAG}-${n}`;
    const owner = customElements.get(tag);
    if (owner === ChatElement) return tag;
    if (!owner) {
      customElements.define(tag, ChatElement);
      return tag;
    }
  }
}
