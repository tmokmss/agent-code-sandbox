// HTTP server for AgentCore Runtime (POST /invocations, GET /ping on port 8080).
// Payload:
//   {"action": "selftest"}  runs the test suite inside the runtime and returns the TAP summary
//   {"action": "probe"}     shows what the host process can see vs. what the sandboxed code can see
//   {"code": "...", ...}    runs exec() with the given options (workdir is created per request)
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { exec, type ExecOptions } from "../src/exec.ts";

const root = path.resolve(import.meta.dirname, "..");

async function selftest() {
  return await new Promise<{ exitCode: number | null; summary: string; failures: string }>((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", process.env.SANDBOX_SELFTEST_FILE ?? "test/sandbox.test.ts"], { cwd: root, env: process.env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => {
      const lines = out.split("\n");
      resolve({
        exitCode: code,
        summary: lines.filter((l) => /^\s*(ok|not ok) |^# (tests|pass|fail)/.test(l)).join("\n"),
        failures: lines.filter((l) => /not ok|error:|expected|actual/.test(l)).join("\n"),
      });
    });
  });
}

async function probe() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-probe-"));
  const host = {
    awsEnvNames: Object.keys(process.env).filter((k) => k.startsWith("AWS_")),
    uid: process.getuid?.(),
    kernel: os.release(),
    arch: os.arch(),
    imds: await fetch("http://169.254.169.254/latest/meta-data/", { signal: AbortSignal.timeout(2000) }).then((r) => r.status, (e) => String(e.cause ?? e)),
  };
  const sandbox: Record<string, unknown> = {};
  const cases: Record<string, string> = {
    env: "console.log(JSON.stringify(Deno.env.toObject()))",
    procEnviron: 'console.log(await Deno.readTextFile("/proc/self/environ"))',
    imds: 'console.log((await fetch("http://169.254.169.254/latest/meta-data/")).status)',
    containerCreds: 'console.log((await fetch("http://169.254.170.2/")).status)',
    etcPasswd: 'console.log(await Deno.readTextFile("/etc/passwd"))',
    subprocess: 'console.log(new TextDecoder().decode((await new Deno.Command("id").output()).stdout))',
  };
  for (const [k, code] of Object.entries(cases)) {
    const r = await exec({ code, workdir, timeoutMs: 10_000 });
    sandbox[k] = { exitCode: r.exitCode, stdout: r.stdout.slice(0, 200), stderr: r.stderr.split("\n")[0]?.slice(0, 200) };
  }
  return { host, sandbox };
}

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/ping") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "Healthy" }));
  }
  if (req.method === "POST" && req.url?.startsWith("/invocations")) {
    let body = "";
    for await (const c of req) body += c;
    try {
      const p = JSON.parse(body || "{}");
      let result: unknown;
      if (p.action === "selftest") result = await selftest();
      else if (p.action === "probe") result = await probe();
      else {
        const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-req-"));
        result = await exec({ ...(p as ExecOptions), workdir });
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  res.writeHead(404).end();
}).listen(8080, "0.0.0.0", () => console.log("listening on 8080"));
