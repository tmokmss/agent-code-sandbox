// Attack and behavior tests for the PoC. Run: node --test test/
// Needs deno on PATH (or SANDBOX_DENO_PATH) and access to registry.npmjs.org.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-cache-"));
process.env.SANDBOX_CACHE_DIR ??= cacheDir;
const { exec } = await import("../src/exec.ts");

function newWorkdir() {
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
    const r = await exec({ code: 'console.log("hi", 1 + 2)', workdir: newWorkdir() });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "hi 3\n");
  });

  test("runs an entrypoint and relative imports, and keeps files between runs", async () => {
    const wd = newWorkdir();
    fs.writeFileSync(path.join(wd, "lib.ts"), "export const add = (a: number, b: number) => a + b;");
    fs.writeFileSync(path.join(wd, "main.ts"), 'import { add } from "./lib.ts"; await Deno.writeTextFile("out.txt", String(add(2, 3)));');
    assert.equal((await exec({ entrypoint: "main.ts", workdir: wd })).exitCode, 0);
    const r = await exec({ code: 'console.log(await Deno.readTextFile("out.txt"))', workdir: wd });
    assert.equal(r.stdout, "5\n");
    assert.deepEqual(fs.readdirSync(wd).sort(), ["lib.ts", "main.ts", "out.txt"]); // temp code file removed
  });

  test("reports the line of an uncaught error", async () => {
    const r = await exec({ code: 'const a = 1;\nthrow new Error("boom");', workdir: newWorkdir() });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /boom/);
    assert.match(r.stderr, /<code>:2/);
  });

  test("reports a syntax error", async () => {
    const r = await exec({ code: "const = 1;", workdir: newWorkdir() });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /Expected|Unexpected/);
  });
});

describe("files", () => {
  test("cannot read outside the allowed paths", async () => {
    const r = await exec({ code: `console.log(await Deno.readTextFile(${JSON.stringify(path.join(outside, "secret.txt"))}))`, workdir: newWorkdir() });
    assert.notEqual(r.exitCode, 0);
    assert.doesNotMatch(r.stdout, /TOP-SECRET/);
    assert.match(r.stderr, /is not allowed in the sandbox/);
  });

  test("cannot write outside the workdir, can only read readonlyPaths", async () => {
    const code = `
      console.log(await Deno.readTextFile(${JSON.stringify(path.join(outside, "secret.txt"))}));
      await Deno.writeTextFile(${JSON.stringify(path.join(outside, "x.txt"))}, "x");`;
    const r = await exec({ code, workdir: newWorkdir(), readonlyPaths: [outside] });
    assert.equal(r.stdout, "TOP-SECRET\n");
    assert.match(r.stderr, /Writing .* is not allowed/);
    assert.equal(fs.existsSync(path.join(outside, "x.txt")), false);
  });

  test("static imports of files outside the allowed paths are rejected before running", async () => {
    // Deno loads static imports without --allow-read checks, so this must be caught in phase A.
    for (const code of [
      `import s from ${JSON.stringify(path.join(outside, "secret.txt"))} with { type: "text" }; console.log(s);`,
      `import s from ${JSON.stringify(path.join(outside, "secret.js"))}; console.log(s);`,
      `const s = await import(${JSON.stringify("file://" + path.join(outside, "secret.js"))}); console.log(s.default);`,
    ]) {
      const r = await exec({ code, workdir: newWorkdir() });
      assert.notEqual(r.exitCode, 0, code);
      assert.doesNotMatch(r.stdout, /TOP-SECRET/);
      assert.match(r.stderr, /outside the allowed paths/);
    }
  });

  test("symlinks in the workdir pointing outside are rejected", async () => {
    const wd = newWorkdir();
    fs.symlinkSync(outside, path.join(wd, "link"));
    const r = await exec({ code: 'console.log(await Deno.readTextFile("link/secret.txt"))', workdir: wd });
    assert.notEqual(r.exitCode, 0);
    assert.doesNotMatch(r.stdout, /TOP-SECRET/);
    assert.match(r.stderr, /Symbolic links/);
  });

  test("a comma in a path or domain cannot widen the permissions", async () => {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), "acs-wd,"));
    const r = await exec({ code: "console.log(1)", workdir: wd });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /Commas and spaces/);
    const r2 = await exec({ code: "console.log(1)", workdir: newWorkdir(), allowedDomains: ["example.com,169.254.169.254"] });
    assert.match(r2.stderr, /Commas and spaces/);
  });

  test("the sandboxed code cannot create symlinks", async () => {
    const r = await exec({ code: `await Deno.symlink(${JSON.stringify(outside)}, "link")`, workdir: newWorkdir() });
    assert.notEqual(r.exitCode, 0);
  });
});

describe("host secrets and processes", () => {
  test("cannot see environment variables", async () => {
    process.env.ACS_TEST_SECRET = "env-secret";
    const r = await exec({ code: 'console.log(Deno.env.get("ACS_TEST_SECRET"))', workdir: newWorkdir() });
    assert.doesNotMatch(r.stdout, /env-secret/);
    const r2 = await exec({ code: 'import process from "node:process"; console.log(JSON.stringify(process.env))', workdir: newWorkdir() });
    assert.doesNotMatch(r2.stdout, /env-secret/);
    const r3 = await exec({ code: 'console.log(await Deno.readTextFile("/proc/self/environ"))', workdir: newWorkdir() });
    assert.doesNotMatch(r3.stdout, /env-secret/);
  });

  test("cannot run subprocesses or FFI", async () => {
    for (const code of [
      'await new Deno.Command("id").output()',
      'import cp from "node:child_process"; cp.execSync("id")',
      'Deno.dlopen("libc.so.6", {})',
    ]) {
      const r = await exec({ code, workdir: newWorkdir() });
      assert.notEqual(r.exitCode, 0, code);
    }
  });
});

describe("network", () => {
  const get = (url: string) => `console.log(await (await fetch(${JSON.stringify(url)})).text())`;

  test("only allowed hosts are reachable", async () => {
    const opts = { workdir: newWorkdir(), allowedDomains: ["127.0.0.1:18090"] };
    assert.equal((await exec({ ...opts, code: get("http://127.0.0.1:18090/") })).stdout, "hello from allowed host\n");
    const r = await exec({ ...opts, code: get("http://127.0.0.1:18091/") });
    assert.doesNotMatch(r.stdout, /REACHED/);
    assert.match(r.stderr, /Network access to "127.0.0.1:18091" is not allowed in the sandbox. Allowed hosts: 127.0.0.1:18090/);
  });

  test("redirects to other hosts are blocked", async () => {
    const r = await exec({ workdir: newWorkdir(), allowedDomains: ["127.0.0.1:18090"], code: get("http://127.0.0.1:18090/redirect") });
    assert.doesNotMatch(r.stdout, /REACHED/);
    assert.notEqual(r.exitCode, 0);
  });

  test("everything is denied by default, including metadata endpoints and the npm registry", async () => {
    for (const url of ["http://127.0.0.1:18090/", "http://169.254.169.254/latest/meta-data/", "http://169.254.170.2/", "https://registry.npmjs.org/lodash"]) {
      const r = await exec({ workdir: newWorkdir(), code: get(url) });
      assert.notEqual(r.exitCode, 0, url);
    }
    const r = await exec({ workdir: newWorkdir(), code: 'import net from "node:net"; net.connect(18091, "127.0.0.1").on("connect", () => console.log("REACHED"))' });
    assert.doesNotMatch(r.stdout, /REACHED/);
  });
});

describe("packages", () => {
  const papa = 'import Papa from "npm:papaparse@5"; console.log(JSON.stringify(Papa.parse("a,b\\n1,2").data));';

  test("an allowed package works", async () => {
    const r = await exec({ code: papa, workdir: newWorkdir(), allowedPackages: ["papaparse@5"] });
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, '[["a","b"],["1","2"]]\n');
  });

  test("a package outside the allowlist is rejected before running", async () => {
    const r = await exec({ code: 'import _ from "npm:lodash@4"; console.log(_.VERSION)', workdir: newWorkdir(), allowedPackages: ["papaparse@5"] });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /Package "lodash" is not allowed/);
  });

  test("a version outside the allowed range is rejected", async () => {
    const r = await exec({ code: papa, workdir: newWorkdir(), allowedPackages: ["papaparse@4"] });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /outside the allowed versions/);
  });

  test("without an allowlist any package works", async () => {
    const r = await exec({ code: 'import _ from "npm:lodash@4"; console.log(typeof _.chunk)', workdir: newWorkdir() });
    assert.equal(r.stdout, "function\n");
  });

  test("cached packages cannot be reached through dynamic imports, require, or path tricks", async () => {
    // lodash is in the shared store now (previous test). Try every way to load it.
    const store = path.join(process.env.SANDBOX_CACHE_DIR!, "store", "npm", "registry.npmjs.org", "lodash");
    const version = fs.readdirSync(store).find((d) => /^\d/.test(d))!;
    const file = path.join(store, version, "lodash.js");
    const attempts = [
      'const n = ["lod", "ash"].join(""); const m = await import("npm:" + n); console.log("LOADED", m.default.VERSION);',
      `const m = await import(["file:/", ${JSON.stringify(file)}].join("/")); console.log("LOADED", m.default.VERSION);`,
      `import { createRequire } from "node:module"; console.log("LOADED", createRequire(import.meta.url)(${JSON.stringify(file)}).VERSION);`,
      'const m = await import(["npm:papaparse@5", "../../lodash", "' + version + '", "lodash.js"].join("/")); console.log("LOADED", m.default.VERSION);',
    ];
    for (const a of attempts) {
      const r = await exec({ code: papa + "\n" + a, workdir: newWorkdir(), allowedPackages: ["papaparse@5"] });
      assert.doesNotMatch(r.stdout, /LOADED/, `${a}\n${r.stderr}`);
    }
  });

  test("jsr: and URL imports are rejected", async () => {
    for (const code of ['import "jsr:@std/path";', 'import "https://deno.land/std@0.224.0/path/mod.ts";']) {
      const r = await exec({ code, workdir: newWorkdir() });
      assert.notEqual(r.exitCode, 0);
      assert.match(r.stderr, /Only npm: imports/);
    }
  });

  test("package.json in the workdir does not install or expose packages", async () => {
    const wd = newWorkdir();
    fs.writeFileSync(path.join(wd, "package.json"), JSON.stringify({ dependencies: { lodash: "4" } }));
    const r = await exec({ code: 'const m = await import(["lod", "ash"].join("")); console.log("LOADED", m.default.VERSION);', workdir: wd, allowedPackages: [] });
    assert.doesNotMatch(r.stdout, /LOADED/);
  });
});

describe("resource limits", () => {
  test("an infinite loop is killed at the timeout", async () => {
    const r = await exec({ code: "while (true) {}", workdir: newWorkdir(), timeoutMs: 1000 });
    assert.equal(r.timedOut, true);
    assert.match(r.stderr, /ran longer than 1000 ms/);
  });

  test("memory is capped", async () => {
    const r = await exec({ code: "const a = []; while (true) a.push(new Array(1e6).fill(1));", workdir: newWorkdir(), memoryMb: 128, timeoutMs: 20_000 });
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.timedOut, false);
  });

  test("large output is truncated, keeping the head and the tail", async () => {
    const r = await exec({ code: 'for (let i = 0; i < 100000; i++) console.log("line", i);', workdir: newWorkdir(), maxOutputBytes: 1000 });
    assert.equal(r.truncated, true);
    assert.match(r.stdout, /^line 0\n/);
    assert.match(r.stdout, /line 99999\n$/);
    assert.match(r.stdout, /bytes omitted/);
    assert.ok(r.stdout.length < 1200);
  });
});
