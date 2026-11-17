#!/usr/bin/env bun
/**
 * Smaller robustness gaps test (Linear BRA-76 — G4 + G7 + G12, the
 * BRA-62 audit's smaller gaps).
 *
 * Proves the Host survives the three gaps BRA-77 did not cover:
 *
 *   A. Atomic snapshot writes (G4): the blob store write
 *      (storeBlob) is tmp+rename, so a crash mid-write leaves the
 *      previous blob intact — old or new, never torn — and a torn
 *      blob is never trusted.
 *      A1. Strand a run (SIGKILL mid-exec, as in BRA-72/77) and
 *          assert the stored blob is intact: it exists, is a real
 *          snapshot (>1KB), equals the live snap bytes (the
 *          suspension's snapshot, copied by storeBlob), no *.tmp
 *          file sits in blobs/, its sha is stable across a fresh
 *          Host load, and a fresh `queue run` resumes from it and
 *          completes the run.
 *      A2. A truncated blob (a torn write, as the pre-fix
 *          copyFileSync could leave) is NOT trusted: `queue run`
 *          exits 1, the entry is failed with a loud error naming
 *          the crashed resume and the blob path, the run is never
 *          marked done, and `result` returns no bogus output.
 *   B. Corrupt worker store (G7): a corrupt worker-jobs/store.json
 *      does NOT start fresh silently — it recovers from
 *      store.json.bak when the backup parses, or fails loudly when
 *      it does not. Same recover-from-backup /
 *      fail-loudly-only-if-backup-also-bad decision as BRA-77's
 *      queue recovery (G5), sharing corruption.ts.
 *      B1. Enqueue two jobs (the second save creates the backup),
 *          corrupt store.json: the restarted server comes up, GET
 *          /jobs shows the job from the backup (one save behind —
 *          the second job is gone, as with BRA-77 A1), stderr says
 *          CORRUPT WORKER STORE + recovered + store.json.bak,
 *          corruption.log records the recovery, and store.json on
 *          disk is restored to the backup content.
 *      B2. Garbage store.json + missing backup: the server process
 *          exits non-zero, stderr says "store.json is corrupt" and
 *          "store.json.bak is missing", /health never answers, and
 *          the garbage store.json is left untouched (no silent
 *          fresh start overwrote it).
 *      B3. store.json that parses but is not a store object, with a
 *          corrupt backup: same loud failure, naming the shape
 *          problem ("missing jobs/workers maps") and the backup
 *          ("also corrupt").
 *   C. Drive cap (G12): the 50-round cap is explicit, not latent.
 *      C1. A 60-sleep workflow (60 suspensions in one drive):
 *          `queue run` exits 1, the entry is failed with the
 *          DriveCapError message naming the 50-round cap, the run,
 *          and the remedy; the journal holds a `drive-cap` event
 *          (cap 50, rounds 51); the blob is intact from the last
 *          suspension; `result` returns no output.
 *      C2. Boundary: a 50-sleep workflow completes (done, 50
 *          sleeps) — the cap is exactly 50 and healthy runs under
 *          it are unaffected.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra76.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra74 suite.)
 *
 * Run outputs go to $BRA76_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The drive child processes and the worker
 * server are killed in a finally block, even on failure. Exit 0 on
 * PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): the C host's own live
 * -snap write (save_snapshot in durablets.c) is still plain
 * fopen/fwrite — the C core is out of scope for BRA-76, so a kill
 * mid-slice can still tear the transient live snap. The live snap
 * is re-created from the (now atomic) blob on resume, so a torn
 * live snap fails the slice loudly and the BRA-74 path resumes
 * from the intact blob — but the C-side tmp+rename is still open
 * work. And fsync is not used (same as the driver-lock heartbeat
 * and BRA-77): the threat model is a process crash, not power loss.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA76_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra76-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const WORKER_PORT = 18776;
const SERVER_URL = `http://127.0.0.1:${WORKER_PORT}`;

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

const queuePath = path.join(STATE_DIR, "queue.json");
const corruptionLogPath = path.join(STATE_DIR, "corruption.log");
const blobPath = (runId: string): string => path.join(STATE_DIR, "blobs", `${runId}.snap`);
const liveSnapPath = (runId: string): string => path.join(STATE_DIR, "slices", `${runId}.snap`);
const journalPath = (runId: string): string => path.join(STATE_DIR, "journals", `${runId}.journal`);
const storePath = path.join(STATE_DIR, "worker-jobs", "store.json");
const storeBackupPath = path.join(STATE_DIR, "worker-jobs", "store.json.bak");

function shaFile(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
function readQueueStrict(): any[] {
  return JSON.parse(fs.readFileSync(queuePath, "utf8"));
}
function queueStatus(runId: string): string | null {
  try {
    return readQueueStrict().find((e) => e.runId === runId)?.status ?? null;
  } catch {
    return null;
  }
}
function queueError(runId: string): string | null {
  try {
    return readQueueStrict().find((e) => e.runId === runId)?.error ?? null;
  } catch {
    return null;
  }
}
function markerLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}
/** Good journal events only (tolerant parse, as the Host loads). */
function readJournal(runId: string): any[] {
  const p = journalPath(runId);
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
function readCorruptionLog(): any[] {
  if (!fs.existsSync(corruptionLogPath)) return [];
  return fs
    .readFileSync(corruptionLogPath, "utf8")
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
const EXEC_WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts");
const SLEEPS_WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra76-many-sleeps.ts");

async function scenarioA(): Promise<void> {
  console.log("\n=== A. atomic snapshot writes (G4) ===");
  // A1: SIGKILL mid-drive — the stored blob is old or new, never torn.
  const runId = "bra76-a1";
  const marker = path.join(WORKDIR, "bra76-a1.marker");
  submit(EXEC_WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  const blob = blobPath(runId);
  check(fs.existsSync(blob), `A1 BLOB OK: stored blob exists for stranded ${runId}`);
  const blobSize = fs.existsSync(blob) ? fs.statSync(blob).size : 0;
  check(blobSize > 1000, `A1 BLOB OK: stored blob is a real snapshot (${blobSize} bytes, not a torn stub)`);
  const liveSnap = liveSnapPath(runId);
  check(
    fs.existsSync(liveSnap) && fs.existsSync(blob) && shaFile(blob) === shaFile(liveSnap),
    "A1 BLOB OK: stored blob bytes equal the live snap bytes (the suspension's snapshot, copied by storeBlob)",
  );
  const tmpFiles = fs.existsSync(path.join(STATE_DIR, "blobs"))
    ? fs.readdirSync(path.join(STATE_DIR, "blobs")).filter((f) => f.includes(".tmp"))
    : [];
  check(tmpFiles.length === 0, `A1 TMP OK: no *.tmp file sits in blobs/ after the kill (${tmpFiles.join(",") || "none"}) — an interrupted atomic write leaves at most a stray tmp, never a torn target`);
  // A fresh Host load does not rewrite the stored blob.
  const hashBefore = fs.existsSync(blob) ? shaFile(blob) : "";
  const list = cli(["queue", "list", "--state-dir", STATE_DIR]);
  check(list.rc === 0, `A1 LOAD OK: queue list exited 0 after the kill (got ${list.rc})`);
  check(
    fs.existsSync(blob) && shaFile(blob) === hashBefore,
    "A1 LOAD OK: stored blob sha is stable across a fresh Host load (loading never rewrites the blob)",
  );
  // The blob is intact: a fresh drive resumes from it and completes.
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `A1 RESUME OK: queue run exited 0 after the kill (got ${drive.rc})`);
  check(queueStatus(runId) === "done", `A1 RESUME OK: ${runId} done after resume from the blob`);
  const res = getResult(runId);
  check(res?.exitCode === 0, `A1 RESUME OK: ${runId} result returns the output after resume (exitCode ${res?.exitCode})`);

  // A2: a truncated blob (a torn write, as the pre-fix copyFileSync
  // could leave) is NOT trusted.
  const runId2 = "bra76-a2";
  const marker2 = path.join(WORKDIR, "bra76-a2.marker");
  submit(EXEC_WORKFLOW, runId2, { markerFile: marker2, sleepMs: 5000 });
  const child2 = await strandRun(runId2, marker2);
  children.push(child2);
  const blob2 = blobPath(runId2);
  check(fs.existsSync(blob2) && fs.statSync(blob2).size > 1000, `A2 SETUP OK: stored blob exists (${fs.existsSync(blob2) ? fs.statSync(blob2).size : 0} bytes) before truncation`);
  const full2 = fs.readFileSync(blob2);
  fs.writeFileSync(blob2, full2.subarray(0, 40));
  check(fs.statSync(blob2).size === 40, "A2 SETUP OK: blob truncated to 40 bytes (simulated torn write)");
  const drive2 = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive2.rc !== 0, `A2 LOUD OK: queue run exited non-zero on a torn blob (got ${drive2.rc})`);
  check(queueStatus(runId2) === "failed", `A2 LOUD OK: ${runId2} entry is failed (never silently completed from a torn blob)`);
  const err2 = queueError(runId2) ?? "";
  check(
    /crashed resuming/i.test(err2) && err2.includes("blobs/bra76-a2.snap"),
    `A2 LOUD OK: failure names the crashed resume and the blob path (error: ${err2.slice(0, 160)})`,
  );
  check(
    drive2.out.includes("failed bra76-a2"),
    "A2 LOUD OK: queue run printed the failed entry (the failure is visible, not swallowed)",
  );
  const res2 = getResult(runId2);
  check(res2 === null, `A2 LOUD OK: ${runId2} result returns no output (no bogus result from a torn blob)`);
}

// ------------------------------------------------------------ worker server (G7)
function serverChild(): Subprocess {
  return spawn(
    [BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", STATE_DIR, "--port", String(WORKER_PORT)],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
}
async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${SERVER_URL}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  return false;
}
async function serverJobs(): Promise<any[]> {
  const r = await fetch(`${SERVER_URL}/jobs`);
  if (!r.ok) return [];
  const body = (await r.json()) as { jobs?: any[] };
  return Array.isArray(body.jobs) ? body.jobs : [];
}
async function enqueueJob(spec: string, trapId: string): Promise<string | null> {
  const r = await fetch(`${SERVER_URL}/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec, runId: "bra76-b", trapId }),
  });
  if (!r.ok) return null;
  const body = (await r.json()) as { jobId?: string };
  return typeof body.jobId === "string" ? body.jobId : null;
}
async function stopServer(child: Subprocess): Promise<void> {
  try {
    child.kill(9);
  } catch {
    /* already dead */
  }
  await child.exited;
}
/** Start a server that is expected to fail loudly in its
 * constructor (corrupt store, no usable backup). Returns the
 * process output: rc is non-zero when it exited on its own, null
 * when it was still running (i.e. it came up when it should not
 * have) or when it neither exited nor answered /health in time. */
async function runServerExpectingExit(timeoutMs = 10_000): Promise<{ rc: number | null; out: string; err: string }> {
  const child = serverChild();
  let exitedCode: number | null = null;
  let out = "";
  let err = "";
  // Drain the pipes in the background: an exited process with
  // unread pipes can block, and the stderr text is the evidence.
  const drained = (async () => {
    exitedCode = await child.exited;
    try {
      out = await new Response(child.stdout as unknown as ReadableStream).text();
    } catch {
      out = "";
    }
    try {
      err = await new Response(child.stderr as unknown as ReadableStream).text();
    } catch {
      err = "";
    }
  })();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitedCode !== null) {
      // The exit code is set before the pipe reads finish — wait
      // for the drain so the returned stderr is complete.
      await drained;
      return { rc: exitedCode, out, err };
    }
    // Still running — check whether it wrongly came up.
    try {
      const r = await fetch(`${SERVER_URL}/health`);
      if (r.ok) {
        await stopServer(child);
        return { rc: null, out: "", err: "server came up (answered /health) when it should have failed loudly" };
      }
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  await stopServer(child);
  return { rc: null, out, err: "server neither exited nor answered /health within the timeout" };
}

async function scenarioB(): Promise<void> {
  console.log("\n=== B. corrupt worker store (G7) ===");
  // B1: corrupt store.json + good backup -> recovered, reported, restored.
  let server = serverChild();
  children.push(server);
  check(await waitForHealth(10_000), "B1 SETUP OK: worker server came up (/health)");
  const job1 = await enqueueJob("bra76-spec", "bra76-b1/trap-0");
  check(job1 !== null, `B1 SETUP OK: first job enqueued (${job1})`);
  const job2 = await enqueueJob("bra76-spec", "bra76-b1/trap-1");
  check(job2 !== null, `B1 SETUP OK: second job enqueued (${job2}) — the second save creates store.json.bak`);
  check(fs.existsSync(storePath), "B1 SETUP OK: store.json exists after the enqueues");
  check(fs.existsSync(storeBackupPath), "B1 SETUP OK: store.json.bak exists after the second save");
  const backupContent = fs.readFileSync(storeBackupPath, "utf8");
  const backupJobs = Object.keys(JSON.parse(backupContent).jobs ?? {});
  check(
    backupJobs.includes(job1!) && !backupJobs.includes(job2!),
    `B1 SETUP OK: backup holds job1 (${job1}) but not job2 (${job2}) — one save behind, as designed`,
  );
  await stopServer(server);
  // Simulate a torn/corrupt store write.
  fs.writeFileSync(storePath, "this is not json at all {{{");
  server = serverChild();
  children.push(server);
  check(await waitForHealth(10_000), "B1 RECOVER OK: server came up on a corrupt store.json (recovered from the backup)");
  const jobs = await serverJobs();
  check(
    jobs.some((j) => j.jobId === job1),
    `B1 RECOVER OK: /jobs shows the recovered job (${job1}) — the queue was not silently dropped`,
  );
  check(
    !jobs.some((j) => j.jobId === job2),
    `B1 RECOVER OK: /jobs does NOT show ${job2} (the backup is one save behind — the staleness is explicit, not hidden)`,
  );
  const restored = JSON.parse(fs.readFileSync(storePath, "utf8"));
  check(
    Object.keys(restored.jobs ?? {}).includes(job1!) && !Object.keys(restored.jobs ?? {}).includes(job2!),
    "B1 RECOVER OK: store.json on disk restored to the backup content (parseable, job1 present)",
  );
  const logRecs = readCorruptionLog().filter((r) => r.kind === "worker-store-recovered" && r.file === "store.json");
  check(logRecs.length === 1, `B1 LOG OK: corruption.log records the worker-store recovery (${logRecs.length} record(s))`);
  check(
    logRecs.length === 1 && logRecs[0].reason.includes("store.json is corrupt") && logRecs[0].reason.includes("store.json.bak"),
    "B1 LOG OK: the record names the corrupt store.json and the store.json.bak it recovered from",
  );
  await stopServer(server);
  const serverErr = await new Response(server.stderr as unknown as ReadableStream)
    .text()
    .catch(() => "");
  check(
    serverErr.includes("CORRUPT WORKER STORE") && serverErr.includes("recovered") && serverErr.includes("store.json.bak"),
    `B1 REPORT OK: the restarted server said CORRUPT WORKER STORE + recovered + store.json.bak on stderr`,
  );

  // B2: garbage store.json + missing backup -> loud failure, no fresh start.
  if (fs.existsSync(storeBackupPath)) fs.rmSync(storeBackupPath);
  const garbage = "this is not json at all {{{";
  fs.writeFileSync(storePath, garbage);
  const loud = await runServerExpectingExit();
  check(loud.rc !== null && loud.rc !== 0, `B2 LOUD OK: server exited non-zero on a corrupt store.json with no backup (rc ${loud.rc})`);
  const loudCombined = `${loud.out}\n${loud.err}`;
  check(
    loudCombined.includes("store.json is corrupt") && loudCombined.includes("store.json.bak is missing"),
    `B2 LOUD OK: failure said "store.json is corrupt" and "store.json.bak is missing" (err tail: ${(loud.err.trim().split("\n").slice(-2).join(" / ") || loudCombined.trim().split("\n").slice(-2).join(" / ")).slice(0, 200)})`,
  );
  check(
    fs.existsSync(storePath) && fs.readFileSync(storePath, "utf8") === garbage,
    "B2 LOUD OK: the garbage store.json is left untouched (no silent fresh start overwrote it)",
  );
  check(
    !loudCombined.includes("server came up"),
    "B2 LOUD OK: /health never answered — the server never came up on the corrupt store",
  );

  // B3: store.json parses but is not a store object, backup also corrupt.
  fs.writeFileSync(storePath, `{"not": "a store"}`);
  fs.writeFileSync(storeBackupPath, "also garbage {{{");
  const loud3 = await runServerExpectingExit();
  check(loud3.rc !== null && loud3.rc !== 0, `B3 LOUD OK: server exited non-zero on a non-object store.json with a corrupt backup (rc ${loud3.rc})`);
  const combined3 = `${loud3.out}\n${loud3.err}`;
  check(
    combined3.includes("missing jobs/workers maps") && combined3.includes("also corrupt"),
    `B3 LOUD OK: failure named the shape problem ("missing jobs/workers maps") and the backup ("also corrupt")`,
  );
  // Restore a usable store for the remaining scenarios (a fresh
  // empty store is the operator's explicit reset, not the server's).
  fs.writeFileSync(storePath, JSON.stringify({ jobs: {}, workers: {}, gates: [], seq: 0 }, null, 2));
  fs.rmSync(storeBackupPath, { force: true });
}

async function scenarioC(): Promise<void> {
  console.log("\n=== C. drive cap is explicit (G12) ===");
  // C1: 60 sleeps need 60 rounds — the cap fires, loudly.
  const runId = "bra76-c1";
  submit(SLEEPS_WORKFLOW, runId, { count: 60 });
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc !== 0, `C1 CAP OK: queue run exited non-zero on a 60-sleep run (got ${drive.rc})`);
  check(queueStatus(runId) === "failed", `C1 CAP OK: ${runId} entry is failed (the cap stops the run, it does not silently truncate it)`);
  const err = queueError(runId) ?? "";
  check(
    err.includes("drive cap of 50 rounds") && err.includes(runId) && err.includes("split the workflow"),
    `C1 CAP OK: failure names the 50-round cap, the run, and the remedy (error: ${err.slice(0, 200)})`,
  );
  check(
    drive.out.includes(`failed ${runId}`) && drive.out.includes("drive cap of 50 rounds"),
    "C1 CAP OK: queue run printed the failed entry with the cap message",
  );
  const capEvents = readJournal(runId).filter((e) => e.event === "drive-cap");
  check(capEvents.length === 1, `C1 JOURNAL OK: the journal holds exactly one drive-cap event (${capEvents.length})`);
  check(
    capEvents.length === 1 && capEvents[0].cap === 50 && capEvents[0].rounds === 51,
    `C1 JOURNAL OK: the drive-cap event names cap 50 and rounds 51 (got cap ${capEvents[0]?.cap}, rounds ${capEvents[0]?.rounds})`,
  );
  const status = cli(["status", runId, "--state-dir", STATE_DIR]);
  check(
    status.rc === 0 && status.out.includes('"event":"drive-cap"'),
    "C1 JOURNAL OK: `status` shows the drive-cap event (the failure reason is visible in the journal, not only in queue.json)",
  );
  check(
    fs.existsSync(blobPath(runId)) && fs.statSync(blobPath(runId)).size > 1000,
    "C1 BLOB OK: the blob is intact from the last suspension (the cap failed the drive, not the snapshot)",
  );
  const res = getResult(runId);
  check(res === null, `C1 RESULT OK: ${runId} result returns no output (the run did not silently complete past the cap)`);

  // C2: boundary — 50 sleeps complete (the cap is exactly 50).
  const runId2 = "bra76-c2";
  submit(SLEEPS_WORKFLOW, runId2, { count: 50 });
  const drive2 = cli(["queue", "run", "--state-dir", STATE_DIR]);
  // rc is 1 here because the queue still holds the failed bra76-c1
  // entry (queue run exits 1 when ANY entry is failed) — the
  // per-entry line is the signal for this run.
  check(
    drive2.out.includes(`done ${runId2}`),
    `C2 BOUNDARY OK: queue run printed "done ${runId2}" (rc ${drive2.rc} is the leftover failed bra76-c1 entry, not this run)`,
  );
  check(queueStatus(runId2) === "done", `C2 BOUNDARY OK: ${runId2} done (50 suspensions fit under the cap)`);
  const res2 = getResult(runId2);
  check(res2?.sleeps === 50, `C2 BOUNDARY OK: ${runId2} result returns 50 sleeps (got ${res2?.sleeps})`);
  check(
    readJournal(runId2).filter((e) => e.event === "drive-cap").length === 0,
    "C2 BOUNDARY OK: no drive-cap event in the 50-sleep journal",
  );
}

try {
  await scenarioA();
  await scenarioB();
  await scenarioC();
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
  console.log(`\nFAIL bra76 smaller-robustness-gaps suite (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra76 smaller-robustness-gaps suite (atomic snapshot writes + torn-blob refusal, corrupt worker-store backup recovery + loud failure, explicit 50-round drive cap)");
