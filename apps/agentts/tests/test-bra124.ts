#!/usr/bin/env bun
/**
 * LLM consequence judge for briefing discovery parity (Linear BRA-124).
 *
 * The v0 keyword topicScore counts DISTINCT terms per topic (capped
 * 3/topic): it measures topic BREADTH, so broad vision abstracts
 * score 14-21 while focused consequential papers score 4-9, and the
 * Nov 18 trial vs the cron edition overlapped 1/13 (Jaccard 0.08).
 * Consequence — whether a paper changes what is true / what works /
 * what to build — is not visible to keyword scoring. The fix is an
 * LLM judge that reads abstracts and scores consequence 0-10
 * (jobspec plugins/muse/jobspecs/briefing-judge-consequence.md),
 * combined with topicScore in workflows/library/consequence-rank.ts
 * as combined = consequence * 10 + topicScore.
 *
 * MECHANISM GAP, stated plainly: under the direct adapter there is
 * no LLM in the loop. The briefing-worker judge handler only CARRIES
 * recorded verdicts (inline `judgments` or a `judgmentsPath` file);
 * in production the same `job` trap goes to a pool worker (a Muse
 * subagent) following the jobspec, which judges live. This test
 * therefore proves (a) the recorded judgments separate
 * consequential from broad papers, and (b) the handler carries and
 * validates them — it does NOT prove the pool judge produces those
 * judgments live.
 *
 * What this proves (in-process DirectAdapter, own temp dirs):
 *   A. Ranking: recorded consequence verdicts rank The Kernel
 *      Reality Check (2611.22947, consequence 8) above LoopZip
 *      (2611.22728, consequence 4) and above the broadest topic
 *      scorer that day (VisHead-Spec 2611.21839, topic 10,
 *      consequence 5) by combined score — the exact inversion the
 *      keyword-only ranking got wrong (LoopZip was the trial
 *      must-read, Kernel Reality Check the cron must-read).
 *   B. Full fixture (when present at
 *      ~/workspace/bra124-judgments-2026-11-18.json, or
 *      $BRA124_JUDGMENTS): all 40 pool verdicts rank Kernel Reality
 *      Check #1 and Lost in a Few Heads #2, and all four
 *      pool-reachable cron papers land in the top 18. Topic scores
 *      come from the committed tests/fixtures/bra124-discover.json
 *      (BRA-173 — the old /tmp file is gone). Skipped with a
 *      note if the judgments fixture is absent — the inline checks
 *      in A are the regression gate.
 *   C. Handler: a real DirectAdapter instance, with the copy's
 *      briefing-worker.ts registered for briefing-judge-consequence,
 *      returns the recorded verdicts for a 3-paper input (inline
 *      judgments, and again via judgmentsPath).
 *   D. Fail loudly: with no judgments and no judgmentsPath the
 *      handler returns ok:false naming the missing judge (no silent
 *      keyword fallback, no invented score); with incomplete
 *      coverage it returns ok:false naming the missing paper.
 *
 *   bun tests/test-bra124.ts
 * Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { combinedScore, rankByConsequence } from "../workflows/library/consequence-rank";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKER = path.join(ROOT, "workflows", "dogfood", "briefing-worker.ts");
const FIXTURE =
  process.env.BRA124_JUDGMENTS ||
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

// --- A. Ranking on known examples (inline, the regression gate) ---
// topicScore is the Nov 18 discovery score; consequence is the
// recorded LLM verdict (fixture provenance: Muse, 2026-11-19).
// The field is `score` — that is the name ConsequenceScored uses
// for topicScore (rankByConsequence reads .score).
const KRC = { id: "2611.22947", score: 8, consequence: 8 }; // Kernel Reality Check
const LOST = { id: "2611.21917", score: 7, consequence: 8 }; // Lost in a Few Heads
const LOOPZIP = { id: "2611.22728", score: 7, consequence: 4 }; // LoopZip (trial must-read)
const LOOPPRUNE = { id: "2611.22757", score: 7, consequence: 4 };
const VISHEAD = { id: "2611.21839", score: 10, consequence: 5 }; // broadest topic scorer

check(combinedScore(8, 9) === 98, `A: combinedScore(8,9)=${combinedScore(8, 9)} (want 98)`);
check(combinedScore(21, 3) === 51, `A: combinedScore(21,3)=${combinedScore(21, 3)} (want 51)`);

const krc = combinedScore(KRC.score, KRC.consequence);
const loopzip = combinedScore(LOOPZIP.score, LOOPZIP.consequence);
const vishead = combinedScore(VISHEAD.score, VISHEAD.consequence);
check(krc === 88, `A: KRC combined=${krc} (want 88)`);
check(loopzip === 47, `A: LoopZip combined=${loopzip} (want 47)`);
check(krc > loopzip, `A: KRC (${krc}) ranks above LoopZip (${loopzip}) by combined score`);
check(krc > vishead, `A: KRC (${krc}) ranks above broadest topic scorer VisHead-Spec (${vishead})`);
const ranked = rankByConsequence([LOOPZIP, VISHEAD, KRC, LOOPPRUNE, LOST]);
check(ranked[0].id === KRC.id, `A: rankByConsequence puts KRC first (got ${ranked[0].id})`);
check(ranked[1].id === LOST.id, `A: rankByConsequence puts Lost-Heads second (got ${ranked[1].id})`);
check(
  ranked[ranked.length - 1].id === LOOPPRUNE.id || ranked[ranked.length - 1].id === LOOPZIP.id,
  `A: rankByConsequence puts a loop-pruning method last (got ${ranked[ranked.length - 1].id})`,
);

// --- B. Full fixture ranking (when present) ---
if (fs.existsSync(FIXTURE)) {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  // BRA-173: the Nov 18 discover topic scores live in a COMMITTED
  // fixture (tests/fixtures/bra124-discover.json), generated from the
  // judgments fixture's combinedRanking[].topic and cross-checked 40/40
  // by recomputing topicScore(title) with the TOPICS table in
  // workflows/dogfood/briefing-worker.ts. The old /tmp/bra124-discover.json
  // is gone (/tmp is wiped on VM replacement) and nothing regenerates it.
  // A missing fixture, or a verdict id without a topic score, is a LOUD
  // failure here — never a silent 0. The silent default is what made
  // this section fail with the wrong #1 (2611.17339, the consequence-8
  // tie breaking by id) instead of failing loudly.
  const discPath = path.join(DIR, "fixtures", "bra124-discover.json");
  check(fs.existsSync(discPath), `B: discover fixture present at ${discPath} (BRA-173)`);
  const topicById = new Map<string, number>();
  if (fs.existsSync(discPath)) {
    for (const c of JSON.parse(fs.readFileSync(discPath, "utf8")).candidates) {
      topicById.set(c.id, c.score);
    }
  }
  const missing = fixture.scores.filter((s: any) => !topicById.has(s.id)).map((s: any) => s.id);
  check(missing.length === 0, `B: every verdict has a discover topic score (missing: ${missing.join(", ") || "none"})`);
  const items = fixture.scores.map((s: any) => ({
    id: s.id,
    score: topicById.get(s.id) ?? 0,
    consequence: s.consequence,
  }));
  check(items.length === 40, `B: fixture carries ${items.length} verdicts (want 40)`);
  const full = rankByConsequence(items);
  check(full[0].id === "2611.22947", `B: full ranking #1 is Kernel Reality Check (got ${full[0].id})`);
  check(full[1].id === "2611.21917", `B: full ranking #2 is Lost in a Few Heads (got ${full[1].id})`);
  const top18 = new Set(full.slice(0, 18).map((p) => p.id));
  for (const cronId of ["2611.22947", "2611.21917", "2611.22426", "2611.22296"]) {
    check(top18.has(cronId), `B: pool-reachable cron paper ${cronId} is in the top 18`);
  }
  const top10 = new Set(full.slice(0, 10).map((p) => p.id));
  check(top10.has("2611.22947") && top10.has("2611.21917"), "B: KRC + Lost-Heads are in the top 10 (the read cut)");
  ok(`B: InfuseLoop rank ${full.findIndex((p) => p.id === "2611.22426") + 1}, SpecSearch rank ${full.findIndex((p) => p.id === "2611.22296") + 1} — below the top-10 read cut (known; see test header)`);
} else {
  ok(`B: SKIP — fixture not present at ${FIXTURE}`);
}

// --- C/D. Judge handler through a real DirectAdapter ---
const adapter = new DirectAdapter();
adapter.registerWorker("briefing-judge-consequence", WORKER);
const ctx = { runId: "bra124-test", trapId: "t1", ordinal: 0 };

const papers = [
  { id: KRC.id, title: "The Kernel Reality Check", score: KRC.score },
  { id: LOST.id, title: "Lost in a Few Heads", score: LOST.score },
  { id: LOOPZIP.id, title: "LoopZip", score: LOOPZIP.score },
];
const judgments = [
  { id: KRC.id, consequence: 8, reasons: "Benchmarks kernelized attention vs FlashAttention at scale; FlashAttention is faster and lower-memory, contradicting the core assumption.", evidence: "FlashAttention achieves lower memory consumption and faster wall-clock time than SOTA kernelized methods." },
  { id: LOST.id, consequence: 8, reasons: "Sparse attention's long-context failure is a selector bug in three blind heads, not a budget problem; full attention in those heads recovers most of the loss.", evidence: "We show that the selector under-ranks the needle rather than running out of budget." },
  { id: LOOPZIP.id, consequence: 4, reasons: "Training-free visual token compression for looped VLMs; a solid method improvement, additive.", evidence: "LoopZip retains 97.16% of the original model's performance at 50% pruning ratio." },
];

const resInline: any = adapter.answer("job", { spec: "briefing-judge-consequence", input: { papers, judgments } }, ctx);
check(resInline !== "HOLD" && resInline.value?.ok === true, `C: handler returns ok:true for inline judgments (got ${JSON.stringify(resInline).slice(0, 160)})`);
if (resInline !== "HOLD" && resInline.value?.ok) {
  const scores = resInline.value.scores;
  check(scores.length === 3, `C: handler returns 3 scores (got ${scores.length})`);
  check(scores[0].id === KRC.id && scores[0].consequence === 8, `C: first score is KRC consequence 8 (got ${scores[0]?.id}=${scores[0]?.consequence})`);
  check(scores[2].id === LOOPZIP.id && scores[2].consequence === 4, `C: third score is LoopZip consequence 4 (got ${scores[2]?.id}=${scores[2]?.consequence})`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bra124-"));
const judgmentsPath = path.join(tmpDir, "judgments.json");
fs.writeFileSync(judgmentsPath, JSON.stringify({ scores: judgments }, null, 1));
const resPath: any = adapter.answer("job", { spec: "briefing-judge-consequence", input: { papers, judgmentsPath } }, ctx);
check(resPath !== "HOLD" && resPath.value?.ok === true, `C: handler returns ok:true for judgmentsPath (got ${JSON.stringify(resPath).slice(0, 160)})`);
if (resPath !== "HOLD" && resPath.value?.ok) {
  check(resPath.value.scores[1].id === LOST.id && resPath.value.scores[1].consequence === 8, "C: judgmentsPath scores carry Lost-Heads consequence 8");
}

const resNone: any = adapter.answer("job", { spec: "briefing-judge-consequence", input: { papers } }, ctx);
check(
  resNone !== "HOLD" && resNone.value?.ok === false && /no LLM judge available/.test(resNone.value?.error ?? ""),
  `D: no judgments -> ok:false naming the missing judge (got ${JSON.stringify(resNone).slice(0, 200)})`,
);

const resPartial: any = adapter.answer(
  "job",
  { spec: "briefing-judge-consequence", input: { papers, judgments: judgments.slice(0, 2) } },
  ctx,
);
check(
  resPartial !== "HOLD" && resPartial.value?.ok === false && /no verdict for 1 paper/.test(resPartial.value?.error ?? ""),
  `D: incomplete coverage -> ok:false naming the missing paper (got ${JSON.stringify(resPartial).slice(0, 200)})`,
);

const resBadRange: any = adapter.answer(
  "job",
  { spec: "briefing-judge-consequence", input: { papers, judgments: [{ id: KRC.id, consequence: 11, reasons: "x" }, judgments[1], judgments[2]] } },
  ctx,
);
check(
  resBadRange !== "HOLD" && resBadRange.value?.ok === false && /out of range/.test(resBadRange.value?.error ?? ""),
  `D: consequence 11 -> ok:false out of range (got ${JSON.stringify(resBadRange).slice(0, 200)})`,
);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (FAILURES.length > 0) {
  console.log(`\ntest-bra124: ${FAILURES.length} FAILURE(S)`);
  process.exit(1);
}
console.log("\ntest-bra124: ALL CHECKS PASSED");
