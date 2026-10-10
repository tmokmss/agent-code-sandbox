import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let root: string | undefined;

// Where the Deno binary, the package store, and the package views live.
// Set AGENT_CODE_SANDBOX_CACHE_DIR to change it. If the home directory is not writable
// (for example, AgentCore Runtime with direct code deployment), fall back to the temp directory.
export function cacheRoot(): string {
  if (root) return root;
  const configured = process.env.AGENT_CODE_SANDBOX_CACHE_DIR;
  if (configured) {
    fs.mkdirSync(configured, { recursive: true });
    return (root = fs.realpathSync(configured));
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  for (const dir of [path.join(base, "agent-code-sandbox"), path.join(os.tmpdir(), `agent-code-sandbox-${os.userInfo().uid}`)]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return (root = fs.realpathSync(dir));
    } catch {
      // Try the next one.
    }
  }
  throw new Error("No writable cache directory. Set AGENT_CODE_SANDBOX_CACHE_DIR.");
}
