// Package allowlist matching.
// An entry is "name" or "name@range". Ranges supported in the PoC:
// "*", "5", "5.7", "5.7.0", "^5.1.0", "~5.1.0". Prerelease versions never match.

export type AllowedPackage = { name: string; range: string };

export function parseAllowedPackage(entry: string): AllowedPackage {
  const at = entry.lastIndexOf("@");
  if (at <= 0) return { name: entry, range: "*" };
  return { name: entry.slice(0, at), range: entry.slice(at + 1) || "*" };
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
  range = range.trim();
  if (range === "*" || range === "" || range === "latest") return true;
  const op = range[0] === "^" || range[0] === "~" ? range[0] : "";
  const parts = range.slice(op.length).split(".").filter((p) => p !== "x" && p !== "*").map(Number);
  if (parts.some((p) => Number.isNaN(p))) return false;
  const lower = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  if (cmp(v, lower) < 0) return false;
  if (op === "^") {
    const i = lower[0] !== 0 ? 0 : lower[1] !== 0 ? 1 : 2;
    return v.slice(0, i + 1).every((n, k) => n === lower[k]);
  }
  if (op === "~") return v[0] === lower[0] && (parts.length < 2 || v[1] === lower[1]);
  // Partial version: "5" or "5.7" means same prefix. Full version means exact.
  return parts.every((p, k) => v[k] === p);
}

export function isAllowed(name: string, version: string, allowed: AllowedPackage[]): boolean {
  return allowed.some((a) => a.name === name && satisfies(version, a.range));
}
