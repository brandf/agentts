#!/usr/bin/env bun
/**
 * Workflow-library manifest conformance (Linear BRA-52).
 *
 * The manifest is apps/agentts/workflows/README.md. A manifest that
 * is not checked rots: this suite parses its tables and verifies
 * every row against the tree, so adding, renaming, or removing a
 * library entry (or a jobspec pairing) without updating the manifest
 * goes red here.
 *
 * Checks:
 *   1. Every row of the §1 entries table: the file exists, the entry
 *      symbol is in it, and the gate holds — `check` means the entry
 *      itself passes `agentts check` (first-run gate + extraction +
 *      M2 checker); `via <consumer>` means the entry has no default
 *      export, so the named consumer is checked instead (its
 *      extraction walks the entry's transitive imports).
 *   2. Every row of the §4 jobspec table: the prose file exists
 *      (unless `(none — worker only)`), and the worker script that
 *      serves the spec dispatches on the spec name. Rows served by
 *      the muse worker pool (no worker script) check the prose file
 *      only.
 *   3. Coverage the other way: every .ts file under workflows/ must
 *      appear in the §1 table (an entry) or the §5 table (a support
 *      file) — a workflow file with no manifest row fails.
 *   4. Admittance: a task carrying a `workflow:<name>` label resolves
 *      to `workflows/<name>.ts` (src/admittance.ts resolveWorkflow)
 *      — the manifest's §6 claim, checked against the real function.
 *
 *   bun tests/test-bra52.ts
 *   (run.sh sets BRA52_WORKDIR; the `check` invocations use a scratch
 *   state dir for their extraction cache. No C host needed — `check`
 *   is pure TypeScript. Exit 0 on PASS, 1 on any mismatch.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { resolveWorkflow } from "../src/admittance";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const MANIFEST = path.join(ROOT, "workflows", "README.md");
const WORKFLOWS_DIR = path.join(ROOT, "workflows");
const WORKDIR = process.env.BRA52_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra52-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

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

/** Rows of a markdown table under a `## N. <title>` heading. */
function tableRows(text: string, heading: string): string[][] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith("## ")) break;
    if (!l.startsWith("| ")) continue;
    // Header and separator rows carry no backticked values; data
    // rows always do (file paths, spec names, symbols).
    if (!l.includes("`")) continue;
    const cells = l.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    rows.push(cells);
  }
  return rows;
}

function firstBackticked(cell: string): string | null {
  const m = cell.match(/`([^`]+)`/);
  return m ? m[1] : null;
}

function cliCheck(workflow: string): { rc: number; out: string } {
  const r = spawnSync(
    BUN,
    [path.join(ROOT, "src", "cli.ts"), "check", workflow, "--state-dir", STATE_DIR],
    { encoding: "utf8", timeout: 120_000 },
  );
  return { rc: r.status ?? 1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

const manifest = fs.readFileSync(MANIFEST, "utf8");

// ---------------------------------------------------------------- §1 entries
const entries = tableRows(manifest, "## 1. The entries");
check(entries.length >= 1, `MANIFEST §1: entries table parses (${entries.length} rows)`);
const entryFiles = new Set<string>();
for (const row of entries) {
  const [name, fileCell, _kind, entryCell, gateCell] = row;
  const file = firstBackticked(fileCell);
  const entry = firstBackticked(entryCell);
  if (!file || !entry) {
    fail(`MANIFEST §1: row "${name}" has no backticked file/entry (file=${fileCell}, entry=${entryCell})`);
    continue;
  }
  const abs = path.resolve(WORKFLOWS_DIR, file);
  entryFiles.add(path.basename(file));
  check(fs.existsSync(abs), `ENTRY ${name}: file exists (${file})`);
  if (fs.existsSync(abs)) {
    const src = fs.readFileSync(abs, "utf8");
    check(src.includes(entry), `ENTRY ${name}: entry symbol "${entry}" is in ${file}`);
  }
  if (gateCell === "check") {
    const r = cliCheck(abs);
    check(
      r.rc === 0 && r.out.includes("CHECK OK"),
      `GATE ${name}: agentts check passes on ${file} (rc ${r.rc})${r.rc !== 0 ? ` — ${r.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}` : ""}`,
    );
  } else {
    const consumer = firstBackticked(gateCell);
    if (!consumer) {
      fail(`GATE ${name}: gate column is neither "check" nor "via <consumer>" (${gateCell})`);
    } else {
      const r = cliCheck(path.join(ROOT, consumer));
      check(
        r.rc === 0 && r.out.includes("CHECK OK"),
        `GATE ${name}: consumer ${consumer} passes agentts check (rc ${r.rc})${r.rc !== 0 ? ` — ${r.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}` : ""}`,
      );
    }
  }
}

// -------------------------------------------------------------- §4 jobspecs
const specs = tableRows(manifest, "## 4. Jobspecs");
check(specs.length >= 1, `MANIFEST §4: jobspec table parses (${specs.length} rows)`);
for (const row of specs) {
  const [specCell, proseCell, _usedBy, servedCell] = row;
  const spec = firstBackticked(specCell);
  if (!spec) {
    fail(`MANIFEST §4: row has no backticked spec name (${row.join(" | ")})`);
    continue;
  }
  const prose = firstBackticked(proseCell);
  if (prose === "(none — worker only)") {
    ok(`JOBSPEC ${spec}: worker-only, no prose file (by design)`);
  } else if (prose) {
    check(fs.existsSync(path.join(ROOT, prose)), `JOBSPEC ${spec}: prose file exists (${prose})`);
  } else {
    fail(`JOBSPEC ${spec}: prose column has no backticked path (${proseCell})`);
  }
  // First backticked .ts path in "Served by" is the worker script.
  const worker = (servedCell.match(/`([^`]+\.ts)`/) ?? [])[1] ?? null;
  if (!worker) {
    // Served by the muse worker pool (no script): the prose file is
    // the whole pairing — already checked above.
    check(servedCell.includes("muse worker pool"), `JOBSPEC ${spec}: no worker script, served-by names the pool (${servedCell})`);
    continue;
  }
  const workerAbs = path.join(ROOT, worker);
  check(fs.existsSync(workerAbs), `JOBSPEC ${spec}: worker script exists (${worker})`);
  if (fs.existsSync(workerAbs)) {
    const src = fs.readFileSync(workerAbs, "utf8");
    check(
      src.includes(`case "${spec}":`) || src.includes(`"${spec}"`),
      `JOBSPEC ${spec}: worker ${worker} dispatches on "${spec}"`,
    );
  }
}

// ------------------------------------------- §5 coverage: no unlisted files
const support = tableRows(manifest, "## 5. Support files");
const supportFiles = new Set(support.map((r) => firstBackticked(r[0])).filter(Boolean) as string[]);
const listed = new Set([...entryFiles, ...supportFiles]);
for (const f of fs.readdirSync(WORKFLOWS_DIR).filter((x) => x.endsWith(".ts")).sort()) {
  check(listed.has(f), `COVERAGE: workflows/${f} is listed in §1 or §5 of the manifest`);
}

// ------------------------------------------------------------- §6 admittance
const resolved = resolveWorkflow(
  { id: "BRA-1", labels: ["workflow:improve-loop"], status: "open" } as never,
  {},
);
check(
  resolved === "workflows/improve-loop.ts",
  `ADMITTANCE: workflow:improve-loop label resolves to workflows/improve-loop.ts (got ${resolved})`,
);
const unmapped = resolveWorkflow({ id: "BRA-2", labels: [], status: "open" } as never, {});
check(unmapped === null, `ADMITTANCE: task with no mapping resolves to null (got ${unmapped})`);

console.log("");
if (FAILURES.length) {
  console.log(`BRA52 FAIL: ${FAILURES.length} check(s) failed`);
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(
  `BRA52 PASS: workflow-library manifest conformance (${entries.length} entries gated, ${specs.length} jobspec pairings, ${support.length} support files, admittance mapping)`,
);
process.exit(0);
