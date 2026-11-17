// Alarm check (BRA-93): run the benchmark suite, compare each metric
// against its recorded baseline threshold, fail loudly on regression.
//
//   bun bench/check.ts [--reps N] [--no-ratchet] [--results FILE]
//   bun bench/check.ts loosen <metric> <newBaseline> --reason "..."
//
// Exit 0: every metric green. Exit 1: any metric breached its threshold,
// a metric has no baseline, or the suite did not produce a metric.
// A breach never changes a baseline (loosening is never automatic).
// A green run records the observation in the baseline's history and
// applies the ratchet rule (see baselines.ts): 5 consecutive
// observations each beating the threshold by >= 20% ratchets the
// baseline down to the median of those 5, per metric, logged in
// ratchet.log with before/after numbers.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  BENCH_DIR,
  loadBaselines,
  saveBaselines,
  applyObservation,
  loosenBaseline,
  type BaselinesFile,
} from "./baselines.ts";

interface ResultRow {
  id: string;
  unit: string;
  median: number;
}

function usage(): never {
  console.error(
    "usage:\n" +
      "  bun bench/check.ts [--reps N] [--no-ratchet] [--results FILE]\n" +
      "  bun bench/check.ts loosen <metric> <newBaseline> --reason \"...\"",
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv[0] === "loosen") {
  const [, metric, baselineRaw] = argv;
  const reasonIdx = argv.indexOf("--reason");
  const reason = reasonIdx >= 0 ? argv[reasonIdx + 1] ?? "" : "";
  if (!metric || !baselineRaw || reasonIdx < 0) usage();
  const file = loadBaselines();
  loosenBaseline(file, metric, Number(baselineRaw), reason);
  saveBaselines(file);
  console.log(`loosened ${metric} to baseline ${baselineRaw} (reason recorded in ratchet.log)`);
  process.exit(0);
}

let reps = 3;
let noRatchet = false;
let resultsFile: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--reps") reps = Number(argv[++i]);
  else if (a === "--no-ratchet") noRatchet = true;
  else if (a === "--results") resultsFile = argv[++i];
  else if (a === "--help" || a === "-h") usage();
  else {
    console.error(`unknown arg: ${a}`);
    usage();
  }
}

if (!resultsFile) {
  const tmp = path.join(os.tmpdir(), `agentts-bench-check-${process.pid}.json`);
  const run = spawnSync(process.execPath, [path.join(BENCH_DIR, "run.ts"), "--reps", String(reps), "--out", tmp], {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (run.status !== 0) {
    console.error(`bench suite failed (exit ${run.status}) — cannot check thresholds`);
    process.exit(1);
  }
  resultsFile = tmp;
}

const results = JSON.parse(fs.readFileSync(resultsFile, "utf8")) as { results: ResultRow[] };
const baselines: BaselinesFile = loadBaselines();
const byId = new Map(results.results.map((r) => [r.id, r]));

let failures = 0;
let ratcheted = 0;
for (const [id, entry] of Object.entries(baselines.metrics)) {
  const row = byId.get(id);
  if (!row) {
    console.log(`MISSING ${id}: suite produced no value (baseline ${entry.baseline} ${entry.unit})`);
    failures++;
    continue;
  }
  if (row.unit !== entry.unit) {
    console.log(`MISMATCH ${id}: unit changed ${entry.unit} -> ${row.unit}; refusing to compare`);
    failures++;
    continue;
  }
  if (row.median > entry.threshold) {
    console.log(
      `FAIL ${id}: observed ${row.median} ${row.unit} > threshold ${entry.threshold} ` +
        `(baseline ${entry.baseline}, x${entry.multiple})`,
    );
    if (!noRatchet) applyObservation(entry, id, row.median); // resets the streak; never loosens
    failures++;
    continue;
  }
  if (noRatchet) {
    console.log(`PASS ${id}: ${row.median} ${row.unit} <= threshold ${entry.threshold} (baseline ${entry.baseline})`);
    continue;
  }
  const outcome = applyObservation(entry, id, row.median);
  if (outcome === "ratcheted") {
    console.log(
      `RATCHETED ${id}: baseline ${entry.baseline} ${entry.unit} is the NEW baseline ` +
        `(was higher; threshold now ${entry.threshold}) — see ratchet.log`,
    );
    ratcheted++;
  } else {
    console.log(
      `PASS ${id}: ${row.median} ${row.unit} <= threshold ${entry.threshold} ` +
        `(baseline ${entry.baseline}, streak ${entry.greenStreak}/5)`,
    );
  }
}
for (const row of results.results) {
  if (!baselines.metrics[row.id]) {
    console.log(`UNBASELINED ${row.id}: measured ${row.median} ${row.unit} but no baseline exists — review and run --write-baselines`);
    failures++;
  }
}
if (!noRatchet) saveBaselines(baselines);

console.log(
  `\n${failures === 0 ? "ALL GREEN" : `${failures} FAILURE(S)`} — ${Object.keys(baselines.metrics).length} metrics checked` +
    (ratcheted ? `, ${ratcheted} ratcheted down` : "") +
    (noRatchet ? " (ratchet off: no history recorded)" : ""),
);
process.exit(failures === 0 ? 0 : 1);
