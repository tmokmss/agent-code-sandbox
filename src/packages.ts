// Package allowlist parsing and matching.
// An entry is "name" or "name@range". Supported ranges: "*", "5", "5.7", "5.7.0",
// "^5.1.0", "~5.1.0". Prerelease versions never match.

import { SandboxConfigError } from "./errors.ts";

export type AllowedPackage = { name: string; range: string };

const NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const RANGE = /^(\*|[\^~]?\d+(\.\d+(\.\d+)?)?)$/;

export function parseAllowedPackage(entry: string): AllowedPackage {
  const at = entry.lastIndexOf("@");
  const [name, range] = at > 0 ? [entry.slice(0, at), entry.slice(at + 1)] : [entry, "*"];
  if (!NAME.test(name)) {
    throw new SandboxConfigError(`Invalid package name in allowedPackages: ${JSON.stringify(entry)}`);
  }
  if (!RANGE.test(range)) {
    throw new SandboxConfigError(
      `Invalid version range in allowedPackages: ${JSON.stringify(entry)}. ` +
        `Use "*", "5", "5.7", "5.7.0", "^5.1.0", or "~5.1.0".`,
    );
  }
  return { name, range };
}

export function formatAllowedPackage(p: AllowedPackage): string {
  return p.range === "*" ? p.name : `${p.name}@${p.range}`;
}

// Parses "npm:name@range/sub/path" into name and range.
export function parseNpmSpecifier(specifier: string): { name: string; range: string } {
  let rest = specifier.replace(/^npm:\/?/, "");
  let name: string;
  if (rest.startsWith("@")) {
    const parts = rest.split("/");
    name = `${parts[0]}/${(parts[1] ?? "").split("@")[0]}`;
    rest = rest.slice(parts[0].length + 1);
  } else {
    name = rest.split(/[@/]/)[0];
  }
  const m = rest.match(/^[^@/]+@([^/]+)/);
  return { name, range: m ? m[1] : "*" };
}

function parseVersion(v: string): number[] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  if (range === "*") return true;
  const op = range[0] === "^" || range[0] === "~" ? range[0] : "";
  const parts = range.slice(op.length).split(".").map(Number);
  const lower = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  if (cmp(v, lower) < 0) return false;
  if (op === "^") {
    // Same as npm: the left-most non-zero part must not change.
    const i = lower[0] !== 0 || parts.length === 1 ? 0 : lower[1] !== 0 || parts.length === 2 ? 1 : 2;
    return v.slice(0, i + 1).every((n, k) => n === lower[k]);
  }
  if (op === "~") return v[0] === lower[0] && (parts.length < 2 || v[1] === lower[1]);
  // Partial version: "5" or "5.7" means the same prefix. A full version means exactly that version.
  return parts.every((p, k) => v[k] === p);
}

export function isAllowed(name: string, version: string, allowed: AllowedPackage[]): boolean {
  return allowed.some((a) => a.name === name && satisfies(version, a.range));
}
