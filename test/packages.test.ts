import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAllowedPackage, parseNpmSpecifier, satisfies } from "../src/packages.ts";

test("satisfies", () => {
  const cases: [string, string, boolean][] = [
    ["5.7.1", "*", true],
    ["5.7.1", "5", true],
    ["6.0.0", "5", false],
    ["5.7.1", "5.7", true],
    ["5.8.0", "5.7", false],
    ["5.7.0", "5.7.0", true],
    ["5.7.1", "5.7.0", false],
    ["5.9.0", "^5.1.0", true],
    ["5.0.9", "^5.1.0", false],
    ["6.0.0", "^5.1.0", false],
    ["0.2.5", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
    ["0.9.0", "^0", true],
    ["0.0.4", "^0.0.3", false],
    ["5.1.9", "~5.1.0", true],
    ["5.2.0", "~5.1.0", false],
    ["5.9.0", "~5", true],
    ["5.1.0-beta.1", "*", false],
  ];
  for (const [v, r, want] of cases) assert.equal(satisfies(v, r), want, `${v} ${r}`);
});

test("parseAllowedPackage", () => {
  assert.deepEqual(parseAllowedPackage("lodash"), { name: "lodash", range: "*" });
  assert.deepEqual(parseAllowedPackage("@scope/pkg@^1.2.0"), { name: "@scope/pkg", range: "^1.2.0" });
  assert.deepEqual(parseAllowedPackage("@scope/pkg"), { name: "@scope/pkg", range: "*" });
  for (const bad of ["lodash@>=4", "lodash@4.x", "lodash@latest", "", "Lodash", "lodash@"]) {
    assert.throws(() => parseAllowedPackage(bad), bad);
  }
});

test("parseNpmSpecifier", () => {
  assert.deepEqual(parseNpmSpecifier("npm:lodash@4/fp"), { name: "lodash", range: "4" });
  assert.deepEqual(parseNpmSpecifier("npm:/@scope/pkg@1.2.3/sub"), { name: "@scope/pkg", range: "1.2.3" });
  assert.deepEqual(parseNpmSpecifier("npm:papaparse"), { name: "papaparse", range: "*" });
});
