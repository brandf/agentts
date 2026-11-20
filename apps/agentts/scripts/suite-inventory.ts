// suite-inventory — the single source for the test-suite inventory.
//
// suite-inventory.json (next to run.sh) holds slug / tier / estimate /
// label for every section. run.sh reads it for --list, tier selection,
// and the workflow driver; the run-tests workflow takes its section
// list from it (via the driver). The per-section COMMAND stays in
// run.sh's `section` definitions — this file owns the metadata, run.sh
// owns the commands, and `check` proves the two agree, so the list
// cannot drift between the two readers.
//
// Usage (plain bun, no node_modules needed):
//   bun scripts/suite-inventory.ts list [--tier N]
//     Print the 4-column table (slug, tier, est-seconds or —, label)
//     in the layout run.sh --list has always used.
//   bun scripts/suite-inventory.ts check
//     Validate the JSON (shape + unique slugs) and that run.sh's
//     `section <slug> <tier>` call sites agree with it on slug set
//     and tier. Exit 0 on agreement, 1 with the mismatches listed.
//     Labels are NOT compared: the JSON carries the short label for
//     --list, while the section call carries the long label for the
//     section header — different strings by design.
//   bun scripts/suite-inventory.ts sections --tier N [--only a,b]
//     Print JSON [{slug, label}] for the tier (tier <= N), or exactly
//     the --only slugs (loud error on an unknown slug). The workflow
//     driver feeds this to the run-tests workflow as its input.

import * as fs from "node:fs";
import * as path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const INVENTORY = path.join(ROOT, "suite-inventory.json");
const RUNSH = path.join(ROOT, "run.sh");

interface Section {
  slug: string;
  tier: number;
  estSeconds: number | null;
  label: string;
}

function loadInventory(): { version: number; sections: Section[] } {
  const raw = fs.readFileSync(INVENTORY, "utf8");
  const inv = JSON.parse(raw) as { version: number; sections: Section[] };
  return inv;
}

function validateShape(inv: { version: number; sections: Section[] }): string[] {
  const problems: string[] = [];
  if (inv.version !== 1) problems.push(`version is ${inv.version}, expected 1`);
  if (!Array.isArray(inv.sections)) {
    problems.push("sections is not an array");
    return problems;
  }
  const seen = new Set<string>();
  for (let i = 0; i < inv.sections.length; i++) {
    const s = inv.sections[i];
    if (typeof s.slug !== "string" || !s.slug) problems.push(`sections[${i}]: bad slug`);
    else if (seen.has(s.slug)) problems.push(`duplicate slug ${s.slug}`);
    else seen.add(s.slug);
    if (s.tier !== 1 && s.tier !== 2 && s.tier !== 3)
      problems.push(`${s.slug}: tier ${s.tier} is not 1, 2, or 3`);
    if (!(s.estSeconds === null || (typeof s.estSeconds === "number" && s.estSeconds >= 0)))
      problems.push(`${s.slug}: estSeconds ${s.estSeconds} is not null or a non-negative number`);
    if (typeof s.label !== "string" || !s.label)
      problems.push(`${s.slug}: label is empty`);
  }
  return problems;
}

/** Extract `section <slug> <tier> "..."` call sites from run.sh.
 * Leading whitespace is allowed (the bench call sits in an if);
 * duplicate slugs (bench is defined twice) collapse to one entry. */
function sectionCalls(): Map<string, number> {
  const src = fs.readFileSync(RUNSH, "utf8");
  const calls = new Map<string, number>();
  const re = /^\s*section (\S+) (\d+) "/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const slug = m[1];
    const tier = Number(m[2]);
    if (calls.has(slug) && calls.get(slug) !== tier) {
      // A slug defined twice with different tiers is itself drift.
      calls.set(slug, -1);
    } else {
      calls.set(slug, tier);
    }
  }
  return calls;
}

function cmdList(tierArg: string | null): number {
  const inv = loadInventory();
  const tier = tierArg === null ? 3 : Number(tierArg);
  for (const s of inv.sections) {
    if (s.tier > tier) continue;
    const est = s.estSeconds === null ? "—" : String(s.estSeconds);
    console.log(
      `${s.slug.padEnd(14)} ${String(s.tier).padEnd(4)} ${est.padEnd(4)} ${s.label}`,
    );
  }
  return 0;
}

function cmdCheck(): number {
  const problems: string[] = [];
  let inv: { version: number; sections: Section[] };
  try {
    inv = loadInventory();
  } catch (e) {
    console.error(`inventory check FAILED: cannot read ${INVENTORY}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  problems.push(...validateShape(inv));
  const calls = sectionCalls();
  const jsonSlugs = new Set(inv.sections.map((s) => s.slug));
  for (const s of inv.sections) {
    if (!calls.has(s.slug)) problems.push(`${s.slug}: in inventory, no section call in run.sh`);
    else if (calls.get(s.slug) === -1)
      problems.push(`${s.slug}: defined twice in run.sh with different tiers`);
    else if (calls.get(s.slug) !== s.tier)
      problems.push(`${s.slug}: tier ${s.tier} in inventory, tier ${calls.get(s.slug)} in run.sh`);
  }
  for (const slug of calls.keys()) {
    if (!jsonSlugs.has(slug)) problems.push(`${slug}: section call in run.sh, no inventory row`);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`inventory check FAILED: ${p}`);
    return 1;
  }
  console.log(`inventory check passed: ${inv.sections.length} sections, run.sh agrees`);
  return 0;
}

function cmdSections(args: string[]): number {
  let tier = 3;
  let only: string[] | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier" && i + 1 < args.length) tier = Number(args[++i]);
    else if (args[i].startsWith("--tier=")) tier = Number(args[i].slice("--tier=".length));
    else if (args[i] === "--only" && i + 1 < args.length)
      only = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (args[i].startsWith("--only="))
      only = args[i].slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean);
    else {
      console.error(`unknown argument: ${args[i]}`);
      return 2;
    }
  }
  const inv = loadInventory();
  const bySlug = new Map(inv.sections.map((s) => [s.slug, s]));
  let picked: Section[];
  if (only !== null) {
    picked = [];
    for (const slug of only) {
      const s = bySlug.get(slug);
      if (!s) {
        console.error(`unknown section: ${slug}`);
        return 1;
      }
      picked.push(s);
    }
  } else {
    picked = inv.sections.filter((s) => s.tier <= tier);
  }
  console.log(JSON.stringify(picked.map((s) => ({ slug: s.slug, label: s.label }))));
  return 0;
}

function main(): number {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") {
    let tier: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--tier" && i + 1 < rest.length) tier = rest[++i];
      else if (rest[i].startsWith("--tier=")) tier = rest[i].slice("--tier=".length);
      else {
        console.error(`unknown argument: ${rest[i]}`);
        return 2;
      }
    }
    return cmdList(tier);
  }
  if (cmd === "check") return cmdCheck();
  if (cmd === "sections") return cmdSections(rest);
  console.error(
    "usage: bun scripts/suite-inventory.ts <list [--tier N] | check | sections --tier N [--only a,b]>",
  );
  return 2;
}

process.exit(main());
