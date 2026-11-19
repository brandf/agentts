#!/usr/bin/env bun
/**
 * Incremental snapshots test (Linear BRA-90).
 *
 * Proves the hash-linked snapshot chain (one keyframe + one delta
 * per checkpoint) survives the failures it must survive, and that
 * the write amplification matches the adopted design:
 *
 *   A. Chain basics: a run stranded at a delta checkpoint has a
 *      manifest (bra90-chain-v1, kind delta, ordinal 5,
 *      sinceKeyframe 5), a small delta file (bytes equal to the
 *      live slice snap), a .snap holding the keyframe copy
 *      (> 1000 bytes), exactly one keyframe file, and a log with
 *      1 base + 5 delta saves. Driving it completes with the
 *      right result.
 *   B. Interval keyframe: stranded at ordinal 25, the manifest is
 *      kind keyframe, trigger interval, sinceKeyframe 0; the log's
 *      26th save is a base; the ordinal-0 keyframe is pruned
 *      (exactly one keyframe file, named by the manifest).
 *   C. Ratio keyframe: a fast-accumulating run rebases at ordinal
 *      2 or 3 (a base save well before the interval would fire),
 *      completes with the right string length, and holds exactly
 *      one keyframe.
 *   D. Fault injection (each a fresh stranded run at a delta
 *      checkpoint, one corruption each — the BRA-67 pattern: the
 *      run must fail loudly, never silently load wrong state):
 *      D1. Truncated delta -> entry failed, error matches
 *          /crashed resuming/i and names blobs/<run>.snap, no
 *          result.
 *      D2. Truncated keyframe -> same shape.
 *      D3. Wrong-hash pairing (manifest keyframeHash swapped to
 *          another run's keyframe) -> same shape, AND the slice
 *          log contains "the delta was not written from this
 *          base" (the engine rejecting the pair).
 *      D4. Missing delta file -> entry failed with the named
 *          "missing delta file" error, no result (never a
 *          bare-base resume).
 *      D5. Corrupt manifest -> entry failed with the named
 *          "corrupt checkpoint manifest" error, no result.
 *      D6. Missing keyframe file -> entry failed with the named
 *          "missing keyframe file" error, no result.
 *   E. Fork: a two-branch all() completes with both branch
 *      names; each branch slice log shows delta-only saves, each
 *      < 1000 bytes (a delta against the shared keyframe, not a
 *      full copy); the keyframe store holds exactly one file,
 *      equal to the parent's .snap.
 *   F. Write amplification: a 30-sleep run's total snapshot
 *      bytes (summed from the C host's "[host] snapshot saved"
 *      log lines) vs 30x the keyframe size is < 0.6 — the
 *      adopted design's write saving, measured on a real run.
 *      The numbers are printed so the report can cite them.
 *   G. Legacy migration: a checkpoint stranded at a KEYFRAME
 *      suspension, with the manifest + delta deleted (a pre-chain
 *      blob: just the .snap full snapshot of the latest
 *      suspension), resumes directly — no replay — the next
 *      suspension writes a base + a fresh manifest, and the run
 *      completes with the right result.
 *   H. Interval 0 = full-only: every suspension is a keyframe
 *      (log all base, 0 delta; stranded manifest kind keyframe,
 *      trigger full-only), and the run completes.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra90.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra89
 *   suite.) Each scenario gets its own state dir, so a failed
 *   entry in one never changes another scenario's `queue run`
 *   exit code. Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): load time (the
 * design says keyframing does NOT improve it — slightly slower,
 * one keyframe + one delta to read — and this test does not time
 * loads); the 4.71x/10.35x prototype totals (those were 500-
 * suspension harness numbers — this test measures the ratio on a
 * 30-suspension real run instead); a torn manifest mid-rename
 * (manifest writes are atomic tmp+rename, so a reader sees old
 * or new, never torn — the corruption case covers a manifest
 * that is garbage on disk); a manifest-less DELTA checkpoint
 * (manifest + delta deleted while .snap holds an older
 * keyframe): the run rewinds to the keyframe and replays the
 * recorded trap answers from the journal (BRA-75) — the result
 * stays correct, but it is a replay, not a direct resume, so it
 * is not what scenario G proves.
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

const WORKDIR = process.env.BRA90_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra90-"));

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

function stateDir(name: string): string {
  const d = path.join(WORKDIR, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const blobPath = (sd: string, runId: string): string => path.join(sd, "blobs", `${runId}.snap`);
const deltaPath = (sd: string, runId: string): string => path.join(sd, "blobs", `${runId}.delta`);
const manifestPath = (sd: string, runId: string): string =>
  path.join(sd, "blobs", `${runId}.checkpoint.json`);
const keyframeDir = (sd: string): string => path.join(sd, "blobs", "keyframes");
const liveSnapPath = (sd: string, runId: string): string =>
  path.join(sd, "slices", `${runId.replace(/\//g, "_")}.snap`);
const sliceLogPath = (sd: string, runId: string): string =>
  path.join(sd, "slices", `${runId.replace(/\//g, "_")}.log`);
const queuePath = (sd: string): string => path.join(sd, "queue.json");

function shaFile(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
function readQueueStrict(sd: string): any[] {
  return JSON.parse(fs.readFileSync(queuePath(sd), "utf8"));
}
function queueStatus(sd: string, runId: string): string | null {
  try {
    return readQueueStrict(sd).find((e) => e.runId === runId)?.status ?? null;
  } catch {
    return null;
  }
}
function queueError(sd: string, runId: string): string | null {
  try {
    return readQueueStrict(sd).find((e) => e.runId === runId)?.error ?? null;
  } catch {
    return null;
  }
}
function markerLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}
function readManifest(sd: string, runId: string): any | null {
  const p = manifestPath(sd, runId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function keyframeFiles(sd: string): string[] {
  const d = keyframeDir(sd);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith(".snap")).sort();
}
/** The C host's snapshot-save log lines for one run, in order:
 * [{bytes, kind}] where kind is "base" or "delta". */
function snapshotLines(sd: string, runId: string): { bytes: number; kind: string }[] {
  const p = sliceLogPath(sd, runId);
  if (!fs.existsSync(p)) return [];
  const out: { bytes: number; kind: string }[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/\[host\] snapshot saved: .* \((\d+) bytes, (base|delta)\)/);
    if (m) out.push({ bytes: Number(m[1]), kind: m[2] });
  }
  return out;
}

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Drive the queue in a child process (the CLI blocks in the exec
 * trap; this process must stay free to kill it). */
function driveChild(sd: string, env: Record<string, string> = {}): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", sd], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
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

function submit(sd: string, workflow: string, runId: string, input: unknown): string {
  const inputFile = path.join(WORKDIR, `${runId.replace(/\//g, "_")}.input.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const r = cli(["run", workflow, "--run-id", runId, "--input-file", inputFile, "--adapter", "direct", "--state-dir", sd]);
  check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `SUBMIT OK: ${runId} submitted (rc ${r.rc})`);
  return runId;
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

function drive(sd: string, env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  return cli(["queue", "run", "--state-dir", sd], env);
}

/** Strand a run: drive it in a child, wait for the entry to flip
 * to "running" AND the marker file to appear (the exec trap has
 * dispatched — the run is suspended with a registry entry and a
 * snapshot checkpoint on disk), then SIGKILL the child. */
async function strandRun(sd: string, runId: string, marker: string, env: Record<string, string> = {}): Promise<Subprocess> {
  const child = driveChild(sd, env);
  const flipped = await waitFor(() => queueStatus(sd, runId) === "running", 15_000, `${runId} entry -> running`);
  check(flipped, `STRAND OK: ${runId} entry flipped to running before the kill`);
  const dispatched = await waitFor(() => markerLines(marker) >= 1, 15_000, `${runId} marker written (exec dispatched)`);
  check(dispatched, `STRAND OK: ${runId} exec dispatched (marker written) before the kill`);
  child.kill(9);
  await child.exited;
  check(queueStatus(sd, runId) === "running", `STRAND OK: ${runId} entry still "running" after the kill (stranded, not driven)`);
  return child;
}

const children: Subprocess[] = [];
const SLEEPS_EXEC = path.join(ROOT, "tests", "workflows", "workflow-bra90-sleeps-exec.ts");
const SLEEPS = path.join(ROOT, "tests", "workflows", "workflow-bra76-many-sleeps.ts");
const ACCUMULATE = path.join(ROOT, "tests", "workflows", "workflow-bra90-accumulate.ts");
const FORK = path.join(ROOT, "tests", "workflows", "workflow-bra90-fork.ts");

async function scenarioA(): Promise<void> {
  console.log("\n=== A. chain basics (stranded at a delta checkpoint) ===");
  const sd = stateDir("state-a");
  const runId = "bra90-a";
  const marker = path.join(WORKDIR, "bra90-a.marker");
  submit(sd, SLEEPS_EXEC, runId, { count: 5, after: 0, markerFile: marker, sleepMs: 2000 });
  const child = await strandRun(sd, runId, marker);
  children.push(child);
  const m = readManifest(sd, runId);
  check(m !== null, "A MANIFEST OK: checkpoint manifest exists for the stranded run");
  check(m?.format === "bra90-chain-v1", `A MANIFEST OK: format is bra90-chain-v1 (got ${m?.format})`);
  check(m?.kind === "delta", `A MANIFEST OK: kind is delta (got ${m?.kind})`);
  check(m?.ordinal === 5, `A MANIFEST OK: ordinal is 5 (got ${m?.ordinal})`);
  check(m?.sinceKeyframe === 5, `A MANIFEST OK: sinceKeyframe is 5 (got ${m?.sinceKeyframe})`);
  check(m?.trigger === null, `A MANIFEST OK: trigger is null at a plain delta (got ${m?.trigger})`);
  check(typeof m?.keyframeHash === "string" && m.keyframeHash.length === 64, "A MANIFEST OK: keyframeHash is a sha256");
  check(typeof m?.deltaHash === "string" && m.deltaHash.length === 64, "A MANIFEST OK: deltaHash is a sha256");
  check(typeof m?.prevCheckpointHash === "string" && m.prevCheckpointHash.length === 64, "A MANIFEST OK: prevCheckpointHash links to the previous checkpoint");
  const kf = keyframeFiles(sd);
  check(kf.length === 1, `A KEYFRAME OK: exactly one keyframe file (${kf.length})`);
  check(kf.length === 1 && kf[0] === `${m?.keyframeHash}.snap`, "A KEYFRAME OK: the keyframe file is named by the manifest's keyframeHash");
  const kfSize = kf.length === 1 ? fs.statSync(path.join(keyframeDir(sd), kf[0])).size : 0;
  const snapSize = fs.existsSync(blobPath(sd, runId)) ? fs.statSync(blobPath(sd, runId)).size : 0;
  check(snapSize > 1000, `A SNAP OK: .snap holds the keyframe copy (${snapSize} bytes, > 1000)`);
  check(snapSize === kfSize, `A SNAP OK: .snap bytes equal the keyframe file (${snapSize} vs ${kfSize})`);
  check(fs.existsSync(deltaPath(sd, runId)), "A DELTA OK: .delta file exists");
  const deltaSize = fs.existsSync(deltaPath(sd, runId)) ? fs.statSync(deltaPath(sd, runId)).size : 0;
  check(deltaSize > 0 && deltaSize < kfSize, `A DELTA OK: delta is smaller than the keyframe (${deltaSize} vs ${kfSize} bytes)`);
  check(
    fs.existsSync(liveSnapPath(sd, runId)) && fs.existsSync(deltaPath(sd, runId)) &&
      shaFile(deltaPath(sd, runId)) === shaFile(liveSnapPath(sd, runId)),
    "A DELTA OK: .delta bytes equal the live slice snap bytes (the suspension's delta, copied by storeBlob)",
  );
  check(
    m?.deltaHash === (fs.existsSync(deltaPath(sd, runId)) ? shaFile(deltaPath(sd, runId)) : ""),
    "A DELTA OK: manifest deltaHash is the sha of the .delta bytes",
  );
  const lines = snapshotLines(sd, runId);
  check(lines.length === 6, `A LOG OK: 6 snapshot saves in the slice log (got ${lines.length})`);
  check(
    lines.length === 6 && lines[0].kind === "base" && lines.slice(1).every((l) => l.kind === "delta"),
    `A LOG OK: kinds are base + 5 delta (${lines.map((l) => l.kind).join(",")})`,
  );
  // Drive it to completion from the delta checkpoint.
  const d = drive(sd);
  check(d.rc === 0, `A RESUME OK: queue run exited 0 (got ${d.rc})`);
  check(queueStatus(sd, runId) === "done", `A RESUME OK: ${runId} done after resume from the delta checkpoint`);
  const res = getResult(sd, runId);
  check(res?.sleeps === 5, `A RESUME OK: ${runId} result returns 5 sleeps (got ${res?.sleeps})`);
}

async function scenarioB(): Promise<void> {
  console.log("\n=== B. interval keyframe at ordinal 25 ===");
  const sd = stateDir("state-b");
  const runId = "bra90-b";
  const marker = path.join(WORKDIR, "bra90-b.marker");
  submit(sd, SLEEPS_EXEC, runId, { count: 25, after: 0, markerFile: marker, sleepMs: 2000 });
  const child = await strandRun(sd, runId, marker);
  children.push(child);
  const m = readManifest(sd, runId);
  check(m?.kind === "keyframe", `B MANIFEST OK: kind is keyframe at ordinal 25 (got ${m?.kind})`);
  check(m?.trigger === "interval", `B MANIFEST OK: trigger is interval (got ${m?.trigger})`);
  check(m?.ordinal === 25, `B MANIFEST OK: ordinal is 25 (got ${m?.ordinal})`);
  check(m?.sinceKeyframe === 0, `B MANIFEST OK: sinceKeyframe reset to 0 at the keyframe (got ${m?.sinceKeyframe})`);
  const lines = snapshotLines(sd, runId);
  check(lines.length === 26, `B LOG OK: 26 snapshot saves in the slice log (got ${lines.length})`);
  check(
    lines.length === 26 && lines[0].kind === "base" && lines[25].kind === "base" &&
      lines.slice(1, 25).every((l) => l.kind === "delta"),
    `B LOG OK: kinds are base + 24 delta + base (keyframe at ordinal 25) + 0 delta after (${lines.map((l) => l.kind).join(",")})`,
  );
  const kf = keyframeFiles(sd);
  check(kf.length === 1, `B PRUNE OK: exactly one keyframe file — the ordinal-0 keyframe was pruned (${kf.length})`);
  check(kf.length === 1 && kf[0] === `${m?.keyframeHash}.snap`, "B PRUNE OK: the surviving keyframe is the ordinal-25 one named by the manifest");
  const d = drive(sd);
  check(d.rc === 0, `B RESUME OK: queue run exited 0 (got ${d.rc})`);
  check(queueStatus(sd, runId) === "done", `B RESUME OK: ${runId} done`);
  const res = getResult(sd, runId);
  check(res?.sleeps === 25, `B RESUME OK: ${runId} result returns 25 sleeps (got ${res?.sleeps})`);
}

async function scenarioC(): Promise<void> {
  console.log("\n=== C. ratio keyframe (fast-accumulating run) ===");
  const sd = stateDir("state-c");
  const runId = "bra90-c";
  submit(sd, ACCUMULATE, runId, { count: 5, firstChunk: 1000, chunk: 100000 });
  const d = drive(sd);
  check(d.rc === 0, `C DRIVE OK: queue run exited 0 (got ${d.rc})`);
  check(queueStatus(sd, runId) === "done", `C DRIVE OK: ${runId} done`);
  const res = getResult(sd, runId);
  check(res?.length === 401000, `C RESULT OK: string length is 401000 (got ${res?.length})`);
  const lines = snapshotLines(sd, runId);
  check(lines.length === 5, `C LOG OK: 5 snapshot saves in the slice log (got ${lines.length})`);
  const baseIdx = lines.map((l, i) => (l.kind === "base" ? i : -1)).filter((i) => i >= 0);
  check(
    baseIdx.length === 2 && baseIdx[0] === 0 && (baseIdx[1] === 2 || baseIdx[1] === 3),
    `C RATIO OK: exactly 2 base saves, the second at ordinal ${baseIdx[1]} (ratio rebase, well before the interval at 25) — base at [${baseIdx.join(",")}], sizes [${lines.map((l) => l.bytes).join(",")}]`,
  );
  const kf = keyframeFiles(sd);
  check(kf.length === 1, `C PRUNE OK: exactly one keyframe file after the ratio rebase (${kf.length})`);
}

async function scenarioD(): Promise<void> {
  console.log("\n=== D. fault injection (torn/corrupt/wrong-hash/missing) ===");
  const strandDelta = async (sd: string, runId: string): Promise<void> => {
    const marker = path.join(WORKDIR, `${runId}.marker`);
    submit(sd, SLEEPS_EXEC, runId, { count: 3, after: 0, markerFile: marker, sleepMs: 2000 });
    const child = await strandRun(sd, runId, marker);
    children.push(child);
    const m = readManifest(sd, runId);
    check(m?.kind === "delta" && m?.ordinal === 3, `D SETUP OK: ${runId} stranded at a delta checkpoint (kind ${m?.kind}, ordinal ${m?.ordinal})`);
  };
  const expectFailedNoResult = (sd: string, runId: string, label: string, errRe: RegExp): void => {
    check(queueStatus(sd, runId) === "failed", `${label}: entry is failed (never silently completed from a corrupt checkpoint)`);
    const err = queueError(sd, runId) ?? "";
    check(errRe.test(err), `${label}: failure names the problem (${errRe} — error: ${err.slice(0, 200)})`);
    check(getResult(sd, runId) === null, `${label}: result returns no output (no bogus result from a corrupt checkpoint)`);
  };

  // D1: truncated delta.
  {
    const sd = stateDir("state-d1");
    const runId = "bra90-d1";
    await strandDelta(sd, runId);
    const full = fs.readFileSync(deltaPath(sd, runId));
    fs.writeFileSync(deltaPath(sd, runId), full.subarray(0, 40));
    check(fs.statSync(deltaPath(sd, runId)).size === 40, "D1 SETUP OK: .delta truncated to 40 bytes");
    const d = drive(sd);
    check(d.rc !== 0, `D1 LOUD OK: queue run exited non-zero on a truncated delta (got ${d.rc})`);
    expectFailedNoResult(sd, runId, "D1 TRUNCATED-DELTA", /crashed resuming/i);
    const err = queueError(sd, runId) ?? "";
    check(err.includes("blobs/bra90-d1.snap"), "D1 LOUD OK: failure names the blob path (last blob intact at blobs/bra90-d1.snap)");
  }
  // D2: truncated keyframe.
  {
    const sd = stateDir("state-d2");
    const runId = "bra90-d2";
    await strandDelta(sd, runId);
    const m = readManifest(sd, runId)!;
    const kf = path.join(keyframeDir(sd), `${m.keyframeHash}.snap`);
    const full = fs.readFileSync(kf);
    fs.writeFileSync(kf, full.subarray(0, 40));
    check(fs.statSync(kf).size === 40, "D2 SETUP OK: keyframe truncated to 40 bytes");
    const d = drive(sd);
    check(d.rc !== 0, `D2 LOUD OK: queue run exited non-zero on a truncated keyframe (got ${d.rc})`);
    expectFailedNoResult(sd, runId, "D2 TRUNCATED-KEYFRAME", /crashed resuming/i);
  }
  // D3: wrong-hash pairing — the manifest names another run's keyframe.
  // The donor lives in its own state dir (a `queue run` drives every
  // stranded entry in a state dir, so stranding the donor in the
  // victim's dir would complete the victim and discard its manifest).
  // Driving the donor to completion leaves its keyframe file on disk
  // (completion discards the manifest + delta, not the keyframe), so
  // the file can be copied into the victim's store.
  {
    const sd = stateDir("state-d3");
    const donorSd = stateDir("state-d3-donor");
    const runId = "bra90-d3";
    const donorId = "bra90-d3-donor";
    submit(donorSd, SLEEPS_EXEC, donorId, { count: 2, after: 0, markerFile: path.join(WORKDIR, `${donorId}.marker`), sleepMs: 2000 });
    const donorDrive = drive(donorSd);
    check(donorDrive.rc === 0, `D3 SETUP OK: donor run completed (rc ${donorDrive.rc})`);
    check(queueStatus(donorSd, donorId) === "done", "D3 SETUP OK: donor run done");
    const donorKf = keyframeFiles(donorSd);
    check(donorKf.length === 1, `D3 SETUP OK: donor left exactly one keyframe file (${donorKf.length})`);
    await strandDelta(sd, runId);
    const m = readManifest(sd, runId)!;
    const donorHash = donorKf[0].slice(0, -".snap".length);
    check(
      donorHash !== m.keyframeHash,
      "D3 SETUP OK: donor keyframe hash differs from the victim's (a real wrong-hash pairing)",
    );
    fs.copyFileSync(path.join(keyframeDir(donorSd), donorKf[0]), path.join(keyframeDir(sd), donorKf[0]));
    check(fs.existsSync(path.join(keyframeDir(sd), donorKf[0])), "D3 SETUP OK: donor keyframe file copied into the victim's store");
    const swapped = { ...m, keyframeHash: donorHash };
    fs.writeFileSync(manifestPath(sd, runId), JSON.stringify(swapped));
    check(readManifest(sd, runId)?.keyframeHash === donorHash, "D3 SETUP OK: manifest keyframeHash swapped to the donor's");
    const d = drive(sd);
    check(d.rc !== 0, `D3 LOUD OK: queue run exited non-zero on a wrong-hash pairing (got ${d.rc})`);
    expectFailedNoResult(sd, runId, "D3 WRONG-HASH", /crashed resuming/i);
    const logText = fs.existsSync(sliceLogPath(sd, runId)) ? fs.readFileSync(sliceLogPath(sd, runId), "utf8") : "";
    check(
      logText.includes("the delta was not written from this base"),
      "D3 ENGINE OK: the slice log shows the engine rejecting the pair (\"the delta was not written from this base\")",
    );
  }
  // D4: missing delta file.
  {
    const sd = stateDir("state-d4");
    const runId = "bra90-d4";
    await strandDelta(sd, runId);
    fs.rmSync(deltaPath(sd, runId));
    check(!fs.existsSync(deltaPath(sd, runId)), "D4 SETUP OK: .delta file deleted");
    const d = drive(sd);
    check(d.rc !== 0, `D4 LOUD OK: queue run exited non-zero with the delta missing (got ${d.rc})`);
    expectFailedNoResult(sd, runId, "D4 MISSING-DELTA", /missing delta file/);
  }
  // D5: corrupt manifest.
  {
    const sd = stateDir("state-d5");
    const runId = "bra90-d5";
    await strandDelta(sd, runId);
    fs.writeFileSync(manifestPath(sd, runId), "this is not json at all {{{");
    check(fs.readFileSync(manifestPath(sd, runId), "utf8").startsWith("this is not json"), "D5 SETUP OK: manifest overwritten with garbage");
    const d = drive(sd);
    check(d.rc !== 0, `D5 LOUD OK: queue run exited non-zero on a corrupt manifest (got ${d.rc})`);
    expectFailedNoResult(sd, runId, "D5 CORRUPT-MANIFEST", /corrupt checkpoint manifest/);
  }
  // D6: missing keyframe file.
  {
    const sd = stateDir("state-d6");
    const runId = "bra90-d6";
    await strandDelta(sd, runId);
    const m = readManifest(sd, runId)!;
    const kf = path.join(keyframeDir(sd), `${m.keyframeHash}.snap`);
    fs.rmSync(kf);
    check(!fs.existsSync(kf), "D6 SETUP OK: keyframe file deleted");
    const d = drive(sd);
    check(d.rc !== 0, `D6 LOUD OK: queue run exited non-zero with the keyframe missing (got ${d.rc})`);
    expectFailedNoResult(sd, runId, "D6 MISSING-KEYFRAME", /missing keyframe file/);
  }
}

async function scenarioE(): Promise<void> {
  console.log("\n=== E. fork (branches share the keyframe) ===");
  const sd = stateDir("state-e");
  const runId = "bra90-e";
  submit(sd, FORK, runId, { branches: 2 });
  const d = drive(sd);
  check(d.rc === 0, `E DRIVE OK: queue run exited 0 (got ${d.rc})`);
  check(queueStatus(sd, runId) === "done", `E DRIVE OK: ${runId} done`);
  const res = getResult(sd, runId);
  check(
    Array.isArray(res?.parts) && res.parts.length === 2 && res.parts[0] === "branch-0" && res.parts[1] === "branch-1",
    `E JOIN OK: result returns both branch names (got ${JSON.stringify(res?.parts)})`,
  );
  const parentLines = snapshotLines(sd, runId);
  const parentKeyframeSize = parentLines.length > 0 ? parentLines[0].bytes : 0;
  check(parentKeyframeSize > 1000, `E PARENT OK: parent keyframe is ${parentKeyframeSize} bytes (> 1000)`);
  for (const i of [0, 1]) {
    const childId = `${runId}/fork-0/branch-${i}`;
    const lines = snapshotLines(sd, childId);
    check(lines.length >= 1, `E BRANCH OK: branch ${i} slice log has snapshot saves (${lines.length})`);
    check(
      lines.every((l) => l.kind === "delta"),
      `E BRANCH OK: branch ${i} wrote deltas only, never a keyframe (${lines.map((l) => `${l.kind}:${l.bytes}`).join(",")})`,
    );
    check(
      lines.every((l) => l.bytes < parentKeyframeSize / 4),
      `E BRANCH OK: branch ${i} deltas are small (< 1/4 of the ${parentKeyframeSize}-byte keyframe each — a delta against the shared keyframe, not a full copy: ${lines.map((l) => l.bytes).join(",")})`,
    );
  }
  const kf = keyframeFiles(sd);
  check(kf.length === 1, `E SHARED OK: exactly one keyframe file — no per-branch copy (${kf.length})`);
  check(
    kf.length === 1 && shaFile(path.join(keyframeDir(sd), kf[0])) === shaFile(blobPath(sd, runId)),
    "E SHARED OK: the single keyframe equals the parent's .snap (the shared fork-point keyframe)",
  );
  check(
    fs.existsSync(blobPath(sd, runId)) && fs.statSync(blobPath(sd, runId)).size > 1000,
    "E SNAP OK: parent .snap is the keyframe copy (> 1000 bytes)",
  );
}

async function scenarioF(): Promise<void> {
  console.log("\n=== F. write amplification (30-sleep run) ===");
  const sd = stateDir("state-f");
  const runId = "bra90-f";
  submit(sd, SLEEPS, runId, { count: 30 });
  const d = drive(sd);
  check(d.rc === 0, `F DRIVE OK: queue run exited 0 (got ${d.rc})`);
  check(queueStatus(sd, runId) === "done", `F DRIVE OK: ${runId} done`);
  const res = getResult(sd, runId);
  check(res?.sleeps === 30, `F RESULT OK: ${runId} result returns 30 sleeps (got ${res?.sleeps})`);
  const lines = snapshotLines(sd, runId);
  check(lines.length === 30, `F LOG OK: 30 snapshot saves in the slice log (got ${lines.length})`);
  check(
    lines.length === 30 && lines[0].kind === "base" && lines[25].kind === "base" &&
      lines.slice(1, 25).every((l) => l.kind === "delta") && lines.slice(26).every((l) => l.kind === "delta"),
    "F LOG OK: kinds are base + 24 delta + base (ordinal-25 keyframe) + 4 delta",
  );
  const total = lines.reduce((s, l) => s + l.bytes, 0);
  const keyframeSize = lines[0]?.bytes ?? 0;
  const fullTotal = 30 * keyframeSize;
  const ratio = fullTotal > 0 ? total / fullTotal : NaN;
  const deltaTotal = lines.filter((l) => l.kind === "delta").reduce((s, l) => s + l.bytes, 0);
  const baseTotal = lines.filter((l) => l.kind === "base").reduce((s, l) => s + l.bytes, 0);
  console.log(
    `F NUMBERS: keyframe=${keyframeSize} bytes, base-total=${baseTotal} (2 keyframes), delta-total=${deltaTotal} (28 deltas), ` +
      `written-total=${total}, full-every-time=${fullTotal}, ratio=${ratio.toFixed(3)} (vs full snapshots every suspension)`,
  );
  check(
    ratio < 0.6,
    `F AMP OK: written bytes are ${ratio.toFixed(3)}x the full-every-time total (< 0.6 — the chain's write saving, measured on a real run)`,
  );
}

async function scenarioG(): Promise<void> {
  console.log("\n=== G. legacy migration (manifest + delta deleted) ===");
  const sd = stateDir("state-g");
  const runId = "bra90-g";
  const marker = path.join(WORKDIR, "bra90-g.marker");
  // Strand at the ordinal-25 KEYFRAME suspension: the .snap file is
  // the ordinal-25 keyframe, a full snapshot of the LATEST
  // suspension — so deleting the manifest + delta leaves a TRUE
  // legacy blob (single full snapshot, no chain record), not a
  // rewind. (Deleting the manifest from a delta checkpoint would
  // leave .snap = the ordinal-0 keyframe and the run would rewind
  // to it and replay the recorded trap answers from the journal —
  // correct, but a replay, not a legacy resume.)
  submit(sd, SLEEPS_EXEC, runId, { count: 25, after: 3, markerFile: marker, sleepMs: 2000 });
  const child = await strandRun(sd, runId, marker);
  children.push(child);
  const m = readManifest(sd, runId);
  check(m?.kind === "keyframe" && m?.ordinal === 25, `G SETUP OK: stranded at a keyframe checkpoint (kind ${m?.kind}, ordinal ${m?.ordinal})`);
  // Simulate a pre-chain blob: just the .snap full snapshot.
  fs.rmSync(manifestPath(sd, runId));
  fs.rmSync(deltaPath(sd, runId));
  check(!fs.existsSync(manifestPath(sd, runId)) && !fs.existsSync(deltaPath(sd, runId)), "G SETUP OK: manifest + delta deleted (legacy single-file blob)");
  check(fs.existsSync(blobPath(sd, runId)), "G SETUP OK: .snap full snapshot remains");
  const d = drive(sd);
  check(d.rc === 0, `G RESUME OK: queue run exited 0 on the legacy blob (got ${d.rc})`);
  check(queueStatus(sd, runId) === "done", `G RESUME OK: ${runId} done after resuming the legacy blob`);
  const res = getResult(sd, runId);
  check(res?.sleeps === 28, `G RESUME OK: ${runId} result returns 28 sleeps (got ${res?.sleeps})`);
  // The run completed, so its manifest was discarded — but the
  // slice log proves the migration: a base save at the first
  // post-resume suspension (the fresh chain's ordinal 0), then
  // deltas. 26 pre-strand saves + 3 post-resume saves.
  const lines = snapshotLines(sd, runId);
  check(lines.length === 29, `G LOG OK: 29 snapshot saves total (got ${lines.length})`);
  check(
    lines.length === 29 && lines[26].kind === "base" && lines[27].kind === "delta" && lines[28].kind === "delta",
    `G MIGRATION OK: the first post-resume suspension wrote a base, then deltas (kinds ${lines.map((l) => l.kind).join(",")}) — the run migrated onto a fresh chain`,
  );
  // No replay: the journal holds exactly one trap event per trap
  // call (25 sleeps + exec + 3 sleeps). A rewind would re-suspend
  // at the replayed traps and show more.
  const journalFile = path.join(sd, "journals", `${runId}.journal`);
  const trapEvents = fs.existsSync(journalFile)
    ? fs.readFileSync(journalFile, "utf8").split("\n").filter((l) => l.includes('"event":"trap"')).length
    : -1;
  check(trapEvents === 29, `G NO-REPLAY OK: exactly 29 trap events in the journal (got ${trapEvents}) — the legacy resume was direct, not a rewind-and-replay`);
  const m2 = readManifest(sd, runId);
  check(m2 === null, "G CLEANUP OK: the completed run's manifest was discarded (no stale chain left behind)");
}

async function scenarioH(): Promise<void> {
  console.log("\n=== H. interval 0 = full-only ===");
  const sd = stateDir("state-h");
  const runId = "bra90-h";
  const marker = path.join(WORKDIR, "bra90-h.marker");
  const env = { DURABLETS_KEYFRAME_INTERVAL: "0" };
  submit(sd, SLEEPS_EXEC, runId, { count: 5, after: 0, markerFile: marker, sleepMs: 2000 });
  const child = await strandRun(sd, runId, marker, env);
  children.push(child);
  const m = readManifest(sd, runId);
  check(m?.kind === "keyframe", `H MANIFEST OK: kind is keyframe (got ${m?.kind})`);
  check(m?.trigger === "full-only", `H MANIFEST OK: trigger is full-only (got ${m?.trigger})`);
  check(m?.ordinal === 5, `H MANIFEST OK: ordinal is 5 (got ${m?.ordinal})`);
  check(m?.sinceKeyframe === 0, `H MANIFEST OK: sinceKeyframe is 0 (got ${m?.sinceKeyframe})`);
  const lines = snapshotLines(sd, runId);
  check(lines.length === 6, `H LOG OK: 6 snapshot saves in the slice log (got ${lines.length})`);
  check(
    lines.length === 6 && lines.every((l) => l.kind === "base"),
    `H LOG OK: every suspension wrote a base, 0 deltas (${lines.map((l) => l.kind).join(",")})`,
  );
  const kf = keyframeFiles(sd);
  check(kf.length === 1, `H PRUNE OK: exactly one keyframe file — each new keyframe unpinned the previous (${kf.length})`);
  const d = drive(sd, env);
  check(d.rc === 0, `H RESUME OK: queue run exited 0 (got ${d.rc})`);
  check(queueStatus(sd, runId) === "done", `H RESUME OK: ${runId} done`);
  const res = getResult(sd, runId);
  check(res?.sleeps === 5, `H RESUME OK: ${runId} result returns 5 sleeps (got ${res?.sleeps})`);
}

try {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();
  await scenarioF();
  await scenarioG();
  await scenarioH();
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
  console.log(`\nFAIL bra90 incremental-snapshots suite (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra90 incremental-snapshots suite (chain basics + interval keyframe + ratio keyframe, torn/corrupt/wrong-hash/missing fault injection, shared-keyframe fork, measured write amplification, legacy migration, full-only interval 0)");
