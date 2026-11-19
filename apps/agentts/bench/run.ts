// Bench runner (BRA-93): repeatable performance measurements for AgentTS.
//
//   bun bench/run.ts [--reps N] [--out FILE] [--write-baselines] [--metrics a,b,c]
//
// Measures the hot paths against a fresh scratch state dir per metric
// (default root ~/workspace/agentts-perf-state, override with
// $AGENTTS_PERF_STATE). Never touches the production state dir, never
// runs run.sh, never edits production code. All timings are wall-clock
// medians over --reps repetitions (default 5).
//
// Notifications are pointed at a dead port ($AGENTTS_WORKER_SERVER) so
// no bench event ever reaches the production tick agent, and the
// notify cost is measured separately against a local throwaway server.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Host } from "../src/host";
import { httpSync } from "../src/worker-http";

const BENCH_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(BENCH_DIR, "..", "..", ".."); // bench/ -> agentts/ -> apps/ -> repo
const WORKFLOWS = path.join(BENCH_DIR, "workflows");
const STATE_ROOT =
  process.env.AGENTTS_PERF_STATE ?? path.join(os.homedir(), "workspace", "agentts-perf-state");
const DURABLETS_BIN =
  process.env.DURABLETS_HOST ??
  path.join(REPO_ROOT, "packages", "durablets", "out", "durablets");

process.env.AGENTTS_WORKER_SERVER ??= "http://127.0.0.1:1"; // dead port: notify fails fast, never touches production

// ---------------------------------------------------------------- stats
export interface MetricResult {
  id: string;
  unit: string;
  median: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
  n: number;
  samples: number[];
  note?: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}
function stats(id: string, unit: string, samples: number[], note?: string): MetricResult {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { id, unit, median: median(samples), p95: p95(samples), mean, min: Math.min(...samples), max: Math.max(...samples), n: samples.length, samples, note };
}
function round(x: number): number {
  return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------- helpers
function freshStateDir(tag: string): string {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(STATE_ROOT, `bench-${tag}-`));
}
function rmDir(d: string): void {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch { /* best effort */ }
}
function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
function codeFingerprint(): Record<string, string> {
  const files = [
    "apps/agentts/src/host.ts",
    "apps/agentts/src/extract.ts",
    "apps/agentts/src/agentts.ts",
    "apps/agentts/src/profiler.ts",
    "packages/durablets/src/durablets.c",
  ];
  const fp: Record<string, string> = {};
  for (const f of files) {
    const p = path.join(REPO_ROOT, f);
    fp[f] = fs.existsSync(p) ? sha256File(p).slice(0, 16) : "missing";
  }
  try {
    const st = fs.statSync(DURABLETS_BIN);
    fp["durablets-binary"] = `${st.size}B@${new Date(st.mtimeMs).toISOString()}`;
  } catch {
    fp["durablets-binary"] = "missing";
  }
  return fp;
}
function journalBytes(stateDir: string): number {
  const dir = path.join(stateDir, "journals");
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size;
  return total;
}
function journalLines(stateDir: string): number {
  const dir = path.join(stateDir, "journals");
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    n += fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).length;
  }
  return n;
}

// ---------------------------------------------------------------- metrics
type Ctx = { reps: number };

async function mSliceSpawn(ctx: Ctx): Promise<MetricResult> {
  // Pure C-host slice cost: spawn the binary on a prebuilt bundle of
  // bench-trivial (no traps) and time it. Excludes extract/bundle.
  const dir = freshStateDir("slice-spawn");
  try {
    const host = new Host({ stateDir: dir });
    const wf = path.join(WORKFLOWS, "bench-trivial.ts");
    // submit() first: it validates + stores the input, so driverFor
    // bakes entry({"n":1000}) into the driver (a bare prepareRun
    // would leave the input undefined and the slice would fail).
    const { runId } = host.submit(wf, { runId: "prep", input: { n: 1000 } });
    const driver = host.driverFor(runId);
    const bundle = await host.bundle(driver, "bench-bundle.js");
    const samples: number[] = [];
    for (let i = 0; i < ctx.reps; i++) {
      const snap = path.join(dir, `slice-${i}.snap`);
      const t0 = performance.now();
      const r = spawnSync(DURABLETS_BIN, ["run", bundle, snap], {
        env: { ...process.env, AGENTTS_RUN_ID: `bench-slice-${i}` },
        encoding: "utf8",
      });
      const dt = performance.now() - t0;
      if (r.status !== 0) throw new Error(`C host slice failed rc=${r.status} signal=${r.signal} error=${r.error ? String(r.error) : "none"}: ${(r.stderr ?? "").slice(0, 300)}`);
      samples.push(dt);
    }
    return stats("slice_spawn_ms", "ms", samples, "spawn + QuickJS init + eval + complete, no traps, no snapshot write");
  } finally {
    rmDir(dir);
  }
}

async function mRunE2E(ctx: Ctx): Promise<MetricResult[]> {
  // End-to-end submit + drive + result for bench-trivial.
  // cold: fresh state dir per rep (extract cold: tsc program + gate + checker).
  // warm: same Host, same workflow (extract cache hit; bundle cache hit after the warm-up build).
  const wf = path.join(WORKFLOWS, "bench-trivial.ts");
  const cold: number[] = [];
  const submitCold: number[] = [];
  const driveCold: number[] = [];
  for (let i = 0; i < ctx.reps; i++) {
    const dir = freshStateDir("e2e-cold");
    try {
      const host = new Host({ stateDir: dir });
      const t0 = performance.now();
      const { runId } = host.submit(wf, { runId: `bench-e2e-cold-${i}`, input: { n: 1000 } });
      submitCold.push(performance.now() - t0);
      const t1 = performance.now();
      await host.runQueue();
      const res = host.result(runId);
      driveCold.push(performance.now() - t1);
      const dt = performance.now() - t0;
      if (res.status !== "done") throw new Error(`e2e cold rep ${i} not done: ${JSON.stringify(res)}`);
      cold.push(dt);
    } finally {
      rmDir(dir);
    }
  }
  const warm: number[] = [];
  const submitWarm: number[] = [];
  const driveWarm: number[] = [];
  {
    const dir = freshStateDir("e2e-warm");
    try {
      const host = new Host({ stateDir: dir });
      // Warm-up (discarded): first submit pays the cold extract.
      {
        const { runId } = host.submit(wf, { runId: "bench-e2e-warm-warmup", input: { n: 1000 } });
        await host.runQueue();
        if (host.result(runId).status !== "done") throw new Error("e2e warm warmup failed");
      }
      for (let i = 0; i < ctx.reps; i++) {
        const t0 = performance.now();
        const { runId } = host.submit(wf, { runId: `bench-e2e-warm-${i}`, input: { n: 1000 } });
        submitWarm.push(performance.now() - t0);
        const t1 = performance.now();
        await host.runQueue();
        const res = host.result(runId);
        driveWarm.push(performance.now() - t1);
        const dt = performance.now() - t0;
        if (res.status !== "done") throw new Error(`e2e warm rep ${i} not done: ${JSON.stringify(res)}`);
        warm.push(dt);
      }
    } finally {
      rmDir(dir);
    }
  }
  return [
    stats("run_e2e_ms.trivial.cold", "ms", cold, "submit+drive+result, first run in a fresh state dir (extract cold)"),
    stats("run_e2e_ms.trivial.warm", "ms", warm, "submit+drive+result, same Host/workflow (extract cache hit; bundle cache hit)"),
    stats("submit_ms.cold", "ms", submitCold, "submit() alone, fresh state dir (freeze + extract cold + validate + enqueue + notify)"),
    stats("submit_ms.warm", "ms", submitWarm, "submit() alone, same Host/workflow (extract cache hit)"),
    stats("drive_ms.trivial.cold", "ms", driveCold, "runQueue+result for a trivial run after a cold submit (startRun incl. bundle + 1 slice + status writes)"),
    stats("drive_ms.trivial.warm", "ms", driveWarm, "runQueue+result for a trivial run after a warm submit"),
  ];
}

async function mSnapshot(ctx: Ctx, sizeKb: number): Promise<MetricResult[]> {
  // Suspension + resume latency and blob size for a live heap of sizeKb.
  // startRun (warm extract) suspends at the sleep trap; driveStep resumes.
  const wf = path.join(WORKFLOWS, "bench-snap.ts");
  const suspend: number[] = [];
  const resume: number[] = [];
  const bytes: number[] = [];
  const dir = freshStateDir(`snap-${sizeKb}kb`);
  try {
    const host = new Host({ stateDir: dir });
    // Warm-up (discarded): the first startRun pays the cold extract.
    // Timed reps must measure suspension, not tsc.
    {
      const warmId = `bench-snap-${sizeKb}kb-warmup`;
      const wrc = await host.startRun(wf, warmId, { sizeKb });
      if (wrc !== 2) throw new Error(`bench-snap ${sizeKb}kb warmup: expected rc 2, got ${wrc}`);
      const wrc2 = host.driveStep(warmId);
      if (wrc2 !== 0) throw new Error(`bench-snap ${sizeKb}kb warmup resume rc=${wrc2}`);
    }
    for (let i = 0; i < ctx.reps; i++) {
      const runId = `bench-snap-${sizeKb}kb-${i}`;
      const t0 = performance.now();
      const rc = await host.startRun(wf, runId, { sizeKb });
      const dtSuspend = performance.now() - t0;
      if (rc !== 2) throw new Error(`bench-snap ${sizeKb}kb rep ${i}: expected rc 2, got ${rc}`);
      suspend.push(dtSuspend);
      // The live snapshot for THIS rep only (not the dir total: every
      // rep leaves its own .snap behind).
      const snapFile = path.join(dir, "slices", `${runId}.snap`);
      bytes.push(fs.existsSync(snapFile) ? fs.statSync(snapFile).size : 0);
      const t1 = performance.now();
      const rc2 = host.driveStep(runId);
      const dtResume = performance.now() - t1;
      if (rc2 !== 0) throw new Error(`bench-snap ${sizeKb}kb rep ${i}: resume rc=${rc2}`);
      resume.push(dtResume);
      const res = host.result(runId);
      if (res.status !== "done" || (res.output as any)?.len !== sizeKb * 1024) {
        throw new Error(`bench-snap ${sizeKb}kb rep ${i}: bad result ${JSON.stringify(res)}`);
      }
    }
  } finally {
    rmDir(dir);
  }
  return [
    stats(`suspend_ms.${sizeKb}kb`, "ms", suspend, `startRun wall time, live heap ${sizeKb}KB (spawn+eval+snapshot write+blob store)`),
    stats(`resume_ms.${sizeKb}kb`, "ms", resume, `driveStep wall time resuming a ${sizeKb}KB-heap run (scan+dispatch+snapshot read)`),
    stats(`snapshot_bytes.${sizeKb}kb`, "bytes", bytes, `live snapshot bytes for ${sizeKb}KB live heap`),
  ];
}

async function mTrapSteps(ctx: Ctx): Promise<MetricResult[]> {
  // Per-driveStep latency as the journal grows: bench-traps with 200
  // traps, one driveStep per trap, times recorded per step index.
  // driveStep has no round cap (only driveToCompletion caps at 50),
  // so a 200-trap run shows whether the per-trap journal scans grow
  // with journal length (~10 events/trap -> ~2000 events by the end).
  const wf = path.join(WORKFLOWS, "bench-traps.ts");
  const first5: number[] = [];
  const last5: number[] = [];
  const allSteps: number[] = [];
  const dir = freshStateDir("trap-steps");
  try {
    const host = new Host({ stateDir: dir });
    // Warm-up (discarded): first startRun pays the cold extract.
    {
      const wrc = await host.startRun(wf, "bench-traps-200-warmup", { traps: 200 });
      if (wrc !== 2) throw new Error(`bench-traps warmup: expected rc 2, got ${wrc}`);
      let cur = wrc;
      let steps = 0;
      while (cur === 2) { cur = host.driveStep("bench-traps-200-warmup"); steps++; }
      if (cur !== 0 || steps !== 200) throw new Error(`bench-traps warmup: rc=${cur} steps=${steps}`);
    }
    for (let r = 0; r < ctx.reps; r++) {
      const runId = `bench-traps-200-${r}`;
      const rc = await host.startRun(wf, runId, { traps: 200 });
      if (rc !== 2) throw new Error(`bench-traps rep ${r}: expected rc 2, got ${rc}`);
      let step = 0;
      let cur = rc;
      while (cur === 2) {
        step++;
        const t0 = performance.now();
        cur = host.driveStep(runId);
        const dt = performance.now() - t0;
        allSteps.push(dt);
        if (step <= 5) first5.push(dt);
        if (step > 195) last5.push(dt);
      }
      if (cur !== 0 || step !== 200) throw new Error(`bench-traps rep ${r}: ended rc=${cur} after ${step} steps`);
      const res = host.result(runId);
      if (res.status !== "done") throw new Error(`bench-traps rep ${r}: not done`);
    }
    const note = `per-driveStep wall time, 200 sequential exec traps; journal grows ~10 events/trap (first5 vs last5 shows the scan cost)`;
    return [
      stats("trap_step_ms.first5", "ms", first5, note),
      stats("trap_step_ms.last5", "ms", last5, note),
      stats("trap_step_ms.median", "ms", allSteps, note),
    ];
  } finally {
    rmDir(dir);
  }
}

async function mFork(ctx: Ctx): Promise<MetricResult> {
  // Per-branch fork cost: bench-fork with 4 branches, time startForkBranches.
  const wf = path.join(WORKFLOWS, "bench-fork.ts");
  const perBranch: number[] = [];
  const dir = freshStateDir("fork");
  try {
    const host = new Host({ stateDir: dir });
    // Warm-up (discarded): first startRun pays the cold extract.
    {
      const wrc = await host.startRun(wf, "bench-fork-4-warmup", { branches: 4 });
      if (wrc !== 3) throw new Error(`bench-fork warmup: expected rc 3, got ${wrc}`);
      host.startForkBranches("bench-fork-4-warmup");
    }
    for (let i = 0; i < ctx.reps; i++) {
      const runId = `bench-fork-4-${i}`;
      const rc = await host.startRun(wf, runId, { branches: 4 });
      if (rc !== 3) throw new Error(`bench-fork rep ${i}: expected rc 3, got ${rc}`);
      const t0 = performance.now();
      const children = host.startForkBranches(runId);
      const dt = performance.now() - t0;
      if (children.length !== 4) throw new Error(`bench-fork rep ${i}: ${children.length} children`);
      perBranch.push(dt / 4);
    }
    return stats("fork_ms.per_branch", "ms", perBranch, "startForkBranches wall time / 4 branches (snapshot copy + branch spawn each)");
  } finally {
    rmDir(dir);
  }
}

async function mEnqueue(ctx: Ctx): Promise<MetricResult[]> {
  // Enqueue throughput: raw queue RMW (host.enqueue) on an empty queue
  // vs a queue already holding 200 entries (full read+parse+2 writes).
  const wf = path.join(WORKFLOWS, "bench-trivial.ts");
  const dir = freshStateDir("enqueue");
  try {
    const host = new Host({ stateDir: dir });
    const first100: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      host.enqueue(wf, `bench-enq-${i}`, { input: { n: 1 } });
      first100.push(performance.now() - t0);
    }
    for (let i = 100; i < 200; i++) host.enqueue(wf, `bench-enq-${i}`, { input: { n: 1 } });
    const next20: number[] = [];
    for (let i = 200; i < 220; i++) {
      const t0 = performance.now();
      host.enqueue(wf, `bench-enq-${i}`, { input: { n: 1 } });
      next20.push(performance.now() - t0);
    }
    return [
      stats("enqueue_ms", "ms", first100, "host.enqueue, queue 0-100 entries (lock + read + parse + 2 atomic writes)"),
      stats("enqueue_ms.q200", "ms", next20, "host.enqueue, queue at 200 entries (same work, bigger files)"),
    ];
  } finally {
    rmDir(dir);
  }
}

async function mJournal(ctx: Ctx): Promise<MetricResult[]> {
  // journalEvent cost: small vs 10KB-payload events.
  const dir = freshStateDir("journal");
  try {
    const host = new Host({ stateDir: dir });
    const small: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t0 = performance.now();
      host.journalEvent("bench-journal", { event: "bench", i });
      small.push(performance.now() - t0);
    }
    const bigPayload = "x".repeat(10 * 1024);
    const large: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      host.journalEvent("bench-journal", { event: "bench", i, payload: bigPayload });
      large.push(performance.now() - t0);
    }
    return [
      stats("journal_event_ms.small", "ms", small, "journalEvent per event, tiny payload (mkdir + validate + stringify + append)"),
      stats("journal_event_ms.large10kb", "ms", large, "journalEvent per event, 10KB payload"),
    ];
  } finally {
    rmDir(dir);
  }
}

async function mHostConstruct(ctx: Ctx): Promise<MetricResult[]> {
  // Fresh-process tax: new Host() with an empty state dir vs a dir
  // holding 10 journals x ~100 events (built by real runs).
  const empty: number[] = [];
  for (let i = 0; i < ctx.reps; i++) {
    const dir = freshStateDir("construct-empty");
    try {
      const t0 = performance.now();
      new Host({ stateDir: dir });
      empty.push(performance.now() - t0);
    } finally {
      rmDir(dir);
    }
  }
  const dir = freshStateDir("construct-journals");
  try {
    const host = new Host({ stateDir: dir });
    const wf = path.join(WORKFLOWS, "bench-traps.ts");
    for (let i = 0; i < 10; i++) {
      const { runId } = host.submit(wf, { runId: `bench-construct-${i}`, input: { traps: 10 } });
      await host.runQueue();
      if (host.result(runId).status !== "done") throw new Error("construct seed run failed");
    }
    const bytes = journalBytes(dir);
    const lines = journalLines(dir);
    const loaded: number[] = [];
    for (let i = 0; i < ctx.reps; i++) {
      const t0 = performance.now();
      new Host({ stateDir: dir });
      loaded.push(performance.now() - t0);
    }
    // Scaling probe: one synthetic journal with 100,000 small events
    // (written directly — no runs needed), to see how construction
    // cost grows with journal volume.
    const bigDir = freshStateDir("construct-100k");
    const bigLines: string[] = [];
    for (let i = 0; i < 100_000; i++) bigLines.push(JSON.stringify({ event: "bench", runId: "bench-big", i }));
    fs.mkdirSync(path.join(bigDir, "journals"), { recursive: true });
    fs.writeFileSync(path.join(bigDir, "journals", "bench-big.journal"), bigLines.join("\n") + "\n");
    const bigBytes = journalBytes(bigDir);
    const bigLoaded: number[] = [];
    for (let i = 0; i < ctx.reps; i++) {
      const t0 = performance.now();
      new Host({ stateDir: bigDir });
      bigLoaded.push(performance.now() - t0);
    }
    rmDir(bigDir);
    // BRA-97: scaling probe at 1,000,000 events — the regime where
    // construction becomes user-visible (~0.34s measured Nov 18,
    // linear at ~0.34us/event; 10M events projects to ~3.4s per
    // Host construction, paid per CLI call). Written in 100k-line
    // chunks so the ~47MB journal never sits as one string in memory.
    // BRA-98: construction no longer loads journals, so these
    // probes now measure that construction stays O(1) in journal
    // volume — the parse cost moved to first journal() access.
    const hugeDir = freshStateDir("construct-1m");
    const hugePath = path.join(hugeDir, "journals", "bench-big.journal");
    fs.mkdirSync(path.join(hugeDir, "journals"), { recursive: true });
    {
      const fd = fs.openSync(hugePath, "w");
      try {
        for (let base = 0; base < 1_000_000; base += 100_000) {
          const lines: string[] = [];
          for (let i = base; i < base + 100_000; i++) {
            lines.push(JSON.stringify({ event: "bench", runId: "bench-big", i }));
          }
          fs.writeSync(fd, lines.join("\n") + "\n");
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    const hugeBytes = journalBytes(hugeDir);
    const hugeLoaded: number[] = [];
    for (let i = 0; i < ctx.reps; i++) {
      const t0 = performance.now();
      new Host({ stateDir: hugeDir });
      hugeLoaded.push(performance.now() - t0);
    }
    rmDir(hugeDir);
    return [
      stats("host_construct_ms.empty", "ms", empty, "new Host() on an empty state dir"),
      stats("host_construct_ms.journals", "ms", loaded, `new Host() with 10 journals on disk, ${lines} events, ${(bytes / 1024).toFixed(0)}KB — not loaded at construction (BRA-98)`),
      stats("host_construct_ms.journals100k", "ms", bigLoaded, `new Host() with 1 synthetic journal on disk, 100,000 events, ${(bigBytes / 1024 / 1024).toFixed(1)}MB — not loaded at construction (BRA-98)`),
      stats("host_construct_ms.journals1m", "ms", hugeLoaded, `new Host() with 1 synthetic journal on disk, 1,000,000 events, ${(hugeBytes / 1024 / 1024).toFixed(1)}MB — not loaded at construction (BRA-98)`),
    ];
  } finally {
    rmDir(dir);
  }
}

async function mResult(ctx: Ctx): Promise<MetricResult[]> {
  // Result-fetch latency: fresh CLI process vs warm in-process Host.
  const dir = freshStateDir("result");
  try {
    const host = new Host({ stateDir: dir });
    const wf = path.join(WORKFLOWS, "bench-trivial.ts");
    const { runId } = host.submit(wf, { runId: "bench-result-1", input: { n: 1000 } });
    await host.runQueue();
    if (host.result(runId).status !== "done") throw new Error("result seed run failed");
    const warm: number[] = [];
    for (let i = 0; i < ctx.reps; i++) {
      const t0 = performance.now();
      const res = host.result(runId);
      warm.push(performance.now() - t0);
      if (res.status !== "done") throw new Error("warm result failed");
    }
    const cli: number[] = [];
    const cliPath = path.join(REPO_ROOT, "apps", "agentts", "src", "cli.ts");
    for (let i = 0; i < ctx.reps; i++) {
      const t0 = performance.now();
      const r = spawnSync(process.execPath, [cliPath, "result", runId, "--state-dir", dir], { encoding: "utf8" });
      cli.push(performance.now() - t0);
      if (r.status !== 0) throw new Error(`cli result failed: ${(r.stderr ?? "").slice(0, 300)}`);
    }
    return [
      stats("result_ms.warm_host", "ms", warm, "host.result() on a warm Host (readQueue + cache read + validate)"),
      stats("result_ms.fresh_cli", "ms", cli, "bun src/cli.ts result in a fresh process (Bun startup + Host construct + readQueue + extract)"),
    ];
  } finally {
    rmDir(dir);
  }
}

async function mExtractBundle(ctx: Ctx): Promise<MetricResult[]> {
  // First-run gate: cold extract (tsc program + gate + checker) vs warm
  // (content-hash cache hit), and the per-run bundle cost through the
  // bundle cache (BRA-94: the first build pays Bun.build; later runs
  // with the same frozen workflow + input reuse the cached bundle).
  const wf = path.join(WORKFLOWS, "bench-trivial.ts");
  const cold: number[] = [];
  for (let i = 0; i < ctx.reps; i++) {
    const dir = freshStateDir("extract-cold");
    try {
      const host = new Host({ stateDir: dir });
      const t0 = performance.now();
      host.prepareRun(wf, `bench-extract-cold-${i}`);
      cold.push(performance.now() - t0);
    } finally {
      rmDir(dir);
    }
  }
  const warm: number[] = [];
  const bundle: number[] = [];
  {
    const dir = freshStateDir("extract-warm");
    try {
      const host = new Host({ stateDir: dir });
      // BRA-94: prepare on the FROZEN entry, like the production path
      // (submit freezes first) — the drivers then import the frozen
      // path, so the bundle cache engages and bundle_ms measures the
      // per-run cached cost. A live-path driver would never hit the
      // cache (it names no content), so measuring on it would keep
      // charging every run for a build production never pays.
      const frozen = host.freezeWorkflow(wf);
      // Warm-up (discarded): the first prepareRun pays the cold extract.
      host.prepareRun(frozen.entryPath, "bench-extract-warm-warmup");
      for (let i = 0; i < ctx.reps; i++) {
        const t0 = performance.now();
        host.prepareRun(frozen.entryPath, `bench-extract-warm-${i}`);
        warm.push(performance.now() - t0);
        const driver = host.driverFor(`bench-extract-warm-${i}`);
        const t1 = performance.now();
        await host.bundle(driver, `bench-bundle-${i}.js`);
        bundle.push(performance.now() - t1);
      }
    } finally {
      rmDir(dir);
    }
  }
  return [
    stats("extract_ms.cold", "ms", cold, "prepareRun on a fresh state dir (tsc createProgram + layering gate + M2 checker)"),
    stats("extract_ms.warm", "ms", warm, "prepareRun, same workflow, cache dir warm (cache read + JSON.parse)"),
    stats("bundle_ms", "ms", bundle, "per-run bundle cost through the bundle cache (first sample pays Bun.build + read-back + import/export scan; later samples are cache hits)"),
  ];
}

async function mFsyncBlob(ctx: Ctx): Promise<MetricResult[]> {
  // Apportion the snapshot-write cost: raw write+fsync+rename+dir-fsync
  // (the write_file_atomic recipe) vs a plain write, and the storeBlob
  // recipe (copy + 3x sha256) — all on a 500KB payload.
  const dir = freshStateDir("fsync");
  try {
    const data = Buffer.alloc(500 * 1024, 0x61);
    const plain: number[] = [];
    const synced: number[] = [];
    for (let i = 0; i < ctx.reps; i++) {
      const p = path.join(dir, `plain-${i}.bin`);
      const t0 = performance.now();
      fs.writeFileSync(p, data);
      fs.renameSync(p, path.join(dir, `plain-${i}.done`));
      plain.push(performance.now() - t0);
      const tmp = path.join(dir, `sync-${i}.tmp`);
      const dst = path.join(dir, `sync-${i}.done`);
      const t1 = performance.now();
      const fd = fs.openSync(tmp, "w");
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, dst);
      const dfd = fs.openSync(dir, "r");
      fs.fsyncSync(dfd);
      fs.closeSync(dfd);
      synced.push(performance.now() - t1);
    }
    const recipe: number[] = [];
    const src = path.join(dir, "blob-src.bin");
    fs.writeFileSync(src, data);
    for (let i = 0; i < ctx.reps; i++) {
      const tmp = path.join(dir, `blob-${i}.tmp`);
      const dst = path.join(dir, `blob-${i}.done`);
      const t0 = performance.now();
      // BRA-95: the recipe is copy + 3 hashes (tmp, src, dst) — the
      // src hash is computed once and reused for both verifications
      // in atomicCopyVerified; the old code hashed src twice.
      fs.copyFileSync(src, tmp);
      sha256File(tmp);
      sha256File(src);
      fs.renameSync(tmp, dst);
      sha256File(dst);
      recipe.push(performance.now() - t0);
    }
    return [
      stats("fsync_ms.500kb.plain", "ms", plain, "write 500KB + rename, no fsync (reference)"),
      stats("fsync_ms.500kb.atomic", "ms", synced, "write 500KB + fsync file + rename + fsync dir (write_file_atomic recipe)"),
      stats("blob_recipe_ms.500kb", "ms", recipe, "copy 500KB + sha256 x3 (storeBlob recipe)"),
    ];
  } finally {
    rmDir(dir);
  }
}

async function mNotify(ctx: Ctx): Promise<MetricResult[]> {
  // notifyEvent cost: against a throwaway HTTP server in its OWN
  // process vs a dead port. The server stays a separate process so
  // the bench measures the production shape (the worker server is
  // its own process). BRA-96: the POST is a fire-and-forget
  // in-process fetch, so each timed call measures initiation only
  // (~0.3ms) — the round-trip lands in the background before the
  // process exits. The hits assertion below waits for delivery to
  // settle (up to 5s) instead of reading the file immediately,
  // which would race the async POSTs.
  const dir = freshStateDir("notify");
  const { spawn } = await import("node:child_process");
  try {
    const host = new Host({ stateDir: dir });
    const port = 18991;
    const hitsFile = path.join(dir, "hits.txt");
    const server = spawn(process.execPath, [path.join(BENCH_DIR, "notify-server.ts"), String(port), hitsFile], {
      stdio: "ignore",
    });
    try {
      // Wait for the server's /health (up to 5s).
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.ok) break;
        } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error("notify server did not come up on :18991");
        await Bun.sleep(50);
      }
      const live: number[] = [];
      process.env.AGENTTS_WORKER_SERVER = `http://127.0.0.1:${port}`;
      for (let i = 0; i < ctx.reps; i++) {
        const t0 = performance.now();
        host.notifyEvent("workflow-completed", { runId: "bench-notify" });
        live.push(performance.now() - t0);
      }
      // Delivery is async (BRA-96): wait for all hits to land.
      const hitDeadline = Date.now() + 5000;
      for (;;) {
        const hits = fs.existsSync(hitsFile) ? fs.readFileSync(hitsFile, "utf8").split("\n").filter(Boolean).length : 0;
        if (hits === ctx.reps) break;
        if (Date.now() > hitDeadline) throw new Error(`notify server saw ${hits} hits, expected ${ctx.reps}`);
        await Bun.sleep(25);
      }
      const dead: number[] = [];
      process.env.AGENTTS_WORKER_SERVER = "http://127.0.0.1:1";
      for (let i = 0; i < ctx.reps; i++) {
        const t0 = performance.now();
        host.notifyEvent("workflow-completed", { runId: "bench-notify" });
        dead.push(performance.now() - t0);
      }
      return [
        stats("notify_ms.local_server", "ms", live, "notifyEvent POST initiation via in-process fetch to a live loopback server (the production shape; the round-trip lands in the background)"),
        stats("notify_ms.dead_port", "ms", dead, "notifyEvent POST initiation to a dead port (fails fast, best-effort; the rejection lands after the drive has moved on)"),
      ];
    } finally {
      server.kill("SIGTERM");
    }
  } finally {
    rmDir(dir);
  }
}

async function mProductionPath(ctx: Ctx): Promise<MetricResult[]> {
  // The production path, exactly as the tick agent invokes it
  // (BRA-116): submit stays a fresh `bun src/cli.ts` process (the
  // submitter is the operator/coordinator, not the tick agent, and
  // there is no /submit endpoint), but every tick-agent action —
  // tick, tick-beat, queue run, deliver-result, queue list,
  // deliveries — is an HTTP call to the worker server (curl spawn,
  // the same shape as the agent's curl commands in TICK-AGENT.md).
  // BRA-100 measured this path through fresh CLI processes (11 Bun
  // spawns, ~2.3s per unit of work); the driver endpoints (BRA-116)
  // are what remove the spawns. Nothing here touches the production
  // state dir or the production server (:18741); the throwaway
  // server is on :18992 and the notify env points at it for the
  // group only, then is restored to the dead port. The in-process
  // Host below is bench scaffolding only: it enqueues the runs the
  // timed HTTP calls then drive (untimed setup), and it never drives
  // a timed step.
  const dir = freshStateDir("prod-path");
  const port = 18992;
  const serverUrl = `http://127.0.0.1:${port}`;
  const cliPath = path.join(REPO_ROOT, "apps", "agentts", "src", "cli.ts");
  const serverPath = path.join(REPO_ROOT, "apps", "agentts", "src", "worker-server.ts");
  const wf = path.join(WORKFLOWS, "bench-trivial.ts");
  const { spawn } = await import("node:child_process");
  const savedNotify = process.env.AGENTTS_WORKER_SERVER;
  const host = new Host({ stateDir: dir });
  let server: ReturnType<typeof spawn> | null = null;
  function cli(args: string[], what: string): string {
    const r = spawnSync(process.execPath, args, { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`${what} failed rc=${r.status}: ${(r.stderr ?? "").slice(0, 300)}`);
    }
    return r.stdout ?? "";
  }
  /** One tick-agent HTTP call (curl spawn via httpSync, the
   * codebase's sync client): throws on a non-200 status, so a
   * failed drive/deliver/list is a bench failure, not a timing. */
  function call(method: "GET" | "POST", p: string, body: unknown, what: string): any {
    const r = httpSync(method, `${serverUrl}${p}`, body, 10_000);
    if (r.status !== 200) {
      throw new Error(`${what} failed HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    }
    return r.body;
  }
  try {
    process.env.AGENTTS_WORKER_SERVER = serverUrl;
    server = spawn(process.execPath, [serverPath, "--state-dir", dir, "--port", String(port)], {
      stdio: "ignore",
    });
    // Wait for the server's /health (up to 5s), as mNotify does.
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error("production-path server did not come up on :18992");
      await Bun.sleep(50);
    }
    // Warm-up (discarded): the first CLI submit pays the cold
    // extract (~1500ms of tsc). Timed reps must measure the
    // per-action tax, not tsc — so warm the extract cache through
    // the CLI itself, exactly as production would. The warm-up
    // drive + deliver go through HTTP, as the timed reps do.
    {
      const warmId = "bench-prod-warmup";
      const out = cli([cliPath, "run", wf, "--input", '{"n":1000}', "--run-id", warmId, "--state-dir", dir], "prod warmup submit");
      if (!out.startsWith(`RUN ${warmId}`)) throw new Error(`prod warmup submit: unexpected output ${out.slice(0, 200)}`);
      call("GET", "/tick?timeoutMs=0", undefined, "prod warmup tick");
      const driveOut = call("POST", "/queue/run", {}, "prod warmup queue run");
      if (!driveOut.entries?.some((e: any) => e.runId === warmId && e.status === "done")) throw new Error(`prod warmup queue run: run not done: ${JSON.stringify(driveOut).slice(0, 300)}`);
      const delOut = call("POST", "/deliver-result", { runId: warmId }, "prod warmup deliver-result");
      if (delOut.runId !== warmId) throw new Error("prod warmup deliver-result: wrong runId");
    }
    const tickMs: number[] = [];
    const beatMs: number[] = [];
    for (let i = 0; i < ctx.reps; i++) {
      // --timeout-ms 0: the server resolves at once (WaitHub runs
      // the check immediately; a 0ms timer fires at once) — this
      // measures the tick invocation cost, not the 60s block.
      let t0 = performance.now();
      const out = call("GET", "/tick?timeoutMs=0", undefined, "prod tick");
      tickMs.push(performance.now() - t0);
      if (!("events" in out) && !("timedOut" in out)) throw new Error("prod tick: unexpected response");
      t0 = performance.now();
      call("POST", "/tick-beat", {}, "prod tick-beat");
      beatMs.push(performance.now() - t0);
    }
    const submitMs: number[] = [];
    for (let i = 0; i < ctx.reps; i++) {
      const runId = `bench-prod-submit-${i}`;
      const t0 = performance.now();
      const out = cli([cliPath, "run", wf, "--input", '{"n":1000}', "--run-id", runId, "--state-dir", dir], "prod submit");
      submitMs.push(performance.now() - t0);
      if (!out.startsWith(`RUN ${runId}`)) throw new Error(`prod submit rep ${i}: unexpected output ${out.slice(0, 200)}`);
      // Cleanup (untimed, in-process): drive the submitted run so
      // no queued runs accumulate into the next rep's measurements.
      await host.runQueue();
      if (host.result(runId).status !== "done") throw new Error(`prod submit rep ${i}: cleanup drive not done`);
    }
    const queueRunMs: number[] = [];
    const deliverMs: number[] = [];
    for (let i = 0; i < ctx.reps; i++) {
      const runId = `bench-prod-drive-${i}`;
      host.submit(wf, { runId, input: { n: 1000 } }); // untimed setup
      const t0 = performance.now();
      const driveOut = call("POST", "/queue/run", {}, "prod queue run");
      queueRunMs.push(performance.now() - t0);
      if (!driveOut.entries?.some((e: any) => e.runId === runId && e.status === "done")) throw new Error(`prod queue run rep ${i}: run not done: ${JSON.stringify(driveOut).slice(0, 300)}`);
      const t1 = performance.now();
      const delOut = call("POST", "/deliver-result", { runId }, "prod deliver-result");
      deliverMs.push(performance.now() - t1);
      if (delOut.runId !== runId) throw new Error(`prod deliver-result rep ${i}: wrong runId`);
    }
    const listMs: number[] = [];
    const deliveriesMs: number[] = [];
    for (let i = 0; i < ctx.reps; i++) {
      const t0 = performance.now();
      call("GET", "/queue/list", undefined, "prod queue list");
      listMs.push(performance.now() - t0);
      const t1 = performance.now();
      call("GET", "/deliveries", undefined, "prod deliveries");
      deliveriesMs.push(performance.now() - t1);
    }
    // End to end, the tick agent's sequence per unit of work (one
    // run submitted -> driven -> delivered): submit, tick, beat,
    // queue run, beat, tick, beat, deliver-result, beat,
    // deliveries, queue list. The beat before/after every action
    // and the deliveries check + light-sweep list are per
    // TICK-AGENT.md; the second tick drains the workflow-completed
    // event the drive's notify posted. The count is the fresh BUN
    // processes per unit of work — the submit is the only one left
    // (the HTTP calls are curl spawns, not Bun, and are not
    // counted); it is computed from the spawns performed, not
    // hardcoded — if the loop gains or loses a CLI call, the count
    // moves and the 1.0x threshold (count kind) fails the gate
    // loudly.
    const e2eMs: number[] = [];
    const invocationCounts: number[] = [];
    for (let i = 0; i < ctx.reps; i++) {
      const runId = `bench-prod-e2e-${i}`;
      let bunSpawns = 0;
      const t0 = performance.now();
      const sub = cli([cliPath, "run", wf, "--input", '{"n":1000}', "--run-id", runId, "--state-dir", dir], "prod e2e submit");
      bunSpawns++;
      if (!sub.startsWith(`RUN ${runId}`)) throw new Error(`prod e2e rep ${i}: submit failed`);
      call("GET", "/tick?timeoutMs=0", undefined, "prod e2e tick 1");
      call("POST", "/tick-beat", {}, "prod e2e beat 1");
      const driveOut = call("POST", "/queue/run", {}, "prod e2e queue run");
      if (!driveOut.entries?.some((e: any) => e.runId === runId && e.status === "done")) throw new Error(`prod e2e rep ${i}: run not done`);
      call("POST", "/tick-beat", {}, "prod e2e beat 2");
      call("GET", "/tick?timeoutMs=0", undefined, "prod e2e tick 2");
      call("POST", "/tick-beat", {}, "prod e2e beat 3");
      const delOut = call("POST", "/deliver-result", { runId }, "prod e2e deliver-result");
      if (delOut.runId !== runId) throw new Error(`prod e2e rep ${i}: wrong delivery runId`);
      call("POST", "/tick-beat", {}, "prod e2e beat 4");
      call("GET", "/deliveries", undefined, "prod e2e deliveries");
      call("GET", "/queue/list", undefined, "prod e2e queue list");
      e2eMs.push(performance.now() - t0);
      invocationCounts.push(bunSpawns);
    }
    return [
      stats("prod_tick_ms", "ms", tickMs, "curl GET /tick?timeoutMs=0 against the throwaway server (curl spawn + fetch + immediate server response; the 60s block is not waited)"),
      stats("prod_tick_beat_ms", "ms", beatMs, "curl POST /tick-beat against the throwaway server (curl spawn + POST)"),
      stats("prod_submit_ms", "ms", submitMs, "bun src/cli.ts run bench-trivial.ts --input ... --state-dir <scratch>, warm extract cache (Bun startup + Host construct + submit) — submit stays CLI (BRA-116)"),
      stats("prod_queue_run_ms", "ms", queueRunMs, "curl POST /queue/run against the throwaway server driving one queued trivial run, warm extract cache — the per-drive-call cost over HTTP"),
      stats("prod_deliver_result_ms", "ms", deliverMs, "curl POST /deliver-result <runId> against the throwaway server (curl spawn + in-server Host construct + delivery record write)"),
      stats("prod_queue_list_ms", "ms", listMs, "curl GET /queue/list against the throwaway server (the light sweep after a tick timeout)"),
      stats("prod_deliveries_ms", "ms", deliveriesMs, "curl GET /deliveries against the throwaway server (the check after a drive)"),
      stats("prod_e2e_ms", "ms", e2eMs, "submit (CLI) → tick → beat → queue run → beat → tick → beat → deliver-result → beat → deliveries → queue list, all driver actions over HTTP, warm extract cache"),
      stats("prod_invocations_per_run", "invocations", invocationCounts, "fresh Bun processes per unit of work (one run submitted → driven → delivered) through the production path; the submit is the only Bun spawn left (BRA-116 moved the driver actions to HTTP curl calls, which are not Bun processes); deterministic count — any change is a real change to the tick-agent loop"),
    ];
  } finally {
    if (server) server.kill("SIGTERM");
    if (savedNotify === undefined) delete process.env.AGENTTS_WORKER_SERVER;
    else process.env.AGENTTS_WORKER_SERVER = savedNotify;
    rmDir(dir);
  }
}

// ---------------------------------------------------------------- main
const ALL: Array<{ id: string; run: (ctx: Ctx) => Promise<MetricResult | MetricResult[]> }> = [
  { id: "slice_spawn_ms", run: mSliceSpawn },
  { id: "run_e2e", run: mRunE2E },
  { id: "snapshot", run: async (ctx) => { const out: MetricResult[] = []; for (const kb of [1, 100, 500, 1000, 5000]) out.push(...(await mSnapshot(ctx, kb))); return out; } },
  { id: "trap_steps", run: mTrapSteps },
  { id: "fork", run: mFork },
  { id: "enqueue", run: mEnqueue },
  { id: "journal", run: mJournal },
  { id: "host_construct", run: mHostConstruct },
  { id: "result", run: mResult },
  { id: "extract_bundle", run: mExtractBundle },
  { id: "fsync_blob", run: mFsyncBlob },
  { id: "notify", run: mNotify },
  { id: "production_path", run: mProductionPath },
];

function parseArgs(argv: string[]): { reps: number; out?: string; writeBaselines: boolean; only: Set<string> | null } {
  let reps = 5;
  let out: string | undefined;
  let writeBaselines = false;
  let only: Set<string> | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reps") reps = Number(argv[++i]);
    else if (a === "--out") out = argv[++i];
    else if (a === "--write-baselines") writeBaselines = true;
    else if (a === "--metrics") only = new Set(argv[++i].split(",").map((s) => s.trim()));
    else if (a === "--list") {
      console.log(ALL.map((m) => m.id).join("\n"));
      process.exit(0);
    } else if (a === "--help" || a === "-h") {
      console.log("usage: bun bench/run.ts [--reps N] [--out FILE] [--write-baselines] [--metrics a,b,c] [--list]");
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return { reps, out, writeBaselines, only };
}

const args = parseArgs(process.argv.slice(2));
const ctx: Ctx = { reps: args.reps };
const results: MetricResult[] = [];
const started = Date.now();
for (const m of ALL) {
  if (args.only && !args.only.has(m.id)) continue;
  const t0 = performance.now();
  const r = await m.run(ctx);
  for (const one of Array.isArray(r) ? r : [r]) {
    results.push(one);
    console.log(
      `${one.id.padEnd(32)} median ${round(one.median)} ${one.unit}  p95 ${round(one.p95)}  mean ${round(one.mean)}  n=${one.n}`,
    );
  }
  console.log(`  [${m.id} took ${round(performance.now() - t0)}ms]`);
}

const out = {
  generated: new Date().toISOString(),
  reps: args.reps,
  durationMs: Date.now() - started,
  codeFingerprint: codeFingerprint(),
  results: results.map((r) => ({ ...r, median: round(r.median), p95: round(r.p95), mean: round(r.mean), min: round(r.min), max: round(r.max) })),
};
const outPath =
  args.out ??
  path.join(BENCH_DIR, "results", `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${outPath} (${results.length} metrics, ${Math.round((Date.now() - started) / 1000)}s total)`);

if (args.writeBaselines) {
  const { writeBaselinesFile } = await import("./baselines.ts");
  writeBaselinesFile(results, out.codeFingerprint);
}
