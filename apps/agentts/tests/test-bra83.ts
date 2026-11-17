#!/usr/bin/env bun
/**
 * Atomic C snapshot writes test (Linear BRA-83 — G4, C half).
 *
 * BRA-76 fixed the host half (storeBlob is tmp+rename with sha
 * checks). This proves the remaining C half: save_snapshot and
 * write_result_json in packages/durablets/src/durablets.c now write
 * through one helper, write_file_atomic — tmp file (pid-suffixed,
 * same directory) + fsync + rename + directory fsync — so a kill
 * mid-write leaves the live .snap / .result.json old or new, never
 * torn.
 *
 *   A. Kill mid-write, timed for real (direct C host).
 *      A1. A big-heap sleep workflow (8 MiB live pad, so the
 *          snapshot is megabytes) is run under the C host with an
 *          LD_PRELOAD shim that delays the first fwrite — writing
 *          half the bytes, then sleeping 20s. The test polls for
 *          the <snap>.<pid>.tmp file, waits 50ms, then SIGKILLs
 *          the C host. The kill genuinely lands inside the write:
 *          the leftover tmp is torn (0 < size < full size), and
 *          the live snap is byte-identical to before the trial
 *          (same file, never opened for writing). Six trials; all
 *          six must land mid-write. Afterwards the live snap
 *          still resumes cleanly (rc 0, correct result).
 *      A2. Host-level kill/restart cycles: three exec runs are
 *          stranded (SIGKILL mid-drive, bra76 pattern) and a
 *          fresh `queue run` completes all three with no
 *          corrupt-snapshot failure — the new save path works
 *          under the real host, and no run ever fails with a
 *          torn-snapshot refusal.
 *   B. A truncated snapshot still fails loudly (the BRA-76 A2
 *      behavior, preserved — not weakened).
 *      B1. C level: a 40-byte truncated copy of a good snapshot
 *          refuses on `durablets resume` (rc 1, stderr
 *          "<snap>: truncated snapshot"); the full copy resumes
 *          (rc 0) as the control.
 *      B2. Host level: a stranded run's stored blob truncated to
 *          40 bytes makes `queue run` exit non-zero, the entry
 *          failed with an error naming the crashed resume and the
 *          blob path, and `result` returns no output.
 *   C. A leftover tmp file from a killed write is ignored.
 *      C1. C level: garbage <snap>.999999.tmp planted next to a
 *          good snapshot — the resume still completes (rc 0,
 *          correct result), the stale tmp sits untouched, and a
 *          fresh run to the same snap path suspends normally.
 *      C2. Host level: garbage tmps planted in slices/ and
 *          blobs/ before a resume drive — the run still completes
 *          and returns its result; the stale tmps are untouched.
 *   D. write_result_json is atomic too.
 *      D1. C level: a completing workflow's result.json is
 *          baselined, then the workflow is re-run under the
 *          fwrite-delay shim; the kill lands inside the result
 *          write (torn <result>.<pid>.tmp left behind) and the
 *          result.json bytes are unchanged. A clean re-run then
 *          produces the correct result (the stale result tmp is
 *          ignored).
 *      D2. Code inspection: the write path in durablets.c has
 *          exactly one rename (rename(tmp, path)) and exactly one
 *          fopen (the tmp "wb" open) — no direct write to the
 *          live path — and both save_snapshot and
 *          write_result_json route through write_file_atomic.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra83.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra82 suite.)
 *
 * Run outputs go to $BRA83_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The drive child processes and the C-host
 * children are killed in a finally block, even on failure. Exit 0
 * on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): a power-loss torn
 * write — the fsync calls themselves are not fault-injected, so
 * the durability half (file + directory fsync) is argued from the
 * code, not demonstrated by a kill. And the timed kill in A1/D1
 * relies on the LD_PRELOAD shim to widen the window: without it
 * the write is sub-millisecond and a random kill would almost
 * never land inside it (the BRA-67 map already notes this). The
 * shim changes nothing about what the C code does — it only
 * delays libc's fwrite so the SIGKILL can land inside a real
 * write of real bytes to the real tmp file; the kill itself is a
 * real SIGKILL of the real C host, and the torn tmp + intact live
 * file are real on-disk facts afterwards.
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
// The C source the D2 inspection reads (BRA-104): run.sh exports
// $AGENTTS_DURABLETS_DIR (BRA-103) — the package dir the binary was
// built from. Under run.sh's scratch-copy path the test runs from
// $SCRATCH/host-src, where the relative candidate resolves to
// $SCRATCH/../packages/durablets, which does not exist; the export
// is the only pointer back to the real package. In place it points
// at the same dir the relative candidate resolves to, so the
// inspection reads the same file either way.
const CORE_SRC = path.join(
  process.env.AGENTTS_DURABLETS_DIR || path.resolve(ROOT, "..", "..", "packages", "durablets"),
  "src",
  "durablets.c",
);
const HOST =
  process.env.DURABLETS_HOST ||
  path.resolve(ROOT, "..", "..", "packages", "durablets", "out", "durablets");

const WORKDIR = process.env.BRA83_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra83-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const DIRECT_DIR = path.join(WORKDIR, "direct");
fs.mkdirSync(DIRECT_DIR, { recursive: true });

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

function shaFile(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
/** Poll until cond() is true or the timeout elapses. Returns true
 * on success; on timeout records nothing — the caller checks the
 * return and fails with its own message, so a timeout here never
 * passes silently. */
async function pollFor(cond: () => boolean, timeoutMs: number, intervalMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(intervalMs);
  }
  return cond();
}
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<boolean> {
  const got = await pollFor(cond, timeoutMs);
  if (!got) fail(`timeout waiting for: ${what}`);
  return got;
}

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const queuePath = path.join(STATE_DIR, "queue.json");
const blobPath = (runId: string): string => path.join(STATE_DIR, "blobs", `${runId}.snap`);
const liveSnapPath = (runId: string): string => path.join(STATE_DIR, "slices", `${runId}.snap`);
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

/** Drive the queue in a child process (the CLI blocks in the exec
 * trap; this process must stay free to kill it). */
function driveChild(): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", STATE_DIR], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
}

/** Strand a run: drive it in a child, wait for the entry to flip
 * to "running" AND the marker file to appear (the exec trap has
 * dispatched — the run is suspended with a registry entry and a
 * snapshot blob on disk), then SIGKILL the child. Returns the child
 * (already dead). */
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

// ------------------------------------------------------- direct C host
/** Bundle a 0-arg workflow the way the reference plugin does:
 * a driver that arms the entry guard and calls the entry, built
 * with `bun build --target bun`. Refuses loudly when the bundle
 * still contains export/import syntax. */
function bundleWorkflow(workflow: string, tag: string): string {
  const abs = path.resolve(workflow);
  const driverPath = path.join(DIRECT_DIR, `${tag}.driver.ts`);
  const bundlePath = path.join(DIRECT_DIR, `${tag}.bundle.js`);
  const driver =
    `// Core-driver-generated driver for ${tag} (not author code): arm the\n` +
    `// entry guard, then call the workflow's exported entry function\n` +
    `// from global code.\n` +
    `import entry from ${JSON.stringify(abs)};\n` +
    `declare function __agentts_begin(): void;\n` +
    `__agentts_begin();\n` +
    `entry();\n`;
  fs.writeFileSync(driverPath, driver);
  const r = spawnSync(BUN, ["build", driverPath, "--outfile", bundlePath, "--target", "bun"], { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(bundlePath)) {
    fail(`bundleWorkflow: bun build failed for ${tag}: ${r.stderr ?? r.error ?? ""}`);
    throw new Error(`bun build failed for ${tag}`);
  }
  const text = fs.readFileSync(bundlePath, "utf8");
  if (/^\s*export\s/m.test(text) || /^\s*import\s/m.test(text)) {
    fail(`bundleWorkflow: bundle ${bundlePath} still contains export/import syntax — refusing to run it`);
    throw new Error(`bundle ${bundlePath} still contains export/import syntax`);
  }
  return bundlePath;
}

/** Run the C host synchronously; returns rc + stderr. */
function runC(args: string[], envExtra: Record<string, string> = {}): { rc: number; err: string } {
  const r = spawnSync(HOST, args, {
    encoding: "utf8",
    env: { ...process.env, ...envExtra },
  });
  return { rc: r.status ?? 1, err: r.stderr ?? "" };
}

/** Resume oracle: a snapshot is valid iff `durablets resume` gets
 * past the snapshot read. A torn snapshot fails there with rc 1
 * and stderr "<snap>: <QuickJS snapshot error>" (observed:
 * "truncated snapshot"); a workflow failure AFTER a good resume
 * prints "exception: ..." instead and never the "<snap>: " line,
 * so the two are distinguishable. Returns true when the snapshot
 * read succeeded (rc 0/2/3), false when it failed on the read. */
function snapshotReads(snap: string, resultJson: string, runId: string): { ok: boolean; rc: number; err: string } {
  const { rc, err } = runC(["resume", snap, resultJson], { AGENTTS_RUN_ID: runId });
  const readFailed = err.split("\n").some((l) => l.startsWith(`${snap}: `));
  return { ok: !readFailed, rc, err };
}

// The LD_PRELOAD shim: delays the binary's first fwrite — writing
// half the bytes, then sleeping 20s — so the test can observe the
// tmp file and SIGKILL the C host mid-write. The binary has
// exactly one fwrite call site (write_file_atomic in durablets.c),
// so the first fwrite IS the atomic write — snapshot or result,
// whichever the slice performs. Set on the test's own C-host
// spawns only; if the kill misses, the write completes normally
// after the sleep (harmless fallback, not a hang).
const SHIM_C = `#define _GNU_SOURCE
#include <dlfcn.h>
#include <stddef.h>
#include <stdio.h>
#include <unistd.h>
typedef size_t (*fwrite_fn)(const void *, size_t, size_t, FILE *);
static int delayed = 0;
size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream)
{
    static fwrite_fn real_fwrite = NULL;
    size_t total, half, second;
    if (!real_fwrite)
        real_fwrite = (fwrite_fn)dlsym(RTLD_NEXT, "fwrite");
    total = size * nmemb;
    if (!delayed && total > 0) {
        delayed = 1;
        half = total / 2;
        if (half > 0)
            real_fwrite(ptr, 1, half, stream);
        /* Flush the partial write so it is visible on disk: a
         * small payload (e.g. the 24-byte result JSON) would
         * otherwise sit in stdio's buffer and the tmp would read
         * 0 bytes at kill time. The flush only exposes the
         * intermediate state — it does not change what the C code
         * does (fwrite -> fflush -> fsync -> rename). */
        fflush(stream);
        sleep(20);
        second = real_fwrite((const char *)ptr + half, 1, total - half, stream);
        return (half + second) / size;
    }
    return real_fwrite(ptr, size, nmemb, stream);
}
`;
const SHIM_SO = path.join(DIRECT_DIR, "fwrite-delay.so");
function compileShim(): void {
  const src = path.join(DIRECT_DIR, "fwrite-delay.c");
  fs.writeFileSync(src, SHIM_C);
  const r = spawnSync("cc", ["-shared", "-fPIC", "-o", SHIM_SO, src, "-ldl"], { encoding: "utf8" });
  check(r.status === 0 && fs.existsSync(SHIM_SO), `SHIM OK: fwrite-delay shim compiled (${r.status === 0 ? "cc ok" : (r.stderr ?? r.error ?? "cc failed")})`);
  if (r.status !== 0 || !fs.existsSync(SHIM_SO)) throw new Error("fwrite-delay shim did not compile — the timed-kill proof cannot run");
}

/** Spawn the C host under the shim, wait for its tmp file to
 * appear (the atomic write is in flight), wait 50ms so the
 * shim's half-write has landed, then SIGKILL it. Returns whether
 * the tmp was observed and the torn tmp's size at kill time. The
 * caller asserts the target file is unchanged afterwards. */
async function killMidWrite(
  args: string[],
  target: string,
  runId: string,
): Promise<{ hit: boolean; tmpSize: number; tmpPath: string }> {
  const child = spawn([HOST, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTTS_RUN_ID: runId, LD_PRELOAD: SHIM_SO },
  });
  children.push(child);
  const tmpPath = `${target}.${child.pid}.tmp`;
  const seen = await pollFor(() => fs.existsSync(tmpPath), 15_000);
  if (!seen) {
    // The write never showed a tmp file — the timing proof did
    // not land (shim not interposing, or the slice never reached
    // its write). Kill the child and report it as a failure, not
    // a pass: a missed window must not read as "no torn write".
    try {
      child.kill(9);
    } catch {
      /* already dead */
    }
    await child.exited;
    return { hit: false, tmpSize: -1, tmpPath };
  }
  // The process is inside the shim's 20s sleep (half the bytes
  // already written) — the kill lands mid-write, deterministically.
  await sleep(50);
  const tmpSize = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : -1;
  child.kill(9);
  await child.exited;
  return { hit: true, tmpSize, tmpPath };
}

const BIG_SLEEP_WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra83-big-sleep.ts");
const COMPLETE_WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra83-complete.ts");

async function scenarioA(): Promise<void> {
  console.log("\n=== A. kill mid-write leaves the live snapshot intact ===");
  compileShim();
  const bundle = bundleWorkflow(BIG_SLEEP_WORKFLOW, "bra83-big-sleep");
  const snap = path.join(DIRECT_DIR, "bra83-a1.snap");

  // Baseline: one clean suspension writes the live snapshot.
  const base = runC(["run", bundle, snap], { AGENTTS_RUN_ID: "bra83-a1" });
  check(base.rc === 2, `A1 BASELINE OK: clean run suspended (rc ${base.rc}, expected 2)`);
  check(fs.existsSync(snap), "A1 BASELINE OK: live snapshot exists after the clean suspension");
  const snapSize = fs.existsSync(snap) ? fs.statSync(snap).size : 0;
  check(snapSize > 1_000_000, `A1 BASELINE OK: live snapshot is megabytes (${snapSize} bytes) — the 8 MiB pad rode along, so the write is real work`);
  const baseSha = fs.existsSync(snap) ? shaFile(snap) : "";
  check(
    !fs.readdirSync(DIRECT_DIR).some((f) => f.includes(".tmp")),
    "A1 BASELINE OK: no *.tmp file left behind by the clean write (tmp+rename cleans up after itself)",
  );

  // Six timed kills: each must land inside the write (the tmp is
  // observed torn) and leave the live snapshot byte-identical.
  const TRIALS = 6;
  let hits = 0;
  for (let i = 0; i < TRIALS; i++) {
    const before = shaFile(snap);
    const { hit, tmpSize, tmpPath } = await killMidWrite(["run", bundle, snap], snap, "bra83-a1");
    check(hit, `A1 TRIAL ${i} HIT OK: tmp file observed in flight (the kill landed inside the write, not before or after it)`);
    if (!hit) continue;
    hits++;
    check(
      tmpSize > 0 && tmpSize < snapSize,
      `A1 TRIAL ${i} TORN OK: leftover tmp is genuinely torn (${tmpSize} bytes of ${snapSize} — the shim's half-write, killed before the rest)`,
    );
    check(fs.existsSync(tmpPath), `A1 TRIAL ${i} TORN OK: the torn tmp is left behind on disk (${path.basename(tmpPath)})`);
    check(
      fs.existsSync(snap) && shaFile(snap) === before,
      `A1 TRIAL ${i} LIVE OK: live snapshot byte-identical after a kill mid-write (sha ${shaFile(snap).slice(0, 12)}… unchanged)`,
    );
  }
  check(hits === TRIALS, `A1 HITS OK: ${hits}/${TRIALS} trials landed mid-write (a trial that missed its window would fail here, not pass vacuously)`);

  // The live snapshot that survived all six kills still resumes.
  const oracle = snapshotReads(snap, JSON.stringify({ ms: 60000 }), "bra83-a1");
  check(oracle.ok, `A1 ORACLE OK: surviving live snapshot resumes (rc ${oracle.rc}, no "<snap>: " snapshot-read failure)`);
  check(oracle.rc === 0, `A1 ORACLE OK: resumed run completed (rc ${oracle.rc}, expected 0)`);
  const resultPath = snap.replace(/\.snap$/, ".result.json");
  check(
    fs.existsSync(resultPath) && JSON.parse(fs.readFileSync(resultPath, "utf8")).slept === 60000,
    "A1 ORACLE OK: resumed run wrote the correct result.json ({slept: 60000})",
  );
  check(
    fs.existsSync(snap) && shaFile(snap) === baseSha,
    "A1 ORACLE OK: live snapshot bytes still the baseline after the oracle resume (the resume read it, it did not rewrite it)",
  );

  // A2: host-level kill/restart cycles — the new save path under
  // the real host. Three exec runs stranded mid-drive, then one
  // fresh drive completes all three with no corrupt-snapshot
  // failure anywhere.
  const runIds = ["bra83-a2-1", "bra83-a2-2", "bra83-a2-3"];
  for (const runId of runIds) {
    const marker = path.join(WORKDIR, `${runId}.marker`);
    submit(EXEC_WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
    const child = await strandRun(runId, marker);
    children.push(child);
    check(fs.existsSync(blobPath(runId)) && fs.statSync(blobPath(runId)).size > 1000, `A2 STRAND OK: stored blob exists for stranded ${runId}`);
  }
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `A2 RESUME OK: queue run exited 0 after the three kills (got ${drive.rc})`);
  for (const runId of runIds) {
    check(queueStatus(runId) === "done", `A2 RESUME OK: ${runId} done after resume from its blob`);
    const res = getResult(runId);
    check(res?.exitCode === 0, `A2 RESUME OK: ${runId} result returns the output after resume (exitCode ${res?.exitCode})`);
    const err = queueError(runId) ?? "";
    check(!/snapshot|resum/i.test(err), `A2 RESUME OK: ${runId} queue error names no snapshot/resume failure (${err ? JSON.stringify(err.slice(0, 120)) : "no error"})`);
  }
}

async function scenarioB(): Promise<void> {
  console.log("\n=== B. a truncated snapshot still fails loudly ===");
  // B1: C level — a 40-byte truncated copy refuses on resume.
  const goodSnap = path.join(DIRECT_DIR, "bra83-b1-good.snap");
  const tornSnap = path.join(DIRECT_DIR, "bra83-b1-torn.snap");
  const bundle = bundleWorkflow(BIG_SLEEP_WORKFLOW, "bra83-big-sleep");
  const base = runC(["run", bundle, goodSnap], { AGENTTS_RUN_ID: "bra83-b1" });
  check(base.rc === 2, `B1 SETUP OK: clean run suspended (rc ${base.rc})`);
  const full = fs.readFileSync(goodSnap);
  fs.writeFileSync(tornSnap, full.subarray(0, 40));
  check(fs.statSync(tornSnap).size === 40, "B1 SETUP OK: snapshot copy truncated to 40 bytes (simulated torn write)");
  const torn = snapshotReads(tornSnap, JSON.stringify({ ms: 60000 }), "bra83-b1");
  check(!torn.ok, `B1 LOUD OK: truncated snapshot refused on resume (rc ${torn.rc}, snapshot-read failed as expected)`);
  check(torn.rc === 1, `B1 LOUD OK: resume of a torn snapshot exits 1 (got ${torn.rc})`);
  check(
    torn.err.includes(`${tornSnap}: truncated snapshot`),
    `B1 LOUD OK: stderr names the torn file and the failure ("${tornSnap}: truncated snapshot")`,
  );
  const control = snapshotReads(goodSnap, JSON.stringify({ ms: 60000 }), "bra83-b1");
  check(control.ok && control.rc === 0, `B1 CONTROL OK: the full copy resumes and completes (rc ${control.rc}) — the oracle distinguishes torn from good`);

  // B2: host level — a truncated stored blob is not trusted
  // (bra76 A2 shape, re-proven so the C change cannot have
  // weakened it).
  const runId = "bra83-b2";
  const marker = path.join(WORKDIR, "bra83-b2.marker");
  submit(EXEC_WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  const blob = blobPath(runId);
  check(fs.existsSync(blob) && fs.statSync(blob).size > 1000, `B2 SETUP OK: stored blob exists (${fs.existsSync(blob) ? fs.statSync(blob).size : 0} bytes) before truncation`);
  const fullBlob = fs.readFileSync(blob);
  fs.writeFileSync(blob, fullBlob.subarray(0, 40));
  check(fs.statSync(blob).size === 40, "B2 SETUP OK: blob truncated to 40 bytes (simulated torn write)");
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc !== 0, `B2 LOUD OK: queue run exited non-zero on a torn blob (got ${drive.rc})`);
  check(queueStatus(runId) === "failed", `B2 LOUD OK: ${runId} entry is failed (never silently completed from a torn blob)`);
  const err = queueError(runId) ?? "";
  check(
    /crashed resuming/i.test(err) && err.includes("blobs/bra83-b2.snap"),
    `B2 LOUD OK: failure names the crashed resume and the blob path (error: ${err.slice(0, 160)})`,
  );
  check(drive.out.includes(`failed ${runId}`), "B2 LOUD OK: queue run printed the failed entry (the failure is visible, not swallowed)");
  const res = getResult(runId);
  check(res === null, `B2 LOUD OK: ${runId} result returns no output (no bogus result from a torn blob)`);
}

async function scenarioC(): Promise<void> {
  console.log("\n=== C. a leftover tmp file is ignored ===");
  // C1: C level — garbage tmps next to a good snapshot.
  const snap = path.join(DIRECT_DIR, "bra83-c1.snap");
  const bundle = bundleWorkflow(BIG_SLEEP_WORKFLOW, "bra83-big-sleep");
  const base = runC(["run", bundle, snap], { AGENTTS_RUN_ID: "bra83-c1" });
  check(base.rc === 2, `C1 SETUP OK: clean run suspended (rc ${base.rc})`);
  const staleTmp = `${snap}.999999.tmp`;
  fs.writeFileSync(staleTmp, "garbage from a killed write {{{");
  const staleResultTmp = `${snap.replace(/\.snap$/, ".result.json")}.999999.tmp`;
  fs.writeFileSync(staleResultTmp, "garbage from a killed result write {{{");
  const beforeSha = shaFile(snap);
  const resumed = snapshotReads(snap, JSON.stringify({ ms: 60000 }), "bra83-c1");
  check(resumed.ok && resumed.rc === 0, `C1 IGNORED OK: resume completes despite the stale tmps (rc ${resumed.rc})`);
  check(
    fs.existsSync(staleTmp) && fs.readFileSync(staleTmp, "utf8") === "garbage from a killed write {{{",
    "C1 IGNORED OK: the stale snapshot tmp is still on disk, byte-identical (ignored, never read as a snapshot)",
  );
  check(
    fs.existsSync(staleResultTmp) && fs.readFileSync(staleResultTmp, "utf8") === "garbage from a killed result write {{{",
    "C1 IGNORED OK: the stale result tmp is still on disk, byte-identical (ignored, never read as a result)",
  );
  check(
    fs.existsSync(snap) && shaFile(snap) === beforeSha,
    "C1 IGNORED OK: the live snapshot bytes are unchanged by the resume (the stale tmp did not get mixed in)",
  );
  // A fresh run to the same snap path suspends normally — the
  // next save ignores the stale tmp (its own pid-suffixed tmp
  // name cannot collide with a dead pid's).
  const rerun = runC(["run", bundle, snap], { AGENTTS_RUN_ID: "bra83-c1" });
  check(rerun.rc === 2, `C1 RERUN OK: a fresh run to the same snap path suspends normally despite the stale tmp (rc ${rerun.rc})`);
  const oracle = snapshotReads(snap, JSON.stringify({ ms: 60000 }), "bra83-c1");
  check(oracle.ok && oracle.rc === 0, `C1 RERUN OK: the re-saved snapshot resumes and completes (rc ${oracle.rc})`);
  check(
    fs.existsSync(staleTmp),
    "C1 RERUN OK: the stale tmp is still there after the re-save (ignored, not cleaned up — the documented behavior; at most one per killed write)",
  );

  // C2: host level — garbage tmps in slices/ and blobs/ before a
  // resume drive.
  const runId = "bra83-c2";
  const marker = path.join(WORKDIR, "bra83-c2.marker");
  submit(EXEC_WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  const staleSliceTmp = `${liveSnapPath(runId)}.999999.tmp`;
  const staleBlobTmp = `${blobPath(runId)}.999999.tmp`;
  fs.writeFileSync(staleSliceTmp, "garbage from a killed live-snap write {{{");
  fs.writeFileSync(staleBlobTmp, "garbage from a killed blob store {{{");
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  // rc is 1 here because the queue still holds the failed
  // bra83-b2 entry — the per-entry line is the signal for this run.
  check(
    drive.out.includes(`done ${runId}`),
    `C2 IGNORED OK: queue run printed "done ${runId}" despite the stale tmps (rc ${drive.rc} is the leftover failed bra83-b2 entry, not this run)`,
  );
  check(queueStatus(runId) === "done", `C2 IGNORED OK: ${runId} done after resume with stale tmps in place`);
  const res = getResult(runId);
  check(res?.exitCode === 0, `C2 IGNORED OK: ${runId} result returns the output after resume (exitCode ${res?.exitCode})`);
  check(
    fs.existsSync(staleSliceTmp) && fs.readFileSync(staleSliceTmp, "utf8") === "garbage from a killed live-snap write {{{",
    "C2 IGNORED OK: the stale slices/ tmp is untouched (ignored, never read)",
  );
  check(
    fs.existsSync(staleBlobTmp) && fs.readFileSync(staleBlobTmp, "utf8") === "garbage from a killed blob store {{{",
    "C2 IGNORED OK: the stale blobs/ tmp is untouched (ignored, never read)",
  );
}

async function scenarioD(): Promise<void> {
  console.log("\n=== D. write_result_json is atomic too ===");
  // D1: C level — kill inside the result write (same shim shape
  // as A1, but the slice performs only the result write).
  const bundle = bundleWorkflow(COMPLETE_WORKFLOW, "bra83-complete");
  const snap = path.join(DIRECT_DIR, "bra83-d1.snap");
  const resultPath = snap.replace(/\.snap$/, ".result.json");
  const base = runC(["run", bundle, snap], { AGENTTS_RUN_ID: "bra83-d1" });
  check(base.rc === 0, `D1 BASELINE OK: clean run completed (rc ${base.rc}, expected 0)`);
  check(
    fs.existsSync(resultPath) && fs.readFileSync(resultPath, "utf8") === `{"value":"bra83-result"}`,
    `D1 BASELINE OK: result.json holds exactly {"value":"bra83-result"} (${fs.existsSync(resultPath) ? fs.statSync(resultPath).size : 0} bytes)`,
  );
  const baseBytes = fs.readFileSync(resultPath, "utf8");
  const { hit, tmpSize, tmpPath } = await killMidWrite(["run", bundle, snap], resultPath, "bra83-d1");
  check(hit, "D1 HIT OK: result tmp file observed in flight (the kill landed inside the result write)");
  if (hit) {
    check(
      tmpSize > 0 && tmpSize < baseBytes.length,
      `D1 TORN OK: leftover result tmp is genuinely torn (${tmpSize} bytes of ${baseBytes.length} — the shim's half-write, killed before the rest)`,
    );
    check(fs.existsSync(tmpPath), `D1 TORN OK: the torn result tmp is left behind on disk (${path.basename(tmpPath)})`);
  }
  check(
    fs.existsSync(resultPath) && fs.readFileSync(resultPath, "utf8") === baseBytes,
    "D1 LIVE OK: result.json byte-identical after a kill mid-write (old or new, never torn)",
  );
  // A clean re-run produces the correct result — the stale
  // result tmp is ignored.
  const rerun = runC(["run", bundle, snap], { AGENTTS_RUN_ID: "bra83-d1" });
  check(rerun.rc === 0, `D1 RERUN OK: clean re-run completed (rc ${rerun.rc})`);
  check(
    fs.existsSync(resultPath) && fs.readFileSync(resultPath, "utf8") === `{"value":"bra83-result"}`,
    "D1 RERUN OK: result.json is the correct complete JSON after the re-run (the stale result tmp did not poison it)",
  );

  // D2: code inspection — the write path has exactly one rename
  // and no direct write to the live path.
  const cSrc = fs.readFileSync(CORE_SRC, "utf8");
  const marker = "/* ---- atomic file write (BRA-83";
  const start = cSrc.indexOf(marker);
  check(start >= 0, "D2 SRC OK: the BRA-83 atomic-write block is present in durablets.c");
  if (start < 0) throw new Error("BRA-83 atomic-write block missing from durablets.c — the inspection cannot run");
  const wrjStart = cSrc.indexOf("static void write_result_json", start);
  check(wrjStart > start, "D2 SRC OK: write_result_json follows the atomic-write helper");
  const wrjEnd = cSrc.indexOf("\n}\n", wrjStart);
  check(wrjEnd > wrjStart, "D2 SRC OK: write_result_json body found (closing brace located)");
  const region = cSrc.slice(start, wrjEnd);
  const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
  check(
    count(region, "rename(tmp, path)") === 1,
    `D2 SRC OK: exactly one rename(tmp, path) in the atomic-write region (got ${count(region, "rename(tmp, path)")}) — a single commit point`,
  );
  check(
    count(region, 'fopen(tmp, "wb")') === 1,
    `D2 SRC OK: exactly one fopen(tmp, "wb") in the atomic-write region (got ${count(region, 'fopen(tmp, "wb")')}) — the tmp is the only file opened for writing`,
  );
  check(
    !region.includes("fopen(filename") && !region.includes("fopen(path"),
    "D2 SRC OK: no fopen of the live path anywhere in the atomic-write region (nothing writes to the target directly)",
  );
  check(
    count(region, "fsync(") === 2,
    `D2 SRC OK: two fsync calls in the region — tmp file before rename, directory after (got ${count(region, "fsync(")})`,
  );
  const ssStart = cSrc.indexOf("static int save_snapshot");
  const ssEnd = cSrc.indexOf("\n}\n", ssStart);
  check(ssStart >= 0 && ssEnd > ssStart, "D2 SRC OK: save_snapshot body found");
  const ssBody = cSrc.slice(ssStart, ssEnd);
  check(
    ssBody.includes("write_file_atomic(filename, buf, size)") &&
      !ssBody.includes("fopen(") &&
      !ssBody.includes("fwrite(") &&
      !ssBody.includes("rename("),
    "D2 SRC OK: save_snapshot routes through write_file_atomic and contains no fopen/fwrite/rename of its own",
  );
  const wrjBody = cSrc.slice(wrjStart, wrjEnd);
  check(
    wrjBody.includes("write_file_atomic(path, text, strlen(text))") &&
      !wrjBody.includes("fopen(") &&
      !wrjBody.includes("fwrite(") &&
      !wrjBody.includes("rename("),
    "D2 SRC OK: write_result_json routes through write_file_atomic and contains no fopen/fwrite/rename of its own",
  );
}

try {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
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
  console.log(`\nFAIL bra83 atomic C snapshot writes suite (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra83 atomic C snapshot writes suite (kill mid-write leaves the live snapshot intact, truncated snapshot still refused loudly, stale tmp ignored, result write atomic, single-rename write path)");
