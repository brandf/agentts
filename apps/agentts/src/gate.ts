// gate — the first-run gate (BRA-44 / BRA-29, Brandon 20:06 + 20:09 PST).
//
// The engine raises no type errors: dquickts erases types as it parses
// (ts_skip_type* in quickjs.c — no type information survives, no API to
// retrieve it), and Bun strips types and does not type-check either
// (verified live: `bun run` on `const x: number = "hello"` prints "ran
// anyway: hello", exit 0). So the host MUST close that hole with a
// first-run gate: before a workflow runs for the first time (or when
// its source hash changes), run a real type-check AND the schema
// extraction, and refuse to start if either fails.
//
// Checker choice (hands-dirty, per Brandon 20:08): the gate uses the
// TypeScript compiler API in-process (ts.createProgram +
// getSemanticDiagnostics) — the engine behind `tsc --noEmit`, with the
// exact flags BRA-46 proved (`--strict --target es2022 --module
// esnext --moduleResolution bundler --skipLibCheck`). Why the API
// instead of spawning `tsc --noEmit` or running `bun check`:
//   - Structured diagnostics natively: file / line / column / code /
//     message come back as data (Diagnostic objects), which is what
//     the feedback channel needs — no parsing CLI text. `bun check`
//     would need its output parsed back into records.
//   - No subprocess, no `bun x` resolution, no PATH/cwd fragility:
//     the plugin already depends on `typescript` (the extractor uses
//     it), so the checker is in-process.
//   - No tsconfig needed: the options are set explicitly in code, and
//     the default lib for target ES2022 includes DOM, so ambient
//     globals (console, etc.) do not false-positive — the caveat
//     Brandon hit with bare `bun check` (TS2584 for console with no
//     lib configured) does not apply here.
//   - It IS `tsc --noEmit`: the CLI is a thin wrapper over this API
//     with the same checker and the same diagnostics. The M2 checker
//     replaces this call later either way.
//
// The gate is a FEEDBACK CHANNEL, not just a wall (Brandon 20:09).
// Types are guardrails for agents writing workflows, not just humans.
// When an agent whips up workflow code, the gate returns a precise
// error before anything runs — and the diagnostics must reach the
// authoring agent in structured, usable form so it can fix and
// resubmit (write, check, fix, run). A gate that only logs the error
// and stops is incomplete. So a gate failure is a structured return
// value — GateError carries per-error records (file, line, column,
// code, message, plus expected vs actual where the compiler provides
// it, parsed out of the diagnostic message) — not raw log text and
// not a bare stop. The principle: don't trust the agent's output,
// verify it — the static check at the gate and the runtime validation
// at the trap boundary bracket the agent's work from both sides.
//
// The gate runs once per workflow version: prepareRun calls it only
// on a cache miss (new content hash); the cache entry records the
// gate result alongside the extracted schemas, so a second run of
// the same version reuses the cached gate result + schemas without
// re-running the checker.

import * as ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

export interface GateDiagnostic {
  /** Absolute path of the file with the error. */
  file: string;
  /** 1-based line and column. */
  line: number;
  column: number;
  /** TS error code, e.g. 2322. */
  code: number;
  /** Flattened diagnostic message (includes expected vs actual where
   * the compiler states it). */
  message: string;
  /** Parsed from the message when the compiler states an assignment
   * mismatch ("Type 'X' is not assignable to type 'Y'"), else null. */
  expected: string | null;
  actual: string | null;
}

export class GateError extends Error {
  readonly diagnostics: GateDiagnostic[];
  constructor(workflowPath: string, diagnostics: GateDiagnostic[]) {
    super(
      `first-run gate: type check failed for ${workflowPath} (${diagnostics.length} error(s)):\n` +
        diagnostics
          .map((d) => `  ${d.file}:${d.line}:${d.column}: error TS${d.code}: ${d.message}`)
          .join("\n"),
    );
    this.name = "GateError";
    this.diagnostics = diagnostics;
  }
}

/** The pinned TypeScript version (package.json, exact — the gate's
 * behavior must be reproducible, and the extractor probe already
 * pins this version). The gate refuses to run on any other compiler
 * version, and a cached gate result is only trusted when it was
 * produced by this version. If the compiler is unavailable at all,
 * the host cannot even load (typescript is a declared dependency) —
 * that is the loud refusal, never a silent skip. */
export const EXPECTED_TS_VERSION = "5.9.3";

/** The M2 checker version (BRA-29). A cached extraction is only
 * trusted when it was written by this checker version: a rule
 * change must re-gate + re-check every workflow, never silently
 * trust a result the current rules did not produce. Bump on any
 * rule change (new rule, changed rule, fixed false positive).
 * bra29.2 (BRA-58): the M2-BUN rule + the gate program now includes
 * bun-types when resolvable, so a cached pre-BRA-58 gate result
 * (which refused any `Bun` reference with TS2867/TS2503) must not
 * be trusted for a workflow whose Bun use is now legal. */
export const CHECKER_VERSION = "bra29.2";

/** The version of the compiler actually loaded. */
export function compilerVersion(): string {
  return ts.version;
}

/** Refuse loudly when the loaded compiler is not the pinned one. */
export function assertCompilerVersion(workflowPath: string): void {
  if (ts.version !== EXPECTED_TS_VERSION) {
    throw new GateError(workflowPath, [
      {
        file: workflowPath,
        line: 1,
        column: 1,
        code: 0,
        message: `TypeScript compiler version mismatch: expected ${EXPECTED_TS_VERSION} (pinned), found ${ts.version} — the gate's behavior must be reproducible; install the pinned version`,
        expected: EXPECTED_TS_VERSION,
        actual: ts.version,
      },
    ]);
  }
}
export const GATE_COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
};

/**
 * The `Bun` global, for type-checking only (BRA-58).
 *
 * The gate builds its program with explicit options and no tsconfig,
 * so `bun-types` (a devDependency, listed in the host tsconfig's
 * `types`) is not auto-included and any `Bun` reference fails with
 * TS2867/TS2503. The fix is NOT `types: ["bun"]` in the options —
 * probed 2026-11-16: it does not resolve (TS2868, the program is
 * built outside any tsconfig so the typeRoots walk finds no
 * `bun-types` package) and it would replace the default automatic
 * inclusion of every `@types/*` package. Instead the gate adds the
 * bun-types entry point as an extra ROOT FILE of the program:
 * `bun-types/index.d.ts` declares the `Bun` global (namespace +
 * var) and its `/// <reference>`s resolve relative to the file, so
 * a workflow that uses `Bun` only in TYPE positions type-checks —
 * and those uses are runtime-safe (types erase; the engine never
 * sees them). A workflow that uses `Bun` in a VALUE position
 * (`Bun.sleepSync(...)`) also type-checks now — and is refused by
 * the M2-BUN checker rule instead (checker.ts): the engine
 * (dquickts) provides no `Bun` global, so a value use would fail at
 * runtime. Types at the gate, runtime refusal at the checker: the
 * two halves are one fix, and neither alone is safe.
 *
 * Resolution: walk up from the workflow file's directory AND from
 * this module's directory, looking for
 * `node_modules/bun-types/index.d.ts`; first hit wins. Both
 * packages that build gate programs (the host and the mock plugin)
 * declare bun-types as a devDependency, so a normal install
 * resolves it. When it does NOT resolve (a bare checkout with no
 * install), the gate falls back to no extra root — the old behavior:
 * any `Bun` reference fails with TS2867/TS2503. The fallback never
 * silently passes a value use: without bun-types the checker never
 * runs (tsc fails first), and with bun-types M2-BUN refuses it.
 */
export function resolveBunTypesPath(workflowPath: string): string | null {
  const starts = [path.dirname(path.resolve(workflowPath)), path.dirname(new URL(import.meta.url).pathname)];
  for (const start of starts) {
    let dir = start;
    for (;;) {
      const candidate = path.join(dir, "node_modules", "bun-types", "index.d.ts");
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* unreadable dir — keep walking up */
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** The root files of a gate program: the workflow, plus the
 * bun-types entry point when resolvable (see resolveBunTypesPath).
 * The extractor (extract.ts) and checkWorkflow below both build
 * their program from these roots, so the gate, the extraction, and
 * the checker all see the same `Bun` types. */
export function gateProgramRoots(workflowPath: string): string[] {
  const bunTypes = resolveBunTypesPath(workflowPath);
  return bunTypes ? [workflowPath, bunTypes] : [workflowPath];
}

/** Parse expected/actual out of an assignment-mismatch message. */
function parseExpectedActual(message: string): { expected: string | null; actual: string | null } {
  const m =
    message.match(/Type '(.+?)' is not assignable to type '(.+?)'\.?$/) ??
    message.match(/Argument of type '(.+?)' is not assignable to parameter of type '(.+?)'\.?$/);
  if (!m) return { expected: null, actual: null };
  return { actual: m[1], expected: m[2] };
}

function toGateDiagnostic(d: ts.Diagnostic): GateDiagnostic {
  const file = d.file?.fileName ?? "";
  let line = 1;
  let column = 1;
  if (d.file && typeof d.start === "number") {
    const pos = d.file.getLineAndCharacterOfPosition(d.start);
    line = pos.line + 1;
    column = pos.character + 1;
  }
  const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
  const { expected, actual } = parseExpectedActual(message);
  return { file, line, column, code: d.code, message, expected, actual };
}

/** Run the real type-check over an already-built program.
 * Returns the error diagnostics (empty = pass). Only category Error
 * blocks the gate; warnings/suggestions do not. */
export function checkProgram(program: ts.Program): GateDiagnostic[] {
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].filter((d) => d.category === ts.DiagnosticCategory.Error);
  return diagnostics.map(toGateDiagnostic);
}

/** Run the real type-check over a workflow (following its imports).
 * Returns the error diagnostics (empty = pass). */
export function checkWorkflow(workflowPath: string): GateDiagnostic[] {
  assertCompilerVersion(workflowPath);
  const program = ts.createProgram(gateProgramRoots(workflowPath), GATE_COMPILER_OPTIONS);
  return checkProgram(program);
}

/** Run the gate over an already-built program: throw GateError (with
 * structured diagnostics) when the workflow does not type-check;
 * return silently when it does. The program is the caller's — the
 * host builds it once per first run and shares it with the
 * extraction pre-check (extract.ts), so the gate and the extraction
 * are the same first-run step, not two program constructions. */
export function runGate(program: ts.Program, workflowPath: string): void {
  assertCompilerVersion(workflowPath);
  const diagnostics = checkProgram(program);
  if (diagnostics.length) throw new GateError(workflowPath, diagnostics);
}
