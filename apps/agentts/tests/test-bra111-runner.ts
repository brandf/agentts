#!/usr/bin/env bun
/**
 * BRA-111 trial runner: seenSourcePath (option B, the frozen-state
 * input — no swap dance).
 *
 * briefing-prep.ts used to copy the seen list from a hardcoded live
 * path, so a trial could only dedupe against the frozen pre-cron
 * state by swapping the live file out and restoring it after — a
 * crash mid-run would leave the frozen state in place and corrupt
 * every later cron dedupe until noticed. The fix is an optional
 * second argv: prep copies THAT file to <scratch>/seen-copy.md
 * instead, and BriefingInput.seenSourcePath threads it through the
 * workflow's prep exec call. The cron path omits it and behaves
 * byte-identically (default = live seen list).
 *
 * What this proves (subprocess, own temp dirs):
 *   A. Default invocation copies the live seen list (content equal
 *      to the live file read at test time), plus the builder + CSS.
 *   B. With a seenSourcePath fixture, the scratch copy is the
 *      fixture's content — not the live file's — and the builder +
 *      CSS are still copied.
 *   C. A missing seen source fails loudly (nonzero exit, stderr
 *      names the path) instead of running with an empty seen list.
 *
 * What this does NOT prove: that the workflow threads
 * seenSourcePath into the prep call — that is proven end to end by
 * the trial runner's dry run (bra111-trial-runner.py), whose
 * discovery excludedSeen must contain IDs that exist ONLY in the
 * frozen file.
 *
 *   bun tests/test-bra111-runner.ts
 * Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const PREP = path.join(ROOT, "workflows", "dogfood", "briefing-prep.ts");
const LIVE_SEEN = path.join(
  os.homedir(),
  "workspace",
  "goals",
  "daily-ai-research-briefing",
  "hidden_files",
  "seen.md",
);

const FAILURES: string[] = [];
function fail(msg: string): void {
  console.log(`FAIL: ${msg}`);
  FAILURES.push(msg);
}
function ok(msg: string): void {
  // Each passing check prints a line containing " OK:" so the suite's
  // parseSectionOutput counts it (one per check, 14 total).
  console.log(`${msg} OK:`);
}
function check(cond: boolean, msg: string): void {
  if (cond) ok(msg);
  else fail(msg);
}

function runPrep(scratch: string, seenSource?: string) {
  const args = [PREP, scratch];
  if (seenSource !== undefined) args.push(seenSource);
  return Bun.spawnSync([process.execPath, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readText(p: string): string {
  return fs.readFileSync(p, "utf8");
}

// --- A. Default invocation copies the live seen list ---
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bra111-prep-default-"));
  const r = runPrep(scratch);
  check(r.exitCode === 0, `A: prep default exits 0 (got ${r.exitCode}: ${r.stderr.toString().slice(0, 200)})`);
  const copy = path.join(scratch, "seen-copy.md");
  check(fs.existsSync(copy), "A: scratch/seen-copy.md exists");
  if (fs.existsSync(copy)) {
    check(
      readText(copy) === readText(LIVE_SEEN),
      "A: seen-copy.md content equals the live seen.md",
    );
  }
  check(
    fs.existsSync(path.join(scratch, "hidden_files", "build_briefings_html.py")),
    "A: builder copied into scratch",
  );
  check(
    fs.existsSync(path.join(scratch, "hidden_files", "letter-base.css")),
    "A: letter CSS copied into scratch",
  );
  fs.rmSync(scratch, { recursive: true, force: true });
}

// --- B. Override copies the fixture, not the live file ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bra111-prep-override-"));
  const fixture = path.join(dir, "frozen-seen.md");
  const fixtureText =
    "# Seen papers (frozen trial fixture)\n\n## 2026-11-19\n2611.99901, 2611.99902\n";
  fs.writeFileSync(fixture, fixtureText);
  const scratch = path.join(dir, "scratch");
  const r = runPrep(scratch, fixture);
  check(r.exitCode === 0, `B: prep override exits 0 (got ${r.exitCode}: ${r.stderr.toString().slice(0, 200)})`);
  const copy = path.join(scratch, "seen-copy.md");
  check(fs.existsSync(copy), "B: scratch/seen-copy.md exists");
  if (fs.existsSync(copy)) {
    check(readText(copy) === fixtureText, "B: seen-copy.md content equals the fixture");
    check(
      readText(copy) !== readText(LIVE_SEEN),
      "B: seen-copy.md content differs from the live seen.md",
    );
  }
  check(
    fs.existsSync(path.join(scratch, "hidden_files", "build_briefings_html.py")),
    "B: builder copied into scratch",
  );
  check(
    fs.existsSync(path.join(scratch, "hidden_files", "letter-base.css")),
    "B: letter CSS copied into scratch",
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- C. Missing seen source fails loudly ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bra111-prep-missing-"));
  const scratch = path.join(dir, "scratch");
  const missing = path.join(dir, "no-such-seen.md");
  const r = runPrep(scratch, missing);
  check(r.exitCode !== 0, `C: prep with missing seen source exits nonzero (got ${r.exitCode})`);
  check(
    r.stderr.toString().includes(missing),
    "C: stderr names the missing seen source path",
  );
  check(
    !fs.existsSync(path.join(scratch, "seen-copy.md")),
    "C: no seen-copy.md written when the source is missing",
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(
  `\n${FAILURES.length === 0 ? "PASS" : "FAIL"} bra111-runner (prep seenSourcePath default/override/missing) — ${FAILURES.length} failure(s)`,
);
process.exit(FAILURES.length === 0 ? 0 : 1);
