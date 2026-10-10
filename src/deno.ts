// Finds the Deno binary, or downloads a pinned version on first use.

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";
import { inflateRawSync } from "node:zlib";
import { cacheRoot } from "./cache.ts";
import { SandboxError } from "./errors.ts";

export const DENO_VERSION = "2.9.7";

// SHA-256 of the release zips on https://github.com/denoland/deno/releases/tag/v2.9.7
const CHECKSUMS: Record<string, string> = {
  "x86_64-unknown-linux-gnu": "c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490",
  "aarch64-unknown-linux-gnu": "c832298b1ad4422481334855f6003e0f54145762c5a134f20a489511d2f65bbf",
  "x86_64-apple-darwin": "95daaff11c116a52ad54785e7914c8e9c9cdcaba793c5ed929c74ca2d8e6259a",
  "aarch64-apple-darwin": "5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c",
};

const DEFAULT_BASE_URL = "https://github.com/denoland/deno/releases/download";

let pending: Promise<string> | undefined;

// Order: AGENT_CODE_SANDBOX_DENO_PATH, deno on PATH, the cached download, a new download.
export function getDeno(): Promise<string> {
  pending ??= locate().catch((e) => {
    pending = undefined; // Let the next exec() retry.
    throw e;
  });
  return pending;
}

async function locate(): Promise<string> {
  const configured = process.env.AGENT_CODE_SANDBOX_DENO_PATH;
  if (configured) return configured;
  const onPath = findOnPath("deno");
  if (onPath) return onPath;

  const target = targetTriple();
  const bin = path.join(cacheRoot(), "deno", DENO_VERSION, target, "deno");
  if (fs.existsSync(bin)) return bin;

  const base = (process.env.AGENT_CODE_SANDBOX_DENO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/v${DENO_VERSION}/deno-${target}.zip`;
  let zip: Buffer;
  try {
    zip = await download(url);
  } catch (e) {
    throw new SandboxError(`Failed to download Deno from ${url}: ${(e as Error).message}. ` +
      "Install Deno on PATH or set AGENT_CODE_SANDBOX_DENO_PATH.", { cause: e });
  }
  const actual = createHash("sha256").update(zip).digest("hex");
  if (actual !== CHECKSUMS[target]) {
    throw new SandboxError(`Checksum mismatch for ${url}: expected ${CHECKSUMS[target]}, got ${actual}.`);
  }
  const exe = extractFile(zip, "deno");
  // Write to a temp file and rename, so concurrent processes never see a partial binary.
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const tmp = `${bin}.tmp-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, exe, { mode: 0o755 });
  fs.renameSync(tmp, bin);
  return bin;
}

function targetTriple(): string {
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch as string];
  const os = { linux: "unknown-linux-gnu", darwin: "apple-darwin" }[process.platform as string];
  if (!arch || !os) {
    throw new SandboxError(`No Deno download for ${process.platform}/${process.arch}. ` +
      "Install Deno on PATH or set AGENT_CODE_SANDBOX_DENO_PATH.");
  }
  return `${arch}-${os}`;
}

function findOnPath(cmd: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

// Reads one file out of a zip archive. Supports the stored and deflate methods, which is
// all the Deno release zips use.
export function extractFile(zip: Buffer, name: string): Buffer {
  // End of central directory record: at least 22 bytes from the end, followed by a comment.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SandboxError("Invalid zip: no end of central directory.");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new SandboxError("Invalid zip: bad central directory.");
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const entryName = zip.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const data = zip.subarray(start, start + compressedSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new SandboxError(`Unsupported zip compression method ${method}.`);
  }
  throw new SandboxError(`"${name}" not found in the zip.`);
}

// GET with redirects. Uses HTTPS_PROXY / NO_PROXY from the environment, because Node's
// built-in fetch ignores them unless NODE_USE_ENV_PROXY is set.
async function download(url: string, redirects = 5): Promise<Buffer> {
  const u = new URL(url);
  const { res, close } = await get(u);
  try {
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      if (redirects === 0) throw new Error("Too many redirects");
      return await download(new URL(res.headers.location, u).toString(), redirects - 1);
    }
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  } finally {
    close();
  }
}

async function get(u: URL): Promise<{ res: http.IncomingMessage; close: () => void }> {
  const headers = { "user-agent": "agent-code-sandbox" };
  const proxy = proxyFor(u);
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  let createConnection: (() => net.Socket) | undefined;
  let raw: net.Socket | undefined;
  if (proxy && u.protocol === "https:") {
    const socket = (raw = await tunnel(proxy, u.hostname, port));
    socket.on("error", () => {}); // Errors surface on the TLS socket and the request.
    createConnection = () => tls.connect({ socket, servername: u.hostname });
  }
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).request(u, { headers, agent: false, createConnection }, (res) => {
      // Close the connection and the proxy tunnel, so they do not keep the process alive.
      resolve({ res, close: () => (res.socket?.destroy(), raw?.destroy()) });
    });
    req.on("error", (e) => {
      raw?.destroy();
      reject(e);
    });
    req.setTimeout(60_000, () => req.destroy(new Error("Request timed out")));
    req.end();
  });
}

function tunnel(proxy: URL, host: string, port: number): Promise<net.Socket> {
  const headers: Record<string, string> = { host: `${host}:${port}` };
  if (proxy.username) {
    const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    headers["proxy-authorization"] = `Basic ${Buffer.from(auth).toString("base64")}`;
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) return resolve(socket);
      socket.destroy();
      reject(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode}`));
    });
    req.on("error", reject);
    req.end();
  });
}

function proxyFor(u: URL): URL | undefined {
  const env = process.env;
  const raw = u.protocol === "https:" ? env.HTTPS_PROXY || env.https_proxy : env.HTTP_PROXY || env.http_proxy;
  if (!raw) return undefined;
  const noProxy = (env.NO_PROXY || env.no_proxy || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  for (const entry of noProxy) {
    if (entry === "*") return undefined;
    const domain = entry.replace(/^\*?\./, "").replace(/:\d+$/, "");
    if (host === domain || host.endsWith(`.${domain}`)) return undefined;
  }
  return new URL(raw.includes("://") ? raw : `http://${raw}`);
}
