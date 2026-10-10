// Attack and behavior tests for exec(). Run: npm test
// Needs access to registry.npmjs.org, and to GitHub when Deno is not on PATH (it is downloaded).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

process.env.AGENT_CODE_SANDBOX_CACHE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "acs-cache-"));
const { exec, SandboxConfigError } = await import("../src/index.ts");

function newWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acs-wd-"));
}

const outside = fs.mkdtempSync(path.join(os.tmpdir(), "acs-outside-"));
fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET");
fs.writeFileSync(path.join(outside, "secret.js"), 'export default "TOP-SECRET-JS";');

let servers: http.Server[] = [];
before(async () => {
  const a = http.createServer((req, res) => {
    if (req.url?.startsWith("/redirect")) {
      res.writeHead(302, { location: "http://127.0.0.1:18091/stolen" });
      res.end();
    } else res.end("hello from allowed host");
  });
  const b = http.createServer((_req, res) => res.end("REACHED-FORBIDDEN-HOST"));
  await new Promise<void>((r) => a.listen(18090, "127.0.0.1", r));
  await new Promise<void>((r) => b.listen(18091, "127.0.0.1", r));
  servers = [a, b];
});
after(() => servers.forEach((s) => s.close()));

describe("basic execution", () => {
  test("returns stdout and exit code", async () => {
    const r = await exec({ code: 'console.log("hi", 1 + 2)', workDir: newWorkDir() });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "hi 3\n");
    assert.equal(r.timedOut, false);
    assert.equal(r.truncated, false);
    assert.ok(r.durationMs >= 0);
  });

  test("works without a workDir and leaves nothing behind", async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()));
    const r = await exec({ code: 'await Deno.writeTextFile("a.txt", "x"); console.log(Deno.cwd())' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(fs.existsSync(r.stdout.trim()), false);
    const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => !before.has(f) && /^acs-(work|run)-/.test(f));
    assert.deepEqual(leftovers, []);
  });

  test("runs an entrypoint and relative imports, and keeps files between runs", async () => {
    const wd = newWorkDir();
    fs.writeFileSync(path.join(wd, "lib.ts"), "export const add = (a: number, b: number) => a + b;");
    fs.writeFileSync(path.join(wd, "main.ts"), 'import { add } from "./lib.ts"; await Deno.writeTextFile("out.txt", String(add(2, 3)));');
    assert.equal((await exec({ entrypoint: "main.ts", workDir: wd })).exitCode, 0);
    const r = await exec({ code: 'console.log(await Deno.readTextFile("out.txt"))', workDir: wd });
    assert.equal(r.stdout, "5\n");
    assert.deepEqual(fs.readdirSync(wd).sort(), ["lib.ts", "main.ts", "out.txt"]); // temp code file removed
  });

  test("an entrypoint outside the workDir is rejected", async () => {
    const r = await exec({ entrypoint: path.join(outside, "secret.js"), workDir: newWorkDir() });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /outside the working directory/);
  });

  test("reports the line of an uncaught error", async () => {
    const r = await exec({ code: 'const a = 1;\nthrow new Error("boom");', workDir: newWorkDir() });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /boom/);
    assert.match(r.stderr, /<code>:2/);
  });

  test("reports a syntax error", async () => {
    const r = await exec({ code: "const = 1;", workDir: newWorkDir() });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /Expected|Unexpected/);
  });
});

describe("options", () => {
  test("invalid options throw SandboxConfigError", async () => {
    const wd = newWorkDir();
    const bad: unknown[] = [
      {},
      { code: "1", entrypoint: "main.ts", workDir: wd },
      { entrypoint: "main.ts" },
      { code: "1", workDir: path.join(wd, "missing") },
      { code: "1", workDir: path.join(outside, "secret.txt") },
      { code: "1", readOnlyDirs: [path.join(outside, "secret.txt")] },
      { code: "1", allowedDomains: ["example.com,169.254.169.254"] },
      { code: "1", allowedDomains: ["example.com 169.254.169.254"] },
      { code: "1", allowedPackages: ["lodash@>=4"] },
      { code: "1", allowedPackages: ["Not A Name"] },
      { code: "1", timeoutMs: 0 },
      { code: "1", memoryMb: 1.5 },
    ];
    for (const o of bad) {
      await assert.rejects(exec(o as never), SandboxConfigError, JSON.stringify(o));
    }
  });

  test("a comma in a directory cannot widen the permissions", async () => {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), "acs-wd,"));
    await assert.rejects(exec({ code: "console.log(1)", workDir: wd }), /commas or whitespace/);
  });

  test("accepts the supported version ranges", async () => {
    const r = await exec({ code: "console.log(1)", allowedPackages: ["a", "a@*", "a@5", "a@5.7", "a@5.7.0", "a@^5.1.0", "a@~5.1.0", "@s/b@1"] });
    assert.equal(r.exitCode, 0);
  });

  test("an aborted signal stops the run", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const r = await exec({ code: "while (true) {}", signal: ac.signal });
    assert.equal(r.exitCode, null);
    assert.equal(r.timedOut, true);
    assert.match(r.stderr, /aborted/);

    const r2 = await exec({ code: "console.log(1)", signal: AbortSignal.abort() });
    assert.equal(r2.timedOut, true);
    assert.equal(r2.stdout, "");
  });
});

describe("files", () => {
  test("cannot read outside the allowed directories", async () => {
    const r = await exec({ code: `console.log(await Deno.readTextFile(${JSON.stringify(path.join(outside, "secret.txt"))}))`, workDir: newWorkDir() });
    assert.notEqual(r.exitCode, 0);
    assert.doesNotMatch(r.stdout, /TOP-SECRET/);
    assert.match(r.stderr, /is not allowed in the sandbox/);
  });

  test("cannot write outside the workDir, can only read readOnlyDirs", async () => {
    const code = `
      console.log(await Deno.readTextFile(${JSON.stringify(path.join(outside, "secret.txt"))}));
      await Deno.writeTextFile(${JSON.stringify(path.join(outside, "x.txt"))}, "x");`;
    const r = await exec({ code, workDir: newWorkDir(), readOnlyDirs: [outside] });
    assert.equal(r.stdout, "TOP-SECRET\n");
    assert.match(r.stderr, /Writing .* is not allowed/);
    assert.equal(fs.existsSync(path.join(outside, "x.txt")), false);
  });

  test("static imports of files outside the allowed directories are rejected before running", async () => {
    // Deno loads static imports without --allow-read checks, so this must be caught in phase A.
    for (const code of [
      `import s from ${JSON.stringify(path.join(outside, "secret.txt"))} with { type: "text" }; console.log(s);`,
      `import s from ${JSON.stringify(path.join(outside, "secret.js"))}; console.log(s);`,
      `const s = await import(${JSON.stringify("file://" + path.join(outside, "secret.js"))}); console.log(s.default);`,
    ]) {
      const r = await exec({ code, workDir: newWorkDir() });
      assert.equal(r.exitCode, 1, code);
      assert.doesNotMatch(r.stdout, /TOP-SECRET/);
      assert.match(r.stderr, /outside the allowed directories/);
    }
  });

  test("symlinks in the workDir pointing outside are rejected", async () => {
    const wd = newWorkDir();
    fs.symlinkSync(outside, path.join(wd, "link"));
    await assert.rejects(
      exec({ code: 'console.log(await Deno.readTextFile("link/secret.txt"))', workDir: wd }),
      (e: Error) => e instanceof SandboxConfigError && /Symbolic links/.test(e.message),
    );
  });

  test("the sandboxed code cannot create symlinks", async () => {
    const r = await exec({ code: `await Deno.symlink(${JSON.stringify(outside)}, "link")`, workDir: newWorkDir() });
    assert.notEqual(r.exitCode, 0);
  });
});

describe("host secrets and processes", () => {
  test("cannot see environment variables of the host", async () => {
    process.env.ACS_TEST_SECRET = "env-secret";
    const r = await exec({ code: 'console.log(Deno.env.get("ACS_TEST_SECRET"))', workDir: newWorkDir() });
    assert.doesNotMatch(r.stdout, /env-secret/);
    const r2 = await exec({ code: 'import process from "node:process"; console.log(JSON.stringify(process.env))', workDir: newWorkDir() });
    assert.doesNotMatch(r2.stdout, /env-secret/);
    const r3 = await exec({ code: 'console.log(await Deno.readTextFile("/proc/self/environ"))', workDir: newWorkDir() });
    assert.doesNotMatch(r3.stdout, /env-secret/);
  });

  test("sees only the env names passed", async () => {
    process.env.ACS_TEST_SECRET = "env-secret";
    const r = await exec({ code: 'import process from "node:process"; console.log(process.env.API_URL, JSON.stringify(process.env))', env: { API_URL: "https://api.example.com" } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /^https:\/\/api.example.com /);
    assert.doesNotMatch(r.stdout, /env-secret/);
    // Names not passed read as undefined, as in Node, instead of throwing.
    const r2 = await exec({ code: 'console.log(Deno.env.get("ACS_TEST_SECRET"), process.env.ACS_TEST_SECRET ?? "default")', env: { API_URL: "x" } });
    assert.equal(r2.stdout, "undefined default\n", r2.stderr);
  });

  test("accepts the whole process.env, minus the reserved names", async () => {
    const { DENO_CERT: _a, HTTPS_PROXY: _b, HTTP_PROXY: _c, NO_PROXY: _d, https_proxy: _e, http_proxy: _f, no_proxy: _g, ALL_PROXY: _h, all_proxy: _i, ...rest } = process.env;
    const env = Object.fromEntries(Object.entries(rest).filter(([k]) => !/^(DENO_|LD_|DYLD_)/i.test(k)));
    const r = await exec({ code: 'console.log(Deno.env.get("ACS_TEST_SECRET"))', env: { ...env, ACS_TEST_SECRET: "visible" } as Record<string, string> });
    assert.equal(r.stdout, "visible\n", r.stderr);
  });

  test("reserved env names are rejected", async () => {
    for (const name of ["DENO_DIR", "deno_dir", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "no_proxy"]) {
      await assert.rejects(exec({ code: "1", env: { [name]: "x" } }), SandboxConfigError, name);
    }
  });

  test("cannot run subprocesses or FFI", async () => {
    for (const code of [
      'await new Deno.Command("id").output()',
      'import cp from "node:child_process"; cp.execSync("id")',
      'Deno.dlopen("libc.so.6", {})',
    ]) {
      const r = await exec({ code, workDir: newWorkDir() });
      assert.notEqual(r.exitCode, 0, code);
    }
  });
});

describe("network", () => {
  const get = (url: string) => `console.log(await (await fetch(${JSON.stringify(url)})).text())`;

  test("only allowed hosts are reachable", async () => {
    const opts = { workDir: newWorkDir(), allowedDomains: ["127.0.0.1:18090"] };
    assert.equal((await exec({ ...opts, code: get("http://127.0.0.1:18090/") })).stdout, "hello from allowed host\n");
    const r = await exec({ ...opts, code: get("http://127.0.0.1:18091/") });
    assert.doesNotMatch(r.stdout, /REACHED/);
    assert.match(r.stderr, /Network access to "127.0.0.1:18091" is not allowed in the sandbox. Allowed hosts: 127.0.0.1:18090/);
  });

  test("redirects to other hosts are blocked", async () => {
    const r = await exec({ workDir: newWorkDir(), allowedDomains: ["127.0.0.1:18090"], code: get("http://127.0.0.1:18090/redirect") });
    assert.doesNotMatch(r.stdout, /REACHED/);
    assert.notEqual(r.exitCode, 0);
  });

  test("everything is denied by default, including metadata endpoints and the npm registry", async () => {
    for (const url of ["http://127.0.0.1:18090/", "http://169.254.169.254/latest/meta-data/", "http://169.254.170.2/", "https://registry.npmjs.org/lodash"]) {
      const r = await exec({ workDir: newWorkDir(), code: get(url) });
      assert.notEqual(r.exitCode, 0, url);
    }
    const r = await exec({ workDir: newWorkDir(), code: 'import net from "node:net"; net.connect(18091, "127.0.0.1").on("connect", () => console.log("REACHED"))' });
    assert.doesNotMatch(r.stdout, /REACHED/);
  });
});

describe("packages", () => {
  const papa = 'import Papa from "npm:papaparse@5"; console.log(Papa.parse("a,b\\n1,2").data.length);';

  test("an allowed package works", async () => {
    const r = await exec({ code: papa, workDir: newWorkDir(), allowedPackages: ["papaparse@5"] });
    assert.equal(r.stdout, "2\n", r.stderr);
  });

  test("a package not in the allowlist is rejected before running", async () => {
    const r = await exec({ code: 'import _ from "npm:lodash@4"; console.log(1)', workDir: newWorkDir(), allowedPackages: ["papaparse@5"] });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /Package "lodash" is not allowed. Allowed packages: papaparse@5/);
  });

  test("a version outside the allowed range is rejected", async () => {
    const r = await exec({ code: papa, workDir: newWorkDir(), allowedPackages: ["papaparse@4"] });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /outside the allowed versions/);
  });

  test("a package that does not exist is reported to the code, not thrown", async () => {
    const r = await exec({ code: 'import x from "npm:acs-no-such-package-zzzq"; console.log(x)' });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /does not exist/);
    assert.doesNotMatch(r.stderr, /^Download /m);
  });

  test("without an allowlist any package works", async () => {
    const r = await exec({ code: 'import _ from "npm:lodash@4"; console.log(typeof _.chunk)', workDir: newWorkDir() });
    assert.equal(r.stdout, "function\n");
  });

  test("cached packages cannot be reached through dynamic imports, require, or path tricks", async () => {
    // lodash is in the shared store now (previous test). Try every way to load it.
    const store = path.join(process.env.AGENT_CODE_SANDBOX_CACHE_DIR!, "store", "npm", "registry.npmjs.org", "lodash");
    const version = fs.readdirSync(store).find((d) => /^\d/.test(d))!;
    const file = path.join(store, version, "lodash.js");
    const attempts = [
      'const n = ["lod", "ash"].join(""); const m = await import("npm:" + n); console.log("LOADED", m.default.VERSION);',
      `const m = await import(["file:/", ${JSON.stringify(file)}].join("/")); console.log("LOADED", m.default.VERSION);`,
      `import { createRequire } from "node:module"; console.log("LOADED", createRequire(import.meta.url)(${JSON.stringify(file)}).VERSION);`,
      'const m = await import(["npm:papaparse@5", "../../lodash", "' + version + '", "lodash.js"].join("/")); console.log("LOADED", m.default.VERSION);',
    ];
    for (const a of attempts) {
      const r = await exec({ code: papa + "\n" + a, workDir: newWorkDir(), allowedPackages: ["papaparse@5"] });
      assert.doesNotMatch(r.stdout, /LOADED/, `${a}\n${r.stderr}`);
    }
  });

  test("jsr: and URL imports are rejected", async () => {
    for (const code of ['import "jsr:@std/path";', 'import "https://deno.land/std@0.224.0/path/mod.ts";']) {
      const r = await exec({ code, workDir: newWorkDir() });
      assert.equal(r.exitCode, 1);
      assert.match(r.stderr, /Only npm: imports/);
    }
  });

  test("package.json in the workDir does not install or expose packages", async () => {
    const wd = newWorkDir();
    fs.writeFileSync(path.join(wd, "package.json"), JSON.stringify({ dependencies: { lodash: "4" } }));
    const r = await exec({ code: 'const m = await import(["lod", "ash"].join("")); console.log("LOADED", m.default.VERSION);', workDir: wd, allowedPackages: [] });
    assert.doesNotMatch(r.stdout, /LOADED/);
  });

  test("concurrent runs share the store safely", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => exec({ code: papa, allowedPackages: ["papaparse@5"] })),
    );
    for (const r of results) assert.equal(r.stdout, "2\n", r.stderr);
  });
});

describe("resource limits", () => {
  test("an infinite loop is killed at the timeout", async () => {
    const r = await exec({ code: "while (true) {}", workDir: newWorkDir(), timeoutMs: 1000 });
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    assert.match(r.stderr, /ran longer than 1000 ms/);
  });

  test("memory is capped", async () => {
    const r = await exec({ code: "const a = []; while (true) a.push(new Array(1e6).fill(1));", workDir: newWorkDir(), memoryMb: 128, timeoutMs: 20_000 });
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.timedOut, false);
  });

  test("large output is truncated, keeping the head and the tail", async () => {
    const r = await exec({ code: 'for (let i = 0; i < 100000; i++) console.log("line", i);', workDir: newWorkDir(), maxOutputBytes: 1000 });
    assert.equal(r.truncated, true);
    assert.match(r.stdout, /^line 0\n/);
    assert.match(r.stdout, /line 99999\n$/);
    assert.match(r.stdout, /bytes omitted/);
    assert.ok(r.stdout.length < 1200);
  });

  test("output is capped at 1 MB by default", async () => {
    const r = await exec({ code: 'const s = "x".repeat(1024); for (let i = 0; i < 4096; i++) console.log(s);' });
    assert.equal(r.truncated, true);
    assert.ok(r.stdout.length < 1024 * 1024 + 200);
  });
});
