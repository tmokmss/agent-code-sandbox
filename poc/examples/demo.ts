// Prints results and phase timings for a few typical runs. Run: node examples/demo.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exec } from "../src/exec.ts";

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-demo-"));
const cases: [string, Parameters<typeof exec>[0]][] = [
  ["plain code", { workdir, code: 'console.log("hello")' }],
  ["npm package (allowed)", { workdir, code: 'import Papa from "npm:papaparse@5"; console.log(Papa.parse("a,b").data)', allowedPackages: ["papaparse@5"] }],
  ["npm package (not allowed)", { workdir, code: 'import _ from "npm:lodash@4"; console.log(_.VERSION)', allowedPackages: ["papaparse@5"] }],
  ["read outside", { workdir, code: 'console.log(await Deno.readTextFile("/etc/passwd"))' }],
  ["network (not allowed)", { workdir, code: 'await fetch("http://169.254.169.254/latest/meta-data/")', allowedDomains: ["api.example.com"] }],
  ["runtime error", { workdir, code: 'const rows = [1, 2];\nconsole.log(rows.map((r) => r.foo.bar));' }],
];
for (const [label, opts] of cases) {
  for (const round of ["cold", "warm"]) {
    const r = await exec(opts);
    if (round === "cold" && !process.argv.includes("--verbose")) continue;
    console.log(`=== ${label} (${round}) exit=${r.exitCode} ${r.durationMs}ms ${JSON.stringify(r.phases)}`);
    if (r.stdout) console.log("stdout:", r.stdout.trimEnd());
    if (r.stderr) console.log("stderr:", r.stderr.trimEnd());
  }
}
