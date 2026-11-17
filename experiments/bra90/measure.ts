// BRA-90 measurement harness — incremental snapshots (JS_SNAPSHOT_BASE/DELTA).
//
// Drives the C host binary DIRECTLY (no host.ts, no queue, no tick agent):
//   durablets run <bundle> <snap>            -> rc 2 (trap) / 3 (combinator) / 0
//   durablets resume <snap> <result-json>    -> same
//   durablets branch <snap> <index>          -> fork check only
// Trap answers are canned and deterministic; large trap results are
// generated from a fixed seed so full-mode and delta-mode runs hold
// byte-identical heaps and their outputs must match exactly.
//
// Usage:
//   bun experiments/bra90/measure.ts [--out-dir DIR] [--workloads a,b,c]
// Workloads: control-1k, control-500k, control-2m, briefing, judgefix,
// churn, fork. Default: all. Everything lands in a fresh scratch dir
// (default mktemp under /tmp); nothing touches ~/workspace/agentts-state
// or the production tick agent. Results: results-YYYY-MM-DD.json in the
// scratch dir AND copied to experiments/bra90/results-<date>.json.
//
// Exit code: 0 when every workload completes identically in both modes
// and every assertion holds; 1 otherwise.
import { spawnSync } from "node:child_process";
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
const OUT_DIR = argVal("--out-dir") || fs.mkdtempSync(path.join("/tmp", "bra90-measure-"));
const only = argVal("--workloads")?.split(",") ?? null;
fs.mkdirSync(OUT_DIR, { recursive: true });
console.log(`BRA-90 measure: out dir ${OUT_DIR}`);

let failures: string[] = [];
function check(cond: boolean, msg: string) {
  if (!cond) { failures.push(msg); console.error(`FAIL: ${msg}`); }
  else console.log(`ok: ${msg}`);
}

// ------------------------------------------------------------ deterministic text
// LCG + fixed sentence pool; identical bytes in both modes by construction.
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
interface SuspRow { ordinal: number; type: string; size: number; kind: string; baseSize: number | null; }
interface RunResult {
  workload: string; mode: "full" | "delta";
  rows: SuspRow[]; finalRc: number; fingerprint: string; resultJson: string | null;
  totalWritten: number; storedAtEnd: number; baseSize: number | null;
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
function dispatchAnswer(trap: any): any {
  const arg = trap.arg ?? {};
  switch (trap.type) {
    case "sleep": return { sleptMs: arg.ms ?? 0 };
    case "job":
      switch (arg.op) {
        case "fetch": return { title: `Paper ${arg.paper}: looped depth`, body: seededText(100 + arg.paper, 3072) };
        case "refine": return { notes: seededText(200 + arg.paper, 1024) };
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

function driveRun(bin: string, bundle: string, dir: string, runId: string, mode: "full" | "delta"): RunResult {
  const snap = path.join(dir, "snap");
  const rows: SuspRow[] = [];
  let stdoutAll = "";
  const env: Record<string, string> = { ...process.env, AGENTTS_RUN_ID: runId } as Record<string, string>;
  if (mode === "delta") env.DURABLETS_DELTA = "1";
  let rc = -1;
  let r = spawnSync(bin, ["run", bundle, snap], { env, encoding: "utf8" });
  rc = r.status ?? 1;
  stdoutAll += r.stdout ?? "";
  let guard = 0;
  while ((rc === 2 || rc === 3) && guard++ < 60) {
    const trap = lastTrap(r.stderr ?? "");
    check(trap !== null, `${runId}/${mode}: trap event present at suspension ${rows.length}`);
    if (!trap) break;
    const size = fsize(snap);
    const baseSize = mode === "delta" ? fsize(snap + ".base") : null;
    const kind = mode === "delta" ? (fs.existsSync(snap + ".meta") ? fs.readFileSync(snap + ".meta", "utf8").trim() : "?") : "full";
    rows.push({ ordinal: trap.ordinal ?? rows.length, type: `${trap.type}:${trap.arg?.op ?? trap.arg?.ms ?? ""}`, size: size ?? -1, kind, baseSize });
    if (rc === 3) { console.error(`  ${runId}/${mode}: suspended at combinator (rc 3) — drive loop stops here`); break; }
    const ans = dispatchAnswer(trap);
    r = spawnSync(bin, ["resume", snap, JSON.stringify(ans)], { env, encoding: "utf8" });
    rc = r.status ?? 1;
    stdoutAll += r.stdout ?? "";
  }
  const resultJson = fs.existsSync(snap + ".result.json") ? fs.readFileSync(snap + ".result.json", "utf8") : null;
  const totalWritten = rows.reduce((a, x) => a + Math.max(0, x.size), 0);
  const lastRow = rows[rows.length - 1];
  const storedAtEnd = mode === "delta"
    ? (lastRow?.baseSize ?? 0) + Math.max(0, lastRow?.size ?? 0)
    : Math.max(0, lastRow?.size ?? 0);
  return { workload: runId, mode, rows, finalRc: rc, fingerprint: stdoutAll, resultJson,
           totalWritten, storedAtEnd, baseSize: mode === "delta" ? fsize(snap + ".base") : null };
}

// ------------------------------------------------------------ workloads
interface Workload { id: string; src: string; prep?: (dir: string) => string; }
const workloads: Workload[] = [
  { id: "control-1k", src: path.join(EXP, "workflows/control.ts"),
    prep: (d) => { const s = fs.readFileSync(path.join(EXP, "workflows/control.ts"), "utf8").replace("__SIZE_BYTES__ / 2", "1024 / 2"); const p = path.join(d, "control-1k.ts"); fs.writeFileSync(p, s); return p; } },
  { id: "control-500k", src: path.join(EXP, "workflows/control.ts"),
    prep: (d) => { const s = fs.readFileSync(path.join(EXP, "workflows/control.ts"), "utf8").replace("__SIZE_BYTES__ / 2", "512000 / 2"); const p = path.join(d, "control-500k.ts"); fs.writeFileSync(p, s); return p; } },
  { id: "control-2m", src: path.join(EXP, "workflows/control.ts"),
    prep: (d) => { const s = fs.readFileSync(path.join(EXP, "workflows/control.ts"), "utf8").replace("__SIZE_BYTES__ / 2", "2097152 / 2"); const p = path.join(d, "control-2m.ts"); fs.writeFileSync(p, s); return p; } },
  { id: "briefing", src: path.join(EXP, "workflows/briefing.ts") },
  { id: "judgefix", src: path.join(EXP, "workflows/judgefix.ts") },
  { id: "churn", src: path.join(EXP, "workflows/churn.ts") },
];
const results: RunResult[] = [];
for (const w of workloads) {
  if (only && !only.includes(w.id)) continue;
  console.log(`\n=== workload ${w.id} ===`);
  for (const mode of ["full", "delta"] as const) {
    const dir = path.join(OUT_DIR, `${w.id}-${mode}`);
    fs.mkdirSync(dir, { recursive: true });
    const src = w.prep ? w.prep(dir) : w.src;
    const bundle = bundleWorkflow(src, dir, w.id);
    const res = driveRun(mode === "full" ? STOCK_BIN : DELTA_BIN, bundle, dir, `${w.id}`, mode);
    results.push(res);
    console.log(`  ${mode}: rc=${res.finalRc} suspensions=${res.rows.length} totalWritten=${res.totalWritten} storedAtEnd=${res.storedAtEnd}`);
    for (const row of res.rows) console.log(`    #${row.ordinal} ${row.type} size=${row.size} kind=${row.kind} base=${row.baseSize ?? "-"}`);
    check(res.finalRc === 0, `${w.id}/${mode}: run completed (rc 0)`);
  }
  const full = results.find((x) => x.workload === w.id && x.mode === "full")!;
  const delta = results.find((x) => x.workload === w.id && x.mode === "delta")!;
  check(full.fingerprint === delta.fingerprint, `${w.id}: stdout fingerprint identical full vs delta`);
  check(full.resultJson === delta.resultJson, `${w.id}: result.json identical full vs delta`);
}

// ------------------------------------------------------------ base reproducibility
if (!only || only.includes("repro")) {
  console.log(`\n=== base reproducibility ===`);
  // Same bundle path AND same run id in both processes: the run id is a
  // snapshotted heap global and the bundle path is the eval filename, so
  // differing either would differ the bytes for reasons unrelated to the
  // engine's reproducibility claim. (First version of this check used
  // different run ids and failed for exactly that reason — harness bug,
  // not an engine finding.)
  const hashes: string[] = [];
  const sharedDir = path.join(OUT_DIR, "repro-shared");
  fs.mkdirSync(sharedDir, { recursive: true });
  const sharedSrc = path.join(sharedDir, "control-1k.ts");
  fs.writeFileSync(sharedSrc, fs.readFileSync(path.join(EXP, "workflows/control.ts"), "utf8").replace("__SIZE_BYTES__ / 2", "1024 / 2"));
  const sharedBundle = bundleWorkflow(sharedSrc, sharedDir, "repro-shared");
  for (let k = 0; k < 2; k++) {
    const dir = path.join(OUT_DIR, `repro-${k}`);
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, AGENTTS_RUN_ID: "repro", DURABLETS_DELTA: "1" } as Record<string, string>;
    const r = spawnSync(DELTA_BIN, ["run", sharedBundle, path.join(dir, "snap")], { env, encoding: "utf8" });
    check(r.status === 2, `repro-${k}: suspended at trap 1 (rc 2)`);
    hashes.push(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "snap.base"))).digest("hex"));
    console.log(`  repro-${k}: base sha256=${hashes[k].slice(0, 16)}… size=${fsize(path.join(dir, "snap.base"))}`);
  }
  check(hashes[0] === hashes[1], "base bytes byte-identical across two fresh processes (rebuildable base)");
}

// ------------------------------------------------------------ fork check (branch from base+delta)
if (!only || only.includes("fork")) {
  console.log(`\n=== fork check: branch from a delta-mode snapshot ===`);
  const judgesSrc = path.join(REPO, "packages/durablets/tests/workflow-judges.ts");
  for (const mode of ["full", "delta"] as const) {
    const dir = path.join(OUT_DIR, `fork-${mode}`);
    fs.mkdirSync(dir, { recursive: true });
    const bundle = bundleWorkflow(judgesSrc, dir, `fork-${mode}`);
    const bin = mode === "full" ? STOCK_BIN : DELTA_BIN;
    const snap = path.join(dir, "snap");
    const env: Record<string, string> = { ...process.env, AGENTTS_RUN_ID: `fork-${mode}` } as Record<string, string>;
    if (mode === "delta") env.DURABLETS_DELTA = "1";
    let r = spawnSync(bin, ["run", bundle, snap], { env, encoding: "utf8" });
    check(r.status === 3, `fork/${mode}: parent suspended at all() combinator (rc 3)`);
    console.log(`  fork/${mode}: parent snap=${fsize(snap)} base=${fsize(snap + ".base") ?? "-"}`);
    // startBranch: copy the snap; in delta mode the pair (.base + .meta)
    // must travel with it, or the branch load fails loudly.
    const csnap = path.join(dir, "child.snap");
    fs.copyFileSync(snap, csnap);
    if (mode === "delta") { fs.copyFileSync(snap + ".base", csnap + ".base"); fs.copyFileSync(snap + ".meta", csnap + ".meta"); }
    const cenv = { ...env, AGENTTS_RUN_ID: `fork-${mode}/branch-0`, AGENTTS_PARENT_FORK: `fork-${mode}/fork-0` };
    r = spawnSync(bin, ["branch", csnap, "0"], { env: cenv, encoding: "utf8" });
    check(r.status === 2, `fork/${mode}: branch 0 suspended at its first trap (rc 2)`);
    console.log(`  fork/${mode}: branch snap=${fsize(csnap)} base=${fsize(csnap + ".base") ?? "-"} meta=${fs.existsSync(csnap + ".meta") ? fs.readFileSync(csnap + ".meta", "utf8").trim() : "-"}`);
    const trap = lastTrap(r.stderr ?? "");
    check(trap !== null, `fork/${mode}: branch trap event present`);
    if (trap) {
      const ans = dispatchAnswer(trap);
      r = spawnSync(bin, ["resume", csnap, JSON.stringify(ans)], { env: cenv, encoding: "utf8" });
      check(r.status === 2 || r.status === 0, `fork/${mode}: branch resume did not error (rc ${r.status})`);
      console.log(`  fork/${mode}: branch after one resume: rc=${r.status} snap=${fsize(csnap)} base=${fsize(csnap + ".base") ?? "-"}`);
    }
  }
}

// ------------------------------------------------------------ write results
const out = { date: new Date().toISOString(), outDir: OUT_DIR, results, failures };
fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(out, null, 2));
const stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(EXP, `results-${stamp}.json`), JSON.stringify(out, null, 2));
console.log(`\nresults -> ${OUT_DIR}/results.json and experiments/bra90/results-${stamp}.json`);

// summary table
console.log("\n| workload | susp | full total written | delta total written | delta/full | stored full | stored delta (base+last) |");
console.log("|---|---|---|---|---|---|---|");
for (const w of workloads) {
  if (only && !only.includes(w.id)) continue;
  const full = results.find((x) => x.workload === w.id && x.mode === "full")!;
  const delta = results.find((x) => x.workload === w.id && x.mode === "delta")!;
  console.log(`| ${w.id} | ${full.rows.length} | ${full.totalWritten} | ${delta.totalWritten} | ${(delta.totalWritten / full.totalWritten).toFixed(3)} | ${full.storedAtEnd} | ${delta.storedAtEnd} |`);
}
console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
