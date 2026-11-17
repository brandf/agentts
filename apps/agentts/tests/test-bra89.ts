#!/usr/bin/env bun
/**
 * Trap-code pin (Linear BRA-89): a library update must not change
 * in-flight runs — and BRA-71's frozen copy only froze the workflow
 * source, not the code that answers the run's traps.
 *
 * Direction (b) — hash-pin + loud refusal, decided in host.ts
 * (see the BRA-89 comment block above assertTrapPin): at submit the
 * host records the content hashes of the run's trap code (worker
 * scripts, jobspec prose, the decision model, the adapter's own
 * files, exec'd scripts); at every job/decide/exec dispatch it
 * re-hashes and refuses loudly (trap-code-mismatch) when a file
 * changed. The snapshot blob stays on disk, so restoring the file
 * and re-queueing resumes the run.
 *
 *   S1. Direct worker: submit a run suspended on an exec trap,
 *       edit workflows/worker.ts mid-run (judge score 0 -> 0.99):
 *       the resume is refused loudly naming worker.ts, the run is
 *       failed, the blob is kept — then restore the file, re-queue
 *       by hand, and the run completes with the ORIGINAL score 0
 *       and decision "revise".
 *   S2. Jobspec: same run shape, edit plugins/muse/jobspecs/
 *       judge.md mid-run: refused loudly naming the jobspec.
 *   S3. Decide: same run shape, edit src/decision-model.ts
 *       mid-run (mean >= threshold forced true): refused loudly
 *       naming decision-model.ts.
 *   S4. Mock adapter: gate-held run, edit workflows/bugfix-worker.ts
 *       mid-run: refused loudly naming it (the live runBugfix
 *       import) — then restore, re-queue, and the run completes
 *       with the simulated reproduce result.
 *   S5. Briefing adapter: edit workflows/briefing-worker.ts
 *       mid-run: refused loudly naming it (refusal-only: the
 *       discover step does live arXiv fetches, so no control leg
 *       executes it).
 *   S6. Briefing-prep exec: edit workflows/briefing-prep.ts
 *       mid-run: refused loudly naming it — then restore, re-queue,
 *       and the run completes with prep exit code 0.
 *   S7. Pool jobspec snapshot (worker-server level): enqueue a job,
 *       edit the jobspec, GET /jobspec?hash=<enqueue-time hash>
 *       still serves the ORIGINAL prose (and a worker-loop run
 *       against the edited file reads the snapshot, not the live
 *       file), while a hash-less GET serves the new prose.
 *   S8. Structural pin precision: the queue entry's trapPin holds
 *       exactly the run's trap code — worker + jobspec +
 *       decision-model + adapter files, each hash matching the live
 *       file — and NOT the bugfix/briefing workers or
 *       briefing-prep (no spec references them); the run then
 *       completes with the original output (happy-path control).
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra89.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra88 suite.)
 *
 * The test edits the repo's worker.ts, decision-model.ts,
 * bugfix-worker.ts, briefing-worker.ts, briefing-prep.ts and
 * jobspecs/judge.md + improve-judge.md mid-run. It snapshots the
 * known originals at startup (and refuses to start when a leftover
 * "bra89-test-edit" marker is already present, so a killed run's
 * edit is never mistaken for the original) and restores them in a
 * finally block. Each scenario uses its own state dir. The drive
 * child processes are killed in a finally block, even on failure.
 * Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): legacy runs submitted
 * before BRA-89 carry no pin and proceed unchecked (grandfathered);
 * muse pool worker SCRIPTS (the pool workers' own --workers-config)
 * are not pinned — the host never sees them — only the jobspec
 * prose they read is (pinned + snapshotted); host core source
 * (host.ts, extract.ts, ...) is not pinned either — the checker
 * cannot check itself from inside.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { WorkerServer, serverConfigFromArgs } from "../src/worker-server";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA89_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra89-"));
fs.mkdirSync(WORKDIR, { recursive: true });

const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra89.ts");
const WORKFLOW_MOCK = path.join(ROOT, "tests", "workflows", "workflow-bra89-mock.ts");
const WORKFLOW_BRIEFING = path.join(ROOT, "tests", "workflows", "workflow-bra89-briefing.ts");
const WORKFLOW_PREP = path.join(ROOT, "tests", "workflows", "workflow-bra89-briefing-prep.ts");

const WORKER = path.join(ROOT, "workflows", "worker.ts");
const DECISION_MODEL = path.join(ROOT, "src", "decision-model.ts");
const JOBSPEC_JUDGE = path.join(ROOT, "plugins", "muse", "jobspecs", "judge.md");
const JOBSPEC_IMPROVE_JUDGE = path.join(ROOT, "plugins", "muse", "jobspecs", "improve-judge.md");
const BUGFIX_WORKER = path.join(ROOT, "workflows", "bugfix-worker.ts");
const BRIEFING_WORKER = path.join(ROOT, "workflows", "briefing-worker.ts");
const BRIEFING_PREP = path.join(ROOT, "workflows", "briefing-prep.ts");

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
const sha = (p: string): string => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function stateDirFor(name: string): string {
  const d = path.join(WORKDIR, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Drive the queue in a child process (the CLI blocks in the exec
 * trap; this process must stay free to kill it). */
function driveChild(stateDir: string): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", stateDir], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
}

const queuePath = (stateDir: string): string => path.join(stateDir, "queue.json");
const journalPath = (stateDir: string, runId: string): string => path.join(stateDir, "journals", `${runId}.journal`);
const blobPath = (stateDir: string, runId: string): string => path.join(stateDir, "blobs", `${runId}.snap`);

function readQueueStrict(stateDir: string): any[] {
  return JSON.parse(fs.readFileSync(queuePath(stateDir), "utf8"));
}
function queueEntry(stateDir: string, runId: string): any | null {
  try {
    return readQueueStrict(stateDir).find((e) => e.runId === runId) ?? null;
  } catch {
    return null;
  }
}
function queueStatus(stateDir: string, runId: string): string | null {
  return queueEntry(stateDir, runId)?.status ?? null;
}
function setQueueStatus(stateDir: string, runId: string, status: string): boolean {
  if (!fs.existsSync(queuePath(stateDir))) return false;
  const q = JSON.parse(fs.readFileSync(queuePath(stateDir), "utf8"));
  const e = q.find((x: any) => x.runId === runId);
  if (!e) return false;
  e.status = status;
  fs.writeFileSync(queuePath(stateDir), JSON.stringify(q, null, 2));
  return true;
}
/** Good journal events only (tolerant parse, as the Host loads). */
function readJournal(stateDir: string, runId: string): any[] {
  const p = journalPath(stateDir, runId);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        const v = JSON.parse(l);
        return v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as any).event === "string" ? v : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
function markerLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
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

function submit(stateDir: string, workflow: string, runId: string, input: unknown, adapter: string, extraArgs: string[] = []): string {
  const inputFile = path.join(WORKDIR, `${runId}.input.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const r = cli(["run", workflow, "--run-id", runId, "--input-file", inputFile, "--adapter", adapter, "--state-dir", stateDir, ...extraArgs]);
  check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `SUBMIT OK: ${runId} submitted under ${adapter} (rc ${r.rc}${r.rc !== 0 ? ` err=${r.err.slice(0, 300)}` : ""})`);
  return runId;
}

function getResult(stateDir: string, runId: string): { status: string; output?: unknown; error?: string } | null {
  const r = cli(["result", runId, "--state-dir", stateDir]);
  if (r.rc === 0) {
    try {
      return { status: "done", output: JSON.parse(r.out) };
    } catch {
      return null;
    }
  }
  if (r.rc === 1) {
    const m = r.err.match(/^run \S+ failed: ([\s\S]*)$/);
    return m ? { status: "failed", error: m[1].trim() } : null;
  }
  return null;
}

/** Strand a run: drive it in a child, wait for the entry to flip
 * to "running" AND the marker file to appear (the exec trap has
 * dispatched — the run is suspended with a registry entry and a
 * snapshot blob on disk), then SIGKILL the child. */
async function strandRun(stateDir: string, runId: string, marker: string): Promise<Subprocess> {
  const child = driveChild(stateDir);
  const flipped = await waitFor(() => queueStatus(stateDir, runId) === "running", 10_000, `${runId} entry -> running`);
  check(flipped, `STRAND OK: ${runId} entry flipped to running before the kill`);
  const dispatched = await waitFor(() => markerLines(marker).length >= 1, 10_000, `${runId} marker written (exec dispatched)`);
  check(dispatched, `STRAND OK: ${runId} exec dispatched (marker written) before the kill`);
  child.kill(9);
  await child.exited;
  check(queueStatus(stateDir, runId) === "running", `STRAND OK: ${runId} entry still "running" after the kill (stranded, not driven)`);
  return child;
}

const children: Subprocess[] = [];

// ---------------------------------------------------------------- edited files
// Snapshot-at-startup + restore-in-finally (these files are too big
// to embed as literals, so the test refuses to start when a leftover
// "bra89-test-edit" marker is already present — a killed run's edit
// is never mistaken for the original).
const EDITED_FILES = [WORKER, DECISION_MODEL, JOBSPEC_JUDGE, JOBSPEC_IMPROVE_JUDGE, BUGFIX_WORKER, BRIEFING_WORKER, BRIEFING_PREP];
const ORIGINALS = new Map<string, string>();
function snapshotOriginals(): void {
  for (const f of EDITED_FILES) {
    const text = fs.readFileSync(f, "utf8");
    if (text.includes("bra89-test-edit")) {
      fail(`EDIT SETUP: ${f} already contains a leftover "bra89-test-edit" marker — restore the file by hand before running this test`);
    }
    ORIGINALS.set(f, text);
  }
}
function restoreOriginals(): void {
  for (const [f, text] of ORIGINALS) {
    try {
      fs.writeFileSync(f, text);
    } catch {
      /* best-effort restore; the startup check above reports leftovers */
    }
  }
}
function editFile(file: string, from: string, to: string, what: string): void {
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes(from)) {
    fail(`EDIT SETUP: replacement for ${what} did not match in ${file} — the fixture literal drifted`);
    return;
  }
  if (src.split(from).length - 1 !== 1) {
    fail(`EDIT SETUP: replacement for ${what} matched ${src.split(from).length - 1} times in ${file} — the anchor is not unique`);
    return;
  }
  fs.writeFileSync(file, src.replace(from, to));
}
function appendFile(file: string, text: string): void {
  fs.appendFileSync(file, text);
}

/** The pin files for a run, as absolute paths (from the queue entry). */
function pinFiles(stateDir: string, runId: string): string[] {
  const e = queueEntry(stateDir, runId);
  const files = e?.trapPin?.files;
  return files && typeof files === "object" ? Object.keys(files as Record<string, string>) : [];
}
function pinHas(stateDir: string, runId: string, suffix: string): boolean {
  return pinFiles(stateDir, runId).some((f) => f.endsWith(suffix));
}

/** Shared refusal assertions after a drive that must have failed
 * on a trap-code mismatch naming `suffix`. */
function assertRefused(stateDir: string, runId: string, marker: string, suffix: string, scenario: string): void {
  check(queueStatus(stateDir, runId) === "failed", `${scenario} FAILED: entry marked failed (got ${queueStatus(stateDir, runId)})`);
  const res = getResult(stateDir, runId);
  check(res !== null && res.status === "failed", `${scenario} RESULT: result reports failed (got ${JSON.stringify(res)?.slice(0, 120)})`);
  check(
    typeof res?.error === "string" && res.error.includes("trap-code pin mismatch") && res.error.includes(suffix),
    `${scenario} ERROR: refusal names the pin mismatch and ${suffix} (got ${JSON.stringify(res?.error)?.slice(0, 300)})`,
  );
  const evs = readJournal(stateDir, runId);
  const mismatch = evs.find((e) => e.event === "trap-code-mismatch");
  check(mismatch !== undefined, `${scenario} JOURNAL: trap-code-mismatch event recorded`);
  check(
    mismatch !== undefined && typeof mismatch.file === "string" && mismatch.file.endsWith(suffix),
    `${scenario} JOURNAL: mismatch event names ${suffix} (got ${mismatch?.file})`,
  );
  check(
    mismatch !== undefined && typeof mismatch.recorded === "string" && mismatch.recorded.length === 64 && typeof mismatch.current === "string" && mismatch.current.length === 64,
    `${scenario} JOURNAL: mismatch event carries full recorded + current sha256 hashes`,
  );
  check(fs.existsSync(blobPath(stateDir, runId)), `${scenario} BLOB KEPT: snapshot blob still on disk after the refusal (restoring the file can still resume it)`);
  if (fs.existsSync(marker)) {
    check(markerLines(marker).every((l) => l === "bra89-original"), `${scenario} MARKER: only the original marker ran (got ${JSON.stringify(markerLines(marker))})`);
  }
}

function driveOk(stateDir: string, scenario: string): void {
  const drive = cli(["queue", "run", "--state-dir", stateDir]);
  check(drive.rc === 0, `${scenario} DRIVE OK: queue run exited 0 (got ${drive.rc}${drive.rc !== 0 ? ` out=${drive.out.slice(0, 300)}` : ""})`);
}
function driveFails(stateDir: string, scenario: string): void {
  const drive = cli(["queue", "run", "--state-dir", stateDir]);
  check(drive.rc === 1, `${scenario} DRIVE RC: queue run exited 1 (the entry failed on this drive, got ${drive.rc})`);
}

const EXPECTED_OUTPUT = { marker: "original", judgeScore: 0, decision: "revise" };

async function scenarioS1(): Promise<void> {
  console.log("\n=== S1. direct worker edited mid-run: loud refusal, then restore + resume on the original ===");
  const stateDir = stateDirFor("s1");
  const runId = "bra89-s1";
  const marker = path.join(WORKDIR, "bra89-s1.marker");
  submit(stateDir, WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 }, "direct");
  check(pinHas(stateDir, runId, "workflows/worker.ts"), "S1 PIN: trap pin includes workflows/worker.ts");
  check(pinHas(stateDir, runId, "plugins/muse/jobspecs/judge.md"), "S1 PIN: trap pin includes the judge jobspec");
  check(pinHas(stateDir, runId, "src/decision-model.ts"), "S1 PIN: trap pin includes decision-model.ts");
  const child = await strandRun(stateDir, runId, marker);
  children.push(child);
  editFile(
    WORKER,
    "const score = Math.min(0.98, Math.round((base + 0.05 * revisionsOf(text)) * 100) / 100);",
    "const score = 0.99; /* bra89-test-edit */",
    "edited judge score",
  );
  driveFails(stateDir, "S1");
  assertRefused(stateDir, runId, marker, "workflows/worker.ts", "S1");
  // Restore + re-queue by hand: the run resumes and completes with
  // the ORIGINAL score 0 and decision "revise" — the edited worker
  // (0.99) never answers a trap.
  restoreOriginals();
  snapshotOriginals();
  check(setQueueStatus(stateDir, runId, "queued"), "S1 REQUEUE: entry set back to queued by hand");
  driveOk(stateDir, "S1");
  const res = getResult(stateDir, runId);
  check(res !== null && res.status === "done", `S1 RESULT: run done after restore (got ${JSON.stringify(res)?.slice(0, 120)})`);
  check(
    res !== null && JSON.stringify(res.output) === JSON.stringify(EXPECTED_OUTPUT),
    `S1 OUTPUT: original output ${JSON.stringify(EXPECTED_OUTPUT)} (got ${JSON.stringify(res?.output)})`,
  );
  check(markerLines(marker).every((l) => l === "bra89-original"), "S1 MARKER: only the original marker, never the edited one");
}

async function scenarioS2(): Promise<void> {
  console.log("\n=== S2. jobspec edited mid-run: loud refusal naming the jobspec ===");
  const stateDir = stateDirFor("s2");
  const runId = "bra89-s2";
  const marker = path.join(WORKDIR, "bra89-s2.marker");
  submit(stateDir, WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 }, "direct");
  const child = await strandRun(stateDir, runId, marker);
  children.push(child);
  appendFile(JOBSPEC_JUDGE, "\n<!-- bra89-test-edit -->\n");
  driveFails(stateDir, "S2");
  assertRefused(stateDir, runId, marker, "plugins/muse/jobspecs/judge.md", "S2");
  restoreOriginals();
  snapshotOriginals();
}

async function scenarioS3(): Promise<void> {
  console.log("\n=== S3. decision-model edited mid-run: loud refusal naming decision-model.ts ===");
  const stateDir = stateDirFor("s3");
  const runId = "bra89-s3";
  const marker = path.join(WORKDIR, "bra89-s3.marker");
  submit(stateDir, WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 }, "direct");
  const child = await strandRun(stateDir, runId, marker);
  children.push(child);
  editFile(
    DECISION_MODEL,
    "if (mean >= threshold) {",
    "if (/* bra89-test-edit */ true) {",
    "forced converge branch",
  );
  driveFails(stateDir, "S3");
  assertRefused(stateDir, runId, marker, "src/decision-model.ts", "S3");
  restoreOriginals();
  snapshotOriginals();
}

async function scenarioS4(): Promise<void> {
  console.log("\n=== S4. mock adapter: bugfix-worker edited mid-run, then restore + resume ===");
  const stateDir = stateDirFor("s4");
  const runId = "bra89-s4";
  submit(stateDir, WORKFLOW_MOCK, runId, { repoRoot: ROOT, workflow: "tests/workflows/workflow-judge-fix-loop.ts" }, "mock", ["--gates", "hold"]);
  check(pinHas(stateDir, runId, "workflows/bugfix-worker.ts"), "S4 PIN: trap pin includes workflows/bugfix-worker.ts (the live runBugfix import)");
  // Drive in a child: the run holds at the gate and the drive exits
  // on its own (rc 0, no failed entries) — no SIGKILL needed. The
  // drive process builds its own host, so --gates hold must be
  // passed here too (the submit's --gates hold only configured the
  // submitting process's adapter, which never drives).
  const drive1 = cli(["queue", "run", "--gates", "hold", "--state-dir", stateDir]);
  check(drive1.rc === 0, `S4 HELD DRIVE OK: queue run exited 0 (got ${drive1.rc})`);
  check(queueStatus(stateDir, runId) === "held", `S4 HELD: entry is held at the gate (got ${queueStatus(stateDir, runId)})`);
  editFile(
    BUGFIX_WORKER,
    "loops: bugPresent ? 6 : 5,",
    "loops: bugPresent ? 66 : 55, /* bra89-test-edit */",
    "edited simulate loops",
  );
  const dg = cli(["deliver-gate", runId, '{"answer":"yes"}', "--state-dir", stateDir]);
  check(dg.rc === 0, `S4 DELIVER OK: deliver-gate exited 0 (got ${dg.rc}${dg.rc !== 0 ? ` err=${dg.err.slice(0, 200)}` : ""})`);
  driveFails(stateDir, "S4");
  assertRefused(stateDir, runId, path.join(WORKDIR, "bra89-s4.marker"), "workflows/bugfix-worker.ts", "S4");
  // The gate trap's answer was journaled (trap-dispatched) before
  // the job trap refused, so the recovery drive re-delivers it
  // without needing another deliver-gate.
  restoreOriginals();
  snapshotOriginals();
  check(setQueueStatus(stateDir, runId, "queued"), "S4 REQUEUE: entry set back to queued by hand");
  driveOk(stateDir, "S4");
  const res = getResult(stateDir, runId);
  const expected = { gateAnswer: "yes", reproduced: false, loops: 5, converged: true, mean: 0.85, simulated: true };
  check(res !== null && res.status === "done", `S4 RESULT: run done after restore (got ${JSON.stringify(res)?.slice(0, 120)})`);
  check(
    res !== null && JSON.stringify(res.output) === JSON.stringify(expected),
    `S4 OUTPUT: simulated reproduce result ${JSON.stringify(expected)} (got ${JSON.stringify(res?.output)})`,
  );
}

async function scenarioS5(): Promise<void> {
  console.log("\n=== S5. briefing adapter: briefing-worker edited mid-run ===");
  const stateDir = stateDirFor("s5");
  const runId = "bra89-s5";
  const marker = path.join(WORKDIR, "bra89-s5.marker");
  const seenPath = path.join(WORKDIR, "bra89-s5-seen.md");
  fs.writeFileSync(seenPath, "");
  submit(stateDir, WORKFLOW_BRIEFING, runId, { markerFile: marker, sleepMs: 5000, seenPath, endDate: "2026-11-16" }, "briefing");
  check(pinHas(stateDir, runId, "workflows/briefing-worker.ts"), "S5 PIN: trap pin includes workflows/briefing-worker.ts");
  const child = await strandRun(stateDir, runId, marker);
  children.push(child);
  editFile(BRIEFING_WORKER, "dogfood/0.1", "dogfood/9.9-bra89-test-edit", "edited worker user-agent");
  driveFails(stateDir, "S5");
  assertRefused(stateDir, runId, marker, "workflows/briefing-worker.ts", "S5");
  restoreOriginals();
  snapshotOriginals();
}

async function scenarioS6(): Promise<void> {
  console.log("\n=== S6. briefing-prep exec edited mid-run, then restore + resume ===");
  const stateDir = stateDirFor("s6");
  const runId = "bra89-s6";
  const marker = path.join(WORKDIR, "bra89-s6.marker");
  const scratchDir = path.join(WORKDIR, "bra89-s6-scratch");
  submit(stateDir, WORKFLOW_PREP, runId, { markerFile: marker, sleepMs: 5000, scratchDir }, "direct");
  check(pinHas(stateDir, runId, "workflows/briefing-prep.ts"), "S6 PIN: trap pin includes workflows/briefing-prep.ts (closure scan found the exec'd script)");
  const child = await strandRun(stateDir, runId, marker);
  children.push(child);
  editFile(BRIEFING_PREP, "copied: copies.length", "copied: 999 /* bra89-test-edit */", "edited prep copy count");
  driveFails(stateDir, "S6");
  assertRefused(stateDir, runId, marker, "workflows/briefing-prep.ts", "S6");
  restoreOriginals();
  snapshotOriginals();
  check(setQueueStatus(stateDir, runId, "queued"), "S6 REQUEUE: entry set back to queued by hand");
  driveOk(stateDir, "S6");
  const res = getResult(stateDir, runId);
  check(res !== null && res.status === "done", `S6 RESULT: run done after restore (got ${JSON.stringify(res)?.slice(0, 120)})`);
  check(
    res !== null && (res.output as any)?.marker === "original" && (res.output as any)?.prepExitCode === 0,
    `S6 OUTPUT: original marker + prep exit code 0 (got ${JSON.stringify(res?.output)})`,
  );
  check(markerLines(marker).every((l) => l === "bra89-original"), "S6 MARKER: only the original marker, never the edited one");
}

async function scenarioS7(): Promise<void> {
  console.log("\n=== S7. pool jobspec snapshot: an enqueued job keeps its enqueue-time prose ===");
  const stateDir = stateDirFor("s7");
  const port = 20000 + Math.floor(Math.random() * 9000);
  const serverUrl = `http://127.0.0.1:${port}`;
  const server = new WorkerServer(serverConfigFromArgs(["--state-dir", stateDir, "--port", String(port)]));
  server.start();
  try {
    const http = async (method: "GET" | "POST", p: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${serverUrl}${p}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      });
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { _raw: text.slice(0, 300) };
      }
      return { status: res.status, body: parsed };
    };
    const enq = await http("POST", "/enqueue", {
      spec: "improve-judge",
      input: {
        item: { kind: "document", description: "t", content: "The fox sat." },
        rubric: { criteria: [{ name: "vivid", description: "d" }], threshold: 0.8 },
        judge: 0,
      },
      runId: "bra89-s7",
      trapId: "bra89-s7/trap-0",
    });
    check(enq.status === 200 && typeof enq.body?.jobId === "string", `S7 ENQUEUE: job enqueued (got HTTP ${enq.status} ${JSON.stringify(enq.body)?.slice(0, 120)})`);
    const jobId = enq.body.jobId as string;
    const st = await http("GET", `/job-status?jobId=${encodeURIComponent(jobId)}`);
    const specHash = st.body?.specHash as string | null;
    check(typeof specHash === "string" && /^[0-9a-f]{64}$/.test(specHash), `S7 SPECHASH: job carries a sha256 spec hash (got ${specHash})`);
    const before = await http("GET", `/jobspec?spec=improve-judge&hash=${specHash}`);
    check(
      before.status === 200 && typeof before.body?.text === "string" && before.body.text.includes("# Job spec: improve-judge") && !before.body.text.includes("bra89-test-edit"),
      "S7 SNAPSHOT: pinned GET serves the original prose before any edit",
    );
    const snapPath = path.join(stateDir, "worker-jobs", "jobspecs", `${specHash}.md`);
    check(
      fs.existsSync(snapPath) && fs.readFileSync(snapPath, "utf8") === before.body.text,
      `S7 SNAPSHOT FILE: content-addressed snapshot exists under worker-jobs/jobspecs/${String(specHash).slice(0, 12)}….md`,
    );
    // Edit the live jobspec: the pinned GET must still serve the
    // original, while a hash-less GET serves the new prose.
    appendFile(JOBSPEC_IMPROVE_JUDGE, "\n<!-- bra89-test-edit -->\n");
    const pinned = await http("GET", `/jobspec?spec=improve-judge&hash=${specHash}`);
    check(
      pinned.status === 200 && pinned.body?.hash === specHash && typeof pinned.body?.text === "string" && !pinned.body.text.includes("bra89-test-edit"),
      "S7 PINNED READ: GET with the enqueue-time hash still serves the ORIGINAL prose after the live edit",
    );
    const live = await http("GET", "/jobspec?spec=improve-judge");
    check(
      live.status === 200 && typeof live.body?.text === "string" && live.body.text.includes("bra89-test-edit") && live.body?.hash !== specHash,
      "S7 LIVE READ: hash-less GET serves the NEW prose with its new hash (the live file did change — only pinned reads are frozen)",
    );
    // A worker-loop run against the edited file must read the
    // snapshot, not the live file — and complete the job.
    const workersJson = path.join(WORKDIR, "bra89-s7-workers.json");
    fs.writeFileSync(workersJson, JSON.stringify({ "improve-judge": path.join(ROOT, "workflows", "worker.ts") }));
    const workspaces = path.join(WORKDIR, "bra89-s7-workspaces");
    const loop = spawn(
      [BUN, path.join(ROOT, "plugins", "muse", "worker-loop.ts"), "--server", serverUrl, "--worker-id", "w-bra89", "--workspace-root", workspaces, "--workers-config", workersJson, "--poll-ms", "300", "--once"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    children.push(loop);
    const exited = await Promise.race([
      loop.exited.then((c: number) => ({ code: c, timedOut: false })),
      sleep(60_000).then(() => ({ code: -1, timedOut: true })),
    ]);
    check(!exited.timedOut, "S7 LOOP: worker-loop exited within 60s");
    check(exited.code === 0, `S7 LOOP RC: worker-loop exited 0 (got ${exited.code})`);
    const after = await http("GET", `/job-status?jobId=${encodeURIComponent(jobId)}`);
    check(after.body?.status === "completed", `S7 JOB: job completed (got ${after.body?.status})`);
    const workerSpec = path.join(workspaces, "specs", "improve-judge.md");
    check(
      fs.existsSync(workerSpec) && !fs.readFileSync(workerSpec, "utf8").includes("bra89-test-edit"),
      "S7 WORKER READ: the pool worker's cached spec is the ORIGINAL prose, not the edited live file",
    );
    restoreOriginals();
    snapshotOriginals();
  } finally {
    server.stop();
  }
}

async function scenarioS8(): Promise<void> {
  console.log("\n=== S8. structural pin precision + happy-path control ===");
  const stateDir = stateDirFor("s8");
  const runId = "bra89-s8";
  const marker = path.join(WORKDIR, "bra89-s8.marker");
  submit(stateDir, WORKFLOW, runId, { markerFile: marker, sleepMs: 0 }, "direct");
  const files = pinFiles(stateDir, runId);
  check(files.length > 0, `S8 PIN EXISTS: queue entry records a trap pin (${files.length} files)`);
  for (const suffix of [
    "workflows/worker.ts",
    "plugins/muse/jobspecs/judge.md",
    "src/decision-model.ts",
    "plugins/direct/src/direct-adapter.ts",
    "plugins/direct/src/adapter.ts",
  ]) {
    check(pinHas(stateDir, runId, suffix), `S8 PIN INCLUDES: ${suffix}`);
  }
  for (const suffix of ["workflows/bugfix-worker.ts", "workflows/briefing-worker.ts", "workflows/briefing-prep.ts"]) {
    check(!pinHas(stateDir, runId, suffix), `S8 PIN EXCLUDES: ${suffix} (no spec references it)`);
  }
  const e = queueEntry(stateDir, runId);
  let hashesOk = true;
  for (const [f, h] of Object.entries((e?.trapPin?.files ?? {}) as Record<string, string>)) {
    if (!fs.existsSync(f) || sha(f) !== h) {
      hashesOk = false;
      fail(`S8 PIN HASH: pinned file ${f} does not hash to its recorded value`);
    }
  }
  check(hashesOk, "S8 PIN HASHES: every pinned file hashes to its recorded value");
  // Happy path, nothing edited: the run completes on the original code.
  driveOk(stateDir, "S8");
  const res = getResult(stateDir, runId);
  check(res !== null && res.status === "done", `S8 RESULT: run done (got ${JSON.stringify(res)?.slice(0, 120)})`);
  check(
    res !== null && JSON.stringify(res.output) === JSON.stringify(EXPECTED_OUTPUT),
    `S8 OUTPUT: original output ${JSON.stringify(EXPECTED_OUTPUT)} (got ${JSON.stringify(res?.output)})`,
  );
}

async function main(): Promise<void> {
  snapshotOriginals();
  if (FAILURES.length) {
    console.log("");
    console.log(`BRA89 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    process.exit(1);
  }
  try {
    await scenarioS1();
    await scenarioS2();
    await scenarioS3();
    await scenarioS4();
    await scenarioS5();
    await scenarioS6();
    await scenarioS7();
    await scenarioS8();
  } finally {
    restoreOriginals();
    for (const c of children) {
      try {
        c.kill(9);
      } catch {
        /* already dead */
      }
    }
  }
  console.log("");
  if (FAILURES.length) {
    console.log(`BRA89 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("BRA89 PASS: trap-code pin refuses changed trap code, restore + resume recovers (direct/jobspec/decide/mock/briefing/prep/pool-snapshot)");
  process.exit(0);
}

await main();
