import { describe, expect, it } from "vitest";
import { decodeEntities, findAll, findFirst, nodeText, parseXml, subtreeText } from "../xml";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2404.18021v2</id>
    <title>Coarse-graining &amp; beyond</title>
    <author><name>Alice Chen</name></author>
    <author><name>Bob Li</name></author>
    <link rel="alternate" type="application/pdf" href="https://arxiv.org/pdf/2404.18021v2"/>
    <summary>First &lt;b&gt;line&lt;/b&gt; of the abstract</summary>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2405.00001v1</id>
    <title>Second entry</title>
  </entry>
</feed>`;

describe("parseXml", () => {
  it("parses nested documents with attributes and mixed content", () => {
    const root = parseXml(FEED);
    const entries = findAll(root, "entry");
    expect(entries).toHaveLength(2);
    expect(nodeText(findAll(entries[0]!, "id")[0])).toBe("http://arxiv.org/abs/2404.18021v2");
  });

  it("keeps attributes on nodes", () => {
    const root = parseXml(FEED);
    const link = findAll(root, "link")[0]!;
    expect(link.attrs.rel).toBe("alternate");
    expect(link.attrs.type).toBe("application/pdf");
    expect(link.attrs.href).toBe("https://arxiv.org/pdf/2404.18021v2");
  });

  it("finds descendants depth-first and in document order", () => {
    const root = parseXml(FEED);
    expect(findAll(root, "name").map(nodeText)).toEqual(["Alice Chen", "Bob Li"]);
    expect(nodeText(findFirst(root, "name"))).toBe("Alice Chen");
    expect(findFirst(root, "missing")).toBeUndefined();
  });

  it("decodes entities in text and attributes", () => {
    const root = parseXml(FEED);
    expect(nodeText(findAll(root, "title")[0])).toBe("Coarse-graining & beyond");
    expect(subtreeText(findAll(root, "summary")[0])).toContain("First <b>line</b> of the abstract");
  });

  it("tolerates an empty and a malformed document", () => {
    expect(findAll(parseXml(""), "entry")).toEqual([]);
    expect(findAll(parseXml("<unclosed>"), "unclosed")).toEqual([]);
    expect(nodeText(findFirst(parseXml("just text"), "entry"))).toBe("");
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references", () => {
    expect(decodeEntities("a&amp;b")).toBe("a&b");
    expect(decodeEntities("&#8212;")).toBe("—");
    expect(decodeEntities("&#x2014;")).toBe("—");
    expect(decodeEntities("&unknown;")).toBe("&unknown;");
  });
});
