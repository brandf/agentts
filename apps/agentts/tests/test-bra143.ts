#!/usr/bin/env bun
/**
 * Prove the bugfix worker on the direct adapter (Linear BRA-143).
 *
 * tests/test-bra106.ts runs workflow-bugfix-bra54.ts end to end
 * under mock only; the mock adapter routes bugfix-* specs to live
 * runBugfix(..., {simulate:true})
 * (plugins/mock/src/mock-adapter.ts:1005-1006). There was no
 * direct-adapter run (real worker process with fs+exec) and no CLI
 * test — even though the workflow's own header says it is designed
 * for the direct adapter. The plan-driven-work template's fix phase
 * runs bugfix jobs; if the worker is broken on the real path, the
 * fix step silently does nothing real.
 *
 * And it WAS broken on the real path: the direct reproduce step
 * never worked. The worker builds a runnable scratch copy of the
 * target repo, builds the real C host, and runs the real CLI on the
 * JudgeFixLoop workflow — but the copy omitted plugins/ (which
 * src/cli.ts statically imports), the inner CLI run passed no input
 * (the JFL workflow requires JudgeFixLoopInput), a bare `run` only
 * submits (so the `result:` line never appeared), and the result
 * parser looked for that line instead of the --wait JSON. All four
 * are fixed in workflows/dogfood/bugfix-worker.ts (see its
 * comments); this test proves the repaired path end to end.
 *
 *   A. Direct-adapter run via the Host API (real worker process
 *      with fs+exec): submit workflow-bugfix-bra54.ts with repoRoot
 *      = this repo's apps/agentts (the copy under test — never the
 *      live tree) and runQueue. The run returns "already-fixed"
 *      with the post-fix signature — reproduce reports 5 loops,
 *      converged, mean 0.85 — and reproduceSimulated is false:
 *      the reproduce job ran for real (runnable copy, real C host
 *      build, real CLI run), not simulated.
 *   B. CLI test: `agentts run` on direct with --wait, same input.
 *      rc 0, stdout parses as the BugfixResult JSON with status
 *      "already-fixed" and reproduceSimulated false. A second CLI
 *      process (`agentts result`) returns the same record.
 *
 * Notes, stated plainly:
 * - Each section runs its own full reproduce (~30s: copy + bun
 *   install + C host build + CLI mock run), so this test takes
 *   ~60-70s. That is the honest cost of proving the real path;
 *   the reproduce is hermetic per run by design.
 * - The reproduce worker copies repoRoot into /tmp scratch and
 *   works there — no run output ever lands in the target repo.
 * - AGENTTS_WORKER_SERVER points at a closed port: a Host's
 *   notifyEvent must never post test events to the production
 *   server (port 18741) — the BRA-133 lesson. The dead port fails
 *   fast and is swallowed.
 *
 *   bun tests/test-bra143.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Host } from "../src/host";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const WORKDIR = process.env.BRA143_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "bra143-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const WF = path.join(ROOT, "workflows", "dogfood", "workflow-bugfix-bra54.ts");
// The target repo is THIS copy's apps/agentts — never the live tree.
// notifyEvent must never reach the production server (BRA-133).
process.env.AGENTTS_WORKER_SERVER = "http://127.0.0.1:59999";

const INPUT = {
  repoRoot: ROOT,
  workflow: "tests/workflows/workflow-judge-fix-loop.ts",
  targetFile: "src/cli.ts",
};

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
function cli(args: string[]): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 300_000,
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function parseJson(out: string): any | null {
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- A. direct adapter, Host API
{
  const host = new Host({ stateDir: path.join(WORKDIR, "state-host"), adapter: new DirectAdapter() });
  host.submit(WF, { runId: "bra143-direct", input: INPUT });
  await host.runQueue();
  const res = host.result("bra143-direct");
  check(res.status === "done", `A DONE OK: direct run done (got ${res.status}${res.error ? ` — ${res.error.slice(0, 200)}` : ""})`);
  const out = res.output as any;
  check(
    out?.status === "already-fixed",
    `A STATUS OK: status is already-fixed (got ${JSON.stringify(out)?.slice(0, 160)})`,
  );
  check(
    out?.reproduced === false && out?.reproduceSimulated === false,
    `A REAL OK: reproduce ran for real — reproduced false, reproduceSimulated false (got reproduced ${out?.reproduced}, simulated ${out?.reproduceSimulated})`,
  );
  // The reproduce evidence is the real CLI run's numbers, not the
  // mock simulation's canned text.
  const printOut = host.output("bra143-direct");
  const reproLine = printOut.split("\n").find((l) => l.startsWith("reproduce:"));
  const repro = reproLine ? JSON.parse(reproLine.slice("reproduce: ".length)) : null;
  check(
    repro !== null && repro.loops === 5 && repro.converged === true && repro.mean === 0.85,
    `A SIGNATURE OK: reproduce reports the post-fix signature (5 loops, converged, mean 0.85 — got ${JSON.stringify(repro)?.slice(0, 200)})`,
  );
  check(
    repro !== null && typeof repro.evidence === "string" && repro.evidence.includes("CLI mock path on tests/workflows/workflow-judge-fix-loop.ts"),
    `A EVIDENCE OK: reproduce evidence names the real CLI run (got ${JSON.stringify(repro?.evidence)?.slice(0, 160)})`,
  );
  check(
    repro !== null && typeof repro.runnableCopy === "string" && repro.runnableCopy.length > 0 &&
      typeof repro.hostBin === "string" && repro.hostBin.endsWith("durablets"),
    `A REAL OK: reproduce built a runnable copy + a real C host binary (runnableCopy ${repro?.runnableCopy}, hostBin ${repro?.hostBin})`,
  );
}

// ---------------------------------------------------------------- B. CLI test
{
  const stateDir = path.join(WORKDIR, "state-cli");
  const inputFile = path.join(WORKDIR, "bra143-cli.input.json");
  fs.writeFileSync(inputFile, JSON.stringify(INPUT));
  const r = cli([
    "run", WF, "--adapter", "direct", "--state-dir", stateDir,
    "--run-id", "bra143-cli", "--input-file", inputFile, "--wait",
  ]);
  check(r.rc === 0, `B CLI OK: agentts run --wait exited 0 (got ${r.rc}${r.rc !== 0 ? ` — ${(r.out + r.err).trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` : ""})`);
  const out = parseJson(r.out);
  check(
    out !== null && out.status === "already-fixed",
    `B STATUS OK: CLI run returns already-fixed (got ${JSON.stringify(out)?.slice(0, 160)})`,
  );
  check(
    out !== null && out.reproduced === false && out.reproduceSimulated === false,
    `B REAL OK: CLI reproduce ran for real — reproduced false, reproduceSimulated false`,
  );
  const res = cli(["result", "bra143-cli", "--state-dir", stateDir]);
  check(res.rc === 0, `B RESULT OK: a second CLI process reads the result (rc ${res.rc})`);
  const out2 = parseJson(res.out);
  check(
    out2 !== null && out2.status === "already-fixed" && out2.reproduceSimulated === false,
    `B RESULT OK: result agrees (already-fixed, reproduceSimulated false)`,
  );
}

if (FAILURES.length) {
  console.log(`\ntest-bra143: ${FAILURES.length} FAILURE(S)`);
  process.exit(1);
}
console.log(
  "\nPASS bra143 bugfix worker on the direct adapter (real worker process with fs+exec: runnable copy + real C host build + real CLI run, post-fix signature 5 loops / converged / mean 0.85, via Host API and via the CLI)",
);
