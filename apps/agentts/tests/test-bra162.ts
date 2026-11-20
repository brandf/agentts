#!/usr/bin/env bun
/**
 * Mock-mode briefing run without judgmentsPath (Linear BRA-162).
 *
 * The defect: the workflow passed `judgmentsPath: input.judgmentsPath`
 * into the judge job unconditionally, but the input type declares it
 * optional — so a mock-mode run with no judgments file failed at the
 * judge step with "JsonBoundaryError: $.input.judgmentsPath is
 * undefined". The fix is the conditional spread in
 * workflows/dogfood/daily-ai-briefing.ts (landed with the BRA-111
 * runner build): the key is omitted when there is no path, and the
 * handler treats an absent key the same as a non-string one — so a
 * mock run reaches the mock adapter's neutral-5 fixture instead of
 * dying at the trap boundary.
 *
 * What this proves:
 *   A. Source-level: the judge job input carries judgmentsPath only
 *      behind the conditional spread, and no unconditional
 *      `judgmentsPath: input.judgmentsPath` remains in the workflow.
 *   B. E2E (the regression): a mock-mode CLI run with NO
 *      judgmentsPath completes — exit 0, the full edition result,
 *      the Monday htmlPath. This is the run the defect killed.
 *   C. E2E (trial path unchanged): the same mock run WITH a
 *      neutral-5 judgments file completes with the identical
 *      selection — supplying verdicts still works exactly as before.
 *
 * The direct-adapter path without verdicts is intentionally
 * unchanged: the handler fails loudly ("no LLM judge available"),
 * pinned by test-bra124 section D — a mock run is the only path
 * that must complete without judgments, because the mock adapter
 * answers the judge job from its fixture.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra162.ts
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
const WORKDIR = process.env.BRA162_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "bra162-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const GOAL_DIR = "/home/hatch/workspace/goals/daily-ai-research-briefing";
const VENV_PYTHON = path.join(GOAL_DIR, "hidden_files", ".venv", "bin", "python");
const WORKFLOW = path.join(ROOT, "workflows", "dogfood", "daily-ai-briefing.ts");

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

// ---------------------------------------------------------------- A. source-level
const workflowSrc = fs.readFileSync(WORKFLOW, "utf8");
check(
  workflowSrc.includes("...(input.judgmentsPath ? { judgmentsPath: input.judgmentsPath } : {})"),
  "A SPREAD OK: the judge job input carries judgmentsPath only behind the conditional spread",
);
check(
  !workflowSrc.includes("judgmentsPath: input.judgmentsPath,"),
  "A NOUNCOND OK: no unconditional judgmentsPath: input.judgmentsPath remains in the workflow",
);

// ---------------------------------------------------------------- B/C. run-level: CLI + briefing mock adapter
const DURABLETS_HOST = process.env.DURABLETS_HOST;
if (!DURABLETS_HOST) {
  fail("B HOST OK: DURABLETS_HOST is not set — run via run.sh or export it (a built C host)");
  console.log("\ntest-bra162: 1 FAILURE(S)");
  process.exit(1);
}

function mockRun(label: string, withJudgments: boolean): any {
  const runDir = path.join(WORKDIR, label);
  const scratch = path.join(runDir, "scratch");
  const input: any = {
    dateLabel: "Wednesday, November 18, 2026",
    editionDate: "2026-11-18",
    mock: true,
    readCount: 5,
    scratchDir: scratch,
    selectCount: 5,
    venvPython: VENV_PYTHON,
    windowDays: 7,
  };
  if (withJudgments) {
    const judgmentsPath = path.join(runDir, "judgments.json");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      judgmentsPath,
      JSON.stringify({
        scores: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
          id: `2611.9000${n}`,
          consequence: 5,
          reasons: "Mock fixture: neutral consequence 5.",
          evidence: "",
        })),
      }),
    );
    input.judgmentsPath = judgmentsPath;
  }
  const inputPath = path.join(runDir, "input.json");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const written = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  check(
    withJudgments ? typeof written.judgmentsPath === "string" : !("judgmentsPath" in written),
    withJudgments
      ? `${label.toUpperCase()} INPUT OK: the with-judgments input carries judgmentsPath`
      : `${label.toUpperCase()} INPUT OK: the no-judgments input carries no judgmentsPath key`,
  );
  const cliRun = spawnSync(
    BUN,
    [
      path.join(ROOT, "src", "cli.ts"),
      "run",
      WORKFLOW,
      "--adapter",
      "briefing",
      "--input-file",
      inputPath,
      "--state-dir",
      path.join(runDir, "state"),
      "--wait",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, AGENTTS_BRIEFING_MOCK: "1", DURABLETS_HOST },
      cwd: ROOT,
    },
  );
  const tag = label.toUpperCase();
  check(cliRun.status === 0, `${tag} RC OK: CLI mock run exits 0 (got ${cliRun.status}; stderr tail: ${String(cliRun.stderr ?? "").trim().slice(-200)})`);
  if (cliRun.status !== 0) return null;
  const out = cliRun.stdout ?? "";
  const jsonText = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  try {
    return JSON.parse(jsonText);
  } catch {
    fail(`${tag} JSON OK: CLI stdout parses as the result JSON (got ${JSON.stringify(out.slice(0, 200))})`);
    return null;
  }
}

const EXPECTED_SELECTED = ["2611.90001", "2611.90002", "2611.90003", "2611.90004", "2611.90005"];
const resultNoJudgments = mockRun("no-judgments", false);
if (resultNoJudgments) {
  check(resultNoJudgments.editionDate === "2026-11-18", `B DATE OK: result editionDate is 2026-11-18 (got ${resultNoJudgments.editionDate})`);
  check(resultNoJudgments.mustReadId === "2611.90001", `B MUST OK: must-read is 2611.90001 (got ${resultNoJudgments.mustReadId})`);
  check(
    JSON.stringify(resultNoJudgments.selectedIds) === JSON.stringify(EXPECTED_SELECTED),
    `B SELECT OK: selected is the mock fixture's 5 (got ${JSON.stringify(resultNoJudgments.selectedIds)})`,
  );
  check(
    resultNoJudgments.htmlPath === `${path.join(WORKDIR, "no-judgments", "scratch", "files")}/ai-briefings-week-2026-11-16.html`,
    `B HTML OK: htmlPath is the Monday file (got ${resultNoJudgments.htmlPath})`,
  );
  check(
    resultNoJudgments.markdownPath === `${path.join(WORKDIR, "no-judgments", "scratch", "files")}/ai-briefing-2026-11-18/2026-11-18-ai-research-briefing.md`,
    `B MD OK: markdownPath unchanged (got ${resultNoJudgments.markdownPath})`,
  );
  check(
    resultNoJudgments.indexPath === `${path.join(WORKDIR, "no-judgments", "scratch", "files")}/ai-briefings.html`,
    `B INDEX OK: indexPath unchanged (got ${resultNoJudgments.indexPath})`,
  );
}

const resultWithJudgments = mockRun("with-judgments", true);
if (resultWithJudgments && resultNoJudgments) {
  check(resultWithJudgments.mustReadId === resultNoJudgments.mustReadId, `C MUST OK: the with-judgments run picks the same must-read (got ${resultWithJudgments.mustReadId})`);
  check(
    JSON.stringify(resultWithJudgments.selectedIds) === JSON.stringify(resultNoJudgments.selectedIds),
    `C SELECT OK: the with-judgments run selects identically (got ${JSON.stringify(resultWithJudgments.selectedIds)})`,
  );
  check(
    resultWithJudgments.htmlPath === resultNoJudgments.htmlPath.replace("no-judgments", "with-judgments"),
    `C HTML OK: the with-judgments htmlPath differs only by run dir (got ${resultWithJudgments.htmlPath})`,
  );
}

// ---------------------------------------------------------------- verdict
if (FAILURES.length) {
  console.log(`\ntest-bra162: ${FAILURES.length} FAILURE(S)`);
  process.exit(1);
}
console.log(
  "\nPASS bra162 mock-mode briefing without judgmentsPath (judge job omits the key when absent; mock run completes with no judgments file; the with-judgments trial run selects identically)",
);
