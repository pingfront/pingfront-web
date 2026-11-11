// @vitest-environment node
// The language packs: every shipped language has one, with English's keys, placeholders and the plural
// categories its language uses, and no English left untranslated. Then the lookup (tag normalization,
// plurals, the lazy load) and the script build's pack source (folder, alias, integrity).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "../src/locales/en.json";
import { packBase, scriptPackSource } from "../src/ui/packs";
import { build, isRtl, loadStrings, LOCALES, resolveLocale, type Locale, type Pack } from "../src/ui/strings";

const dir = new URL("../src/locales/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const read = (tag: string) => JSON.parse(readFileSync(new URL(`${tag}.json`, dir), "utf8")) as Record<string, string | Record<string, string>>;
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const others = LOCALES.filter((l) => l !== "en");

// Keys whose English text is also correct in some languages: a placeholder with punctuation, the AI
// label where the language uses the English letters, and "Chat", which several languages borrowed.
const SAME_AS_ENGLISH = new Set(["said", "ai", "chat"]);
// Words that are spelled as in English but are the language's own (checked one by one).
const HOMOGRAPHS: Record<string, string[]> = { da: ["send"], nb: ["send"], fr: ["messages", "message", "placeholder", "photo"], "fr-CA": ["messages", "message", "placeholder", "photo"], nl: ["open"] };

describe("language packs", () => {
  it("ship 50 languages, one file each", () => {
    expect(LOCALES).toHaveLength(50);
    expect(files.map((f) => f.slice(0, -5)).sort()).toEqual([...LOCALES].sort());
  });

  it.each(others)("%s has every key, in English's order, with English's placeholders", (tag) => {
    const pack = read(tag);
    expect(Object.keys(pack)).toEqual(Object.keys(en));
    const categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories.slice().sort();
    for (const [k, ref] of Object.entries(en) as [string, string | Record<string, string>][]) {
      const v = pack[k]!;
      if (typeof ref === "string") {
        expect(typeof v, `${tag}.${k}`).toBe("string");
        expect(holes(v as string), `${tag}.${k}`).toEqual(holes(ref));
      } else {
        expect(Object.keys(v).sort(), `${tag}.${k} plural categories`).toEqual(categories);
        for (const [q, s] of Object.entries(v)) {
          // A form for an exact number (zero; Arabic one and two) may say the number in words.
          const exact = q === "zero" || (tag === "ar" && (q === "one" || q === "two"));
          if (!(exact && holes(s).length === 0)) expect(holes(s), `${tag}.${k}.${q}`).toEqual(holes(ref.other!));
        }
      }
    }
  });

  it.each(others)("%s leaves no English untranslated and keeps the brand voice", (tag) => {
    const pack = read(tag);
    for (const [k, v] of Object.entries(pack)) {
      for (const s of typeof v === "string" ? [v] : Object.values(v)) {
        const ref = (en as Record<string, string | Record<string, string>>)[k]!;
        const english = typeof ref === "string" ? [ref] : Object.values(ref);
        if (!SAME_AS_ENGLISH.has(k) && !HOMOGRAPHS[tag]?.includes(k)) expect(english, `${tag}.${k} is English`).not.toContain(s);
        expect(s, `${tag}.${k}`).not.toMatch(/[!¡]|\p{Extended_Pictographic}/u);
        expect(s.trim(), `${tag}.${k}`).toBe(s);
      }
    }
    expect(pack.branding).toContain("pingfront");
    expect(JSON.stringify(pack)).not.toMatch(/Pingfront|PingFront|PINGFRONT/);
  });
});

// The address form of pingfront's locale guide: words of the other form that must not appear. Whole
// words, case-sensitive; `raw` entries are patterns (a capitalized formal pronoun mid-sentence, suffixes).
// Android's TranslationCatalogTest checks its strings with the same table.
const ADDRESS: Record<string, { words?: string[]; raw?: string[] }> = {
  tr: { words: ["siz", "size", "sizin", "sizi", "sizden", "açın", "edin", "girin", "çizin", "düzeltin", "yönetin", "değiştirin", "gelin"], raw: ["[ıiuü]n[ıiuü]z(?!\\p{L})", "y[ıiuü]n(?!\\p{L})"] },
  "zh-Hans": { raw: ["您"] },
  "zh-Hant": { raw: ["您"] },
  "zh-HK": { raw: ["您"] },
  fr: { words: ["tu", "toi", "ton", "ta", "tes", "appli", "applis"] },
  "fr-CA": { words: ["tu", "toi", "ton", "ta", "tes", "appli", "applis"] },
  de: { raw: ["[a-zäöüß,] (?:Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihnen)(?!\\p{L})"] },
  es: { words: ["usted", "ustedes"] },
  "es-419": { words: ["usted", "ustedes", "vos"] },
  it: { raw: ["[a-zàèéìòù,] (?:Lei|Suo|Sua|Suoi)(?!\\p{L})"] },
  "pt-BR": { words: ["tu", "teu", "tua", "teus", "tuas"] },
  "pt-PT": { words: ["você", "vocês", "tu", "teu", "tua", "teus", "tuas"] },
  nl: { words: ["u", "uw"] },
  ca: { words: ["vostè", "vostès", "vós"] },
  cs: { words: ["ty", "tvůj", "tvoje", "tvá", "tvé", "můžeš", "máš"] },
  sk: { words: ["ty", "tvoj", "tvoja", "tvoje", "môžeš", "máš"] },
  hr: { words: ["ti", "tvoj", "tvoja", "tvoje", "tebi", "tebe", "možeš"] },
  sl: { words: ["ti", "tvoj", "tvoja", "tvoje", "tebi", "tebe"] },
  bg: { words: ["ти", "твоя", "твоят", "твоето", "твоите", "теб", "можеш"] },
  el: { words: ["εσύ", "σου", "σένα"] },
  ro: { words: ["tu", "tău", "tale", "tine"] },
  ru: { words: ["ты", "твой", "твоя", "твоё", "твои", "тебе", "тебя"] },
  uk: { words: ["ти", "твій", "твоя", "твоє", "твої", "тобі", "тебе"] },
  pl: { words: ["Pan", "Pani", "Pana", "Panu", "Państwo", "Państwa"] },
  hu: { words: ["Ön", "Önnek", "Önt", "Öné", "Önök"], raw: ["a\\(z\\)"] },
  fi: { words: ["te", "teidän", "teille", "teitä"] },
  da: { raw: ["[a-zæøå,] (?:De|Dem|Deres)(?!\\p{L})"] },
  nb: { raw: ["[a-zæøå,] (?:De|Dem|Deres)(?!\\p{L})"] },
  sv: { raw: ["[a-zåäö,] (?:Ni|Er|Ert|Era)(?!\\p{L})"] },
  id: { words: ["kamu", "kau", "engkau"] },
  ms: { words: ["kamu", "kau", "engkau", "awak"] },
  vi: { raw: ["quý khách", "quý vị"] },
  hi: { words: ["तुम", "तू", "तुम्हारा", "तुम्हारी"] },
  bn: { words: ["তুমি", "তোমার", "তোমাকে"] },
  ta: { raw: ["உன்", "உனக்கு"] },
  th: { raw: ["ครับ", "ค่ะ"] },
  ko: { words: ["당신"] },
  mr: { words: ["तू", "तुझा", "तुझी", "तुझे", "तुला"] },
  gu: { words: ["તું", "તારું", "તારી", "તારો", "તને"] },
  pa: { words: ["ਤੂੰ", "ਤੇਰਾ", "ਤੇਰੀ", "ਤੇਰੇ", "ਤੈਨੂੰ"] },
  kn: { words: ["ನೀನು", "ನಿನ್ನ", "ನಿನಗೆ"] },
  te: { words: ["నువ్వు", "నీకు", "నీ", "నిన్ను"] },
  ml: { words: ["നീ", "നിന്റെ", "നിനക്ക്", "നിന്നെ"] },
  or: { words: ["ତୁ", "ତୁମେ", "ତୁମର", "ତୋର", "ତୁମକୁ"] },
};
const addressPatterns = (tag: string) => [
  ...(ADDRESS[tag]?.words ?? []).map((w) => new RegExp(`(?<![\\p{L}\\p{M}])${w}(?![\\p{L}\\p{M}])`, "u")),
  ...(ADDRESS[tag]?.raw ?? []).map((r) => new RegExp(r, "u")),
];

describe("the address form", () => {
  it("has a rule for languages whose address form a word can give away", () => {
    for (const tag of Object.keys(ADDRESS)) expect(LOCALES as readonly string[], tag).toContain(tag);
  });

  it.each(others)("%s addresses people the way the locale guide says", (tag) => {
    const pack = read(tag);
    const problems: string[] = [];
    for (const [k, v] of Object.entries(pack)) {
      for (const s of typeof v === "string" ? [v] : Object.values(v)) {
        for (const re of addressPatterns(tag)) if (re.test(s)) problems.push(`${tag}.${k}: ${s} (${re.source})`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("the lookup", () => {
  it("normalizes tags to a shipped language", () => {
    const cases: Record<string, string> = {
      "de-AT": "de", "en-GB": "en", "es-MX": "es-419", "es-US": "es-419", "es-ES": "es", es: "es", pt: "pt-BR", "pt-BR": "pt-BR",
      "pt-PT": "pt-PT", "pt-AO": "pt-PT", "zh-CN": "zh-Hans", zh: "zh-Hans", "zh-TW": "zh-Hant", "zh-HK": "zh-HK", "zh-Hant-HK": "zh-HK", "zh-MO": "zh-HK", "zh-Hant-CN": "zh-Hant",
      "zh-Hans-HK": "zh-Hans", "fr-CA": "fr-CA", "fr-FR": "fr", "fr-BE": "fr", "mr-IN": "mr", "te-IN": "te",
      "zh-Hans-TW": "zh-Hans", iw: "he", "in-ID": "id", no: "nb", "nn-NO": "nb", "fa-IR": "fa", "sw-KE": "en", "not a tag": "en",
    };
    for (const [tag, want] of Object.entries(cases)) expect(resolveLocale(tag), tag).toBe(want);
  });

  it("lays out Arabic, Hebrew, Persian and Urdu right to left", () => {
    expect(LOCALES.filter(isRtl).sort()).toEqual(["ar", "fa", "he", "ur"]);
  });

  it("picks the plural form for the number, in the language's digits", () => {
    const ar = build("ar", read("ar") as Partial<Pack>);
    expect(new Set([0, 1, 2, 3, 11, 100].map((n) => ar.openUnread(n))).size).toBeGreaterThan(3);
    const ru = build("ru", read("ru") as Partial<Pack>);
    expect(ru.over(1)).not.toBe(ru.over(2));
    expect(ru.over(2)).not.toBe(ru.over(5));
    expect(build("en").over(1200)).toBe("1,200 characters over the limit");
    expect(build("en").teamTitle("")).toBe("The team");
    // An action this version doesn't know reads as managing the subscription, as on iOS.
    expect(build("en").storeAction("hologram")).toEqual({ title: "Your subscription", body: "Change your plan, payment method or renewal.", button: "Manage subscription" });
  });

  // Android's pf_stars plurals, chosen by the number the noun counts (pf_stars_plural_on): the total, or the rating.
  it("pluralizes the stars line on the number its noun counts, in the language's digits", () => {
    const at = (tag: Locale) => build(tag, read(tag) as Partial<Pack>);
    const ar = at("ar");
    const d = (n: number) => new Intl.NumberFormat("ar").format(n);
    expect(ar.stars(4, 5)).toBe(`${d(4)} من ${d(5)} نجوم`);
    expect(ar.stars(1, 1)).toBe(`${d(1)} من ${d(1)} نجمة`);
    expect(ar.stars(1, 2)).toBe(`${d(1)} من ${d(2)} نجمتين`);
    expect(ar.stars(4, 11)).toBe(`${d(4)} من ${d(11)} نجمة`);
    expect(at("el").stars(3, 5)).toBe("Βαθμολογία: 3 από 5");
    expect(at("fr").stars(4, 5)).toBe("4 étoiles sur 5");
    expect(at("fr").stars(1, 1)).toBe("1 étoile sur 1");
    expect(at("tr").stars(4, 5)).toBe("5 üzerinden 4 yıldız");
    expect(build("en").stars(1, 5)).toBe("1 of 5 stars");
    expect(build("en").stars(1, 1)).toBe("1 of 1 star");
    const five = (tag: Locale) => [1, 2, 5].map((n) => (tag === "en" ? build("en") : at(tag)).stars(n, 5));
    expect(five("en")).toEqual(["1 of 5 stars", "2 of 5 stars", "5 of 5 stars"]);
    expect(five("fr")).toEqual(["1 étoile sur 5", "2 étoiles sur 5", "5 étoiles sur 5"]);
    expect(five("fr-CA")).toEqual(["1 étoile sur 5", "2 étoiles sur 5", "5 étoiles sur 5"]);
    expect(five("ar")).toEqual([1, 2, 5].map((n) => `${d(n)} من ${d(5)} نجوم`));
    expect(five("ru")).toEqual(["Оценка: 1 из 5", "Оценка: 2 из 5", "Оценка: 5 из 5"]);
    expect(five("pl")).toEqual(["Ocena: 1 z 5", "Ocena: 2 z 5", "Ocena: 5 z 5"]);
    expect(at("ro").stars(1, 1)).toBe("1 din 1 stea");
  });

  it("uses the native SDKs' wording (iOS where iOS and Android differ)", () => {
    const en = build("en");
    expect(en.welcomeBody("Clockwise")).toBe("Questions, bugs or ideas: the people who make Clockwise read every message and reply here.");
    expect(en.placeholder).toBe("Message");
    expect(en.offline).toBe("You're offline. Messages will send when you're back online.");
    expect(en.loadFailed).toBe("Couldn't load the conversation.");
    expect(en.unavailable).toBe("Chat is unavailable right now.");
    expect(en.paused).toBe("This chat is paused for now.");
    expect(en.unreachable).toBe("Can't reach the chat right now. Messages will send when it's back.");
    expect(en.retrying).toBe("Not sent yet. Trying again soon.");
    expect(en.held("app_paused")).toBe("Not sent yet. It will send when the chat is back.");
    expect(en.held("verification_required")).toBe("Not sent yet. It will send after you sign in.");
    expect(en.closeHint).toBe("You can close this; the reply waits here.");
    expect(en.replaced).toBe("Replaced by a newer offer");
    expect(en.offerGone).toBe("This offer is no longer available.");
    expect(en.photoRemoved).toBe("Photo removed");
    expect(en.rateLimited).toBe("Sending is paused for a while. Try again later.");
    expect(en.rateCountdown("0:40")).toBe("You can send again in 0:40.");
    expect([en.notDelivered, en.sending, en.waitingConnection, en.older, en.addPhoto, en.tryAgain, en.remove]).toEqual(["Not delivered", "Sending…", "Waiting for connection", "Load earlier messages", "Add photo", "Try again", "Delete"]);
    expect(en.stars(4, 5)).toBe("4 of 5 stars");
    expect(en.review("Clockwise")).toEqual({ title: "Enjoying Clockwise?", body: "Your review helps other people find Clockwise." });
    expect(en.teamTitle("Clockwise")).toBe("The Clockwise team");
    expect(en.storeAction("billing_issue")).toEqual({ title: "Payment didn't go through", body: "Update your payment method to keep your subscription.", button: "Update payment method" });
    expect(en.storeAction("manage_subscriptions")).toEqual({ title: "Your subscription", body: "Change your plan, payment method or renewal.", button: "Manage subscription" });
  });

  it("loads a pack lazily, and falls back to English for a language it doesn't ship", async () => {
    expect((await loadStrings("de-CH")).send).toBe(read("de").send);
    expect((await loadStrings("ja")).locale).toBe("ja");
    expect((await loadStrings("sw")).send).toBe("Send");
  });
});

describe("the script build's packs", () => {
  it("load from the script's folder, the alias from its exact version", () => {
    expect(packBase("https://cdn.pingfront.sh/web/1.0.0/pingfront.js").href).toBe("https://cdn.pingfront.sh/web/1.0.0/locales/");
    expect(packBase("https://cdn.pingfront.sh/web/v1/pingfront.js").href).toBe("https://cdn.pingfront.sh/web/1.0.0/locales/");
    expect(packBase("https://example.com/static/pf/pingfront.js").href).toBe("https://example.com/static/pf/locales/");
    expect(packBase(undefined).href).toBe("https://cdn.pingfront.sh/web/1.0.0/locales/");
  });

  it("check the manifest's digest and each pack's, without credentials", async () => {
    const calls: [string, RequestInit][] = [];
    const fake = (async (u: URL | string, o: RequestInit = {}) => {
      calls.push([String(u), o]);
      return new Response(String(u).endsWith("manifest.json") ? JSON.stringify({ de: "sha384-de" }) : JSON.stringify({ send: "Senden" }));
    }) as typeof fetch;
    const source = scriptPackSource("https://cdn.test/web/1.0.0/pingfront.js", "sha384-manifest", fake);
    expect(await source("de")).toEqual({ send: "Senden" });
    expect(await source("fr")).toBeUndefined(); // Not in the manifest: never fetched.
    expect(calls.map(([u, o]) => [u, o.integrity, o.credentials])).toEqual([
      ["https://cdn.test/web/1.0.0/locales/manifest.json", "sha384-manifest", "omit"],
      ["https://cdn.test/web/1.0.0/locales/de.json", "sha384-de", "omit"],
    ]);
  });

  it("carry the Free plan's lockup outlines in the same manifest, checked the same way", async () => {
    const { packManifest, lockupFile } = await import("../vite.config");
    const { LOCKUP } = await import("../src/ui/lockup");
    expect(JSON.parse(packManifest).lockup).toBe(lockupFile.integrity);
    expect(JSON.parse(lockupFile.source)).toEqual(LOCKUP);
    const calls: [string, RequestInit][] = [];
    const fake = (async (u: URL | string, o: RequestInit = {}) => {
      calls.push([String(u), o]);
      return new Response(String(u).endsWith("manifest.json") ? JSON.stringify({ lockup: "sha384-lockup" }) : lockupFile.source);
    }) as typeof fetch;
    const source = scriptPackSource("https://cdn.test/web/1.0.0/pingfront.js", "sha384-manifest", fake);
    expect(await source("lockup")).toEqual(LOCKUP);
    expect(calls.at(-1)!.slice(0, 1).concat(calls.at(-1)![1].integrity as string)).toEqual(["https://cdn.test/web/1.0.0/locales/lockup.json", "sha384-lockup"]);
  });
});
