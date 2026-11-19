#!/usr/bin/env bun
/**
 * Inline one-shot workflows (Linear BRA-112): `agentts run -` reads the
 * workflow source from stdin and materializes it, content-addressed,
 * to .agentts-scratch/inline/<sha256[0:16]>.ts under the cwd. Nothing
 * is ever deleted — the file persists in scratch (ephemeral by
 * convention) and the frozen copy is the durable, auditable record.
 * Relative imports resolve against .agentts-scratch/inline/, so a
 * one-shot reaching the repo tree writes ../../workflows/... .
 *
 *   S1. Heredoc-equivalent run (spawnSync stdin): the stdin source is
 *       the JudgeFixLoop test workflow verbatim, whose
 *       ../../workflows/library/judge-fix-loop import resolves from the
 *       materialized location. Mock adapter, --wait: the run
 *       converges (loops 5) — proving the relative library import
 *       executed, not just resolved.
 *   S2. Default runId + inline --input: submit without --run-id and
 *       without --wait prints `RUN run-inline-<timestamp>`; the run
 *       then drives via `queue run` and `result` reads it done.
 *   S3. Content-addressed reuse: submitting the same source twice
 *       reuses the same materialized file (same path, same content,
 *       no second file minted in inline/).
 *   S4. Frozen-copy read-back: the queue entry's frozenHash points
 *       at a frozen copy whose entry content is byte-identical to
 *       the stdin source.
 *   S5. Bad source fails loudly: a type error is refused at submit
 *       (exit 1, no RUN line).
 *   S6. Empty stdin fails loudly (exit 1, "no workflow source").
 *
 *   BRA112_WORKDIR=<dir> bun tests/test-bra112.ts
 *   (run.sh sets BRA112_WORKDIR and runs this after the bra106 suite.)
 *
 * The CLI runs with cwd = the repo root (ROOT), so the materialized
 * file lands in the repo's .agentts-scratch/inline/ — that is the
 * designed persistence, not test litter: the dir is gitignored and
 * the file is content-addressed scratch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA112_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra112-"));
fs.mkdirSync(WORKDIR, { recursive: true });

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

const SOURCE = fs.readFileSync(path.join(ROOT, "tests", "workflows", "workflow-judge-fix-loop.ts"), "utf8");
const INPUT_FILE = path.join(ROOT, "tests", "fixtures", "judge-fix-loop-input.json");
const INPUT_JSON = fs.readFileSync(INPUT_FILE, "utf8");
const INLINE_DIR = path.join(ROOT, ".agentts-scratch", "inline");
const EXPECTED_FILE = path.join(
  INLINE_DIR,
  `${crypto.createHash("sha256").update(SOURCE).digest("hex").slice(0, 16)}.ts`,
);

function stateDirFor(name: string): string {
  const d = path.join(WORKDIR, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cli(
  args: string[],
  input?: string,
): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    cwd: ROOT,
    input,
    encoding: "utf8",
    env: { ...process.env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function frozenEntryMatches(stateDir: string, runId: string, source: string): boolean {
  const queue = JSON.parse(fs.readFileSync(path.join(stateDir, "queue.json"), "utf8")) as Array<{
    runId: string;
    frozenHash?: string;
  }>;
  const entry = queue.find((e) => e.runId === runId);
  if (!entry?.frozenHash) return false;
  const frozenDir = path.join(stateDir, "frozen", entry.frozenHash);
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  return walk(frozenDir).some((f) => f.endsWith(".ts") && fs.readFileSync(f, "utf8") === source);
}

async function main(): Promise<void> {
  // S1: stdin run with a relative library import, --wait, explicit run-id.
  const sd1 = stateDirFor("s1");
  const s1 = cli(
    ["run", "-", "--adapter", "mock", "--wait", "--input-file", INPUT_FILE, "--state-dir", sd1, "--run-id", "run-bra112-jfl"],
    SOURCE,
  );
  check(s1.rc === 0, `BRA112 S1 OK: stdin run exits 0 (rc ${s1.rc}, err: ${s1.err.slice(0, 200)})`);
  check(s1.out.includes('"converged": true'), `BRA112 S1 OK: JudgeFixLoop run converged (out: ${s1.out.slice(0, 120)})`);
  check(s1.out.includes('"loops": 5'), `BRA112 S1 OK: converged at loop 5, so the ../../workflows/library/judge-fix-loop import executed`);
  check(
    fs.existsSync(EXPECTED_FILE) && fs.readFileSync(EXPECTED_FILE, "utf8") === SOURCE,
    `BRA112 S1 OK: materialized at .agentts-scratch/inline/<hash>.ts with byte-identical content`,
  );
  check(
    frozenEntryMatches(sd1, "run-bra112-jfl", SOURCE),
    `BRA112 S4 OK: frozen copy under frozen/<closureHash>/ holds the stdin source byte-identical`,
  );

  // S2: default runId + inline --input, no --wait; then drive + result.
  const sd2 = stateDirFor("s2");
  const s2 = cli(
    ["run", "-", "--adapter", "mock", "--input", INPUT_JSON, "--state-dir", sd2],
    SOURCE,
  );
  const runLine = s2.out.split("\n").find((l) => l.startsWith("RUN "));
  const runId = runLine?.slice("RUN ".length).trim();
  check(s2.rc === 0, `BRA112 S2 OK: submit without --run-id exits 0 (rc ${s2.rc})`);
  check(
    runId !== undefined && /^run-inline-\d+$/.test(runId),
    `BRA112 S2 OK: default runId is run-inline-<timestamp> (got: ${runId ?? "(none)"})`,
  );
  if (runId) {
    const drive = cli(["queue", "run", "--state-dir", sd2]);
    check(drive.rc === 0, `BRA112 S2 OK: queue run drives it (rc ${drive.rc})`);
    const res = cli(["result", runId, "--state-dir", sd2]);
    check(res.rc === 0 && res.out.includes('"converged": true'), `BRA112 S2 OK: result reads the run done and converged`);
  }

  // S3: content-addressed reuse — the same source reuses the same file.
  const before = fs.readdirSync(INLINE_DIR).sort();
  const s3 = cli(
    ["run", "-", "--adapter", "mock", "--input-file", INPUT_FILE, "--state-dir", sd1, "--run-id", "run-bra112-jfl-2"],
    SOURCE,
  );
  check(s3.rc === 0, `BRA112 S3 OK: re-submit of the same source exits 0 (rc ${s3.rc})`);
  const after = fs.readdirSync(INLINE_DIR).sort();
  check(
    JSON.stringify(before) === JSON.stringify(after) && fs.readFileSync(EXPECTED_FILE, "utf8") === SOURCE,
    `BRA112 S3 OK: no second file minted in inline/ (still ${after.length} file(s)), content unchanged`,
  );

  // S5: bad source fails loudly at submit.
  const bad = `export default function bad(input: { x: number }): { y: string } {\n  return { y: input.x };\n}\n`;
  const sd5 = stateDirFor("s5");
  const s5 = cli(
    ["run", "-", "--adapter", "mock", "--input", '{"x": 1}', "--state-dir", sd5],
    bad,
  );
  check(s5.rc !== 0, `BRA112 S5 OK: type-error source refused (rc ${s5.rc})`);
  check(!s5.out.includes("RUN "), `BRA112 S5 OK: no RUN line for the refused source`);

  // S6: empty stdin fails loudly.
  const sd6 = stateDirFor("s6");
  const s6 = cli(["run", "-", "--adapter", "mock", "--state-dir", sd6], "");
  check(s6.rc === 1, `BRA112 S6 OK: empty stdin exits 1 (rc ${s6.rc})`);
  check(s6.err.includes("no workflow source on stdin"), `BRA112 S6 OK: empty stdin says so loudly`);

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA112 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("BRA112 PASS: agentts run - reads stdin, materializes content-addressed to .agentts-scratch/inline/, runs with relative library imports, refuses bad/empty source loudly");
  process.exit(0);
}

await main();
