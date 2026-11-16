// daily-ai-briefing — the daily AI research briefing as an AgentTS
// workflow (BRA-55, Phase 2 use case (a)). A real edition end to end
// through the real engine: arXiv discovery, parallel full-text reads,
// dedupe against a COPY of the seen list, computed prior-work
// relations, must-read selection by decide trap, rendered markdown +
// meta.json, a JudgeFixLoop structural polish over the draft, and the
// weekly HTML page via the existing builder — all into scratch.
//
// TEST RUN ONLY: the edition is dated 2026-11-16 and marked TEST in
// its scope note; every output lands under
// .agentts-scratch/briefing-test-2026-11-16 (relative to the host cwd).
// The live briefing files and the live seen list are only ever read.
// Run from the host root (agentts-host, or staged apps/agentts):
//   bun src/cli.ts run workflows/daily-ai-briefing.ts --adapter briefing \
//       --state-dir <scratch-state-dir>
// Mock mode (gate/swap checks, fixture data, no files written):
//   AGENTTS_BRIEFING_MOCK=1 bun src/cli.ts run workflows/daily-ai-briefing.ts \
//       --adapter briefing --state-dir <scratch-state-dir>
//
// Design notes (deviations from the task sketch, with reasons):
// - Discovery reads arxiv.org/list past-week pages, not the arXiv API:
//   export.arxiv.org 429s on this VM's shared egress IP, while the
//   list pages answer in ~1s. Candidates are title-scored here and
//   re-scored with the abstract at read time.
// - No gate: no step here needs a human decision. The must-read is a
//   decide trap, not a gate; the v0 decision model ratifies the
//   score-ordered leader (it cannot reason over paper IDs — see
//   BRA-55). Real semantic judging awaits BRA-48 subagent workers.
// - JudgeFixLoop polishes the draft as a STRUCTURAL check (all five
//   subsections present, real numbers present); its fix step can only
//   append revision markers, not write missing sections (BRA-44
//   worker limitation) — the loop's value here is the check + journal.

import { job, exec, decide, all, type Outcome } from "../src/agentts";
import {
  judgeFixLoop,
  type AggregateScore,
  type JudgeVerdict,
  type LoopDecision,
} from "./judge-fix-loop";
import { PRIOR_WORK, type PriorWorkEntry } from "./briefing-prior-work";

declare function print(...args: unknown[]): void;

// ---------------------------------------------------------------- types
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

interface ReadInput {
  paper: PaperCandidate;
}

interface PaperRead {
  ok: boolean;
  error: string;
  id: string;
  title: string;
  authors: string;
  submitted: string;
  abstract: string;
  numbers: string[];
  method: string[];
  caveats: string[];
  topics: string[];
  score: number;
  fullText: boolean;
  readChars: number;
  absUrl: string;
  htmlUrl: string;
}

interface RelatePaper {
  id: string;
  title: string;
  abstract: string;
  authors: string;
  topics: string[];
}

interface RelateInput {
  paper: RelatePaper;
  priorWork: PriorWorkEntry[];
}

interface PaperRelation {
  priorId: string;
  priorTitle: string;
  priorDate: string;
  basis: string;
  note: string;
}

interface RelateResult {
  paperId: string;
  relations: PaperRelation[];
  threadNote: string;
}

interface RenderPaper {
  id: string;
  title: string;
  authors: string;
  submitted: string;
  abstract: string;
  numbers: string[];
  method: string[];
  caveats: string[];
  relations: PaperRelation[];
  threadNote: string;
  topics: string[];
  fullText: boolean;
}

interface RenderInput {
  date: string;
  dateLabel: string;
  papers: RenderPaper[];
  mustReadId: string;
  scopeNote: string;
}

interface EditionMeta {
  date: string;
  must_read: string;
  papers: string[];
  slug: string;
  title: string;
}

interface RenderResult {
  markdown: string;
  meta: EditionMeta;
  paperCount: number;
  mustReadId: string;
}

interface WriteInput {
  markdown: string;
  meta: EditionMeta;
  outDir: string;
  date: string;
}

interface WriteResult {
  ok: boolean;
  error: string;
  markdownPath: string;
  metaPath: string;
  bytes: number;
}

// JudgeFixLoop contracts (same shapes as the BRA-44 test workflow).
interface WorkItem {
  text: string;
  goal: string;
}

interface Rubric {
  criteria: string[];
  threshold: number;
}

interface JudgeInput {
  item: WorkItem;
  rubric: Rubric;
  judge: number;
}

interface AggregateInput {
  verdicts: JudgeVerdict[];
  failed: number;
  threshold: number;
}

interface FixInput {
  item: WorkItem;
  rubric: Rubric;
  verdicts: JudgeVerdict[];
}

interface RubricUpdateInput {
  rubric: Rubric;
  verdicts: JudgeVerdict[];
}

// ---------------------------------------------------------------- config
const EDITION_DATE = "2026-11-16";
const DATE_LABEL = "Monday, November 16, 2026";
const SCRATCH = ".agentts-scratch/briefing-test-2026-11-16";
const SEEN_COPY = `${SCRATCH}/seen-copy.md`;
const FILES_DIR = `${SCRATCH}/files`;
const CATEGORIES = ["cs.LG", "cs.CL", "cs.CV", "cs.AI", "stat.ML", "cs.NE"];
const WINDOW_DAYS = 7;
const READ_COUNT = 12;
const SELECT_COUNT = 7;
// The live venv python (the only interpreter with the `markdown`
// module the builder needs). Machine-specific; this is a dogfood run.
const VENV_PYTHON =
  "/home/hatch/workspace/goals/daily-ai-research-briefing/hidden_files/.venv/bin/python";

// ---------------------------------------------------------------- run
// 1. Scratch setup (exec): copy the seen list + builder into scratch.
const prep = exec({ cmd: "bun", args: ["workflows/briefing-prep.ts", SCRATCH] });
print("prep:", JSON.stringify(prep));
if (prep.exitCode !== 0) {
  throw new Error(`briefing prep failed: ${(prep.stderr ?? "").slice(0, 300)}`);
}

// 2. Discovery (job): scan the window, dedupe vs the seen copy.
const discovery = job<DiscoveryInput, DiscoveryResult>({
  spec: "briefing-discover",
  input: {
    seenPath: SEEN_COPY,
    windowDays: WINDOW_DAYS,
    maxResults: 300,
    categories: CATEGORIES,
    endDate: EDITION_DATE,
  },
});
if (!discovery.ok) {
  throw new Error(`briefing discover failed: ${discovery.error}`);
}
print(
  `discovery: source=${discovery.source} scanned=${discovery.scanned} ` +
    `fresh=${discovery.freshCount} candidates=${discovery.candidates.length} ` +
    `excludedSeen=${discovery.excludedSeen.length} ` +
    `window=${discovery.earliestScanned || discovery.windowStart}..${discovery.windowEnd}`,
);
print(`discovery: excludedSeen sample=${JSON.stringify(discovery.excludedSeen.slice(0, 8))}`);
if (discovery.candidates.length < SELECT_COUNT) {
  throw new Error(
    `briefing discover found only ${discovery.candidates.length} candidates, need ${SELECT_COUNT}`,
  );
}

// 3. Reads in parallel (all): fetch + verify + extract per paper.
const readOutcomes: Outcome<PaperRead>[] = all(
  discovery.candidates.slice(0, READ_COUNT).map(
    (c) =>
      () =>
        job<ReadInput, PaperRead>({ spec: "briefing-read", input: { paper: c } }),
  ),
);
const reads: PaperRead[] = [];
let readFailed = 0;
for (const o of readOutcomes) {
  if (o.ok && o.value.ok) reads.push(o.value);
  else readFailed++;
}
print(`reads: ${reads.length} ok, ${readFailed} failed`);
if (reads.length < 5) {
  throw new Error(`briefing reads: only ${reads.length} papers read, need at least 5`);
}

// Rank by topic score (re-scored with the abstract), then number
// density, then full-text availability — all computed, no judgement.
function rankScore(r: PaperRead): number {
  return r.score * 10 + Math.min(r.numbers.length, 5) + (r.fullText ? 1 : 0);
}
reads.sort((a, b) => rankScore(b) - rankScore(a) || a.id.localeCompare(b.id));
const selected = reads.slice(0, SELECT_COUNT);
print(`selected: ${selected.map((r) => `${r.id}(rank ${rankScore(r)}, ${r.numbers.length} numbers)`).join(", ")}`);

// 4. Prior-work relations in parallel (all): computed against the
// index of delivered editions.
const relateOutcomes: Outcome<RelateResult>[] = all(
  selected.map(
    (r) =>
      () =>
        job<RelateInput, RelateResult>({
          spec: "briefing-relate",
          input: {
            paper: {
              id: r.id,
              title: r.title,
              abstract: r.abstract,
              authors: r.authors,
              topics: r.topics,
            },
            priorWork: PRIOR_WORK,
          },
        }),
  ),
);
const relationsById = new Map<string, RelateResult>();
let relateFailed = 0;
for (const o of relateOutcomes) {
  if (o.ok) relationsById.set(o.value.paperId, o.value);
  else relateFailed++;
}
print(`relate: ${relationsById.size} ok, ${relateFailed} failed`);
for (const r of selected) {
  const rel = relationsById.get(r.id);
  print(`relate ${r.id}: ${(rel?.relations ?? []).length} relations`);
}

// 5. Must-read selection (decide): the v0 decision model ratifies the
// score-ordered leader — options are ordered by rank, so its
// first-option fallback picks the top paper. The ranking is the real
// decision; the trap records it.
const top = selected[0];
const second = selected[1];
const must = decide<LoopDecision>({
  question:
    `must-read selection: top paper ${top.id} score ${rankScore(top)} threshold 50; ` +
    `second paper ${second.id} score ${rankScore(second)}. Which paper is the must-read?`,
  options: [top.id, second.id],
});
print(`must-read decide: ${JSON.stringify(must)}`);
const mustReadId = must.choice === second.id ? second.id : top.id;

// 6. Render (job): dated markdown + meta.json, live format.
const scopeNote =
  `**TEST EDITION — produced by the AgentTS briefing workflow (BRA-55 proof run), not the live 06:15 cron.** ` +
  `Covers arXiv submissions ${discovery.earliestScanned || discovery.windowStart}–${discovery.windowEnd} ` +
  `in ${CATEGORIES.join(", ")}, deduped against a copy of the seen list ` +
  `(${discovery.scanned} papers scanned, ${discovery.excludedSeen.length} seen IDs excluded). ` +
  `All ${selected.length} papers below were verified on their own arXiv abs pages, with full-text reads where ar5iv served the paper; ` +
  `every number and claim is an extracted sentence from the fetched text. The must-read is ${mustReadId}.`;
const renderPapers: RenderPaper[] = selected.map((r) => {
  const rel = relationsById.get(r.id);
  return {
    id: r.id,
    title: r.title,
    authors: r.authors,
    submitted: r.submitted,
    abstract: r.abstract,
    numbers: r.numbers,
    method: r.method,
    caveats: r.caveats,
    relations: rel?.relations ?? [],
    threadNote: rel?.threadNote ?? "",
    topics: r.topics,
    fullText: r.fullText,
  };
});
const rendered = job<RenderInput, RenderResult>({
  spec: "briefing-render",
  input: {
    date: EDITION_DATE,
    dateLabel: DATE_LABEL,
    papers: renderPapers,
    mustReadId,
    scopeNote,
  },
});
print(`render: ${rendered.paperCount} papers, must-read ${rendered.mustReadId}`);

// 7. JudgeFixLoop structural polish over the draft (library reuse).
// Criteria are structural properties the v0 worker can genuinely
// check on the draft text (digits present; each subsection present).
const polished = judgeFixLoop<WorkItem, Rubric>(
  { text: rendered.markdown, goal: `AI research briefing test edition ${EDITION_DATE}` },
  {
    criteria: ["concrete numbers", "how it works", "other work", "limitations", "insights"],
    threshold: 0.8,
  },
  3,
  {
    judge: (item, rubric, judge) =>
      job<JudgeInput, JudgeVerdict>({ spec: "judge", input: { item, rubric, judge } }),
    aggregate: (verdicts, failed) =>
      job<AggregateInput, AggregateScore>({
        spec: "aggregate",
        input: { verdicts, failed, threshold: 0.8 },
      }),
    fix: (item, rubric, verdicts) =>
      job<FixInput, WorkItem>({ spec: "fix", input: { item, rubric, verdicts } }),
    updateRubric: (rubric, verdicts) =>
      job<RubricUpdateInput, Rubric>({ spec: "rubric-update", input: { rubric, verdicts } }),
    decideRevise: (agg, loop) =>
      decide<LoopDecision>({
        question: `loop ${loop}: mean score ${agg.meanScore} threshold 0.8; ${agg.approved} of 3 approved. Should the work item be revised or kept?`,
        options: ["revise", "keep"],
      }),
    decideRubric: (loop, misses) =>
      decide<LoopDecision>({
        question: `loop ${loop}: misses: ${misses} missed criteria across judges; update the rubric if misses >= 2. Should the rubric be updated or kept?`,
        options: ["update", "keep"],
      }),
    decideConverged: (agg, loop, since) =>
      decide<LoopDecision>({
        question: `loop ${loop}: mean score ${agg.meanScore} threshold 0.8, loops since rubric change ${since}. Converged?`,
        options: ["converged", "continue"],
      }),
  },
);
print(
  `polish: loops=${polished.loops} converged=${polished.converged} ` +
    `mean=${polished.lastAggregate?.meanScore ?? "n/a"}`,
);

// 8. Write the edition (job) into scratch files.
const written = job<WriteInput, WriteResult>({
  spec: "briefing-write",
  input: {
    markdown: polished.item.text,
    meta: rendered.meta,
    outDir: FILES_DIR,
    date: EDITION_DATE,
  },
});
if (!written.ok) {
  throw new Error(`briefing write failed: ${written.error}`);
}
print(`written: ${written.markdownPath} (${written.bytes} bytes), ${written.metaPath}`);

// 9. Append to the weekly HTML page + rebuild the index (exec): the
// existing builder, run against scratch only via the live venv python.
const html = exec({
  cmd: VENV_PYTHON,
  args: [`${SCRATCH}/hidden_files/build_briefings_html.py`],
});
print(`html builder: exit=${html.exitCode} stdout=${JSON.stringify(html.stdout.slice(0, 200))}`);
if (html.exitCode !== 0) {
  throw new Error(`briefing html build failed: ${(html.stderr ?? "").slice(0, 300)}`);
}

print(`edition: ${written.markdownPath}`);
print(`week page: ${FILES_DIR}/ai-briefings-week-2026-11-16.html`);
print(`index: ${FILES_DIR}/ai-briefings.html`);
print(`papers: ${rendered.paperCount}, must-read: ${rendered.mustReadId}`);
print("done");
