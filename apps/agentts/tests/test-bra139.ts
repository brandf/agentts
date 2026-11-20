#!/usr/bin/env bun
/**
 * run/call sub-workflows CLI+direct e2e test (Linear BRA-139).
 *
 * `tests/test-bra105.ts` covers `run/` sub-workflows under mock only
 * (virtual clock); it has 0 `cli.ts` and 0 `DirectAdapter` mentions.
 * Integration-real exists via `test-bra94/117/126.ts` (child runs on
 * Host-API direct), but no test submits a `run/` parent through the
 * CLI on direct. This test submits the same bra105 parent fixtures
 * through `bun src/cli.ts` on the direct adapter and proves the
 * child runs and the parent completes, with the journal evidence
 * (run-child events, child lifecycle) read back through a read-only
 * in-process Host over the same state dir.
 *
 * What this proves, through the real usage path:
 *   A. Value through the trap: a pure child returns its result; the
 *      parent gets it as the trap result (doubled 42, label n=21);
 *      the parent journal carries the run-child event naming the
 *      child runId, and the child journal shows lifecycle
 *      completed.
 *   B. Child suspends (sleep) and resumes: the child sleeps 50ms
 *      (real clock) and the parent receives the result.
 *   C. Child throws: the failure surfaces loudly at the call site —
 *      the parent catches it and completes (not failed), the
 *      child's error name and message are preserved, and the child
 *      journal records lifecycle failed. No silent drop.
 *   D. Nested run/call: a child that itself calls a grandchild; the
 *      parent receives the grandchild's result two levels down, and
 *      the middle child's journal names the grandchild.
 *
 * Notes, stated plainly:
 * - A throwaway worker server runs on a random port and
 *   AGENTTS_WORKER_SERVER points at it before any submit: a
 *   Host's notifyEvent posts to the default port 18741 otherwise
 *   — the production server — and test events must never land
 *   there (BRA-133).
 * - The journal is read through a read-only in-process Host over
 *   the same state dir (construction drives nothing); the runs
 *   themselves are driven only by CLI subprocesses.
 * - S5–S8 of test-bra105 (cancellation, freeze pinning, loud
 *   refusal at submit, fresh-process gate resume) are Host-API
 *   behaviors, not CLI-path behaviors, and stay in test-bra105.
 *
 *   DURABLETS_HOST=<built C host> AGENTTS_DURABLETS_DIR=<durablets>
 *   bun tests/test-bra139.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { Host } from "../src/host";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const TESTS = path.join(ROOT, "tests", "workflows");
const WORKDIR = process.env.BRA139_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra139-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 21000 + Math.floor(Math.random() * 8000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// Point this process's notifyEvent (and every CLI subprocess's) at
// the TEST server: the default port is the production server.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

const BUN = "/opt/hatch-image/bin/bun";

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
const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function cli(args: string[]): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

let server: Subprocess | null = null;
async function startServer(): Promise<void> {
  server = spawn([BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", STATE_DIR, "--port", String(PORT)], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env },
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("bra139 server did not come up");
    await sleep(50);
  }
}
async function stopServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  try {
    s.kill(9);
  } catch { /* already dead */ }
  await s.exited;
}

function readQueue(): any[] {
  const p = path.join(STATE_DIR, "queue.json");
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}
function queueStatus(runId: string): string | null {
  return readQueue().find((e) => e.runId === runId)?.status ?? null;
}

/** Read-only journal access through an in-process Host over the
 * same state dir. Constructing a Host drives nothing. */
function readHost(): Host {
  return new Host({ stateDir: STATE_DIR });
}

/** Submit a parent workflow through the CLI, drive it, and return
 * the parsed result output (or null, with a FAIL recorded). */
function runParent(workflow: string, runId: string): any | null {
  const sub = cli(["run", workflow, "--run-id", runId, "--adapter", "direct", "--state-dir", STATE_DIR, "--gates", "hold"]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId}`);
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR, "--gates", "hold"]);
  check(drive.rc === 0, `DRIVE OK: queue run exits 0 for ${runId} (got ${drive.rc}: ${(drive.out + drive.err).slice(0, 200)})`);
  check(queueStatus(runId) === "done", `DONE OK: ${runId} done (got ${queueStatus(runId) ?? "missing"})`);
  const res = cli(["result", runId, "--state-dir", STATE_DIR]);
  check(res.rc === 0, `RESULT OK: result exits 0 for ${runId} (got ${res.rc})`);
  try {
    return JSON.parse(res.out);
  } catch {
    fail(`RESULT OK: result prints parseable JSON for ${runId} (got ${JSON.stringify(res.out.slice(0, 200))})`);
    return null;
  }
}

async function main(): Promise<number> {
  await startServer();
  try {
    // A. Value through the trap.
    console.log("\n=== A. value through the trap (CLI+direct) ===");
    {
      const runId = "run-bra139-value";
      const out = runParent(path.join(TESTS, "workflow-bra105-parent.ts"), runId);
      if (out) {
        check(out.doubled === 42 && out.label === "n=21", `VALUE OK: child result is the trap result (got ${JSON.stringify(out)})`);
      }
      const host = readHost();
      const childRunId = `${runId}/trap-0/child`;
      const runChild = host.journal(runId).find((e) => e.event === "run-child");
      check(
        runChild?.childRunId === childRunId && runChild?.workflow === "./workflow-bra105-child.ts",
        `VALUE OK: parent journal has the run-child event (childRunId ${runChild?.childRunId ?? "(none)"})`,
      );
      check(
        host.journal(childRunId).some((e) => e.event === "lifecycle" && e.lifecycle === "completed"),
        "VALUE OK: child journal shows lifecycle completed (own journal, own runId)",
      );
    }

    // B. Child suspends (sleep) and resumes — real clock.
    console.log("\n=== B. sleeping child resumes (CLI+direct, real clock) ===");
    {
      const runId = "run-bra139-sleep";
      const out = runParent(path.join(TESTS, "workflow-bra105-parent-sleep.ts"), runId);
      if (out) {
        check(out.slept === true && out.sleptMs === 50, `SLEEP OK: sleeping child resumed and returned (got ${JSON.stringify(out)})`);
      }
    }

    // C. Child throws — loud, catchable, no silent drop.
    console.log("\n=== C. child throws (CLI+direct) ===");
    {
      const runId = "run-bra139-throw";
      const out = runParent(path.join(TESTS, "workflow-bra105-parent-throw.ts"), runId);
      if (out) {
        check(out.caught === "Error", `THROW OK: parent caught the child error by name (got ${JSON.stringify(out)})`);
      }
      const host = readHost();
      const parentOut = host.output(runId);
      check(parentOut.includes("caught: Error:"), "THROW OK: parent output names the caught error");
      check(parentOut.includes("boom from child"), "THROW OK: the child's message surfaces at the call site");
      check(parentOut.includes(`child run ${runId}/trap-0/child`), "THROW OK: the message carries the child runId for context");
      const childEvents = host.journal(`${runId}/trap-0/child`);
      const failed = childEvents.find((e) => e.event === "lifecycle" && e.lifecycle === "failed");
      check(
        typeof failed?.error === "string" && failed.error.includes("boom from child"),
        "THROW OK: child journal records lifecycle failed with the error (no silent drop)",
      );
    }

    // D. Nested run/call, two levels.
    console.log("\n=== D. nested run/call (CLI+direct) ===");
    {
      const runId = "run-bra139-nested";
      const out = runParent(path.join(TESTS, "workflow-bra105-parent-nested.ts"), runId);
      if (out) {
        check(out.deep === "grandchild:hello", `NESTED OK: grandchild result arrives two levels down (got ${JSON.stringify(out)})`);
      }
      const host = readHost();
      const middleEvents = host.journal(`${runId}/trap-0/child`);
      const grandchild = middleEvents.find((e) => e.event === "run-child");
      check(
        grandchild?.childRunId === `${runId}/trap-0/child/trap-0/child`,
        `NESTED OK: the middle child's journal names the grandchild (got ${grandchild?.childRunId ?? "(none)"})`,
      );
      check(
        host.journal(`${runId}/trap-0/child/trap-0/child`).some((e) => e.event === "lifecycle" && e.lifecycle === "completed"),
        "NESTED OK: grandchild journal shows lifecycle completed",
      );
    }
  } finally {
    await stopServer();
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA139 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log("PASS bra139 run/call CLI+direct e2e (value through the trap, sleep-resume on the real clock, loud throw, two-level nesting — all through the CLI on direct)");
  return 0;
}

process.exit(await main());
