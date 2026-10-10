// PoC of exec(): runs LLM-generated JS/TS in a Deno child process.
// See docs/design.md for the reasons behind each step.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowed, parseAllowedPackage, parseNpmSpecifier, type AllowedPackage } from "./packages.ts";

export type ExecOptions = {
  code?: string;
  entrypoint?: string;
  workdir: string;
  readonlyPaths?: string[];
  allowedPackages?: string[];
  allowedDomains?: string[];
  timeoutMs?: number;
  memoryMb?: number;
  maxOutputBytes?: number;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  // Time spent per phase, for the PoC measurements.
  phases: Record<string, number>;
};

const DENO = process.env.SANDBOX_DENO_PATH ?? findOnPath("deno");
const CACHE_ROOT = process.env.SANDBOX_CACHE_DIR ?? path.join(os.homedir(), ".cache", "agent-code-sandbox");
const STORE_DIR = path.join(CACHE_ROOT, "store"); // DENO_DIR for phase A only
const VIEWS_DIR = path.join(CACHE_ROOT, "views"); // DENO_DIR per set of packages, for phase B
const NPM_SUBDIR = path.join("npm", "registry.npmjs.org");

// Env vars passed to Deno. Nothing else from the host process is inherited.
function baseEnv(denoDir: string): NodeJS.ProcessEnv {
  return {
    DENO_DIR: denoDir,
    NO_COLOR: "1",
    DENO_NO_UPDATE_CHECK: "1",
    DENO_NO_PACKAGE_JSON: "1",
    HOME: denoDir,
    PATH: "/usr/bin:/bin",
  };
}

// Phase A needs to reach the npm registry, possibly through the host's proxy.
function fetchEnv(denoDir: string): NodeJS.ProcessEnv {
  const env = baseEnv(denoDir);
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "DENO_CERT", "NPM_CONFIG_REGISTRY"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

class SandboxError extends Error {}

export async function exec(opts: ExecOptions): Promise<ExecResult> {
  const started = performance.now();
  const phases: Record<string, number> = {};
  const mark = (name: string, t0: number) => (phases[name] = Math.round(performance.now() - t0));

  const workdir = fs.realpathSync(opts.workdir);
  const readonlyPaths = (opts.readonlyPaths ?? []).map((p) => fs.realpathSync(p));
  const allowedRoots = [workdir, ...readonlyPaths];
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-run-"));
  let codeFile: string | undefined;

  try {
    // Deno splits permission lists on commas, so "/tmp/a,/etc" would also allow /etc.
    for (const v of [...allowedRoots, ...(opts.allowedDomains ?? [])]) {
      if (/[,\s]/.test(v)) throw new SandboxError(`Commas and spaces are not allowed in paths or domains: ${JSON.stringify(v)}`);
    }
    if ((opts.code === undefined) === (opts.entrypoint === undefined)) {
      throw new SandboxError("Specify exactly one of code or entrypoint.");
    }
    let entry: string;
    if (opts.code !== undefined) {
      // Write the code into the workdir so that relative imports resolve from there.
      codeFile = path.join(workdir, `.sandbox-${randomBytes(6).toString("hex")}.ts`);
      fs.writeFileSync(codeFile, opts.code);
      entry = codeFile;
    } else {
      entry = path.resolve(workdir, opts.entrypoint!);
    }

    let t0 = performance.now();
    checkSymlinks(allowedRoots);
    mark("symlinkScan", t0);

    // Phase A1: read the static module graph without fetching anything.
    t0 = performance.now();
    const graph = await denoJson(["info", "--json", "--no-config", "--no-npm", "--no-remote", entry], baseEnv(STORE_DIR), workdir);
    const npmSpecifiers = checkGraph(graph, allowedRoots, opts.allowedPackages?.map(parseAllowedPackage));
    mark("graphCheck", t0);

    // Phase A2: download npm packages into the shared store and pin them in a per-run lockfile.
    const lockPath = path.join(runDir, "deno.lock");
    let viewDir: string;
    if (npmSpecifiers.length > 0) {
      t0 = performance.now();
      const r = await run(DENO, ["cache", "--no-config", "--no-remote", `--lock=${lockPath}`, entry], {
        env: fetchEnv(STORE_DIR), cwd: workdir, timeoutMs: 120_000, maxOutputBytes: 64_000,
      });
      if (r.exitCode !== 0) throw new SandboxError(`Failed to fetch packages:\n${r.stderr}`);
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      checkLock(lock, opts.allowedPackages?.map(parseAllowedPackage));
      mark("fetchPackages", t0);
      t0 = performance.now();
      viewDir = buildView(Object.keys(lock.npm ?? {}));
      mark("buildView", t0);
    } else {
      fs.writeFileSync(lockPath, JSON.stringify({ version: "5" }));
      viewDir = buildView([]);
    }

    // Phase B: run the code. No registry access, no new packages, only the files and hosts allowed.
    t0 = performance.now();
    const args = [
      "run",
      "--no-config",
      "--no-remote",
      "--cached-only",
      `--lock=${lockPath}`,
      "--frozen",
      "--no-prompt",
      `--allow-read=${allowedRoots.join(",")}`,
      `--allow-write=${workdir}`,
      `--v8-flags=--max-old-space-size=${opts.memoryMb ?? 512}`,
    ];
    if (opts.allowedDomains?.length) args.push(`--allow-net=${opts.allowedDomains.join(",")}`);
    args.push(entry);
    const r = await run(DENO, args, {
      env: baseEnv(viewDir), cwd: workdir, timeoutMs: opts.timeoutMs ?? 30_000, maxOutputBytes: opts.maxOutputBytes ?? 20_000,
    });
    mark("run", t0);
    return {
      ...r,
      stderr: rewriteStderr(r.stderr, workdir, codeFile, opts.allowedDomains ?? []),
      stdout: r.stdout,
      durationMs: Math.round(performance.now() - started),
      phases,
    };
  } catch (e) {
    if (!(e instanceof SandboxError)) throw e;
    return {
      stdout: "", stderr: e.message, exitCode: 1, timedOut: false, truncated: false,
      durationMs: Math.round(performance.now() - started), phases,
    };
  } finally {
    if (codeFile) fs.rmSync(codeFile, { force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

// Symlinks are followed by Deno's permission checks. The sandboxed code cannot create
// symlinks (Deno.symlink needs unscoped read and write), but the host or the agent's other
// tools can. Reject any symlink that points outside the allowed roots.
function checkSymlinks(roots: string[]) {
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        let target: string;
        try { target = fs.realpathSync(p); } catch { continue; } // dangling
        if (!within(target, roots)) bad.push(p);
      } else if (ent.isDirectory()) {
        walk(p);
      }
    }
  };
  roots.forEach(walk);
  if (bad.length) throw new SandboxError(`Symbolic links pointing outside the allowed paths are not allowed:\n${bad.join("\n")}`);
}

function within(p: string, roots: string[]) {
  return roots.some((r) => p === r || p.startsWith(r + path.sep));
}

type DenoGraph = {
  modules: { specifier: string; local?: string; error?: string; dependencies?: { specifier: string; code?: { specifier: string }; type?: { specifier: string } }[] }[];
};

// Static imports are loaded by Deno without --allow-read checks, so every module in the
// static graph must be inside the allowed roots. npm imports must match the allowlist.
// Dynamic imports with computed specifiers are not in this graph; Deno's runtime
// permissions and the per-run package view cover them.
function checkGraph(graph: DenoGraph, roots: string[], allowed?: AllowedPackage[]): string[] {
  const errors: string[] = [];
  const npm = new Set<string>();
  const specifiers = new Set<string>();
  for (const m of graph.modules) {
    specifiers.add(m.specifier);
    for (const d of m.dependencies ?? []) {
      if (d.code) specifiers.add(d.code.specifier);
      if (d.type) specifiers.add(d.type.specifier);
    }
  }
  for (const s of specifiers) {
    const scheme = s.slice(0, s.indexOf(":") + 1);
    if (scheme === "file:") {
      let p = fileURLToPath(s);
      try { p = fs.realpathSync(p); } catch { /* missing file: Deno reports it later */ }
      if (!within(p, roots)) errors.push(`Import of a file outside the allowed paths: ${p}`);
    } else if (scheme === "npm:") {
      const { name, range } = parseNpmSpecifier(s);
      if (allowed && !allowed.some((a) => a.name === name)) {
        errors.push(`Package "${name}" is not allowed. Allowed packages: ${allowed.map((a) => `${a.name}@${a.range}`).join(", ") || "(none)"}`);
      }
      npm.add(`${name}@${range}`);
    } else if (scheme === "node:" || scheme === "data:") {
      // Built-in modules and inline modules are fine. A data: module's own imports are in the graph too.
    } else {
      errors.push(`Only npm: imports and relative files are supported. Not allowed: ${s}`);
    }
  }
  if (errors.length) throw new SandboxError([...new Set(errors)].join("\n"));
  return [...npm];
}

// After resolution, check the exact versions picked for the top-level specifiers.
// Dependencies of allowed packages are allowed automatically.
function checkLock(lock: { specifiers?: Record<string, string> }, allowed?: AllowedPackage[]) {
  if (!allowed) return;
  const errors: string[] = [];
  for (const [spec, version] of Object.entries(lock.specifiers ?? {})) {
    if (!spec.startsWith("npm:")) continue;
    const { name } = parseNpmSpecifier(spec);
    const v = version.split("_")[0];
    if (!isAllowed(name, v, allowed)) errors.push(`Package "${name}@${v}" is outside the allowed versions.`);
  }
  if (errors.length) throw new SandboxError(errors.join("\n"));
}

// A view is a DENO_DIR that contains only the packages pinned in the lockfile, hard-linked
// from the store. Phase B uses it so that packages cached by earlier runs cannot be loaded
// (Deno lets npm code and createRequire read anything inside DENO_DIR).
function buildView(packageKeys: string[]): string {
  const pkgs = [...new Set(packageKeys.map((k) => k.split("_")[0]))].sort();
  const hash = createHash("sha256").update(pkgs.join("\n")).digest("hex").slice(0, 16);
  const dir = path.join(VIEWS_DIR, hash);
  if (fs.existsSync(dir)) return dir;
  const tmp = `${dir}.tmp-${randomBytes(4).toString("hex")}`;
  for (const key of pkgs) {
    const at = key.lastIndexOf("@");
    const name = key.slice(0, at), version = key.slice(at + 1);
    const src = path.join(STORE_DIR, NPM_SUBDIR, name);
    const dst = path.join(tmp, NPM_SUBDIR, name);
    linkTree(path.join(src, version), path.join(dst, version));
    fs.copyFileSync(path.join(src, "registry.json"), path.join(dst, "registry.json"));
  }
  fs.mkdirSync(tmp, { recursive: true });
  try { fs.renameSync(tmp, dir); } catch { fs.rmSync(tmp, { recursive: true, force: true }); }
  return dir;
}

function linkTree(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) linkTree(s, d);
    else if (ent.isFile()) {
      try { fs.linkSync(s, d); } catch { fs.copyFileSync(s, d); }
    }
  }
}

// Deno's hints ("run again with the --allow-net flag") mislead the LLM, which cannot pass flags.
function rewriteStderr(stderr: string, workdir: string, codeFile: string | undefined, domains: string[]): string {
  let s = stderr;
  if (codeFile) {
    s = s.split(`file://${codeFile}`).join("<code>").split(codeFile).join("<code>");
  }
  s = s.split(`file://${workdir}/`).join("./");
  // Stack frames inside Deno's own code do not help the LLM fix its code.
  s = s.split("\n").filter((l) => !/^\s+at .*\(?ext:[\w/]+\.js:\d+:\d+\)?$/.test(l)).join("\n");
  s = s.replace(/Requires (net) access to "([^"]+)", run again with the --allow-net flag/g,
    `Network access to "$2" is not allowed in the sandbox. Allowed hosts: ${domains.join(", ") || "(none)"}`);
  s = s.replace(/Requires (read|write) access to "([^"]+)", run again with the --allow-\w+ flag/g,
    (_m, kind, p) => `${kind === "read" ? "Reading" : "Writing"} "${p}" is not allowed in the sandbox. ${kind === "read" ? "Only the working directory and read-only paths can be read." : "Only the working directory can be written."}`);
  s = s.replace(/Requires (\w+) access(?: to "([^"]+)")?, run again with the --allow-\w+ flag/g,
    (_m, kind) => `${kind} access is not available in the sandbox.`);
  return s;
}

type RunResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean };

// Spawns a process, kills it on timeout, and keeps at most maxOutputBytes per stream
// (the head and the tail, since errors usually come last).
function run(cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; maxOutputBytes: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: o.env, cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out = new Capture(o.maxOutputBytes), err = new Capture(o.maxOutputBytes);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, o.timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      let stderr = err.text();
      if (timedOut) stderr += `\n[sandbox] Killed: the code ran longer than ${o.timeoutMs} ms.`;
      resolve({ stdout: out.text(), stderr, exitCode: timedOut ? null : code, timedOut, truncated: out.truncated || err.truncated });
    });
  });
}

class Capture {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail = Buffer.alloc(0);
  private dropped = 0;
  private max: number;
  constructor(max: number) { this.max = max; }
  get truncated() { return this.dropped > 0; }
  push(c: Buffer) {
    const half = Math.floor(this.max / 2);
    if (this.headLen < half) {
      const take = c.subarray(0, half - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      c = c.subarray(take.length);
    }
    if (c.length === 0) return;
    const merged = Buffer.concat([this.tail, c]);
    const keep = this.max - half;
    if (merged.length > keep) this.dropped += merged.length - keep;
    this.tail = merged.subarray(Math.max(0, merged.length - keep));
  }
  text() {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = this.tail.toString("utf8");
    if (!this.dropped) return head + tail;
    return `${head}\n[sandbox] ... ${this.dropped} bytes omitted. Write large output to a file instead. ...\n${tail}`;
  }
}

function findOnPath(cmd: string): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, cmd);
    if (fs.existsSync(p)) return p;
  }
  return cmd;
}

async function denoJson(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<any> {
  const r = await run(DENO, args, { env, cwd, timeoutMs: 30_000, maxOutputBytes: 50_000_000 });
  if (r.exitCode !== 0) throw new SandboxError(r.stderr);
  return JSON.parse(r.stdout);
}
