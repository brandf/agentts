// consequence-rank — consequence-led ranking for briefing discovery
// (BRA-124). Pure functions, no traps: the workflow imports this and
// the regression test imports it directly.
//
// The problem it solves: keyword topicScore measures topic COVERAGE
// (distinct terms, capped 3/topic), so broad vision abstracts score
// 14-21 while focused consequential papers score 4-9. Consequence is
// not visible to keyword scoring — title or abstract. The LLM judge
// (jobspec briefing-judge-consequence) reads each abstract and scores
// CONSEQUENCE 0-10:
//
//   0-2  incremental method/variation; no existing claim tested;
//        results self-referential (beats its own baseline on its own
//        benchmark).
//   3-4  solid method or measurement; additive — does not challenge
//        or change any existing claim.
//   5-6  measures/compares against existing work in a way that
//        constrains what is true (benchmark, careful ablation,
//        profiling) — narrows the space without overturning anything.
//   7-8  overturns, corrects, or relocates an existing claim — a
//        benchmark audit showing a widely-used method does not do what
//        is claimed; a diagnosis showing a failure lives elsewhere
//        than assumed; a failed replication; a fix to a widely-used
//        component.
//   9-10 changes what the field should build or believe at scale — a
//        result that invalidates a research direction or reorders
//        priorities across many papers.
//
// Calibration: most papers score 3-6; 8+ is rare; 9-10 exceptional.
// The judge must cite the evidence: the specific claim and the
// specific evidence in the abstract.
//
// Combination: the candidate pool is already topic-filtered (score >
// 0, diversity fill by topic), so consequence LEADS and topicScore
// breaks near-ties: combined = consequence * 10 + topicScore.
// Consequence spans 0-100, topicScore 0-21, so topic can only tip a
// ranking when two papers are within ~2 consequence points of each
// other. A paper with no consequence score (unjudged) sorts by
// topicScore alone, below every judged paper — the workflow treats
// a missing verdict as a loud failure, so this is a fallback only,
// never a silent path.

export interface ConsequenceScored {
  id: string;
  /** Keyword topic score (topicScore). */
  score: number;
  /** LLM-judge consequence score 0-10, or null when unjudged. */
  consequence: number | null;
}

/** Combined rank: consequence-led, topicScore as tiebreak. */
export function combinedScore(topicScore: number, consequence: number | null): number {
  if (consequence === null || consequence === undefined) return topicScore;
  return consequence * 10 + topicScore;
}

/** Sort highest-combined first; ties break by id (deterministic). */
export function rankByConsequence<T extends ConsequenceScored>(items: T[]): T[] {
  return [...items].sort(
    (a, b) =>
      combinedScore(b.score, b.consequence) - combinedScore(a.score, a.consequence) ||
      a.id.localeCompare(b.id),
  );
}

/** One read paper, for the must-read ranking (BRA-130). The
 * consequence is optional here (a read may not carry one) — rankReads
 * throws loudly on such an item rather than ranking it. Standalone
 * shape (not extending ConsequenceScored): PaperRead carries
 * `consequence?` as an optional property, which is not assignable to
 * a required one. */
export interface RankedRead {
  id: string;
  /** Keyword topic score (topicScore). */
  score: number;
  /** LLM-judge consequence score 0-10, absent when unjudged. */
  consequence?: number | null;
  /** Numbers extracted by the read (count only — see compareReads). */
  numbers: string[];
  /** Whether ar5iv served full text for this paper. */
  fullText: boolean;
}

/** Order two read papers for the must-read pick (BRA-130).
 * Consequence-led and NOTHING else can overturn it: combinedScore
 * orders first; numbers and fullText are TIEBREAKS only — they order
 * papers with equal combined scores and can never overturn a
 * consequence point (the old rankScore added up to 6 bonus points on
 * top of the combined score, so a consequence-7 paper with 5 numbers
 * and full text beat a consequence-8 paper with none — the exact
 * failure BRA-130 was filed for). Final tiebreak is id, ascending,
 * so the order is fully deterministic.
 *
 * LOUD on unjudged input: a read without a numeric consequence
 * throws naming the paper, instead of silently falling back to a
 * topic-fit score (the old `score * 10` branch). The judge fails
 * loudly upstream on missing verdicts and the read passes
 * consequence through untouched, so this is unreachable in
 * practice — but a silent topic-fit fallback in the must-read path
 * is the wrong shape, and the throw is the pin that proves it. */
export function compareReads(a: RankedRead, b: RankedRead): number {
  if (typeof a.consequence !== "number") {
    throw new Error(
      `rankReads: read ${a.id} has no consequence score — unjudged reads cannot be ranked (the judge fails loudly upstream; a missing consequence here means the read dropped it, see BRA-130)`,
    );
  }
  if (typeof b.consequence !== "number") {
    throw new Error(
      `rankReads: read ${b.id} has no consequence score — unjudged reads cannot be ranked (the judge fails loudly upstream; a missing consequence here means the read dropped it, see BRA-130)`,
    );
  }
  return (
    combinedScore(b.score, b.consequence) - combinedScore(a.score, a.consequence) ||
    b.numbers.length - a.numbers.length ||
    Number(b.fullText) - Number(a.fullText) ||
    a.id.localeCompare(b.id)
  );
}

/** Rank read papers for the must-read pick, highest first (BRA-130).
 * Returns a sorted copy; throws on any unjudged read (see
 * compareReads). The must-read is element [0]. Validation is an
 * explicit loop up front: a one-element array never calls the sort
 * comparator, so validation cannot live in compareReads alone. */
export function rankReads<T extends RankedRead>(items: T[]): T[] {
  for (const item of items) {
    if (typeof item.consequence !== "number") {
      throw new Error(
        `rankReads: read ${item.id} has no consequence score — unjudged reads cannot be ranked (the judge fails loudly upstream; a missing consequence here means the read dropped it, see BRA-130)`,
      );
    }
  }
  return [...items].sort(compareReads);
}
