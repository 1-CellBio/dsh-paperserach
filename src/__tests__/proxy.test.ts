import { describe, expect, it } from "vitest";
import {
  buildSocks5ConnectRequest,
  buildSocks5Greeting,
  parseProxyUrl,
  parseSocks5ReplyHeader,
  socks5ReplyTailLength,
} from "../proxy";

describe("parseProxyUrl", () => {
  it("accepts http and https proxy urls with explicit ports", () => {
    expect(parseProxyUrl("http://127.0.0.1:8080")).toEqual({ kind: "http", host: "127.0.0.1", port: 8080 });
    expect(parseProxyUrl("https://proxy.corp:3128")).toEqual({ kind: "http", host: "proxy.corp", port: 3128 });
  });

  it("maps socks5 and socks5h to kind socks5 with the 1080 default", () => {
    expect(parseProxyUrl("socks5://localhost")).toEqual({ kind: "socks5", host: "localhost", port: 1080 });
    expect(parseProxyUrl("socks5h://127.0.0.1:9050")).toEqual({ kind: "socks5", host: "127.0.0.1", port: 9050 });
  });

  it("defaults the http port and rejects unusable values", () => {
    expect(parseProxyUrl("http://proxy.example")).toEqual({ kind: "http", host: "proxy.example", port: 80 });
    expect(parseProxyUrl("ftp://proxy.example")).toBeNull();
    expect(parseProxyUrl("not a url")).toBeNull();
    expect(parseProxyUrl("")).toBeNull();
    expect(parseProxyUrl("http://")).toBeNull();
  });

  it("ignores userinfo and trailing path noise", () => {
    expect(parseProxyUrl("http://user:pass@127.0.0.1:3128/")).toEqual({ kind: "http", host: "127.0.0.1", port: 3128 });
    expect(parseProxyUrl("  socks5://localhost:9050  ")).toEqual({ kind: "socks5", host: "localhost", port: 9050 });
  });
});

describe("socks5 framing", () => {
  it("greeting offers exactly one no-auth method", () => {
    expect([...buildSocks5Greeting()]).toEqual([0x05, 0x01, 0x00]);
  });

  it("CONNECT request carries the domain target and port in network order", () => {
    const frame = buildSocks5ConnectRequest("scholar.google.com", 443);
    expect(frame[0]).toBe(0x05);        // version
    expect(frame[1]).toBe(0x01);        // CONNECT
    expect(frame[2]).toBe(0x00);        // reserved
    expect(frame[3]).toBe(0x03);        // ATYP domain
    expect(frame[4]).toBe(18);          // label length
    expect(frame.subarray(5, 23).toString("utf8")).toBe("scholar.google.com");
    expect(frame[23]).toBe(0x01);       // 443 >> 8
    expect(frame[24]).toBe(0xbb);       // 443 & 0xff
  });

  it("refuses over-long host names", () => {
    expect(() => buildSocks5ConnectRequest("x".repeat(256), 80)).toThrow(/host name too long/i);
  });

  it("parses reply headers and computes the bound-address tail", () => {
    const ipv4 = parseSocks5ReplyHeader(Buffer.from([0x05, 0x00, 0x00, 0x01]));
    expect(ipv4).toEqual({ version: 5, rep: 0, atyp: 1 });
    expect(socks5ReplyTailLength(ipv4)).toBe(6);   // 4 addr + 2 port
    const ipv6 = parseSocks5ReplyHeader(Buffer.from([0x05, 0x01, 0x00, 0x04]));
    expect(socks5ReplyTailLength(ipv6)).toBe(18);  // 16 addr + 2 port
    const domain = parseSocks5ReplyHeader(Buffer.from([0x05, 0x00, 0x00, 0x03]));
    expect(socks5ReplyTailLength(domain)).toBe(-1);
    expect(socks5ReplyTailLength({ version: 5, rep: 0, atyp: 9 })).toBe(-2);
  });

  it("rejects short reply headers", () => {
    expect(() => parseSocks5ReplyHeader(Buffer.from([0x05, 0x00, 0x00]))).toThrow(/short reply header/i);
  });
});
