#!/usr/bin/env bun
/**
 * Swap test, host leg (Linear BRA-44).
 *
 * The same workflows, run under the AgentTS host, must produce
 * byte-identical results to the same workflows under the mock plugin
 * (and under the core's reference plugin). Swapping the environment
 * — and swapping the mock engine for the host's disk engine — changes
 * nothing above the plugin boundary. Any divergence fails the run.
 *
 * Usage: bun tests/swap-test-host.ts <reference-out-dir> <mock-out-dir> <host-state-dir>
 * (run.sh runs the reference suite, the mock suite, and the host suite
 * into scratch dirs, then this.) The host writes .out files under
 * <host-state-dir>/slices/; the mock and reference suites write them
 * flat in their workdirs.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const [refDir, mockDir, hostDir] = process.argv.slice(2);
if (!refDir || !mockDir || !hostDir) {
  console.log("usage: bun tests/swap-test-host.ts <reference-out-dir> <mock-out-dir> <host-state-dir>");
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
  const host = path.join(hostDir, "slices", name);
  for (const [label, p] of [["reference", ref], ["mock", mock], ["host", host]] as const) {
    if (!fs.existsSync(p)) {
      console.log(`FAIL: ${label} output missing for ${runId}: ${p}`);
      failures++;
    }
  }
  if (!fs.existsSync(ref) || !fs.existsSync(mock) || !fs.existsSync(host)) continue;
  compared++;
  const a = fs.readFileSync(mock);
  const b = fs.readFileSync(host);
  if (a.equals(b)) {
    console.log(`MATCH: ${runId} (mock vs host, ${a.length} bytes, byte-identical)`);
  } else {
    failures++;
    console.log(`FAIL: ${runId} diverges mock vs host (${a.length} vs ${b.length} bytes)`);
    const al = a.toString().split("\n");
    const bl = b.toString().split("\n");
    for (let i = 0; i < Math.max(al.length, bl.length); i++) {
      if (al[i] !== bl[i]) console.log(`  line ${i}: mock: ${al[i] ?? ""}\n           host: ${bl[i] ?? ""}`);
    }
  }
  const r = fs.readFileSync(ref);
  if (!r.equals(b)) {
    failures++;
    console.log(`FAIL: ${runId} diverges reference vs host (${r.length} vs ${b.length} bytes)`);
  }
}

console.log();
if (failures) {
  console.log(`FAIL swap test: ${failures} divergence(s) across ${compared} compared runs`);
  process.exit(1);
}
console.log(`PASS swap test: ${compared} runs byte-identical under the mock plugin, the host, and the reference plugin`);
