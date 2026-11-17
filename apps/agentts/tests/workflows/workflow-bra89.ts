// BRA-89 test workflow (direct adapter): an exec trap (writes a
// marker, sleeps in the shell so the drive can be stranded
// mid-dispatch), then a JFL judge job served by workflows/worker.ts,
// then a decide served by src/decision-model.ts. The item text
// addresses NONE of the rubric criteria (33 words, so not concise;
// no vivid word; no number or concrete noun), so the original
// worker scores 0 and the original decision model answers "revise"
// (mean 0 < threshold 0.8). The test edits worker.ts /
// decision-model.ts / the judge jobspec mid-run and restores the
// originals in a finally block.
import { exec, job, decide } from "../../src/agentts";

interface Bra89Input {
  markerFile: string;
  sleepMs: number;
}

interface JudgeItem {
  text: string;
  goal: string;
}

interface JudgeRubric {
  criteria: string[];
  threshold: number;
}

interface JudgeInput {
  item: JudgeItem;
  rubric: JudgeRubric;
  judge: number;
}

interface JudgeVerdict {
  score: number;
  label: string;
  notes: string;
}

interface DecideOut {
  choice: string;
  confidence: number;
}

export interface RunResult {
  marker: string;
  judgeScore: number;
  decision: string;
}

const ITEM_TEXT =
  "The committee discussed the proposal at length while members considered various aspects of the matter before them and eventually agreed to postpone any decision until another session could be arranged for further review.";

export default function run(input: Bra89Input): RunResult {
  const r = exec({
    cmd: "sh",
    args: ["-c", `echo bra89-original >> "${input.markerFile}" && sleep ${Math.floor(input.sleepMs / 1000)} && echo done`],
  });
  const verdict = job<JudgeInput, JudgeVerdict>({
    spec: "judge",
    input: {
      item: { text: ITEM_TEXT, goal: "test" },
      rubric: { criteria: ["vivid", "concrete", "concise"], threshold: 0.8 },
      judge: 0,
    },
  });
  const d = decide<DecideOut>({
    question: `mean score ${verdict.score} threshold 0.8: converge or revise?`,
    options: ["converge", "revise"],
  });
  return {
    marker: r.stdout.trim() === "done" ? "original" : "unexpected",
    judgeScore: verdict.score,
    decision: d.choice,
  };
}
