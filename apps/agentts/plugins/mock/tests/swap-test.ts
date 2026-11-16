#!/usr/bin/env bun
/**
 * Swap test (Linear BRA-45) — the point of the mock plugin.
 *
 * The same workflows, run under the mock plugin, must produce
 * byte-identical results to the same workflows under the core's
 * reference plugin. Swapping the environment changes nothing above
 * the plugin boundary. Any divergence fails the run.
 *
 * Usage: bun tests/swap-test.ts <reference-out-dir> <mock-out-dir>
 * (run.sh runs the reference suite into a scratch dir, then the mock
 * suite, then this.) Compares the parent .out file of every ported
 * core-suite workflow — fork versions and straight-through references
 * alike — plus the still-suspended race([]) run (empty output both
 * sides). Typed-validation and virtual-clock tests are mock-only by
 * design (the reference plugin does not enforce contracts or run a
 * virtual clock); they are covered by run-mock-suite.ts, not here.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const [refDir, mockDir] = process.argv.slice(2);
if (!refDir || !mockDir) {
  console.log("usage: bun tests/swap-test.ts <reference-out-dir> <mock-out-dir>");
  process.exit(1);
}

const RUNS = [
  "run-judges",
  "run-judges-direct",
  "run-global",
  "run-global-direct",
  "run-nested",
  "run-nested-direct",
  "run-failfast",
  "run-failfast-direct",
  "run-any",
  "run-any-direct",
  "run-race",
  "run-race-direct",
  "run-race-empty",
  "run-cancel-step",
  "run-cancel-combinator",
  "run-sticky",
  "run-race-a",
  "run-race-b",
  "run-nested-cancel",
  "run-trap-types",
  "run-agentts",
  "run-judges-module",
  "run-global-module",
  "run-nested-module",
  "run-failfast-module",
  "run-any-module",
  "run-race-module",
  "run-json-boundary",
  "run-error-rehydration",
  "run-error-rehydration-direct",
];

let failures = 0;
let compared = 0;
for (const runId of RUNS) {
  const name = runId.replace(/\//g, "_") + ".out";
  const ref = path.join(refDir, name);
  const mock = path.join(mockDir, name);
  if (!fs.existsSync(ref)) {
    console.log(`FAIL: reference output missing: ${ref}`);
    failures++;
    continue;
  }
  if (!fs.existsSync(mock)) {
    console.log(`FAIL: mock output missing: ${mock}`);
    failures++;
    continue;
  }
  compared++;
  const a = fs.readFileSync(ref);
  const b = fs.readFileSync(mock);
  if (a.equals(b)) {
    console.log(`MATCH: ${runId} (${a.length} bytes, byte-identical)`);
  } else {
    failures++;
    console.log(`FAIL: ${runId} diverges (${a.length} vs ${b.length} bytes)`);
    const al = a.toString().split("\n");
    const bl = b.toString().split("\n");
    for (let i = 0; i < Math.max(al.length, bl.length); i++) {
      if (al[i] !== bl[i]) console.log(`  line ${i}: ref: ${al[i] ?? ""}\n           mock: ${bl[i] ?? ""}`);
    }
  }
}

console.log();
if (failures) {
  console.log(`FAIL swap test: ${failures} divergence(s) across ${compared} compared runs`);
  process.exit(1);
}
console.log(`PASS swap test: ${compared} runs byte-identical under the mock plugin and the reference plugin`);
