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
// baseline down — but only on a decisive improvement (BRA-107 (c)):
// the window median must also be <= 0.80x the old baseline;
// otherwise the streak resets without moving — tighten-only
// (BRA-107) — per metric, logged in ratchet.log with before/after
// numbers. Default reps is 5 (BRA-107 (a)): a 5-observation median
// cuts the noisiest metric's swing roughly in half vs 3 reps.
//
// Confirm-before-fail (BRA-107 (b)): a threshold breach does not
// fail the check immediately. The suite is re-run once and only the
// breaching metric(s) are re-checked: if the re-measure also
// breaches, the failure is real and the check fails; if it passes,
// the first observation was a single-observation flake and the
// metric counts as green on the re-measured value (the breaching
// observation is discarded, not recorded). Cost is one extra suite
// run, on failure only. With --results there is no live suite to
// re-run, so breaches fail immediately as before.
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
  type BaselineEntry,
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

let reps = 5;
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

let suiteRunCount = 0;
/** Run the bench suite once and return its parsed results. */
function runSuite(reps: number): { results: ResultRow[] } {
  const tmp = path.join(os.tmpdir(), `agentts-bench-check-${process.pid}-${++suiteRunCount}.json`);
  const run = spawnSync(process.execPath, [path.join(BENCH_DIR, "run.ts"), "--reps", String(reps), "--out", tmp], {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (run.status !== 0) {
    console.error(`bench suite failed (exit ${run.status}) — cannot check thresholds`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(tmp, "utf8")) as { results: ResultRow[] };
}

const results = resultsFile
  ? (JSON.parse(fs.readFileSync(resultsFile, "utf8")) as { results: ResultRow[] })
  : runSuite(reps);
const baselines: BaselinesFile = loadBaselines();
const byId = new Map(results.results.map((r) => [r.id, r]));

let failures = 0;
let ratcheted = 0;
let confirmedPasses = 0;
/** Process a green observation through the ratchet rule and print the
 * outcome line. Returns nothing; updates `ratcheted` on a ratchet. */
function reportGreen(id: string, entry: BaselineEntry, observed: number, note = ""): void {
  if (noRatchet) {
    console.log(
      `PASS ${id}: ${observed} ${entry.unit} <= threshold ${entry.threshold} (baseline ${entry.baseline})${note}`,
    );
    return;
  }
  const outcome = applyObservation(entry, id, observed);
  if (outcome === "ratcheted") {
    console.log(
      `RATCHETED ${id}: baseline ${entry.baseline} ${entry.unit} is the NEW baseline ` +
        `(was higher; threshold now ${entry.threshold}) — see ratchet.log${note}`,
    );
    ratcheted++;
  } else {
    console.log(
      `PASS ${id}: ${observed} ${entry.unit} <= threshold ${entry.threshold} ` +
        `(baseline ${entry.baseline}, streak ${entry.greenStreak}/5)${note}`,
    );
  }
}

interface Breach {
  id: string;
  entry: BaselineEntry;
  row: ResultRow;
}
const breached: Breach[] = [];
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
    // BRA-107 (b): do not fail yet — confirm by re-measuring below.
    // The breaching observation is held, not recorded: if the
    // re-measure passes, the flake is discarded entirely.
    console.log(
      `FAIL ${id}: observed ${row.median} ${row.unit} > threshold ${entry.threshold} ` +
        `(baseline ${entry.baseline}, x${entry.multiple})`,
    );
    breached.push({ id, entry, row });
    continue;
  }
  reportGreen(id, entry, row.median);
}

if (breached.length > 0) {
  if (resultsFile) {
    // No live suite to re-run from a recorded file: breaches fail as
    // before, and the streak resets (never loosens).
    for (const { id, entry, row } of breached) {
      if (!noRatchet) applyObservation(entry, id, row.median);
      failures++;
    }
  } else {
    console.log(
      `CONFIRM: ${breached.length} metric(s) breached; re-measuring once before failing (BRA-107 confirm-before-fail)...`,
    );
    const confirm = runSuite(reps);
    const confirmById = new Map(confirm.results.map((r) => [r.id, r]));
    for (const { id, entry, row } of breached) {
      const again = confirmById.get(id);
      if (!again) {
        console.log(`FAIL ${id}: re-measure produced no value — treating the breach as real`);
        if (!noRatchet) applyObservation(entry, id, row.median);
        failures++;
        continue;
      }
      if (again.median > entry.threshold) {
        console.log(
          `FAIL ${id}: confirmed on re-measure — ${again.median} ${again.unit} > threshold ${entry.threshold} ` +
            `(first observation ${row.median}); failing`,
        );
        if (!noRatchet) applyObservation(entry, id, again.median);
        failures++;
        continue;
      }
      console.log(
        `CONFIRMED-PASS ${id}: re-measured ${again.median} ${again.unit} <= threshold ${entry.threshold} ` +
          `— first observation ${row.median} did not reproduce (single-observation flake)`,
      );
      confirmedPasses++;
      reportGreen(
        id,
        entry,
        again.median,
        ` (confirmed on re-measure; breaching observation ${row.median} discarded)`,
      );
    }
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
    (confirmedPasses ? `, ${confirmedPasses} breach(es) cleared on re-measure` : "") +
    (noRatchet ? " (ratchet off: no history recorded)" : ""),
);
process.exit(failures === 0 ? 0 : 1);
