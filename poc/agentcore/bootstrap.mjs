// Entry point for AgentCore Runtime direct code deployment (NODE_22).
// The zip may not keep the executable bit and the code directory may be read-only,
// so copy the bundled Deno binary to /tmp before loading the server.
import * as fs from "node:fs";
import * as path from "node:path";

const here = import.meta.dirname;
const deno = "/tmp/acs-bin/deno";
if (!fs.existsSync(deno)) {
  fs.mkdirSync(path.dirname(deno), { recursive: true });
  fs.copyFileSync(path.join(here, "bin", "deno"), deno);
  fs.chmodSync(deno, 0o755);
}
process.env.SANDBOX_DENO_PATH ??= deno;
process.env.SANDBOX_CACHE_DIR ??= "/tmp/acs-cache";
process.env.SANDBOX_SELFTEST_FILE ??= path.join(here, "sandbox.test.mjs");
await import("./server.mjs");
