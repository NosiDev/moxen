/**
 * HTML to readable text, without a DOM library: headings, paragraphs, lists,
 * code, tables as rows, and links with their targets, with scripts, styles and
 * page chrome left out. It is a tolerant tokenizer, not a parser: it only has
 * to survive whatever a site sends and keep the words in order.
 */

const SKIPPED = new Set(["script", "style", "noscript", "template", "svg", "iframe", "canvas", "object", "embed", "head", "select", "button", "dialog"]);
/** Dropped only when the page has a main region to read instead. */
const CHROME = new Set(["nav", "footer", "aside", "header", "form"]);
const BLOCKS = new Set(["p", "div", "section", "article", "main", "ul", "ol", "table", "tr", "blockquote", "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "address", "fieldset", "hr", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "caption"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "source", "track", "wbr"]);

const NAMED: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", laquo: "«", raquo: "»", times: "×", rarr: "→", larr: "←", euro: "€", pound: "£", yen: "¥", deg: "°", plusmn: "±", frac12: "½",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]!.toLowerCase() === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    out[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return out;
}

/** Code keeps its spaces and line breaks through the tidying below, as stand-ins put back at the end. */
const protectWhitespace = (text: string): string => text.replace(/\r?\n/g, "\u0002").replace(/\t/g, "\u0003\u0003\u0003\u0003").replace(/ /g, "\u0003");
const restoreWhitespace = (text: string): string => text.replace(/\u0002/g, "\n").replace(/\u0003/g, " ");

export interface ExtractedPage {
  readonly title: string;
  readonly text: string;
  /** Visible text is so thin next to the markup that the page is probably built by scripts in a browser. */
  readonly looksScripted: boolean;
}

function resolveHref(href: string, base: string | undefined): string | null {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#") || /^(?:javascript|data|mailto|tel):/i.test(trimmed)) return null;
  try {
    return base ? new URL(trimmed, base).toString() : new URL(trimmed).toString();
  } catch {
    return null;
  }
}

/** The page's main region if it declares one (`main`, `article`, role=main), else everything. */
function mainRegion(html: string): string {
  const found = /<(main|article)\b[^>]*>([\s\S]*)<\/\1>/i.exec(html) ?? /<([a-z]+)\b[^>]*\brole\s*=\s*["']main["'][^>]*>([\s\S]*)<\/\1>/i.exec(html);
  return found && found[2]!.length > 400 ? found[2]! : html;
}

export function extractText(html: string, baseUrl?: string): ExtractedPage {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const hasMain = mainRegion(html) !== html;
  const source = mainRegion(html);
  const out: string[] = [];
  const stack: string[] = [];
  let skipDepth = 0;
  let pre = 0;
  let anchor: { href: string | null; start: number } | null = null;
  const listStack: Array<{ ordered: boolean; n: number }> = [];

  const push = (text: string): void => {
    if (text !== "") out.push(text);
  };
  const newline = (count = 1): void => {
    const tail = out.join("").slice(-2);
    const have = tail.endsWith("\n\n") ? 2 : tail.endsWith("\n") ? 1 : 0;
    if (out.length > 0 && have < count) push("\n".repeat(count - have));
  };

  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|<[^>]*>|[^<]+|</g;
  for (let match = token.exec(source); match; match = token.exec(source)) {
    const closing = match[1] === "/";
    const name = match[2]?.toLowerCase();
    if (name === undefined) {
      if (skipDepth === 0 && !match[0].startsWith("<")) push(pre > 0 ? protectWhitespace(decodeEntities(match[0])) : decodeEntities(match[0]).replace(/\s+/g, " "));
      continue;
    }
    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at === -1) continue;
      while (stack.length > at) {
        const closed = stack.pop()!;
        if (SKIPPED.has(closed) || (hasMain && CHROME.has(closed))) skipDepth = Math.max(0, skipDepth - 1);
      }
      if (skipDepth > 0) continue;
      if (name === "a" && anchor) {
        if (anchor.href !== null) push(` (${anchor.href})`);
        anchor = null;
      } else if (name === "pre") {
        pre = Math.max(0, pre - 1);
        newline();
        push("```");
        newline(2);
      } else if (name === "ul" || name === "ol") {
        listStack.pop();
        newline(listStack.length === 0 ? 2 : 1);
      } else if (name === "td" || name === "th") {
        push(" | ");
      } else if (BLOCKS.has(name)) {
        newline(/^h[1-6]$/.test(name) || name === "p" || name === "blockquote" || name === "table" ? 2 : 1);
      }
      continue;
    }
    const attrs = attributes(match[3] ?? "");
    const selfClosed = VOID.has(name) || (match[3] ?? "").trimEnd().endsWith("/");
    if (skipDepth > 0) {
      if (!selfClosed) {
        stack.push(name);
        if (SKIPPED.has(name) || (hasMain && CHROME.has(name))) skipDepth += 1;
      }
      continue;
    }
    if (SKIPPED.has(name) || (hasMain && CHROME.has(name) && name !== "header") || attrs.hidden !== undefined || attrs["aria-hidden"] === "true") {
      if (!selfClosed) {
        stack.push(name);
        skipDepth += 1;
      }
      continue;
    }
    if (!selfClosed) stack.push(name);
    if (/^h[1-6]$/.test(name)) {
      newline(2);
      push(`${"#".repeat(Number(name[1]))} `);
    } else if (name === "li") {
      newline();
      const list = listStack[listStack.length - 1];
      push(`${"  ".repeat(Math.max(0, listStack.length - 1))}${list?.ordered ? `${(list.n += 1)}. ` : "- "}`);
    } else if (name === "ul" || name === "ol") {
      newline(listStack.length === 0 ? 2 : 1);
      listStack.push({ ordered: name === "ol", n: 0 });
    } else if (name === "pre") {
      pre += 1;
      newline(2);
      push("```\n");
    } else if (name === "br") {
      push("\n");
    } else if (name === "hr") {
      newline(2);
      push("---");
      newline(2);
    } else if (name === "img") {
      if (attrs.alt?.trim()) push(`[image: ${attrs.alt.trim()}]`);
    } else if (name === "a") {
      anchor = { href: attrs.href ? resolveHref(attrs.href, baseUrl) : null, start: out.length };
    } else if (name === "tr") {
      newline();
    } else if (BLOCKS.has(name)) {
      newline(name === "p" || name === "blockquote" ? 2 : 1);
    }
  }

  const text = out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+(?=\S)/g, (gap) => (gap.length > 1 && /^\n {2,}[-\d]/.test(gap) ? gap : "\n"))
    .replace(/ \| \n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const restored = restoreWhitespace(text);
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  return { title, text: restored, looksScripted: text.length < 300 && (scripts >= 3 || /<div[^>]+id=["'](?:root|app|__next|__nuxt)["']/i.test(html) || /enable javascript|requires javascript/i.test(html)) };
}
