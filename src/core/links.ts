// Chat links (the protocol, "Chat links"): a URL the app routes to the SDK whose query has `pingfront=chat` or
// `pingfront=report`, with an optional `topic`. Pure parsing; the engine decides what a topic matches.

/** What a URL is: not a chat link, a refused one, or a link to open. `topic` is only a candidate here. */
export type ChatLink = { kind: "none" } | { kind: "refused" } | { kind: "chat"; topic?: string } | { kind: "report" };

const LINK_PARAM = "pingfront";
const TOPIC_PARAM = "topic";
const MAX_LENGTH = 2048;
const HIERARCHICAL = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
/** Schemes no link opens and no chat link carries (the protocol, "Link card URLs"). */
const DENIED = new Set(["javascript", "data", "vbscript", "file", "blob", "about", "content", "intent"]);
const TOPIC_ID = /^[a-z0-9_-]{1,32}$/;

/**
 * The link card URL rule (the protocol, "Link card URLs"; fixtures/link-urls.json): ASCII tab, line feed and
 * carriage return removed, whitespace and control characters trimmed from both ends, as a browser reads a URL.
 * Returns the cleaned URL, or undefined when it has no scheme or a refused one.
 */
export function allowedLink(raw: string): string | undefined {
  const edge = (c = "") => c <= " " || (c >= "\x7f" && c <= "\x9f") || /\s/.test(c);
  let url = raw.replace(/[\t\n\r]/g, "");
  let a = 0;
  let b = url.length;
  while (a < b && edge(url[a])) a++;
  while (b > a && edge(url[b - 1])) b--;
  url = url.slice(a, b);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  return scheme && !DENIED.has(scheme) ? url : undefined;
}

/** True for `chat` and `report` links (the call returns true for them). */
export const isOpenable = (l: ChatLink): l is { kind: "chat"; topic?: string } | { kind: "report" } => l.kind === "chat" || l.kind === "report";

export function parseChatLink(input: string | URL | undefined | null): ChatLink {
  const raw = input instanceof URL ? input.href : input;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return { kind: "none" };
  const scheme = HIERARCHICAL.exec(raw)?.[1]?.toLowerCase();
  if (!scheme || DENIED.has(scheme)) return { kind: "none" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "none" };
  }
  // Only the query counts: URLSearchParams percent-decodes names and values; the fragment is not in `search`.
  const params = new URLSearchParams(url.search);
  const values = params.getAll(LINK_PARAM);
  if (values.length === 0) return { kind: "none" };
  if (values.length > 1) return { kind: "refused" };
  if (values[0] === "report") return { kind: "report" };
  if (values[0] !== "chat") return { kind: "refused" };
  const topics = params.getAll(TOPIC_PARAM);
  const topic = topics.length === 1 && TOPIC_ID.test(topics[0]!) ? topics[0] : undefined;
  return topic ? { kind: "chat", topic } : { kind: "chat" };
}

/**
 * The address without a chat link's own parameters (`pingfront`, `topic`), for `history.replaceState`: the
 * path, every other parameter as it was written, and the fragment.
 */
export function withoutLinkParams(loc: { pathname: string; search: string; hash: string }): string {
  const kept = loc.search
    .replace(/^\?/, "")
    .split("&")
    .filter((part) => {
      if (!part) return false;
      const name = part.split("=")[0]!;
      let decoded = name;
      try {
        decoded = decodeURIComponent(name.replace(/\+/g, " "));
      } catch {
        // Malformed escapes are someone else's parameter: keep it.
      }
      return decoded !== LINK_PARAM && decoded !== TOPIC_PARAM;
    });
  return `${loc.pathname}${kept.length ? `?${kept.join("&")}` : ""}${loc.hash}`;
}
