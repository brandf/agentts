// run-tests — drive the AgentTS test suite from a workflow (BRA-164).
//
// The workflow engine owns the suite's loop, retry, report, and
// resume; run.sh keeps only the leaf work (executing one section via
// `run.sh --bash --only <slug>`). This is the dogfood move: the suite driver
// is the ultimate integration test of the engine, and if the engine
// cannot run it, that is an engine bug to fix, not a reason to keep
// the bash loop.
//
// Composability: this workflow runs a list of sections and returns a
// machine-readable report (per-section result + attempt history).
// A bigger workflow composes on top of it — run the suite, check the
// report deterministically for failures, diagnose with an agent job,
// fix with an agent job, loop until green. The report is the output;
// nothing here diagnoses or fixes.
//
// Design decisions (the issue's five points, worked out — not the
// sketch transcribed):
//
// 1. Drive cap: chunked workflow runs, NOT a raised cap and NOT
//    all() batching. MAX_DRIVE_ROUNDS is 50 suspensions per
//    uninterrupted drive, and it is an infinite-loop guard for every
//    run — raising it globally would weaken that guard, and a
//    per-run override would be a host change for one caller. The
//    suite is 68 sections (tier 1: 33, tier 2: 67, tier 3: 68 —
//    counted from suite-inventory.json; the issue's 49/51 were the
//    stale BRA-137-era counts), so a single sequential loop exceeds
//    the cap on tiers 2 and 3. The driver (run.sh workflow mode)
//    splits a tier's list into chunks of at most 32 sections and
//    runs one workflow run per chunk; tier 1 is two chunks (32+1), the
//    common case. all() batching would also fit the cap (each child
//    run has its own 50-round budget and the parent pays one round
//    per all() call), but the driver runs branches sequentially, so
//    batching buys no parallelism — only fork/join machinery per
//    batch, for no benefit. The plain sequential loop + chunking is
//    the simplest correct answer.
//    Worst case per chunk: 32 sections + 10 retries (the chunk
//    retry budget, below) + 1 inventory read = 43 rounds, under 50
//    with margin. A chunk whose runner is broken enough to need
//    more retries fails loudly at the cap — which is correct: the
//    environment is broken, not the suite.
// 2. Resume: a kill mid-section leaves the run suspended at the
//    exec trap; on resume the host re-dispatches the exec (the
//    BRA-75 exception: a crash during exec dispatch re-runs the
//    command, visible in the journal as a second trap-dispatch
//    marked redispatched: true). So a kill costs at most the
//    in-flight section — the same bound run.sh's markers give.
//    The driver re-drives the SAME run (deterministic runId, state
//    dir under the resume dir); it never submits a fresh run over a
//    suspended one.
// 3. Retry must not hide flakiness. A section is retried ONLY when
//    it did not execute — the runner itself failed (no test verdict
//    in its output: no " OK:" line, no PASS line, no FAIL line).
//    A section whose tests ran and failed is recorded as failed and
//    never retried: re-running failing tests until they pass is
//    exactly the flakiness the retry must not hide. Every attempt
//    lands in the report; a section that passes only after a retry
//    is flagged flaky (its slug is in the report's `flaky` list —
//    a flaky test is a real defect to file, not a pass). Retries
//    are also capped per chunk (maxRetriesPerChunk, default 10):
//    once the budget is spent, further no-result sections are
//    recorded as failed with one attempt, so a broken environment
//    cannot burn the drive cap on retries.
// 4. One inventory. suite-inventory.json is the single source for
//    slug / tier / estimate / label. run.sh reads it (for --list,
//    tier selection, and the workflow driver) and validates at
//    startup that its section definitions agree with it
//    (scripts/suite-inventory.ts check). The workflow takes its
//    section list as INPUT (sections: [{slug, label}]) — the
//    hermetic path the driver uses — and falls back to reading the
//    inventory itself (one exec `cat`, filtered by tier) when no
//    list is given. The per-section COMMAND stays in run.sh's
//    section definitions; the leaf is `run.sh --bash --only <slug>`, which
//    reuses them exactly (including the ref/mock/host workdirs and
//    the bench --no-ratchet rule).
// 5. Escape hatch. run.sh keeps its bash loop as --bash: when the
//    engine itself is what is broken, the suite must still run.
//    The workflow is the default; the bash loop is the fallback,
//    not a second implementation to keep in sync.
//
// Environment: the leaf exec inherits the CLI process's env (the
// direct adapter spawns without an env override), so the driver
// must export DQUICKTS (the dquickts tree for the C host build —
// the Makefile's default vendor dir is absent) and TMPDIR before
// invoking the workflow. run.sh workflow mode does this.
//
// Note on timing: elapsedMs is wall time around each exec trap
// (Date.now before/after). If the run is killed mid-section and
// resumed, the attempt's elapsed includes the dead time — honest
// wall time; the journal's redispatched marker explains it.

import { exec } from "../../src/agentts";

/** One section to run: its slug and its (short) inventory label. */
export interface RunTestsSectionInput {
  slug: string;
  label: string;
}

/** Input to the run-tests workflow. */
export interface RunTestsInput {
  /** Tier whose sections to run when `sections` is absent (1, 2, or 3). */
  tier: number;
  /** Explicit section list (the driver path — hermetic, frozen with the run). */
  sections?: RunTestsSectionInput[];
  /** Absolute path to suite-inventory.json (fallback read, when sections is absent). */
  inventoryPath?: string;
  /** Absolute path to the repo root (for the run.sh default). */
  repoRoot: string;
  /** Absolute path to run.sh (default <repoRoot>/apps/agentts/run.sh). */
  runSh?: string;
  /** Shared --resume-dir for the leaf --only calls. One dir per tier:
   * ref/mock/host write their workdirs under it and swap reads them,
   * so all chunks of a tier must share it. */
  resumeDir: string;
  /** Max attempts per section (default 3) — only on execution failure, never on test failure. */
  maxAttempts?: number;
  /** Max no-result retries per chunk (default 10) — bounds total suspensions under the drive cap. */
  maxRetriesPerChunk?: number;
  /** Chunk index within the tier (default 0) — for the report, not for control flow. */
  chunkIndex?: number;
  /** Number of chunks in the tier (default 1). */
  chunkCount?: number;
}

/** One attempt at one section. */
export interface SectionAttempt {
  attempt: number;
  exitCode: number;
  /** " OK:" lines in the attempt's stdout — the same count rule run.sh uses. */
  ok: number;
  elapsedMs: number;
  /** Did the test script produce a verdict (any check line, PASS line, or FAIL line)? */
  executed: boolean;
}

/** One section's result, with its full attempt history. */
export interface SectionResult {
  slug: string;
  label: string;
  passed: boolean;
  /** OK count of the last attempt (0 when the section never executed). */
  ok: number;
  attempts: SectionAttempt[];
  elapsedMs: number;
  /** Passed only after a retry — a flaky test, a real defect to file, not a clean pass. */
  flaky: boolean;
}

/** The run-tests report: the workflow's output, and the input to the
 * diagnose step that composes on top of this workflow. */
export interface RunTestsResult {
  tier: number;
  chunkIndex: number;
  chunkCount: number;
  sections: SectionResult[];
  ran: number;
  passed: number;
  failed: number;
  totalOk: number;
  /** Slugs that passed only after a retry — flaky, file them. */
  flaky: string[];
  failedSlugs: string[];
  elapsedMs: number;
}

/** Parse one section attempt's output. Pure — unit-tested directly.
 * passed = the leaf exited 0 (the test script's own exit code is
 * authoritative). executed = the script produced a verdict: any
 * " OK:" check line, a PASS line, or a FAIL line. A nonzero exit
 * with no verdict means the runner itself broke before the tests
 * ran (bun crash, missing file, host-build failure) — that is the
 * only retryable case. */
export function parseSectionOutput(stdout: string, exitCode: number): {
  ok: number;
  executed: boolean;
  passed: boolean;
} {
  let ok = 0;
  for (const line of stdout.split("\n")) {
    if (line.includes(" OK:")) ok++;
  }
  const executed =
    ok > 0 ||
    /^PASS /m.test(stdout) ||
    /^FAIL/m.test(stdout) ||
    /FAILURE\(S\)/.test(stdout);
  return { ok, executed, passed: exitCode === 0 };
}

export default function runTests(input: RunTestsInput): RunTestsResult {
  const tier = input.tier;
  const maxAttempts = input.maxAttempts ?? 3;
  const maxRetries = input.maxRetriesPerChunk ?? 10;
  const chunkIndex = input.chunkIndex ?? 0;
  const chunkCount = input.chunkCount ?? 1;
  const runSh = input.runSh ?? input.repoRoot + "/apps/agentts/run.sh";
  const resumeDir = input.resumeDir;

  // Resolve the section list: explicit input first (hermetic), else
  // one exec `cat` of the inventory, filtered by tier.
  let sections: RunTestsSectionInput[];
  if (input.sections !== undefined && input.sections.length > 0) {
    sections = input.sections;
  } else {
    const invPath =
      input.inventoryPath ?? input.repoRoot + "/apps/agentts/suite-inventory.json";
    const cat = exec({ cmd: "cat", args: [invPath] });
    if (cat.exitCode !== 0) {
      throw new Error(
        "run-tests: cannot read inventory " + invPath + ": " + (cat.stderr ?? ""),
      );
    }
    const inv = JSON.parse(cat.stdout) as {
      sections: Array<{ slug: string; tier: number; label: string }>;
    };
    sections = [];
    for (let i = 0; i < inv.sections.length; i++) {
      const s = inv.sections[i];
      if (s.tier <= tier) sections.push({ slug: s.slug, label: s.label });
    }
  }

  const results: SectionResult[] = [];
  let retriesUsed = 0;
  const started = Date.now();
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const attempts: SectionAttempt[] = [];
    let passed = false;
    let ok = 0;
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt++;
      const t0 = Date.now();
      const r = exec({
        cmd: runSh,
        // --bash is mandatory on the leaf: without it the leaf
        // re-enters the workflow driver (the default) and the run
        // recurses forever — each level spawning the next through
        // the exec trap. (Caught by the first probe run, Nov 19:
        // the leaf `run.sh --only bra101` drove the workflow again
        // instead of running the section.)
        args: ["--bash", "--only", sec.slug, "--resume-dir", resumeDir],
      });
      const elapsed = Date.now() - t0;
      const parsed = parseSectionOutput(r.stdout, r.exitCode);
      attempts.push({
        attempt,
        exitCode: r.exitCode,
        ok: parsed.ok,
        elapsedMs: elapsed,
        executed: parsed.executed,
      });
      ok = parsed.ok;
      if (parsed.passed) {
        passed = true;
        break;
      }
      // Tests ran and failed — record it, never retry. Only a
      // section that never executed is retryable, and only within
      // the chunk's retry budget.
      if (parsed.executed) break;
      if (retriesUsed >= maxRetries) break;
      retriesUsed++;
    }
    let elapsedMs = 0;
    for (let j = 0; j < attempts.length; j++) elapsedMs += attempts[j].elapsedMs;
    results.push({
      slug: sec.slug,
      label: sec.label,
      passed,
      ok,
      attempts,
      elapsedMs,
      flaky: passed && attempts.length > 1,
    });
  }

  let passedCount = 0;
  let totalOk = 0;
  const flaky: string[] = [];
  const failedSlugs: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const s = results[i];
    if (s.passed) {
      passedCount++;
      totalOk += s.ok;
      if (s.flaky) flaky.push(s.slug);
    } else {
      failedSlugs.push(s.slug);
    }
  }
  return {
    tier,
    chunkIndex,
    chunkCount,
    sections: results,
    ran: results.length,
    passed: passedCount,
    failed: results.length - passedCount,
    totalOk,
    flaky,
    failedSlugs,
    elapsedMs: Date.now() - started,
  };
}
