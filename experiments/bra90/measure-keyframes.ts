// BRA-90 keyframe + heap-shape measurement harness.
//
// Extends the BRA-90 investigation (see docs/audits/bra90-incremental-
// snapshots.md and experiments/bra90/measure.ts — that harness is NOT
// modified; this is a second harness for the follow-up questions):
//   1. Keyframes: resume/load time vs chain length (10/50/100/250/500
//      suspensions), pure-delta vs keyframe intervals 10/25/50, plus
//      the disk cost of keyframes (bytes written) — the tradeoff table
//      the interval recommendation rests on.
//   2. Stale-base bound: delta size vs suspensions-since-keyframe
//      (sawtooth) vs pure-delta growth toward full size.
//   3. Heap shape: equal total bytes at different shapes (1x500KB
//      string vs 12,000x~50B objects vs mixed), few-change vs
//      many-change, measuring delta-WRITE time (engine [bra90-time]
//      lines, not wall clock) and delta size. The engine has no dirty
//      tracking (quickjs-snapshot.c snap_write_body re-serializes
//      every cell and memcmps it against the base body), so write work
//      is O(heap cells), not O(changed bytes).
//   4. Pinning: grow-then-drop workload (shape-shrink) — the attached
//      base pins dead cells; a keyframe after the drop lets them go.
//      Measured via stored bytes + load-process peak RSS.
//
// Drives the C host binary DIRECTLY (no host.ts, no queue, no tick
// agent). Trap answers are canned and deterministic; full-mode and
// delta-mode runs hold byte-identical heaps and must produce identical
// stdout + <snap>.result.json (asserted at 50 suspensions, plus a
// full 500-suspension check on accumulate).
//
// Usage:
//   bun experiments/bra90/measure-keyframes.ts [--out-dir DIR]
// Everything lands in a fresh scratch dir (default mktemp under /tmp);
// nothing touches ~/workspace/agentts-state or the production tick
// agent. Results: experiments/bra90/results-keyframes-<date>.json.
//
// Exit code: 0 when every check passes; 1 otherwise.
import { spawnSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const REPO = path.resolve(import.meta.dir, "../..");
const EXP = path.resolve(import.meta.dir);
const DQUICKTS = process.env.DQUICKTS || path.join(process.env.HOME!, "workspace/dquickts-build-minimal");

const args = process.argv.slice(2);
function argVal(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const OUT_DIR = argVal("--out-dir") || fs.mkdtempSync(path.join("/tmp", "bra90-keyframes-"));
fs.mkdirSync(OUT_DIR, { recursive: true });
console.log(`BRA-90 keyframes measure: out dir ${OUT_DIR}`);

let failures: string[] = [];
function check(cond: boolean, msg: string) {
  if (!cond) { failures.push(msg); console.error(`FAIL: ${msg}`); }
  else console.log(`ok: ${msg}`);
}
function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function sha256(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// ------------------------------------------------------------ deterministic text
const SENTENCES = [
  "The transformer applies self-attention across the full context window, letting each token gather evidence from every other token in a single layer.",
  "Depth recurrence reuses the same block weights across iterations, trading sequential compute for parameter efficiency at inference time.",
  "A looped architecture deepens the representation of the current position without advancing the position index or sampling a new token.",
  "The judge scored the draft for factual grounding, penalising claims that could not be traced to a cited source in the paper.",
  "Spectral radius regularisation keeps the recurrent transition contractive, which stabilises training over many unrolled iterations.",
  "Quantisation to four bits cuts memory bandwidth by roughly a factor of four, but the error compounds across the looped iterations.",
  "The revision expands the methods section with the missing ablation and tightens the claim about sample efficiency on the long-context split.",
  "Context compression stores a gist embedding per segment, letting the decoder attend to a compact summary instead of the raw tokens.",
  "The baseline reproduces the published number within half a point, so the comparison rests on the same training recipe and data order.",
  "Editorial notes: the summary buries the lead, the second paragraph repeats the abstract, and the limitations section needs one honest sentence.",
  "The aggregate counts two approvals and one rejection; the rejected draft failed on grounding, not on style, and goes back for another pass.",
  "A sparse router scores every sub-vocabulary before dropping any, so the head forms a distribution over the full vocabulary first.",
];
function seededText(seed: number, targetChars: number): string {
  let state = (seed * 2654435761 + 12345) >>> 0;
  const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
  let out = "";
  while (out.length < targetChars) {
    out += SENTENCES[Math.floor(next() * SENTENCES.length)] + " ";
  }
  return out.slice(0, targetChars);
}

// ------------------------------------------------------------ build
function build(src: string, out: string, label: string) {
  console.log(`building ${label} -> ${out}`);
  const r = spawnSync("cc", ["-g", "-O2", "-Wall", `-I${EXP}`, `-I${DQUICKTS}`, src,
    `${DQUICKTS}/libquickjs.a`, "-lm", "-lpthread", "-ldl", "-o", out],
    { encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stderr); throw new Error(`${label} build failed`); }
  if (r.stderr.trim()) console.log(`  [${label} warnings] ${r.stderr.trim().split("\n").slice(0, 3).join(" | ")}`);
}
const STOCK_BIN = path.join(OUT_DIR, "durablets-stock");
const DELTA_BIN = path.join(OUT_DIR, "durablets-delta");
build(path.join(REPO, "packages/durablets/src/durablets.c"), STOCK_BIN, "stock");
build(path.join(EXP, "durablets-delta.c"), DELTA_BIN, "delta-prototype");

// ------------------------------------------------------------ host driving
interface SuspRow {
  ordinal: number; type: string; size: number; kind: string;
  trigger: string | null; ratio: number | null; baseSize: number | null;
  sliceMs: number; readMs: number | null; writeMs: number | null;
}
interface Milestone {
  chainLength: number; loadReadMsMedian: number; loadReadMsMin: number; loadReadMsMax: number;
  loadWallMsMedian: number; sliceMs: number; deltaSize: number; baseSize: number | null;
  rssKbMedian?: number;
}
interface RunResult {
  workload: string; mode: string; interval: number | null;
  rows: SuspRow[]; milestones: Milestone[]; finalRc: number;
  fingerprint: string; resultJson: string | null;
  totalWritten: number; storedAtEnd: number;
  keyframeCount: number; keyframeBytes: number; deltaBytes: number;
  lastTrap: any | null; lastAnswer: any | null;
}
function lastTrap(stderrText: string): any | null {
  let last: any = null;
  for (const line of stderrText.split("\n")) {
    const m = line.match(/^\[durablets\] (\{.*\})\s*$/);
    if (!m) continue;
    try { const ev = JSON.parse(m[1]); if (ev.event === "trap") last = ev; } catch { /* ignore */ }
  }
  return last;
}
/* Engine [bra90-time] lines: "[bra90-time] read kind=delta base=.. delta=.. ms=0.624"
 * or "[bra90-time] write kind=delta bytes=.. ms=1.234". */
function bra90Times(stderrText: string): { readMs: number | null; writeMs: number | null } {
  let readMs: number | null = null, writeMs: number | null = null;
  for (const line of stderrText.split("\n")) {
    let m = line.match(/^\[bra90-time\] read .* ms=([\d.]+)\s*$/);
    if (m) readMs = parseFloat(m[1]);
    m = line.match(/^\[bra90-time\] write .* ms=([\d.]+)\s*$/);
    if (m) writeMs = parseFloat(m[1]);
  }
  return { readMs, writeMs };
}
function dispatchAnswer(trap: any): any {
  const arg = trap.arg ?? {};
  switch (trap.type) {
    case "sleep": return { sleptMs: arg.ms ?? 0 };
    case "job":
      switch (arg.op) {
        case "fetch": return { title: `Paper ${arg.paper}: looped depth`, body: seededText(100 + arg.paper, 3072) };
        case "refine": return { notes: seededText(200 + arg.paper, 1024) };
        case "note": return { notes: seededText(600 + arg.i, 512) };
        case "judge": return { score: 0.5 + (arg.judge % 3) * 0.2, notes: seededText(300 + arg.round * 10 + arg.judge, 2560) };
        case "fix": return { revised: seededText(400 + arg.round, 4096) };
        case "rewrite": return { text: seededText(500 + arg.i, 20480) };
        case "aggregate": return { approved: 2, failed: 1, summary: "2 approved, 1 failed" };
        default: return { score: 0.5, label: "default" };
      }
    default: return { score: 0.5, label: "default" };
  }
}
function bundleWorkflow(workflowSrc: string, dir: string, name: string): string {
  const driverPath = path.join(dir, `${name}.driver.ts`);
  const bundlePath = path.join(dir, `${name}.bundle.js`);
  fs.writeFileSync(driverPath,
    `import entry from ${JSON.stringify(workflowSrc)};\n` +
    `declare function __agentts_begin(): void;\n__agentts_begin();\nentry();\n`);
  const r = spawnSync(process.execPath, ["build", driverPath, "--outfile", bundlePath, "--target", "bun"], { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(bundlePath)) throw new Error(`bun build failed for ${name}: ${r.stderr}`);
  const text = fs.readFileSync(bundlePath, "utf8");
  if (/^\s*export\s/m.test(text) || /^\s*import\s/m.test(text)) throw new Error(`bundle ${name} still has export/import`);
  return bundlePath;
}
function fsize(p: string): number | null { try { return fs.statSync(p).size; } catch { return null; } }
function readMeta(snap: string): any | null {
  try { return JSON.parse(fs.readFileSync(snap + ".meta", "utf8")); } catch { return null; }
}
function subst(srcPath: string, reps: Array<[string, string]>, outPath: string): string {
  let s = fs.readFileSync(srcPath, "utf8");
  for (const [a, b] of reps) s = s.replaceAll(a, b);
  fs.writeFileSync(outPath, s);
  return outPath;
}

// ------------------------------------------------------------ load probe + RSS
function probeLoad(bin: string, snap: string, env: Record<string, string>, reps: number): { readMs: number[]; wallMs: number[] } {
  const readMs: number[] = [], wallMs: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    const r = spawnSync(bin, ["load", snap], { env, encoding: "utf8" });
    wallMs.push(performance.now() - t0);
    if (r.status !== 0) throw new Error(`load probe failed rc=${r.status}: ${(r.stderr ?? "").slice(-300)}`);
    const t = bra90Times(r.stderr ?? "");
    if (t.readMs !== null) readMs.push(t.readMs);
  }
  return { readMs, wallMs };
}

/* Peak RSS (VmHWM, KiB) of a load process that sleeps after reading,
 * sampled from /proc/<pid>/status while it lives. The load verb sleeps
 * DURABLETS_LOAD_SLEEP_MS after a successful read so sampling is not a
 * race. Returns the max VmHWM seen (or null if /proc vanished). */
async function sampleLoadRss(bin: string, snap: string, env: Record<string, string>, sleepMs: number): Promise<number | null> {
  const child = spawn(bin, ["load", snap], { env: { ...env, DURABLETS_LOAD_SLEEP_MS: String(sleepMs) } });
  let peak: number | null = null;
  const pid = child.pid;
  if (!pid) { child.kill(); return null; }
  const done = new Promise<void>((resolve) => { child.on("exit", () => resolve()); });
  while (true) {
    const exited = await Promise.race([done.then(() => true), Bun.sleep(10).then(() => false)]);
    try {
      const st = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const m = st.match(/^VmHWM:\s*(\d+)\s*kB/m);
      if (m) peak = peak === null ? parseInt(m[1], 10) : Math.max(peak, parseInt(m[1], 10));
    } catch { /* process gone between checks */ }
    if (exited) break;
  }
  await done;
  return peak;
}

interface DriveOpts {
  maxSusp: number;
  interval: number | null;      // null = pure delta (no keyframes); number = keyframe interval
  milestones?: number[];        // chain lengths at which to load-probe
  probeReps?: number;
  rssAtFinal?: boolean;         // sample load RSS at the final milestone
  keepKeyframesDir?: string;    // if set, copy each keyframe .base aside here
  asideOrdinal?: number | null; // if set, copy aside the checkpoint triple at this chain length
  asideDir?: string;
}

// ------------------------------------------------------------ drive one run
function driveRun(bin: string, bundle: string, dir: string, runId: string,
                  mode: "full" | "delta", opts: DriveOpts): RunResult {
  const snap = path.join(dir, "snap");
  const rows: SuspRow[] = [];
  const milestones: Milestone[] = [];
  let stdoutAll = "";
  const env: Record<string, string> = { ...process.env, AGENTTS_RUN_ID: runId } as Record<string, string>;
  if (mode === "delta") {
    env.DURABLETS_DELTA = "1";
    if (opts.interval !== null && opts.interval !== undefined) env.DURABLETS_KEYFRAME_INTERVAL = String(opts.interval);
  }
  let keyframeCount = 0, keyframeBytes = 0, deltaBytes = 0;
  let lastTrapEv: any | null = null, lastAns: any | null = null;

  const recordRow = (r: any, sliceMs: number, trap: any) => {
    const meta = mode === "delta" ? readMeta(snap) : null;
    const size = fsize(snap) ?? -1;
    const kind = mode === "delta" ? (meta?.kind ?? "?") : "full";
    const t = bra90Times(r.stderr ?? "");
    if (mode === "delta" && kind === "keyframe") { keyframeCount++; keyframeBytes += Math.max(0, size); }
    if (mode === "delta" && kind === "delta") deltaBytes += Math.max(0, size);
    rows.push({
      ordinal: trap.ordinal ?? rows.length, type: `${trap.type}:${trap.arg?.op ?? trap.arg?.ms ?? ""}`,
      size, kind, trigger: meta?.trigger ?? null, ratio: meta?.ratio ?? null,
      baseSize: meta?.baseSize ?? null, sliceMs, readMs: t.readMs, writeMs: t.writeMs,
    });
    // keyframe aside-copy: keep each keyframe file for the chain record.
    if (opts.keepKeyframesDir && kind === "keyframe") {
      fs.mkdirSync(opts.keepKeyframesDir, { recursive: true });
      const dst = path.join(opts.keepKeyframesDir, `kf-${rows.length}.base`);
      fs.copyFileSync(snap + ".base", dst);
      fs.writeFileSync(dst + ".sha256", sha256(dst));
    }
    // aside-copy for the pruning test.
    if (opts.asideOrdinal !== null && opts.asideOrdinal !== undefined && rows.length === opts.asideOrdinal && opts.asideDir) {
      fs.mkdirSync(opts.asideDir, { recursive: true });
      for (const suf of ["", ".base", ".meta"]) fs.copyFileSync(snap + suf, path.join(opts.asideDir, "snap" + suf));
      fs.writeFileSync(path.join(opts.asideDir, "answer.json"), JSON.stringify({ trap: lastTrapEv, answer: lastAns }));
    }
    // Milestone load probe (before resuming this checkpoint). Delta
    // mode only: the stock binary has no `load` verb.
    if (mode === "delta" && opts.milestones && opts.milestones.includes(rows.length)) {
      const probe = probeLoad(bin, snap, env, opts.probeReps ?? 5);
      const ms: Milestone = {
        chainLength: rows.length,
        loadReadMsMedian: median(probe.readMs), loadReadMsMin: Math.min(...probe.readMs), loadReadMsMax: Math.max(...probe.readMs),
        loadWallMsMedian: median(probe.wallMs), sliceMs: rows[rows.length - 1].sliceMs,
        deltaSize: size, baseSize: meta?.baseSize ?? null,
      };
      milestones.push(ms);
      console.log(`    milestone chain=${rows.length}: loadReadMs median=${ms.loadReadMsMedian.toFixed(3)} (min ${ms.loadReadMsMin.toFixed(3)} max ${ms.loadReadMsMax.toFixed(3)}) wallMs median=${ms.loadWallMsMedian.toFixed(1)} delta=${size} base=${ms.baseSize}`);
    }
  };

  let rc = -1;
  let t0 = performance.now();
  let r = spawnSync(bin, ["run", bundle, snap], { env, encoding: "utf8" });
  let sliceMs = performance.now() - t0;
  rc = r.status ?? 1;
  stdoutAll += r.stdout ?? "";
  let guard = 0;
  while ((rc === 2 || rc === 3) && guard++ < opts.maxSusp + 5) {
    const trap = lastTrap(r.stderr ?? "");
    check(trap !== null, `${runId}/${mode}: trap event present at suspension ${rows.length}`);
    if (!trap) break;
    lastTrapEv = trap;
    // Dispatch the answer BEFORE recording the row: the aside-copy for
    // the pruning test must save the answer for THIS trap, and the
    // milestone probe must run before the resume below.
    const ans = rc === 3 ? null : dispatchAnswer(trap);
    lastAns = ans;
    recordRow(r, sliceMs, trap);
    if (rc === 3) { console.error(`  ${runId}/${mode}: suspended at combinator (rc 3) — drive loop stops here`); break; }
    if (rows.length > opts.maxSusp) break; // unexpected extra suspensions; the post-run count check fails loudly
    t0 = performance.now();
    r = spawnSync(bin, ["resume", snap, JSON.stringify(ans)], { env, encoding: "utf8" });
    sliceMs = performance.now() - t0;
    rc = r.status ?? 1;
    stdoutAll += r.stdout ?? "";
  }
  const resultJson = fs.existsSync(snap + ".result.json") ? fs.readFileSync(snap + ".result.json", "utf8") : null;
  const totalWritten = rows.reduce((a, x) => a + Math.max(0, x.size), 0);
  const lastRow = rows[rows.length - 1];
  const storedAtEnd = mode === "delta"
    ? (lastRow?.baseSize ?? 0) + Math.max(0, lastRow?.size ?? 0)
    : Math.max(0, lastRow?.size ?? 0);
  return {
    workload: runId, mode, interval: mode === "delta" ? (opts.interval ?? null) : null,
    rows, milestones, finalRc: rc, fingerprint: stdoutAll, resultJson,
    totalWritten, storedAtEnd, keyframeCount, keyframeBytes, deltaBytes,
    lastTrap: lastTrapEv, lastAnswer: lastAns,
  };
}

// ------------------------------------------------------------ long chains
const CHAIN_MILESTONES = [10, 50, 100, 250, 500];
const allResults: RunResult[] = [];

interface ChainWorkload { id: string; prep50: string; prep500: string; }
function prepChain(id: string): ChainWorkload {
  const prepDir = path.join(OUT_DIR, "prep", id);
  fs.mkdirSync(prepDir, { recursive: true });
  const W = (f: string) => path.join(EXP, "workflows", f);
  switch (id) {
    case "accumulate":
      return { id,
        prep50: subst(W("accumulate.ts"), [["__PAPERS__", "25"]], path.join(prepDir, "acc-50.ts")),
        prep500: subst(W("accumulate.ts"), [["__PAPERS__", "250"]], path.join(prepDir, "acc-500.ts")) };
    case "slowgrow":
      return { id,
        prep50: subst(W("slowgrow.ts"), [["__SUSPENSIONS__", "50"]], path.join(prepDir, "slow-50.ts")),
        prep500: subst(W("slowgrow.ts"), [["__SUSPENSIONS__", "500"]], path.join(prepDir, "slow-500.ts")) };
    case "stable":
      return { id,
        prep50: subst(W("stable.ts"), [["__SUSPENSIONS__", "50"]], path.join(prepDir, "stable-50.ts")),
        prep500: subst(W("stable.ts"), [["__SUSPENSIONS__", "500"]], path.join(prepDir, "stable-500.ts")) };
    case "churn-long":
      return { id,
        prep50: subst(W("churn-long.ts"), [["__SUSPENSIONS__", "50"]], path.join(prepDir, "churn-50.ts")),
        prep500: subst(W("churn-long.ts"), [["__SUSPENSIONS__", "500"]], path.join(prepDir, "churn-500.ts")) };
    default: throw new Error(`unknown chain workload ${id}`);
  }
}

const chainIds = ["accumulate", "slowgrow", "stable", "churn-long"];
for (const id of chainIds) {
  const w = prepChain(id);
  // ---- equivalence at 50 suspensions: full vs pure vs K10 vs K25 vs K50
  console.log(`\n=== chain ${id}: equivalence at 50 suspensions ===`);
  const eq: Record<string, RunResult> = {};
  const eqModes: Array<{ mode: "full" | "delta"; interval: number | null; tag: string }> = [
    { mode: "full", interval: null, tag: "full" },
    { mode: "delta", interval: null, tag: "pure" },
    { mode: "delta", interval: 10, tag: "k10" },
    { mode: "delta", interval: 25, tag: "k25" },
    { mode: "delta", interval: 50, tag: "k50" },
  ];
  for (const m of eqModes) {
    const dir = path.join(OUT_DIR, `${id}-eq50-${m.tag}`);
    fs.mkdirSync(dir, { recursive: true });
    const bundle = bundleWorkflow(w.prep50, dir, `${id}-eq50-${m.tag}`);
    const res = driveRun(m.mode === "full" ? STOCK_BIN : DELTA_BIN, bundle, dir, `${id}-eq50-${m.tag}`, m.mode,
      { maxSusp: 50, interval: m.interval });
    eq[m.tag] = res;
    allResults.push(res);
    console.log(`  ${m.tag}: rc=${res.finalRc} susp=${res.rows.length} totalWritten=${res.totalWritten} stored=${res.storedAtEnd} keyframes=${res.keyframeCount}`);
    check(res.finalRc === 0, `${id}/eq50/${m.tag}: run completed (rc 0)`);
  }
  for (const tag of ["pure", "k10", "k25", "k50"]) {
    check(eq[tag].fingerprint === eq.full.fingerprint, `${id}/eq50/${tag}: stdout fingerprint identical to full`);
    check(eq[tag].resultJson === eq.full.resultJson, `${id}/eq50/${tag}: result.json identical to full`);
  }
  // ---- long chains to 500 (delta modes only; full-500 for accumulate)
  console.log(`\n=== chain ${id}: long runs to 500 suspensions ===`);
  const longModes: Array<{ interval: number | null; tag: string }> = [
    { interval: null, tag: "pure" },
    { interval: 10, tag: "k10" },
    { interval: 25, tag: "k25" },
    { interval: 50, tag: "k50" },
  ];
  for (const m of longModes) {
    const dir = path.join(OUT_DIR, `${id}-500-${m.tag}`);
    fs.mkdirSync(dir, { recursive: true });
    const bundle = bundleWorkflow(w.prep500, dir, `${id}-500-${m.tag}`);
    const isAccK25 = id === "accumulate" && m.tag === "k25";
    const res = driveRun(DELTA_BIN, bundle, dir, `${id}-500-${m.tag}`, "delta",
      { maxSusp: 500, interval: m.interval, milestones: CHAIN_MILESTONES, probeReps: 5,
        keepKeyframesDir: isAccK25 ? path.join(dir, "keyframes") : undefined,
        asideOrdinal: isAccK25 ? 50 : null,
        asideDir: isAccK25 ? path.join(dir, "prune-old") : undefined });
    allResults.push(res);
    console.log(`  ${m.tag}: rc=${res.finalRc} susp=${res.rows.length} totalWritten=${res.totalWritten} stored=${res.storedAtEnd} keyframes=${res.keyframeCount} kfBytes=${res.keyframeBytes}`);
    check(res.finalRc === 0, `${id}/500/${m.tag}: run completed (rc 0)`);
    check(res.rows.length === 500, `${id}/500/${m.tag}: 500 suspensions driven`);
    // Sawtooth check (growing workloads only: accumulate/slowgrow): the
    // first delta after a keyframe is smaller than the delta just
    // before that keyframe (the reset is real). Stable/churn deltas
    // are flat by construction, so they assert flatness instead.
    if (id === "accumulate" || id === "slowgrow") {
      for (let i = 0; i < res.rows.length; i++) {
        if (res.rows[i].kind === "keyframe" && i >= 1 && i + 1 < res.rows.length) {
          check(res.rows[i + 1].size < res.rows[i - 1].size,
            `${id}/500/${m.tag}: delta after keyframe @${i} (${res.rows[i + 1].size}) < delta before (${res.rows[i - 1].size})`);
        }
      }
    } else {
      const deltas = res.rows.filter((r) => r.kind === "delta").map((r) => r.size);
      const med = median(deltas);
      check(deltas.every((d) => Math.abs(d - med) <= 0.1 * med),
        `${id}/500/${m.tag}: deltas flat (median ${med}, all within 10%)`);
    }
  }
  if (id === "accumulate") {
    // Full-mode 500 for the direct equivalence check at full length.
    const dir = path.join(OUT_DIR, `${id}-500-full`);
    fs.mkdirSync(dir, { recursive: true });
    const bundle = bundleWorkflow(w.prep500, dir, `${id}-500-full`);
    const res = driveRun(STOCK_BIN, bundle, dir, `${id}-500-full`, "full", { maxSusp: 500 });
    allResults.push(res);
    console.log(`  full: rc=${res.finalRc} susp=${res.rows.length} totalWritten=${res.totalWritten} stored=${res.storedAtEnd}`);
    check(res.finalRc === 0, `${id}/500/full: run completed (rc 0)`);
    const pure = allResults.find((x) => x.workload === `${id}-500-pure`)!;
    check(pure.fingerprint === res.fingerprint, `${id}/500/pure: stdout fingerprint identical to full at 500`);
    check(pure.resultJson === res.resultJson, `${id}/500/pure: result.json identical to full at 500`);
  }
}

// Stale-base bound assertions (from the long runs just driven).
{
  const accPure = allResults.find((x) => x.workload === "accumulate-500-pure")!;
  const accK25 = allResults.find((x) => x.workload === "accumulate-500-k25")!;
  const accK50 = allResults.find((x) => x.workload === "accumulate-500-k50")!;
  const lastPure = accPure.rows[accPure.rows.length - 1];
  check((lastPure.ratio ?? 0) > 0.9, `accumulate/pure: final delta ratio ${lastPure.ratio} > 0.9 (stale base, grows toward full)`);
  const lastK25 = accK25.rows[accK25.rows.length - 1];
  check((lastK25.ratio ?? 1) < 0.5, `accumulate/k25: final delta ratio ${lastK25.ratio} < 0.5 (keyframe bounds it)`);
  check(accK50.rows.some((r) => r.trigger === "ratio"), "accumulate/k50: at least one ratio-triggered keyframe (75% rule fires)");
  check(accK25.rows.some((r) => r.trigger === "interval"), "accumulate/k25: at least one interval-triggered keyframe");
  const stablePure = allResults.find((x) => x.workload === "stable-500-pure")!;
  const stableK25 = allResults.find((x) => x.workload === "stable-500-k25")!;
  const stableLoads = stablePure.milestones.map((m) => m.loadReadMsMedian);
  const stableLoadsK = stableK25.milestones.map((m) => m.loadReadMsMedian);
  console.log(`  stable load-read medians pure: ${stableLoads.map((x) => x.toFixed(3)).join(", ")} ms`);
  console.log(`  stable load-read medians k25:  ${stableLoadsK.map((x) => x.toFixed(3)).join(", ")} ms`);
}

// ------------------------------------------------------------ heap shapes
// Equal total bytes (ground truth = full snapshot size at suspension 1),
// different shapes. Calibrated 2026-11-17: 1x500KB string = 514,348 B;
// 12,000 objects = ~518,651 B; 6,000 objects + 250KB string = ~516,651 B;
// 1x2MB string = 2,014,346 B; 45,000 objects = ~1,999,076 B.
interface ShapeResult {
  id: string; fullSizeSusp1: number; deltaFullSizeSusp1: number;
  medianDeltaWriteMs: number; medianDeltaReadMs: number; medianDeltaSliceMs: number;
  medianFullWriteMs: number; medianFullReadMs: number;
  medianDeltaSize: number; medianFullSize: number;
  medianPostKfDelta: number | null; postKfDeltaN: number;
  n: number; fingerprintMatch: boolean;
}
const shapeResults: ShapeResult[] = [];
interface ShapeSpec { id: string; srcFile: string; reps: Array<[string, string]>; }
const shapeSpecs: ShapeSpec[] = [
  { id: "shape-string-500k", srcFile: "shape-string.ts", reps: [["__BYTES__", "500000"], ["__SUSPENSIONS__", "20"]] },
  { id: "shape-objects-500k-few", srcFile: "shape-objects.ts", reps: [["__COUNT__", "12000"], ["__CHANGES__", "1"], ["__SUSPENSIONS__", "20"]] },
  { id: "shape-objects-500k-many", srcFile: "shape-objects.ts", reps: [["__COUNT__", "12000"], ["__CHANGES__", "6000"], ["__SUSPENSIONS__", "20"]] },
  { id: "shape-mixed-500k", srcFile: "shape-mixed.ts", reps: [["__OBJ_COUNT__", "6000"], ["__SUSPENSIONS__", "20"]] },
  { id: "shape-string-2m", srcFile: "shape-string.ts", reps: [["__BYTES__", "2000000"], ["__SUSPENSIONS__", "20"]] },
  { id: "shape-objects-2m-few", srcFile: "shape-objects.ts", reps: [["__COUNT__", "45000"], ["__CHANGES__", "1"], ["__SUSPENSIONS__", "20"]] },
  { id: "shape-rebuild", srcFile: "shape-rebuild.ts", reps: [["__SUSPENSIONS__", "20"]] },
  { id: "shape-append", srcFile: "shape-append.ts", reps: [["__SUSPENSIONS__", "20"]] },
];
for (const s of shapeSpecs) {
  console.log(`\n=== shape ${s.id} ===`);
  const prepDir = path.join(OUT_DIR, "prep", s.id);
  fs.mkdirSync(prepDir, { recursive: true });
  const src = subst(path.join(EXP, "workflows", s.srcFile), s.reps, path.join(prepDir, `${s.id}.ts`));
  const runs: Record<string, RunResult> = {};
  // Full (stock binary, no engine timing) + pure delta + k1: interval 1
  // writes a full BASE snapshot at every suspension, WITH engine
  // [bra90-time] lines — the full-write/full-read baseline the stock
  // binary cannot provide. + k10: the post-keyframe delta floor (the
  // delta right after a keyframe — the rebuild-vs-append pair lives
  // here). All four must agree on stdout + result.
  const shapeModes: Array<{ mode: "full" | "delta"; interval: number | null; tag: string }> = [
    { mode: "full", interval: null, tag: "full" },
    { mode: "delta", interval: null, tag: "pure" },
    { mode: "delta", interval: 1, tag: "k1" },
    { mode: "delta", interval: 10, tag: "k10" },
  ];
  for (const m of shapeModes) {
    const dir = path.join(OUT_DIR, `${s.id}-${m.tag}`);
    fs.mkdirSync(dir, { recursive: true });
    const bundle = bundleWorkflow(src, dir, s.id);
    const res = driveRun(m.mode === "full" ? STOCK_BIN : DELTA_BIN, bundle, dir, `${s.id}-${m.tag}`, m.mode,
      { maxSusp: 20, interval: m.interval });
    runs[m.tag] = res;
    allResults.push(res);
    console.log(`  ${m.tag}: rc=${res.finalRc} susp=${res.rows.length} totalWritten=${res.totalWritten}`);
    check(res.finalRc === 0, `${s.id}/${m.tag}: run completed (rc 0)`);
  }
  const fpMatch = runs.full.fingerprint === runs.pure.fingerprint && runs.full.resultJson === runs.pure.resultJson
    && runs.k1.fingerprint === runs.full.fingerprint && runs.k1.resultJson === runs.full.resultJson
    && runs.k10.fingerprint === runs.full.fingerprint && runs.k10.resultJson === runs.full.resultJson;
  check(fpMatch, `${s.id}: stdout + result.json identical full vs pure vs k1 vs k10`);
  // Delta rows are rows 1.. (row 0 is the base write). Full rows are all full writes.
  const dRows = runs.pure.rows.slice(1);
  const dWrite = dRows.map((r) => r.writeMs ?? NaN).filter((x) => !isNaN(x));
  const dRead = dRows.map((r) => r.readMs ?? NaN).filter((x) => !isNaN(x));
  const dSlice = dRows.map((r) => r.sliceMs);
  const kRows = runs.k1.rows.slice(1);
  const fWrite = kRows.map((r) => r.writeMs ?? NaN).filter((x) => !isNaN(x));
  const fRead = kRows.map((r) => r.readMs ?? NaN).filter((x) => !isNaN(x));
  // Post-keyframe deltas in the k10 run: rows after the first keyframe
  // (ordinal 10), kind delta — the floor a keyframe actually achieves.
  const k10Rows = runs.k10.rows;
  const postKf = k10Rows.filter((r) => r.ordinal > 10 && r.kind === "delta").map((r) => r.size);
  shapeResults.push({
    id: s.id,
    fullSizeSusp1: runs.full.rows[0].size,
    deltaFullSizeSusp1: runs.pure.rows[0].size,
    medianDeltaWriteMs: median(dWrite), medianDeltaReadMs: median(dRead), medianDeltaSliceMs: median(dSlice),
    medianFullWriteMs: median(fWrite), medianFullReadMs: median(fRead),
    medianDeltaSize: median(dRows.map((r) => r.size)),
    medianFullSize: median(runs.full.rows.slice(1).map((r) => r.size)),
    medianPostKfDelta: postKf.length ? median(postKf) : null, postKfDeltaN: postKf.length,
    n: dRows.length, fingerprintMatch: fpMatch,
  });
  console.log(`  ${s.id}: full@1=${runs.full.rows[0].size} delta@1=${runs.pure.rows[0].size} medDeltaWrite=${median(dWrite).toFixed(3)}ms medDeltaRead=${median(dRead).toFixed(3)}ms medDeltaSize=${median(dRows.map((r) => r.size))} medFullWrite(k1)=${median(fWrite).toFixed(3)}ms medFullRead(k1)=${median(fRead).toFixed(3)}ms medPostKfDelta(k10)=${postKf.length ? median(postKf) : "-"}`);
}

// ------------------------------------------------------------ shrink / pinning
interface ShrinkResult {
  mode: string; fullSizePreDrop: number; fullSizePostDrop: number;
  storedAtEnd: number; totalWritten: number;
  loadRssKbMedian: number | null; loadReadMsMedian: number | null;
}
const shrinkResults: ShrinkResult[] = [];
{
  console.log(`\n=== shrink / pinning ===`);
  const prepDir = path.join(OUT_DIR, "prep", "shape-shrink");
  fs.mkdirSync(prepDir, { recursive: true });
  const src = subst(path.join(EXP, "workflows", "shape-shrink.ts"),
    [["__COUNT__", "10000"], ["__SUSPENSIONS__", "30"]], path.join(prepDir, "shape-shrink.ts"));
  // 31 suspensions: 1 pre-drop (base pins ~436 KB) + 30 post-drop.
  const shrinkModes: Array<{ mode: "full" | "delta"; interval: number | null; tag: string }> = [
    { mode: "full", interval: null, tag: "full" },
    { mode: "delta", interval: null, tag: "pure" },
    { mode: "delta", interval: 25, tag: "k25" },
  ];
  const shrinkRuns: Record<string, RunResult> = {};
  for (const m of shrinkModes) {
    const dir = path.join(OUT_DIR, `shape-shrink-${m.tag}`);
    fs.mkdirSync(dir, { recursive: true });
    const bundle = bundleWorkflow(src, dir, `shape-shrink-${m.tag}`);
    const res = driveRun(m.mode === "full" ? STOCK_BIN : DELTA_BIN, bundle, dir, `shape-shrink-${m.tag}`, m.mode,
      { maxSusp: 31, interval: m.interval, milestones: [1, 2, 31], probeReps: 5 });
    shrinkRuns[m.tag] = res;
    allResults.push(res);
    console.log(`  ${m.tag}: rc=${res.finalRc} susp=${res.rows.length} totalWritten=${res.totalWritten} stored=${res.storedAtEnd} keyframes=${res.keyframeCount}`);
    check(res.finalRc === 0, `shape-shrink/${m.tag}: run completed (rc 0)`);
  }
  check(shrinkRuns.pure.fingerprint === shrinkRuns.full.fingerprint, "shape-shrink: stdout identical pure vs full");
  check(shrinkRuns.k25.fingerprint === shrinkRuns.full.fingerprint, "shape-shrink: stdout identical k25 vs full");
  // RSS of loading the FINAL checkpoint (post-drop, 30 suspensions after
  // the drop): pure loads the old 436 KB base (dead cells pinned);
  // k25 loads the small post-drop keyframe. 5 reps, 500 ms sleep.
  const rss: Record<string, number[]> = {};
  const rssRead: Record<string, number[]> = {};
  for (const tag of ["pure", "k25"]) {
    const dir = path.join(OUT_DIR, `shape-shrink-${tag}`);
    const env: Record<string, string> = { ...process.env, AGENTTS_RUN_ID: `shape-shrink-${tag}`, DURABLETS_DELTA: "1" } as Record<string, string>;
    rss[tag] = [];
    rssRead[tag] = [];
    for (let i = 0; i < 5; i++) {
      const peak = await sampleLoadRss(DELTA_BIN, path.join(dir, "snap"), env, 500);
      if (peak !== null) rss[tag].push(peak);
      const probe = probeLoad(DELTA_BIN, path.join(dir, "snap"), env, 1);
      if (probe.readMs.length) rssRead[tag].push(probe.readMs[0]);
    }
    console.log(`  shape-shrink/${tag}: load RSS median=${median(rss[tag])} KiB (n=${rss[tag].length}) readMs median=${median(rssRead[tag]).toFixed(3)}`);
  }
  for (const m of shrinkModes) {
    const res = shrinkRuns[m.tag];
    shrinkResults.push({
      mode: m.tag,
      fullSizePreDrop: res.rows[0].size,
      fullSizePostDrop: median(res.rows.slice(1).map((r) => r.size)),
      storedAtEnd: res.storedAtEnd, totalWritten: res.totalWritten,
      loadRssKbMedian: rss[m.tag] ? median(rss[m.tag]) : null,
      loadReadMsMedian: rssRead[m.tag] ? median(rssRead[m.tag]) : null,
    });
  }
  // The live heap collapses after the drop (full snapshots prove it),
  // but pure-delta stored bytes stay ~the old base: keyframing is what
  // releases the pinned base.
  check(shrinkRuns.full.rows[0].size > 400000, `shape-shrink/full: pre-drop full ${shrinkRuns.full.rows[0].size} > 400 KB`);
  check(median(shrinkRuns.full.rows.slice(1).map((r) => r.size)) < 30000, `shape-shrink/full: post-drop full ${median(shrinkRuns.full.rows.slice(1).map((r) => r.size))} < 30 KB (heap collapsed)`);
  check(shrinkRuns.pure.storedAtEnd > 400000, `shape-shrink/pure: stored ${shrinkRuns.pure.storedAtEnd} > 400 KB (old base pinned)`);
  check(shrinkRuns.k25.storedAtEnd < 100000, `shape-shrink/k25: stored ${shrinkRuns.k25.storedAtEnd} < 100 KB (keyframe released it)`);
}

// ------------------------------------------------------------ pruning tests (on accumulate-500-k25)
const pruning: Record<string, any> = {};
{
  console.log(`\n=== pruning tests (accumulate-500-k25) ===`);
  const runDir = path.join(OUT_DIR, "accumulate-500-k25");
  const oldDir = path.join(runDir, "prune-old");
  const oldAns = JSON.parse(fs.readFileSync(path.join(oldDir, "answer.json"), "utf8"));
  const finalRes = allResults.find((x) => x.workload === "accumulate-500-k25")!;
  const env: Record<string, string> = { ...process.env, AGENTTS_RUN_ID: "prune-test", DURABLETS_DELTA: "1", DURABLETS_KEYFRAME_INTERVAL: "25" } as Record<string, string>;
  // (a) Final checkpoint alone in a fresh dir resumes to completion.
  const finalDir = path.join(OUT_DIR, "prune-final");
  fs.mkdirSync(finalDir, { recursive: true });
  for (const suf of ["", ".base", ".meta"]) fs.copyFileSync(path.join(runDir, "snap" + suf), path.join(finalDir, "snap" + suf));
  let r = spawnSync(DELTA_BIN, ["resume", path.join(finalDir, "snap"), JSON.stringify(finalRes.lastAnswer)], { env, encoding: "utf8" });
  pruning.finalAloneRc = r.status;
  check(r.status === 0, `pruning(a): final checkpoint alone resumes to completion (rc ${r.status})`);
  check(fs.existsSync(path.join(finalDir, "snap.result.json")), "pruning(a): result.json written");
  // (b) Old checkpoint (ordinal 50) with its own keyframe resumes.
  r = spawnSync(DELTA_BIN, ["resume", path.join(oldDir, "snap"), JSON.stringify(oldAns.answer)], { env, encoding: "utf8" });
  pruning.oldWithKeyframeRc = r.status;
  check(r.status === 2, `pruning(b): old checkpoint + its keyframe resumes to next suspension (rc ${r.status})`);
  // (c) Old checkpoint with its keyframe REPLACED by the final keyframe fails loudly.
  const strandedDir = path.join(OUT_DIR, "prune-stranded");
  fs.mkdirSync(strandedDir, { recursive: true });
  for (const suf of ["", ".base", ".meta"]) fs.copyFileSync(path.join(oldDir, "snap" + suf), path.join(strandedDir, "snap" + suf));
  fs.copyFileSync(path.join(runDir, "snap.base"), path.join(strandedDir, "snap.base"));
  r = spawnSync(DELTA_BIN, ["resume", path.join(strandedDir, "snap"), JSON.stringify(oldAns.answer)], { env, encoding: "utf8" });
  pruning.oldWithNewKeyframeRc = r.status;
  pruning.oldWithNewKeyframeStderr = (r.stderr ?? "").slice(-200);
  check(r.status === 1, `pruning(c): old checkpoint + wrong (newer) keyframe fails loudly (rc ${r.status})`);
  check((r.stderr ?? "").includes("not written from this base"), "pruning(c): engine rejects with base-id mismatch, not a silent wrong resume");
  console.log(`  pruning: final-alone rc=${pruning.finalAloneRc}, old+own-kf rc=${pruning.oldWithKeyframeRc}, old+new-kf rc=${pruning.oldWithNewKeyframeRc}`);
}

// ------------------------------------------------------------ fork check with keyframes
const forkResults: Record<string, any> = {};
{
  console.log(`\n=== fork check with keyframes ===`);
  const judgesSrc = path.join(REPO, "packages/durablets/tests/workflow-judges.ts");
  for (const m of [{ mode: "full" as const, interval: null, tag: "full" },
                   { mode: "delta" as const, interval: 10, tag: "k10" },
                   { mode: "delta" as const, interval: 1, tag: "k1" }]) {
    const dir = path.join(OUT_DIR, `fork-${m.tag}`);
    fs.mkdirSync(dir, { recursive: true });
    const bundle = bundleWorkflow(judgesSrc, dir, `fork-${m.tag}`);
    const bin = m.mode === "full" ? STOCK_BIN : DELTA_BIN;
    const snap = path.join(dir, "snap");
    const env: Record<string, string> = { ...process.env, AGENTTS_RUN_ID: `fork-${m.tag}` } as Record<string, string>;
    if (m.mode === "delta") { env.DURABLETS_DELTA = "1"; env.DURABLETS_KEYFRAME_INTERVAL = String(m.interval); }
    let r = spawnSync(bin, ["run", bundle, snap], { env, encoding: "utf8" });
    check(r.status === 3, `fork/${m.tag}: parent suspended at all() combinator (rc 3)`);
    const csnap = path.join(dir, "child.snap");
    fs.copyFileSync(snap, csnap);
    if (m.mode === "delta") { fs.copyFileSync(snap + ".base", csnap + ".base"); fs.copyFileSync(snap + ".meta", csnap + ".meta"); }
    const cenv = { ...env, AGENTTS_RUN_ID: `fork-${m.tag}/branch-0`, AGENTTS_PARENT_FORK: `fork-${m.tag}/fork-0` };
    r = spawnSync(bin, ["branch", csnap, "0"], { env: cenv, encoding: "utf8" });
    check(r.status === 2, `fork/${m.tag}: branch 0 suspended at its first trap (rc 2)`);
    const trap = lastTrap(r.stderr ?? "");
    check(trap !== null, `fork/${m.tag}: branch trap event present`);
    forkResults[m.tag] = { parentSnap: fsize(snap), parentBase: fsize(snap + ".base"), branchSnap: fsize(csnap), branchBase: fsize(csnap + ".base") };
    console.log(`  fork/${m.tag}: parent snap=${fsize(snap)} base=${fsize(snap + ".base") ?? "-"} branch snap=${fsize(csnap)} base=${fsize(csnap + ".base") ?? "-"}`);
    if (trap) {
      const ans = dispatchAnswer(trap);
      r = spawnSync(bin, ["resume", csnap, JSON.stringify(ans)], { env: cenv, encoding: "utf8" });
      check(r.status === 2 || r.status === 0, `fork/${m.tag}: branch resume did not error (rc ${r.status})`);
    }
  }
}

// ------------------------------------------------------------ write results
const out = { date: new Date().toISOString(), outDir: OUT_DIR, results: allResults, shapes: shapeResults, shrink: shrinkResults, pruning, fork: forkResults, failures };
fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(out, null, 2));
const stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(EXP, `results-keyframes-${stamp}.json`), JSON.stringify(out, null, 2));
console.log(`\nresults -> ${OUT_DIR}/results.json and experiments/bra90/results-keyframes-${stamp}.json`);

// summary tables
console.log("\n=== long chains: total bytes written (500 suspensions) ===");
console.log("| workload | pure | k10 | k25 | k50 | pure/k25 |");
console.log("|---|---|---|---|---|---|");
for (const id of chainIds) {
  const get = (tag: string) => allResults.find((x) => x.workload === `${id}-500-${tag}`)!;
  const pure = get("pure"), k10 = get("k10"), k25 = get("k25"), k50 = get("k50");
  console.log(`| ${id} | ${pure.totalWritten} | ${k10.totalWritten} | ${k25.totalWritten} | ${k50.totalWritten} | ${(pure.totalWritten / k25.totalWritten).toFixed(2)}x |`);
}
console.log("\n=== long chains: load-read ms (median of 5) at chain length ===");
console.log("| workload | mode | 10 | 50 | 100 | 250 | 500 |");
console.log("|---|---|---|---|---|---|---|");
for (const id of chainIds) {
  for (const tag of ["pure", "k10", "k25", "k50"]) {
    const res = allResults.find((x) => x.workload === `${id}-500-${tag}`)!;
    const cells = CHAIN_MILESTONES.map((L) => { const m = res.milestones.find((x) => x.chainLength === L); return m ? m.loadReadMsMedian.toFixed(3) : "-"; });
    console.log(`| ${id} | ${tag} | ${cells.join(" | ")} |`);
  }
}
console.log("\n=== heap shapes (20 suspensions, medians) ===");
console.log("| shape | full@1 | med delta write ms | med delta read ms | med delta size | med full write ms (k1) | med full read ms (k1) | med post-keyframe delta (k10) |");
console.log("|---|---|---|---|---|---|---|---|");
for (const s of shapeResults) {
  console.log(`| ${s.id} | ${s.fullSizeSusp1} | ${s.medianDeltaWriteMs.toFixed(3)} | ${s.medianDeltaReadMs.toFixed(3)} | ${s.medianDeltaSize} | ${s.medianFullWriteMs.toFixed(3)} | ${s.medianFullReadMs.toFixed(3)} | ${s.medianPostKfDelta ?? "-"} |`);
}
console.log("\n=== shrink / pinning ===");
console.log("| mode | pre-drop full | post-drop full (median) | stored at end | load RSS median KiB |");
console.log("|---|---|---|---|---|");
for (const s of shrinkResults) {
  console.log(`| ${s.mode} | ${s.fullSizePreDrop} | ${s.fullSizePostDrop} | ${s.storedAtEnd} | ${s.loadRssKbMedian ?? "-"} |`);
}
console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
