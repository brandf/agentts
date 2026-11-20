// mock-adapter — the mock environment adapter (BRA-44).
// Implementation — the loadable seam is ./adapter.ts (see plugins/README.md for why the mock adapter appears in two files).
//
// The canned-answer half of the BRA-45 mock plugin, factored out so
// the host can load it as an adapter. Same answers as the mock
// plugin's defaultAnswer/mockJob (the swap test requires identical
// answers): job specs score/verify/aggregate by the canned table,
// exec echo hi, gate auto-yes or held, decide {choice:"a",
// confidence:0.9}. Queues and per-type functions let tests configure
// answers ("the next decide returns X at confidence 0.6").
//
// The virtual clock lives in the HOST, not here: sleep/cron/clock
// never reach the adapter. JudgeFixLoop mock judges are answered
// here too (spec "judge"): a deterministic function of the input —
// base score per judge index plus 0.15 per revision the fix job has
// applied (counted from "(revised" markers in the item text) — so
// the loop genuinely improves across iterations and converges, with
// no canned literal per loop. "fix" appends a revision marker and a
// sentence addressing the rubric; "aggregate" computes the mean over
// the verdicts; "rubric-update" adds a criterion when verdicts show
// a repeated miss.

import { HOLD, type Adapter, type TrapAnswer, type TrapContext } from "../../../src/adapter";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { runBugfix } from "../../../workflows/dogfood/bugfix-worker";

export type CannedFn = (
  type: string,
  arg: any,
  ctx: TrapContext,
) => TrapAnswer | undefined;

const MOCK: Record<string, any> = {
  "score:7": { score: 0.92, label: "approved" },
  "verify:7": { score: 0.97, label: "verified" },
  "score:3": { score: 0.41, label: "weak" },
  "verify:3": { score: 0.88, label: "retried" },
  "score:5": { score: 0.63, label: "approved" },
  "score:9": { score: 0.31, label: "slow" },
  "score:11": { score: 0.9, label: "approved" },
  "score:12": { score: 0.85, label: "approved" },
  "score:21": { score: 0.21, label: "g21" },
  "score:22": { score: 0.22, label: "g22" },
  "score:23": { score: 0.23, label: "g23" },
};

/** Judge base scores per judge index (mock judges, canned). */
const JUDGE_BASE = [0.55, 0.62, 0.48];

function revisionsOf(text: string): number {
  return (text.match(/\(revised/g) ?? []).length;
}

function mockJudge(arg: any): any {
  const input = arg?.input ?? {};
  const judge = typeof input.judge === "number" ? input.judge : 0;
  const item = input.item ?? {};
  // A deck-shaped item takes the deck branch (BRA-109) — the same
  // criterion-weighted scoring as the real worker, so the mock run
  // shows a real improving arc.
  if (isDeckItem(item)) return mockJudgeDeck(item, input.rubric ?? {}, judge);
  // A plan-shaped item takes the plan branch (BRA-117) — the same
  // structural scoring as the real worker.
  if (isPlanItem(item)) return mockJudgePlan(item, input.rubric ?? {}, judge);
  // A rubric-shaped item takes the rubric branch (rubric review) —
  // the same criterion checks as the real worker.
  if (isRubricItem(item)) return mockJudgeRubric(item, input.rubric ?? {}, judge);
  const text: string = typeof input.item?.text === "string" ? input.item.text : "";
  const rubric = input.rubric ?? {};
  const criteria: string[] = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  const score = Math.min(
    0.98,
    JUDGE_BASE[judge % JUDGE_BASE.length] + 0.15 * revisionsOf(text),
  );
  const notes =
    criteria.length === 0
      ? "no criteria"
      : criteria.map((c) => `${c}: ${text.toLowerCase().includes(c.toLowerCase().split(" ")[0]) ? "addressed" : "missing"}`).join("; ");
  return { score: Math.round(score * 100) / 100, label: score >= 0.8 ? "approved" : "weak", notes };
}

function mockFix(arg: any): any {
  const input = arg?.input ?? {};
  const item = input.item ?? { text: "", goal: "" };
  // A deck-shaped item takes the deck branch (BRA-109) — the same
  // structural edits as the real worker.
  if (isDeckItem(item)) return mockFixDeck(item, input.verdicts ?? []);
  // A plan-shaped item takes the plan branch (BRA-117) — the same
  // structural edits as the real worker.
  if (isPlanItem(item)) return mockFixPlan(item, input.verdicts ?? []);
  // A rubric-shaped item takes the rubric branch (rubric review) —
  // the same structural edits as the real worker.
  if (isRubricItem(item)) return mockFixRubric(item, input.verdicts ?? []);
  const n = revisionsOf(item.text) + 1;
  // Deliberately neutral: the revision marker is what the mock judges
  // score on (+0.15 per revision). Naming the missed criteria here
  // would game the mock judge's keyword check (its notes look for the
  // criterion's first word in the text) and fake an improvement.
  return { text: `${item.text} (revised ${n}). It is tightened and clarified.`, goal: item.goal ?? "" };
}

/** JudgeFixLoop aggregate (spec "aggregate", new shape): the input
 * carries plain JudgeVerdicts plus the failed-branch count (the
 * workflow unwraps the all() outcomes first). The old direct-trap
 * aggregate ({op:"aggregate", verdicts: Outcome[]}) is a separate
 * branch in mockJob below and keeps its ok-counting shape. */
function mockAggregate(arg: any): any {
  const input = arg?.input ?? {};
  const verdicts = Array.isArray(input.verdicts) ? input.verdicts : [];
  const threshold = typeof input.threshold === "number" ? input.threshold : 0.8;
  const scores = verdicts
    .map((v: any) => (typeof v?.score === "number" ? v.score : null))
    .filter((s: any) => s !== null);
  const mean = scores.length ? scores.reduce((a: number, b: number) => a + b, 0) / scores.length : 0;
  const approved = scores.filter((s: number) => s >= threshold).length;
  const failed = typeof input.failed === "number" ? input.failed : verdicts.length - approved;
  // Open-feedback themes (rubric review): the Q2 adversarial probe
  // answers plus the free-form feedback, deduped first-seen — same
  // logic as the real worker's aggregate.
  const openFeedbackThemes: string[] = [];
  const seenThemes = new Set<string>();
  for (const v of verdicts) {
    const texts: string[] = [
      ...(Array.isArray((v as any)?.guidedAnswers)
        ? (v as any).guidedAnswers.filter((a: any) => a?.question === 2).map((a: any) => a.answer)
        : []),
      ...(typeof (v as any)?.openFeedback === "string" ? [(v as any).openFeedback] : []),
    ];
    for (const t of texts) {
      if (typeof t === "string" && t.trim() && !seenThemes.has(t)) {
        seenThemes.add(t);
        openFeedbackThemes.push(t);
      }
    }
  }
  return {
    approved,
    failed,
    meanScore: Math.round(mean * 100) / 100,
    summary: `${approved} approved, ${failed} failed, mean ${Math.round(mean * 100) / 100}`,
    openFeedbackThemes: openFeedbackThemes.slice(0, 6),
  };
}

function mockRubricUpdate(arg: any): any {
  const input = arg?.input ?? {};
  const rubric = input.rubric ?? { criteria: [], threshold: 0.8 };
  // A text rubric (the meta-rubric) is versioned human-owned prose:
  // v0 never rewrites it. Return it unchanged — same as the real worker.
  if (typeof rubric.text === "string") {
    return { text: rubric.text, threshold: rubric.threshold ?? 0.8 };
  }
  const criteria: string[] = [...(rubric.criteria ?? [])];
  if (!criteria.includes("concrete example")) criteria.push("concrete example");
  return { criteria, threshold: rubric.threshold ?? 0.8 };
}

// Shared presentations mock logic (BRA-109) — mirrors
// workflows/library/worker.ts's deck branch exactly (same criterion
// checks, same fix edits, same renderings, same deck ids), except
// mockSlidesRender, which computes the same paths + bytes WITHOUT
// writing files (a mock never writes).

const PRESENTATION_MAX_BULLETS = 5;
const PRESENTATION_MAX_BULLET_WORDS = 12;
const CONCRETE_BULLET = "In 2026, 3 pilot teams ran this process end to end.";

function isDeckItem(item: any): boolean {
  return item !== null && typeof item === "object" && Array.isArray(item.slides);
}

function deckSlides(deck: any): any[] {
  return Array.isArray(deck?.slides) ? deck.slides : [];
}

function deckBullets(slide: any): string[] {
  return Array.isArray(slide?.bullets) ? slide.bullets : [];
}

function renderDeckText(title: string, slides: any[]): string {
  const lines: string[] = [String(title ?? "")];
  slides.forEach((s: any, i: number) => {
    lines.push(`Slide ${i + 1}: ${s?.title ?? ""}`);
    for (const b of deckBullets(s)) lines.push(`- ${b}`);
  });
  return lines.join("\n");
}

function renderDeckMarkdown(deck: any): string {
  const lines: string[] = [`# ${deck?.title ?? ""}`, ""];
  deckSlides(deck).forEach((s: any, i: number) => {
    lines.push(`## Slide ${i + 1}: ${s?.title ?? ""}`, "");
    for (const b of deckBullets(s)) lines.push(`- ${b}`);
    lines.push("");
  });
  lines.push(`Deck: ${deck?.deckId ?? ""} · ${deckSlides(deck).length} slides`);
  return lines.join("\n") + "\n";
}

function mockDeckCriterionAddressed(criterion: string, deck: any): boolean {
  const first = criterion.toLowerCase().split(" ")[0];
  const slides = deckSlides(deck);
  // Search text is titles + bullets only — NOT the rendered text,
  // whose "Slide N:" lines carry digits that would trip the
  // "concrete" number check (and the word "Slide") for every deck.
  const searchText = slides.flatMap((s: any) => [s?.title ?? "", ...deckBullets(s)]).join(" ");
  if (first === "one-idea") return slides.every((s) => deckBullets(s).length <= PRESENTATION_MAX_BULLETS);
  if (first === "concise")
    return slides.every((s) =>
      deckBullets(s).every(
        (b) => String(b).split(/\s+/).filter((w) => w && w !== "…").length <= PRESENTATION_MAX_BULLET_WORDS,
      ),
    );
  if (first === "concrete") {
    if (/\d/.test(searchText)) return true;
    return ["fox", "coat", "light", "morning", "dog", "river", "stone", "road", "cat", "house", "tree", "rain", "snow"].some(
      (w) => searchText.toLowerCase().includes(w),
    );
  }
  if (first === "complete") return slides.length > 0 && slides.every((s) => deckBullets(s).length >= 1);
  return searchText.toLowerCase().includes(first);
}

function mockJudgeDeck(item: any, rubric: any, judgeIndex: number): any {
  const criteria: string[] = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  const weights = criteria.map((_c, i) =>
    i % Math.max(criteria.length, 1) === judgeIndex % Math.max(criteria.length, 1) ? 2 : 1,
  );
  let got = 0;
  let total = 0;
  const notes: string[] = [];
  criteria.forEach((c, i) => {
    const addressed = mockDeckCriterionAddressed(c, item);
    total += weights[i];
    if (addressed) got += weights[i];
    notes.push(`${c}: ${addressed ? "addressed" : "missing"}`);
  });
  const base = total > 0 ? got / total : 0;
  const score = Math.min(0.98, Math.round((base + 0.05 * revisionsOf(item.text ?? "")) * 100) / 100);
  return { score, label: score >= (rubric.threshold ?? 0.8) ? "approved" : "weak", notes: notes.join("; ") || "no criteria" };
}

function mockFixDeck(item: any, verdicts: any[]): any {
  const slides: any[] = deckSlides(item).map((s: any) => ({
    title: s?.title ?? "",
    bullets: [...deckBullets(s)],
    ...(typeof s?.notes === "string" ? { notes: s.notes } : {}),
  }));
  const missed = new Set<string>();
  for (const v of verdicts) {
    if (typeof v?.notes !== "string") continue;
    for (const part of v.notes.split("; ")) {
      if (part.endsWith("missing")) missed.add(part.split(":")[0]);
    }
  }
  let changed = false;
  if (missed.has("complete")) {
    for (const s of slides) {
      if (s.bullets.length === 0) {
        s.bullets.push(`Key point: ${s.title}.`);
        changed = true;
      }
    }
  }
  if (missed.has("concise")) {
    for (const s of slides) {
      s.bullets = s.bullets.map((b: string) => {
        const words = String(b).split(/\s+/).filter(Boolean);
        if (words.length <= PRESENTATION_MAX_BULLET_WORDS) return b;
        changed = true;
        return `${words.slice(0, PRESENTATION_MAX_BULLET_WORDS).join(" ")} …`;
      });
    }
  }
  if (missed.has("concrete") && slides.length > 0) {
    let target = slides[0];
    for (const s of slides) if (s.bullets.length < target.bullets.length) target = s;
    target.bullets.push(CONCRETE_BULLET);
    changed = true;
  }
  if (missed.has("one-idea")) {
    for (const s of slides) {
      if (s.bullets.length <= PRESENTATION_MAX_BULLETS) continue;
      const evidence = s.bullets.filter((b: string) => /\d/.test(b));
      const rest = s.bullets.filter((b: string) => !/\d/.test(b));
      s.bullets = [...evidence, ...rest].slice(0, PRESENTATION_MAX_BULLETS);
      changed = true;
    }
  }
  const prevRevisions =
    typeof item.revisions === "number" ? item.revisions : revisionsOf(typeof item.text === "string" ? item.text : "");
  const revisions = prevRevisions + (changed ? 1 : 0);
  const text = changed
    ? `${renderDeckText(item.title, slides)} (revised ${revisions}).`
    : typeof item.text === "string"
      ? item.text
      : renderDeckText(item.title, slides);
  return { ...item, slides, text, revisions };
}

function mockSlidesCreate(arg: any): any {
  const input = arg?.input ?? {};
  const title: string = typeof input.title === "string" ? input.title : "";
  const slides: any[] = Array.isArray(input.slides) ? input.slides : [];
  if (!title.trim()) throw new Error("slides-create: title must be a non-empty string");
  if (slides.length === 0) throw new Error("slides-create: slides must be a non-empty array (at least one slide)");
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    if (!s || typeof s.title !== "string" || !s.title.trim()) {
      throw new Error(`slides-create: slide ${i + 1} must have a non-empty string title`);
    }
    if (!Array.isArray(s.bullets)) {
      throw new Error(`slides-create: slide ${i + 1} ("${s.title}") bullets must be an array`);
    }
  }
  const clean: any[] = slides.map((s: any) => ({
    title: s.title,
    bullets: s.bullets.map((b: any) => String(b)),
    ...(typeof s.notes === "string" ? { notes: s.notes } : {}),
  }));
  const deckId = `deck-${crypto.createHash("sha256").update(`${title}\n${JSON.stringify(clean)}`).digest("hex").slice(0, 12)}`;
  return { deckId, title, slides: clean, text: renderDeckText(title, clean), revisions: 0 };
}

// The mock render computes the same paths + bytes as the real worker
// (same rendering) WITHOUT writing any file — a mock never writes.
function mockSlidesRender(arg: any): any {
  const input = arg?.input ?? {};
  const deck: any = input.deck ?? {};
  const outDir: string =
    typeof input.outDir === "string" && input.outDir ? input.outDir : ".agentts-scratch/presentations-out";
  const deckPath = `${outDir}/deck.json`;
  const markdownPath = `${outDir}/deck.md`;
  const deckJson = JSON.stringify(deck, null, 2);
  const markdown = renderDeckMarkdown(deck);
  return {
    ok: true,
    error: "",
    deckId: deck.deckId ?? "",
    deckPath,
    markdownPath,
    slides: deckSlides(deck).length,
    bytes: Buffer.byteLength(deckJson, "utf8") + Buffer.byteLength(markdown, "utf8"),
  };
}

// Shared plan-driven-work mock logic (BRA-117) — mirrors
// workflows/library/worker.ts's plan branch exactly (same criterion
// checks, same fix edits, same rendering, same content hashes).
// mockPlanDraft / mockPlanPhase compute the same plan / record as the
// real worker; a mock never runs a command phase's shell command
// (the mock exec is canned — see the exec branch in answer() — so a
// mock run's command-phase evidence is empty and its phase review
// hits the cap honestly instead of pretending the command ran).

function isPlanItem(item: any): boolean {
  return (
    item !== null &&
    typeof item === "object" &&
    Array.isArray(item.phases) &&
    typeof item.request === "string"
  );
}

function renderPlanText(plan: any): string {
  const lines: string[] = [`Plan: ${plan?.request ?? ""}`];
  const phases: any[] = Array.isArray(plan?.phases) ? plan.phases : [];
  phases.forEach((p: any, i: number) => {
    lines.push(`Phase ${i + 1}: ${p?.name ?? ""} — ${p?.description ?? ""}`);
    const exec =
      p?.kind === "command"
        ? `command: ${p?.command ?? ""}${Array.isArray(p?.args) && p.args.length ? ` ${p.args.join(" ")}` : ""}`
        : "agent (plan-phase)";
    lines.push(`  Executes via: ${exec}`);
    lines.push(`  Acceptance: ${p?.acceptance ?? ""}`);
    const deps: string[] = Array.isArray(p?.dependsOn) ? p.dependsOn : [];
    lines.push(`  Depends on: ${deps.length ? deps.join(", ") : "none"}`);
  });
  return lines.join("\n");
}

function mockPlanSequenced(plan: any): boolean {
  const phases: any[] = Array.isArray(plan?.phases) ? plan.phases : [];
  const seen = new Set<string>();
  for (const p of phases) {
    if (!p || typeof p.name !== "string" || !p.name) return false;
    const deps: string[] = Array.isArray(p.dependsOn) ? p.dependsOn : [];
    for (const d of deps) {
      if (d === p.name || !seen.has(d)) return false;
    }
    seen.add(p.name);
  }
  return true;
}

function mockPlanCriterionAddressed(criterion: string, plan: any): boolean {
  const first = criterion.toLowerCase().split(" ")[0];
  const text: string = typeof plan?.text === "string" ? plan.text : "";
  const phases: any[] = Array.isArray(plan?.phases) ? plan.phases : [];
  if (first === "covers-request") {
    return typeof plan?.request === "string" && plan.request.length > 0 && text.includes(plan.request);
  }
  if (first === "sequenced") return mockPlanSequenced(plan);
  if (first === "jobspec") {
    return phases.every((p) => {
      if (p?.kind === "agent") return true;
      if (p?.kind === "command") return typeof p.command === "string" && p.command.trim().length > 0;
      return false;
    });
  }
  if (first === "acceptance") {
    return phases.every((p) => typeof p?.acceptance === "string" && p.acceptance.trim().length > 0);
  }
  if (first === "review-points") {
    return Array.isArray(plan?.reviewPoints) && plan.reviewPoints.length > 0;
  }
  if (first === "gate-placement") {
    return typeof plan?.gatePlacement === "string" && plan.gatePlacement.trim().length > 0;
  }
  return text.toLowerCase().includes(first);
}

function mockJudgePlan(item: any, rubric: any, judgeIndex: number): any {
  const criteria: string[] = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  const weights = criteria.map((_c, i) =>
    i % Math.max(criteria.length, 1) === judgeIndex % Math.max(criteria.length, 1) ? 2 : 1,
  );
  let got = 0;
  let total = 0;
  const notes: string[] = [];
  criteria.forEach((c, i) => {
    const addressed = mockPlanCriterionAddressed(c, item);
    total += weights[i];
    if (addressed) got += weights[i];
    notes.push(`${c}: ${addressed ? "addressed" : "missing"}`);
  });
  const base = total > 0 ? got / total : 0;
  const score = Math.min(0.98, Math.round((base + 0.05 * revisionsOf(item.text ?? "")) * 100) / 100);
  return { score, label: score >= (rubric.threshold ?? 0.8) ? "approved" : "weak", notes: notes.join("; ") || "no criteria" };
}

function mockFixPlan(item: any, verdicts: any[]): any {
  const missed = new Set<string>();
  for (const v of verdicts) {
    if (typeof v?.notes !== "string") continue;
    for (const part of v.notes.split("; ")) {
      if (part.endsWith("missing")) missed.add(part.split(":")[0]);
    }
  }
  const phases: any[] = (Array.isArray(item?.phases) ? item.phases : []).map((p: any) => ({
    name: p?.name ?? "",
    description: p?.description ?? "",
    acceptance: p?.acceptance ?? "",
    kind: p?.kind ?? "agent",
    ...(typeof p?.command === "string" ? { command: p.command } : {}),
    ...(Array.isArray(p?.args) ? { args: [...p.args] } : {}),
    ...(typeof p?.cwd === "string" ? { cwd: p.cwd } : {}),
    dependsOn: Array.isArray(p?.dependsOn) ? [...p.dependsOn] : [],
  }));
  let reviewPoints: string[] | undefined = Array.isArray(item?.reviewPoints) ? [...item.reviewPoints] : undefined;
  let gatePlacement: string | undefined = typeof item?.gatePlacement === "string" ? item.gatePlacement : undefined;
  let changed = false;
  if (missed.has("review-points")) {
    reviewPoints = phases.map((p) => `Review "${p.name}" against its acceptance criterion.`);
    changed = true;
  }
  if (missed.has("gate-placement")) {
    gatePlacement = "Human approval at the gate between plan review and phase 1 execution.";
    changed = true;
  }
  if (missed.has("sequenced")) {
    phases.forEach((p, i) => {
      p.dependsOn = i === 0 ? [] : [phases[i - 1].name];
    });
    changed = true;
  }
  if (missed.has("acceptance")) {
    for (const p of phases) {
      if (typeof p.acceptance !== "string" || !p.acceptance.trim()) {
        p.acceptance = `Phase "${p.name}" completes with evidence recorded.`;
        changed = true;
      }
    }
  }
  if (missed.has("covers-request")) changed = true;
  const prevRevisions =
    typeof item.revisions === "number" ? item.revisions : revisionsOf(typeof item.text === "string" ? item.text : "");
  const revisions = prevRevisions + (changed ? 1 : 0);
  const plan: any = { ...item, phases, revisions };
  if (reviewPoints !== undefined) plan.reviewPoints = reviewPoints;
  if (gatePlacement !== undefined) plan.gatePlacement = gatePlacement;
  plan.text = changed
    ? `${renderPlanText(plan)} (revised ${revisions}).`
    : typeof item.text === "string"
      ? item.text
      : renderPlanText(plan);
  return plan;
}

// ------------------------------------------------------- rubric review
// The rubric-review workflow: a rubric-shaped item (kind "rubric")
// takes the rubric branch of mockJudge()/mockFix() instead of the
// generic text branch. Mirrors workflows/library/worker.ts exactly
// (same criterion checks, same fix edits, same guided answers).

const META_CRITERIA: { name: string; stem: string }[] = [
  { name: "coverage", stem: "coverage" },
  { name: "discrimination", stem: "discrimination" },
  { name: "anchored-scores", stem: "anchor" },
  { name: "actionability", stem: "actionab" },
  { name: "checkability", stem: "checkab" },
  { name: "independence", stem: "independen" },
  { name: "calibration", stem: "calibrat" },
  { name: "open-ended-feedback", stem: "open-ended" },
  { name: "drafter-shared", stem: "drafter" },
  { name: "anti-patterns", stem: "anti-pattern" },
  { name: "versioning", stem: "version" },
  { name: "no-process-in-prose", stem: "no process" },
  { name: "multiple-perspectives", stem: "perspective" },
  { name: "signs-of-generality", stem: "generality" },
];

function isRubricItem(item: any): boolean {
  return item !== null && typeof item === "object" && item.kind === "rubric" && typeof item.text === "string";
}

const RUBRIC_FIX_SENTENCES: Record<string, string> = {
  coverage:
    "Coverage: this rubric scores every quality dimension that distinguishes good work from bad work, including the subtle ones.",
  discrimination:
    "Discrimination: real work lands across the scale — mediocre work scores mid-range, good work high, great work at the top.",
  "anchored-scores":
    "Anchored scores: every criterion defines what 0, 5, and 10 mean in observable terms, with the interpolation rule.",
  actionability:
    "Actionability: every failing score names the concrete change — what to add, remove, or rewrite.",
  checkability:
    "Checkability: every criterion is verifiable from the artifact itself, with no intent-guessing.",
  independence:
    "Independence: the criteria are orthogonal — one flaw costs one score.",
  calibration:
    "Calibration: the threshold is calibrated against reference examples — a known-good artifact passes, a known-mediocre one fails.",
  "open-ended-feedback":
    "Open-ended feedback: judges give guided open-ended feedback every round, and it reaches the fix step alongside the scores.",
  "drafter-shared":
    "Drafter-shared: the rubric is written in plain actionable language and handed to the drafter before drafting begins.",
  "anti-patterns":
    "Anti-patterns: the known failure modes are named, each with its tell — what the judge will see when the failure is present.",
  versioning:
    "Versioning: this rubric is a versioned file with a change log, and every judging record names the version used.",
  "no-process-in-prose":
    "No process in prose: this rubric carries data only — perspectives, graded questions with anchors, open-ended questions.",
  "multiple-perspectives":
    "Multiple perspectives: the rubric is organized into distinct perspectives, each with anchored graded questions and open-ended questions.",
  "signs-of-generality":
    "Signs of generality: the criteria are written in class terms, the claimed scope matches what they cover, and a validation record is cited.",
};

function rubricMissedAddressed(item: any): { missed: string[]; addressed: string[] } {
  const text: string = typeof item?.text === "string" ? item.text : "";
  const lower = text.toLowerCase();
  const missed: string[] = [];
  const addressed: string[] = [];
  for (const c of META_CRITERIA) {
    if (lower.includes(c.stem)) addressed.push(c.name);
    else missed.push(c.name);
  }
  return { missed, addressed };
}

function mockJudgeRubric(item: any, rubric: any, judgeIndex: number): any {
  const { missed, addressed } = rubricMissedAddressed(item);
  const addressedSet = new Set(addressed);
  const weights = META_CRITERIA.map((_c, i) =>
    i % META_CRITERIA.length === judgeIndex % META_CRITERIA.length ? 2 : 1,
  );
  let got = 0;
  let total = 0;
  const scores: any[] = [];
  const notes: string[] = [];
  META_CRITERIA.forEach((c, i) => {
    const isAddressed = addressedSet.has(c.name);
    total += weights[i];
    if (isAddressed) got += weights[i];
    scores.push({
      criterion: c.name,
      score: isAddressed ? 10 : 0,
      reason: isAddressed
        ? `names ${c.name} (${c.stem} appears in the rubric)`
        : `does not name ${c.name} — no ${c.stem} in the rubric`,
    });
    notes.push(`${c.name}: ${isAddressed ? "addressed" : "missing"}`);
  });
  const base = total > 0 ? got / total : 0;
  const score = Math.round(base * 100) / 100;
  const missedPick = (offset: number): string | null =>
    missed.length ? missed[(judgeIndex + offset) % missed.length] : null;
  const addressedPick = addressed.length ? addressed[judgeIndex % addressed.length] : null;
  const q1 = missedPick(0);
  const q3 = missedPick(1) ?? META_CRITERIA[judgeIndex % META_CRITERIA.length].name;
  const guidedAnswers = [
    {
      question: 1,
      answer: q1
        ? `This rubric misses ${q1} entirely — a bad artifact could hide behind the absence of any ${q1} check.`
        : "No quality dimension is missed entirely — all 14 meta-criteria are named.",
    },
    {
      question: 2,
      answer:
        missed.length > 0
          ? `A rubric that checks only ${addressedPick ?? "structure"} and ignores ${missed.join(", ")} would pass this rubric while letting a thin artifact through.`
          : "No passing-but-bad construction found in this round — every meta-criterion is named.",
    },
    {
      question: 3,
      answer: `Two careful judges could disagree on ${q3}: the wording around ${q3} leaves room for interpretation.`,
    },
    {
      question: 4,
      answer:
        missed.length > 0
          ? `This rubric rewards ${addressedPick ?? "structure"} without checking ${missed[0]}.`
          : "Nothing rewarded that should not be, or punished that should not be, in this round.",
    },
    {
      question: 5,
      answer: "See the free-form feedback.",
    },
  ];
  const openFeedback =
    `Judge ${judgeIndex}: ${addressed.length} of 14 criteria addressed. ` +
    (missed.length ? `Missed: ${missed.join(", ")}. Strongest gap: ${missed[0]}.` : "No gap found in this round.");
  return {
    score,
    label: score >= (rubric.threshold ?? 0.8) ? "approved" : "weak",
    notes: notes.join("; "),
    scores,
    guidedAnswers,
    openFeedback,
  };
}

function mockFixRubric(item: any, verdicts: any[]): any {
  const missed = new Set<string>();
  for (const v of verdicts) {
    if (typeof v?.notes === "string") {
      for (const part of v.notes.split("; ")) {
        if (part.endsWith("missing")) missed.add(part.split(":")[0]);
      }
    }
    for (const a of v?.guidedAnswers ?? []) {
      if (typeof a?.answer !== "string" || a.question !== 1) continue;
      const m = a.answer.match(/misses (\S+) entirely/);
      if (m && META_CRITERIA.some((c) => c.name === m[1])) missed.add(m[1]);
    }
  }
  const sentences: string[] = [];
  for (const name of missed) {
    const s = RUBRIC_FIX_SENTENCES[name];
    if (s) sentences.push(s);
  }
  const text: string = typeof item?.text === "string" ? item.text : "";
  const n = revisionsOf(text) + 1;
  const newText = sentences.length ? `${text} (revised ${n}). ${sentences.join(" ")}` : `${text} (revised ${n}).`;
  return { ...item, text: newText };
}

function mockPlanDraft(arg: any): any {
  const input = arg?.input ?? {};
  const request: string = typeof input.request === "string" ? input.request : "";
  const context: string | undefined = typeof input.context === "string" ? input.context : undefined;
  const outlines: any[] = Array.isArray(input.phaseOutlines) ? input.phaseOutlines : [];
  if (!request.trim()) throw new Error("plan-draft: request must be a non-empty string");
  if (outlines.length === 0) {
    throw new Error("plan-draft: phaseOutlines must be a non-empty array (at least one phase)");
  }
  const names = new Set<string>();
  for (let i = 0; i < outlines.length; i++) {
    const o = outlines[i];
    if (!o || typeof o.name !== "string" || !o.name.trim()) {
      throw new Error(`plan-draft: phase ${i + 1} must have a non-empty string name`);
    }
    if (names.has(o.name)) throw new Error(`plan-draft: duplicate phase name "${o.name}"`);
    names.add(o.name);
    if (typeof o.description !== "string" || !o.description.trim()) {
      throw new Error(`plan-draft: phase "${o.name}" must have a non-empty string description`);
    }
    if (typeof o.acceptance !== "string" || !o.acceptance.trim()) {
      throw new Error(`plan-draft: phase "${o.name}" must have a non-empty string acceptance criterion`);
    }
    if (o.kind !== "agent" && o.kind !== "command") {
      throw new Error(`plan-draft: phase "${o.name}" kind must be "agent" or "command" (got ${JSON.stringify(o.kind)})`);
    }
    if (o.kind === "command" && (typeof o.command !== "string" || !o.command.trim())) {
      throw new Error(`plan-draft: command phase "${o.name}" must have a non-empty command`);
    }
    if (o.kind === "agent" && o.command !== undefined) {
      throw new Error(`plan-draft: agent phase "${o.name}" must not carry a command`);
    }
  }
  const earlier = new Set<string>();
  for (const o of outlines) {
    if (o.dependsOn !== undefined) {
      if (!Array.isArray(o.dependsOn)) {
        throw new Error(`plan-draft: phase "${o.name}" dependsOn must be an array of phase names`);
      }
      for (const d of o.dependsOn) {
        if (typeof d !== "string" || !earlier.has(d)) {
          throw new Error(
            `plan-draft: phase "${o.name}" depends on ${JSON.stringify(d)} — dependencies must name phases listed earlier in the plan`,
          );
        }
      }
    }
    earlier.add(o.name);
  }
  const phases: any[] = outlines.map((o: any, i: number) => ({
    name: o.name,
    description: o.description,
    acceptance: o.acceptance,
    kind: o.kind,
    ...(typeof o.command === "string" ? { command: o.command } : {}),
    ...(Array.isArray(o.args) ? { args: [...o.args] } : {}),
    ...(typeof o.cwd === "string" ? { cwd: o.cwd } : {}),
    dependsOn: o.dependsOn !== undefined ? [...o.dependsOn] : i === 0 ? [] : [outlines[i - 1].name],
  }));
  const plan: any = { request, phases, text: "", revisions: 0 };
  if (context !== undefined) plan.context = context;
  plan.text = renderPlanText(plan);
  return plan;
}

function mockPlanPhase(arg: any): any {
  const input = arg?.input ?? {};
  const phase: any = input.phase ?? {};
  const prior: any[] = Array.isArray(input.prior) ? input.prior : [];
  if (!phase || typeof phase.name !== "string" || !phase.name.trim()) {
    throw new Error("plan-phase: phase must have a non-empty string name");
  }
  if (typeof phase.description !== "string" || !phase.description.trim()) {
    throw new Error(`plan-phase: phase "${phase.name}" must have a non-empty string description`);
  }
  if (typeof phase.acceptance !== "string" || !phase.acceptance.trim()) {
    throw new Error(`plan-phase: phase "${phase.name}" must have a non-empty string acceptance criterion`);
  }
  if (phase.kind !== "agent") {
    throw new Error(
      `plan-phase: phase "${phase.name}" kind must be "agent" — command phases never reach this job (got ${JSON.stringify(phase.kind)})`,
    );
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify(phase)).digest("hex").slice(0, 12);
  const priorSummary = prior
    .map((p: any) => `${p?.phase ?? "?"}: ${p?.ok ? "ok" : "FAILED"} — ${p?.detail ?? ""}`)
    .join("; ");
  const evidence =
    `Phase "${phase.name}" executed via plan-phase: ${phase.description}` +
    (priorSummary ? ` Prior results: ${priorSummary}.` : " No prior phases.") +
    ` Content hash ${hash}.`;
  return { phase: phase.name, status: "executed", ok: true, evidence, detail: `plan-phase record ${hash}` };
}

// Shared improve-loop mock logic (identical in both mock copies —
// plugins/mock/src/mock-adapter.ts and plugins/mock/src/mock-plugin.ts.
// The swap test requires identical answers, so this block is
// inserted verbatim into both files; keep them in sync. It mirrors
// workflows/library/worker.ts's improve-* implementations exactly (same
// criterion checks, same dedupe/filter rules, same fix sentences),
// except improve-write, which computes the same paths + bytes
// WITHOUT writing files (a mock never writes).

const IMPROVE_VIVID = ["vivid", "bright", "russet", "flashed", "striking", "golden", "crimson", "blazing", "shimmering", "scarlet", "gleaming"];
const IMPROVE_CONCRETE = ["fox", "coat", "light", "morning", "dog", "river", "stone", "road", "cat", "house", "tree", "rain", "snow"];

function improveCriterionAddressed(criterion: string, text: string): boolean {
  const t = text.toLowerCase();
  const first = criterion.toLowerCase().split(" ")[0];
  if (first === "vivid") return IMPROVE_VIVID.some((w) => t.includes(w));
  if (first === "concrete") {
    if (/\d/.test(text)) return true;
    return IMPROVE_CONCRETE.some((w) => t.includes(w));
  }
  if (first === "concise") return text.split(/\s+/).filter(Boolean).length <= 25;
  return t.includes(first);
}

function improveSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "criterion";
}

function mockImproveJudge(arg: any): any {
  const input = arg?.input ?? {};
  const item = input.item ?? { content: "" };
  const rubric = input.rubric ?? { criteria: [], threshold: 0.8 };
  const criteria: any[] = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  const content: string = typeof item.content === "string" ? item.content : "";
  const judgeIndex = typeof input.judge === "number" ? input.judge : 0;
  const axisScores: any[] = [];
  const findings: any[] = [];
  let addressed = 0;
  let weightedGot = 0;
  let weightedTotal = 0;
  criteria.forEach((c: any, i: number) => {
    const name: string = typeof c?.name === "string" ? c.name : String(c ?? "");
    const description: string = typeof c?.description === "string" ? c.description : "";
    const isAddressed = improveCriterionAddressed(name, content);
    const weight = i % Math.max(criteria.length, 1) === judgeIndex % Math.max(criteria.length, 1) ? 2 : 1;
    weightedTotal += weight;
    if (isAddressed) {
      addressed++;
      weightedGot += weight;
    }
    axisScores.push({ criterion: name, score: isAddressed ? 1 : 0, note: isAddressed ? "addressed" : "not addressed" });
    const id = `finding-${improveSlug(name)}`;
    if (isAddressed) {
      findings.push({
        id,
        criterion: name,
        severity: "nit",
        detail: `"${name}": addressed, but could be strengthened`,
        suggestion: `Tighten the wording for "${name}".`,
      });
    } else {
      findings.push({
        id,
        criterion: name,
        severity: "major",
        detail: `"${name}": not addressed — ${description}`,
        suggestion: `Address the "${name}" criterion: ${description}`,
      });
    }
  });
  const mean = weightedTotal > 0 ? Math.round((weightedGot / weightedTotal) * 100) / 100 : 0;
  return {
    judge: judgeIndex,
    axisScores,
    findings,
    summary: `judge ${judgeIndex}: ${addressed} of ${criteria.length} axes addressed (weighted mean ${mean})`,
  };
}

function mockImproveAggregate(arg: any): any {
  const input = arg?.input ?? {};
  const scorecards: any[] = Array.isArray(input.scorecards) ? input.scorecards : [];
  const findings: any[] = [];
  const dropped: any[] = [];
  const seen = new Set<string>();
  for (const sc of scorecards) {
    for (const f of sc?.findings ?? []) {
      if (!f || typeof f.id !== "string") continue;
      if (seen.has(f.id)) {
        dropped.push({ finding: f, reason: "duplicate" });
      } else {
        seen.add(f.id);
        findings.push(f);
      }
    }
  }
  const hasSevere = findings.some((f: any) => f.severity === "blocking" || f.severity === "major");
  const kept: any[] = [];
  if (hasSevere) {
    for (const f of findings) {
      if (f.severity === "nit") dropped.push({ finding: f, reason: "nit filtered: higher-severity findings present" });
      else kept.push(f);
    }
  } else {
    kept.push(...findings);
  }
  let meanSum = 0;
  for (const sc of scorecards) {
    const axes: any[] = Array.isArray(sc?.axisScores) ? sc.axisScores : [];
    const judgeIndex = typeof sc?.judge === "number" ? sc.judge : 0;
    let got = 0;
    let total = 0;
    axes.forEach((a: any, i: number) => {
      const weight = i % Math.max(axes.length, 1) === judgeIndex % Math.max(axes.length, 1) ? 2 : 1;
      total += weight;
      if (a?.score === 1) got += weight;
    });
    meanSum += total > 0 ? got / total : 0;
  }
  const meanScore = scorecards.length ? Math.round((meanSum / scorecards.length) * 100) / 100 : 0;
  return {
    findings: kept,
    dropped,
    meanScore,
    summary: `${kept.length} findings, ${dropped.length} dropped, mean ${meanScore}`,
  };
}

function mockImproveDecide(arg: any): any {
  const input = arg?.input ?? {};
  const aggregated = input.aggregated ?? { findings: [], dropped: [], meanScore: 0, summary: "" };
  const findings: any[] = Array.isArray(aggregated.findings) ? aggregated.findings : [];
  const severe = findings.filter((f: any) => f.severity === "blocking" || f.severity === "major");
  if (!severe.length) {
    return { needsFix: false, fixes: [], reason: "no blocking/major findings — no fixes needed" };
  }
  return {
    needsFix: true,
    fixes: severe.map((f: any) => ({ findingId: f.id, action: f.suggestion })),
    reason: `${severe.length} finding(s) need fixes: ${severe.map((f: any) => f.id).join(", ")}`,
  };
}

function mockImproveFix(arg: any): any {
  const input = arg?.input ?? {};
  const item = input.item ?? { content: "" };
  const rubric = input.rubric ?? { criteria: [], threshold: 0.8 };
  const decision = input.decision ?? { needsFix: false, fixes: [], reason: "" };
  const aggregated = input.aggregated ?? { findings: [], dropped: [], meanScore: 0, summary: "" };
  const findings: any[] = Array.isArray(aggregated.findings) ? aggregated.findings : [];
  const byId = new Map<string, any>(findings.map((f: any) => [f.id, f]));
  const criteria: any[] = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  const descByName = new Map<string, string>(criteria.map((c: any) => [c?.name, c?.description ?? ""]));
  const content: string = typeof item.content === "string" ? item.content : "";
  const n = (content.match(/\(revised/g) ?? []).length + 1;
  const sentences: string[] = [];
  const changes: any[] = [];
  for (const fix of decision.fixes ?? []) {
    const f = byId.get(fix.findingId);
    if (!f) continue;
    const name: string = f.criterion ?? "";
    const first = name.toLowerCase().split(" ")[0];
    if (first === "concise") continue; // cannot fix by appending
    let sentence: string;
    if (first === "vivid") {
      sentence = "A vivid, golden example brings the point to life.";
    } else if (first === "concrete") {
      sentence = "In 2026, 3 pilot teams ran this process end to end.";
    } else {
      sentence = `${name}: ${descByName.get(name) ?? f.detail ?? ""} (revised ${n}).`;
    }
    sentences.push(sentence);
    changes.push({
      round: 0,
      findingId: f.id,
      description: `Added coverage for '${name}': ${sentence}`,
      why: f.detail,
    });
  }
  const newContent = sentences.length
    ? `${content} (revised ${n}). ${sentences.join(" ")}`
    : content;
  return { item: { ...item, content: newContent }, changes };
}

// The mock write computes the same paths + bytes as the real worker
// (same rendering) WITHOUT writing any file — a mock never writes.
function mockImproveWrite(arg: any): any {
  const input = arg?.input ?? {};
  const item = input.item ?? { kind: "", description: "", content: "" };
  const report = input.report ?? { rounds: 0, converged: false, changes: [], outstanding: [], finalMeanScore: 0, summary: "" };
  const outDir: string = typeof input.outDir === "string" && input.outDir ? input.outDir : ".agentts-scratch/improve-loop-out";
  const improvedPath = `${outDir}/improved.md`;
  const reportPath = `${outDir}/change-report.json`;
  const improved = `# ${item.description}\n\n_kind: ${item.kind}_\n\n${item.content}` + (item.ref ? `\n\nSource: ${item.ref}` : "");
  const reportJson = JSON.stringify(report, null, 2);
  return {
    ok: true,
    error: "",
    improvedPath,
    reportPath,
    bytes: Buffer.byteLength(improved, "utf8") + Buffer.byteLength(reportJson, "utf8"),
  };
}

export class MockAdapter implements Adapter {
  readonly name = "mock";
  readonly gates: "auto" | "hold";
  private answerQueues = new Map<string, TrapAnswer[]>();
  private cannedFns = new Map<string, CannedFn>();
  private gateQueue: unknown[] = [];

  constructor(opts: { gates?: "auto" | "hold" } = {}) {
    this.gates = opts.gates ?? "auto";
  }

  queueAnswer(type: string, answer: TrapAnswer | unknown): void {
    const list = this.answerQueues.get(type) ?? [];
    list.push(
      answer !== null && typeof answer === "object" && ("value" in (answer as any) || "throw" in (answer as any))
        ? (answer as TrapAnswer)
        : { value: answer },
    );
    this.answerQueues.set(type, list);
  }

  setCanned(type: string, fn: CannedFn): void {
    this.cannedFns.set(type, fn);
  }

  queueGateAnswer(answer: unknown): void {
    this.gateQueue.push(answer);
  }

  private mockJob(arg: any): any {
    // Bug-fix workflow specs (Phase 2, BRA-54): the same bugfix
    // worker code, run in-process with simulate: true — deterministic
    // simulation for fast iteration under --adapter mock (reproduce
    // statically checks the canned decide, fix dry-runs the patch,
    // test/verify report the post-fix signature). Simulated results
    // always carry simulated: true; the direct adapter spawns the
    // worker process and executes everything for real.
    if (arg && typeof arg.spec === "string" && arg.spec.startsWith("bugfix-")) {
      return runBugfix(arg.spec, arg.input ?? {}, { simulate: true });
    }
    if (arg && typeof arg.spec === "string") {
      // Improve-loop specs (standard library): input-dependent mock
      // answers — the same logic as the real workers (see the block
      // above), so the mock run shows a real improving arc.
      if (arg.spec === "improve-judge") return mockImproveJudge(arg);
      if (arg.spec === "improve-aggregate") return mockImproveAggregate(arg);
      if (arg.spec === "improve-decide") return mockImproveDecide(arg);
      if (arg.spec === "improve-fix") return mockImproveFix(arg);
      if (arg.spec === "improve-write") return mockImproveWrite(arg);
      if (arg.spec === "judge") return mockJudge(arg);
      if (arg.spec === "fix") return mockFix(arg);
      if (arg.spec === "rubric-update") return mockRubricUpdate(arg);
      // Presentations specs (BRA-109): input-dependent mock answers —
      // the same logic as the real workers (see the block above), so
      // the mock run shows a real improving arc.
      if (arg.spec === "slides-create") return mockSlidesCreate(arg);
      if (arg.spec === "slides-render") return mockSlidesRender(arg);
      // Plan-driven-work specs (BRA-117): input-dependent mock
      // answers — the same logic as the real workers (see the block
      // above), so the mock run shows a real improving arc.
      if (arg.spec === "plan-draft") return mockPlanDraft(arg);
      if (arg.spec === "plan-phase") return mockPlanPhase(arg);
      // BRA-47: the cascade's job tier ("decision" jobspec). No canned
      // decision exists — the mock answers the first option at 0.5, a
      // deliberate guess: a cascade tier at/above its threshold would
      // need a queued answer, and an unconfigured mock run escalates
      // instead of deciding on a made-up confidence.
      if (arg.spec === "decision") {
        const options: string[] = Array.isArray(arg.input?.options) ? arg.input.options : [];
        return {
          choice: options[0] ?? "yes",
          confidence: 0.5,
          reason: "mock default: no canned decision answer; first option at 0.5",
        };
      }
      if (arg.spec === "aggregate") {
        // Two shapes share the "aggregate" spec across workflows, and
        // the adapter is shared too — distinguish by the INPUT shape:
        // Outcome objects ({ok}) count ok/failed (the judges
        // workflow); JudgeVerdicts ({score}) reduce to a mean (JFL).
        // The extractor never confuses them (one extraction per
        // workflow); only the shared adapter must look at the input.
        const verdicts = Array.isArray(arg.input?.verdicts) ? arg.input.verdicts : [];
        if (verdicts.some((v: any) => v && typeof v === "object" && typeof v.ok === "boolean")) {
          const ok = verdicts.filter((v: any) => v.ok).length;
          return {
            approved: ok,
            failed: verdicts.length - ok,
            summary: `${ok} approved, ${verdicts.length - ok} failed`,
          };
        }
        return mockAggregate(arg);
      }
      const key = `${arg.spec}:${arg.input?.value}`;
      if (key in MOCK) return MOCK[key];
      console.error(`[mock] no canned result for ${key}; using default`);
      return { score: 0.5, label: "default" };
    }
    if (arg && arg.op === "aggregate") {
      const verdicts = arg.verdicts || [];
      const ok = verdicts.filter((v: any) => v.ok).length;
      return {
        approved: ok,
        failed: verdicts.length - ok,
        summary: `${ok} approved, ${verdicts.length - ok} failed`,
      };
    }
    const key = `${arg?.op}:${arg?.value}`;
    if (key in MOCK) return MOCK[key];
    console.error(`[mock] no canned result for ${key}; using default`);
    return { score: 0.5, label: "default" };
  }

  answer(type: string, arg: any, ctx: TrapContext): TrapAnswer | typeof HOLD {
    const queued = this.answerQueues.get(type);
    if (queued && queued.length) return queued.shift()!;
    const fn = this.cannedFns.get(type);
    if (fn) {
      const a = fn(type, arg, ctx);
      if (a !== undefined) return a;
    }
    switch (type) {
      case "job":
        return { value: this.mockJob(arg) };
      case "exec": {
        // `cat <file>` reads the file for real — rubric-file
        // resolution (improve-loop) depends on it, and the mock
        // cannot canned-answer a file it has never seen.
        if (arg?.cmd === "cat" && typeof arg?.args?.[0] === "string") {
          try {
            return { value: { stdout: fs.readFileSync(arg.args[0], "utf8"), stderr: "", exitCode: 0 } };
          } catch (e: any) {
            return { value: { stdout: "", stderr: e?.message ?? String(e), exitCode: 1 } };
          }
        }
        // `echo hi` is the mock's one canned literal that behaves
        // like a real command — it stays silent, like cat.
        if (arg?.cmd === "echo hi") {
          return { value: { stdout: "hi\n", exitCode: 0 } };
        }
        // BRA-120: everything else is canned — the command was NOT
        // run, and the mock used to return the simulated success
        // silently, so a real workflow under mock passed vacuously.
        // Say so loudly, naming the command, and mark the answer
        // so the host journals it. The mock still never runs the
        // command (Brandon, Nov 18) — this is a signal, not a
        // behavior change. A queued exec answer never reaches here
        // (deliberate, answered above), so it is never marked.
        const display = [arg?.cmd, ...(Array.isArray(arg?.args) ? arg.args : [])]
          .filter((x) => typeof x === "string")
          .join(" ");
        console.error(
          `[mock] CANNED EXEC: command "${display}" was NOT run — returning simulated {stdout: "", exitCode: 0}. Only cat and echo hi execute for real under --adapter mock.`,
        );
        return { value: { stdout: "", exitCode: 0 }, canned: true };
      }
      case "gate": {
        if (this.gateQueue.length) return { value: this.gateQueue.shift() };
        if (this.gates === "hold") return HOLD;
        // BRA-119: the silent auto-"yes". A gate answered this way
        // had no human behind it — mark it `auto` (host-side-only
        // provenance, see TrapAnswer) so the host logs it loudly
        // and marks the journal event. A queued answer above is
        // deliberate and is never marked.
        return { value: { answer: "yes" }, auto: true };
      }
      case "decide":
        return { value: { choice: "a", confidence: 0.9 } };
      default:
        console.error(`[mock] unknown trap type ${type}; using default`);
        return { value: { score: 0.5, label: "default" } };
    }
  }
}
