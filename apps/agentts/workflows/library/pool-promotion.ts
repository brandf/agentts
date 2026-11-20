// pool-promotion — abstract-informed pooling supplement for briefing
// discovery (BRA-124). Pure functions, no traps: discover() in
// workflows/dogfood/briefing-worker.ts fetches and scores; the
// selection here is pure and unit-tested in tests/test-bra124-pool.ts.
//
// THE POOLING GAP. List-sourced discover candidates are TITLE-scored
// (the list pages carry no abstract), so a paper whose title scores
// <= 2 but whose abstract is topic-strong never reaches the pool.
// Nov 18, 2026: TPHC (2611.23026) title 0 / abstract 7 and Gemma 4
// K=V Cache (2611.23035) title 2 / abstract 4 were both in the cron's
// edition and neither was in the trial pool. The second pass fetches
// abstracts for the most recent title-low fresh candidates and
// promotes the abstract-strong ones — as a SUPPLEMENT to the judge's
// input, not by displacing pool picks.
//
// WHY A SUPPLEMENT, NOT DISPLACEMENT (measured on the real Nov 18
// data — see tests/test-bra124-pool.ts §D). Displacement was the
// first design: promote into the pool by ejecting the lowest
// title-scored top-K picks. It fails on the real data: the pool has
// NO disposable picks. The 8 lowest top-K picks are all title-6
// papers, and THREE of them (2611.22241, 2611.22612, 2611.22853) are
// in the judged top 8 (consequence 7 each) — displacing them for
// unjudged abstract-strong papers trades known-consequential papers
// for unknowns. The diversity fill's tail is no better: its
// title-4 picks include 2611.22186 (selected, consequence 7) and
// SpecSearch (judged #18). So the supplement: the pool stays 40,
// the judge sees pool + up to 8 abstract-strong papers, and the
// judge's consequence ranking decides whether any of them makes the
// edition. The supplement can only ADD to the edition, never remove.
//
// KNOWN LIMIT — the pinned regression is NOT closed by abstract
// topic scoring (measured, not assumed). On the real Nov 18 data,
// ranked by abstract score, TPHC (7) is #21 of 150 and Gemma (4) is
// #67 — both below the PROMOTE_MAX=8 cap, and Gemma is below the
// PROMOTE_MIN_ABSTRACT_SCORE=7 floor. No threshold, top-K,
// per-topic, or recency-ranked abstract-topic-score rule that fits
// 8 supplement slots promotes either of them (a threshold <= 4
// admits 76 papers; a top-K by abstract score takes 14..9). The
// signal that DOES separate them is measurement density (the read
// step's number-sentence count): Gemma ranks #2 of 150 and TPHC #19
// — but that is a second signal, and the brief forbids inventing a
// second scoring scheme, so it is NOT baked in here. It is the
// follow-up decision: see the BRA-124 report. The test pins this
// limit explicitly (TPHC and Gemma are NOT promoted) so a future
// change that does promote them must update the test deliberately.

/** One candidate as discover() / parseAtom() produce it. Only the
 * fields the selection needs are required; the rest ride through. */
export interface AbstractScoredCandidate {
  id: string;
  title: string;
  authors: string;
  submitted: string;
  categories: string;
  abstract: string;
  /** Keyword topic score — title-only for list-sourced candidates,
   * abstract-informed for API/parseAtom candidates. */
  score: number;
  topics: string[];
  reason: string;
}

/** Title score at or below which a fresh candidate is "title-low"
 * and eligible for the abstract fetch. Nov 18: 1743 of 1993 fresh
 * papers (87%) score <= 2 — the fetch bound below, not this
 * threshold, is what keeps the second pass bounded. */
export const TITLE_LOW_MAX_SCORE = 2;

/** Max title-low candidates whose abstracts the second pass fetches,
 * most recent first. Nov 18: both pinned papers sit at recency
 * ranks 70-72 of the title-low set, so 150 carries ~78 papers of
 * margin against day-to-day rank shifts. */
export const ABSTRACT_FETCH_MAX_IDS = 150;

/** arXiv API id_list batch size: 150 ids = 2 calls (100 + 50). */
export const ABSTRACT_FETCH_BATCH_IDS = 100;

/** Abstract-score floor for promotion. Calibrated on Nov 18: TPHC
 * (the paper this pass exists to rescue) scores exactly 7, so the
 * floor is set AT the level a real architecture paper with
 * measurements clears — a higher bar would exclude the very class
 * of paper the pass exists for. The floor is a gate, not the
 * selector: the cap + abstract-score ranking select (see
 * selectSupplement). On Nov 18 the top 8 by abstract score are all
 * >= 9, so the floor binds only on quiet days. */
export const PROMOTE_MIN_ABSTRACT_SCORE = 7;

/** Max papers the supplement adds to the judge's input (20% of a
 * 40-paper pool). The judge judges pool + supplement, so this also
 * bounds the extra judge verdicts per edition. */
export const PROMOTE_MAX = 8;

/**
 * Pick the title-low fresh candidates whose abstracts the second
 * pass fetches: score <= TITLE_LOW_MAX_SCORE, not already in the
 * pool, most recent first (submitted desc, then id desc — the
 * higher id is the later submission within a day), capped at
 * maxIds. Pure: takes the fresh list and the picked ids, returns
 * the fetch ids in fetch order.
 */
export function selectAbstractFetch(
  fresh: Pick<AbstractScoredCandidate, "id" | "score" | "submitted">[],
  pickedIds: ReadonlySet<string>,
  maxIds: number = ABSTRACT_FETCH_MAX_IDS,
): string[] {
  const low = fresh.filter((c) => c.score <= TITLE_LOW_MAX_SCORE && !pickedIds.has(c.id));
  low.sort((a, b) => b.submitted.localeCompare(a.submitted) || b.id.localeCompare(a.id));
  return low.slice(0, maxIds).map((c) => c.id);
}

/**
 * Pick the supplement: abstract-scored candidates (from parseAtom,
 * so `score` is the abstract-informed topicScore) that are NOT
 * already in the pool and clear PROMOTE_MIN_ABSTRACT_SCORE,
 * ranked by abstract score desc (ties by id asc), capped at
 * maxPromote. Returns the supplement candidates in rank order.
 * The pool is never modified here — the caller appends the
 * supplement to the judge's input.
 */
export function selectSupplement(
  abstractScored: AbstractScoredCandidate[],
  poolIds: ReadonlySet<string>,
  maxPromote: number = PROMOTE_MAX,
  minAbstractScore: number = PROMOTE_MIN_ABSTRACT_SCORE,
): AbstractScoredCandidate[] {
  const eligible = abstractScored.filter((c) => !poolIds.has(c.id) && c.score >= minAbstractScore);
  eligible.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return eligible.slice(0, maxPromote);
}
