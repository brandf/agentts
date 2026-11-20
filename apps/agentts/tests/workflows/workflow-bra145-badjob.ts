import { job } from "../../src/agentts";

/**
 * BRA-145 fixture (bad trap output): one job trap whose declared
 * output schema requires score to be a number. The test registers a
 * worker (via --workers-config) that returns score as a string, so
 * the host's output validation refuses it loudly on the direct path.
 */
declare function print(...args: unknown[]): void;

export interface ScoreIn {
  item: string;
}

export interface Score {
  score: number;
  label: string;
}

export interface In {
  item: string;
}

export interface Out {
  score: number;
}

export default function wf(input: In): Out {
  const s = job<ScoreIn, Score>({ spec: "bra145-score", input: { item: input.item } });
  print("job:", JSON.stringify(s));
  return { score: s.score };
}
