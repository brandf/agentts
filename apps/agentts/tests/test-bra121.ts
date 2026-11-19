#!/usr/bin/env bun
/**
 * Join-slice failure reporting (Linear BRA-121).
 *
 * A throw that surfaces through an `all()`/`any()`/`race()` join used
 * to crash the join slice instead of failing the run cleanly: the C
 * host's join-resume paths (`join`, `join-value`, `join-aggregate`,
 * `join-throw` in packages/durablets/src/durablets.c) returned rc=1
 * with NO lifecycle "failed" event journaled, so the host's
 * runJoinSlice classified the slice as a crash, retried the combine
 * 3 times (deterministically — the branch outcomes are already on
 * disk), and gave up with the misleading "C host crashed joining
 * <runId> 3 times" message. The real error was visible only in the
 * slice log, not in the run result.
 *
 * The fix (BRA-121): each join handler's JS_ResumeWith exception arm
 * now emits a lifecycle "failed" event (after print_exception, which
 * stashes the "Name: message" the event carries) — the same shape the
 * run/resume/cancel paths already had. runJoinSlice then classifies
 * rc=1 as "failed" and the run fails with the real error, no retries.
 *
 * This test drives tests/workflows/workflow-bra121-probe.ts under the
 * Host with the direct adapter (real C host, real joins) in each mode
 * and asserts the failure is clean: result status "failed" with the
 * real error, exactly one lifecycle "failed" event carrying it in the
 * journal, and zero "host-crash" events. The caught-after-join mode
 * proves the happy path still works.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra121.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra111 suite.)
 *
 * Run outputs go to $BRA121_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Host } from "../src/host";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra121-probe.ts");
const WORKDIR = process.env.BRA121_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra121-"));

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

/** Modes that must fail cleanly, with the error fragment the run must carry. */
const FAILING_MODES: [string, string][] = [
  ["plain", "plain throw, no combinator"],
  ["after-join", "after-join throw"],
  ["fail-fast", "branch boom"],
  ["after-join-sleep", "after-join throw"],
  ["any-winner", "after-any throw: winner"],
  ["any-all-fail", "All branches failed"],
  ["race-fail", "racer boom"],
  ["race-win", "after-race throw: winner"],
];

const host = new Host({ stateDir: path.join(WORKDIR, "state"), adapter: new DirectAdapter() });

for (const [mode, fragment] of FAILING_MODES) {
  const runId = `bra121-${mode}`;
  host.submit(WORKFLOW, { runId, input: { mode } });
  await host.runQueue();
  const res = host.result(runId);
  check(res.status === "failed", `FAIL OK: ${mode} run failed (got ${res.status})`);
  check(
    (res.error ?? "").includes(fragment),
    `FAIL OK: ${mode} error names the real failure (${JSON.stringify(res.error)})`,
  );
  const events = host.journal(runId);
  const failed = events.filter((e) => e.event === "lifecycle" && e.lifecycle === "failed");
  check(failed.length === 1, `FAIL OK: ${mode} journal carries exactly 1 lifecycle failed (got ${failed.length})`);
  check(
    (failed[0]?.error ?? "").includes(fragment),
    `FAIL OK: ${mode} lifecycle failed carries the real error (${JSON.stringify(failed[0]?.error)})`,
  );
  const crashes = events.filter((e) => e.event === "host-crash");
  check(crashes.length === 0, `FAIL OK: ${mode} journal carries 0 host-crash events (got ${crashes.length})`);
}

// Happy path: a failing branch, caught after the join, completes.
{
  const runId = "bra121-caught-after-join";
  host.submit(WORKFLOW, { runId, input: { mode: "caught-after-join" } });
  await host.runQueue();
  const res = host.result(runId);
  check(res.status === "done", `CAUGHT OK: caught-after-join run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
  check((res.output as any)?.ok === true, `CAUGHT OK: caught-after-join output ok (got ${JSON.stringify(res.output)})`);
  const events = host.journal(runId);
  check(
    events.filter((e) => e.event === "lifecycle" && e.lifecycle === "failed").length === 0,
    `CAUGHT OK: caught-after-join journal carries 0 lifecycle failed`,
  );
  check(
    events.filter((e) => e.event === "host-crash").length === 0,
    `CAUGHT OK: caught-after-join journal carries 0 host-crash events`,
  );
}

if (FAILURES.length) {
  console.log(`\nFAIL: ${FAILURES.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nPASS bra121 join-slice failure reporting (a throw after an all()/any()/race() join fails cleanly with the real error, no join-slice crash retries)`);
