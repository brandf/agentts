// Generic library fixture for BRA-106: a single-judge scorer
// parameterized by the item type. The trap call lives in the generic
// function; the extractor specializes ScoreIn<X> per instantiation,
// so no callback seam is needed. The mock adapter answers the
// unknown spec "bra106-score" with its default { score: 0.5, label:
// "default" }, which validates against Score.

import { job } from "../../src/agentts";

export interface ScoreIn<X> {
  item: X;
  n: number;
}

export interface Score {
  score: number;
  label: string;
}

export function scoreOne<X>(item: X, n: number): Score {
  return job<ScoreIn<X>, Score>({ spec: "bra106-score", input: { item, n } });
}
