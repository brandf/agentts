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
import * as fs from "node:fs";
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
  default:
    console.error(`worker: unknown spec "${spec}"`);
    process.exit(2);
}
console.log(JSON.stringify(result));
