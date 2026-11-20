#!/usr/bin/env bun
/**
 * `agentts run` on direct refuses a workflow whose generic cannot
 * be extracted (Linear BRA-146).
 *
 * Extraction refusal had unit + integration-mock coverage plus the
 * `agentts check` CLI (tests/test-bra106.ts §D), but the submit-path
 * refusal — `agentts run` on direct refusing a workflow whose
 * generic cannot be extracted — was untested. The failure cases in
 * test-bra106.ts are mock/check only.
 *
 * The negative controls are the same scratch files as test-bra106
 * §D (a lib with judgeOne<X> calling job<JudgeIn<X>, Verdict>):
 *   A. Never-called generic: `agentts run` refuses with
 *      "unresolved type parameter X" — and no queue entry is
 *      created (the run never starts).
 *   B. Inferred call (no explicit type arguments): `agentts run`
 *      refuses with "explicit type arguments".
 *   C. Two instantiations of one spec with different types:
 *      `agentts run` refuses with "conflicting contracts for trap
 *      key `job:judge-one`".
 *   D. Positive control: the same instantiation twice extracts OK
 *      — `agentts check` passes (CHECK OK). It is check-only: a
 *      `run` would need a worker for the judge-one spec, which is
 *      unregistered, so the run path is out of scope here.
 *
 * Notes, stated plainly:
 * - The scratch lib imports the agentts module by absolute path
 *   (the test knows ROOT); a relative import cannot resolve from a
 *   temp dir — the same device as test-bra106 §D.
 * - AGENTTS_WORKER_SERVER points at a closed port: a Host's
 *   notifyEvent must never post test events to the production
 *   server (port 18741) — the BRA-133 lesson. The dead port fails
 *   fast and is swallowed.
 *
 *   bun tests/test-bra146.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const WORKDIR = process.env.BRA146_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "bra146-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const STATE_DIR = path.join(WORKDIR, "state");
const SCRATCH = path.join(WORKDIR, "scratch");
fs.mkdirSync(SCRATCH, { recursive: true });
// notifyEvent must never reach the production server (BRA-133).
process.env.AGENTTS_WORKER_SERVER = "http://127.0.0.1:59999";

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

function cli(args: string[]): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 120_000,
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function readQueue(): any[] {
  const p = path.join(STATE_DIR, "queue.json");
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

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

/** `agentts run` on direct must refuse loudly, with the needle in
 * the output, and must not create a queue entry. */
function expectRunRefusal(label: string, workflow: string, input: unknown, needle: string): void {
  const runId = `bra146-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const r = cli([
    "run", workflow, "--adapter", "direct", "--state-dir", STATE_DIR,
    "--run-id", runId, "--input", JSON.stringify(input),
  ]);
  const text = `${r.out}\n${r.err}`;
  check(r.rc !== 0, `${label} RC OK: agentts run exits non-zero (got ${r.rc})`);
  check(
    text.includes(needle),
    `${label} TEXT OK: refusal names the cause ("${needle}")${text.includes(needle) ? "" : ` — got: ${text.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`}`,
  );
  check(
    !readQueue().some((e) => e.runId === runId),
    `${label} CLEAN OK: no queue entry was created for the refused run`,
  );
}

const wfNever = scratchWorkflow(
  "workflow-never.ts",
  `import { judgeOne } from "./lib";\n` +
    `export interface In { x: string }\n` +
    `export interface Out { ok: boolean }\n` +
    `export default function wf(input: In): Out { return { ok: true }; }\n`,
);
expectRunRefusal("NEG NEVER-CALLED", wfNever, { x: "a" }, "unresolved type parameter X");

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
expectRunRefusal("NEG INFERRED", wfInfer, { item: { text: "hi" } }, "explicit type arguments");

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
expectRunRefusal("NEG MULTI-INSTANTIATION", wfMulti, { a: { text: "hi" }, b: { n: 1 } }, "conflicting contracts for trap key `job:judge-one`");

// ---------------------------------------------------------------- D. positive control (check only)
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
  const r = cli(["check", wfTwice, "--state-dir", STATE_DIR]);
  check(
    r.rc === 0 && `${r.out}\n${r.err}`.includes("CHECK OK"),
    `TWICE-SAME OK: same instantiation twice passes agentts check (rc ${r.rc})`,
  );
}

if (FAILURES.length) {
  console.log(`\ntest-bra146: ${FAILURES.length} FAILURE(S)`);
  process.exit(1);
}
console.log(
  "\nPASS bra146 agentts run refuses an unextractable generic on direct (never-called, inferred, and conflicting-instantiation cases all refuse loudly with the exact cause; the same instantiation twice checks green)",
);
