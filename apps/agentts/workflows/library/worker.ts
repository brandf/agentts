#!/usr/bin/env bun
/**
 * worker — the direct adapter's worker process (BRA-44, v0).
 *
 * One worker process per job trap: the direct adapter spawns
 * `bun worker.ts '<json {spec, input}>'` and reads the result JSON
 * from the last stdout line. The work here is GENUINE computation
 * over the actual input — not canned answers: judges score the item
 * against the rubric's criteria with real keyword/coverage checks,
 * fix revises the text to address the missed criteria, aggregate
 * reduces the verdicts, rubric-update adds a criterion for a
 * repeated miss. Deterministic: same input, same output.
 *
 * Judge scoring (per criterion, then averaged):
 *  - "vivid": the text contains a vivid word (vivid, bright, russet,
 *    flashed, striking, golden, crimson, blazing, shimmering).
 *  - "concrete": the text contains a concrete detail (a number, a
 *    proper name, or a concrete noun: fox, coat, light, morning,
 *    dog, river, stone, road).
 *  - "concise": the text is at most 25 words.
 *  - any other criterion: the text contains its first word.
 * A criterion scores 1 if addressed, else 0; the verdict score is
 * the fraction addressed, nudged +0.05 per revision marker
 * ("(revised N)") up to 0.98 — revisions genuinely improve the text,
 * so later loops score higher. Notes name each criterion addressed /
 * missing, which is what the fix worker and the rubric decide read.
 *
 * Presentations (BRA-109): a deck-shaped item (an object with a
 * `slides` array) takes the deck branch of judge()/fix() instead.
 * The deck branch scores the four presentation criteria
 * structurally: "one-idea" (at most 5 bullets per slide), "concise"
 * (every bullet at most 12 words), "concrete" (a number or concrete
 * noun in the deck text), "complete" (every slide has at least one
 * bullet); any other criterion falls back to first-word containment
 * in the deck text. The "concrete" / fallback checks run over titles
 * + bullets only, not the rendered text — the rendering's "Slide N:"
 * lines carry digits that would trip the number check for every deck. The deck fix genuinely edits the deck — it fills
 * empty slides, shortens long bullets, adds a concrete bullet to the
 * slide with the fewest bullets, and trims over-full slides to 5
 * bullets, in that order, so the added bullet never gets trimmed
 * away; the trim keeps number-bearing ("evidence") bullets first so
 * a concrete bullet survives a later trim of the same slide. The
 * revision marker is appended only when the fix actually changed
 * something — an unknown criterion (a custom rubric the fix does not
 * know) leaves the deck untouched and the loop hits the cap honestly.
 * The `slides-create` / `slides-render` specs below are the Slides
 * steps: create validates the outline and builds the deck locally
 * (deterministic deck id, no live Google Slides call in v0), render
 * writes deck.json + deck.md. The mock adapter mirrors all of this
 * (same criterion checks, same fix edits, same renderings).
 */
import * as fs from "node:fs";
import * as crypto from "node:crypto";
const payload = JSON.parse(process.argv[2] ?? "{}");
const spec: string = payload.spec;
const input: any = payload.input ?? {};

function revisionsOf(text: string): number {
  return (text.match(/\(revised/g) ?? []).length;
}

const VIVID = ["vivid", "bright", "russet", "flashed", "striking", "golden", "crimson", "blazing", "shimmering", "scarlet", "gleaming"];
const CONCRETE = ["fox", "coat", "light", "morning", "dog", "river", "stone", "road", "cat", "house", "tree", "rain", "snow"];

function criterionAddressed(criterion: string, text: string): boolean {
  const t = text.toLowerCase();
  const first = criterion.toLowerCase().split(" ")[0];
  if (first === "vivid") return VIVID.some((w) => t.includes(w));
  if (first === "concrete") {
    if (/\d/.test(text)) return true;
    return CONCRETE.some((w) => t.includes(w));
  }
  if (first === "concise") return text.split(/\s+/).filter(Boolean).length <= 25;
  return t.includes(first);
}

function judge(): any {
  const item = input.item ?? { text: "", goal: "" };
  const rubric = input.rubric ?? { criteria: [], threshold: 0.8 };
  // A deck-shaped item takes the deck branch (BRA-109).
  if (isDeckItem(item)) return judgeDeck(item, rubric, typeof input.judge === "number" ? input.judge : 0);
  // A plan-shaped item takes the plan branch (BRA-117).
  if (isPlanItem(item)) return judgePlan(item, rubric, typeof input.judge === "number" ? input.judge : 0);
  // A rubric-shaped item takes the rubric branch (rubric review).
  if (isRubricItem(item)) return judgeRubric(item, rubric, typeof input.judge === "number" ? input.judge : 0);
  const criteria: string[] = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  const text: string = typeof item.text === "string" ? item.text : "";
  const judgeIndex = typeof input.judge === "number" ? input.judge : 0;
  // Judges differ: each weights one criterion double (judge 0 vivid,
  // judge 1 concrete, judge 2 concise) — independent judges, not
  // identical copies.
  const weights = criteria.map((c) => {
    const first = c.toLowerCase().split(" ")[0];
    if (judgeIndex === 0 && first === "vivid") return 2;
    if (judgeIndex === 1 && first === "concrete") return 2;
    if (judgeIndex === 2 && first === "concise") return 2;
    return 1;
  });
  let got = 0;
  let total = 0;
  const notes: string[] = [];
  criteria.forEach((c, i) => {
    const addressed = criterionAddressed(c, text);
    total += weights[i];
    if (addressed) got += weights[i];
    notes.push(`${c}: ${addressed ? "addressed" : "missing"}`);
  });
  const base = total > 0 ? got / total : 0;
  const score = Math.min(0.98, Math.round((base + 0.05 * revisionsOf(text)) * 100) / 100);
  return { score, label: score >= (rubric.threshold ?? 0.8) ? "approved" : "weak", notes: notes.join("; ") || "no criteria" };
}

function fix(): any {
  const item = input.item ?? { text: "", goal: "" };
  const verdicts: any[] = Array.isArray(input.verdicts) ? input.verdicts : [];
  // A deck-shaped item takes the deck branch (BRA-109).
  if (isDeckItem(item)) return fixDeck(item, verdicts);
  // A plan-shaped item takes the plan branch (BRA-117).
  if (isPlanItem(item)) return fixPlan(item, verdicts);
  // A rubric-shaped item takes the rubric branch (rubric review).
  if (isRubricItem(item)) return fixRubric(item, verdicts);
  const n = revisionsOf(item.text) + 1;
  const missed = new Set<string>();
  for (const v of verdicts) {
    if (typeof v?.notes !== "string") continue;
    for (const part of v.notes.split("; ")) {
      if (part.endsWith("missing")) missed.add(part.split(":")[0]);
    }
  }
  const additions: string[] = [];
  if (missed.has("vivid")) additions.push("The fox's russet coat flashed golden in the morning light.");
  if (missed.has("concrete")) additions.push("It was the third morning the fox had crossed the stone road.");
  if (missed.has("concise")) additions.push(""); // concision comes from tightening, not adding
  const addition = additions.filter(Boolean).join(" ");
  const text = addition ? `${item.text} (revised ${n}). ${addition}` : `${item.text} (revised ${n}).`;
  return { text, goal: item.goal ?? "" };
}

function aggregate(): any {
  const verdicts: any[] = Array.isArray(input.verdicts) ? input.verdicts : [];
  const failed: number = typeof input.failed === "number" ? input.failed : 0;
  const threshold: number = typeof input.threshold === "number" ? input.threshold : 0.8;
  // Outcome-shaped verdicts ({ok}) count ok/failed (the judges
  // workflow); JudgeVerdicts ({score}) reduce to a mean (JFL). See
  // the mock adapter for why one spec carries two shapes.
  if (verdicts.some((v) => v && typeof v === "object" && typeof v.ok === "boolean")) {
    const ok = verdicts.filter((v) => v.ok).length;
    return { approved: ok, failed: verdicts.length - ok, summary: `${ok} approved, ${verdicts.length - ok} failed` };
  }
  const scores = verdicts.map((v) => (typeof v?.score === "number" ? v.score : null)).filter((s) => s !== null);
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const approved = scores.filter((s) => s >= threshold).length;
  // Open-feedback themes (rubric review): the Q2 adversarial probe
  // answers plus the free-form feedback, deduped first-seen, so the
  // aggregate summarizes recurring themes alongside the mean score.
  const openFeedbackThemes: string[] = [];
  const seenThemes = new Set<string>();
  for (const v of verdicts) {
    const texts: string[] = [
      ...(Array.isArray(v?.guidedAnswers)
        ? v.guidedAnswers.filter((a: any) => a?.question === 2).map((a: any) => a.answer)
        : []),
      ...(typeof v?.openFeedback === "string" ? [v.openFeedback] : []),
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

function rubricUpdate(): any {
  const rubric = input.rubric ?? { criteria: [], threshold: 0.8 };
  // A text rubric (the meta-rubric) is versioned human-owned prose:
  // v0 never rewrites it. Return it unchanged — the loop records the
  // update round and needs two more loops before convergence.
  if (typeof rubric.text === "string") {
    return { text: rubric.text, threshold: rubric.threshold ?? 0.8 };
  }
  const verdicts: any[] = Array.isArray(input.verdicts) ? input.verdicts : [];
  const criteria: string[] = [...(rubric.criteria ?? [])];
  const missed = new Set<string>();
  for (const v of verdicts) {
    if (typeof v?.notes !== "string") continue;
    for (const part of v.notes.split("; ")) {
      if (part.endsWith("missing")) missed.add(part.split(":")[0]);
    }
  }
  // A repeated miss the rubric does not name yet becomes a criterion.
  if (missed.size > 0 && !criteria.includes("concrete example")) criteria.push("concrete example");
  return { criteria, threshold: rubric.threshold ?? 0.8 };
}

// ------------------------------------------------------- presentations
// The presentations workflow (BRA-109): deck-shaped JudgeFixLoop
// items + the slides-create / slides-render specs. Mirrored in the
// mock adapter (plugins/mock/src/mock-adapter.ts) — keep the two in
// sync, same criterion checks, same fix edits, same renderings.

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

/** The deck's text rendering: the title, then one line per slide
 * title and one `- bullet` line per bullet. The judges score the
 * "concrete" criterion (and any fallback criterion) against this. */
function renderDeckText(title: string, slides: any[]): string {
  const lines: string[] = [String(title ?? "")];
  slides.forEach((s: any, i: number) => {
    lines.push(`Slide ${i + 1}: ${s?.title ?? ""}`);
    for (const b of deckBullets(s)) lines.push(`- ${b}`);
  });
  return lines.join("\n");
}

/** The deck's markdown rendering (slides-render / mock render share
 * this exactly — same bytes, the mock just does not write files). */
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

function deckCriterionAddressed(criterion: string, deck: any): boolean {
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
  if (first === "concrete") return criterionAddressed("concrete", searchText);
  if (first === "complete") return slides.length > 0 && slides.every((s) => deckBullets(s).length >= 1);
  return searchText.toLowerCase().includes(first);
}

/** Deck judge: one weighted score per criterion (judge j doubles
 * criterion j, as in improve-judge), nudged +0.05 per revision
 * marker up to 0.98. Notes name each criterion addressed / missing,
 * which is what the fix worker and the rubric decide read. */
function judgeDeck(item: any, rubric: any, judgeIndex: number): any {
  const criteria: string[] = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  const weights = criteria.map((_c, i) =>
    i % Math.max(criteria.length, 1) === judgeIndex % Math.max(criteria.length, 1) ? 2 : 1,
  );
  let got = 0;
  let total = 0;
  const notes: string[] = [];
  criteria.forEach((c, i) => {
    const addressed = deckCriterionAddressed(c, item);
    total += weights[i];
    if (addressed) got += weights[i];
    notes.push(`${c}: ${addressed ? "addressed" : "missing"}`);
  });
  const base = total > 0 ? got / total : 0;
  const score = Math.min(0.98, Math.round((base + 0.05 * revisionsOf(item.text ?? "")) * 100) / 100);
  return { score, label: score >= (rubric.threshold ?? 0.8) ? "approved" : "weak", notes: notes.join("; ") || "no criteria" };
}

/** Deck fix: genuinely edits the deck to address the missed
 * criteria, in dependency order — fill empty slides, shorten long
 * bullets, add the concrete bullet to the slide with the fewest
 * bullets, then trim over-full slides (keeping number-bearing
 * "evidence" bullets first, so the concrete bullet survives the
 * trim). An unknown criterion gets no edit. The revision marker is
 * appended only when something actually changed. */
function fixDeck(item: any, verdicts: any[]): any {
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

// Slides-create: validate the outline and build the deck locally.
// v0 does NOT call the live Google Slides API — the deck id is a
// deterministic content hash (`deck-<sha256[0:12] of title +
// slides>`), and a live Slides adapter plugs into this same spec
// later. An invalid outline throws: the run fails loudly before any
// review work, naming the problem.
function slidesCreate(): any {
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

// Slides-render: write the final deck as deck.json + deck.md.
function slidesRender(): any {
  const deck: any = input.deck ?? {};
  const outDir: string =
    typeof input.outDir === "string" && input.outDir ? input.outDir : ".agentts-scratch/presentations-out";
  const deckPath = `${outDir}/deck.json`;
  const markdownPath = `${outDir}/deck.md`;
  const deckJson = JSON.stringify(deck, null, 2);
  const markdown = renderDeckMarkdown(deck);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(deckPath, deckJson);
    fs.writeFileSync(markdownPath, markdown);
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message ?? String(e),
      deckId: deck.deckId ?? "",
      deckPath,
      markdownPath,
      slides: deckSlides(deck).length,
      bytes: 0,
    };
  }
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

// ------------------------------------------------------- improve-loop
// The improve-loop workers (v0, deterministic keyword/coverage —
// see plugins/muse/jobspecs/improve-*.md). They share the same
// criterionAddressed() as the JFL judge, but over the improve-loop
// contracts: the item's `content` (not `text`), rubric criteria as
// {name, description} objects (not bare strings).
//
// Judge: one axis per criterion (1 addressed, 0 missing); judge j
// doubles axis j (mod axis count) in the weighted mean. A missed
// axis is a "major" finding; an addressed axis is a "nit" finding
// (the aggregate drops nits when a major exists). v0 emits only
// major + nit — no "blocking" (the type keeps it for future workers).
function improveSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "criterion";
}

function improveJudge(): any {
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
  criteria.forEach((c, i) => {
    const name: string = typeof c?.name === "string" ? c.name : String(c ?? "");
    const description: string = typeof c?.description === "string" ? c.description : "";
    const isAddressed = criterionAddressed(name, content);
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

// Aggregate: dedupe by finding id (keep first, drop the rest as
// "duplicate"); filter nits when any blocking/major finding exists
// (reason "nit filtered: higher-severity findings present"); keep
// nits when they are all there is. meanScore is the mean over
// scorecards of the weighted axis means (recomputed from each
// scorecard's judge index — judge j doubles axis j).
function improveAggregate(): any {
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
  const hasSevere = findings.some((f) => f.severity === "blocking" || f.severity === "major");
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
    axes.forEach((a, i) => {
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

// Decide: needsFix when any blocking/major finding exists; the fixes
// are those findings, action = the finding's suggestion.
function improveDecide(): any {
  const aggregated = input.aggregated ?? { findings: [], dropped: [], meanScore: 0, summary: "" };
  const findings: any[] = Array.isArray(aggregated.findings) ? aggregated.findings : [];
  const severe = findings.filter((f) => f.severity === "blocking" || f.severity === "major");
  if (!severe.length) {
    return { needsFix: false, fixes: [], reason: "no blocking/major findings — no fixes needed" };
  }
  return {
    needsFix: true,
    fixes: severe.map((f) => ({ findingId: f.id, action: f.suggestion })),
    reason: `${severe.length} finding(s) need fixes: ${severe.map((f) => f.id).join(", ")}`,
  };
}

// Fix: for each fix, look up the finding and append a sentence that
// addresses its criterion. "concise" cannot be fixed by appending
// (appending makes text longer) — it is skipped, no change recorded.
// The round is NOT in FixInput (the workflow owns it and stamps it
// onto the changes) — the change records carry round 0 here.
function improveFix(): any {
  const item = input.item ?? { content: "" };
  const rubric = input.rubric ?? { criteria: [], threshold: 0.8 };
  const decision = input.decision ?? { needsFix: false, fixes: [], reason: "" };
  const aggregated = input.aggregated ?? { findings: [], dropped: [], meanScore: 0, summary: "" };
  const findings: any[] = Array.isArray(aggregated.findings) ? aggregated.findings : [];
  const byId = new Map<string, any>(findings.map((f) => [f.id, f]));
  const criteria: any[] = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  const descByName = new Map<string, string>(criteria.map((c) => [c?.name, c?.description ?? ""]));
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

// Write: render improved.md + change-report.json into outDir.
function improveWrite(): any {
  const item = input.item ?? { kind: "", description: "", content: "" };
  const report = input.report ?? { rounds: 0, converged: false, changes: [], outstanding: [], finalMeanScore: 0, summary: "" };
  const outDir: string = typeof input.outDir === "string" && input.outDir ? input.outDir : ".agentts-scratch/improve-loop-out";
  const improvedPath = `${outDir}/improved.md`;
  const reportPath = `${outDir}/change-report.json`;
  const improved = `# ${item.description}\n\n_kind: ${item.kind}_\n\n${item.content}` + (item.ref ? `\n\nSource: ${item.ref}` : "");
  const reportJson = JSON.stringify(report, null, 2);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(improvedPath, improved);
    fs.writeFileSync(reportPath, reportJson);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), improvedPath, reportPath, bytes: 0 };
  }
  return {
    ok: true,
    error: "",
    improvedPath,
    reportPath,
    bytes: Buffer.byteLength(improved, "utf8") + Buffer.byteLength(reportJson, "utf8"),
  };
}

// ------------------------------------------------------- plan-driven-work
// The plan-driven-work template (BRA-117): the plan-draft /
// plan-phase specs plus the plan branch of judge()/fix(). Mirrored
// in the mock adapter (plugins/mock/src/mock-adapter.ts) — keep the
// two in sync, same criterion checks, same fix edits.
//
// Plan judge: one weighted score per criterion (judge j doubles
// criterion j, as in the deck judge), nudged +0.05 per revision
// marker up to 0.98. The criteria are structural — the plan is
// data, not prose: "covers-request" (the rendered text carries the
// request), "sequenced" (dependsOn names earlier phases only, no
// cycles, no self-dependency), "jobspec" (every phase names how it
// executes: kind agent|command, and a command for command phases),
// "acceptance" (every phase has a non-empty acceptance criterion),
// "review-points" (reviewPoints is a non-empty array),
// "gate-placement" (gatePlacement is a non-empty string); any other
// criterion falls back to first-word containment in the plan text.
// Plan fix: genuinely edits the plan — adds review points (one per
// phase), states the gate placement, repairs a broken sequence to
// a serial chain, fills a missing acceptance with a default. A
// criterion the fix does not know (a custom rubric criterion
// outside the six) stays outstanding and the loop hits the cap
// honestly instead of pretending to improve. The revision marker
// is appended only when the fix actually changed something.

function isPlanItem(item: any): boolean {
  return (
    item !== null &&
    typeof item === "object" &&
    Array.isArray(item.phases) &&
    typeof item.request === "string"
  );
}

/** The plan's rendered text: the request, then one block per phase
 * (name, description, how it executes, acceptance, dependencies).
 * The judges score "covers-request" against this. */
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

/** Is the plan's dependency graph a valid DAG over earlier phases
 * only (a phase may only depend on phases listed before it)? */
function planSequenced(plan: any): boolean {
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

function planCriterionAddressed(criterion: string, plan: any): boolean {
  const first = criterion.toLowerCase().split(" ")[0];
  const text: string = typeof plan?.text === "string" ? plan.text : "";
  const phases: any[] = Array.isArray(plan?.phases) ? plan.phases : [];
  if (first === "covers-request") {
    return typeof plan?.request === "string" && plan.request.length > 0 && text.includes(plan.request);
  }
  if (first === "sequenced") return planSequenced(plan);
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

function judgePlan(item: any, rubric: any, judgeIndex: number): any {
  const criteria: string[] = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  const weights = criteria.map((_c, i) =>
    i % Math.max(criteria.length, 1) === judgeIndex % Math.max(criteria.length, 1) ? 2 : 1,
  );
  let got = 0;
  let total = 0;
  const notes: string[] = [];
  criteria.forEach((c, i) => {
    const addressed = planCriterionAddressed(c, item);
    total += weights[i];
    if (addressed) got += weights[i];
    notes.push(`${c}: ${addressed ? "addressed" : "missing"}`);
  });
  const base = total > 0 ? got / total : 0;
  const score = Math.min(0.98, Math.round((base + 0.05 * revisionsOf(item.text ?? "")) * 100) / 100);
  return { score, label: score >= (rubric.threshold ?? 0.8) ? "approved" : "weak", notes: notes.join("; ") || "no criteria" };
}

function fixPlan(item: any, verdicts: any[]): any {
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
    // Repair to a serial chain: each phase depends on the previous.
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
  // "covers-request" is repaired by the re-render below (the text
  // carries the request by construction); "jobspec" for a command
  // phase with no command cannot be invented — it stays outstanding.
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

// plan-draft: validate the phase outlines, sequence them (an omitted
// dependsOn means "the previous phase"; an explicit empty array
// means "no dependencies"), render the plan text. Review points and
// gate placement are deliberately NOT filled here — the JudgeFixLoop
// fix adds them, which is the plan loop's improving arc. An invalid
// outline throws: the run fails loudly before any review work,
// naming the problem.
function planDraft(): any {
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
  // dependsOn may only name phases listed EARLIER (a phase cannot
  // depend on itself or on a later phase — that keeps the graph
  // acyclic by construction).
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

// plan-phase: execute one agent phase. v0 produces an execution
// record — validation, a content hash of the phase, and a summary
// of the prior phases' results (the context the phase builds on).
// Real agent execution (a worker session doing the phase's work and
// returning its result) arrives with worker agents following the
// plan-phase jobspec; the record is the v0 stand-in, same honesty
// class as slides-create computing a deck locally.
function planPhase(): any {
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

// ------------------------------------------------------- rubric review
// The rubric-review workflow (workflows/library/rubric-review.ts):
// a rubric-shaped item (kind "rubric") takes the rubric branch of
// judge()/fix() instead of the generic text branch. Mirrored in the
// mock adapter (plugins/mock/src/mock-adapter.ts) — keep the two in
// sync, same criterion checks, same fix edits, same guided answers.
//
// Rubric judge: one 0–10 score per meta-rubric criterion (the 14
// criteria of workflows/rubrics/meta-rubric.md — the file is the
// source of truth; tests/test-rubric-review.ts asserts every name
// below appears in it). v0 scores binary per criterion: 10 when the
// rubric under review names the criterion (its key stem appears in
// the text), 0 when it does not — a real judge interpolates per the
// file's 0/5/10 anchors. The verdict score is the weighted mean over
// criteria as a 0–1 fraction, with NO revision nudge: the fix
// genuinely adds the missing coverage, so the improving arc comes
// from the text itself, not the marker. Guided answers are
// deterministic functions of the missed/addressed sets (Q1 names a
// missed dimension, Q2 constructs the passing-but-bad rubric from
// the missed criteria, Q3 names a wording judges could read two
// ways, Q4 names what is rewarded without check, Q5 is the
// free-form summary). The fix appends one sentence per missed
// criterion (naming it, in the spirit of Q1); scope, artifactKind
// and references are preserved untouched — the fix never rewrites
// the rubric's scope or its reference examples.

/** The meta-rubric's 14 criteria, as the key stems the v0 judge
 * checks for in the rubric under review. Stems are chosen to be
 * precise ("no process", not "process"; "generality", not
 * "general") so a rubric does not score by accident. */
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

/** One sentence per missed criterion, each containing the criterion's
 * stem — the fix's addressing sentence for that criterion. */
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

function judgeRubric(item: any, rubric: any, judgeIndex: number): any {
  const { missed, addressed } = rubricMissedAddressed(item);
  const addressedSet = new Set(addressed);
  // Judges differ: each weights one criterion double (judge j doubles
  // criterion j mod 14) — independent judges, not identical copies.
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

function fixRubric(item: any, verdicts: any[]): any {
  const missed = new Set<string>();
  for (const v of verdicts) {
    if (typeof v?.notes === "string") {
      for (const part of v.notes.split("; ")) {
        if (part.endsWith("missing")) missed.add(part.split(":")[0]);
      }
    }
    // Open-ended feedback also names missed dimensions (Q1): the v0
    // Q1 format is "This rubric misses <name> entirely — ...". In v0
    // it duplicates the notes set — the path is exercised here, and a
    // real fix worker would use the prose. A Q2 answer is never
    // appended verbatim: it quotes the criticism, and quoting it
    // would make the next round's judge score the criterion as
    // addressed for merely being mentioned.
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

let result: unknown;
switch (spec) {
  case "judge":
    result = judge();
    break;
  case "fix":
    result = fix();
    break;
  case "aggregate":
    result = aggregate();
    break;
  case "rubric-update":
    result = rubricUpdate();
    break;
  case "improve-judge":
    result = improveJudge();
    break;
  case "improve-aggregate":
    result = improveAggregate();
    break;
  case "improve-decide":
    result = improveDecide();
    break;
  case "improve-fix":
    result = improveFix();
    break;
  case "improve-write":
    result = improveWrite();
    break;
  case "slides-create":
    result = slidesCreate();
    break;
  case "slides-render":
    result = slidesRender();
    break;
  case "plan-draft":
    result = planDraft();
    break;
  case "plan-phase":
    result = planPhase();
    break;
  default:
    console.error(`worker: unknown spec "${spec}"`);
    process.exit(2);
}
console.log(JSON.stringify(result));
