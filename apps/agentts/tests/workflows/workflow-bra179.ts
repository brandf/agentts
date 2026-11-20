// BRA-179 test workflow: read a file, then judge its whole text.
// The job INPUT is what crosses argv to the worker spawn — with a
// ~200KB file the payload JSON exceeds Linux's 128KB single-argument
// cap (MAX_ARG_STRLEN) and the spawn fails E2BIG on un-fixed code.
// The exec result crosses back via the BRA-171 file path.
import { exec, job } from "../../src/agentts";

export interface Bra179Input {
  filePath: string;
}

interface JudgeInput {
  item: { text: string };
  rubric: { criteria: string[]; threshold: number };
}
interface JudgeVerdict {
  score: number;
  label: string;
  notes: string;
}
export interface RunResult {
  score: number;
  label: string;
  notes: string;
  textLen: number;
}

export default function run(input: Bra179Input): RunResult {
  const r = exec({ cmd: "cat", args: [input.filePath] });
  const verdict = job<JudgeInput, JudgeVerdict>({
    spec: "judge",
    input: {
      item: { text: r.stdout },
      rubric: { criteria: ["vivid fox", "concrete 42", "concise"], threshold: 0.8 },
    },
  });
  return { score: verdict.score, label: verdict.label, notes: verdict.notes, textLen: r.stdout.length };
}
