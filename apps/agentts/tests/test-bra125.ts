#!/usr/bin/env bun
/**
 * Cancelled-run failure reporting (Linear BRA-125).
 *
 * A run that fails on cancel used to journal a lifecycle "failed"
 * event with NO error: the C host's cancel handler
 * (packages/durablets/src/durablets.c, the `cancel` arm) emitted the
 * failure event BEFORE print_exception, so g_last_exception was NULL
 * at emit time and the event carried no error at all — not even "?".
 * The run/resume paths do it the other way round (print_exception
 * first, which stashes the "Name: message" the failed event carries).
 *
 * The fix (BRA-125): swap the two lines in the cancel arm, so the
 * event carries the CancellationError.
 *
 * This test drives tests/workflows/workflow-bra125-probe.ts under the
 * Host with the direct adapter (real C host): the run suspends at a
 * 60s sleep, is cancelled with the CancellationError uncaught, and
 * asserts the journaled failure carries the real error — exactly one
 * lifecycle "failed" event carrying "CancellationError: probe cancel".
 * (BRA-131 fixed the companion gap this test used to note:
 * host.result() for a stepwise-driven run derived status from the
 * registry/finished map and never consulted the journal for
 * "failed", so it reported "running" here. See
 * tests/test-bra131.ts, which asserts result() reports the failure.)
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra125.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra121 suite.)
 *
 * Run outputs go to $BRA125_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Host } from "../src/host";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra125-probe.ts");
const WORKDIR = process.env.BRA125_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra125-"));

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

const host = new Host({ stateDir: path.join(WORKDIR, "state"), adapter: new DirectAdapter() });

const runId = "bra125-cancel-probe";
let rc = await host.startRun(WORKFLOW, runId);
check(rc === 2, `SUSPEND OK: run suspended at the sleep (rc ${rc}, expected 2)`);
rc = host.cancelRun(runId, "probe cancel", "bra125-cancel-probe") ?? -1;
check(rc === 1, `CANCEL OK: cancelled run failed as expected (rc ${rc}, expected 1)`);

const events = host.journal(runId);
const failed = events.filter((e) => e.event === "lifecycle" && e.lifecycle === "failed");
check(failed.length === 1, `FAIL OK: journal carries exactly 1 lifecycle failed (got ${failed.length})`);
check(
  (failed[0]?.error ?? "").includes("CancellationError: probe cancel"),
  `FAIL OK: lifecycle failed carries the CancellationError (${JSON.stringify(failed[0]?.error)})`,
);
const crashes = events.filter((e) => e.event === "host-crash");
check(crashes.length === 0, `FAIL OK: journal carries 0 host-crash events (got ${crashes.length})`);

if (FAILURES.length) {
  console.log(`\nFAIL: ${FAILURES.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nPASS bra125 cancelled-run failure reporting (a run that fails on cancel journals its lifecycle failed event with the real error)`);
