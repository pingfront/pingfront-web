// Copied by scripts/sync-contract.mjs from the pingfront wire contract's key check. Do not edit.
// Public app keys look like `pk_live_` + 22 random base62 chars + 2 check chars.
// The check chars let every SDK reject a mistyped key offline, before any request.
// Algorithm (mirror it exactly in Swift, Kotlin and Dart):
//   crc  = CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) of the UTF-8 bytes of prefix + body
//   n    = crc mod 3844
//   check = ALPHABET[floor(n / 62)] + ALPHABET[n mod 62]

export const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const KEY_BODY_LENGTH = 22;

export type KeyKind = "pk" | "sk" | "ids";
export type KeyMode = "live" | "test";

export type ParsedKey = { kind: KeyKind; mode: KeyMode; body: string };

export type KeyProblem =
  | "empty"
  | "whitespace"
  | "wrong_prefix"
  | "wrong_length"
  | "bad_characters"
  | "checksum_mismatch";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function checkChars(prefixAndBody: string): string {
  const n = crc32(prefixAndBody) % 3844;
  return BASE62[Math.floor(n / 62)]! + BASE62[n % 62]!;
}

export function makeKey(kind: KeyKind, mode: KeyMode, random: (n: number) => Uint8Array): string {
  const bytes = random(KEY_BODY_LENGTH);
  let body = "";
  for (const b of bytes) body += BASE62[b % 62];
  const head = `${kind}_${mode}_${body}`;
  return head + checkChars(head);
}

export function checkKey(
  key: string,
  expectedKind: KeyKind = "pk",
): { ok: true; key: ParsedKey } | { ok: false; problem: KeyProblem } {
  if (key.length === 0) return { ok: false, problem: "empty" };
  if (key.trim() !== key) return { ok: false, problem: "whitespace" };
  const match = /^([a-z]+)_(live|test)_(.*)$/.exec(key);
  if (!match || match[1] !== expectedKind) return { ok: false, problem: "wrong_prefix" };
  const rest = match[3]!;
  if (rest.length !== KEY_BODY_LENGTH + 2) return { ok: false, problem: "wrong_length" };
  if (!/^[0-9A-Za-z]+$/.test(rest)) return { ok: false, problem: "bad_characters" };
  const body = rest.slice(0, KEY_BODY_LENGTH);
  const head = `${match[1]}_${match[2]}_${body}`;
  if (checkChars(head) !== rest.slice(KEY_BODY_LENGTH)) return { ok: false, problem: "checksum_mismatch" };
  return { ok: true, key: { kind: expectedKind, mode: match[2] as KeyMode, body } };
}

export const KEY_PROBLEM_MESSAGES: Record<KeyProblem, string> = {
  empty: "The app key is empty. Copy it from Dashboard > App > Connect.",
  whitespace: "The app key has spaces or line breaks around it. Remove them.",
  wrong_prefix: "This is not a public app key. Public keys start with pk_live_ or pk_test_.",
  wrong_length: "The app key has the wrong length. It was probably cut off when copying.",
  bad_characters: "The app key contains characters that never appear in keys.",
  checksum_mismatch: "The app key has a typo: its check characters do not match.",
};
