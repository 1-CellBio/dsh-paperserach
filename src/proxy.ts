/** Forward-proxy fetch for sources behind IP blocks (Google Scholar).
 *
 * Supports the two proxy shapes local setups actually expose:
 *  - http:// / https:// forward proxies — CONNECT tunnel for https targets,
 *    absolute-URI requests for http targets (what requests/urllib do)
 *  - socks5:// — handshake per RFC 1928, no auth
 *
 * Zero dependencies: built on node:http / node:https / node:net / node:tls.
 * Exported byte-level helpers are pure so the SOCKS5 framing is unit-tested
 * without a real proxy.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export type ProxyConfig = {
  kind: "http" | "socks5";
  host: string;
  port: number;
};

/** Parse an http(s)/socks5(h) proxy URL. Returns null when unusable. */
export function parseProxyUrl(raw: string): ProxyConfig | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const protocol = url.protocol.replace(":", "").toLowerCase();
  const kind = protocol === "socks5" || protocol === "socks5h" ? "socks5" : "http";
  if (kind === "http" && protocol !== "http" && protocol !== "https") return null;
  const host = url.hostname;
  if (!host) return null;
  const port = url.port
    ? Number(url.port)
    : kind === "socks5" ? 1080 : protocol === "https" ? 443 : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { kind, host, port };
}

// ── SOCKS5 byte framing (RFC 1928) ──────────────────────────────────

/** Client greeting: one method, no auth. */
export function buildSocks5Greeting(): Buffer {
  return Buffer.from([0x05, 0x01, 0x00]);
}

/** CONNECT request for a domain-name target. */
export function buildSocks5ConnectRequest(host: string, port: number): Buffer {
  const name = Buffer.from(host, "utf8");
  if (name.length > 255) throw new Error("socks5: host name too long");
  return Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
    name,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]);
}

export type Socks5ReplyHeader = { version: number; rep: number; atyp: number };

/** Parse the first 4 bytes of a SOCKS5 CONNECT reply. */
export function parseSocks5ReplyHeader(header: Buffer): Socks5ReplyHeader {
  if (header.length < 4) throw new Error("socks5: short reply header");
  return { version: header[0]!, rep: header[1]!, atyp: header[3]! };
}

/** Bytes to read after the 4-byte header to consume the bound address. */
export function socks5ReplyTailLength(header: Socks5ReplyHeader): number {
  if (header.atyp === 1) return 4 + 2; // IPv4 + port
  if (header.atyp === 4) return 16 + 2; // IPv6 + port
  if (header.atyp === 3) return -1; // domain: 1 length byte, then len + 2
  return -2; // invalid atyp
}

// ── socket plumbing ─────────────────────────────────────────────────

function waitForConnect(socket: net.Socket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      socket.destroy();
      reject(new Error("aborted"));
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      socket.removeListener("error", onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("error", onError);
    socket.once("connect", () => {
      cleanup();
      resolve();
    });
  });
}

/** Byte-accurate socket reader. Chunks are accumulated privately; leftover
 * bytes go back via a single unshift AFTER the handshake (calling
 * readable.unshift() from inside a flowing 'data' handler is unsafe and
 * stalls the stream — that is exactly what the handshake must avoid). */
class SocketByteReader {
  private chunks: Buffer[] = [];
  private length = 0;

  readExact(socket: net.Socket, n: number, signal: AbortSignal): Promise<Buffer> {
    if (this.length >= n) return Promise.resolve(this.take(n));
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        this.chunks.push(chunk);
        this.length += chunk.length;
        if (this.length >= n) {
          cleanup();
          resolve(this.take(n));
        }
      };
      const onAbort = (): void => {
        cleanup();
        socket.destroy();
        reject(new Error("aborted"));
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        socket.removeListener("data", onData);
        signal.removeEventListener("abort", onAbort);
        socket.removeListener("error", onError);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("error", onError);
      socket.on("data", onData);
    });
  }

  private take(n: number): Buffer {
    const all = Buffer.concat(this.chunks, this.length);
    const rest = all.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return all.subarray(0, n);
  }

  /** Handshake done — hand surplus bytes back for the protocol above. */
  flush(socket: net.Socket): void {
    if (this.length === 0) return;
    socket.unshift(Buffer.concat(this.chunks, this.length));
    this.chunks = [];
    this.length = 0;
  }
}

async function dialSocks5(
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  signal: AbortSignal,
): Promise<net.Socket> {
  const socket = net.connect({ host: proxy.host, port: proxy.port, signal });
  try {
    await waitForConnect(socket, signal);
    const reader = new SocketByteReader();
    const write = (payload: Buffer): void => {
      socket.write(payload);
    };
    write(buildSocks5Greeting());
    const greeting = await reader.readExact(socket, 2, signal);
    if (greeting[0] !== 0x05 || greeting[1] !== 0x00) {
      throw new Error("socks5: proxy rejected no-auth method");
    }
    write(buildSocks5ConnectRequest(targetHost, targetPort));
    const header = await reader.readExact(socket, 4, signal);
    const reply = parseSocks5ReplyHeader(header);
    if (reply.rep !== 0) {
      throw new Error(`socks5: CONNECT refused (rep ${reply.rep})`);
    }
    const tail = socks5ReplyTailLength(reply);
    if (tail === -1) {
      const length = (await reader.readExact(socket, 1, signal))[0]!;
      await reader.readExact(socket, length + 2, signal);
    } else if (tail > 0) {
      await reader.readExact(socket, tail, signal);
    }
    reader.flush(socket);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** Open a CONNECT tunnel through a plain http(s) proxy. */
function connectTunnel(
  proxySocket: net.Socket,
  targetHost: string,
  targetPort: number,
  signal: AbortSignal,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      createConnection: () => proxySocket,
      method: "CONNECT",
      host: targetHost,
      port: targetPort,
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
      signal,
    });
    req.once("connect", (response, socket) => {
      if (response.statusCode === 200) {
        resolve(socket);
        return;
      }
      socket?.destroy();
      reject(new Error(`proxy CONNECT failed with HTTP ${response.statusCode ?? 0}`));
    });
    req.once("error", (error) => {
      proxySocket.destroy();
      reject(error);
    });
    req.end();
  });
}

/** AbortSignal guard: node's tls.connect typing takes no signal, so the
 * socket is destroyed manually when the merged signal fires. */
function guardSocket(socket: net.Socket, signal: AbortSignal): void {
  signal.addEventListener("abort", () => socket.destroy(), { once: true });
}

function proxySocketFor(proxy: ProxyConfig, signal: AbortSignal): Promise<net.Socket> {
  if (proxy.kind === "http" && proxy.port === 443) {
    // https:// proxy: speak TLS to the proxy itself first.
    const socket = tls.connect({ host: proxy.host, port: proxy.port });
    guardSocket(socket, signal);
    return new Promise((resolve, reject) => {
      socket.once("secureConnect", () => resolve(socket));
      socket.once("error", reject);
    });
  }
  const socket = net.connect({ host: proxy.host, port: proxy.port, signal });
  return waitForConnect(socket, signal).then(() => socket);
}

// ── public fetch ────────────────────────────────────────────────────

export interface ProxyFetchOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ProxyFetchResult {
  status: number;
  ok: boolean;
  text: string;
}

function finishText(req: http.ClientRequest): Promise<ProxyFetchResult> {
  return new Promise((resolve, reject) => {
    req.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        const status = response.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString("utf8") });
      });
      response.once("error", reject);
    });
    req.once("error", reject);
    req.end();
  });
}

function portOf(target: URL): number {
  return target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
}

function mergedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** GET a text document through a forward proxy. Follows no redirects and
 * retries nothing — callers decide how to treat the status. */
export async function proxyFetchText(
  url: string,
  proxyUrl: string,
  options: ProxyFetchOptions = {},
): Promise<ProxyFetchResult> {
  const proxy = parseProxyUrl(proxyUrl);
  if (!proxy) throw new Error(`invalid proxy url: ${proxyUrl || "(empty)"}`);
  const target = new URL(url);
  const signal = mergedSignal(options.signal, options.timeoutMs ?? 30_000);
  const headers = { Host: target.host, ...(options.headers ?? {}) };

  // Plain http target through an http proxy: absolute-URI request, the
  // classic forward-proxy form (no CONNECT needed).
  if (target.protocol !== "https:" && proxy.kind === "http") {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      path: target.toString(),
      headers,
      signal,
    });
    return finishText(req);
  }

  const tunnel = proxy.kind === "socks5"
    ? await dialSocks5(proxy, target.hostname, portOf(target), signal)
    : await proxySocketFor(proxy, signal).then((socket) =>
        connectTunnel(socket, target.hostname, portOf(target), signal));

  try {
    if (target.protocol === "https:") {
      const secure = tls.connect({ socket: tunnel, servername: target.hostname });
      guardSocket(secure, signal);
      const req = https.request({
        createConnection: () => secure,
        host: target.hostname,
        port: portOf(target),
        path: `${target.pathname}${target.search}`,
        headers,
        signal,
      });
      return await finishText(req);
    }
    const req = http.request({
      createConnection: () => tunnel,
      host: target.hostname,
      port: portOf(target),
      path: `${target.pathname}${target.search}`,
      headers,
      signal,
    });
    return await finishText(req);
  } catch (error) {
    tunnel.destroy();
    throw error;
  }
}
