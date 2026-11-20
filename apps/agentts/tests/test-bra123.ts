#!/usr/bin/env bun
/**
 * daily-ai-briefing returned htmlPath doesn't match the week file
 * (Linear BRA-123).
 *
 * The workflow's WriteResult.htmlPath was computed as
 * `ai-briefings-week-<editionDate>.html`, but the weekly builder
 * names the page by the Monday of the edition's week. For the Nov 18,
 * 2026 trial edition the workflow returned
 * `htmlPath: .../ai-briefings-week-2026-11-18.html` while the file on
 * disk is `ai-briefings-week-2026-11-16.html` (Nov 16 is the Monday).
 * The markdown, meta.json and index paths in the same result were
 * correct; only htmlPath pointed at a file that does not exist.
 *
 * The fix (option (a) from the brief): compute the Monday in the
 * workflow — exported `weekMonday(dateStr)` in
 * workflows/dogfood/daily-ai-briefing.ts — and use it for both the
 * `week page` print and the returned htmlPath (one shared const, so
 * the two cannot disagree). Option (b) — return the builder's actual
 * output path — was rejected: the builder prints only a summary line,
 * so it would mean changing the live cron builder's stdout contract.
 * Drift risk: if the builder's week rule ever changes, weekMonday
 * must change with it — section C pins the builder's current rule.
 *
 * What this proves:
 *   A. The Monday helper, called directly: Wed Nov 18 -> Mon Nov 16,
 *      Mon Nov 16 -> itself, Sun Nov 22 -> Mon Nov 16, Mon Nov 23 ->
 *      itself, Tue Nov 17 -> Mon Nov 16, Sun Nov 15 -> Mon Nov 9,
 *      Thu Jan 1 2026 -> Mon Dec 29 2025 (year boundary); and the
 *      workflow source uses one shared const for the print and the
 *      return, with the old edition-date computation gone.
 *      (Correction to the brief: it called Nov 17 "Mon of the next
 *      week" — Nov 17, 2026 is a Tuesday; the next Monday is Nov 23.
 *      Weekdays verified with `date -d`.)
 *   B. Run-level, CLI + briefing mock adapter: a Nov 18 edition run
 *      through the real engine returns
 *      htmlPath .../files/ai-briefings-week-2026-11-16.html — the
 *      Monday file, not the edition-date file — with the other
 *      returned paths unchanged.
 *   C. Builder reality: the real builder, run against a scratch dir
 *      holding a Nov 18 markdown edition, writes
 *      ai-briefings-week-2026-11-16.html (and no -11-18 file) — so
 *      the path section B returns is the file that exists after a
 *      real run. Section C materializes the edition into the SAME
 *      scratch dir section B's run used, then asserts the returned
 *      htmlPath exists on disk.
 *
 * Notes, stated plainly:
 * - The mock run needs a judgmentsPath: the workflow passes
 *   `judgmentsPath: input.judgmentsPath` into the judge job, and the
 *   trap JSON boundary rejects `undefined` — so a mock run with no
 *   judgments file fails at the judge step with
 *   "JsonBoundaryError: $.input.judgmentsPath is undefined". That is
 *   a PRE-EXISTING issue (found during verification, not fixed here —
 *   it belongs to the judge step, not htmlPath); the test supplies a
 *   small neutral-5 judgments file matching the mock fixture's own
 *   verdicts. The mock adapter ignores the file and answers with its
 *   fixture.
 * - The workflow's `print` calls do not surface in the CLI --wait
 *   output (verified: stdout is the result JSON only), so the print
 *   line is asserted at the source level in A (one shared const) —
 *   not at runtime.
 * - The builder check uses the live goal dir's builder/CSS/venv
 *   (briefing-prep.ts hardcodes the same path); read-only.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra123.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { weekMonday } from "../workflows/dogfood/daily-ai-briefing";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const WORKDIR = process.env.BRA123_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "bra123-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const GOAL_DIR = "/home/hatch/workspace/goals/daily-ai-research-briefing";
const VENV_PYTHON = path.join(GOAL_DIR, "hidden_files", ".venv", "bin", "python");
const WORKFLOW = path.join(ROOT, "workflows", "dogfood", "daily-ai-briefing.ts");
const SCRATCH = path.join(WORKDIR, "scratch");
const FILES_DIR = path.join(SCRATCH, "files");

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

// ---------------------------------------------------------------- A. weekMonday
check(weekMonday("2026-11-18") === "2026-11-16", `A WED OK: weekMonday(2026-11-18 Wed) = ${weekMonday("2026-11-18")} (want 2026-11-16)`);
check(weekMonday("2026-11-16") === "2026-11-16", `A MON OK: weekMonday(2026-11-16 Mon) = ${weekMonday("2026-11-16")} (want 2026-11-16)`);
check(weekMonday("2026-11-22") === "2026-11-16", `A SUN OK: weekMonday(2026-11-22 Sun) = ${weekMonday("2026-11-22")} (want 2026-11-16)`);
check(weekMonday("2026-11-23") === "2026-11-23", `A NEXTMON OK: weekMonday(2026-11-23 Mon) = ${weekMonday("2026-11-23")} (want 2026-11-23)`);
check(weekMonday("2026-11-17") === "2026-11-16", `A TUE OK: weekMonday(2026-11-17 Tue) = ${weekMonday("2026-11-17")} (want 2026-11-16, not 2026-11-17 — the brief's case corrected)`);
check(weekMonday("2026-11-15") === "2026-11-09", `A PREVSUN OK: weekMonday(2026-11-15 Sun) = ${weekMonday("2026-11-15")} (want 2026-11-09)`);
check(weekMonday("2026-01-01") === "2025-12-29", `A YEAR OK: weekMonday(2026-01-01 Thu) = ${weekMonday("2026-01-01")} (want 2025-12-29, year boundary)`);

// The print and the return share one const — assert the source says so,
// and that the old edition-date computation is gone entirely.
const workflowSrc = fs.readFileSync(WORKFLOW, "utf8");
check(
  workflowSrc.includes("print(`week page: ${weekHtml}`)"),
  "A PRINT OK: the week-page print uses the shared weekHtml const",
);
check(
  workflowSrc.includes("htmlPath: weekHtml,"),
  "A RETURN OK: the returned htmlPath is the shared weekHtml const",
);
check(
  !workflowSrc.includes("ai-briefings-week-${EDITION_DATE}"),
  "A GONE OK: no ai-briefings-week-<editionDate> computation remains in the workflow",
);

// ---------------------------------------------------------------- B. run-level: CLI + briefing mock adapter
const DURABLETS_HOST = process.env.DURABLETS_HOST;
if (!DURABLETS_HOST) {
  fail("B HOST OK: DURABLETS_HOST is not set — run via run.sh or export it (a built C host)");
  console.log("\ntest-bra123: 1 FAILURE(S)");
  process.exit(1);
}
// Neutral-5 verdicts for the mock discovery fixture's 7 papers
// (2611.90001-2611.90007) — the mock judge fixture returns neutral 5
// for every paper and ignores this file, but the workflow's judge job
// input must not carry an undefined judgmentsPath (see the header).
const judgmentsPath = path.join(WORKDIR, "judgments.json");
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
const inputPath = path.join(WORKDIR, "input.json");
fs.writeFileSync(
  inputPath,
  JSON.stringify({
    dateLabel: "Wednesday, November 18, 2026",
    editionDate: "2026-11-18",
    mock: true,
    readCount: 5,
    scratchDir: SCRATCH,
    selectCount: 5,
    venvPython: VENV_PYTHON,
    windowDays: 7,
    judgmentsPath,
  }),
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
    path.join(WORKDIR, "state"),
    "--wait",
  ],
  {
    encoding: "utf8",
    env: { ...process.env, AGENTTS_BRIEFING_MOCK: "1", DURABLETS_HOST },
    cwd: ROOT,
  },
);
check(cliRun.status === 0, `B RC OK: CLI mock run exits 0 (got ${cliRun.status}; stderr tail: ${String(cliRun.stderr ?? "").trim().slice(-200)})`);
let result: any = null;
if (cliRun.status === 0) {
  const out = cliRun.stdout ?? "";
  const jsonText = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  try {
    result = JSON.parse(jsonText);
  } catch {
    fail(`B JSON OK: CLI stdout parses as the result JSON (got ${JSON.stringify(out.slice(0, 200))})`);
  }
}
if (result) {
  check(result.editionDate === "2026-11-18", `B DATE OK: result editionDate is 2026-11-18 (got ${result.editionDate})`);
  check(
    result.htmlPath === `${FILES_DIR}/ai-briefings-week-2026-11-16.html`,
    `B HTML OK: htmlPath is the Monday file (got ${result.htmlPath})`,
  );
  check(
    !String(result.htmlPath ?? "").includes("2026-11-18"),
    "B NOTEDITION OK: htmlPath does not contain the edition date",
  );
  check(
    result.markdownPath === `${FILES_DIR}/ai-briefing-2026-11-18/2026-11-18-ai-research-briefing.md`,
    `B MD OK: markdownPath unchanged (got ${result.markdownPath})`,
  );
  check(
    result.indexPath === `${FILES_DIR}/ai-briefings.html`,
    `B INDEX OK: indexPath unchanged (got ${result.indexPath})`,
  );
}

// ---------------------------------------------------------------- C. builder reality
// Materialize the edition the mock run pretended to write, into the
// SAME scratch dir, then run the REAL builder and check the file the
// workflow returned exists.
const prep = spawnSync(BUN, [path.join(ROOT, "workflows", "dogfood", "briefing-prep.ts"), SCRATCH], {
  encoding: "utf8",
  cwd: ROOT,
});
check(prep.status === 0, `C PREP OK: briefing-prep populates scratch (rc ${prep.status}; ${String(prep.stderr ?? "").trim().slice(-160)})`);
const editionDir = path.join(FILES_DIR, "ai-briefing-2026-11-18");
fs.mkdirSync(editionDir, { recursive: true });
fs.writeFileSync(
  path.join(editionDir, "2026-11-18-ai-research-briefing.md"),
  [
    "# AI Research Briefing — Wednesday, November 18, 2026",
    "",
    "**TEST EDITION — produced by the AgentTS briefing workflow.**",
    "",
    "---",
    "",
    "## 1. Mock paper on quantization and attention",
    "",
    "**arXiv: [2611.90001](https://arxiv.org/abs/2611.90001)** · Mock Author · Submitted 2026-11-16",
    "",
    "**Why it matters:** Mock abstract.",
    "",
    "### Key findings",
    "",
    "- Mock result 42% vs baseline 40%, a 2 point gain.",
    "",
  ].join("\n"),
);
if (!fs.existsSync(VENV_PYTHON)) {
  fail(`C VENV OK: venv python is missing at ${VENV_PYTHON}`);
} else {
  const builder = spawnSync(VENV_PYTHON, [path.join(SCRATCH, "hidden_files", "build_briefings_html.py")], {
    encoding: "utf8",
    cwd: SCRATCH,
  });
  check(builder.status === 0, `C BUILD OK: real builder exits 0 (rc ${builder.status}; ${String(builder.stderr ?? "").trim().slice(-160)})`);
}
const weekFile = path.join(FILES_DIR, "ai-briefings-week-2026-11-16.html");
const wrongFile = path.join(FILES_DIR, "ai-briefings-week-2026-11-18.html");
check(fs.existsSync(weekFile), `C MONDAY OK: builder wrote ${weekFile}`);
check(!fs.existsSync(wrongFile), `C NOEDITION OK: builder wrote no ${wrongFile}`);
check(
  fs.existsSync(weekFile) && fs.readFileSync(weekFile, "utf8").includes('id="day-2026-11-18"'),
  "C ANCHOR OK: the week file contains the Nov 18 day section",
);
check(fs.existsSync(path.join(FILES_DIR, "ai-briefings.html")), "C INDEXFILE OK: the builder rebuilt ai-briefings.html");
if (result) {
  check(
    fs.existsSync(result.htmlPath),
    `C EXISTS OK: the returned htmlPath exists on disk after the builder ran (got ${result.htmlPath})`,
  );
}

// ---------------------------------------------------------------- verdict
if (FAILURES.length) {
  console.log(`\ntest-bra123: ${FAILURES.length} FAILURE(S)`);
  process.exit(1);
}
console.log(
  "\nPASS bra123 briefing htmlPath week Monday (weekMonday: Wed->Mon, Mon->itself, Sun->prior Mon, year boundary; CLI mock run returns the Monday file for a Nov 18 edition; the real builder writes exactly that file)",
);
