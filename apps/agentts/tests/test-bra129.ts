#!/usr/bin/env bun
/**
 * Traps cannot suspend inside native-builtin callbacks (Linear BRA-129).
 *
 * A trap (here `exec`) called from inside a C-implemented native-builtin
 * callback — Array.map is the original — throws at runtime
 * `TypeError: this call cannot be suspended`. Direct calls and plain
 * `for` loops suspend fine. Found Nov 18 validating rubricReview:
 * `resolveReferences` used `examples.map((e) => resolveTextBlob(...))`.
 * The workflow-side workaround (a plain for loop) already landed.
 *
 * Option (a) — make suspension work from native callbacks — is an
 * engine redesign, NOT done here: `js_can_suspend_from` (quickjs.c)
 * requires every frame to be a bytecode function entered directly,
 * and a callback entered from C has entry kind NATIVE; the snapshot
 * format stores only JS heap frames, so a C builtin's loop state
 * (index, array, callback) has no representation to resume from.
 * Recorded as follow-up in the worker report.
 *
 * Option (b) — implemented here: the extractor refuses the workflow
 * at first run when a trap call sits inside a native-builtin callback,
 * naming the callback AND the fix. The check (`nativeCallbackTaint`
 * in src/extract.ts) covers inline callbacks, named functions passed
 * by reference, helpers called synchronously from inside a callback,
 * and trap calls in library files (the whole closure is walked).
 * A thunk merely CREATED inside a callback — `steps.map((s) => () =>
 * job(...))`, the plan-driven-work shape — is NOT flagged: it executes
 * after the callback returns, where suspension works.
 *
 * What this proves (CLI-driven, direct adapter so exec is real, own
 * state dirs):
 *   A. Refused at submit, exact message: map, forEach, filter,
 *      named-function, helper-called-from-map, direct trap(), and the
 *      library-file case. The message names the callback (Array.map
 *      etc.) and the fix (plain for loop / direct call).
 *   B. Runs fine: the same trap in a plain for loop, and .map()
 *      building thunks that all() invokes later.
 *   C. The taint analysis, called directly: inline/named/helper
 *      callbacks are tainted with the right method; thunks created
 *      inside a callback are not; replace/from/sort are tainted;
 *      a plain loop is not.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra129.ts
 *   (run.sh sets DURABLETS_HOST and runs this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as ts from "typescript";
import { nativeCallbackTaint, enclosingFunction } from "../src/extract";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA129_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra129-"));
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

function getResult(stateDir: string, runId: string): { status: string; output?: unknown } | null {
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

// The refusal message tail — quoted here, never paraphrased. The
// leading file:line varies per run (frozen-dir hash), so the refused
// cases build the full expected stderr line from the frozen dir +
// the trap call's line/column in the fixture.
function refusalTail(label: string, method: string): string {
  return (
    `${label} sits inside a ${method} callback — traps cannot suspend from inside a native-builtin callback ` +
    `(the callback runs from C, so dquickts throws "this call cannot be suspended" at runtime). ` +
    `Move the trap out of the callback — use a plain for loop (or a direct call) instead`
  );
}

/** Line/column (1-based) of the first line in a fixture matching `re`. */
function trapPosition(fixture: string, re: RegExp): { line: number; column: number } {
  const lines = fs.readFileSync(fixture, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m && m.index !== undefined) return { line: i + 1, column: m.index + 1 };
  }
  throw new Error(`no trap call matching ${re} in ${fixture}`);
}

/** The frozen copy's hash dir for a submitted run (exactly one). */
function frozenHash(stateDir: string): string {
  const entries = fs.readdirSync(path.join(stateDir, "frozen"));
  if (entries.length !== 1) throw new Error(`expected exactly one frozen dir in ${stateDir}, got ${entries}`);
  return entries[0];
}

// ---------------------------------------------------------------- A. refused at submit, exact message
{
  const cases: {
    name: string;
    workflow: string;
    trapFile: string;
    trapRe: RegExp;
    label: string;
    method: string;
  }[] = [
    {
      name: "map",
      workflow: "workflow-bra129-map.ts",
      trapFile: "workflow-bra129-map.ts",
      trapRe: /exec\(\{ cmd: "echo", args: \[v\] \}\)/,
      label: "`exec` trap",
      method: "Array.map",
    },
    {
      name: "foreach",
      workflow: "workflow-bra129-foreach.ts",
      trapFile: "workflow-bra129-foreach.ts",
      trapRe: /exec\(\{ cmd: "echo", args: \[v\] \}\)/,
      label: "`exec` trap",
      method: "Array.forEach",
    },
    {
      name: "filter",
      workflow: "workflow-bra129-filter.ts",
      trapFile: "workflow-bra129-filter.ts",
      trapRe: /exec\(\{ cmd: "echo", args: \[v\] \}\)/,
      label: "`exec` trap",
      method: "Array.filter",
    },
    {
      name: "named",
      workflow: "workflow-bra129-named.ts",
      trapFile: "workflow-bra129-named.ts",
      trapRe: /exec\(\{ cmd: "echo", args: \[v\] \}\)/,
      label: "`exec` trap",
      method: "Array.map",
    },
    {
      name: "helper",
      workflow: "workflow-bra129-helper.ts",
      trapFile: "workflow-bra129-helper.ts",
      trapRe: /exec\(\{ cmd: "echo", args: \[v\] \}\)/,
      label: "`exec` trap",
      method: "Array.map",
    },
    {
      name: "direct",
      workflow: "workflow-bra129-direct.ts",
      trapFile: "workflow-bra129-direct.ts",
      trapRe: /trap<ExecSpec, ExecResult>\("exec", \{ cmd: "echo", args: \[v\] \}\)/,
      label: "direct trap() call",
      method: "Array.map",
    },
    {
      name: "libuse",
      workflow: "workflow-bra129-libuse.ts",
      trapFile: "workflow-bra129-lib.ts",
      trapRe: /exec\(\{ cmd: "echo", args: \[v\] \}\)/,
      label: "`exec` trap",
      method: "Array.map",
    },
  ];
  for (const c of cases) {
    const sd = stateDirFor(`refused-${c.name}`);
    const runId = `bra129-${c.name}`;
    const wf = path.join(ROOT, "tests", "workflows", c.workflow);
    const sub = cli([
      "run",
      wf,
      "--run-id",
      runId,
      "--input",
      JSON.stringify({ marker: "x" }),
      "--state-dir",
      sd,
      "--adapter",
      "direct",
    ]);
    check(sub.rc !== 0, `A ${c.name.toUpperCase()} RC OK: submit failed (rc ${sub.rc})`);
    const pos = trapPosition(path.join(ROOT, "tests", "workflows", c.trapFile), c.trapRe);
    const frozenPath = path.join(sd, "frozen", frozenHash(sd), "tests", "workflows", c.trapFile);
    const expected =
      `ERROR: type extraction failed for 1 trap call site(s):\n` +
      `  - ${frozenPath}:${pos.line}:${pos.column}: ${refusalTail(c.label, c.method)}\n`;
    check(
      sub.err.includes(expected),
      `A ${c.name.toUpperCase()} MSG OK: submit failed with the exact refusal text (got ${JSON.stringify(sub.err.slice(0, 300))})`,
    );
  }
}

// ---------------------------------------------------------------- B. runs fine
{
  const sd = stateDirFor("loop");
  const runId = "bra129-loop";
  const sub = cli([
    "run",
    path.join(ROOT, "tests", "workflows", "workflow-bra129-loop.ts"),
    "--run-id",
    runId,
    "--input",
    JSON.stringify({ marker: "x" }),
    "--state-dir",
    sd,
    "--adapter",
    "direct",
  ]);
  check(sub.rc === 0 && sub.out.includes(`RUN ${runId}`), `B LOOP SUBMIT OK: ${runId} submitted (rc ${sub.rc})`);
  const drive = cli(["queue", "run", "--state-dir", sd, "--adapter", "direct"]);
  check(drive.rc === 0, `B LOOP DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  const res = getResult(sd, runId);
  check(res?.status === "done", `B LOOP RESULT OK: run completed (got ${res?.status})`);
  const out = (res?.output as any) ?? {};
  check(out.direct === "direct" && out.cb === "cb", `B LOOP OUT OK: plain for loop ran the trap (got ${JSON.stringify(out)})`);
}
{
  const sd = stateDirFor("thunk");
  const runId = "bra129-thunk";
  const sub = cli([
    "run",
    path.join(ROOT, "tests", "workflows", "workflow-bra129-thunk.ts"),
    "--run-id",
    runId,
    "--input",
    JSON.stringify({ marker: "x" }),
    "--state-dir",
    sd,
    "--adapter",
    "direct",
  ]);
  check(sub.rc === 0 && sub.out.includes(`RUN ${runId}`), `B THUNK SUBMIT OK: ${runId} submitted (rc ${sub.rc})`);
  const drive = cli(["queue", "run", "--state-dir", sd, "--adapter", "direct"]);
  check(drive.rc === 0, `B THUNK DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  const res = getResult(sd, runId);
  check(res?.status === "done", `B THUNK RESULT OK: run completed (got ${res?.status})`);
  const out = (res?.output as any) ?? {};
  check(
    Array.isArray(out.results) && out.results.join(",") === "a,b",
    `B THUNK OUT OK: .map thunks ran via all() (got ${JSON.stringify(out.results)})`,
  );
}

// ---------------------------------------------------------------- C. the taint analysis, called directly
{
  function parse(src: string): ts.SourceFile {
    return ts.createSourceFile("probe.ts", src, ts.ScriptTarget.Latest, true);
  }
  function functionsInOrder(sf: ts.SourceFile): ts.Node[] {
    const out: ts.Node[] = [];
    function walk(node: ts.Node): void {
      if (ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) out.push(node);
      ts.forEachChild(node, walk);
    }
    walk(sf);
    return out;
  }
  // Inline map callback: tainted with Array.map.
  {
    const taint = nativeCallbackTaint(parse(`["a"].map((v) => { exec({}); return v; });`));
    check(taint.size === 1, `C MAP OK: one tainted function (got ${taint.size})`);
    check([...taint.values()][0] === "Array.map", `C MAP METHOD OK: tainted with Array.map (got ${[...taint.values()][0]})`);
  }
  // Thunk created inside a map callback: outer tainted, inner not.
  {
    const sf = parse(`["a"].map((v) => () => { exec({}); });`);
    const taint = nativeCallbackTaint(sf);
    const fns = functionsInOrder(sf);
    check(fns.length === 2, `C THUNK SHAPE OK: two functions found (got ${fns.length})`);
    check(taint.has(fns[0]) && !taint.has(fns[1]), `C THUNK OK: map callback tainted, created thunk not`);
  }
  // Named function passed to map: tainted with Array.map. (One
  // function-like node in this snippet — the callback is passed by
  // reference, not inline.)
  {
    const sf = parse(`function runOne(v: string) { exec({}); return v; } ["a"].map(runOne);`);
    const taint = nativeCallbackTaint(sf);
    const fns = functionsInOrder(sf);
    check(fns.length === 1, `C NAMED SHAPE OK: one function found (got ${fns.length})`);
    check(taint.get(fns[0]) === "Array.map", `C NAMED OK: named function tainted with Array.map`);
  }
  // Helper called synchronously from inside a map callback: tainted.
  {
    const sf = parse(
      `function runOne(v: string) { exec({}); return v; } ["a"].map((v) => { runOne(v); return v; });`,
    );
    const taint = nativeCallbackTaint(sf);
    const fns = functionsInOrder(sf);
    check(fns.length === 2, `C HELPER SHAPE OK: two functions found (got ${fns.length})`);
    check(taint.get(fns[0]) === "Array.map" && taint.get(fns[1]) === "Array.map", `C HELPER OK: helper and callback both tainted`);
  }
  // Nested function called from inside the callback: tainted.
  {
    const sf = parse(`["a"].map((v) => { const g = () => { exec({}); }; g(); return v; });`);
    const taint = nativeCallbackTaint(sf);
    const fns = functionsInOrder(sf);
    check(fns.length === 2, `C NESTED SHAPE OK: two functions found (got ${fns.length})`);
    check(taint.get(fns[0]) === "Array.map" && taint.get(fns[1]) === "Array.map", `C NESTED OK: nested called function tainted`);
  }
  // Plain for loop: nothing tainted.
  {
    const taint = nativeCallbackTaint(parse(`for (const v of ["a"]) { exec({}); }`));
    check(taint.size === 0, `C LOOP OK: nothing tainted (got ${taint.size})`);
  }
  // replace / from / sort: tainted with the right method.
  {
    const t1 = nativeCallbackTaint(parse(`"a".replace(/a/, (m) => { exec({}); return "b"; });`));
    check([...t1.values()][0] === "String.replace", `C REPLACE OK: tainted with String.replace (got ${[...t1.values()][0]})`);
    const t2 = nativeCallbackTaint(parse(`Array.from(["a"], (v) => { exec({}); return v; });`));
    check([...t2.values()][0] === "Array.from", `C FROM OK: tainted with Array.from (got ${[...t2.values()][0]})`);
    const t3 = nativeCallbackTaint(parse(`["b"].sort((a, b) => { exec({}); return 0; });`));
    check([...t3.values()][0] === "Array.sort", `C SORT OK: tainted with Array.sort (got ${[...t3.values()][0]})`);
  }
  // Name-based match: a user object with its own map method is flagged
  // too (documented limitation of the name-based check — a loud refusal
  // the author can restructure around, never a silent pass).
  {
    const t = nativeCallbackTaint(
      parse(`const foo = { map: (cb: (x: string) => string) => cb("a") }; foo.map((v) => { exec({}); return v; });`),
    );
    check([...t.values()][0] === "Array.map", `C CUSTOM OK: same-name method flagged as Array.map (got ${[...t.values()][0]})`);
  }
  // enclosingFunction: the trap call's innermost function.
  {
    const sf = parse(`["a"].map((v) => { exec({}); return v; });`);
    let trapCall: ts.Node | undefined;
    function walk(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "exec") trapCall = node;
      ts.forEachChild(node, walk);
    }
    walk(sf);
    const fn = trapCall ? enclosingFunction(trapCall) : undefined;
    check(fn !== undefined && ts.isArrowFunction(fn), `C ENCLOSING OK: trap's innermost function is the map callback arrow`);
  }
}

// ---------------------------------------------------------------- verdict
if (FAILURES.length) {
  console.log(`\nFAIL bra129 traps in native callbacks (${FAILURES.length} failures)`);
  process.exit(1);
}
console.log(`\nPASS bra129 traps in native callbacks (traps inside map/forEach/filter/named/helper/direct/library callbacks refused at extraction with the callback and the fix named; plain loop and all() thunks run)`);
