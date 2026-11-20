// workflow-bra124-pooljudge — live pool-judge probe for BRA-124 (Part 4).
// One briefing-judge-consequence job with NO judgmentsPath, through the
// muse adapter: the pool worker judges live (jobspec
// briefing-judge-consequence.md). The three papers are the abstract-pass
// supplement's top three (SlideJev, OICycle, Illusion of Grounding) with
// their real abstracts in the input — they carry NO recorded verdicts in
// the original Nov 18 fixture, so any verdict this run delivers is
// provably new, not the fixture's. (The supplement trial scored them
// separately in the extended judgments file; this probe passes no
// judgmentsPath, so the worker cannot reach any fixture — the judge
// handler fails loudly under the direct adapter without verdicts, and
// under the muse adapter the job goes to the pool.)
//
// Run by the Part 4 driver (~/workspace/bra124-pooljudge-trial.py):
// scratch state dir + throwaway port, a real Muse subagent as the pool
// worker (plugins/muse/WORKER.md loop), CLI submit with --adapter muse
// and AGENTTS_WORKER_SERVER set, tick-standin drives the queue.
// The delivery carries the live verdicts; the journal's trap-result
// carries the workerId naming the worker that judged them.

import { job } from "../../src/agentts";

export interface Bra124PooljudgePaper {
  id: string;
  title: string;
  authors: string;
  submitted: string;
  categories: string;
  abstract: string;
  score: number;
  topics: string[];
  reason: string;
}

export interface Bra124PooljudgeInput {
  papers: Bra124PooljudgePaper[];
}

export interface Bra124PooljudgeVerdict {
  id: string;
  consequence: number;
  reasons: string;
  evidence?: string;
}

export interface Bra124PooljudgeResult {
  ok: boolean;
  error: string;
  scores: Bra124PooljudgeVerdict[];
}

export interface Bra124PooljudgeOutput {
  ok: boolean;
  scores: Bra124PooljudgeVerdict[];
}

export default function bra124Pooljudge(input: Bra124PooljudgeInput): Bra124PooljudgeOutput {
  const judged = job<Bra124PooljudgeInput, Bra124PooljudgeResult>({
    spec: "briefing-judge-consequence",
    input: { papers: input.papers },
  });
  if (!judged.ok) {
    throw new Error(`bra124 pooljudge failed: ${judged.error}`);
  }
  return { ok: true, scores: judged.scores };
}
