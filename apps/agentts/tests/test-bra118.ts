#!/usr/bin/env bun
/**
 * Bundle validator false-positives on import/export inside string
 * literals (Linear BRA-118).
 *
 * The bundle validator in host.ts `bundle()` (and `bundleSync()`)
 * tested the whole bundle text with /^\s*export\s/m and
 * /^\s*import\s/m. The regex cannot tell code from string-literal
 * content, so any workflow embedding a script, code sample, or doc
 * text with `import`/`export` at a line start was un-runnable.
 * Found verifying BRA-116: a workflow whose exec traps run Python
 * check scripts embedded as TS template literals failed at queue
 * run with "bundle ... still contains export/import syntax after
 * Bun.build — refusing to run a bundle the C host would eval as a
 * module", though Bun.build had correctly preserved the Python
 * `import` lines as string content.
 *
 * The fix is a real parse, not a better regex: both validator sites
 * now call `bundleHasModuleSyntax` (host.ts, exported), which runs
 * the bundle text through Bun.Transpiler.scan and refuses only on
 * a static import statement or any export. Dynamic `import()` was
 * never refused by the old check either, and `import.meta` is not
 * an import. An unscannable bundle is refused loudly, never run.
 *
 * What this proves (CLI-driven, direct adapter so exec is real,
 * own state dirs):
 *   A. The issue reproduction RUNS (workflow-bra118-repro.ts): a
 *      Python script with `import` at line starts inside a template
 *      literal executes for real and prints {"re": "re", "os":
 *      "os"}; the single-, double-quoted, and template-literal
 *      strings holding the keywords round-trip in the result.
 *   B. A genuine top-level import is STILL refused loudly
 *      (workflow-bra118-realimport.ts): `import fs from "node:fs"`
 *      survives Bun.build as a real import, and the run fails with
 *      the exact refusal text (quoted here, never paraphrased).
 *   C. The validator itself, called directly: genuine static
 *      import/export shapes refuse; import/export inside
 *      single-quoted, double-quoted, and template-literal strings,
 *      line and block comments, dynamic import, import.meta, and
 *      nested template interpolation do not; unscannable text
 *      throws loudly instead of passing.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra118.ts
 *   (run.sh sets DURABLETS_HOST and runs this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { bundleHasModuleSyntax } from "../src/host";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA118_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra118-"));
fs.mkdirSync(WORKDIR, { recursive: true });

const REPRO_WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra118-repro.ts");
const REALIMPORT_WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra118-realimport.ts");

// The exact refusal text — quoted here, never paraphrased. The
// bundle path varies per run, so section B builds the full string
// from the state dir + run id and asserts exact containment.
const REFUSAL_TAIL =
  `still contains export/import syntax after Bun.build — refusing to run a bundle the C host would eval as a module`;

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

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function stateDirFor(name: string): string {
  const d = path.join(WORKDIR, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function getResult(stateDir: string, runId: string): { status: string; output?: unknown; error?: string } | null {
  const r = cli(["result", runId, "--state-dir", stateDir]);
  if (r.rc === 0) {
    try {
      return { status: "done", output: JSON.parse(r.out) };
    } catch {
      return null;
    }
  }
  return null;
}

function getResultRaw(stateDir: string, runId: string): { rc: number; out: string; err: string } {
  return cli(["result", runId, "--state-dir", stateDir]);
}

// ---------------------------------------------------------------- A. the reproduction runs
{
  const sd = stateDirFor("repro");
  const runId = "bra118-repro";
  const sub = cli([
    "run",
    REPRO_WORKFLOW,
    "--run-id",
    runId,
    "--input",
    JSON.stringify({ marker: "x" }),
    "--state-dir",
    sd,
    "--adapter",
    "direct",
  ]);
  check(sub.rc === 0 && sub.out.includes(`RUN ${runId}`), `A SUBMIT OK: ${runId} submitted (rc ${sub.rc})`);
  const drive = cli(["queue", "run", "--state-dir", sd, "--adapter", "direct"]);
  check(drive.rc === 0, `A DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  check(
    !drive.out.includes(REFUSAL_TAIL) && !drive.err.includes(REFUSAL_TAIL),
    `A NOREFUSAL OK: queue run did not refuse the bundle for import/export syntax`,
  );
  const res = getResult(sd, runId);
  check(res?.status === "done", `A RESULT OK: run completed (got ${res?.status})`);
  const out = (res?.output as any) ?? {};
  check(
    out.py?.stdout === `{"re": "re", "os": "os"}\n` && out.py?.exitCode === 0,
    `A PY OK: the embedded Python script ran for real (got ${JSON.stringify(out.py?.stdout)})`,
  );
  check(out.single === "import single", `A SINGLE OK: single-quoted string round-tripped (got ${JSON.stringify(out.single)})`);
  check(out.double === "export double", `A DOUBLE OK: double-quoted string round-tripped (got ${JSON.stringify(out.double)})`);
  check(
    out.templated === "templated\nimport templated\nexport templated",
    `A TEMPLATED OK: template-literal string round-tripped (got ${JSON.stringify(out.templated)})`,
  );
}

// ---------------------------------------------------------------- B. a genuine import is still refused loudly
{
  const sd = stateDirFor("realimport");
  const runId = "bra118-realimport";
  const sub = cli([
    "run",
    REALIMPORT_WORKFLOW,
    "--run-id",
    runId,
    "--input",
    JSON.stringify({ marker: "x" }),
    "--state-dir",
    sd,
    "--adapter",
    "direct",
  ]);
  check(sub.rc === 0 && sub.out.includes(`RUN ${runId}`), `B SUBMIT OK: ${runId} submitted (rc ${sub.rc})`);
  const drive = cli(["queue", "run", "--state-dir", sd, "--adapter", "direct"]);
  const expected = `bundle ${sd}/slices/bundle-${runId}.js ${REFUSAL_TAIL}`;
  check(
    drive.out.includes(expected) || drive.err.includes(expected),
    `B REFUSED OK: queue run failed with the exact refusal text (got out=${JSON.stringify(drive.out.slice(0, 200))} err=${JSON.stringify(drive.err.slice(0, 200))})`,
  );
  const res = getResult(sd, runId);
  check(res === null, `B NOTDONE OK: the run did not complete (got ${res?.status})`);
  const raw = getResultRaw(sd, runId);
  check(
    (raw.out + raw.err).includes(expected),
    `B RESULT OK: result reports the exact refusal text`,
  );
}

// ---------------------------------------------------------------- C. the validator, called directly
{
  const OUT = "test-bundle.js";
  const refuses: [string, string][] = [
    ["C IMPORT OK", `import fs from "node:fs";\nconst x = 1;\n`],
    ["C EXPORT OK", `export const x = 1;\n`],
    ["C EXPORTDEFAULT OK", `const x = 1;\nexport default x;\n`],
    ["C REEXPORT OK", `export { x } from "./other";\n`],
    ["C EXPORTSTAR OK", `export * from "./other";\n`],
  ];
  for (const [label, text] of refuses) {
    check(bundleHasModuleSyntax(text, OUT) === true, `${label}: genuine module syntax refuses (got false)`);
  }
  const allows: [string, string][] = [
    ["C TEMPLATE OK", "const s = `a\nimport re, json\nimport os`;\nconst x = 1;\n"],
    ["C TEMPLATEEXPORT OK", "const s = `a\nexport y`;\n"],
    ["C SINGLE OK", "const s = 'foo\\\nimport x';\n"],
    ["C DOUBLE OK", 'const s = "foo\\\nexport y";\n'],
    ["C BLOCKCOMMENT OK", "/*\nimport x\nexport y\n*/\nconst x = 1;\n"],
    ["C LINECOMMENT OK", "// import x\n// export y\nconst x = 1;\n"],
    ["C DYNAMIC OK", `const m = await import("./other");\n`],
    ["C META OK", `console.log(import.meta.url);\n`],
    ["C NESTED OK", "const s = `a ${`b\nimport x`} c`;\n"],
    ["C REGEX OK", "const r = /import\\s+/;\nconst x = 1;\n"],
    ["C PLAIN OK", "const x = 1;\nconsole.log(x);\n"],
  ];
  for (const [label, text] of allows) {
    check(bundleHasModuleSyntax(text, OUT) === false, `${label}: string/comment/dynamic shape does not refuse (got true)`);
  }
  // An unscannable bundle is refused loudly, never run.
  let threw = "";
  try {
    bundleHasModuleSyntax(`const x = ;\n`, OUT);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check(
    threw.includes("could not be scanned for import/export syntax"),
    `C UNSCANNABLE OK: invalid bundle text throws loudly (got ${JSON.stringify(threw)})`,
  );
}

// ---------------------------------------------------------------- verdict
if (FAILURES.length) {
  console.log(`\nFAIL bra118 bundle validator string literals (${FAILURES.length} failures)`);
  process.exit(1);
}
console.log(`\nPASS bra118 bundle validator string literals (import/export inside strings and comments no longer refused; genuine top-level import/export still refused loudly)`);
