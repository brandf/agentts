#!/usr/bin/env bun
/**
 * bugfix-worker — the bug-fix workflow's worker process (Phase 2, BRA-54).
 *
 * One worker process per bugfix job trap: the direct adapter spawns
 * `bun bugfix-worker.ts '<json {spec, input}>'` and reads the result
 * JSON from the last stdout line (same protocol as workflows/library/worker.ts).
 * The work here is GENUINE computation over the actual inputs — not
 * canned answers: reproduce builds a runnable copy of the target repo
 * in scratch, builds the real C host, and runs the real CLI on the real
 * JudgeFixLoop workflow; diagnose reads the real source and locates the
 * root cause; fix applies a verified patch (all edits checked before
 * any write); test runs the real staged run.sh; verify re-runs the CLI
 * mock path against the fixed sources and parses the real result.
 *
 * The same functions are imported by the mock adapter (simulate: true)
 * so the bugfix workflow iterates under --adapter mock: reproduce
 * statically checks whether the CLI wires the local decision model
 * into its mock path and reports the known pre-fix signature, fix
 * dry-runs the patch, test and verify report the post-fix signature
 * the direct run proves for real. Simulated results always carry
 * simulated: true; diagnose is identical in both modes (a real file
 * read) and reports simulated: false. The mock run is iteration only
 * — the direct run is the proof.
 *
 * Deterministic given the same repo state. All results are JSON-clean
 * (plain objects, strings, numbers, booleans, arrays — no undefined).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const BUN = "/opt/hatch-image/bin/bun";

/** Source entries copied from the target repo into a runnable scratch copy.
 * plugins/ is required: src/cli.ts statically imports both adapters
 * (../plugins/mock/src/mock-adapter, ../plugins/direct/src/direct-adapter),
 * so a copy without it fails at CLI startup (BRA-143: the direct
 * reproduce path never worked without it). */
const REPO_ENTRIES = ["src", "workflows", "tests", "plugins", "package.json", "bun.lock", "tsconfig.json"];

export interface RunOptions {
  simulate: boolean;
}

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string;
}

function spawn(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): SpawnResult {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    timeout: opts.timeoutMs ?? 120_000,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error ? String(r.error) : "",
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while (true) {
    const j = haystack.indexOf(needle, i);
    if (j < 0) return n;
    n++;
    i = j + needle.length;
  }
}

/** Copy (or re-sync) the repo's runnable entries into dest. */
function syncRunnableCopy(repoRoot: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of REPO_ENTRIES) {
    const src = path.join(repoRoot, entry);
    const dst = path.join(dest, entry);
    if (!fs.existsSync(src)) throw new Error(`bugfix worker: repo entry missing: ${src}`);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
  }
}

function buildHost(coreDir: string, outDir: string): SpawnResult {
  return spawn("make", ["-C", coreDir, `OUT_DIR=${outDir}`, "durablets"], { timeoutMs: 300_000 });
}

/** Run the CLI mock path on the JFL workflow from a runnable copy.
 * The workflow requires a JudgeFixLoopInput — the canonical fixture
 * (tests/fixtures/judge-fix-loop-input.json, the same input the
 * mock end-to-end test uses) — so pass it explicitly; without it
 * the inner run refuses with "workflow run requires an input"
 * (BRA-143: the direct reproduce path never worked without it).
 * --wait is required too: a bare `run` only submits and prints
 * "RUN <id>", so the workflow's `result:` line never appears;
 * --wait drives the queue and prints the result (same reason). */
function runCliMock(runnable: string, hostBin: string, workflowRel: string, stateDir: string, runId: string): SpawnResult {
  return spawn(
    BUN,
    [
      path.join(runnable, "src", "cli.ts"),
      "run",
      path.join(runnable, workflowRel),
      "--adapter",
      "mock",
      "--state-dir",
      stateDir,
      "--run-id",
      runId,
      "--input-file",
      path.join(runnable, "tests", "fixtures", "judge-fix-loop-input.json"),
      "--wait",
    ],
    { env: { DURABLETS_HOST: hostBin }, timeoutMs: 300_000 },
  );
}

/** Parse the JFL workflow's result out of CLI output. `agentts run
 * --wait` prints ONLY the pretty-printed result JSON on stdout (no
 * "RUN <id>" line, no `result:` prefix — the workflow's print()
 * output stays in the run's output file), so parse the whole stdout
 * as JSON; the `result: ` line is kept as a fallback for any path
 * that prints it (BRA-143: the direct reproduce path never worked
 * with the line-only parse). */
function parseJflResult(stdout: string): { loops: number; converged: boolean; mean: number; found: boolean } {
  const fromResult = (result: any): { loops: number; converged: boolean; mean: number; found: boolean } => {
    const mean = typeof result?.lastAggregate?.meanScore === "number" ? result.lastAggregate.meanScore : 0;
    return {
      loops: typeof result?.loops === "number" ? result.loops : 0,
      converged: result?.converged === true,
      mean,
      found: true,
    };
  };
  try {
    return fromResult(JSON.parse(stdout));
  } catch {
    // Fall back to the workflow's `result: {...}` print line.
  }
  const line = stdout.split("\n").find((l) => l.startsWith("result: "));
  if (!line) return { loops: 0, converged: false, mean: 0, found: false };
  try {
    return fromResult(JSON.parse(line.slice("result: ".length)));
  } catch {
    return { loops: 0, converged: false, mean: 0, found: false };
  }
}

// ---------------------------------------------------------------- reproduce

// The fix lives in the CLI (src/cli.ts), not the adapter: the mock
// adapter's canned decide is deliberate (the swap test requires the
// host mock adapter to match the mock plugin byte-identically), so
// the CLI wires the local decision model into its mock path.
const TARGET_FILE = "src/cli.ts";
const MOCK_ADAPTER_FILE = "plugins/mock/src/mock-adapter.ts";
const CANNED_DECIDE = 'return { value: { choice: "a", confidence: 0.9 } };';
const WIRING_MARKER = 'setCanned("decide"';

function reproduce(input: any, opts: RunOptions): any {
  const repoRoot: string = input.repoRoot;
  const workflowRel: string = input.workflow ?? "tests/workflows/workflow-judge-fix-loop.ts";
  if (opts.simulate) {
    // Static check: does the CLI wire the local decision model into
    // its mock path? The loop counts / mean are the verified BRA-54
    // reproduction signature (manual run: 6 loops, unconverged,
    // mean 0.55).
    const file = path.join(repoRoot, TARGET_FILE);
    const src = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const bugPresent = !src.includes(WIRING_MARKER);
    return {
      reproduced: bugPresent,
      loops: bugPresent ? 6 : 5,
      converged: !bugPresent,
      mean: bugPresent ? 0.55 : 0.85,
      evidence: bugPresent
        ? "mock simulation: the CLI does not wire the local decision model into its mock path — known pre-fix signature (6 loops, unconverged, mean 0.55)"
        : "mock simulation: the CLI already wires the local decision model — fix already applied",
      runnableCopy: "",
      hostBin: "",
      error: "",
      simulated: true,
    };
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bugfix-repro-"));
  const runnable = path.join(scratch, "runnable");
  const hostBinDir = path.join(scratch, "host-bin");
  const hostBin = path.join(hostBinDir, "durablets");
  const stateDir = path.join(scratch, "state");
  try {
    syncRunnableCopy(repoRoot, runnable);
    const install = spawn(BUN, ["install"], { cwd: runnable, timeoutMs: 180_000 });
    if (install.status !== 0) {
      return { reproduced: false, loops: 0, converged: false, mean: 0, evidence: "", runnableCopy: runnable, hostBin, error: `bun install failed: ${(install.stderr || install.error).slice(0, 300)}`, simulated: false };
    }
    const coreDir = path.resolve(repoRoot, "..", "..", "packages", "durablets");
    const built = buildHost(coreDir, hostBinDir);
    if (built.status !== 0 || !fs.existsSync(hostBin)) {
      return { reproduced: false, loops: 0, converged: false, mean: 0, evidence: "", runnableCopy: runnable, hostBin, error: `C host build failed: ${(built.stderr || built.error).slice(0, 300)}`, simulated: false };
    }
    const cli = runCliMock(runnable, hostBin, workflowRel, stateDir, "repro-bra54");
    const parsed = parseJflResult(cli.stdout);
    if (!parsed.found) {
      return { reproduced: false, loops: 0, converged: false, mean: 0, evidence: "", runnableCopy: runnable, hostBin, error: `CLI output had no result line (exit ${cli.status}): ${cli.stdout.slice(0, 300)}${cli.stderr.slice(0, 300)}`, simulated: false };
    }
    const reproduced = !parsed.converged && parsed.loops >= 6;
    return {
      reproduced,
      loops: parsed.loops,
      converged: parsed.converged,
      mean: parsed.mean,
      evidence: `CLI mock path on ${workflowRel}: loops ${parsed.loops}, converged ${parsed.converged}, mean ${parsed.mean}`,
      runnableCopy: runnable,
      hostBin,
      error: "",
      simulated: false,
    };
  } catch (e) {
    return { reproduced: false, loops: 0, converged: false, mean: 0, evidence: "", runnableCopy: runnable, hostBin, error: `reproduce failed: ${e instanceof Error ? e.message : String(e)}`, simulated: false };
  }
}

// ----------------------------------------------------------------- diagnose

export interface PatchEdit {
  search: string;
  replace: string;
}

/** The BRA-54 patch: wire the local decision model into the CLI mock
 * path by default (issue option 1). The adapter is untouched — its
 * canned decide is deliberate (the swap test requires the host mock
 * adapter to match the mock plugin byte-identically). */
function buildPatch(): PatchEdit[] {
  return [
    {
      search: 'import { compilerVersion } from "./gate";',
      replace: 'import { compilerVersion } from "./gate";\nimport { decideLocal } from "./decision-model";',
    },
    {
      search:
        '  if (adapterName === "mock") adapter = new MockAdapter({ gates });\n  else if (adapterName === "direct") adapter = new DirectAdapter();\n  else adapter = await Host.loadAdapter(adapterName);\n  return new Host({ stateDir: stateDir(args), adapter, clock });',
      replace:
        '  if (adapterName === "mock") adapter = new MockAdapter({ gates });\n  else if (adapterName === "direct") adapter = new DirectAdapter();\n  else adapter = await Host.loadAdapter(adapterName);\n  // BRA-54: the mock adapter\'s canned decide {choice:"a"} cannot\n  // answer revise/keep/converged questions, so the CLI mock path\n  // could not drive decide-heavy workflows (the JudgeFixLoop\n  // workflow looped 6 times unconverged, mean stuck at 0.55). Wire\n  // the local decision model in by default — a queued or setCanned\n  // answer still wins, since the adapter consults those first.\n  if (adapter instanceof MockAdapter) {\n    adapter.setCanned("decide", (_type, arg) => ({ value: decideLocal(arg.question, arg.options) }));\n  }\n  return new Host({ stateDir: stateDir(args), adapter, clock });',
    },
  ];
}

function diagnose(input: any, _opts: RunOptions): any {
  const repoRoot: string = input.repoRoot;
  const targetFile: string = input.targetFile ?? TARGET_FILE;
  const file = path.join(repoRoot, targetFile);
  if (!fs.existsSync(file)) {
    return { found: false, rootCause: "", file: targetFile, edits: [], rationale: "", error: `target file missing: ${file}`, simulated: false };
  }
  const src = fs.readFileSync(file, "utf8");
  // The root cause is the missing wiring: the CLI constructs a bare
  // MockAdapter, whose canned decide matches none of the
  // JudgeFixLoop decide options — so the loop never revises and
  // never converges, silently, with no error.
  if (src.includes(WIRING_MARKER)) {
    return { found: false, rootCause: "", file: targetFile, edits: [], rationale: "", error: "CLI already wires the local decision model into its mock path — bug already fixed or file drifted", simulated: false };
  }
  // The underlying cause must still be the adapter's canned decide;
  // if that changed, the CLI wiring is not the (only) story.
  const mockFile = path.join(repoRoot, MOCK_ADAPTER_FILE);
  const mockSrc = fs.existsSync(mockFile) ? fs.readFileSync(mockFile, "utf8") : "";
  if (!mockSrc.includes(CANNED_DECIDE)) {
    return { found: false, rootCause: "", file: targetFile, edits: [], rationale: "", error: "mock adapter no longer returns the canned decide {choice:\"a\"} — the bug's underlying cause is gone; re-diagnose", simulated: false };
  }
  const edits = buildPatch();
  for (const edit of edits) {
    const n = countOccurrences(src, edit.search);
    if (n !== 1) {
      return { found: false, rootCause: "", file: targetFile, edits: [], rationale: "", error: `patch edit search occurs ${n} times (expected exactly 1): ${edit.search.slice(0, 80)}`, simulated: false };
    }
  }
  return {
    found: true,
    rootCause:
      'The CLI\'s makeHost constructs a bare MockAdapter whose decide case returns the canned {choice:"a", confidence:0.9}. That matches none of the JudgeFixLoop decide options (revise/keep, update/keep, converged/continue), so the loop never revises and never converges — silently, with no error. The host suite works around it with host.setCanned("decide", decideLocal); the CLI never wires it. The adapter\'s canned decide is deliberate (the swap test requires the host mock adapter to match the mock plugin byte-identically), so the fix belongs in the CLI, not the adapter.',
    file: targetFile,
    edits,
    rationale:
      'Wire the local decision model into the CLI mock path by default: in makeHost, when the adapter is a MockAdapter, setCanned("decide", decideLocal) — the same mechanism the host suite uses. Queued and setCanned answers are consulted before the adapter\'s switch, so an explicitly configured canned answer still wins. The adapter itself is untouched, so the swap test\'s byte-identical invariant and the trap-types canned expectations hold.',
    error: "",
    simulated: false,
  };
}

// ---------------------------------------------------------------------- fix

function applyFix(input: any, opts: RunOptions): any {
  const repoRoot: string = input.repoRoot;
  const targetFile: string = input.file ?? TARGET_FILE;
  const edits: PatchEdit[] = Array.isArray(input.edits) ? input.edits : [];
  const file = path.join(repoRoot, targetFile);
  if (!fs.existsSync(file)) {
    return { applied: false, alreadyApplied: false, wouldApply: false, file: targetFile, editsApplied: 0, error: `target file missing: ${file}`, simulated: opts.simulate };
  }
  const src = fs.readFileSync(file, "utf8");
  // Two-phase: verify EVERY edit before applying ANY of them, so a
  // bad patch never leaves the file half-edited.
  let already = 0;
  for (const edit of edits) {
    const found = countOccurrences(src, edit.search);
    const replaced = countOccurrences(src, edit.replace);
    if (found === 1) continue;
    if (found === 0 && replaced >= 1) {
      already++;
      continue;
    }
    return { applied: false, alreadyApplied: false, wouldApply: false, file: targetFile, editsApplied: 0, error: `patch edit search occurs ${found} times (expected exactly 1): ${edit.search.slice(0, 80)}`, simulated: opts.simulate };
  }
  if (already === edits.length && edits.length > 0) {
    return { applied: false, alreadyApplied: true, wouldApply: false, file: targetFile, editsApplied: 0, error: "", simulated: opts.simulate };
  }
  if (opts.simulate) {
    return { applied: false, alreadyApplied: false, wouldApply: true, file: targetFile, editsApplied: 0, error: "", simulated: true };
  }
  let next = src;
  for (const edit of edits) {
    if (countOccurrences(next, edit.search) !== 1) {
      return { applied: false, alreadyApplied: false, wouldApply: false, file: targetFile, editsApplied: 0, error: `patch edit no longer applies cleanly: ${edit.search.slice(0, 80)}`, simulated: false };
    }
    next = next.replace(edit.search, edit.replace);
  }
  fs.writeFileSync(file, next, "utf8");
  return { applied: true, alreadyApplied: false, wouldApply: false, file: targetFile, editsApplied: edits.length, error: "", simulated: false };
}

// --------------------------------------------------------------------- test

function runSuite(input: any, opts: RunOptions): any {
  const repoRoot: string = input.repoRoot;
  if (opts.simulate) {
    const exists = fs.existsSync(path.join(repoRoot, "run.sh"));
    return {
      passed: exists,
      exitCode: exists ? 0 : 1,
      summary: exists
        ? "mock simulation — full suite not executed; the direct run executes staged run.sh for real"
        : "mock simulation — run.sh missing",
      error: exists ? "" : "run.sh missing",
      simulated: true,
    };
  }
  const r = spawn("sh", ["run.sh"], { cwd: repoRoot, timeoutMs: 540_000 });
  const out = `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trim()).filter(Boolean);
  const tail = out.slice(-3).join(" | ");
  return {
    passed: r.status === 0,
    exitCode: r.status ?? 1,
    summary: tail.slice(0, 500),
    error: r.status === 0 ? "" : `run.sh exited ${r.status}: ${tail.slice(0, 300)}`,
    simulated: false,
  };
}

// ------------------------------------------------------------------- verify

function verify(input: any, opts: RunOptions): any {
  const repoRoot: string = input.repoRoot;
  const workflowRel: string = input.workflow ?? "tests/workflows/workflow-judge-fix-loop.ts";
  if (opts.simulate) {
    return {
      converged: true,
      loops: 5,
      mean: 0.85,
      evidence: "mock simulation — assumes the simulated fix; the direct run executes the CLI mock path against the fixed sources for real (known post-fix signature: converges at loop 5, mean 0.85)",
      error: "",
      simulated: true,
    };
  }
  const runnable: string = input.runnableCopy;
  const hostBin: string = input.hostBin;
  if (!runnable || !hostBin || !fs.existsSync(runnable) || !fs.existsSync(hostBin)) {
    return { converged: false, loops: 0, mean: 0, evidence: "", error: "verify needs the reproduce step's runnableCopy and hostBin", simulated: false };
  }
  try {
    // Re-sync the runnable copy with the (now fixed) staged sources.
    syncRunnableCopy(repoRoot, runnable);
    const install = spawn(BUN, ["install"], { cwd: runnable, timeoutMs: 180_000 });
    if (install.status !== 0) {
      return { converged: false, loops: 0, mean: 0, evidence: "", error: `bun install failed: ${(install.stderr || install.error).slice(0, 300)}`, simulated: false };
    }
    const stateDir = path.join(path.dirname(runnable), "state-verify");
    const cli = runCliMock(runnable, hostBin, workflowRel, stateDir, "verify-bra54");
    const parsed = parseJflResult(cli.stdout);
    if (!parsed.found) {
      return { converged: false, loops: 0, mean: 0, evidence: "", error: `CLI output had no result line (exit ${cli.status}): ${cli.stdout.slice(0, 300)}${cli.stderr.slice(0, 300)}`, simulated: false };
    }
    return {
      converged: parsed.converged,
      loops: parsed.loops,
      mean: parsed.mean,
      evidence: `CLI mock path on ${workflowRel} after the fix: loops ${parsed.loops}, converged ${parsed.converged}, mean ${parsed.mean}`,
      error: "",
      simulated: false,
    };
  } catch (e) {
    return { converged: false, loops: 0, mean: 0, evidence: "", error: `verify failed: ${e instanceof Error ? e.message : String(e)}`, simulated: false };
  }
}

// ------------------------------------------------------------------ dispatch

export function runBugfix(spec: string, input: any, opts: RunOptions): unknown {
  switch (spec) {
    case "bugfix-reproduce":
      return reproduce(input, opts);
    case "bugfix-diagnose":
      return diagnose(input, opts);
    case "bugfix-fix":
      return applyFix(input, opts);
    case "bugfix-test":
      return runSuite(input, opts);
    case "bugfix-verify":
      return verify(input, opts);
    default:
      throw new Error(`bugfix worker: unknown spec "${spec}"`);
  }
}

if (import.meta.main) {
  /** BRA-179: a job payload over the inline argv cap arrives as
   * `agentts-file:<path>` (the spawning side writes the JSON to a
   * scratch file and passes the marker — Linux caps any single argv
   * string at 128KB). Small payloads still arrive inline. The marker
   * starts with `a`, which no JSON document starts with, so it can
   * never collide with an inline payload. A missing or unreadable
   * file fails LOUDLY (the path named) instead of running with an
   * empty input. (Marker + 64KB threshold shared with
   * RESULT_ARG_INLINE_MAX_BYTES / RESULT_ARG_FILE_PREFIX in
   * src/host.ts — BRA-171; keep the two in sync, per the BRA-88
   * verbatim-copy rule.) */
  const readPayloadArg = (raw: string | undefined): any => {
    const text = raw ?? "{}";
    if (!text.startsWith("agentts-file:")) return JSON.parse(text);
    const filePath = text.slice("agentts-file:".length);
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      throw new Error(`bugfix worker: cannot read job payload file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const payload = readPayloadArg(process.argv[2]);
  const spec: string = payload.spec;
  const input: any = payload.input ?? {};
  try {
    console.log(JSON.stringify(runBugfix(spec, input, { simulate: false })));
  } catch (e) {
    console.error(`bugfix worker: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
