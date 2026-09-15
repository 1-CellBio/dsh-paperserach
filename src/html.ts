/** Minimal HTML helpers for the scraping adapters (google_scholar / ssrn /
 * base / iacr): entity decoding, tag stripping and attribute extraction.
 * Zero dependencies — the fragments these adapters parse are simple,
 * well-shaped result rows, so a small regex layer beats a DOM. */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Decode the handful of named entities Google/Bing-grade HTML actually uses,
 * plus numeric (&#8217;) and hex (&#x2019;) references. */
export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/** Strip all tags and collapse whitespace — leaves readable text. */
export function stripTags(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

/** First capture group of a regex, or "" — the adapters' bread and butter. */
export function firstMatch(input: string, pattern: RegExp): string {
  const match = pattern.exec(input);
  return match?.[1]?.trim() ?? "";
}

/** All capture-group matches of a global regex (empty strings dropped). */
export function allMatches(input: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const global = pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, pattern.flags + "g");
  for (const match of input.matchAll(global)) {
    const value = match[1]?.trim();
    if (value) out.push(value);
  }
  return out;
}

/** Extract one attribute value from a single tag string (no nesting). */
export function attrValue(tag: string, name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return (match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim();
}

/** Absolute-ize a possibly protocol-relative or root-relative URL. */
export function absoluteUrl(raw: string, base: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) {
    try {
      return new URL(value, base).toString();
    } catch {
      return "";
    }
  }
  return "";
}
