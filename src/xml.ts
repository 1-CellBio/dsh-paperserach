/** Minimal XML parser for the controlled API responses this plugin consumes
 * (arXiv Atom, NCBI eutils, dblp hits, PMC OA service). Not a general XML
 * implementation: no namespaces, no validation. Mixed content is preserved
 * in document order so itertext-style concatenation works. */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  /** Child nodes, document order. */
  children: XmlNode[];
  /** Direct text of this element (all text fragments concatenated). */
  text: string;
  /** Text and element fragments interleaved in document order. */
  parts: Array<{ kind: "text"; value: string } | { kind: "node"; node: XmlNode }>;
}

export function parseXml(input: string): XmlNode {
  const xml = input.replace(/^\uFEFF/, "");
  const doc: XmlNode = newDocNode();
  const stack: XmlNode[] = [doc];
  let i = 0;

  const tagName = (): string => {
    const start = i;
    while (i < xml.length && /[^\s/>=]/.test(xml[i]!)) i++;
    return xml.slice(start, i);
  };
  const skipWs = (): void => {
    while (i < xml.length && /\s/.test(xml[i]!)) i++;
  };
  const attributes = (): Record<string, string> => {
    const attrs: Record<string, string> = {};
    skipWs();
    while (i < xml.length && xml[i] !== ">" && xml[i] !== "/" && xml[i] !== "?") {
      const name = tagName();
      if (!name) break;
      skipWs();
      let value = "";
      if (xml[i] === "=") {
        i++;
        skipWs();
        const quote = xml[i];
        if (quote === '"' || quote === "'") {
          i++;
          const start = i;
          while (i < xml.length && xml[i] !== quote) i++;
          value = xml.slice(start, i);
          i++;
        } else {
          const start = i;
          while (i < xml.length && /[^\s>]/.test(xml[i]!)) i++;
          value = xml.slice(start, i);
        }
      }
      attrs[name] = decodeEntities(value);
      skipWs();
    }
    return attrs;
  };

  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      appendText(stack.at(-1)!, xml.slice(i));
      break;
    }
    if (lt > i) appendText(stack.at(-1)!, xml.slice(i, lt));
    i = lt + 1;

    if (xml.startsWith("!--", i)) {
      const end = xml.indexOf("-->", i);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("![CDATA[", i)) {
      const end = xml.indexOf("]]>", i);
      const raw = end < 0 ? xml.slice(i + 8) : xml.slice(i + 8, end);
      appendText(stack.at(-1)!, raw, true);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml[i] === "!" || xml[i] === "?") {
      const end = xml.indexOf(">", i);
      i = end < 0 ? xml.length : end + 1;
      continue;
    }

    if (xml[i] === "/") {
      i++;
      tagName();
      skipWs();
      if (xml[i] === ">") i++;
      if (stack.length > 1) stack.pop();
      continue;
    }

    const tag = tagName();
    if (!tag) { i++; continue; }
    const attrs = attributes();
    const node: XmlNode = { tag, attrs, children: [], text: "", parts: [] };
    if (xml[i] === "/") {
      i++;
      if (xml[i] === ">") i++;
      appendNode(stack.at(-1)!, node);
      continue;
    }
    if (xml[i] === ">") i++;
    appendNode(stack.at(-1)!, node);
    stack.push(node);
  }

  return singleRoot(doc);
}

function newDocNode(): XmlNode {
  return { tag: "#document", attrs: {}, children: [], text: "", parts: [] };
}

function singleRoot(doc: XmlNode): XmlNode {
  const roots = doc.children.filter((child) => child.tag !== "#document");
  return roots.length === 1 ? roots[0]! : doc;
}

function appendText(node: XmlNode, raw: string, cdata = false): void {
  if (!raw) return;
  const value = cdata ? raw : decodeEntities(raw);
  node.parts.push({ kind: "text", value });
  node.text += value;
}

function appendNode(parent: XmlNode, node: XmlNode): void {
  parent.parts.push({ kind: "node", node });
  parent.children.push(node);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (full, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return NAMED_ENTITIES[body] ?? full;
  });
}

/** First descendant matching tag name (depth-first). */
export function findFirst(node: XmlNode | undefined, tag: string): XmlNode | undefined {
  if (!node) return undefined;
  if (node.tag === tag) return node;
  for (const child of node.children) {
    const hit = findFirst(child, tag);
    if (hit) return hit;
  }
  return undefined;
}

/** All descendants matching tag name, document order. */
export function findAll(node: XmlNode | undefined, tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (current: XmlNode): void => {
    for (const child of current.children) {
      if (child.tag === tag) out.push(child);
      walk(child);
    }
  };
  if (node) walk(node);
  return out;
}

/** Concatenated own text (already entity-decoded). */
export function nodeText(node: XmlNode | undefined): string {
  return node ? node.text.trim() : "";
}

/** Concatenated text of the whole subtree in document order — mirrors
 * ElementTree itertext(). */
export function subtreeText(node: XmlNode | undefined): string {
  if (!node) return "";
  const parts: string[] = [];
  const walk = (current: XmlNode): void => {
    for (const part of current.parts) {
      if (part.kind === "text") parts.push(part.value);
      else walk(part.node);
    }
  };
  walk(node);
  return parts.join("").trim();
}
