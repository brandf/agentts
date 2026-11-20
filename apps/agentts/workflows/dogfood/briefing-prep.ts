#!/usr/bin/env bun
/**
 * briefing-prep — scratch setup for the daily AI research briefing
 * workflow (BRA-55). Run via an exec trap before discovery.
 *
 *   bun workflows/dogfood/briefing-prep.ts <scratchDir> [seenSource]
 *
 * Creates <scratchDir>/{files,hidden_files} and copies, read-only:
 *   - the seen list -> <scratchDir>/seen-copy.md (a COPY; the
 *     live hidden_files/seen.md is never written by this workflow)
 *   - the weekly-HTML builder + letter CSS -> <scratchDir>/hidden_files/
 * so the builder can run against scratch files only.
 *
 * The seen source defaults to the live seen list. BRA-111 trials pass
 * an explicit frozen seen file instead (BriefingInput.seenSourcePath):
 * the trial dedupes against the frozen pre-cron state without ever
 * touching the live file — no swap dance, no restore to forget.
 *
 * The goal dir is Brandon's workspace path (this is a dogfood run on
 * his machine); the live briefing files are only ever READ.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const GOAL_DIR = "/home/hatch/workspace/goals/daily-ai-research-briefing";

const scratch = process.argv[2];
if (!scratch) {
  console.error("briefing-prep: usage: bun briefing-prep.ts <scratchDir> [seenSource]");
  process.exit(2);
}
// BRA-111: optional seen source (frozen trial state). Default is the
// live seen list — the cron path passes nothing and is unchanged.
const seenSource = process.argv[3] ?? path.join(GOAL_DIR, "hidden_files", "seen.md");
const filesDir = path.join(scratch, "files");
const hiddenDir = path.join(scratch, "hidden_files");
fs.mkdirSync(filesDir, { recursive: true });
fs.mkdirSync(hiddenDir, { recursive: true });

const copies: [string, string][] = [
  [seenSource, path.join(scratch, "seen-copy.md")],
  [path.join(GOAL_DIR, "hidden_files", "build_briefings_html.py"), path.join(hiddenDir, "build_briefings_html.py")],
  [path.join(GOAL_DIR, "hidden_files", "letter-base.css"), path.join(hiddenDir, "letter-base.css")],
];
for (const [src, dst] of copies) {
  if (!fs.existsSync(src)) {
    console.error(`briefing-prep: missing source ${src}`);
    process.exit(2);
  }
  fs.copyFileSync(src, dst);
}
const seenIds = (fs.readFileSync(path.join(scratch, "seen-copy.md"), "utf8").match(/\d{4}\.\d{4,5}/g) ?? []).length;
console.log(JSON.stringify({ scratch, seenIds, copied: copies.length }));
