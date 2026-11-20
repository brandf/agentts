// BRA-171 test workflow: a job trap whose answer is a large value; the
// workflow returns (and prints) the value's length. The VALUE is what
// crosses argv to the C host on resume — with a ~200KB label it
// exceeds Linux's 128KB single-argument cap (MAX_ARG_STRLEN) and the
// resume spawn fails E2BIG on un-fixed code.
declare function trap<Input, Output>(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

export interface ScoreInput {
  op: string;
}
export interface ScoreResult {
  score: number;
  label: string;
}
export interface RunResult {
  labelLen: number;
  score: number;
}

export default function run(): RunResult {
  const r = trap<ScoreInput, ScoreResult>("job", { op: "score" }) as ScoreResult;
  print("labelLen:", r.label.length);
  print("score:", r.score);
  return { labelLen: r.label.length, score: r.score };
}
