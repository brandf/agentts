#!/usr/bin/env bun
/**
 * briefing-prep — scratch setup for the daily AI research briefing
 * workflow (BRA-55). Run via an exec trap before discovery.
 *
 *   bun workflows/briefing-prep.ts <scratchDir>
 *
 * Creates <scratchDir>/{files,hidden_files} and copies, read-only:
 *   - the live seen list -> <scratchDir>/seen-copy.md (a COPY; the
 *     live hidden_files/seen.md is never written by this workflow)
 *   - the weekly-HTML builder + letter CSS -> <scratchDir>/hidden_files/
 * so the builder can run against scratch files only.
 *
 * The goal dir is Brandon's workspace path (this is a dogfood run on
 * his machine); the live briefing files are only ever READ.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const GOAL_DIR = "/home/hatch/workspace/goals/daily-ai-research-briefing";

const scratch = process.argv[2];
if (!scratch) {
  console.error("briefing-prep: usage: bun briefing-prep.ts <scratchDir>");
  process.exit(2);
}
const filesDir = path.join(scratch, "files");
const hiddenDir = path.join(scratch, "hidden_files");
fs.mkdirSync(filesDir, { recursive: true });
fs.mkdirSync(hiddenDir, { recursive: true });

const copies: [string, string][] = [
  [path.join(GOAL_DIR, "hidden_files", "seen.md"), path.join(scratch, "seen-copy.md")],
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
