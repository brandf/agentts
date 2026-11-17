#!/usr/bin/env bun
/**
 * Queue/driver integrity test (Linear BRA-72 — G2 + G13, the BRA-62
 * audit's queue/driver gaps).
 *
 * Proves (a) a crashed driver leaves a queue entry stranded at
 * "running" and the queue does not drive it, and `queue repair`
 * re-drives it to completion; (b) two concurrent `queue run`
 * drivers do not corrupt a run — the second fails loudly.
 *
 *   A. Stranded suspended run + explicit repair: drive a run with
 *      a 5s exec trap in a child process, SIGKILL the child
 *      mid-drive (entry "running", run suspended, lock left behind
 *      with a dead pid). `queue list` still shows "running".
 *      `queue repair` exits 0, prints
 *      `REPAIR <runId>: running -> queued`, the entry is "queued",
 *      and the journal carries a `queue-repaired` event. `queue run`
 *      then drives it to completion.
 *   B. Completed-run repair: drive a fast run to done, then flip
 *      its queue entry back to "running" (simulating a crash
 *      between completion and the queue write). `queue repair`
 *      marks it "done" WITHOUT re-driving — the trap count in the
 *      journal is unchanged and `result` still returns the output.
 *   C. Never-started repair: submit a run, flip its entry to
 *      "running" before any drive. `queue repair` re-queues it and
 *      `queue run` completes it.
 *   D. Inconsistent state is left alone: strand a run as in A, then
 *      delete its registry file (runs/<runId>.json — simulating
 *      registry loss). `queue repair` leaves the entry "running"
 *      and says so (journal shows trap activity but no registry
 *      entry — re-driving would restart from scratch and could
 *      double-execute the dispatched trap). A following `queue run`
 *      does not drive it either (the auto-repair leaves it too).
 *   E. Concurrent drivers: drive a 10s exec run in a child; while
 *      it holds the lock, run `queue run` again — it exits non-zero
 *      and says "driver already running". The journal still has
 *      exactly ONE `trap` event for the run (no second drive
 *      started it) and the entry is still "running" until the first
 *      driver finishes it.
 *   F. Auto-repair in `queue run`: crash a driver mid-drive as in
 *      A, then run `queue run` WITHOUT an explicit repair — it
 *      prints the REPAIR line itself and the run completes. (This
 *      is the tick agent's path: it self-heals on its normal wake.)
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra72.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra75 suite.)
 *
 * Run outputs go to $BRA72_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The drive child processes are killed in a
 * finally block, even on failure. Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): a crash DURING an
 * exec's spawnSync re-runs the command on recovery (BRA-75
 * scenario D — the marker has two lines after A and F). The repair
 * makes the re-drive happen; it does not make the exec idempotent.
 * (A state dir with a corrupt journal line used to brick the Host
 * constructor — BRA-62 G15, fixed by BRA-77: the line is now
 * quarantined and the repair runs. See tests/test-bra77.ts.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA72_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra72-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

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

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Drive the queue in a child process (the CLI blocks in the exec
 * trap; this process must stay free to kill it). */
function driveChild(): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", STATE_DIR], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
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
function setQueueStatus(runId: string, status: string): boolean {
  const p = path.join(STATE_DIR, "queue.json");
  if (!fs.existsSync(p)) return false;
  const q = JSON.parse(fs.readFileSync(p, "utf8"));
  const e = q.find((x: any) => x.runId === runId);
  if (!e) return false;
  e.status = status;
  fs.writeFileSync(p, JSON.stringify(q, null, 2));
  return true;
}
function readJournal(runId: string): any[] {
  const p = path.join(STATE_DIR, "journals", `${runId}.journal`);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
function markerLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  fail(`timeout waiting for: ${what}`);
  return false;
}

function submit(workflow: string, runId: string, input: unknown): string {
  const inputFile = path.join(WORKDIR, `${runId}.input.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const r = cli(["run", workflow, "--run-id", runId, "--input-file", inputFile, "--adapter", "direct", "--state-dir", STATE_DIR]);
  check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `SUBMIT OK: ${runId} submitted (rc ${r.rc})`);
  return runId;
}

function getResult(runId: string): any | null {
  const r = cli(["result", runId, "--state-dir", STATE_DIR]);
  if (r.rc !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

/** Strand a run: drive it in a child, wait for the entry to flip
 * to "running" AND the marker file to appear (the exec trap has
 * dispatched — the run is suspended with a registry entry and a
 * snapshot blob on disk), then SIGKILL the child. Waiting for the
 * marker matters: killing right after the "running" flip can land
 * before the first slice returns, leaving a never-started run
 * instead of a suspended one. Returns the child (already dead). */
async function strandRun(runId: string, marker: string): Promise<Subprocess> {
  const child = driveChild();
  const flipped = await waitFor(() => queueStatus(runId) === "running", 10_000, `${runId} entry -> running`);
  check(flipped, `STRAND OK: ${runId} entry flipped to running before the kill`);
  const dispatched = await waitFor(() => markerLines(marker) >= 1, 10_000, `${runId} marker written (exec dispatched)`);
  check(dispatched, `STRAND OK: ${runId} exec dispatched (marker written) before the kill`);
  child.kill(9);
  await child.exited;
  check(queueStatus(runId) === "running", `STRAND OK: ${runId} entry still "running" after the kill (stranded, not driven)`);
  return child;
}

const children: Subprocess[] = [];
async function scenarioA(): Promise<void> {
  console.log("\n=== A. stranded suspended run + explicit repair ===");
  const runId = "bra72-a";
  const marker = path.join(WORKDIR, "bra72-a.marker");
  submit(path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  // The lock is left behind with a dead pid — repair must break it.
  const lockDir = path.join(STATE_DIR, "driver.lock");
  check(fs.existsSync(lockDir), "A LOCK OK: driver.lock left behind by the killed driver");
  const list = cli(["queue", "list", "--state-dir", STATE_DIR]);
  check(list.out.includes(`running ${runId}`), `A LIST OK: queue list still shows ${runId} running (the queue does not drive it on its own)`);
  const repair = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair.rc === 0, `A REPAIR OK: queue repair exited 0 (got ${repair.rc})`);
  check(
    repair.out.includes(`REPAIR ${runId}: running -> queued`),
    `A REPAIR OK: repair reported ${runId} running -> queued (out: ${repair.out.trim().split("\n").find((l) => l.includes("REPAIR")) ?? "(none)"})`,
  );
  check(queueStatus(runId) === "queued", `A REPAIR OK: ${runId} entry is queued after repair`);
  check(
    readJournal(runId).some((e) => e.event === "queue-repaired" && e.to === "queued"),
    `A JOURNAL OK: queue-repaired event (to queued) in the ${runId} journal`,
  );
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `A RECOVER OK: queue run exited 0 (got ${drive.rc})`);
  check(queueStatus(runId) === "done", `A RECOVER OK: ${runId} done after repair`);
  const res = getResult(runId);
  check(res?.exitCode === 0, `A RECOVER OK: ${runId} completed after repair (exitCode ${res?.exitCode})`);
  // The exec re-runs on recovery (BRA-75 scenario D: the crash was
  // DURING dispatch, its output lost) — marker 2 lines, documented.
  check(markerLines(marker) === 2, `A RECOVER OK: marker has 2 lines — the exec re-ran once on recovery (known BRA-75 behavior)`);
}

async function scenarioB(): Promise<void> {
  console.log("\n=== B. completed-run repair (no re-drive) ===");
  const runId = "bra72-b";
  const marker = path.join(WORKDIR, "bra72-b.marker");
  submit(path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), runId, { markerFile: marker, sleepMs: 0 });
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `B DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  check(queueStatus(runId) === "done", `B DRIVE OK: ${runId} done`);
  const trapsBefore = readJournal(runId).filter((e) => e.event === "trap").length;
  // Simulate the crash window: completion happened, queue write did not.
  check(setQueueStatus(runId, "running"), `B SETUP OK: ${runId} entry flipped back to running (simulated crash window)`);
  const repair = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair.rc === 0, `B REPAIR OK: queue repair exited 0 (got ${repair.rc})`);
  check(
    repair.out.includes(`REPAIR ${runId}: running -> done`),
    `B REPAIR OK: repair marked ${runId} done without re-driving`,
  );
  check(queueStatus(runId) === "done", `B REPAIR OK: ${runId} entry is done after repair`);
  const trapsAfter = readJournal(runId).filter((e) => e.event === "trap").length;
  check(trapsAfter === trapsBefore, `B REPAIR OK: trap count unchanged (${trapsBefore} -> ${trapsAfter}) — no re-drive happened`);
  const res = getResult(runId);
  check(res?.exitCode === 0, `B REPAIR OK: ${runId} result still returns the output (exitCode ${res?.exitCode})`);
}

async function scenarioC(): Promise<void> {
  console.log("\n=== C. never-started repair ===");
  const runId = "bra72-c";
  const marker = path.join(WORKDIR, "bra72-c.marker");
  submit(path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), runId, { markerFile: marker, sleepMs: 0 });
  check(setQueueStatus(runId, "running"), `C SETUP OK: ${runId} entry flipped to running before any drive`);
  const repair = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair.rc === 0, `C REPAIR OK: queue repair exited 0 (got ${repair.rc})`);
  check(
    repair.out.includes(`REPAIR ${runId}: running -> queued`),
    `C REPAIR OK: repair re-queued never-started ${runId}`,
  );
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `C RECOVER OK: queue run exited 0 (got ${drive.rc})`);
  const res = getResult(runId);
  check(queueStatus(runId) === "done" && res?.exitCode === 0, `C RECOVER OK: ${runId} completed (exitCode ${res?.exitCode})`);
}

async function scenarioD(): Promise<void> {
  console.log("\n=== D. inconsistent state is left alone ===");
  const runId = "bra72-d";
  const marker = path.join(WORKDIR, "bra72-d.marker");
  submit(path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  // Simulate registry loss: delete the persisted run entry.
  const regPath = path.join(STATE_DIR, "runs", `${runId}.json`);
  check(fs.existsSync(regPath), `D SETUP OK: registry file exists for ${runId} before deletion`);
  fs.rmSync(regPath);
  const repair = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair.rc === 0, `D REPAIR OK: queue repair exited 0 (got ${repair.rc})`);
  const repairLine = repair.out.split("\n").find((l) => l.includes(`REPAIR ${runId}`)) ?? "";
  check(
    repairLine.includes("running -> left-running") && repairLine.includes("inconsistent"),
    `D REPAIR OK: repair left ${runId} running and said why (line: ${repairLine || "(none)"})`,
  );
  check(queueStatus(runId) === "running", `D REPAIR OK: ${runId} entry still running after repair`);
  // A following `queue run` must not drive it either — the auto-repair
  // leaves it too, and runQueue skips non-queued entries.
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `D DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  check(
    drive.out.includes(`REPAIR ${runId}: running -> left-running`),
    `D DRIVE OK: queue run's auto-repair also left ${runId} running`,
  );
  check(queueStatus(runId) === "running", `D DRIVE OK: ${runId} entry still running after queue run (not driven)`);
}

async function scenarioE(): Promise<void> {
  console.log("\n=== E. concurrent drivers: second fails loudly ===");
  const runId = "bra72-e";
  const marker = path.join(WORKDIR, "bra72-e.marker");
  submit(path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), runId, { markerFile: marker, sleepMs: 10000 });
  const child = driveChild();
  children.push(child);
  const held = await waitFor(
    () => fs.existsSync(path.join(STATE_DIR, "driver.lock", "holder.json")) && queueStatus(runId) === "running",
    10_000,
    "first driver holding the lock with entry running",
  );
  check(held, "E LOCK OK: first driver holds the lock and the entry is running");
  const second = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(second.rc !== 0, `E REFUSE OK: second queue run exited non-zero (got ${second.rc})`);
  const combined = `${second.out}\n${second.err}`;
  check(
    combined.includes("driver already running"),
    `E REFUSE OK: second driver said "driver already running" (out: ${second.out.trim().split("\n")[0] ?? ""} / err: ${second.err.trim().split("\n")[0] ?? ""})`,
  );
  const traps = readJournal(runId).filter((e) => e.event === "trap").length;
  check(traps === 1, `E JOURNAL OK: exactly one trap event for ${runId} (${traps}) — no second drive started it`);
  check(queueStatus(runId) === "running", `E JOURNAL OK: ${runId} entry still running (first driver still driving)`);
  await child.exited;
  check((child.exitCode ?? 1) === 0, `E DONE OK: first driver exited 0 (got ${child.exitCode})`);
  const res = getResult(runId);
  check(queueStatus(runId) === "done" && res?.exitCode === 0, `E DONE OK: ${runId} completed under the first driver (exitCode ${res?.exitCode})`);
  check(markerLines(marker) === 1, `E DONE OK: marker has 1 line — the exec ran once, not twice`);
}

async function scenarioF(): Promise<void> {
  console.log("\n=== F. auto-repair in queue run (tick-agent path) ===");
  const runId = "bra72-f";
  const marker = path.join(WORKDIR, "bra72-f.marker");
  submit(path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  // No explicit repair — `queue run` must repair it itself.
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `F RECOVER OK: queue run exited 0 (got ${drive.rc})`);
  check(
    drive.out.includes(`REPAIR ${runId}: running -> queued`),
    `F RECOVER OK: queue run printed the REPAIR line itself (no explicit repair needed)`,
  );
  const res = getResult(runId);
  check(queueStatus(runId) === "done" && res?.exitCode === 0, `F RECOVER OK: ${runId} completed via auto-repair (exitCode ${res?.exitCode})`);
}

try {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();
  await scenarioF();
} finally {
  for (const c of children) {
    try {
      c.kill(9);
    } catch {
      /* already dead */
    }
  }
}

if (FAILURES.length) {
  console.log(`\nFAIL bra72 queue/driver integrity suite (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra72 queue/driver integrity suite (stranded repair, completed/never-started/inconsistent cases, concurrent-driver refusal, auto-repair in queue run)");
