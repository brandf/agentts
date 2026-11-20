#!/usr/bin/env bun
/**
 * Briefing must-read decision measures topic-fit, not consequence
 * (Linear BRA-130).
 *
 * Found by the BRA-124 re-trial round 2 (Nov 18, 2026): even when the
 * day's must-read IS selected, the trial picks the wrong must-read.
 * Read scores that day: LoopZip 2611.22728 = 21, VisHead-Spec
 * 2611.21839 = 16, The Kernel Reality Check 2611.22947 (the cron's
 * must-read) = 16. The old rankScore was
 * `score*10 + min(numbers,5) + (fullText?1:0)`: LoopZip 213,
 * VisHead-Spec 164, KRC 163 — KRC loses the #2 decide-trap slot by
 * ONE point (numbers count 2 vs 3), and the v0 decision model then
 * ratifies the score-ordered leader. Trial must-read: LoopZip.
 *
 * BRA-124 (merged Nov 19) built the semantic judge, so consequence
 * scores now exist — but the must-read mechanism still let the
 * numbers/fullText bonuses (up to 6 points) overturn a consequence
 * point, and the decide trap only ever ratified the leader. This
 * item finishes the job (BRA-130):
 *   - the ranking is consequence-led end to end: combinedScore
 *     orders; numbers and fullText are TIEBREAKS only and can never
 *     overturn a consequence point (workflows/library/
 *     consequence-rank.ts: rankReads / compareReads);
 *   - the decide trap is GONE: the must-read is a deterministic pick
 *     (top of the ranking). The v0 decision model cannot judge
 *     consequence, so the trap was a fake step — the r0 species
 *     (gates always returning true, exec faking success). The
 *     ranking IS the decision. The stale "threshold 50" calibration
 *     goes away with it;
 *   - an unjudged read throws loudly instead of silently falling
 *     back to `score * 10` (the old topic-fit formula).
 *
 * What this proves:
 *   A. Ranking units (direct import of rankReads): the Nov 18
 *      regression — KRC beats LoopZip on the issue's own values,
 *      while the OLD rankScore (mirrored here) picks LoopZip on the
 *      same fixture, proving the fixture reproduces the original
 *      failure; a one-consequence-point gap cannot be overturned by
 *      numbers/fullText (the 81-vs-80 case); tiebreak order is
 *      numbers, then fullText, then id; an unjudged read throws
 *      naming the paper.
 *   B. Fixture grounding (when present at
 *      ~/workspace/bra124-judgments-2026-11-18.json, or
 *      $BRA130_JUDGMENTS): the recorded verdicts say KRC
 *      consequence 8, LoopZip consequence 4 — the regression
 *      fixture's consequence values come from the recorded
 *      verdicts, not from the test author. Skipped with a note if
 *      the fixture is absent.
 *   C. Run-level, CLI + briefing mock adapter (modeled on
 *      test-bra123 §B): a Nov 18 edition run through the real engine
 *      returns mustReadId 2611.90001 — the top combined paper on the
 *      mock fixture (consequence 5 for all, top topic 7.5) — proving
 *      the deterministic pick drives end to end after the trap
 *      removal, and agrees with the old decide-trap outcome on a
 *      fixture where all consequences are equal. (The mock read
 *      passes consequence through like the real worker; if it
 *      dropped it, rankReads would throw and this run would fail.)
 *   D. Source-level: no `decide<` call and no "threshold 50" remain
 *      in daily-ai-briefing.ts; the workflow imports rankReads.
 *
 * Notes, stated plainly:
 * - The Nov 18 fixture's topic scores (KRC 16, LoopZip 21) and
 *   numbers counts (KRC 2, LoopZip 3) are from the BRA-130 issue
 *   text. The fullText values are DERIVED from the issue's
 *   rankScore arithmetic, not recorded data: KRC 163 = 160+2+1, so
 *   fullText true; LoopZip 213 = 210+3+0 with 3 numbers, so
 *   fullText false. The regression holds under either fullText
 *   assignment (KRC combined 96 vs LoopZip 61) — the derivation
 *   only pins the old-score reproduction (163 vs 213) exactly.
 * - The mock run no longer supplies a judgments file (BRA-162): the
 *   workflow omits judgmentsPath from the judge job input when it is
 *   absent, so a mock run with no judgments file reaches the mock
 *   adapter's neutral-5 fixture instead of dying at the trap
 *   boundary with "JsonBoundaryError: $.input.judgmentsPath is
 *   undefined". test-bra162.ts pins the no-judgments run and the
 *   with-judgments trial run. (Section B's real judgments fixture is
 *   unrelated — it is the ranking logic's fixture, not a workaround.)
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra130.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { combinedScore, compareReads, rankReads, type RankedRead } from "../workflows/library/consequence-rank";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const WORKDIR = process.env.BRA130_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "bra130-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const GOAL_DIR = "/home/hatch/workspace/goals/daily-ai-research-briefing";
const VENV_PYTHON = path.join(GOAL_DIR, "hidden_files", ".venv", "bin", "python");
const WORKFLOW = path.join(ROOT, "workflows", "dogfood", "daily-ai-briefing.ts");
const ADAPTER = path.join(ROOT, "plugins", "briefing", "src", "adapter.ts");
const FIXTURE =
  process.env.BRA130_JUDGMENTS ||
  path.join(os.homedir(), "workspace", "bra124-judgments-2026-11-18.json");

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

function mkRead(
  id: string,
  score: number,
  consequence: number | null | undefined,
  nNumbers: number,
  fullText: boolean,
): RankedRead {
  const numbers: string[] = [];
  for (let i = 0; i < nNumbers; i++) numbers.push(`number ${i + 1}`);
  return { id, score, consequence, numbers, fullText };
}

/** The pre-fix rankScore, mirrored exactly (BRA-130 issue text):
 * `score*10 + min(numbers,5) + (fullText?1:0)`. Kept only to prove
 * the regression fixture reproduces the original failure. */
function oldRankScore(r: RankedRead): number {
  return r.score * 10 + Math.min(r.numbers.length, 5) + (r.fullText ? 1 : 0);
}

// ---------------------------------------------------------------- A. ranking units
// Nov 18 regression values (issue text + derived fullText, see the
// header): KRC topic 16, consequence 8, 2 numbers, fullText true;
// LoopZip topic 21, consequence 4, 3 numbers, fullText false.
const KRC = mkRead("2611.22947", 16, 8, 2, true);
const LOOPZIP = mkRead("2611.22728", 21, 4, 3, false);
const LOST = mkRead("2611.21917", 7, 8, 2, true);

check(oldRankScore(KRC) === 163, `A OLD-KRC OK: old rankScore(KRC)=${oldRankScore(KRC)} (want 163, the issue's number)`);
check(oldRankScore(LOOPZIP) === 213, `A OLD-LOOPZIP OK: old rankScore(LoopZip)=${oldRankScore(LOOPZIP)} (want 213, the issue's number)`);
check(oldRankScore(LOOPZIP) > oldRankScore(KRC), `A OLD-FAILS OK: old rule picks LoopZip (${oldRankScore(LOOPZIP)}) over KRC (${oldRankScore(KRC)}) — the fixture reproduces the original failure`);

const rankedNov18 = rankReads([LOOPZIP, KRC, LOST]);
check(rankedNov18[0].id === KRC.id, `A NOV18 OK: rankReads puts KRC first (got ${rankedNov18[0].id})`);
check(rankedNov18[1].id === LOST.id, `A NOV18-2 OK: rankReads puts Lost-Heads second (got ${rankedNov18[1].id})`);
check(rankedNov18[2].id === LOOPZIP.id, `A NOV18-3 OK: rankReads puts LoopZip last (got ${rankedNov18[2].id})`);

// The 81-vs-80 case (brief): a consequence-7 paper with 5 numbers
// and full text must NOT beat a consequence-8 paper with none. The
// comparison is against the REJECTED design — combined score PLUS
// the old bonuses — which scores the seven 81 (75+6) against the
// eight's 80: that is exactly the overturn the tiebreak-only rule
// removes. (The pre-fix rankScore cannot see consequence at all, so
// it is not the comparison here; the old-rule check above already
// pins the original failure.)
function combinedPlusBonuses(r: RankedRead): number {
  return combinedScore(r.score, r.consequence ?? null) + Math.min(r.numbers.length, 5) + (r.fullText ? 1 : 0);
}
const seven = mkRead("2611.90007", 5, 7, 5, true);
const eight = mkRead("2611.90008", 0, 8, 0, false);
check(combinedPlusBonuses(seven) === 81 && combinedPlusBonuses(eight) === 80, `A BONUS-81 OK: bonuses-on-combined scores 81 vs 80 (seven would win — the rejected design)`);
const rankedGap = rankReads([seven, eight]);
check(rankedGap[0].id === eight.id, `A GAP OK: one consequence point cannot be overturned — consequence-8 first (got ${rankedGap[0].id})`);

// Tiebreak order: equal combined -> numbers, then fullText, then id.
const tieNumsA = mkRead("2611.90011", 10, 6, 3, false);
const tieNumsB = mkRead("2611.90012", 10, 6, 1, true);
check(rankReads([tieNumsB, tieNumsA])[0].id === tieNumsA.id, "A TIE-NUMS OK: equal combined, more numbers wins (numbers outrank fullText)");
const tieFtA = mkRead("2611.90013", 10, 6, 2, true);
const tieFtB = mkRead("2611.90014", 10, 6, 2, false);
check(rankReads([tieFtB, tieFtA])[0].id === tieFtA.id, "A TIE-FT OK: equal combined and numbers, fullText wins");
const tieIdA = mkRead("2611.90022", 10, 6, 2, true);
const tieIdB = mkRead("2611.90021", 10, 6, 2, true);
check(rankReads([tieIdA, tieIdB])[0].id === tieIdB.id, "A TIE-ID OK: full tie, lower id first (deterministic)");
check(compareReads(tieIdB, tieIdA) < 0, "A CMP OK: compareReads orders the lower id first");

// Unjudged reads throw loudly, naming the paper — no silent
// topic-fit fallback.
let threwMissing = "";
try {
  rankReads([mkRead("2611.90031", 7, 5, 1, true), mkRead("2611.90032", 21, undefined, 3, false)]);
} catch (e) {
  threwMissing = String(e);
}
check(
  threwMissing.includes("2611.90032") && threwMissing.includes("no consequence"),
  `A THROW-UNDEF OK: unjudged (undefined) read throws naming the paper (got ${JSON.stringify(threwMissing.slice(0, 120))})`,
);
let threwNull = "";
try {
  rankReads([mkRead("2611.90033", 7, null, 1, true)]);
} catch (e) {
  threwNull = String(e);
}
check(
  threwNull.includes("2611.90033") && threwNull.includes("no consequence"),
  `A THROW-NULL OK: unjudged (null) read throws naming the paper (got ${JSON.stringify(threwNull.slice(0, 120))})`,
);
// A one-element array never calls the sort comparator, so the
// validation must live in rankReads itself — this is the case that
// caught the first version (compareReads-only guard, silent pass).
let threwSingle = "";
try {
  rankReads([mkRead("2611.90034", 7, undefined, 1, true)]);
} catch (e) {
  threwSingle = String(e);
}
check(
  threwSingle.includes("2611.90034") && threwSingle.includes("no consequence"),
  `A THROW-SINGLE OK: a lone unjudged read throws naming the paper (got ${JSON.stringify(threwSingle.slice(0, 120))})`,
);

// ---------------------------------------------------------------- B. fixture grounding
if (fs.existsSync(FIXTURE)) {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const scores = fixture.scores ?? fixture;
  const byId = new Map<string, any>();
  for (const s of scores) byId.set(s.id, s);
  check(byId.get("2611.22947")?.consequence === 8, `B KRC OK: recorded verdict says KRC consequence 8 (got ${byId.get("2611.22947")?.consequence})`);
  check(byId.get("2611.22728")?.consequence === 4, `B LOOPZIP OK: recorded verdict says LoopZip consequence 4 (got ${byId.get("2611.22728")?.consequence})`);
  // Rebuild the regression reads from the recorded consequences +
  // the issue's topic/numbers values; the ranking must pick KRC.
  const krcFromFixture = mkRead("2611.22947", 16, byId.get("2611.22947").consequence, 2, true);
  const loopzipFromFixture = mkRead("2611.22728", 21, byId.get("2611.22728").consequence, 3, false);
  check(
    rankReads([loopzipFromFixture, krcFromFixture])[0].id === "2611.22947",
    "B FIXTURE OK: reads built from the recorded verdicts rank KRC first",
  );
} else {
  ok(`B: SKIP — fixture not present at ${FIXTURE}`);
}

// ---------------------------------------------------------------- C. run-level: CLI + briefing mock adapter
const DURABLETS_HOST = process.env.DURABLETS_HOST;
if (!DURABLETS_HOST) {
  fail("C HOST OK: DURABLETS_HOST is not set — run via run.sh or export it (a built C host)");
  console.log(`\ntest-bra130: ${FAILURES.length + 1} FAILURE(S)`);
  process.exit(1);
}
const SCRATCH = path.join(WORKDIR, "scratch");
// No judgmentsPath (BRA-162): the mock run needs none — the mock
// judge fixture answers neutral 5 for every paper, and the workflow
// omits the key from the judge job input when it is absent.
const inputPath = path.join(WORKDIR, "input.json");
fs.writeFileSync(
  inputPath,
  JSON.stringify({
    dateLabel: "Wednesday, November 18, 2026",
    editionDate: "2026-11-18",
    mock: true,
    readCount: 5,
    scratchDir: SCRATCH,
    selectCount: 5,
    venvPython: VENV_PYTHON,
    windowDays: 7,
  }),
);
const cliRun = spawnSync(
  BUN,
  [
    path.join(ROOT, "src", "cli.ts"),
    "run",
    WORKFLOW,
    "--adapter",
    "briefing",
    "--input-file",
    inputPath,
    "--state-dir",
    path.join(WORKDIR, "state"),
    "--wait",
  ],
  {
    encoding: "utf8",
    env: { ...process.env, AGENTTS_BRIEFING_MOCK: "1", DURABLETS_HOST },
    cwd: ROOT,
  },
);
check(cliRun.status === 0, `C RC OK: CLI mock run exits 0 (got ${cliRun.status}; stderr tail: ${String(cliRun.stderr ?? "").trim().slice(-200)})`);
let result: any = null;
if (cliRun.status === 0) {
  const out = cliRun.stdout ?? "";
  const jsonText = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  try {
    result = JSON.parse(jsonText);
  } catch {
    fail(`C JSON OK: CLI stdout parses as the result JSON (got ${JSON.stringify(out.slice(0, 200))})`);
  }
}
if (result) {
  // Mock fixture: consequence 5 for all 7 papers, topic scores
  // 7.5 down to 4.5 — top combined is 2611.90001 at 57.5.
  check(result.mustReadId === "2611.90001", `C MUSTREAD OK: mock run must-read is 2611.90001 (got ${result.mustReadId})`);
  check(result.paperCount === 5, `C COUNT OK: mock run paperCount is 5 (got ${result.paperCount})`);
  check(
    JSON.stringify(result.selectedIds) === JSON.stringify(["2611.90001", "2611.90002", "2611.90003", "2611.90004", "2611.90005"]),
    `C SELECTED OK: selectedIds are the top 5 by combined (got ${JSON.stringify(result.selectedIds)})`,
  );
}

// ---------------------------------------------------------------- D. source checks
const workflowSrc = fs.readFileSync(WORKFLOW, "utf8");
check(!workflowSrc.includes("decide<"), "D NODECIDE OK: no decide< call remains in daily-ai-briefing.ts");
check(!workflowSrc.includes("threshold 50"), "D NOTHRESH OK: no 'threshold 50' remains in daily-ai-briefing.ts");
check(workflowSrc.includes("rankReads"), "D RANKREADS OK: the workflow imports/uses rankReads");
check(
  workflowSrc.includes("const mustReadId = selected[0].id;"),
  "D DETERMINISTIC OK: the must-read is the deterministic top of the ranking",
);
const adapterSrc = fs.readFileSync(ADAPTER, "utf8");
check(
  adapterSrc.includes("consequence: typeof p.consequence === \"number\" ? p.consequence : undefined,"),
  "D MOCK OK: the mock read fixture passes consequence through like the real worker",
);

// ---------------------------------------------------------------- verdict
if (FAILURES.length > 0) {
  console.log(`\ntest-bra130: ${FAILURES.length} FAILURE(S)`);
  process.exit(1);
}
console.log("\nPASS bra130 briefing must-read consequence-led (Nov 18 regression: KRC beats LoopZip; one consequence point cannot be overturned; tiebreaks numbers/fullText/id; unjudged reads throw; CLI mock run must-read 2611.90001; decide trap + threshold 50 gone)");
