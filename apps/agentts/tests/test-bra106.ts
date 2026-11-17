#!/usr/bin/env bun
/**
 * Extractor generic specialization (Linear BRA-106).
 *
 * Before BRA-106 the extractor needed a concrete, named type at every
 * trap call site, and a generic function could not supply one — so
 * JudgeFixLoop took its trap calls as injected callbacks
 * (JudgeFixLoopSteps) from the concrete caller. The fix is a
 * specialization pass in extractWorkflow: for each generic function
 * containing trap calls, enumerate its call sites in the workflow
 * closure, read the concrete type arguments at each call site, and
 * re-resolve the inner trap sites under that substitution (explicit
 * type arguments only; inferred calls fail loudly).
 *
 * Checks (run: bun tests/test-bra106.ts; run.sh runs it after the
 * bra103 suite, with $BRA106_WORKDIR):
 *   A. The converted JudgeFixLoop callers extract green: the JFL
 *      test consumer, workflow-bugfix-bra54, and daily-ai-briefing
 *      all pass `agentts check`, and their extracted sites carry the
 *      specialized concrete contracts (job:judge input
 *      JudgeInput<WorkItem, Rubric>, etc.).
 *   B. A minimal generic library (a different function/spec from
 *      JudgeFixLoop — tests/workflows/lib-bra106-generic.ts,
 *      scoreOne<X> calling job<ScoreIn<X>, Score>) extracts green
 *      with a concrete schema AND runs end to end under the mock
 *      adapter (mock default answer { score: 0.5, label: "default" }).
 *   C. The converted JudgeFixLoop itself runs end to end under the
 *      mock adapter (same assertions as run-host-suite's mock run:
 *      converged, 5 loops, mean 0.85, rubric gained "concrete
 *      example", item revised twice).
 *   D. Negative controls (scratch files under $BRA106_WORKDIR,
 *      extraction only): a never-called generic lib still fails
 *      loudly (unresolved type parameter); an inferred call (no
 *      explicit type arguments) fails loudly (explicit-args error);
 *      two instantiations of one spec with different types conflict
 *      (one-key-one-contract); the same instantiation twice extracts
 *      OK (dedupe).
 *
 * Deliberate scope: workflow-bugfix-bra54 and daily-ai-briefing get
 * `check` here, not a mock end-to-end run. The bugfix workflow's
 * JudgeFixLoop step is only reachable when a live bug is found, and
 * BRA-54 is fixed — on the current tree the mock run ends
 * "already-fixed" before the loop — so no fixture input reaches its
 * JFL step. The briefing reads live arXiv pages via exec, which the
 * mock adapter answers with empty stdout, so a mock run proves
 * nothing about its loop. Both callers' JFL conversions are covered
 * by (A) extraction plus (C), which runs the exact loop code they
 * share, and by the full run.sh green (test-checker + test-bra52
 * gate both files).
 *
 * Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { extractWorkflow } from "../src/extract";
import { Host } from "../src/host";
import { decideLocal } from "../src/decision-model";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const WORKDIR = process.env.BRA106_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra106-"));
const STATE_DIR = path.join(WORKDIR, "state");
const CACHE_DIR = path.join(WORKDIR, "cache");
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

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
function cliCheck(workflow: string): { rc: number; out: string } {
  const r = spawnSync(
    BUN,
    [path.join(ROOT, "src", "cli.ts"), "check", workflow, "--state-dir", STATE_DIR],
    { encoding: "utf8", timeout: 120_000 },
  );
  return { rc: r.status ?? 1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}
function expectThrow(fn: () => unknown, needle: string, label: string): void {
  try {
    fn();
    fail(`${label}: extraction unexpectedly succeeded`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    check(
      msg.includes(needle),
      `${label}: loud error names the cause ("${needle}")${msg.includes(needle) ? "" : ` — got: ${msg.split("\n").slice(0, 2).join(" | ").slice(0, 300)}`}`,
    );
  }
}

// ---------------------------------------------------------- A. converted callers extract green
const CALLERS: { file: string; judgeInput: string }[] = [
  { file: "tests/workflows/workflow-judge-fix-loop.ts", judgeInput: "JudgeInput<WorkItem, Rubric>" },
  { file: "workflows/workflow-bugfix-bra54.ts", judgeInput: "JudgeInput<FixItem, FixRubric>" },
  { file: "workflows/daily-ai-briefing.ts", judgeInput: "JudgeInput<WorkItem, Rubric>" },
];
for (const { file, judgeInput } of CALLERS) {
  const abs = path.join(ROOT, file);
  const r = cliCheck(abs);
  check(
    r.rc === 0 && r.out.includes("CHECK OK"),
    `CHECK ${file}: agentts check passes (rc ${r.rc})${r.rc !== 0 ? ` — ${r.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}` : ""}`,
  );
  let ex;
  try {
    ex = extractWorkflow(abs, CACHE_DIR);
  } catch (e: any) {
    fail(`EXTRACT ${file}: ${String(e?.message ?? e).split("\n").slice(0, 2).join(" | ")}`);
    continue;
  }
  const judge = ex.sites["job:judge"];
  check(
    judge?.inputType === judgeInput,
    `SPECIALIZE ${file}: job:judge input is the concrete ${judgeInput} (got ${judge?.inputType})`,
  );
  for (const key of ["job:aggregate", "job:fix", "job:rubric-update", "decide"]) {
    check(key in ex.sites, `SPECIALIZE ${file}: site ${key} extracted`);
  }
}

// ------------------------------------------------- B. generic lib: extract + mock end to end
{
  const generic = path.join(ROOT, "tests/workflows/workflow-bra106-generic.ts");
  const ex = extractWorkflow(generic, CACHE_DIR);
  const site = ex.sites["job:bra106-score"];
  check(
    site?.inputType === "ScoreIn<Bra106Item>",
    `GENERIC EXTRACT: job:bra106-score input is ScoreIn<Bra106Item> (got ${site?.inputType})`,
  );
  const schema = JSON.stringify(site?.inputSchema ?? {});
  check(
    schema.includes("Bra106Item") && schema.includes('"text":{"type":"string"}'),
    `GENERIC SCHEMA: input schema carries the concrete Bra106Item { text: string }`,
  );

  const host = new Host({ stateDir: path.join(WORKDIR, "generic") });
  host.submit(generic, { runId: "bra106-generic", input: { item: { text: "hello" } } });
  await host.runQueue();
  const res = host.result("bra106-generic");
  check(res.status === "done", `GENERIC MOCK: run done (got ${res.status} ${res.error ?? ""})`);
  if (res.status === "done") {
    const out = host.output("bra106-generic");
    const line = out.split("\n").find((l) => l.startsWith("score:"));
    const scored = line ? JSON.parse(line.slice("score: ".length)) : null;
    check(
      scored !== null && scored.score === 0.5 && scored.label === "default",
      `GENERIC MOCK: mock default answer { score: 0.5, label: "default" } flows through (got ${line ?? "no score line"})`,
    );
  }
}

// ------------------------------------------- C. converted JudgeFixLoop, mock end to end
{
  const host = new Host({ stateDir: path.join(WORKDIR, "jfl") });
  host.setCanned("decide", (_type, arg) => ({ value: decideLocal(arg.question, arg.options) }));
  const input = JSON.parse(
    fs.readFileSync(path.join(ROOT, "tests", "fixtures", "judge-fix-loop-input.json"), "utf8"),
  );
  host.submit(path.join(ROOT, "tests/workflows/workflow-judge-fix-loop.ts"), { runId: "bra106-jfl", input });
  await host.runQueue();
  const res = host.result("bra106-jfl");
  check(res.status === "done", `JFL MOCK: run done (got ${res.status} ${res.error ?? ""})`);
  if (res.status === "done") {
    const out = host.output("bra106-jfl");
    check(out.includes("loop 1: 0 approved, 0 failed, mean 0.55"), "JFL MOCK OK: loop 1 aggregate is 0.55 (mock judges)");
    check(out.includes("loop 3: rubric updated"), "JFL MOCK OK: the rubric was updated at loop 3 (3 missed criteria)");
    check(out.includes("loop 5: converged"), "JFL MOCK OK: converged at loop 5 — 2 loops after the rubric change");
    const resultLine = out.split("\n").find((l) => l.startsWith("result:"));
    const result = resultLine ? JSON.parse(resultLine.slice("result: ".length)) : null;
    check(result !== null && result.converged === true, "JFL MOCK OK: result.converged is true");
    check(result !== null && result.loops === 5, `JFL MOCK OK: result.loops is 5 (got ${result?.loops})`);
    check(
      result !== null &&
        Array.isArray(result.rubric?.criteria) &&
        result.rubric.criteria.includes("concrete example"),
      "JFL MOCK OK: the updated rubric carries the new 'concrete example' criterion",
    );
    check(
      result !== null &&
        typeof result.item?.text === "string" &&
        (result.item.text.match(/\(revised/g) ?? []).length === 2,
      "JFL MOCK OK: the item was revised twice",
    );
  }
}

// ---------------------------------------------------------- D. negative controls (scratch)
const SCRATCH = path.join(WORKDIR, "scratch");
fs.mkdirSync(SCRATCH, { recursive: true });
// The scratch lib imports the agentts module by absolute path (the
// test knows ROOT); a relative import cannot resolve from a temp dir.
fs.writeFileSync(
  path.join(SCRATCH, "lib.ts"),
  `import { job } from "${ROOT}/src/agentts";\n` +
    `export interface JudgeIn<X> { item: X; n: number }\n` +
    `export interface Verdict { score: number }\n` +
    `export function judgeOne<X>(item: X, n: number): Verdict {\n` +
    `  return job<JudgeIn<X>, Verdict>({ spec: "judge-one", input: { item, n } });\n` +
    `}\n`,
);
function scratchWorkflow(name: string, body: string): string {
  const p = path.join(SCRATCH, name);
  fs.writeFileSync(p, body);
  return p;
}
const wfNever = scratchWorkflow(
  "workflow-never.ts",
  `import { judgeOne } from "./lib";\n` +
    `export interface In { x: string }\n` +
    `export interface Out { ok: boolean }\n` +
    `export default function wf(input: In): Out { return { ok: true }; }\n`,
);
expectThrow(
  () => extractWorkflow(wfNever, CACHE_DIR),
  "unresolved type parameter X",
  "NEG NEVER-CALLED",
);
const wfInfer = scratchWorkflow(
  "workflow-infer.ts",
  `import { judgeOne, type Verdict } from "./lib";\n` +
    `export interface WorkItem { text: string }\n` +
    `export interface In { item: WorkItem }\n` +
    `export interface Out { score: number }\n` +
    `export default function wf(input: In): Out {\n` +
    `  const v: Verdict = judgeOne(input.item, 3);\n` +
    `  return { score: v.score };\n` +
    `}\n`,
);
expectThrow(
  () => extractWorkflow(wfInfer, CACHE_DIR),
  "explicit type arguments",
  "NEG INFERRED",
);
const wfMulti = scratchWorkflow(
  "workflow-multi.ts",
  `import { judgeOne, type Verdict } from "./lib";\n` +
    `export interface WorkItem { text: string }\n` +
    `export interface OtherItem { n: number }\n` +
    `export interface In { a: WorkItem; b: OtherItem }\n` +
    `export interface Out { s1: number; s2: number }\n` +
    `export default function wf(input: In): Out {\n` +
    `  const v1: Verdict = judgeOne<WorkItem>(input.a, 1);\n` +
    `  const v2: Verdict = judgeOne<OtherItem>(input.b, 2);\n` +
    `  return { s1: v1.score, s2: v2.score };\n` +
    `}\n`,
);
expectThrow(
  () => extractWorkflow(wfMulti, CACHE_DIR),
  "conflicting contracts for trap key `job:judge-one`",
  "NEG MULTI-INSTANTIATION",
);
{
  const wfTwice = scratchWorkflow(
    "workflow-twice.ts",
    `import { judgeOne, type Verdict } from "./lib";\n` +
      `export interface WorkItem { text: string }\n` +
      `export interface In { a: WorkItem; b: WorkItem }\n` +
      `export interface Out { s1: number; s2: number }\n` +
      `export default function wf(input: In): Out {\n` +
      `  const v1: Verdict = judgeOne<WorkItem>(input.a, 1);\n` +
      `  const v2: Verdict = judgeOne<WorkItem>(input.b, 2);\n` +
      `  return { s1: v1.score, s2: v2.score };\n` +
      `}\n`,
  );
  let twice;
  try {
    twice = extractWorkflow(wfTwice, CACHE_DIR);
  } catch (e: any) {
    fail(`TWICE-SAME: extraction unexpectedly failed — ${String(e?.message ?? e).split("\n").slice(0, 2).join(" | ")}`);
  }
  if (twice) {
    check(
      Object.keys(twice.sites).length === 1 && twice.sites["job:judge-one"]?.inputType === "JudgeIn<WorkItem>",
      `TWICE-SAME: same instantiation twice extracts to one deduped site (got ${Object.keys(twice.sites).join(", ")})`,
    );
  }
}

if (FAILURES.length) {
  console.log(`\nBRA106 FAIL: ${FAILURES.length} check(s) failed`);
  process.exit(1);
}
console.log("\nBRA106 PASS: generic specialization green");
