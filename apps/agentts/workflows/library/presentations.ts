// presentations — the presentations standard-library workflow (BRA-109).
//
// Takes a deck outline (title + slides) and a presentation rubric
// (inline, a `{ file }` reference to a rubric JSON file, or the
// default rubric below), builds the deck as a Google Slides
// presentation, runs a JudgeFixLoop review/polish step over the
// deck, and renders the final deck to files.
//
// Shape (settled, following improve-loop): a workflow is a function
// with a trap-like signature — ONE JSON-capable input in, ONE
// JSON-capable output out. The default export IS the workflow:
//   export default function presentations(input: PresentationInput): PresentationResult
//
// Steps:
//   1. Resolve the rubric (inline, or a file read with an `exec`
//      `cat` trap and parsed as JSON — a malformed file fails loudly
//      rather than judging against a rubric that is not there).
//   2. `slides-create` (job trap): validate the outline and build the
//      deck — an invalid outline (empty title, no slides, a slide
//      with no title) fails loudly here, before any review work.
//   3. JudgeFixLoop over the deck (form A import composition, same
//      run/journal): three judges score the deck against the rubric,
//      an aggregate reduces the verdicts, a decide drives
//      revise-or-keep, the fix genuinely improves the deck
//      (trims over-full slides, shortens long bullets, adds a
//      concrete bullet, fills empty slides). At most `maxLoops`
//      loops (default 3).
//   4. `slides-render` (job trap): write the final deck as deck.json
//      + deck.md into outDir (default
//      `.agentts-scratch/presentations-out`).
//
// Result (PresentationResult): the final deck, its id and paths,
// the loop outcome (loops, converged, final mean score).
//
// v1 limits, stated plainly: the Slides steps are job traps served
// by the deterministic workers (workflows/library/worker.ts under
// the direct adapter, mirrored in the mock adapter) — they do NOT
// call the live Google Slides API. `slides-create` computes the deck
// locally and returns a deterministic deck id
// (`deck-<sha256[0:12] of title + slides>`); a live Slides adapter
// plugs into the same two specs later. The v0 judge/fix workers are
// deterministic keyword/coverage workers, not LLM judgment — the fix
// edits the deck structurally (trim / shorten / append / fill)
// rather than rewriting prose, and a criterion the fix does not know
// (a custom rubric criterion outside one-idea / concise / concrete /
// complete) stays outstanding and the loop hits the cap honestly
// instead of pretending to improve.

import { job, exec } from "../../src/agentts";
import { judgeFixLoop, type JudgeFixLoopResult } from "./judge-fix-loop";

declare function print(...args: unknown[]): void;

// ---------------------------------------------------------------- types
/** One slide of the input outline. `bullets` may be empty — an
 * empty slide is a weak deck, not an invalid one; the review step's
 * "complete" criterion catches it. */
export interface SlideDraft {
  title: string;
  bullets: string[];
  notes?: string;
}

export interface Slide {
  title: string;
  bullets: string[];
  notes?: string;
}

/** A deck: the structured slides plus a text rendering the judges
 * score against, and a revision counter the fix step bumps when it
 * actually changes something. */
export interface Deck {
  deckId: string;
  title: string;
  slides: Slide[];
  text: string;
  revisions: number;
}

/** A presentation rubric: criteria as bare strings (the JudgeFixLoop
 * shape, as in the daily briefing — the judge/fix workers match
 * criteria by name), plus the mean-score threshold. */
export interface PresentationRubric {
  criteria: string[];
  threshold: number;
}

export interface PresentationRubricFileRef {
  file: string;
}

/** A rubric inline, a reference to a rubric JSON file, or omitted
 * (the default rubric below). */
export type PresentationRubricInput = PresentationRubric | PresentationRubricFileRef;

export interface PresentationInput {
  title: string;
  slides: SlideDraft[];
  rubric?: PresentationRubricInput;
  outDir?: string;
  maxLoops?: number;
}

export interface PresentationResult {
  deck: Deck;
  deckId: string;
  title: string;
  slides: number;
  deckPath: string;
  markdownPath: string;
  loops: number;
  converged: boolean;
  finalMeanScore: number;
}

// Job trap contracts (concrete, named types at every call site).
export interface SlidesCreateInput {
  title: string;
  slides: SlideDraft[];
}

export interface SlidesRenderInput {
  deck: Deck;
  outDir: string;
}

export interface SlidesRenderResult {
  ok: boolean;
  error: string;
  deckId: string;
  deckPath: string;
  markdownPath: string;
  slides: number;
  bytes: number;
}

/** The default rubric (decided by the BRA-109 implementer — the
 * issue left the rubric undecided): four criteria the v0 workers
 * can genuinely check and fix. "one-idea": each slide carries one
 * idea (at most 5 bullets). "concise": bullets are short (at most
 * 12 words each). "concrete": the deck names a concrete detail (a
 * number or a concrete noun). "complete": every slide has at least
 * one bullet. */
export const DEFAULT_PRESENTATION_RUBRIC: PresentationRubric = {
  criteria: ["one-idea", "concise", "concrete", "complete"],
  threshold: 0.8,
};

export const MAX_LOOPS = 3;

// ------------------------------------------------------- rubric resolve
/** Resolve a rubric input: inline rubrics pass through; a file
 * reference is read with an exec trap (`cat`) and parsed as JSON.
 * A malformed file (unreadable, bad JSON, wrong shape) throws a
 * clear error — the run fails loudly rather than judging against
 * a rubric that is not there. */
export function resolveRubric(rubric: PresentationRubricInput | undefined): PresentationRubric {
  if (rubric === undefined) {
    return DEFAULT_PRESENTATION_RUBRIC;
  }
  if (!("file" in rubric)) {
    return rubric;
  }
  const read = exec({ cmd: "cat", args: [rubric.file] });
  if (read.exitCode !== 0) {
    throw new Error(
      `presentations: could not read rubric file ${rubric.file} (exit ${read.exitCode}): ${(read.stderr ?? "").slice(0, 200)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.stdout);
  } catch {
    throw new Error(`presentations: rubric file ${rubric.file} is not valid JSON`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { criteria?: unknown }).criteria) ||
    typeof (parsed as { threshold?: unknown }).threshold !== "number"
  ) {
    throw new Error(
      `presentations: rubric file ${rubric.file} must be a JSON object with a criteria array and a numeric threshold`,
    );
  }
  return parsed as PresentationRubric;
}

// -------------------------------------------------------- workflow entry
/** The workflow: one JSON-capable input in, one JSON-capable output
 * out. The host generates a driver (global code) that calls this
 * with the input JSON; the C host captures the return value as the
 * run result. */
export default function presentations(input: PresentationInput): PresentationResult {
  const rubric = resolveRubric(input.rubric);
  print(`rubric: ${rubric.criteria.join(", ")} (threshold ${rubric.threshold})`);

  const deck = job<SlidesCreateInput, Deck>({
    spec: "slides-create",
    input: { title: input.title, slides: input.slides },
  });
  print(`deck: ${deck.deckId} (${deck.slides.length} slides)`);

  const maxLoops = input.maxLoops ?? MAX_LOOPS;
  const reviewed: JudgeFixLoopResult<Deck, PresentationRubric> = judgeFixLoop<Deck, PresentationRubric>(
    deck,
    rubric,
    maxLoops,
  );
  const finalDeck = reviewed.item;
  const finalMeanScore = reviewed.lastAggregate?.meanScore ?? 0;
  print(
    `review: ${reviewed.loops} loop(s), converged ${reviewed.converged}, final mean score ${finalMeanScore}`,
  );

  const outDir = input.outDir ?? ".agentts-scratch/presentations-out";
  const rendered = job<SlidesRenderInput, SlidesRenderResult>({
    spec: "slides-render",
    input: { deck: finalDeck, outDir },
  });
  if (!rendered.ok) {
    throw new Error(`presentations: render failed: ${rendered.error}`);
  }
  print(`deck: ${rendered.deckPath}`);
  print(`markdown: ${rendered.markdownPath}`);
  return {
    deck: finalDeck,
    deckId: rendered.deckId,
    title: finalDeck.title,
    slides: rendered.slides,
    deckPath: rendered.deckPath,
    markdownPath: rendered.markdownPath,
    loops: reviewed.loops,
    converged: reviewed.converged,
    finalMeanScore,
  };
}
