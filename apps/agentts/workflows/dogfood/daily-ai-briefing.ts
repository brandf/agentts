// daily-ai-briefing — the daily AI research briefing as an AgentTS
// workflow (BRA-55, Phase 2 use case (a)). A real edition end to end
// through the real engine: arXiv discovery, parallel full-text reads,
// dedupe against a COPY of the seen list, computed prior-work
// relations, deterministic must-read selection (top of the
// consequence-led ranking, BRA-130), rendered markdown +
// meta.json, a JudgeFixLoop structural polish over the draft, and the
// weekly HTML page via the existing builder — all into scratch.
//
// TEST RUN ONLY: the edition is dated 2026-11-16 and marked TEST in
// its scope note; every output lands under
// .agentts-scratch/briefing-test-2026-11-16 (relative to the host cwd).
// The live briefing files and the live seen list are only ever read.
// Run from the host root (agentts-host, or staged apps/agentts):
//   bun src/cli.ts run workflows/dogfood/daily-ai-briefing.ts --adapter briefing \
//       --input-file <input.json> --state-dir <scratch-state-dir> --wait
// (or without --wait: `run` prints the runId, `queue run` drives it,
// `result <runId>` prints the output JSON). Mock mode (fixture data,
// no files written) is the briefing adapter's AGENTTS_BRIEFING_MOCK=1;
// the workflow's input.mock only marks the edition TEST in its scope
// note. See tests/fixtures/briefing-input.json for a sample input.
//
// Design notes (deviations from the task sketch, with reasons):
// - Discovery reads arxiv.org/list past-week pages, not the arXiv API:
//   export.arxiv.org 429s on this VM's shared egress IP, while the
//   list pages answer in ~1s. Candidates are title-scored here and
//   re-scored with the abstract at read time.
// - No gate: no step here needs a human decision. The must-read is
//   a deterministic pick — the top of the consequence-led ranking
//   (BRA-130). There used to be a decide trap here; it was removed
//   because the v0 decision model cannot judge consequence (it parses
//   machine-readable signals and falls back to the first option), so
//   the trap only ever ratified the leader — a fake step, the r0
//   species (gates always returning true, exec faking success). Real
//   semantic judging of the ranking itself is the LLM consequence
//   judge (BRA-124); the must-read is its top paper.
// - JudgeFixLoop polishes the draft as a STRUCTURAL check (all five
//   subsections present, real numbers present); its fix step can only
//   append revision markers, not write missing sections (BRA-44
//   worker limitation) — the loop's value here is the check + journal.

import { job, exec, all, type Outcome } from "../../src/agentts";
import {
  judgeFixLoop,
  resolveTextBlob,
} from "../library/judge-fix-loop";
import { combinedScore, rankByConsequence, rankReads } from "../library/consequence-rank";
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
  /** LLM-judge consequence 0-10, attached by the judge step. */
  consequence?: number;
  /** Combined consequence-led rank (consequence * 10 + score). */
  combined?: number;
}

interface DiscoveryInput {
  seenPath: string;
  windowDays: number;
  maxResults: number;
  categories: string[];
  endDate: string;
  /** Pre-judge pool size (BRA-124): discovery returns a wider pool
   * than the final candidates so the judge can surface papers the
   * keyword cut would drop. */
  preJudgePool: number;
}

/** One LLM consequence verdict (jobspec briefing-judge-consequence). */
export interface ConsequenceVerdict {
  id: string;
  consequence: number;
  reasons: string;
  evidence?: string;
}

export interface JudgeInput {
  papers: PaperCandidate[];
  /** Trial-only: path to a JSON file of recorded LLM verdicts.
   * Production runs omit it — the pool worker judges live. Under
   * the direct adapter the script fails loudly without verdicts. */
  judgmentsPath?: string;
  judgments?: ConsequenceVerdict[];
}

export interface JudgeResult {
  ok: boolean;
  error: string;
  scores: ConsequenceVerdict[];
}

interface DiscoveryResult {
  ok: boolean;
  error: string;
  candidates: PaperCandidate[];
  /** BRA-124 abstract pass (second pass in discover): the
   * abstract-strong title-low papers promoted as a SUPPLEMENT to
   * the judge's input. The pool itself (candidates) is unchanged.
   * Optional: older/mock discover results carry no supplement and
   * the judge sees the pool alone. */
  abstractPass?: { fetched: number; promoted: PaperCandidate[] };
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
  /** The morning-report rubric text (v0.2). Carried so the read step
   * sees the standard before extracting; the v0 deterministic read
   * worker cannot act on prose yet — contractual in v0 (criterion 9). */
  rubricText?: string;
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
  /** Judge consequence, passed through the read untouched. */
  consequence?: number;
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
  /** The morning-report rubric text (v0.2). The drafter reads the
   * rubric BEFORE drafting (meta-rubric criterion 9); the v0
   * deterministic render worker cannot act on prose yet — contractual
   * in v0, so a real drafter reads it. */
  rubricText?: string;
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

/** The workflow's input (typed params, not env vars or hardcoded
 * constants): the edition date + label, the scratch dir everything
 * lands under, the arXiv window + counts, the venv python for the
 * HTML builder, and mock (true = a TEST edition, marked so in its
 * scope note; the adapter's mock mode is separate — see the header). */
export interface BriefingInput {
  editionDate: string;
  dateLabel: string;
  scratchDir: string;
  windowDays: number;
  readCount: number;
  selectCount: number;
  venvPython: string;
  mock: boolean;
  /** Trial-only: path to recorded LLM consequence verdicts (see
   * JudgeInput). Production runs omit it — the pool judges live. */
  judgmentsPath?: string;
}

export interface BriefingResult {
  editionDate: string;
  mustReadId: string;
  selectedIds: string[];
  markdownPath: string;
  metaPath: string;
  htmlPath: string;
  indexPath: string;
  paperCount: number;
  polishLoops: number;
  polishConverged: boolean;
}

// JudgeFixLoop item/rubric (the loop's trap contracts live in the
// loop itself, parameterized by these — BRA-106). Exported: the
// extractor's specialization alias imports them by name, so they must
// be importable from this file.
export interface WorkItem {
  text: string;
  goal: string;
}

export interface Rubric {
  criteria: string[];
  threshold: number;
}

// ---------------------------------------------------------------- config
/** The Monday of the week containing `dateStr` ("YYYY-MM-DD"), as the
 * weekly HTML builder names its pages: the builder
 * (hidden_files/build_briefings_html.py, `week_monday`) writes
 * `ai-briefings-week-<monday>.html`, where monday is the edition
 * date minus its weekday offset (Python weekday(): Monday=0).
 *
 * (BRA-123: the workflow used to return
 * `ai-briefings-week-<editionDate>.html`, which names a file that
 * does not exist whenever the edition is not a Monday — e.g. the
 * Nov 18, 2026 trial returned `...-2026-11-18.html` while the file
 * on disk is `...-2026-11-16.html`. The Monday is computed here
 * rather than taken from the builder's output: the builder prints
 * only a summary line, so returning its actual path would mean
 * changing the live cron builder's stdout contract. Drift risk: if
 * the builder's week rule ever changes, this must change with it —
 * the test pins the builder's current rule.)
 *
 * UTC throughout: edition dates are plain calendar dates, and local
 * time would shift the weekday near midnight. */
export function weekMonday(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // Monday=0 ... Sunday=6
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

export default function dailyAiBriefing(input: BriefingInput): BriefingResult {
  // Input-derived constants (were hardcoded module-level consts).
  const EDITION_DATE = input.editionDate;
  const DATE_LABEL = input.dateLabel;
  const SCRATCH = input.scratchDir;
  const SEEN_COPY = `${SCRATCH}/seen-copy.md`;
  const FILES_DIR = `${SCRATCH}/files`;
  const CATEGORIES = ["cs.LG", "cs.CL", "cs.CV", "cs.AI", "stat.ML", "cs.NE"];
  const WINDOW_DAYS = input.windowDays;
  const READ_COUNT = input.readCount;
  const SELECT_COUNT = input.selectCount;
  // The live venv python (the only interpreter with the `markdown`
  // module the builder needs). Machine-specific; this is a dogfood run.
  const VENV_PYTHON = input.venvPython;

  // 0. Morning-report rubric (v0.2, reviewed through rubricReview):
  // read the file every day, so edits take effect the next morning
  // with no code change. The text reaches the draft (render) and read
  // steps BEFORE drafting (meta-rubric criterion 9). resolveTextBlob
  // throws loudly if the file is unreadable — the run fails rather
  // than drafting against a rubric that is not there. Direct call
  // (never inside Array.map — traps cannot suspend inside a
  // native-builtin callback, BRA-129).
  const rubricText = resolveTextBlob({
    file: "workflows/rubrics/morning-report-rubric.md",
  });
  print(`rubric: ${rubricText.length} chars from workflows/rubrics/morning-report-rubric.md`);

  // ---------------------------------------------------------------- run
  // 1. Scratch setup (exec): copy the seen list + builder into scratch.
  const prep = exec({ cmd: "bun", args: ["workflows/dogfood/briefing-prep.ts", SCRATCH] });
  print("prep:", JSON.stringify(prep));
  if (prep.exitCode !== 0) {
    throw new Error(`briefing prep failed: ${(prep.stderr ?? "").slice(0, 300)}`);
  }

  // 2. Discovery (job): scan the window, dedupe vs the seen copy.
  // Returns a WIDE pre-judge pool (BRA-124): the judge re-ranks it
  // by consequence and cuts it to the candidate count, so papers the
  // keyword cut would drop stay in play for judging.
  const POOL_SIZE = 40;
  const CANDIDATE_COUNT = 18;
  const discovery = job<DiscoveryInput, DiscoveryResult>({
    spec: "briefing-discover",
    input: {
      seenPath: SEEN_COPY,
      windowDays: WINDOW_DAYS,
      maxResults: 300,
      categories: CATEGORIES,
      endDate: EDITION_DATE,
      preJudgePool: POOL_SIZE,
    },
  });
  if (!discovery.ok) {
    throw new Error(`briefing discover failed: ${discovery.error}`);
  }
  print(
    `discovery: source=${discovery.source} scanned=${discovery.scanned} ` +
      `fresh=${discovery.freshCount} pool=${discovery.candidates.length} ` +
      `abstractPass fetched=${discovery.abstractPass?.fetched ?? 0} ` +
      `supplement=${discovery.abstractPass?.promoted.length ?? 0} ` +
      `excludedSeen=${discovery.excludedSeen.length} ` +
      `window=${discovery.earliestScanned || discovery.windowStart}..${discovery.windowEnd}`,
  );
  print(`discovery: excludedSeen sample=${JSON.stringify(discovery.excludedSeen.slice(0, 8))}`);
  if (discovery.candidates.length < SELECT_COUNT) {
    throw new Error(
      `briefing discover found only ${discovery.candidates.length} candidates, need ${SELECT_COUNT}`,
    );
  }

  // 2b. Consequence judge (job, BRA-124): the LLM judge scores each
  // pool paper's abstract for consequence 0-10 (jobspec
  // briefing-judge-consequence). In production a pool worker judges
  // live; in a trial the recorded verdicts come via judgmentsPath.
  // The pool is re-ranked consequence-led (consequence * 10 +
  // topicScore) and cut to the candidate count — the read set below
  // comes from the judged ranking, not the keyword ranking.
  // The judge sees the pool PLUS the abstract-pass supplement
  // (discovery.abstractPass.promoted): abstract-strong title-low
  // papers the title cut buried. Nobody is displaced — the
  // supplement can only add to the edition, and only if the judge
  // finds a promoted paper consequential (see
  // workflows/library/pool-promotion.ts). The judge fails loudly
  // upstream on any paper without a verdict, so a trial must carry
  // verdicts for the supplement too.
  const judgePapers = [...discovery.candidates, ...(discovery.abstractPass?.promoted ?? [])];
  const judged = job<JudgeInput, JudgeResult>({
    spec: "briefing-judge-consequence",
    input: {
      papers: judgePapers,
      judgmentsPath: input.judgmentsPath,
    },
  });
  if (!judged.ok) {
    throw new Error(`briefing judge failed: ${judged.error}`);
  }
  const verdictById = new Map<string, ConsequenceVerdict>();
  for (const s of judged.scores) verdictById.set(s.id, s);
  const ranked = rankByConsequence(
    judgePapers.map((c) => ({
      ...c,
      consequence: verdictById.get(c.id)?.consequence ?? null,
    })),
  ).map((c) => ({
    ...c,
    consequence: c.consequence ?? undefined,
    combined: combinedScore(c.score, c.consequence),
  }));
  const candidates = ranked.slice(0, CANDIDATE_COUNT);
  print(
    `judged: pool=${discovery.candidates.length} supplement=${judgePapers.length - discovery.candidates.length} ` +
      `ranked=${ranked.length} candidates=${candidates.length} ` +
      `top=${candidates.slice(0, 5).map((c) => `${c.id}(cons ${c.consequence}, combined ${c.combined})`).join(", ")}`,
  );
  for (const c of candidates) {
    print(`candidate ${c.id}: topic ${c.score}, consequence ${c.consequence}, combined ${c.combined} — ${verdictById.get(c.id)?.reasons ?? ""}`);
  }

  // 3. Reads in parallel (all): fetch + verify + extract per paper.
  // The read set is the judged ranking's top READ_COUNT — consequence
  // led, not keyword led.
  const readOutcomes: Outcome<PaperRead>[] = all(
    candidates.slice(0, READ_COUNT).map(
      (c) =>
        () =>
          job<ReadInput, PaperRead>({ spec: "briefing-read", input: { paper: c, rubricText } }),
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

  // Rank the reads consequence-led (BRA-130): combinedScore orders;
  // numbers and fullText are tiebreaks only and can never overturn a
  // consequence point (see compareReads in consequence-rank.ts). An
  // unjudged read throws loudly here instead of silently falling
  // back to a topic-fit score — the judge fails loudly upstream and
  // the read passes consequence through untouched, so this is
  // unreachable in practice, but a silent fallback in the must-read
  // path is the wrong shape.
  const rankedReads = rankReads(reads);
  const selected = rankedReads.slice(0, SELECT_COUNT);
  print(`selected: ${selected.map((r) => `${r.id}(consequence ${r.consequence}, ${r.numbers.length} numbers)`).join(", ")}`);

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

  // 5. Must-read selection (BRA-130): deterministic — the top of the
  // consequence-led ranking. There is no decide trap here: the v0
  // decision model cannot judge consequence, so a decide trap would
  // only ratify the leader (a fake step — see the header note). The
  // ranking IS the decision; the pick is printed for the journal.
  // (The old decide question carried a stale threshold calibrated
  // for the score-times-ten scale. It goes away with the trap;
  // there is no threshold on the combined scale.)
  const mustReadId = selected[0].id;
  print(
    `must-read: ${mustReadId} consequence ${selected[0].consequence} — top of the consequence-led ranking`,
  );

  // 6. Render (job): dated markdown + meta.json, live format.
  const scopeNote =
    (input.mock
      ? `**TEST EDITION — produced by the AgentTS briefing workflow (BRA-55 proof run), not the live 06:15 cron.** `
      : `**AI research briefing — produced by the AgentTS briefing workflow.** `) +
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
      rubricText,
    },
  });
  print(`render: ${rendered.paperCount} papers, must-read ${rendered.mustReadId}`);

  // 7. JudgeFixLoop structural polish over the draft (library reuse).
  // Criteria are structural properties the v0 worker can genuinely
  // check on the draft text (digits present; each subsection present).
  // The reviewed text rubric (morning-report-rubric.md) is NOT the
  // step-7 rubric: the v0 judge checks the first word of each
  // criterion string and cannot read prose — question-derived criteria
  // would false-negative and the fix would append "(revised N)." to
  // the published edition. Switching step 7 to the text rubric needs
  // a real (LLM) judge; the text rubric reaches the draft/read steps
  // instead (criterion 9). See the briefing-review record in
  // ~/workspace/rubric-validation/VALIDATION.md.
  const polished = judgeFixLoop<WorkItem, Rubric>(
    { text: rendered.markdown, goal: `AI research briefing test edition ${EDITION_DATE}` },
    {
      criteria: ["concrete numbers", "how it works", "other work", "limitations", "insights"],
      threshold: 0.8,
    },
    3,
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

  // The week page is named by the week's Monday, not the edition
  // date (BRA-123) — one value for the print and the return, so they
  // cannot disagree.
  const weekHtml = `${FILES_DIR}/ai-briefings-week-${weekMonday(EDITION_DATE)}.html`;
  print(`edition: ${written.markdownPath}`);
  print(`week page: ${weekHtml}`);
  print(`index: ${FILES_DIR}/ai-briefings.html`);
  print(`papers: ${rendered.paperCount}, must-read: ${rendered.mustReadId}`);

  return {
    editionDate: EDITION_DATE,
    mustReadId: rendered.mustReadId,
    selectedIds: selected.map((r) => r.id),
    markdownPath: written.markdownPath,
    metaPath: written.metaPath,
    htmlPath: weekHtml,
    indexPath: `${FILES_DIR}/ai-briefings.html`,
    paperCount: rendered.paperCount,
    polishLoops: polished.loops,
    polishConverged: polished.converged,
  };
}
