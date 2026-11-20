#!/usr/bin/env bun
/**
 * Unit tests for the BRA-124 abstract-informed pooling supplement
 * (workflows/library/pool-promotion.ts). Direct in-process calls:
 * no engine, no adapter, no clock, no CLI, no server, no network.
 * Exit 0 on PASS, 1 on any mismatch.
 *
 * Fixtures are REAL Nov 18, 2026 data (tests/fixtures/bra124-pool.json):
 * the 40-paper trial pool (reproduced exactly by discover()'s
 * algorithm), the 200 most-recent title-low fresh papers, and the
 * 150 abstract-scored papers from the arXiv API id_list fetch.
 *
 * The design under test is the SUPPLEMENT, not displacement (see
 * pool-promotion.ts and §D below for why displacement was rejected).
 *
 * Two honest limits, pinned here rather than papered over:
 *  - TPHC (2611.23026) and Gemma 4 K=V Cache (2611.23035) are NOT
 *    promoted by abstract topic scoring (§C): TPHC's abstract score
 *    (7) ranks #21 of 150 and Gemma's (4) ranks #67, both below
 *    the PROMOTE_MAX=8 cap, and Gemma is below the floor of 7. The
 *    pinned regression is NOT closed by this pass; the signal that
 *    does separate them (measurement density — the read step's
 *    number-sentence count: Gemma #2 of 150, TPHC #19) is a second
 *    signal the brief forbids inventing, so it is the follow-up
 *    decision, not a silent bake-in. See the BRA-124 report.
 *  - The supplement's effect on the edition is NOT proven by this
 *    file: it proves the selection mechanics only. Whether the 8
 *    promoted papers make the edition is the judge's call (their
 *    consequence scores are unknown until judged) — the supplement
 *    trial (extended judgments file, pool + supplement judged
 *    together) is the end-to-end proof, and it is reported
 *    separately, not asserted here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  selectAbstractFetch,
  selectSupplement,
  TITLE_LOW_MAX_SCORE,
  ABSTRACT_FETCH_MAX_IDS,
  PROMOTE_MIN_ABSTRACT_SCORE,
  PROMOTE_MAX,
  type AbstractScoredCandidate,
} from "../workflows/library/pool-promotion";
import { combinedScore } from "../workflows/library/consequence-rank";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(DIR, "fixtures", "bra124-pool.json"), "utf8"),
) as {
  pool: { id: string; title: string; score: number; submitted: string; topics: string[]; fromTopK: boolean }[];
  fetchCandidates: { id: string; score: number; submitted: string }[];
  abstractScored: { id: string; title: string; ascore: number; tscore: number; submitted: string; abstract: string }[];
};

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
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const POOL_IDS = new Set(FIXTURE.pool.map((p) => p.id));
const TPHC = "2611.23026";
const GEMMA = "2611.23035";
// The 8 promoted papers, by abstract score desc (ties by id asc).
const TOP8 = [
  "2611.22879", // SlideJev, ascore 14
  "2611.22826", // OICycle, ascore 13
  "2611.23228", // Spool, ascore 13
  "2611.22769", // ForceBody, ascore 11
  "2611.23127", // Illusion of Grounding, ascore 11
  "2611.22790", // NexSight, ascore 10
  "2611.22854", // WATERFALL, ascore 10
  "2611.23115", // Nunchi, ascore 9
];

// ------------------------------------------------------- A: fetch set (real Nov 18 data)
{
  const ids = selectAbstractFetch(FIXTURE.fetchCandidates, POOL_IDS, ABSTRACT_FETCH_MAX_IDS);
  check(
    ids.length === 150,
    `A FETCH-COUNT OK: the second pass fetches exactly ${ABSTRACT_FETCH_MAX_IDS} abstracts (got ${ids.length})`,
  );
  check(
    same(ids, FIXTURE.fetchCandidates.slice(0, 150).map((c) => c.id)),
    "A FETCH-ORDER OK: the fetch set is the 150 most recent title-low papers, in recency order (submitted desc, id desc)",
  );
  check(
    ids.includes(TPHC) && ids.includes(GEMMA),
    `A PINNED-IN-FETCH OK: TPHC (${TPHC}) at recency rank 72 and Gemma (${GEMMA}) at recency rank 70 are both inside the 150 fetch bound`,
  );
  check(
    ids[149] === "2611.22721",
    `A FETCH-BOUNDARY OK: the 150th fetched paper is 2611.22721 (submitted 2026-11-18, title score 2) — the bound, not the data, cuts the list`,
  );
  check(
    FIXTURE.fetchCandidates.every((c) => c.score <= TITLE_LOW_MAX_SCORE),
    `A TITLE-LOW OK: every fetch candidate scores <= ${TITLE_LOW_MAX_SCORE} on title alone`,
  );
  check(
    FIXTURE.pool.every((p) => p.score > TITLE_LOW_MAX_SCORE),
    "A POOL-DISJOINT OK: on Nov 18 the pool (title scores 4-10) and the fetch set (title scores 0-2) are disjoint — no pool paper is re-fetched",
  );
}

// ------------------------------------------------------- B: fetch-selection rules (small, real ids)
{
  const fresh = [
    { id: "2611.23229", score: 0, submitted: "2026-11-18" }, // most recent, title 0
    { id: TPHC, score: 0, submitted: "2026-11-18" },
    { id: GEMMA, score: 2, submitted: "2026-11-18" },
    { id: "2611.22947", score: 8, submitted: "2026-11-18" }, // KRC — not title-low
    { id: "2611.29999", score: 0, submitted: "2026-11-18" }, // synthetic: title-low AND in the pool
    { id: "2611.22721", score: 2, submitted: "2026-11-17" }, // older day — last by recency
  ];
  const picked = new Set(["2611.29999"]);
  const all = selectAbstractFetch(fresh, picked, 10);
  check(
    same(all, ["2611.23229", GEMMA, TPHC, "2611.22721"]),
    "B RULES OK: title-low only (KRC score 8 out), pool members out (synthetic 2611.29999 out), most recent first (id desc within a day: 2611.23035 before 2611.23026), older day last",
  );
  check(
    same(selectAbstractFetch(fresh, picked, 2), ["2611.23229", GEMMA]),
    "B CAP OK: maxIds=2 takes the 2 most recent title-low papers",
  );
  check(
    same(selectAbstractFetch(fresh, new Set<string>(), 10), ["2611.29999", "2611.23229", GEMMA, TPHC, "2611.22721"]),
    "B NO-POOL OK: with an empty pool the synthetic paper is fetched first (highest id) — the pool filter, not the score, excluded it above",
  );
}

// ------------------------------------------------------- C: supplement selection (real Nov 18 data)
{
  const scored: AbstractScoredCandidate[] = FIXTURE.abstractScored.map((p) => ({
    id: p.id,
    title: p.title,
    authors: "",
    submitted: p.submitted,
    categories: "",
    abstract: p.abstract,
    score: p.ascore,
    topics: [],
    reason: "",
  }));
  const before = JSON.stringify(scored);
  const supp = selectSupplement(scored, POOL_IDS, PROMOTE_MAX, PROMOTE_MIN_ABSTRACT_SCORE);
  check(
    same(supp.map((c) => c.id), TOP8),
    `C SUPPLEMENT OK: the supplement is exactly the top ${PROMOTE_MAX} by abstract score — ${TOP8.join(", ")} (ascores 14, 13, 13, 11, 11, 10, 10, 9)`,
  );
  check(
    !supp.some((c) => c.id === TPHC) && !supp.some((c) => c.id === GEMMA),
    `C KNOWN-LIMIT OK: TPHC (ascore 7, rank #21 of 150) and Gemma (ascore 4, rank #67) are NOT promoted — abstract topic scoring cannot rescue them; see the header. This is pinned, not hidden.`,
  );
  check(
    !supp.some((c) => POOL_IDS.has(c.id)),
    "C NO-OVERLAP OK: no supplement paper is already in the pool",
  );
  check(
    supp.every((c) => c.abstract.length > 0),
    "C ABSTRACTS OK: every promoted paper carries its real abstract — the judge reads it, it does not re-fetch",
  );
  check(
    !supp.some((c) => c.id === "2611.22733"),
    "C FLOOR OK: 2611.22733 (ascore 6) is below the PROMOTE_MIN_ABSTRACT_SCORE=7 floor and is not promoted",
  );
  check(
    JSON.stringify(scored) === before,
    "C NO-MUTATION OK: selectSupplement does not mutate its input",
  );
  check(
    selectSupplement(scored, POOL_IDS, PROMOTE_MAX, 15).length === 0,
    "C FLOOR-BINDS OK: with a floor of 15 nothing promotes — the floor gates, the cap + ranking select",
  );
}

// ------------------------------------------------------- D: why a supplement, not displacement
{
  // The 8 lowest top-K picks — what a displacement rule would eject.
  const topK = FIXTURE.pool.filter((p) => p.fromTopK);
  const lowest = [...topK]
    .sort((a, b) => a.id.localeCompare(b.id))
    .sort((a, b) => b.submitted.localeCompare(a.submitted))
    .sort((a, b) => a.score - b.score)
    .slice(0, 8)
    .map((p) => p.id);
  check(
    same(lowest, ["2611.22191", "2611.22241", "2611.22434", "2611.22612", "2611.22652", "2611.22666", "2611.22853", "2611.22962"]),
    "D DISPLACEMENT-TARGETS OK: the 8 lowest top-K picks are all title-6 papers — the pool has no weak tail to displace into",
  );
  check(
    ["2611.22241", "2611.22612", "2611.22853"].every((id) => lowest.includes(id)),
    "D DISPLACEMENT-HARM OK: three of those eight (2611.22241, 2611.22612, 2611.22853) are in the judged top 8 (consequence 7 each, per the recorded verdicts) — displacing them for unjudged papers trades known-consequential papers for unknowns. That is why the supplement displaces nobody.",
  );
  const poolBefore = JSON.stringify(FIXTURE.pool.map((p) => p.id));
  const scored: AbstractScoredCandidate[] = FIXTURE.abstractScored.map((p) => ({
    id: p.id, title: p.title, authors: "", submitted: p.submitted, categories: "",
    abstract: p.abstract, score: p.ascore, topics: [], reason: "",
  }));
  selectSupplement(scored, POOL_IDS);
  check(
    JSON.stringify(FIXTURE.pool.map((p) => p.id)) === poolBefore,
    "D POOL-INTACT OK: the supplement leaves the 40-paper pool unchanged — it only adds to the judge's input",
  );
}

// ------------------------------------------------------- E: the supplement is fair (consequence dominates)
{
  check(
    combinedScore(14, 6) === 74 && combinedScore(6, 7) === 76,
    "E FAIRNESS OK: a promoted paper (topic 14) with consequence 6 scores 74 — BELOW a title-pool paper (topic 6) with consequence 7 at 76. The supplement's topic advantage cannot overturn a consequence point.",
  );
  check(
    combinedScore(14, 7) === 84 && combinedScore(8, 7) === 78,
    "E TIEBREAK OK: at equal consequence 7, the promoted paper's topic 14 (84) tips it above a title-pool paper's topic 8 (78) — the topic score does its intended job, tipping within a consequence point, never overturning one.",
  );
}

// ------------------------------------------------------- verdict
if (FAILURES.length > 0) {
  console.log(`\nFAIL bra124-pool unit tests for the abstract-informed pooling supplement (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra124-pool unit tests for the abstract-informed pooling supplement (fetch selection; supplement selection; displacement finding; consequence fairness)");
