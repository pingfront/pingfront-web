// The thread as rows, the way Messages lays it out: centered times per 5-minute section, the ping line
// above a message the team sent first, receipts and system lines, groups of consecutive bubbles from one
// author, Delivered or Read under the person's last message, then unsent messages and the typing bubble.
import type { Author, Card, CardPart, ImagePart, Message, Part, PingOrigin } from "./model.js";
import type { OutboxItem } from "./outbox.js";

const SECTION_MS = 5 * 60_000;

export type Item =
  | { kind: "text"; key: string; text: string; tail: boolean }
  | { kind: "image"; key: string; part: ImagePart; messageId: string; tail: boolean }
  | { kind: "card"; key: string; card: Card; part: CardPart; messageId: string }
  | { kind: "fallback"; key: string; text: string | undefined; tail: boolean };

export type Row =
  | { kind: "time"; key: string; at: number }
  | { kind: "ping"; key: string; name: string; ping: PingOrigin }
  | { kind: "system"; key: string; text: string; receipt: boolean }
  | { kind: "group"; key: string; side: "me" | "team"; author: Author; ai: boolean; items: Item[] }
  | { kind: "status"; key: string; read: boolean }
  | { kind: "pending"; key: string; item: OutboxItem }
  | { kind: "typing"; key: string; name?: string };

export type TimelineInput = {
  messages: Message[];
  pending: OutboxItem[];
  teamReadSeq: number;
  timestamps: "grouped" | "always";
  typing?: { name?: string } | null;
};

const authorKey = (a: Author) => `${a.kind}:${a.id ?? a.name ?? ""}`;

// A hand-off line ("Deniz will reply") records nothing done for the person: it shows without the check.
function items(m: Message): { bubbles: Item[]; receipts: { text: string; check: boolean }[] } {
  const bubbles: Item[] = [];
  const receipts: { text: string; check: boolean }[] = [];
  let unknown = false;
  m.parts.forEach((p: Part, i) => {
    const key = `${m.id}:${i}`;
    if (p.type === "text") {
      if (p.text.trim()) bubbles.push({ kind: "text", key, text: p.text, tail: false });
    } else if (p.type === "image") bubbles.push({ kind: "image", key, part: p, messageId: m.id, tail: false });
    else if (p.type === "card") {
      if (p.card.kind === "unknown") unknown = true;
      else bubbles.push({ kind: "card", key, card: p.card, part: p, messageId: m.id });
    } else if (p.type === "receipt") receipts.push({ text: p.text, check: p.action !== "handed_off" });
    else unknown = true;
  });
  // Parts and cards this version doesn't know show the message's fallback text, once.
  if (unknown) bubbles.push({ kind: "fallback", key: `${m.id}:fallback`, text: m.fallback, tail: false });
  return { bubbles, receipts };
}

export function buildTimeline(input: TimelineInput): Row[] {
  const rows: Row[] = [];
  let lastAt = -Infinity;
  let group: Extract<Row, { kind: "group" }> | null = null;
  let lastMine: number | null = null;
  const closeGroup = () => {
    if (group) {
      // The tail goes on the last bubble, also when only quick replies (choices) follow it, as in Messages.
      const items = group.items;
      let i = items.length - 1;
      const isChoices = (item: (typeof items)[number] | undefined) => item?.kind === "card" && item.card.kind === "choices";
      while (i >= 0 && isChoices(items[i])) i--;
      const last = items[i];
      if (last && "tail" in last) last.tail = true;
    }
    group = null;
  };
  const time = (at: number, key: string, force: boolean) => {
    if (force || at - lastAt >= SECTION_MS) {
      closeGroup();
      rows.push({ kind: "time", key: `t:${key}`, at });
    }
    lastAt = at;
  };

  for (const m of input.messages) {
    const at = Date.parse(m.createdAt) || 0;
    const { bubbles, receipts } = items(m);
    const system = m.author.kind === "system";
    const side = m.author.kind === "person" ? "me" : "team";
    const continues = group !== null && !system && authorKey(group.author) === authorKey(m.author) && at - lastAt < SECTION_MS && !m.ping;
    time(at, m.id, !continues && input.timestamps === "always" && !system);
    if (m.ping) {
      closeGroup();
      rows.push({ kind: "ping", key: `p:${m.id}`, name: (m.author.name ?? "").split(" ")[0] ?? "", ping: m.ping });
    }
    if (system) {
      closeGroup();
      for (const b of bubbles) if (b.kind === "text") rows.push({ kind: "system", key: b.key, text: b.text, receipt: false });
    } else if (bubbles.length) {
      if (!group || authorKey(group.author) !== authorKey(m.author)) {
        closeGroup();
        group = { kind: "group", key: `g:${m.id}`, side, author: m.author, ai: m.author.kind === "ai", items: [] };
        rows.push(group);
      }
      group.items.push(...bubbles);
      if (side === "me") lastMine = m.seq;
    }
    if (receipts.length) {
      closeGroup();
      receipts.forEach((r, i) => rows.push({ kind: "system", key: `r:${m.id}:${i}`, text: r.text, receipt: r.check }));
    }
  }
  closeGroup();

  // Delivered or Read under the person's last message, when it is the newest thing they sent.
  // A message the server already answered with (live, or the send's own answer) shows once, as sent.
  const sent = new Set(input.messages.map((m) => m.clientId));
  const pending = input.pending.filter((p) => !sent.has(p.clientId));
  if (lastMine !== null && pending.length === 0) {
    // As in Messages: only when the person's message is the newest one.
    const idx = rows.findLastIndex((r) => r.kind === "group");
    const newest = rows[idx];
    if (newest?.kind === "group" && newest.side === "me") rows.splice(idx + 1, 0, { kind: "status", key: "status", read: input.teamReadSeq >= lastMine });
  }
  for (const p of pending) rows.push({ kind: "pending", key: `o:${p.clientId}`, item: p });
  if (input.typing) rows.push({ kind: "typing", key: "typing", name: input.typing.name });
  return rows;
}

/**
 * An unsent message's line: "waiting" (offline), "sending" (on the wire, or not tried yet), "retrying" (after an
 * attempt the outbox will retry, queued behind one, or while the service can't be reached), or what it is held for (sending is closed for a reason
 * that ends by itself: it goes then). None for a failure that needs the person. `held` is what it waits for: its own
 * hold, a closed policy that holds messages, or a held message ahead of it (the queue goes in order).
 */
export type PendingInfo = { line?: string; held?: string; show: boolean };

/**
 * Each unsent message's line, as iOS words it. Only the last of a run of the same line shows it (`show`), as Messages
 * shows Delivered once under the last message it applies to; a failure that needs the person ends a run.
 */
export function pendingLines(pending: OutboxItem[], reason: string | undefined, notice: string | undefined): PendingInfo[] {
  let ahead: string | undefined;
  let retrying = false;
  const out = pending.map((p): PendingInfo => {
    const waits = p.state !== "failed";
    const held = p.held ?? (waits ? (reason === "app_paused" || reason === "verification_required" ? reason : ahead) : undefined);
    if (p.held) ahead = p.held;
    // Not on the wire after an attempt, or queued behind one that waits to be tried again: not "Sending…".
    retrying ||= p.state === "queued" && p.attempts > 0;
    const line = !waits && !p.held ? undefined : held ? held : notice === "offline" ? "waiting" : notice === "unreachable" || (p.state === "queued" && retrying) ? "retrying" : "sending";
    return { line, held, show: false };
  });
  out.forEach((o, i) => (o.show = !!o.line && out[i + 1]?.line !== o.line));
  return out;
}

/** Messages sorted by seq, deduplicated by id (newer copies win). */
export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt));
}
