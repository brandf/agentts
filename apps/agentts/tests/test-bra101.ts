#!/usr/bin/env bun
/**
 * HOLD-identity regression test (Linear BRA-101).
 *
 * Root cause: when node_modules is missing, run.sh copies the host
 * sources to scratch ($SCRATCH/host-src, including plugins/) and runs
 * the host from there — but it used to set $AGENTTS_PLUGINS_DIR to
 * the ORIGINAL $SCRIPT_DIR/plugins. Every adapter imports HOLD from
 * ../../../src/adapter relative to its own file, so an adapter loaded
 * from the original tree got a different HOLD Symbol instance than
 * the scratch host's — `answer === HOLD` (src/host.ts) was false and
 * the host failed the gate with `answer is not an Object`.
 *
 * This test pins the fix from both sides, through the same loader
 * the host uses (Host.loadAdapter — $AGENTTS_PLUGINS_DIR first):
 *   A. Wiring: when $AGENTTS_PLUGINS_DIR is set and the direct
 *      adapter resolves from it, the src/adapter.ts sibling to that
 *      plugins dir must be the same file this test's tree imports
 *      HOLD from. Under the old run.sh on the scratch-copy path this
 *      fails (original tree vs scratch tree).
 *   B. Identity, direct: the loaded direct adapter's gate answer
 *      must be `===` the host's HOLD — the exact comparison the host
 *      makes at the gate.
 *   C. Identity, mock: same check for the mock adapter, constructed
 *      with gates: "hold" from the loaded module's own class (its
 *      createAdapter() defaults to gates: "auto", which auto-answers
 *      gates instead of holding).
 *
 * The muse/briefing adapters return HOLD for gates too, but are not
 * loaded here (muse needs a queue server; briefing delegates to
 * direct/mock, covered by B/C). The end-to-end proof stays the host
 * suite's cross-process gate, which drives a real gate through the
 * CLI in a fresh process; this test is the fast pointed assertion
 * that names BRA-101 when it regresses.
 *
 * Run: bun tests/test-bra101.ts (run.sh runs it after the bra89
 * suite, with $AGENTTS_PLUGINS_DIR set by run.sh). No state dir,
 * no C host, no side effects. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { HOLD } from "../src/adapter";
import { Host } from "../src/host";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");

const FAILURES: string[] = [];
function fail(msg: string): void {
  console.log(`FAIL: ${msg}`);
  FAILURES.push(msg);
}
function ok(msg: string): void {
  console.log(msg);
}
function check(cond: boolean, msg: string): void {
  if (cond) ok(msg);
  else fail(msg);
}

const CTX = { runId: "bra101", trapId: "t1", ordinal: 0 };

// A. Wiring: the plugins dir's sibling src/adapter.ts is the same
// file the host imports HOLD from.
const envDir = process.env.AGENTTS_PLUGINS_DIR;
const hostAdapter = fs.realpathSync(path.join(ROOT, "src", "adapter.ts"));
const directSeam = envDir ? path.join(envDir, "direct", "src", "adapter.ts") : null;
if (envDir && directSeam && fs.existsSync(directSeam)) {
  // The loader resolves "direct" from $AGENTTS_PLUGINS_DIR first,
  // so that tree's ../../../src/adapter must be the host's file.
  const pluginAdapter = path.join(envDir, "..", "src", "adapter.ts");
  check(
    fs.existsSync(pluginAdapter) && fs.realpathSync(pluginAdapter) === hostAdapter,
    `BRA101 PLUGIN DIR OK: $AGENTTS_PLUGINS_DIR (${envDir}) resolves src/adapter.ts to the same file the host imports (${hostAdapter})`,
  );
} else if (envDir) {
  ok(
    "BRA101 PLUGIN DIR OK: $AGENTTS_PLUGINS_DIR is set but the direct adapter is not under it — loadAdapter falls back to the sibling plugins/ dir (same tree as the host); identity is covered by B/C below",
  );
} else {
  ok(
    "BRA101 PLUGIN DIR OK: $AGENTTS_PLUGINS_DIR unset — loadAdapter falls back to the sibling plugins/ dir (same tree as the host)",
  );
}

// B. Identity, direct: the loaded adapter's gate answer IS the host's HOLD.
const direct = await Host.loadAdapter("direct");
const directAnswer = direct.answer("gate", { question: "bra101?" }, CTX);
check(
  directAnswer === HOLD,
  "BRA101 DIRECT HOLD OK: direct adapter's gate answer is the host's HOLD (same Symbol instance)",
);

// C. Identity, mock: same check via the loaded module's own class.
const mock = await Host.loadAdapter("mock");
const MockCtor = mock.constructor as new (opts: { gates: "hold" }) => typeof mock;
const heldMock = new MockCtor({ gates: "hold" });
const mockAnswer = heldMock.answer("gate", { question: "bra101?" }, CTX);
check(
  mockAnswer === HOLD,
  "BRA101 MOCK HOLD OK: mock adapter (gates: hold) gate answer is the host's HOLD (same Symbol instance)",
);

if (FAILURES.length) {
  console.log(`\nFAIL bra101 HOLD-identity suite (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra101 HOLD-identity suite (plugin dir resolves to the host's tree; direct + mock gate answers are the host's HOLD)");
