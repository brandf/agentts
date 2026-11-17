#!/usr/bin/env bun
/**
 * State-dir relocation test (Linear BRA-85).
 *
 * A state dir is the sole carrier of run state, but before BRA-85 the
 * registry (runs/<run>.json) and queue.json pinned ABSOLUTE paths
 * under the original state dir (frozenPath, snap, out, log), so a
 * state dir copied or moved to a new path could not resume its
 * suspended runs: `queue run` failed loudly with "frozen copy
 * missing for run ... (hash ...) was deleted".
 *
 * The fix (host.ts, BRA-85): frozenPath is stored state-dir-relative
 * ("frozen/<hash>/...") going forward, and every stored path is
 * rebased against the CURRENT state dir at load (readQueue,
 * registerLoadedRunEntry) and defensively at use (requireFrozen) —
 * preferring the copy under this state dir, falling back to the
 * stored absolute path when it exists (legacy non-moved dirs keep
 * working), never silently dropping a run.
 *
 *   A. Issue repro end-to-end (gate run, new relative form): submit
 *      a gate run (workflow-gate-hold.ts, direct adapter), drive it
 *      to held, `cp -r` the state dir to a new location, delete the
 *      original. `queue list` and `deliver-gate` work against the
 *      copy, and `queue run` against the copy completes the run
 *      (result { done: true }). Also asserts the stored form on
 *      disk: queue.json's frozenPath is relative, and after
 *      deliver-gate the rewritten runs/<run>.json points its
 *      snap/out/log under the NEW state dir.
 *   B. Legacy absolute-path state dir still resumes WITHOUT
 *      relocation (no behavior change for the non-moved case): the
 *      stored frozenPath in queue.json + runs/<run>.json is
 *      rewritten to the absolute pre-BRA-85 form, then deliver-gate
 *      + `queue run` against the SAME dir completes the run.
 *   C. Legacy absolute-path state dir, RELOCATED: same rewrite as
 *      B, then `cp -r` to a new location and delete the original —
 *      deliver-gate + `queue run` against the copy completes the
 *      run. Old on-disk state dirs relocate too, not just new ones.
 *   D. Registry snap/out/log rebase (exec trap, not just a gate):
 *      strand an exec run mid-sleep (SIGKILL mid-drive, blob
 *      intact), rewrite its stored frozenPath to the legacy absolute
 *      form, `cp -r` to a new location, delete the original, `queue
 *      repair` re-queues it, `queue run` completes it from the
 *      rebased snapshot (result exitCode 0). This proves the snap
 *      path rebase works — a gate-only test would only prove
 *      frozenPath.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra85.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra84 suite.)
 *
 * Run outputs go to $BRA85_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The drive child processes are killed in a
 * finally block, even on failure. Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): journal events keep
 * their historical absolute workflowPath/bundlePath (display only —
 * the profiler reads them, it never executes from them), so a
 * relocated dir's profile still shows the old paths for pre-move
 * runs. And a state dir copied WITHOUT deleting the original is not
 * exercised: the rebase prefers the copy under the current state
 * dir, so the copy executes from its own files, but the test does
 * not assert the original is untouched in that case.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { Host } from "../src/host";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA85_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra85-"));

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
function driveChild(stateDir: string): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", stateDir], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
}

const stateDir = (name: string): string => {
  const d = path.join(WORKDIR, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const queuePath = (sd: string): string => path.join(sd, "queue.json");
const runEntryPath = (sd: string, runId: string): string => path.join(sd, "runs", `${runId}.json`);

function readQueueStrict(sd: string): any[] {
  return JSON.parse(fs.readFileSync(queuePath(sd), "utf8"));
}
function queueEntry(sd: string, runId: string): any | null {
  try {
    return readQueueStrict(sd).find((e) => e.runId === runId) ?? null;
  } catch {
    return null;
  }
}
function queueStatus(sd: string, runId: string): string | null {
  return queueEntry(sd, runId)?.status ?? null;
}
function readRunEntry(sd: string, runId: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(runEntryPath(sd, runId), "utf8"));
  } catch {
    return null;
  }
}
function getResult(sd: string, runId: string): any | null {
  const r = cli(["result", runId, "--state-dir", sd]);
  if (r.rc !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
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

/** `cp -r` a state dir to a new location and delete the original —
 * the move in the issue, verbatim (cp, not rename, so no inode is
 * shared with the original). */
function relocate(src: string, dest: string): void {
  const cp = spawnSync("cp", ["-r", src, dest], { encoding: "utf8" });
  check(cp.status === 0, `RELOCATE OK: cp -r ${path.basename(src)} -> ${path.basename(dest)} (rc ${cp.status})`);
  fs.rmSync(src, { recursive: true, force: true });
  check(!fs.existsSync(src), `RELOCATE OK: original ${path.basename(src)} deleted after the copy`);
  check(fs.existsSync(path.join(dest, "queue.json")), `RELOCATE OK: copy holds queue.json`);
}

/**
 * Rewrite the stored frozenPath in queue.json + runs/<run>.json to
 * the ABSOLUTE pre-BRA-85 form (absolute path under the given state
 * dir), simulating a state dir written before BRA-85. snap/out/log
 * are already stored absolute, so only frozenPath needs rewriting.
 */
function rewriteStoredFrozenAbsolute(sd: string, runId: string): void {
  const relToAbs = (stored: string): string =>
    path.isAbsolute(stored) ? stored : path.join(sd, stored);
  const qp = queuePath(sd);
  const q = JSON.parse(fs.readFileSync(qp, "utf8"));
  const qe = q.find((e: any) => e.runId === runId);
  check(typeof qe?.frozenPath === "string", `LEGACY SETUP OK: queue entry for ${runId} carries a frozenPath to rewrite`);
  if (qe?.frozenPath) qe.frozenPath = relToAbs(qe.frozenPath);
  fs.writeFileSync(qp, JSON.stringify(q, null, 2));
  const rp = runEntryPath(sd, runId);
  const re = JSON.parse(fs.readFileSync(rp, "utf8"));
  check(typeof re?.frozenPath === "string", `LEGACY SETUP OK: registry entry for ${runId} carries a frozenPath to rewrite`);
  if (re?.frozenPath) re.frozenPath = relToAbs(re.frozenPath);
  fs.writeFileSync(rp, JSON.stringify(re, null, 2));
  check(
    path.isAbsolute(queueEntry(sd, runId)?.frozenPath ?? "") &&
      path.isAbsolute(readRunEntry(sd, runId)?.frozenPath ?? ""),
    `LEGACY SETUP OK: stored frozenPath is now absolute (pre-BRA-85 form) for ${runId}`,
  );
}

function submitGate(sd: string, runId: string): void {
  const r = cli([
    "run",
    path.join(ROOT, "tests", "workflows", "workflow-gate-hold.ts"),
    "--run-id",
    runId,
    "--adapter",
    "direct",
    "--state-dir",
    sd,
  ]);
  check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `SUBMIT OK: ${runId} submitted (rc ${r.rc})`);
}

function driveToHeld(sd: string, runId: string): void {
  const drive = cli(["queue", "run", "--state-dir", sd]);
  check(drive.rc === 0, `HOLD OK: queue run exited 0 driving ${runId} (got ${drive.rc})`);
  check(queueStatus(sd, runId) === "held", `HOLD OK: queue says ${runId} held (got ${queueStatus(sd, runId)})`);
  check(fs.existsSync(path.join(sd, "blobs", `${runId}.snap`)), `HOLD OK: blob persisted for ${runId}`);
}

/** deliver-gate + queue run against the given state dir, then assert
 * the run completed with { done: true }. */
function deliverAndComplete(sd: string, runId: string, tag: string): void {
  const del = cli(["deliver-gate", runId, '{"answer":"no"}', "--state-dir", sd]);
  check(del.rc === 0, `${tag} DELIVER OK: deliver-gate exited 0 (got ${del.rc})`);
  check(queueStatus(sd, runId) === "queued", `${tag} DELIVER OK: ${runId} re-queued after delivery (got ${queueStatus(sd, runId)})`);
  const drive = cli(["queue", "run", "--state-dir", sd]);
  check(drive.rc === 0, `${tag} DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  check(queueStatus(sd, runId) === "done", `${tag} DRIVE OK: queue says ${runId} done (got ${queueStatus(sd, runId)})`);
  const res = getResult(sd, runId);
  // NOTE: `agentts result` prints the run's output JSON directly
  // ({"done":true}), not a {status, output} envelope.
  check(
    res !== null && (res as any)?.done === true,
    `${tag} RESULT OK: result is { done: true } (got ${JSON.stringify(res)})`,
  );
}

const GATE_WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-gate-hold.ts");
const EXEC_WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts");

async function scenarioA(): Promise<void> {
  console.log("\n=== A. issue repro: gate run resumes after cp -r + delete (relative stored form) ===");
  const s1 = stateDir("a-state1");
  const s2 = path.join(WORKDIR, "a-state2");
  const runId = "bra85-a-gate";
  submitGate(s1, runId);
  // Stored form going forward: frozenPath is state-dir-relative.
  const stored = queueEntry(s1, runId)?.frozenPath;
  check(
    typeof stored === "string" && !path.isAbsolute(stored) && stored.startsWith("frozen/"),
    `A STORED OK: queue.json stores frozenPath relative (got ${stored})`,
  );
  driveToHeld(s1, runId);
  relocate(s1, s2);
  const list = cli(["queue", "list", "--state-dir", s2]);
  check(list.rc === 0 && list.out.includes(runId), `A LIST OK: queue list against the copy sees ${runId} (rc ${list.rc})`);
  check(queueStatus(s2, runId) === "held", `A LIST OK: copy says ${runId} held (got ${queueStatus(s2, runId)})`);
  const del = cli(["deliver-gate", runId, '{"answer":"no"}', "--state-dir", s2]);
  check(del.rc === 0, `A DELIVER OK: deliver-gate against the copy exited 0 (got ${del.rc})`);
  // Load-time rebase, checked directly in-process: a fresh Host over
  // the copy must see the registry snap under the NEW state dir even
  // though runs/<run>.json on disk still holds the old absolute
  // paths (deliver-gate does not drive, so it never rewrites the
  // entry — the rebase is in-memory at load, persisted on the next
  // save). The drive below is the behavioral proof for frozenPath.
  const probe = new Host({ stateDir: s2 });
  check(
    probe.registryHas(runId),
    `A REBASE OK: fresh Host over the copy loads the registry entry for ${runId}`,
  );
  check(
    probe.snapPath(runId) === path.join(s2, "slices", `${runId}.snap`),
    `A REBASE OK: registry snap resolves under the new state dir (got ${probe.snapPath(runId)})`,
  );
  const re = readRunEntry(s2, runId);
  check(
    typeof re?.frozenPath === "string" && !path.isAbsolute(re.frozenPath) && re.frozenPath.startsWith("frozen/"),
    `A REBASE OK: registry frozenPath stays stored relative (got ${re?.frozenPath})`,
  );
  const drive = cli(["queue", "run", "--state-dir", s2]);
  check(drive.rc === 0, `A DRIVE OK: queue run against the copy exited 0 (got ${drive.rc})`);
  check(queueStatus(s2, runId) === "done", `A DRIVE OK: queue says ${runId} done (got ${queueStatus(s2, runId)})`);
  const res = getResult(s2, runId);
  check(
    res !== null && (res as any)?.done === true,
    `A RESULT OK: result is { done: true } (got ${JSON.stringify(res)})`,
  );
}

async function scenarioB(): Promise<void> {
  console.log("\n=== B. legacy absolute-path state dir resumes WITHOUT relocation ===");
  const s1 = stateDir("b-state1");
  const runId = "bra85-b-gate";
  submitGate(s1, runId);
  driveToHeld(s1, runId);
  rewriteStoredFrozenAbsolute(s1, runId);
  deliverAndComplete(s1, runId, "B");
}

async function scenarioC(): Promise<void> {
  console.log("\n=== C. legacy absolute-path state dir resumes AFTER relocation ===");
  const s1 = stateDir("c-state1");
  const s2 = path.join(WORKDIR, "c-state2");
  const runId = "bra85-c-gate";
  submitGate(s1, runId);
  driveToHeld(s1, runId);
  rewriteStoredFrozenAbsolute(s1, runId);
  relocate(s1, s2);
  const list = cli(["queue", "list", "--state-dir", s2]);
  check(list.rc === 0 && list.out.includes(runId), `C LIST OK: queue list against the copy sees ${runId} (rc ${list.rc})`);
  deliverAndComplete(s2, runId, "C");
}

async function scenarioD(): Promise<void> {
  console.log("\n=== D. snap/out/log rebase: stranded exec run resumes after relocation ===");
  const s1 = stateDir("d-state1");
  const s2 = path.join(WORKDIR, "d-state2");
  const runId = "bra85-d-exec";
  const marker = path.join(WORKDIR, "bra85-d.marker");
  const inputFile = path.join(WORKDIR, "bra85-d.input.json");
  fs.writeFileSync(inputFile, JSON.stringify({ markerFile: marker, sleepMs: 5000 }));
  const sub = cli([
    "run",
    EXEC_WORKFLOW,
    "--run-id",
    runId,
    "--input-file",
    inputFile,
    "--adapter",
    "direct",
    "--state-dir",
    s1,
  ]);
  check(sub.rc === 0 && sub.out.includes(`RUN ${runId}`), `D SUBMIT OK: ${runId} submitted (rc ${sub.rc})`);
  // Strand it: drive in a child, wait for the exec to dispatch
  // (marker written — the run is suspended with a blob on disk),
  // then SIGKILL the driver.
  const child = driveChild(s1);
  try {
    const flipped = await waitFor(() => queueStatus(s1, runId) === "running", 10_000, `${runId} entry -> running`);
    check(flipped, `D STRAND OK: ${runId} entry flipped to running before the kill`);
    const dispatched = await waitFor(() => markerLines(marker) >= 1, 10_000, `${runId} marker written (exec dispatched)`);
    check(dispatched, `D STRAND OK: ${runId} exec dispatched (marker written) before the kill`);
    check(fs.existsSync(path.join(s1, "blobs", `${runId}.snap`)), `D STRAND OK: snapshot blob for ${runId} is on disk`);
  } finally {
    try {
      child.kill(9);
    } catch {
      /* already dead */
    }
    await child.exited;
  }
  check(queueStatus(s1, runId) === "running", `D STRAND OK: ${runId} entry still "running" after the kill`);
  // Legacy absolute stored form, then relocate — so this scenario
  // proves the snap rebase under the old on-disk shape, not only
  // under the new relative one.
  rewriteStoredFrozenAbsolute(s1, runId);
  relocate(s1, s2);
  const repair = cli(["queue", "repair", "--state-dir", s2]);
  check(repair.rc === 0, `D REPAIR OK: queue repair exited 0 (got ${repair.rc})`);
  check(
    repair.out.includes(`REPAIR ${runId}: running -> queued`),
    `D REPAIR OK: repair re-queued ${runId} (got ${repair.out.slice(0, 200)})`,
  );
  const drive = cli(["queue", "run", "--state-dir", s2]);
  check(drive.rc === 0, `D DRIVE OK: queue run against the copy exited 0 (got ${drive.rc})`);
  check(queueStatus(s2, runId) === "done", `D DRIVE OK: queue says ${runId} done (got ${queueStatus(s2, runId)})`);
  const res = getResult(s2, runId);
  check(
    res !== null && (res as any)?.exitCode === 0,
    `D RESULT OK: result exitCode 0 (got ${JSON.stringify(res)})`,
  );
  check(markerLines(marker) >= 1, `D MARKER OK: exec ran (marker has ${markerLines(marker)} line(s))`);
}

async function main(): Promise<void> {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  console.log("");
  if (FAILURES.length > 0) {
    console.log(`BRA85 FAIL: ${FAILURES.length} failure(s)`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("BRA85 PASS: state-dir relocation resumes suspended runs (gate + exec, relative + legacy-absolute stored forms)");
}

await main();
