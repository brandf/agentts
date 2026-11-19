#!/usr/bin/env bun
/**
 * Rubric-review tests (rubric-rubric design, Nov 18, 2026).
 *
 * Runs tests/workflows/workflow-rubric-review-probe.ts under the Host
 * with the mock adapter (mirrored rubric workers) and the direct
 * adapter (real worker processes) and asserts the same outcomes under
 * both — the mock/direct mirror proof for the new rubric branch:
 *
 *   A. Meta-rubric file mirror: workflows/rubrics/meta-rubric.md
 *      carries all 14 criterion names the workers check for, under
 *      four perspective headings, with the guided questions.
 *   B. Resolver: inline vs file resolution agree (same resolved text,
 *      same round-1 score); a missing file, an empty file, and an
 *      empty inline rubric all fail loudly.
 *   C. Negative control: the current five-word briefing rubric scores
 *      0 in round 1 (it names none of the 14 meta-criteria), the loop
 *      revises it, and round 2 converges at 1.0 — with per-criterion
 *      scores, all five guided answers, and free-form feedback on
 *      every final verdict, and the full open-ended feedback in the
 *      run result. The fixed text names all 14 criteria.
 *   D. Positive control: the meta-rubric itself scores 1.0 in round 1
 *      and converges in 1 loop, every criterion 10.
 *   E. Mid control: a rubric naming 3 of 14 criteria scores a 0.22
 *      round-1 aggregate (judge 0: 0.20, judge 1: 0.20, judge 2:
 *      0.27 — judge 2 doubles criterion 2, which is addressed),
 *      then converges in loop 2 at 1.0.
 *   F. Loud failures: no mediocre example, a bad example label, and
 *      an example carrying both text and file all fail loudly.
 *   G. Rubric-update on a text rubric returns it unchanged (v0 never
 *      rewrites versioned prose) — driven through a separate probe
 *      workflow (one contract per trap key per extraction).
 *   H. References carried: the judges' inputs carry the resolved
 *      reference examples (1 good + 1 mediocre).
 *   I. File-based references (BRA-129): the weak review with the
 *      reference examples resolved from files — the path that failed
 *      in validation when resolveReferences called exec inside
 *      Array.map. Same outcomes as C under both adapters.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-rubric-review.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra121 suite.)
 *
 * Run outputs go to $RUBRIC_REVIEW_WORKDIR (scratch, set by run.sh)
 * or a fresh mkdtemp dir. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Host } from "../src/host";
import { decideLocal } from "../src/decision-model";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-rubric-review-probe.ts");
const UPDATE_WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-rubric-update-probe.ts");
const META_RUBRIC = path.join(ROOT, "workflows", "rubrics", "meta-rubric.md");
const WORKDIR = process.env.RUBRIC_REVIEW_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "rubric-review-"));

const FAILURES: string[] = [];
function fail(msg: string): void {
  console.log(`FAIL: ${msg}`);
  FAILURES.push(msg);
}
function ok(msg: string): void {
  console.log(msg);
}
function check(cond: boolean, msg: string): void {
  if (cond) ok(msg);
  else fail(msg);
}

// ------------------------------------------------------------- fixtures
/** The current five-word briefing rubric: names none of the 14
 * meta-criteria (no stem appears in it), so it must score 0. */
const WEAK_RUBRIC = [
  "# Briefing Rubric",
  "",
  "Score each paper on: concrete numbers, how it works, other work, limitations, insights.",
  "",
].join("\n");

/** A mid-quality rubric: names 3 of 14 criteria — anchored-scores
 * ("anchors"), versioning ("Version"), multiple-perspectives
 * ("perspective") — and no others. "cover" is not "coverage";
 * "Graded questions" is not "open-ended". */
const MID_RUBRIC = [
  "# Review Rubric (v1)",
  "",
  "## Selection perspective",
  "### Graded questions",
  "- Does the selection cover the day's consequential papers? Each question defines its 0, 5, and 10 anchors: 0 means the must-read is arbitrary, 5 means strong but a stronger candidate was cut, 10 means the single most consequential paper with its reason stated.",
  "",
  "## Depth perspective",
  "### Graded questions",
  "- Are the key findings stated with numbers? Each question defines its 0, 5, and 10 anchors: 0 means no numbers, 5 means numbers without comparators, 10 means every key claim carries numbers with baselines.",
  "",
  "## Version",
  "",
  "v1. Change log: created as a mid-quality fixture.",
  "",
].join("\n");

const GOOD_EXAMPLE =
  "Paper A: FlashAttention 2,830 MB / 144.9 ms vs. DiJiang 4,085 MB / 157 ms. " +
  "The mechanism replaces softmax with a tiled online algorithm. " +
  "Relates to Hedgehog (2611.22947), which it supersedes on memory traffic. " +
  "Insight: any future linear-attention proposal needs a DRAM-traffic budget in its abstract. " +
  "Limitation: evaluated on one GPU, one config.";
const MEDIOCRE_EXAMPLE =
  "Paper B is a new attention mechanism. It improves accuracy. " +
  "Related to attention research. Interesting direction with more work needed.";

const SCOPE = {
  inScope: "one daily edition of the AI research briefing — at least five papers, verified, deduped",
  outOfScope: "papers already covered in a prior edition; anything that is not a research paper",
  boundaries: "generalizes across different days' editions, not across kinds of morning report",
};

/** The 14 meta-criterion names, in file order (hyphenated keys). */
const META_CRITERIA = [
  "coverage",
  "discrimination",
  "anchored-scores",
  "actionability",
  "checkability",
  "independence",
  "calibration",
  "open-ended-feedback",
  "drafter-shared",
  "anti-patterns",
  "versioning",
  "no-process-in-prose",
  "multiple-perspectives",
  "signs-of-generality",
];

/** The display names as the file writes them (spaces, not hyphens). */
const META_CRITERIA_DISPLAY = [
  "Coverage",
  "Discrimination",
  "Anchored scores",
  "Actionability",
  "Checkability",
  "Independence",
  "Calibration",
  "Open-ended feedback",
  "Drafter-shared",
  "Anti-patterns",
  "Versioning",
  "No process in prose",
  "Multiple perspectives",
  "Signs of generality",
];

/** The key stems the v0 workers check for, per criterion. */
const META_STEMS: Record<string, string> = {
  coverage: "coverage",
  discrimination: "discrimination",
  "anchored-scores": "anchor",
  actionability: "actionab",
  checkability: "checkab",
  independence: "independen",
  calibration: "calibrat",
  "open-ended-feedback": "open-ended",
  "drafter-shared": "drafter",
  "anti-patterns": "anti-pattern",
  versioning: "version",
  "no-process-in-prose": "no process",
  "multiple-perspectives": "perspective",
  "signs-of-generality": "generality",
};

// ------------------------------------------------------------- journal
function unwrapResult(e: any): unknown {
  const r = e?.result;
  if (r !== null && typeof r === "object" && !Array.isArray(r) && "value" in r) return r.value;
  return r;
}

function allEvents(host: Host, runId: string): any[] {
  const events = host.journal(runId);
  const out = [...events];
  for (const e of events) {
    if (e.event === "fork" && Array.isArray(e.childRuns)) {
      for (const child of e.childRuns) out.push(...host.journal(child));
    }
  }
  return out;
}

/** Aggregate means in journal order (one per loop). */
function aggregateMeans(host: Host, runId: string): number[] {
  const means: number[] = [];
  for (const e of host.journal(runId)) {
    if (e.event !== "trap-result") continue;
    const v = unwrapResult(e) as any;
    if (v && typeof v.meanScore === "number" && typeof v.summary === "string" && typeof v.approved === "number") {
      means.push(v.meanScore);
    }
  }
  return means;
}

/** Aggregate results in journal order (one per loop). */
function aggregates(host: Host, runId: string): any[] {
  const out: any[] = [];
  for (const e of host.journal(runId)) {
    if (e.event !== "trap-result") continue;
    const v = unwrapResult(e) as any;
    if (v && typeof v.meanScore === "number" && typeof v.summary === "string" && typeof v.approved === "number") {
      out.push(v);
    }
  }
  return out;
}

/** Judge trap inputs, in journal order (they live in the fork-child
 * journals — the judges run in all() branch thunks). */
function judgeInputs(host: Host, runId: string): any[] {
  return allEvents(host, runId)
    .filter((e: any) => e.event === "trap" && e.type === "job" && e.arg?.spec === "judge")
    .map((e: any) => e.arg.input);
}

// ------------------------------------------------------------- driving
function mockHost(stateDir: string): Host {
  const host = new Host({ stateDir, adapter: new MockAdapter({ gates: "hold" }) });
  host.setCanned("decide", (_type, arg) => ({ value: decideLocal(arg.question, arg.options) }));
  return host;
}

async function runProbe(host: Host, runId: string, input: any): Promise<any> {
  host.submit(WORKFLOW, { runId, input });
  await host.runQueue();
  return host.result(runId);
}

function reviewInput(overrides: any): any {
  // Drop undefined-valued keys: the trap-boundary JSON rule rejects
  // undefined anywhere in a submitted input (use absence, not
  // undefined, for "no value").
  const input: any = {
    mode: "review",
    rubricText: WEAK_RUBRIC,
    threshold: 0.8,
    scope: SCOPE,
    artifactKind: "AI research briefing edition",
    goodExample: GOOD_EXAMPLE,
    mediocreExample: MEDIOCRE_EXAMPLE,
    metaRubricFile: META_RUBRIC,
    ...overrides,
  };
  for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
  return input;
}

function assertReviewShape(tag: string, out: any): void {
  check(out && typeof out === "object", `${tag} OK: review output present`);
  if (!out || typeof out !== "object") return;
  const verdicts = out.lastVerdicts;
  check(Array.isArray(verdicts) && verdicts.length === 3, `${tag} OK: 3 final verdicts (got ${verdicts?.length})`);
  if (!Array.isArray(verdicts)) return;
  for (let i = 0; i < verdicts.length; i++) {
    const v = verdicts[i];
    check(
      Array.isArray(v.scores) && v.scores.length === 14,
      `${tag} OK: verdict ${i} carries 14 per-criterion scores (got ${v.scores?.length})`,
    );
    check(
      Array.isArray(v.guidedAnswers) && v.guidedAnswers.length === 5,
      `${tag} OK: verdict ${i} carries 5 guided answers (got ${v.guidedAnswers?.length})`,
    );
    check(
      typeof v.openFeedback === "string" && v.openFeedback.length > 0,
      `${tag} OK: verdict ${i} carries free-form openFeedback`,
    );
    if (Array.isArray(v.guidedAnswers)) {
      check(
        JSON.stringify(v.guidedAnswers.map((a: any) => a.question)) === JSON.stringify([1, 2, 3, 4, 5]),
        `${tag} OK: verdict ${i} guided answers are questions 1-5 in order`,
      );
    }
  }
}

// ------------------------------------------------------- A. file mirror
{
  console.log("\n=== A. meta-rubric file mirror ===");
  const text = fs.readFileSync(META_RUBRIC, "utf8");
  const lower = text.toLowerCase();
  for (const name of META_CRITERIA_DISPLAY) {
    check(text.includes(name), `MIRROR OK: meta-rubric.md names "${name}"`);
  }
  for (const name of META_CRITERIA) {
    check(
      lower.includes(META_STEMS[name]),
      `MIRROR OK: meta-rubric.md contains the "${name}" stem "${META_STEMS[name]}" the workers check for`,
    );
  }
  for (const heading of [
    "## Discrimination perspective",
    "## Clarity perspective",
    "## Usefulness perspective",
    "## Robustness perspective",
  ]) {
    check(text.includes(heading), `MIRROR OK: meta-rubric.md has heading "${heading}"`);
  }
  check(text.includes("Guided open-ended questions"), "MIRROR OK: meta-rubric.md carries the guided open-ended questions");
  check(text.includes("## Version"), "MIRROR OK: meta-rubric.md carries a Version section");
  check(
    text.includes("Interpolate:"),
    "MIRROR OK: meta-rubric.md states the interpolation rule",
  );
}

// ------------------------------------------------------------- B. resolver
{
  console.log("\n=== B. resolver: inline vs file, loud failures (mock) ===");
  const stateDir = path.join(WORKDIR, "resolver");
  const host = mockHost(stateDir);
  const weakFile = path.join(WORKDIR, "weak-rubric.md");
  fs.writeFileSync(weakFile, WEAK_RUBRIC);

  let res = await runProbe(host, "resolve-inline", { mode: "resolve-inline", rubricText: WEAK_RUBRIC });
  check(res.status === "done", `RESOLVE OK: inline resolves (got ${res.status})`);
  check(res.output?.resolvedText === WEAK_RUBRIC, "RESOLVE OK: inline resolved text is the input text");

  res = await runProbe(host, "resolve-file", { mode: "resolve-file", rubricFile: weakFile });
  check(res.status === "done", `RESOLVE OK: file resolves (got ${res.status})`);
  check(res.output?.resolvedText === WEAK_RUBRIC, "RESOLVE OK: file resolved text equals the inline text");

  const missing = path.join(WORKDIR, "no-such-rubric.md");
  res = await runProbe(host, "resolve-missing", { mode: "resolve-missing", rubricFile: missing });
  check(res.status === "failed", `RESOLVE OK: missing file fails loudly (got ${res.status})`);
  check(
    (res.error ?? "").includes(missing),
    `RESOLVE OK: missing-file error names the path (${JSON.stringify(res.error)})`,
  );

  const emptyFile = path.join(WORKDIR, "empty-rubric.md");
  fs.writeFileSync(emptyFile, "  \n");
  res = await runProbe(host, "resolve-empty-file", { mode: "resolve-file", rubricFile: emptyFile });
  check(res.status === "failed", `RESOLVE OK: empty file fails loudly (got ${res.status})`);
  check((res.error ?? "").includes("empty"), `RESOLVE OK: empty-file error says empty (${JSON.stringify(res.error)})`);

  res = await runProbe(host, "resolve-empty-inline", { mode: "resolve-inline", rubricText: "" });
  check(res.status === "failed", `RESOLVE OK: empty inline rubric fails loudly (got ${res.status})`);
  check((res.error ?? "").includes("empty"), `RESOLVE OK: empty-inline error says empty (${JSON.stringify(res.error)})`);
}

// ------------------------------------------- C/D/E. reviews, both adapters
const FINAL_TEXTS: Record<string, string> = {};
for (const adapter of ["mock", "direct"] as const) {
  console.log(`\n=== ${adapter}: weak / meta / mid reviews ===`);
  const stateDir = path.join(WORKDIR, `review-${adapter}`);
  const host =
    adapter === "mock" ? mockHost(stateDir) : new Host({ stateDir, adapter: new DirectAdapter() });

  // C. Negative control: the five-word briefing rubric.
  {
    const runId = `weak-${adapter}`;
    const res = await runProbe(host, runId, reviewInput({}));
    check(res.status === "done", `WEAK OK [${adapter}]: run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
    const out = res.output?.review;
    check(out?.loops === 2, `WEAK OK [${adapter}]: 2 loops (got ${out?.loops})`);
    check(out?.converged === true, `WEAK OK [${adapter}]: converged (got ${out?.converged})`);
    const means = aggregateMeans(host, runId);
    check(means.length === 2, `WEAK OK [${adapter}]: 2 aggregates (got ${means.length})`);
    check(means[0] === 0, `WEAK OK [${adapter}]: round-1 aggregate mean 0 — the negative control scores low (got ${means[0]})`);
    check(means[1] === 1, `WEAK OK [${adapter}]: round-2 aggregate mean 1.0 (got ${means[1]})`);
    check(out?.finalMeanScore === 1, `WEAK OK [${adapter}]: final mean 1.0 (got ${out?.finalMeanScore})`);
    assertReviewShape(`WEAK [${adapter}]`, out);
    const aggs = aggregates(host, runId);
    check(
      Array.isArray(aggs[1]?.openFeedbackThemes) && aggs[1].openFeedbackThemes.length > 0,
      `WEAK OK [${adapter}]: final aggregate carries openFeedbackThemes (${JSON.stringify(aggs[1]?.openFeedbackThemes)?.slice(0, 120)})`,
    );
    const fixed: string = out?.rubric ?? "";
    for (const name of META_CRITERIA) {
      check(
        fixed.toLowerCase().includes(META_STEMS[name]),
        `WEAK OK [${adapter}]: fixed rubric names "${name}"`,
      );
    }
    FINAL_TEXTS[`weak-${adapter}`] = fixed;
    // H. References carried: the judges' inputs carry both examples.
    const inputs = judgeInputs(host, runId);
    check(inputs.length === 6, `REFS OK [${adapter}]: 6 judge inputs across 2 loops (got ${inputs.length})`);
    if (inputs.length > 0) {
      const refs = inputs[0]?.item?.references ?? [];
      check(
        refs.length === 2 && refs[0]?.label === "good" && refs[0]?.text === GOOD_EXAMPLE,
        `REFS OK [${adapter}]: first judge input carries the known-good example`,
      );
      check(
        refs.length === 2 && refs[1]?.label === "mediocre" && refs[1]?.text === MEDIOCRE_EXAMPLE,
        `REFS OK [${adapter}]: first judge input carries the known-mediocre example`,
      );
      check(
        typeof inputs[0]?.item?.scope === "string" && inputs[0].item.scope.includes("In scope:"),
        `REFS OK [${adapter}]: first judge input carries the rendered scope`,
      );
    }
  }

  // D. Positive control: the meta-rubric itself.
  {
    const runId = `meta-${adapter}`;
    const res = await runProbe(host, runId, reviewInput({ rubricFile: META_RUBRIC, rubricText: undefined }));
    check(res.status === "done", `META OK [${adapter}]: run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
    const out = res.output?.review;
    check(out?.loops === 1, `META OK [${adapter}]: 1 loop (got ${out?.loops})`);
    check(out?.converged === true, `META OK [${adapter}]: converged (got ${out?.converged})`);
    check(out?.finalMeanScore === 1, `META OK [${adapter}]: final mean 1.0 (got ${out?.finalMeanScore})`);
    assertReviewShape(`META [${adapter}]`, out);
    const verdicts = out?.lastVerdicts ?? [];
    for (let i = 0; i < verdicts.length; i++) {
      check(
        verdicts[i]?.scores?.every((s: any) => s.score === 10),
        `META OK [${adapter}]: verdict ${i} scores every criterion 10`,
      );
    }
  }

  // E. Mid control: 3 of 14 criteria named.
  {
    const runId = `mid-${adapter}`;
    const res = await runProbe(host, runId, reviewInput({ rubricText: MID_RUBRIC }));
    check(res.status === "done", `MID OK [${adapter}]: run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
    const out = res.output?.review;
    check(out?.loops === 2, `MID OK [${adapter}]: 2 loops (got ${out?.loops})`);
    check(out?.converged === true, `MID OK [${adapter}]: converged (got ${out?.converged})`);
    const means = aggregateMeans(host, runId);
    check(means.length === 2, `MID OK [${adapter}]: 2 aggregates (got ${means.length})`);
    check(
      means[0] === 0.22,
      `MID OK [${adapter}]: round-1 aggregate mean 0.22 — judges 0.20/0.20/0.27 (got ${means[0]})`,
    );
    check(means[1] === 1, `MID OK [${adapter}]: round-2 aggregate mean 1.0 (got ${means[1]})`);
    assertReviewShape(`MID [${adapter}]`, out);
  }
}

// Mock/direct mirror: the fixed weak rubric is identical under both.
check(
  FINAL_TEXTS["weak-mock"] !== undefined &&
    FINAL_TEXTS["weak-mock"] === FINAL_TEXTS["weak-direct"],
  "MIRROR OK: mock and direct produce the identical fixed weak rubric",
);

// ------------------------------------------------------- F. loud failures
{
  console.log("\n=== F. loud failures: references validation (mock) ===");
  const stateDir = path.join(WORKDIR, "failures");
  const host = mockHost(stateDir);

  let res = await runProbe(host, "no-mediocre", reviewInput({ omitMediocre: true }));
  check(res.status === "failed", `FAIL OK: no mediocre example fails loudly (got ${res.status})`);
  check(
    (res.error ?? "").includes("referenceExamples"),
    `FAIL OK: no-mediocre error names referenceExamples (${JSON.stringify(res.error)})`,
  );

  res = await runProbe(host, "bad-label", reviewInput({ badLabel: true }));
  check(res.status === "failed", `FAIL OK: bad example label fails loudly (got ${res.status})`);
  check(
    (res.error ?? "").includes("referenceExamples") || (res.error ?? "").includes("good"),
    `FAIL OK: bad-label error names the label problem (${JSON.stringify(res.error)})`,
  );

  res = await runProbe(host, "both-forms", reviewInput({ bothExampleForms: true }));
  check(res.status === "failed", `FAIL OK: example with both text and file fails loudly (got ${res.status})`);
  check(
    (res.error ?? "").includes("text or file"),
    `FAIL OK: both-forms error names text-or-file (${JSON.stringify(res.error)})`,
  );
}

// -------------------------------------------------- G. rubric-update text
for (const adapter of ["mock", "direct"] as const) {
  console.log(`\n=== G. rubric-update on a text rubric (${adapter}) ===`);
  const stateDir = path.join(WORKDIR, `rubric-update-${adapter}`);
  const host =
    adapter === "mock" ? mockHost(stateDir) : new Host({ stateDir, adapter: new DirectAdapter() });
  const metaText = fs.readFileSync(META_RUBRIC, "utf8");
  host.submit(UPDATE_WORKFLOW, {
    runId: `rubric-update-${adapter}`,
    input: { rubricText: metaText, threshold: 0.8 },
  });
  await host.runQueue();
  const res = host.result(`rubric-update-${adapter}`);
  check(res.status === "done", `UPDATE OK [${adapter}]: run done (got ${res.status})`);
  check(
    res.output?.rubricUpdate?.text === metaText,
    `UPDATE OK [${adapter}]: text rubric returned unchanged`,
  );
  check(
    res.output?.rubricUpdate?.threshold === 0.8,
    `UPDATE OK [${adapter}]: threshold preserved (got ${res.output?.rubricUpdate?.threshold})`,
  );
}

// -------------------------------------------------- I. file-based references
for (const adapter of ["mock", "direct"] as const) {
  console.log(`\n=== I. file-based reference examples (${adapter}) ===`);
  const stateDir = path.join(WORKDIR, `file-refs-${adapter}`);
  const host =
    adapter === "mock" ? mockHost(stateDir) : new Host({ stateDir, adapter: new DirectAdapter() });
  // BRA-129: reference examples resolved from files used to fail —
  // resolveReferences called the exec trap inside Array.map, which
  // cannot suspend in dquickts. This section runs the weak review
  // with file-based references and asserts it completes with the
  // resolved texts in the judges' inputs.
  const goodFile = path.join(WORKDIR, "good-example.md");
  const mediocreFile = path.join(WORKDIR, "mediocre-example.md");
  fs.writeFileSync(goodFile, GOOD_EXAMPLE);
  fs.writeFileSync(mediocreFile, MEDIOCRE_EXAMPLE);
  const runId = `file-refs-${adapter}`;
  const res = await runProbe(
    host,
    runId,
    reviewInput({
      goodExample: undefined,
      mediocreExample: undefined,
      goodExampleFile: goodFile,
      mediocreExampleFile: mediocreFile,
    }),
  );
  check(
    res.status === "done",
    `FILE-REFS OK [${adapter}]: run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`,
  );
  const out = res.output?.review;
  check(out?.loops === 2, `FILE-REFS OK [${adapter}]: 2 loops (got ${out?.loops})`);
  check(out?.converged === true, `FILE-REFS OK [${adapter}]: converged (got ${out?.converged})`);
  const inputs = judgeInputs(host, runId);
  check(inputs.length === 6, `FILE-REFS OK [${adapter}]: 6 judge inputs across 2 loops (got ${inputs.length})`);
  if (inputs.length > 0) {
    const refs = inputs[0]?.item?.references ?? [];
    check(
      refs.length === 2 && refs[0]?.text === GOOD_EXAMPLE,
      `FILE-REFS OK [${adapter}]: first judge input carries the resolved good example from file`,
    );
    check(
      refs.length === 2 && refs[1]?.text === MEDIOCRE_EXAMPLE,
      `FILE-REFS OK [${adapter}]: first judge input carries the resolved mediocre example from file`,
    );
  }
}

if (FAILURES.length) {
  console.log(`\nFAIL: ${FAILURES.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nPASS rubric-review (inline/file RubricInput resolution, three-judge + fix loop carrying open-ended feedback, reference-examples enforcement, file-based reference examples resolve, negative-control weak rubric scores 0 then converges)`);
