#!/usr/bin/env bun
/**
 * Plan-driven-work failed phases hide stdout (Linear BRA-122).
 *
 * When a command phase failed, the template reported only
 * `phase "X" command exited 1: (no stderr)` — a command that
 * reports its failure on stdout (the common case) left no trace
 * of why it failed. The repro: the bra111-template run
 * (2026-11-18), phase implement-fix ran bra111-wireup.py, which
 * exited 1 after test-bra111.ts failed — the template error
 * carried only `(no stderr)` and the wireup's stdout with the
 * actual reason was lost.
 *
 * The fix: `formatExecFailure` in workflows/library/plan-driven-
 * work.ts — a failed exec's error carries the stdout TAIL (last
 * 2048 chars; the failure reason is usually at the end) and the
 * stderr HEAD (first 300 chars, as before), each labeled. The
 * error is the failed phase's execution record: the run throws,
 * so no PhaseRecord is returned, and the journal's lifecycle
 * "failed" event carries this message (the wave-failure
 * aggregation embeds each phase's error verbatim). Both failure
 * sites use it: the phase error and the commit-step error.
 *
 * What this proves:
 *   A. The formatter, called directly: stdout-only, stderr-only,
 *      both streams, neither (keeps the old "(no stderr)"), a
 *      long stdout is tailed to 2048 chars with a "..." marker,
 *      a long stderr is headed to 300 chars, and the commit-step
 *      label.
 *   B. The phase path end to end (Host, direct adapter, real
 *      exec): a full template run whose command phase prints a
 *      long failure to stdout and exits 1 fails with the stdout
 *      tail in the run's error — the final line present, the head
 *      marker cut — and the journal's lifecycle-"failed" event
 *      carries it too.
 *   C. The commit path (Host, mock adapter, canned exec): a full
 *      template run whose commit command fails carries the commit
 *      stdout tail and stderr head in the run's error.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra122.ts
 *   (run.sh sets DURABLETS_HOST and runs this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Host } from "../src/host";
import { decideLocal } from "../src/decision-model";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";
import {
  formatExecFailure,
  EXEC_STDOUT_TAIL_CHARS,
  EXEC_STDERR_HEAD_CHARS,
} from "../workflows/library/plan-driven-work";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKFLOW = path.join(ROOT, "workflows", "library", "plan-driven-work.ts");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "plan-driven-work");
const WORKDIR = process.env.BRA122_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra122-"));

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

// ---------------------------------------------------------------- A. the formatter, called directly
{
  // stdout-only: the old message would have said "(no stderr)".
  const m1 = formatExecFailure('phase "x" command', { stdout: "WIREUP FAIL: duplicate runId", exitCode: 1 });
  check(
    m1 === 'phase "x" command exited 1: stdout tail: WIREUP FAIL: duplicate runId',
    `A STDOUT OK: stdout-only failure names the stdout tail (got ${JSON.stringify(m1)})`,
  );
  // stderr-only: no regression, and no "(no stderr)" when stderr is present.
  const m2 = formatExecFailure('phase "x" command', { stdout: "", stderr: "boom on stderr", exitCode: 2 });
  check(
    m2 === 'phase "x" command exited 2: stderr: boom on stderr',
    `A STDERR OK: stderr-only failure carries stderr (got ${JSON.stringify(m2)})`,
  );
  check(!m2.includes("(no stderr)"), `A STDERR NOFALLBACK OK: no "(no stderr)" when stderr is present`);
  // Both streams, labeled, in order.
  const m3 = formatExecFailure('phase "x" command', { stdout: "out reason", stderr: "err reason", exitCode: 1 });
  check(
    m3 === 'phase "x" command exited 1: stdout tail: out reason | stderr: err reason',
    `A BOTH OK: both streams labeled in one line (got ${JSON.stringify(m3)})`,
  );
  // Neither stream: the old "(no stderr)" text is kept.
  const m4 = formatExecFailure('phase "x" command', { stdout: "", stderr: "", exitCode: 1 });
  check(
    m4 === 'phase "x" command exited 1: (no stderr)',
    `A NEITHER OK: both-empty keeps the old fallback (got ${JSON.stringify(m4)})`,
  );
  // Long stdout: tailed to EXEC_STDOUT_TAIL_CHARS, with the "..." marker.
  const longStdout = "BRA122 HEAD MARKER\n" + "x".repeat(3000) + "\nBRA122 TAIL MARKER";
  const m5 = formatExecFailure('phase "x" command', { stdout: longStdout, exitCode: 1 });
  const expectedTail = longStdout.trim().slice(-EXEC_STDOUT_TAIL_CHARS);
  check(
    m5 === `phase "x" command exited 1: stdout tail: ...${expectedTail}`,
    `A TAIL OK: long stdout is the exact last ${EXEC_STDOUT_TAIL_CHARS} chars with "..." (got ${JSON.stringify(m5.slice(0, 120))}...)`,
  );
  check(!m5.includes("BRA122 HEAD MARKER"), `A TAIL HEAD OK: the head marker is cut from the tail`);
  check(m5.includes("BRA122 TAIL MARKER"), `A TAIL TAIL OK: the final line survives the tail`);
  // Long stderr: headed to EXEC_STDERR_HEAD_CHARS.
  const longStderr = "0123456789".repeat(50);
  const m6 = formatExecFailure('phase "x" command', { stdout: "", stderr: longStderr, exitCode: 1 });
  const expectedHead = longStderr.trim().slice(0, EXEC_STDERR_HEAD_CHARS);
  check(
    m6 === `phase "x" command exited 1: stderr: ${expectedHead}`,
    `A HEAD OK: long stderr is the exact first ${EXEC_STDERR_HEAD_CHARS} chars (got ${JSON.stringify(m6.slice(0, 120))}...)`,
  );
  // The commit-step label.
  const m7 = formatExecFailure("commit step", { stdout: "push rejected", exitCode: 1 });
  check(
    m7 === "commit step exited 1: stdout tail: push rejected",
    `A COMMIT OK: commit-step label shapes the same way (got ${JSON.stringify(m7)})`,
  );
}

// ---------------------------------------------------------------- B. phase path: direct adapter, real exec
{
  const stateDir = path.join(WORKDIR, "direct-stdout-phase");
  const host = new Host({ stateDir, adapter: new DirectAdapter() });
  const input = {
    request: "A plan with a command phase that fails on stdout",
    phaseOutlines: [
      {
        name: "stdout-fails",
        description: "A command that prints its failure to stdout",
        acceptance: "command succeeds",
        kind: "command",
        command: "sh",
        args: ["-c", "echo BRA122 HEAD MARKER; seq 1 1000; echo BRA122 FINAL FAIL LINE; exit 1"],
      },
      {
        name: "never-runs",
        description: "A phase after the failure",
        acceptance: "runs",
        kind: "agent",
        dependsOn: ["stdout-fails"],
      },
    ],
    executeThrough: "never-runs",
  };
  const runId = "run-bra122-stdout-phase";
  host.submit(WORKFLOW, { runId, input });
  await host.runQueue();
  let q = host.readQueue().find((e) => e.runId === runId);
  check(q?.status === "held", `B GATE OK: run held at the human gate first (got ${q?.status ?? "missing"})`);
  host.deliverGate(runId, { answer: "approve" });
  await host.runQueue();
  const res = host.result(runId);
  check(res.status === "failed", `B FAILED OK: run failed (got ${res.status})`);
  const err = res.error ?? "";
  check(
    err.includes('phase "stdout-fails" command exited 1'),
    `B PHASE OK: error names the phase and exit code (${JSON.stringify(err.slice(0, 160))})`,
  );
  check(err.includes("BRA122 FINAL FAIL LINE"), `B TAIL OK: error carries the stdout tail's final line`);
  check(!err.includes("BRA122 HEAD MARKER"), `B HEAD OK: the stdout head is cut — the error carries the tail, not the head`);
  check(!err.includes("(no stderr)"), `B NOFALLBACK OK: no "(no stderr)" when stdout carries the reason`);
  check(err.includes("later waves did not execute"), `B WAVES OK: error says the later waves did not execute`);
  // The run's record: the journal's lifecycle-"failed" event carries
  // the same message — a failed phase is diagnosable from the run alone.
  const journal = host.journal(runId);
  const failedEv = journal.find((e: any) => e.event === "lifecycle" && e.lifecycle === "failed");
  check(
    typeof failedEv?.error === "string" && failedEv.error.includes("BRA122 FINAL FAIL LINE"),
    `B JOURNAL OK: lifecycle-failed event carries the stdout tail (${JSON.stringify(String(failedEv?.error ?? "").slice(0, 120))})`,
  );
}

// ---------------------------------------------------------------- C. commit path: mock adapter, canned failing exec
{
  const stateDir = path.join(WORKDIR, "mock-commit");
  const host = new Host({ stateDir, adapter: new MockAdapter({ gates: "hold" }) });
  host.setCanned("decide", (_type, arg) => ({ value: decideLocal(arg.question, arg.options) }));
  // Only the commit command fails; every other exec falls through to
  // the mock's default canned success.
  host.setCanned("exec", (_type, arg) => {
    if (arg?.cmd === "bra122-commit") {
      return {
        value: {
          stdout: "BRA122 COMMIT FAIL: push rejected by remote\n",
          stderr: "remote: permission denied\n",
          exitCode: 1,
        },
      };
    }
    return undefined;
  });
  const input = JSON.parse(fs.readFileSync(path.join(FIXTURES, "mock-plan-input.json"), "utf8"));
  input.commit = { cmd: "bra122-commit", args: [] };
  const runId = "run-bra122-commit";
  host.submit(WORKFLOW, { runId, input });
  await host.runQueue();
  let q = host.readQueue().find((e) => e.runId === runId);
  check(q?.status === "held", `C GATE OK: run held at the human gate first (got ${q?.status ?? "missing"})`);
  host.deliverGate(runId, { answer: "approve" });
  await host.runQueue();
  const res = host.result(runId);
  check(res.status === "failed", `C FAILED OK: run failed (got ${res.status})`);
  const err = res.error ?? "";
  check(err.includes("commit step exited 1"), `C COMMIT OK: error names the commit step and exit code (${JSON.stringify(err.slice(0, 200))})`);
  check(err.includes("BRA122 COMMIT FAIL"), `C STDOUT OK: error carries the commit stdout tail`);
  check(
    err.includes("stderr: remote: permission denied"),
    `C STDERR OK: error carries the commit stderr head`,
  );
}

// ---------------------------------------------------------------- verdict
if (FAILURES.length) {
  console.log(`\nFAIL bra122 failed phase hides stdout (${FAILURES.length} failures)`);
  process.exit(1);
}
console.log(
  `\nPASS bra122 failed phase hides stdout (formatter: stdout tail + stderr head, labeled, bounded to ${EXEC_STDOUT_TAIL_CHARS}/${EXEC_STDERR_HEAD_CHARS} chars; phase path: a real failing command's stdout tail reaches the run error and the journal; commit path: same treatment for the commit step)`,
);
