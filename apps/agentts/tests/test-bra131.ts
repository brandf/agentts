#!/usr/bin/env bun
/**
 * host.result() for a stepwise-driven failure (Linear BRA-131).
 *
 * result() derived status from the queue entry, then the finished
 * map, then the registry — and never consulted the journal for a
 * lifecycle "failed" event. A run that fails on cancel (or on its
 * first slice) therefore reported "running": cancelRun left the
 * registry entry in place with rc 1 and never recorded `finished`,
 * and a fresh Host over the same stateDir loads that entry with an
 * empty finished map, so even the journal fallback (which only
 * checked "completed") missed it.
 *
 * The fix (BRA-131), in src/host.ts:
 *  - cancelRun records `finished` on a terminal rc (0/1), like
 *    driveStep does — the in-memory bookkeeping is consistent
 *    across every terminal path.
 *  - result() derives from durable state: a registry entry with
 *    rc 0 reads the result file (done), rc 1 reports failed with
 *    the journal's error; with no registry entry, a lifecycle
 *    "failed" event in the journal reports failed (the same
 *    fallback childOutcome already uses). The error prefers the
 *    journal's real error via childFailureMessage, falling back to
 *    the exit-code message.
 *
 * This test drives both failure shapes under the Host with the
 * direct adapter (real C host), on the same Host and on a FRESH
 * Host over the same stateDir (empty finished map, registry loaded
 * from disk):
 *  A. Cancel: workflow-bra125-probe.ts suspends at a 60s sleep,
 *     is cancelled, and result() must report failed with
 *     "CancellationError: probe cancel" — same host and fresh host.
 *  B. First-slice throw: workflow-bra131-throw.ts throws before any
 *     trap; the slice path deletes the registry entry, so a fresh
 *     Host must derive the failure from the journal alone.
 *  C. Sanity: a suspended (not cancelled) run still reports
 *     "running", and an unknown runId still reports "pending".
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra131.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra125 suite.)
 *
 * Run outputs go to $BRA131_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Host } from "../src/host";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const PROBE = path.join(ROOT, "tests", "workflows", "workflow-bra125-probe.ts");
const THROW = path.join(ROOT, "tests", "workflows", "workflow-bra131-throw.ts");
const WORKDIR = process.env.BRA131_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra131-"));

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

const stateDir = path.join(WORKDIR, "state");
const host = new Host({ stateDir, adapter: new DirectAdapter() });

// --- A. Cancel: same host, then a fresh host over the same stateDir.
const cancelId = "bra131-cancel-probe";
let rc = await host.startRun(PROBE, cancelId);
check(rc === 2, `CANCEL-SETUP OK: run suspended at the sleep (rc ${rc}, expected 2)`);
rc = host.cancelRun(cancelId, "probe cancel", "bra131-cancel-probe") ?? -1;
check(rc === 1, `CANCEL OK: cancelled run failed as expected (rc ${rc}, expected 1)`);
let r = host.result(cancelId);
check(r.status === "failed", `CANCEL OK: same-host result() reports failed (got ${JSON.stringify(r)})`);
check(
  (r.error ?? "").includes("CancellationError: probe cancel"),
  `CANCEL OK: same-host result() carries the CancellationError (${JSON.stringify(r.error)})`,
);
const fresh = new Host({ stateDir, adapter: new DirectAdapter() });
r = fresh.result(cancelId);
check(r.status === "failed", `CANCEL OK: fresh-host result() reports failed (got ${JSON.stringify(r)})`);
check(
  (r.error ?? "").includes("CancellationError: probe cancel"),
  `CANCEL OK: fresh-host result() carries the CancellationError (${JSON.stringify(r.error)})`,
);

// --- B. First-slice throw: no registry entry, journal-only derivation.
const throwId = "bra131-throw";
rc = await host.startRun(THROW, throwId);
check(rc === 1, `THROW OK: run failed on its first slice (rc ${rc}, expected 1)`);
check(!host.registryHas(throwId), `THROW OK: slice path deleted the registry entry`);
const fresh2 = new Host({ stateDir, adapter: new DirectAdapter() });
r = fresh2.result(throwId);
check(r.status === "failed", `THROW OK: fresh-host result() reports failed (got ${JSON.stringify(r)})`);
check(
  (r.error ?? "").includes("bra131 immediate throw"),
  `THROW OK: fresh-host result() carries the throw (${JSON.stringify(r.error)})`,
);

// --- C. Sanity: suspended stays running, unknown stays pending.
const liveId = "bra131-live-probe";
rc = await host.startRun(PROBE, liveId);
check(rc === 2, `LIVE OK: second probe suspended at the sleep (rc ${rc}, expected 2)`);
r = host.result(liveId);
check(r.status === "running", `LIVE OK: suspended run still reports running (got ${JSON.stringify(r)})`);
r = host.result("bra131-no-such-run");
check(r.status === "pending", `UNKNOWN OK: unknown runId reports pending (got ${JSON.stringify(r)})`);

if (FAILURES.length) {
  console.log(`\nFAIL: ${FAILURES.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nPASS bra131 host-result failure derivation (a stepwise-driven failure reports failed, same host and fresh host)`);
