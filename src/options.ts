import * as fs from "node:fs";
import * as path from "node:path";
import { SandboxConfigError } from "./errors.ts";
import { parseAllowedPackage, type AllowedPackage } from "./packages.ts";

type CommonOptions = {
  /** Directories the code can read but not write. */
  readOnlyDirs?: string[];
  /**
   * npm packages the code may import, as "name" or "name@range". Dependencies of allowed
   * packages are allowed automatically. Omit to allow any package; [] allows none.
   */
  allowedPackages?: string[];
  /** Hosts the code may connect to: "api.example.com", "api.example.com:443", "*.example.com", or an IP. Default: none. */
  allowedDomains?: string[];
  /** Environment variables the code can read. Only these names are visible. */
  env?: Record<string, string>;
  /** Time limit for running the code. Package downloads are not counted. Default: no limit. */
  timeoutMs?: number;
  /** Limit of the JS heap in MB. Default: V8's default. */
  memoryMb?: number;
  /** Bytes kept per stream (stdout and stderr). The middle is dropped beyond this. Default: 1 MB. */
  maxOutputBytes?: number;
  /** Stops the run when aborted. */
  signal?: AbortSignal;
};

/**
 * Options of exec(). Specify exactly one of `code` and `entrypoint`.
 * `workDir` is optional with `code` (a temporary directory is used) and required with `entrypoint`.
 */
export type ExecOptions =
  | (CommonOptions & { code: string; workDir?: string; entrypoint?: never })
  | (CommonOptions & { entrypoint: string; workDir: string; code?: never });

export type ExecResult = {
  stdout: string;
  /** Standard error, rewritten so that the LLM can fix its code. */
  stderr: string;
  /** 1 when rejected before running. null when stopped (timeout or abort). */
  exitCode: number | null;
  /** true when stopped by the timeout or the signal. */
  timedOut: boolean;
  /** true when stdout or stderr was truncated. */
  truncated: boolean;
  /** Time from the call of exec() to its return. */
  durationMs: number;
};

export type NormalizedOptions = {
  code?: string;
  entrypoint?: string;
  /** Real path. undefined when a temporary directory should be created. */
  workDir?: string;
  /** Real paths. */
  readOnlyDirs: string[];
  /**
   * The directories as the developer wrote them, when they differ from the real paths (for
   * example /var/... on macOS, which is /private/var/...). Deno checks permissions on the path
   * the code uses without resolving symlinks, so both spellings are allowed.
   */
  readAliases: string[];
  writeAliases: string[];
  allowedPackages?: AllowedPackage[];
  allowedDomains: string[];
  env: Record<string, string>;
  timeoutMs?: number;
  memoryMb?: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
};

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

// Names that would silently break other guarantees. See "予約された環境変数" in docs/design.md.
const RESERVED_PROXY_NAMES = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);

function reservedEnvReason(name: string): string | undefined {
  const upper = name.toUpperCase();
  if (upper.startsWith("DENO_")) return "it changes how the sandbox runtime works (for example, which packages can be loaded)";
  if (upper.startsWith("LD_") || upper.startsWith("DYLD_")) return "it can load arbitrary libraries into the sandbox runtime";
  if (RESERVED_PROXY_NAMES.has(upper)) return "it is reserved for the network controls of the sandbox";
  return undefined;
}

// Deno splits permission lists on commas, so "/tmp/a,/etc" would also allow /etc.
function checkListItem(kind: string, value: string): void {
  if (value === "" || /[,\s]/.test(value)) {
    throw new SandboxConfigError(`${kind} must not be empty or contain commas or whitespace: ${JSON.stringify(value)}`);
  }
}

function directory(kind: string, p: unknown, aliases: string[]): string {
  if (typeof p !== "string" || p === "") throw new SandboxConfigError(`${kind} must be a non-empty string.`);
  let real: string;
  try {
    real = fs.realpathSync(p);
  } catch {
    throw new SandboxConfigError(`${kind} does not exist: ${p}`);
  }
  if (!fs.statSync(real).isDirectory()) throw new SandboxConfigError(`${kind} is not a directory: ${p}`);
  checkListItem(kind, real);
  const given = path.resolve(p);
  if (given !== real) {
    checkListItem(kind, given);
    aliases.push(given);
  }
  return real;
}

function positive(kind: string, v: unknown, integer: boolean): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) {
    throw new SandboxConfigError(`${kind} must be a positive ${integer ? "integer" : "number"}.`);
  }
  return v;
}

export function normalizeOptions(options: ExecOptions): NormalizedOptions {
  if (typeof options !== "object" || options === null) throw new SandboxConfigError("Options must be an object.");
  const o = options as CommonOptions & { code?: unknown; entrypoint?: unknown; workDir?: unknown };

  if ((o.code === undefined) === (o.entrypoint === undefined)) {
    throw new SandboxConfigError("Specify exactly one of code and entrypoint.");
  }
  if (o.code !== undefined && typeof o.code !== "string") throw new SandboxConfigError("code must be a string.");
  if (o.entrypoint !== undefined) {
    if (typeof o.entrypoint !== "string" || o.entrypoint === "") throw new SandboxConfigError("entrypoint must be a non-empty string.");
    if (o.workDir === undefined) throw new SandboxConfigError("workDir is required with entrypoint.");
  }

  const writeAliases: string[] = [];
  const readOnlyAliases: string[] = [];
  const workDir = o.workDir === undefined ? undefined : directory("workDir", o.workDir, writeAliases);
  const readOnlyDirs = (o.readOnlyDirs ?? []).map((d) => directory("readOnlyDirs", d, readOnlyAliases));

  const allowedDomains = [...(o.allowedDomains ?? [])];
  for (const d of allowedDomains) {
    if (typeof d !== "string") throw new SandboxConfigError("allowedDomains must be strings.");
    checkListItem("allowedDomains", d);
  }

  const allowedPackages = o.allowedPackages?.map((p) => {
    if (typeof p !== "string") throw new SandboxConfigError("allowedPackages must be strings.");
    return parseAllowedPackage(p);
  });

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(o.env ?? {})) {
    if (value === undefined) continue; // Allows { ...process.env } as written in the docs.
    if (name === "" || /[=,\s\0]/.test(name)) {
      throw new SandboxConfigError(`Invalid environment variable name: ${JSON.stringify(name)}`);
    }
    const reason = reservedEnvReason(name);
    if (reason) throw new SandboxConfigError(`env must not set ${name}: ${reason}.`);
    if (typeof value !== "string" || value.includes("\0")) {
      throw new SandboxConfigError(`The value of env.${name} must be a string without NUL characters.`);
    }
    env[name] = value;
  }

  return {
    code: o.code as string | undefined,
    entrypoint: o.entrypoint as string | undefined,
    workDir,
    readOnlyDirs,
    readAliases: [...writeAliases, ...readOnlyAliases],
    writeAliases,
    allowedPackages,
    allowedDomains,
    env,
    timeoutMs: positive("timeoutMs", o.timeoutMs, false),
    memoryMb: positive("memoryMb", o.memoryMb, true),
    maxOutputBytes: positive("maxOutputBytes", o.maxOutputBytes, true) ?? DEFAULT_MAX_OUTPUT_BYTES,
    signal: o.signal,
  };
}

export function within(p: string, roots: string[]): boolean {
  return roots.some((r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}
