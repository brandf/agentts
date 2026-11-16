// Wrong-shape result through the worker pool (BRA-48): one job
// whose worker returns valid JSON in the wrong shape. The queue
// server accepts it (it is JSON); the host's trap boundary must
// reject it with a ValidationError at the call site, and the run
// fails — proving the boundary is enforced host-side, never by
// trusting the worker.

import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface JudgeInput {
  item: { text: string; goal: string };
  rubric: { criteria: string[]; threshold: number };
  judge: number;
}

interface JudgeVerdict {
  score: number;
  label: string;
  notes: string;
}

const v = job<JudgeInput, JudgeVerdict>({
  spec: "bad-shape",
  input: {
    item: { text: "The quick brown fox jumps over the lazy dog.", goal: "A vivid opening." },
    rubric: { criteria: ["vivid", "concrete", "concise"], threshold: 0.8 },
    judge: 0,
  },
});
print("verdict:", JSON.stringify(v));
print("done");
