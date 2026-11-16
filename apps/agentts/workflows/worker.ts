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
 */
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
  return {
    approved,
    failed,
    meanScore: Math.round(mean * 100) / 100,
    summary: `${approved} approved, ${failed} failed, mean ${Math.round(mean * 100) / 100}`,
  };
}

function rubricUpdate(): any {
  const rubric = input.rubric ?? { criteria: [], threshold: 0.8 };
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
  default:
    console.error(`worker: unknown spec "${spec}"`);
    process.exit(2);
}
console.log(JSON.stringify(result));
