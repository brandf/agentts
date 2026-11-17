// BRA-89 test workflow (briefing adapter): an exec trap (writes a
// marker, sleeps in the shell so the drive can be stranded
// mid-dispatch), then a briefing-discover job served by
// workflows/briefing-worker.ts through the briefing adapter's
// DirectAdapter. The discover step does live arXiv fetches, so this
// workflow is refusal-only in the test: the pin check fires before
// the worker ever runs, and no control leg executes it. The test
// edits briefing-worker.ts mid-run and restores the original in a
// finally block.
import { exec, job } from "../../src/agentts";

interface Bra89BriefingInput {
  markerFile: string;
  sleepMs: number;
  seenPath: string;
  endDate: string;
}

interface PaperCandidate {
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

interface DiscoveryInput {
  seenPath: string;
  windowDays: number;
  maxResults: number;
  categories: string[];
  endDate: string;
}

interface DiscoveryResult {
  ok: boolean;
  error: string;
  candidates: PaperCandidate[];
  excludedSeen: string[];
  scanned: number;
  freshCount: number;
  windowStart: string;
  windowEnd: string;
  source: string;
  apiStatus: number;
  earliestScanned: string;
}

export interface RunResult {
  marker: string;
  ok: boolean;
  candidateCount: number;
}

export default function run(input: Bra89BriefingInput): RunResult {
  const r = exec({
    cmd: "sh",
    args: ["-c", `echo bra89-original >> "${input.markerFile}" && sleep ${Math.floor(input.sleepMs / 1000)} && echo done`],
  });
  const d = job<DiscoveryInput, DiscoveryResult>({
    spec: "briefing-discover",
    input: {
      seenPath: input.seenPath,
      windowDays: 7,
      maxResults: 7,
      categories: ["cs.LG"],
      endDate: input.endDate,
    },
  });
  return {
    marker: r.stdout.trim() === "done" ? "original" : "unexpected",
    ok: d.ok,
    candidateCount: d.candidates.length,
  };
}
