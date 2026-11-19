#!/usr/bin/env bun
/**
 * Blob-recipe audit test (Linear BRA-95).
 *
 * The storeBlob recipe (atomicCopyVerified, the G4 pattern) verified
 * each copy twice — tmp vs src before rename, dest vs src after —
 * but hashed the SOURCE twice: shaFile(src) once per check, the same
 * file, the same bytes. The second computation was pure waste
 * (~0.85 ms per copy at 500KB, ~0.05 ms at 10KB, median of 21 —
 * ~/workspace/bra95-measure.ts), two copies per base-mode
 * suspension. The fix computes the src hash once and reuses it.
 *
 * Per-hash audit (why the other two hashes stay):
 *   - sha(tmp): load-bearing — the pre-commit gate. A torn copy is
 *     caught BEFORE rename, so it never reaches its final path and
 *     cannot poison a hash-named keyframe file.
 *   - sha(src): load-bearing as the reference — but computed once,
 *     not twice. Caching is also more correct: the copy was taken
 *     from src as it was when check A ran, so check B must compare
 *     the dest against that same src; a fresh hash would fail
 *     spuriously if src changed mid-call.
 *   - sha(dst): load-bearing — the post-commit confirmation, the
 *     only verification of the artifact at its final path after
 *     rename. Dropping it would weaken the G4 "sha-verify both
 *     sides" guarantee to "verified pre-rename, rename assumed
 *     faithful", which the issue forbids.
 *
 * What this proves (CLI-driven, real runs, own state dirs):
 *   A. Checkpoint integrity after the change: a run stranded at a
 *      delta checkpoint has a manifest whose keyframeHash/deltaHash
 *      are the shas of the bytes on disk, the .snap keyframe copy
 *      is byte-identical to the keyframe file, and the run drives
 *      to completion with the right result.
 *   B. Corruption is still detected: a truncated .delta and a
 *      truncated keyframe file each fail loudly on drive (entry
 *      failed, /crashed resuming/i, no result) — the guarantee the
 *      two kept hashes provide survives the change.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra95.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra94
 *   suite.) Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA95_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra95-"));

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
const queuePath = (sd: string): string => path.join(sd, "queue.json");

function shaFile(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
function readQueueStrict(sd: string): any[] {
  return JSON.parse(fs.readFileSync(queuePath(sd), "utf8"));
}
function queueStatus(sd: string, runId: string): string | null {
  try {
    const q = readQueueStrict(sd);
    return q.find((e) => e.runId === runId)?.status ?? null;
  } catch {
    return null;
  }
}
function queueError(sd: string, runId: string): string | null {
  try {
    const q = readQueueStrict(sd);
    return q.find((e) => e.runId === runId)?.error ?? null;
  } catch {
    return null;
  }
}
function markerLines(file: string): number {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
function readManifest(sd: string, runId: string): any | null {
  const p = manifestPath(sd, runId);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function keyframeFiles(sd: string): string[] {
  const d = keyframeDir(sd);
  try {
    return fs.readdirSync(d).filter((f) => f.endsWith(".snap")).sort();
  } catch {
    return [];
  }
}
function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function driveChild(sd: string, env: Record<string, string> = {}): Subprocess {
  // Bun.spawn (not node:child_process): its Subprocess has a real
  // .exited promise, so `await child.exited` after kill(9) waits
  // until the holder pid is actually gone and the driver lock reads
  // stale. A node ChildProcess has no .exited — awaiting it resolves
  // immediately and the next drive is refused as "driver already
  // running".
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
    await Bun.sleep(100);
  }
  console.log(`TIMEOUT waiting for ${what}`);
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

async function scenarioA(): Promise<void> {
  console.log("\n=== A. checkpoint integrity after the BRA-95 change (stranded at a delta checkpoint) ===");
  const sd = stateDir("state-a");
  const runId = "bra95-a";
  const marker = path.join(WORKDIR, "bra95-a.marker");
  submit(sd, SLEEPS_EXEC, runId, { count: 3, after: 0, markerFile: marker, sleepMs: 2000 });
  const child = await strandRun(sd, runId, marker);
  children.push(child);
  const m = readManifest(sd, runId);
  check(m !== null, "A MANIFEST OK: checkpoint manifest exists for the stranded run");
  check(m?.format === "bra90-chain-v1", `A MANIFEST OK: format is bra90-chain-v1 (got ${m?.format})`);
  check(m?.kind === "delta" && m?.ordinal === 3, `A MANIFEST OK: kind delta, ordinal 3 (got ${m?.kind}/${m?.ordinal})`);
  check(
    typeof m?.keyframeHash === "string" && /^[0-9a-f]{64}$/.test(m.keyframeHash),
    "A MANIFEST OK: keyframeHash is a sha256",
  );
  check(
    typeof m?.deltaHash === "string" && /^[0-9a-f]{64}$/.test(m.deltaHash),
    "A MANIFEST OK: deltaHash is a sha256",
  );
  const kf = keyframeFiles(sd);
  check(kf.length === 1, `A KEYFRAME OK: exactly one keyframe file (${kf.length})`);
  check(kf.length === 1 && kf[0] === `${m?.keyframeHash}.snap`, "A KEYFRAME OK: the keyframe file is named by the manifest's keyframeHash");
  check(
    fs.existsSync(blobPath(sd, runId)) && shaFile(blobPath(sd, runId)) === m?.keyframeHash,
    "A SNAP OK: .snap bytes hash to the manifest keyframeHash (the keyframe copy verified by both checks)",
  );
  check(
    kf.length === 1 && shaFile(path.join(keyframeDir(sd), kf[0])) === m?.keyframeHash,
    "A KEYFRAME OK: the keyframe file bytes hash to the manifest keyframeHash",
  );
  check(
    fs.existsSync(deltaPath(sd, runId)) && m?.deltaHash === shaFile(deltaPath(sd, runId)),
    "A DELTA OK: manifest deltaHash is the sha of the .delta bytes",
  );
  check(
    fs.existsSync(liveSnapPath(sd, runId)) &&
      shaFile(deltaPath(sd, runId)) === shaFile(liveSnapPath(sd, runId)),
    "A DELTA OK: .delta bytes equal the live slice snap bytes (the suspension's delta, copied by storeBlob)",
  );
  const d = drive(sd);
  check(d.rc === 0, `A RESUME OK: queue run exited 0 (got ${d.rc})`);
  check(queueStatus(sd, runId) === "done", `A RESUME OK: ${runId} done`);
  const res = getResult(sd, runId);
  check(res?.sleeps === 3, `A RESUME OK: ${runId} result returns 3 sleeps (got ${res?.sleeps})`);
}

async function scenarioB(): Promise<void> {
  console.log("\n=== B. corruption is still detected (truncated delta, truncated keyframe) ===");
  const strandDelta = async (sd: string, runId: string): Promise<void> => {
    const marker = path.join(WORKDIR, `${runId}.marker`);
    submit(sd, SLEEPS_EXEC, runId, { count: 3, after: 0, markerFile: marker, sleepMs: 2000 });
    const child = await strandRun(sd, runId, marker);
    children.push(child);
    const m = readManifest(sd, runId);
    check(m?.kind === "delta" && m?.ordinal === 3, `B SETUP OK: ${runId} stranded at a delta checkpoint (kind ${m?.kind}, ordinal ${m?.ordinal})`);
  };
  const expectFailedNoResult = (sd: string, runId: string, label: string, errRe: RegExp): void => {
    check(queueStatus(sd, runId) === "failed", `${label}: entry is failed (never silently completed from a corrupt checkpoint)`);
    const err = queueError(sd, runId) ?? "";
    check(errRe.test(err), `${label}: failure names the problem (${errRe} — error: ${err.slice(0, 200)})`);
    check(getResult(sd, runId) === null, `${label}: result returns no output (no bogus result from a corrupt checkpoint)`);
  };

  // B1: truncated delta.
  {
    const sd = stateDir("state-b1");
    const runId = "bra95-b1";
    await strandDelta(sd, runId);
    const full = fs.readFileSync(deltaPath(sd, runId));
    fs.writeFileSync(deltaPath(sd, runId), full.subarray(0, 40));
    check(fs.statSync(deltaPath(sd, runId)).size === 40, "B1 SETUP OK: .delta truncated to 40 bytes");
    const d = drive(sd);
    check(d.rc !== 0, `B1 LOUD OK: queue run exited non-zero on a truncated delta (got ${d.rc})`);
    expectFailedNoResult(sd, runId, "B1 TRUNCATED-DELTA", /crashed resuming/i);
  }
  // B2: truncated keyframe.
  {
    const sd = stateDir("state-b2");
    const runId = "bra95-b2";
    await strandDelta(sd, runId);
    const m = readManifest(sd, runId)!;
    const kf = path.join(keyframeDir(sd), `${m.keyframeHash}.snap`);
    const full = fs.readFileSync(kf);
    fs.writeFileSync(kf, full.subarray(0, 40));
    check(fs.statSync(kf).size === 40, "B2 SETUP OK: keyframe truncated to 40 bytes");
    const d = drive(sd);
    check(d.rc !== 0, `B2 LOUD OK: queue run exited non-zero on a truncated keyframe (got ${d.rc})`);
    expectFailedNoResult(sd, runId, "B2 TRUNCATED-KEYFRAME", /crashed resuming/i);
  }
}

try {
  await scenarioA();
  await scenarioB();
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
  console.log(`\nFAIL bra95 blob-recipe suite (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra95 blob-recipe suite (checkpoint integrity after the duplicate-src-hash removal; truncated delta and truncated keyframe still fail loudly)");
