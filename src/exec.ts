// exec(): runs LLM-generated JS/TS in a Deno child process.
// See docs/design.md for the reasons behind each step.

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheRoot } from "./cache.ts";
import { getDeno } from "./deno.ts";
import { RejectedError, SandboxConfigError, SandboxError } from "./errors.ts";
import { normalizeOptions, within, type ExecOptions, type ExecResult } from "./options.ts";
import { formatAllowedPackage, isAllowed, parseNpmSpecifier, type AllowedPackage } from "./packages.ts";
import { run, type RunResult } from "./process.ts";
import { rewriteStderr } from "./stderr.ts";

const NPM_SUBDIR = path.join("npm", "registry.npmjs.org");
// Phase A (inspecting and fetching) does not run the user's code, but bound it anyway.
const INFO_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 300_000;
const ABORTED_MESSAGE = "[sandbox] Stopped: the run was aborted.";

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

// Phase A2 needs to reach the npm registry, possibly through the host's proxy.
function fetchEnv(denoDir: string): NodeJS.ProcessEnv {
  const env = baseEnv(denoDir);
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "DENO_CERT", "NPM_CONFIG_REGISTRY"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

/**
 * Runs JavaScript or TypeScript code in a sandbox.
 *
 * Problems the LLM can fix (exceptions, syntax errors, denied permissions, packages that are
 * not allowed, timeouts) come back as a result. Problems the developer has to fix throw
 * SandboxConfigError (invalid options) or SandboxError (the environment).
 */
export async function exec(options: ExecOptions): Promise<ExecResult> {
  const started = performance.now();
  const o = normalizeOptions(options);
  const finish = (r: Omit<ExecResult, "durationMs">): ExecResult => ({
    ...r,
    durationMs: Math.round(performance.now() - started),
  });
  if (o.signal?.aborted) {
    return finish({ stdout: "", stderr: ABORTED_MESSAGE, exitCode: null, timedOut: true, truncated: false });
  }

  const deno = await getDeno();
  const root = cacheRoot();
  const storeDir = path.join(root, "store"); // DENO_DIR for phase A only
  const viewsDir = path.join(root, "views"); // DENO_DIR per set of packages, for phase B

  const tempWorkDir = o.workDir === undefined ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acs-work-"))) : undefined;
  const workDir = o.workDir ?? tempWorkDir!;
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-run-"));
  let codeFile: string | undefined;
  const rewrite = (stderr: string) =>
    rewriteStderr(stderr, { workDir, codeFile, allowedDomains: o.allowedDomains, envNames: Object.keys(o.env) });

  try {
    const roots = [workDir, ...o.readOnlyDirs];
    checkSymlinks(roots);

    let entry: string;
    if (o.code !== undefined) {
      // Write the code into the workDir so that relative imports resolve from there, and so
      // that phases A and B see the same module graph.
      codeFile = path.join(workDir, `.sandbox-${randomBytes(6).toString("hex")}.ts`);
      fs.writeFileSync(codeFile, o.code);
      entry = codeFile;
    } else {
      entry = path.resolve(workDir, o.entrypoint!);
      let real = entry;
      try {
        real = fs.realpathSync(entry);
      } catch {
        // A missing file is reported by Deno below.
      }
      if (!within(real, [workDir])) throw new RejectedError(`The entrypoint is outside the working directory: ${o.entrypoint}`);
    }

    // Phase A1: read the static module graph without fetching anything.
    const info = await run(deno, ["info", "--json", "--no-config", "--no-npm", "--no-remote", entry], {
      env: baseEnv(storeDir), cwd: workDir, timeoutMs: INFO_TIMEOUT_MS, maxOutputBytes: 64 * 1024 * 1024, signal: o.signal,
    });
    if (info.aborted) return finish(stopped(ABORTED_MESSAGE));
    if (info.exitCode !== 0) {
      if (info.timedOut) throw new SandboxError("Inspecting the module graph timed out.");
      throw new RejectedError(info.stderr.trim());
    }
    const npmSpecifiers = checkGraph(JSON.parse(info.stdout), roots, o.allowedPackages);

    // Phase A2: download npm packages into the shared store and pin them in a per-run lockfile.
    const lockPath = path.join(runDir, "deno.lock");
    let viewDir: string;
    if (npmSpecifiers.length > 0) {
      const r = await run(deno, ["cache", "--no-config", "--no-remote", `--lock=${lockPath}`, entry], {
        env: fetchEnv(storeDir), cwd: workDir, timeoutMs: FETCH_TIMEOUT_MS, maxOutputBytes: 64 * 1024, signal: o.signal,
      });
      if (r.aborted) return finish(stopped(ABORTED_MESSAGE));
      if (r.exitCode !== 0) handleFetchFailure(r);
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      checkLock(lock, o.allowedPackages);
      viewDir = buildView(Object.keys(lock.npm ?? {}), storeDir, viewsDir);
    } else {
      fs.writeFileSync(lockPath, JSON.stringify({ version: "5" }));
      viewDir = buildView([], storeDir, viewsDir);
    }

    // Phase B: run the code. No registry access, no new packages, only the files and hosts allowed.
    const args = [
      "run",
      "--no-config",
      "--no-remote",
      "--cached-only",
      `--lock=${lockPath}`,
      "--frozen",
      "--no-prompt",
      `--allow-read=${roots.join(",")}`,
      `--allow-write=${workDir}`,
    ];
    if (o.allowedDomains.length) args.push(`--allow-net=${o.allowedDomains.join(",")}`);
    const envNames = Object.keys(o.env);
    if (envNames.length) args.push(`--allow-env=${envNames.join(",")}`);
    // Other names read as undefined, as in Node, instead of throwing. Code like
    // `process.env.X ?? "default"` and JSON.stringify(process.env) keep working.
    args.push("--ignore-env");
    if (o.memoryMb !== undefined) args.push(`--v8-flags=--max-old-space-size=${o.memoryMb}`);
    args.push(entry);
    const r = await run(deno, args, {
      env: { ...baseEnv(viewDir), ...o.env }, cwd: workDir, timeoutMs: o.timeoutMs, maxOutputBytes: o.maxOutputBytes, signal: o.signal,
    });
    let stderr = rewrite(r.stderr);
    const note = r.timedOut ? `[sandbox] Killed: the code ran longer than ${o.timeoutMs} ms.` : r.aborted ? ABORTED_MESSAGE : "";
    if (note) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${note}`;
    return finish({
      stdout: r.stdout,
      stderr,
      exitCode: r.exitCode,
      timedOut: r.timedOut || r.aborted,
      truncated: r.truncated,
    });
  } catch (e) {
    if (!(e instanceof RejectedError)) throw e;
    return finish({ stdout: "", stderr: rewrite(e.message), exitCode: 1, timedOut: false, truncated: false });
  } finally {
    if (codeFile) fs.rmSync(codeFile, { force: true });
    if (tempWorkDir) fs.rmSync(tempWorkDir, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

function stopped(message: string): Omit<ExecResult, "durationMs"> {
  return { stdout: "", stderr: message, exitCode: null, timedOut: true, truncated: false };
}

// A package or version that does not exist is the LLM's mistake. Anything else (the registry
// cannot be reached, a timeout) is a problem of the environment.
function handleFetchFailure(r: RunResult): never {
  // Drop the "Download https://registry.npmjs.org/..." progress lines.
  const msg = r.stderr.split("\n").filter((l) => !/^Download /.test(l)).join("\n").trim();
  if (!r.timedOut && /does not exist|not found|could not find|no matching version|404/i.test(msg)) {
    throw new RejectedError(msg);
  }
  throw new SandboxError(`Failed to fetch npm packages${r.timedOut ? " (timed out)" : ""}:\n${msg}`);
}

// Symlinks are followed by Deno's permission checks. The sandboxed code cannot create
// symlinks (Deno.symlink needs unscoped read and write), but the host or the agent's other
// tools can. Reject any symlink that points outside the allowed directories.
function checkSymlinks(roots: string[]): void {
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.realpathSync(p);
        } catch {
          continue; // Dangling: nothing to read through it.
        }
        if (!within(target, roots)) bad.push(p);
      } else if (ent.isDirectory()) {
        walk(p);
      }
    }
  };
  roots.forEach(walk);
  if (bad.length) {
    throw new SandboxConfigError(`Symbolic links pointing outside the allowed directories are not allowed:\n${bad.join("\n")}`);
  }
}

type DenoGraph = {
  modules?: {
    specifier: string;
    dependencies?: { specifier: string; code?: { specifier: string }; type?: { specifier: string } }[];
  }[];
};

// Static imports are loaded by Deno without --allow-read checks, so every module in the
// static graph must be inside the allowed directories. npm imports must match the allowlist.
// Dynamic imports with computed specifiers are not in this graph; Deno's runtime
// permissions and the per-run package view cover them.
function checkGraph(graph: DenoGraph, roots: string[], allowed?: AllowedPackage[]): string[] {
  const errors: string[] = [];
  const npm = new Set<string>();
  const specifiers = new Set<string>();
  for (const m of graph.modules ?? []) {
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
      try {
        p = fs.realpathSync(p);
      } catch {
        // A missing file: Deno reports it when running.
      }
      if (!within(p, roots)) errors.push(`Import of a file outside the allowed directories: ${p}`);
    } else if (scheme === "npm:") {
      const { name, range } = parseNpmSpecifier(s);
      if (allowed && !allowed.some((a) => a.name === name)) {
        errors.push(`Package "${name}" is not allowed. Allowed packages: ${allowed.map(formatAllowedPackage).join(", ") || "(none)"}`);
      }
      npm.add(`${name}@${range}`);
    } else if (scheme === "node:" || scheme === "data:") {
      // Built-in modules and inline modules are fine. A data: module's own imports are in the graph too.
    } else {
      errors.push(`Only npm: imports, node: built-ins, and files in the working directory can be imported. Not allowed: ${s}`);
    }
  }
  if (errors.length) throw new RejectedError([...new Set(errors)].join("\n"));
  return [...npm];
}

// After resolution, check the exact versions picked for the specifiers in the code.
// Dependencies of allowed packages are allowed automatically.
function checkLock(lock: { specifiers?: Record<string, string> }, allowed?: AllowedPackage[]): void {
  if (!allowed) return;
  const errors: string[] = [];
  for (const [spec, version] of Object.entries(lock.specifiers ?? {})) {
    if (!spec.startsWith("npm:")) continue;
    const { name } = parseNpmSpecifier(spec);
    const v = version.split("_")[0];
    if (!isAllowed(name, v, allowed)) {
      const ranges = allowed.filter((a) => a.name === name).map(formatAllowedPackage).join(", ");
      errors.push(`Package "${name}@${v}" is outside the allowed versions. Allowed: ${ranges || "(none)"}`);
    }
  }
  if (errors.length) throw new RejectedError(errors.join("\n"));
}

// A view is a DENO_DIR that contains only the packages pinned in the lockfile, hard-linked
// from the store. Phase B uses it so that packages cached by earlier runs cannot be loaded
// (Deno lets npm code and createRequire read anything inside DENO_DIR).
function buildView(packageKeys: string[], storeDir: string, viewsDir: string): string {
  const pkgs = [...new Set(packageKeys.map((k) => k.split("_")[0]))].sort();
  const hash = createHash("sha256").update(pkgs.join("\n")).digest("hex").slice(0, 16);
  const dir = path.join(viewsDir, hash);
  if (fs.existsSync(dir)) return dir;
  // Build in a temp directory and rename, so that concurrent runs never see a partial view.
  const tmp = `${dir}.tmp-${randomBytes(4).toString("hex")}`;
  try {
    for (const key of pkgs) {
      const at = key.lastIndexOf("@");
      const name = key.slice(0, at);
      const version = key.slice(at + 1);
      const src = path.join(storeDir, NPM_SUBDIR, name);
      const dst = path.join(tmp, NPM_SUBDIR, name);
      linkTree(path.join(src, version), path.join(dst, version));
      fs.copyFileSync(path.join(src, "registry.json"), path.join(dst, "registry.json"));
    }
    fs.mkdirSync(tmp, { recursive: true });
    fs.renameSync(tmp, dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    // Another run created the same view first.
    if (!fs.existsSync(dir)) throw e;
  }
  return dir;
}

function linkTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) linkTree(s, d);
    else if (ent.isFile()) {
      try {
        fs.linkSync(s, d);
      } catch {
        fs.copyFileSync(s, d);
      }
    }
  }
}
