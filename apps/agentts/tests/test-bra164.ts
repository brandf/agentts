#!/usr/bin/env bun
/**
 * Tests for the workflow-driven test-suite runner (Linear BRA-164).
 *
 * The suite used to run only from run.sh's bash section loop. BRA-164
 * moves the loop into the run-tests workflow
 * (workflows/library/run-tests.ts): the engine owns the loop, retry,
 * report, and resume; run.sh keeps only the leaf (`run.sh --bash
 * --only <slug>` per section). This test proves the new driver end to end:
 *
 *   A. The inventory check passes (suite-inventory.json agrees with
 *      run.sh's section definitions on slug + tier).
 *   B. `agentts check` passes on run-tests.ts (first-run gate).
 *   C. `parseSectionOutput` unit checks: pass / test-failure /
 *      crash-no-verdict / empty-exit-0 / the bash " OK:" counting rule.
 *   D. A live 2-section chunk (bra101 + bra103) through the CLI on
 *      direct, with the workflow's per-section OK counts cross-checked
 *      against a bash leaf run of bra103 (same rule, same count).
 *   E. A bogus-slug retry probe: `run.sh --bash --only nosuch` fails loudly
 *      with no verdict, so the workflow retries it 3 times and records
 *      it failed — never retried as a test failure, never passed.
 *
 * Notes, stated plainly:
 * - A throwaway worker server runs on a random port and
 *   AGENTTS_WORKER_SERVER points at it before any submit: a
 *   Host's notifyEvent posts to the default port 18741 otherwise
 *   — the production server — and test events must never land
 *   there (BRA-133).
 * - The live chunk's leaf calls are real `run.sh --bash --only <slug>`
 *   invocations through the direct adapter's exec trap, so they
 *   need the same env run.sh itself needs: DQUICKTS (the C host
 *   build) and TMPDIR, inherited from this process, plus
 *   DURABLETS_HOST / AGENTTS_DURABLETS_DIR (set by run.sh).
 * - The bogus-slug probe depends on run.sh failing loudly on an
 *   unknown --only slug (BRA-164: the startup validation) — a
 *   typo'd --only used to silently run 0 sections and PASS.
 *
 *   DURABLETS_HOST=<built C host> AGENTTS_DURABLETS_DIR=<durablets>
 *   DQUICKTS=$HOME/workspace/dquickts-build-minimal
 *   bun tests/test-bra164.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { parseSectionOutput } from "../workflows/library/run-tests";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const RUN_TESTS = path.join(ROOT, "workflows", "library", "run-tests.ts");
const WORKDIR = process.env.BRA164_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra164-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 21000 + Math.floor(Math.random() * 8000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// Point this process's notifyEvent (and every CLI subprocess's) at
// the TEST server: the default port is the production server.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

const BUN = "/opt/hatch-image/bin/bun";
const RUN_D = "run-bra164-chunk";
const RUN_E = "run-bra164-bogus";

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
const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function cli(args: string[]): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

let server: Subprocess | null = null;
async function startServer(): Promise<void> {
  server = spawn([BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", STATE_DIR, "--port", String(PORT)], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env },
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("bra164 server did not come up");
    await sleep(50);
  }
}
async function stopServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  try {
    s.kill(9);
  } catch { /* already dead */ }
  await s.exited;
}

/** Drive one run-tests input through the CLI (submit + queue run +
 * result) and return the parsed result JSON, or null on a CLI failure
 * (the failure is already recorded as a check). */
function driveRun(runId: string, input: unknown): Record<string, any> | null {
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", RUN_TESTS,
    "--run-id", runId,
    "--input-file", inputFile,
    "--state-dir", STATE_DIR,
    "--adapter", "direct", "--clock", "real", "--gates", "hold",
  ]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId} (got ${JSON.stringify(sub.out.slice(0, 120))})`);
  if (sub.rc !== 0) return null;
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR, "--gates", "hold"]);
  check(drive.rc === 0, `DRIVE OK: queue run exits 0 for ${runId} (got ${drive.rc}: ${(drive.out + drive.err).slice(0, 200)})`);
  if (drive.rc !== 0) return null;
  const res = cli(["result", runId, "--state-dir", STATE_DIR]);
  check(res.rc === 0, `RESULT OK: result exits 0 for ${runId} (got ${res.rc}: ${(res.out + res.err).slice(0, 200)})`);
  if (res.rc !== 0) return null;
  try {
    return JSON.parse(res.out) as Record<string, any>;
  } catch {
    fail(`RESULT OK: result for ${runId} is not JSON (got ${JSON.stringify(res.out.slice(0, 200))})`);
    return null;
  }
}

async function main(): Promise<number> {
  await startServer();
  try {
    // --------------------------------------------- §A inventory check
    console.log("\n=== §A inventory check ===");
    {
      const r = spawnSync(BUN, [path.join(ROOT, "scripts", "suite-inventory.ts"), "check"], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env },
      });
      check(r.status === 0, `INVENTORY OK: suite-inventory check exits 0 (got ${r.status}: ${(r.stdout + r.stderr).slice(0, 200)})`);
      check(
        /inventory check passed: \d+ sections, run\.sh agrees/.test(r.stdout ?? ""),
        `INVENTORY OK: check prints the agreement line (got ${JSON.stringify((r.stdout ?? "").slice(0, 120))})`,
      );
    }

    // --------------------------------------------- §B agentts check
    console.log("\n=== §B agentts check ===");
    {
      const r = cli(["check", RUN_TESTS, "--state-dir", STATE_DIR]);
      check(r.rc === 0, `CHECK OK: agentts check exits 0 on run-tests.ts (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`);
      check(r.out.includes("CHECK OK"), `CHECK OK: check prints CHECK OK (got ${JSON.stringify(r.out.slice(0, 160))})`);
      check(r.out.includes("runTests(RunTestsInput)"), `CHECK OK: entry is runTests(RunTestsInput) (got ${JSON.stringify(r.out.slice(0, 160))})`);
    }

    // --------------------------------------------- §C parseSectionOutput
    console.log("\n=== §C parseSectionOutput ===");
    {
      const p = parseSectionOutput("--- bra103 ---\n OK: a\n OK: b\nPASS bra103 durablets-dir suite\n", 0);
      check(p.ok === 2, `PARSE OK: pass case counts 2 OK lines (got ${p.ok})`);
      check(p.executed === true, `PARSE OK: pass case executed (got ${p.executed})`);
      check(p.passed === true, `PARSE OK: pass case passed (got ${p.passed})`);

      const f = parseSectionOutput("--- bra103 ---\nFAIL: something broke\n", 1);
      check(f.executed === true, `PARSE OK: test-failure case executed (got ${f.executed})`);
      check(f.passed === false, `PARSE OK: test-failure case not passed (got ${f.passed})`);

      // A FAIL line makes the case executed even with a PASS line
      // present: the section's tests ran and one failed, so the
      // workflow records it (never retries it).
      const fp = parseSectionOutput(" OK: a\nFAIL: b broke\nPASS bra103\n", 1);
      check(fp.executed === true && fp.passed === false, `PARSE OK: FAIL + PASS case executed and not passed (got executed=${fp.executed}, passed=${fp.passed})`);

      // The FAILURE(S) summary line is a verdict too.
      const fs = parseSectionOutput("FAILURE(S): 2 checks\n", 1);
      check(fs.executed === true && fs.passed === false, `PARSE OK: FAILURE(S) case executed and not passed (got executed=${fs.executed}, passed=${fs.passed})`);

      const c = parseSectionOutput("bun: command not found\n", 127);
      check(c.executed === false, `PARSE OK: crash case did not execute (got ${c.executed})`);
      check(c.passed === false, `PARSE OK: crash case not passed (got ${c.passed})`);

      // Empty exit-0: no verdict, but the leaf's exit code is
      // authoritative, so passed is true. Unreachable from a real
      // leaf — run.sh always prints its PASS summary on success,
      // which is itself a verdict line — but the parser must match
      // the bash loop (success iff rc == 0), quirk and all.
      const e = parseSectionOutput("", 0);
      check(e.executed === false, `PARSE OK: empty exit-0 case did not execute (got ${e.executed})`);
      check(e.passed === true, `PARSE OK: empty exit-0 case passed on the exit code (got ${e.passed})`);

      // The bash rule is `grep -cE " OK:"` — a "NOT OK:" line
      // contains " OK:" and counts, exactly as the bash loop counts
      // it. The workflow must match bash, quirk and all.
      const n = parseSectionOutput(" OK: a\nNOT OK: b\n", 0);
      check(n.ok === 2, `PARSE OK: NOT OK: counts under the bash rule (got ${n.ok})`);
    }

    // --------------------------------------------- §D live 2-section chunk
    console.log("\n=== §D live 2-section chunk ===");
    const resumeD = path.join(WORKDIR, "resume");
    const outD = driveRun(RUN_D, {
      tier: 1,
      sections: [
        { slug: "bra101", label: "HOLD-identity suite (BRA-101)" },
        { slug: "bra103", label: "durablets-dir suite (BRA-103)" },
      ],
      repoRoot: path.resolve(ROOT, ".."),
      runSh: path.join(ROOT, "run.sh"),
      resumeDir: resumeD,
      chunkIndex: 0,
      chunkCount: 1,
    });
    if (outD) {
      check(outD.ran === 2, `CHUNK OK: 2 sections ran (got ${outD.ran})`);
      check(outD.passed === 2, `CHUNK OK: 2 sections passed (got ${outD.passed})`);
      check(outD.failed === 0, `CHUNK OK: 0 sections failed (got ${outD.failed})`);
      check(outD.totalOk > 0, `CHUNK OK: totalOk > 0 (got ${outD.totalOk})`);
      check(Array.isArray(outD.flaky) && outD.flaky.length === 0, `CHUNK OK: nothing flaky (got ${JSON.stringify(outD.flaky)})`);
      check(Array.isArray(outD.failedSlugs) && outD.failedSlugs.length === 0, `CHUNK OK: no failed slugs (got ${JSON.stringify(outD.failedSlugs)})`);
      check(Array.isArray(outD.sections) && outD.sections.length === 2, `CHUNK OK: 2 per-section results (got ${outD.sections?.length})`);
      const attemptsD = (outD.sections as any[]).flatMap((s) => s.attempts ?? []);
      check(attemptsD.length === 2, `CHUNK OK: 2 attempts recorded (got ${attemptsD.length})`);
      const bySlug = new Map<string, any>((outD.sections as any[]).map((r) => [r.slug, r]));
      const r101 = bySlug.get("bra101");
      const r103 = bySlug.get("bra103");
      check(r101?.passed === true && r101?.attempts?.length === 1, `CHUNK OK: bra101 passed in 1 attempt (got passed=${r101?.passed}, attempts=${r101?.attempts?.length})`);
      check(r103?.passed === true && r103?.attempts?.length === 1, `CHUNK OK: bra103 passed in 1 attempt (got passed=${r103?.passed}, attempts=${r103?.attempts?.length})`);
      check(r103?.ok === 5, `CHUNK OK: bra103 counted 5 OK (got ${r103?.ok})`);
      check(outD.totalOk === (r101?.ok ?? 0) + (r103?.ok ?? 0), `CHUNK OK: totalOk is the sum of the sections (got ${outD.totalOk})`);

      // Cross-check against the bash leaf: the workflow's count for
      // bra103 must equal the bash loop's count for the same section.
      const bashDir = path.join(WORKDIR, "bash-leaf");
      const leaf = spawnSync(path.join(ROOT, "run.sh"), ["--bash", "--only", "bra103", "--resume-dir", bashDir], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env },
      });
      check(leaf.status === 0, `CHUNK OK: bash leaf --only bra103 exits 0 (got ${leaf.status}: ${(leaf.stdout + leaf.stderr).slice(-200)})`);
      const markFile = path.join(bashDir, ".done", "bra103");
      const mark = fs.existsSync(markFile) ? fs.readFileSync(markFile, "utf8") : "";
      const bashOk = Number((mark.match(/^ok=(\d+)/m) ?? [])[1] ?? NaN);
      check(
        Number.isFinite(bashOk) && bashOk === r103?.ok,
        `CHUNK OK: workflow count for bra103 (${r103?.ok}) equals the bash leaf count (${bashOk})`,
      );
    }

    // --------------------------------------------- §E bogus-slug retry probe
    console.log("\n=== §E bogus-slug retry probe ===");
    const outE = driveRun(RUN_E, {
      tier: 1,
      sections: [{ slug: "nosuch", label: "bogus slug (BRA-164 probe)" }],
      repoRoot: path.resolve(ROOT, ".."),
      runSh: path.join(ROOT, "run.sh"),
      resumeDir: path.join(WORKDIR, "resume2"),
      chunkIndex: 0,
      chunkCount: 1,
    });
    if (outE) {
      check(outE.ran === 1, `BOGUS OK: 1 section ran (got ${outE.ran})`);
      check(outE.passed === 0, `BOGUS OK: 0 sections passed (got ${outE.passed})`);
      check(outE.failed === 1, `BOGUS OK: 1 section failed (got ${outE.failed})`);
      check(
        Array.isArray(outE.failedSlugs) && outE.failedSlugs.length === 1 && outE.failedSlugs[0] === "nosuch",
        `BOGUS OK: failedSlugs is [nosuch] (got ${JSON.stringify(outE.failedSlugs)})`,
      );
      check(Array.isArray(outE.flaky) && outE.flaky.length === 0, `BOGUS OK: nothing flaky — a no-verdict section never passes on retry (got ${JSON.stringify(outE.flaky)})`);
      const r = (outE.sections as any[])[0];
      check(r?.attempts?.length === 3, `BOGUS OK: nosuch was attempted 3 times (got ${r?.attempts?.length})`);
      check(r?.ok === 0, `BOGUS OK: nosuch counted 0 OK (got ${r?.ok})`);
      check(r?.flaky === false, `BOGUS OK: nosuch is not flagged flaky (got ${r?.flaky})`);
      const attemptsE = (outE.sections as any[]).flatMap((s) => s.attempts ?? []);
      check(attemptsE.length === 3, `BOGUS OK: 3 attempts recorded (got ${attemptsE.length})`);
      check(
        attemptsE.every((a) => a.exitCode === 1),
        `BOGUS OK: every attempt exited 1 (got ${JSON.stringify(attemptsE.map((a) => a.exitCode))})`,
      );
      check(
        attemptsE.every((a) => a.executed === false),
        `BOGUS OK: every attempt recorded as not executed (got ${JSON.stringify(attemptsE.map((a) => a.executed))})`,
      );
    }
  } finally {
    await stopServer();
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA164 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log("PASS bra164 run-tests workflow driver (inventory check, agentts check, parseSectionOutput units, live 2-section chunk, bogus-slug retry probe — all through the CLI on direct)");
  return 0;
}

process.exit(await main());
