#!/usr/bin/env bun
/**
 * Loud validation refusal through `agentts run` on direct
 * (Linear BRA-145).
 *
 * Validation had unit coverage (tests/test-checker.ts) and
 * integration-mock coverage (typed fixtures under the mock-default
 * Host, run-host-suite.ts ~L1141-1226), but no test refused a bad
 * trap output (or bad input) loudly through `agentts run` on
 * direct. The happy path is incidental on every CLI submit; the
 * refusal on the real path was unproven.
 *
 *   A. Bad input: `agentts run` on direct with n as a string (the
 *      fixture requires a number) is refused at submit — rc 1 and
 *      the exact text `REFUSED: input does not match In: $.n: must
 *      be number` — and no queue entry is created.
 *   B. Bad trap output: a job trap whose declared output schema
 *      requires score to be a number, served by a workers-config
 *      worker that returns score as a string. `agentts run --wait`
 *      on direct fails rc 1 with the exact text `ValidationError:
 *      output validation failed for <runId>/trap-0 (attempt 0):
 *      $.score: must be number`; the queue entry is failed; the
 *      journal carries exactly one validation-error event (phase
 *      output, attempt 0, errors[0].path $.score).
 *
 * Notes, stated plainly:
 * - The bad worker script and the workers-config are written into
 *   this test's scratch workdir at runtime (like test-bra106's
 *   scratch lib) — they are test doubles, not committed fixtures.
 * - AGENTTS_WORKER_SERVER points at a closed port: a Host's
 *   notifyEvent must never post test events to the production
 *   server (port 18741) — the BRA-133 lesson. The dead port fails
 *   fast and is swallowed.
 *
 *   bun tests/test-bra145.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const WORKDIR = process.env.BRA145_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "bra145-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const STATE_DIR = path.join(WORKDIR, "state");
const WF_TRIVIAL = path.join(ROOT, "tests", "workflows", "workflow-bra145-trivial.ts");
const WF_BADJOB = path.join(ROOT, "tests", "workflows", "workflow-bra145-badjob.ts");
// notifyEvent must never reach the production server (BRA-133).
process.env.AGENTTS_WORKER_SERVER = "http://127.0.0.1:59999";

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
    timeout: 120_000,
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function readQueue(): any[] {
  const p = path.join(STATE_DIR, "queue.json");
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}
function readJournal(runId: string): any[] {
  const p = path.join(STATE_DIR, "journals", `${runId}.journal`);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------- A. bad input refused at submit
{
  const runId = "bra145-bad-input";
  const r = cli([
    "run", WF_TRIVIAL, "--adapter", "direct", "--state-dir", STATE_DIR,
    "--run-id", runId, "--input", JSON.stringify({ n: "not-a-number" }),
  ]);
  const text = `${r.out}\n${r.err}`;
  check(r.rc === 1, `A RC OK: bad input exits 1 (got ${r.rc})`);
  check(
    text.includes("REFUSED: input does not match In: $.n: must be number"),
    `A TEXT OK: refusal names the input, the path, and the failure ("REFUSED: input does not match In: $.n: must be number")${text.includes("REFUSED") ? "" : ` — got: ${text.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`}`,
  );
  check(
    !readQueue().some((e) => e.runId === runId),
    `A CLEAN OK: no queue entry was created for the refused run`,
  );
}

// ---------------------------------------------------------------- B. bad trap output refused loudly
{
  // The test-double worker: returns score as a string, violating
  // the declared { score: number, label: string } output schema.
  const worker = path.join(WORKDIR, "bad-worker.ts");
  fs.writeFileSync(
    worker,
    `#!/usr/bin/env bun\n` +
      `// Deliberately wrong-typed job result: score as a string.\n` +
      `const payload = JSON.parse(process.argv[2] ?? "{}");\n` +
      `console.log(JSON.stringify({ score: "high", label: "approved" }));\n`,
  );
  const workersConfig = path.join(WORKDIR, "workers-bra145.json");
  fs.writeFileSync(workersConfig, JSON.stringify({ "bra145-score": worker }));

  const runId = "bra145-bad-output";
  const r = cli([
    "run", WF_BADJOB, "--adapter", "direct", "--state-dir", STATE_DIR,
    "--run-id", runId, "--input", JSON.stringify({ item: "x" }),
    "--workers-config", workersConfig, "--wait",
  ]);
  const text = `${r.out}\n${r.err}`;
  check(r.rc === 1, `B RC OK: bad trap output exits 1 (got ${r.rc})`);
  check(
    text.includes(`ValidationError: output validation failed for ${runId}/trap-0 (attempt 0): $.score: must be number`),
    `B TEXT OK: refusal is a ValidationError naming the trap, the attempt, the path, and the failure${text.includes("ValidationError") ? "" : ` — got: ${text.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`}`,
  );
  check(
    readQueue().find((e) => e.runId === runId)?.status === "failed",
    `B FAILED OK: queue entry for ${runId} is failed (got ${readQueue().find((e) => e.runId === runId)?.status})`,
  );
  const errors = readJournal(runId).filter((e) => e.event === "validation-error");
  check(errors.length === 1, `B JOURNAL OK: exactly 1 validation-error event (got ${errors.length})`);
  if (errors.length === 1) {
    check(
      errors[0].phase === "output" && errors[0].attempt === 0,
      `B JOURNAL OK: phase output, attempt 0 (got ${errors[0].phase}, ${errors[0].attempt})`,
    );
    check(
      Array.isArray(errors[0].errors) && errors[0].errors.some((i: any) => i.path === "$.score"),
      `B JOURNAL OK: the precise error (path $.score) is journaled`,
    );
  }
}

if (FAILURES.length) {
  console.log(`\ntest-bra145: ${FAILURES.length} FAILURE(S)`);
  process.exit(1);
}
console.log(
  "\nPASS bra145 loud validation refusal on direct (bad input refused at submit with the exact text; bad trap output fails the run with a ValidationError naming the trap, path, and failure, journaled once)",
);
