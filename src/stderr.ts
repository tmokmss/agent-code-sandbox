// Rewrites Deno's stderr so that the LLM can act on it. Deno's hints ("run again with the
// --allow-net flag") mislead the LLM, which cannot pass flags, and temporary paths are noise.

export type RewriteContext = {
  workDir: string;
  codeFile?: string;
  allowedDomains: string[];
  envNames: string[];
};

const list = (items: string[]) => items.join(", ") || "(none)";

export function rewriteStderr(stderr: string, c: RewriteContext): string {
  let s = stderr;
  if (c.codeFile) {
    s = s.split(`file://${c.codeFile}`).join("<code>").split(c.codeFile).join("<code>");
  }
  s = s.split(`file://${c.workDir}/`).join("./");
  // Stack frames inside Deno's own code do not help the LLM fix its code.
  s = s.split("\n").filter((l) => !/^\s+at .*\(?ext:[\w/.-]+\.[jt]s:\d+:\d+\)?$/.test(l)).join("\n");
  s = s.replace(/Requires net access to "([^"]+)", run again with the --allow-net flag/g,
    (_m, host) => `Network access to "${host}" is not allowed in the sandbox. Allowed hosts: ${list(c.allowedDomains)}`);
  s = s.replace(/Requires read access to "([^"]+)", run again with the --allow-read flag/g,
    (_m, p) => `Reading "${p}" is not allowed in the sandbox. Only the working directory and the read-only directories can be read.`);
  s = s.replace(/Requires write access to "([^"]+)", run again with the --allow-write flag/g,
    (_m, p) => `Writing "${p}" is not allowed in the sandbox. Only the working directory can be written.`);
  s = s.replace(/Requires env access to "([^"]+)", run again with the --allow-env flag/g,
    (_m, name) => `Environment variable "${name}" is not available in the sandbox. Available: ${list(c.envNames)}`);
  s = s.replace(/Requires (\w+) access(?: to "[^"]+")?, run again with the --allow-[\w-]+ flag/g,
    (_m, kind) => `${kind} access is not available in the sandbox.`);
  return s;
}
