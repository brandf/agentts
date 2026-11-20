#!/usr/bin/env bun
/**
 * rubricReview CLI+direct e2e test (Linear BRA-141).
 *
 * `tests/test-rubric-review.ts` covers rubricReview via mock + direct
 * (Host API) but has 0 `cli.ts` mentions. The validation-corpus runs
 * were one-off scripts, not committed tests. No CLI run of a rubric
 * review with a standin exists in-suite. This test submits the same
 * probe workflow (`tests/workflows/workflow-rubric-review-probe.ts`)
 * through `bun src/cli.ts` on the direct adapter and proves the
 * review runs end to end on the real path: the weak-rubric negative
 * control (round 1 scores 0, the loop revises it, round 2 converges
 * at 1.0) and the meta-rubric positive control (1.0 in round 1, 1
 * loop, every criterion 10).
 *
 * What this proves, through the real usage path:
 *   A. Weak review: submit prints `RUN <runId>`, `queue run`
 *      drives it to `done`, `result` is the probe output — the
 *      review ran 2 loops and converged at a final mean of 1.0,
 *      the 3 final verdicts each carry 14 per-criterion scores,
 *      5 guided answers (questions 1–5 in order) and free-form
 *      openFeedback, and the fixed rubric names all 14
 *      meta-criteria. The journal shows 2 aggregates with means
 *      [0, 1] and 6 judge inputs across the 2 loops, the first
 *      carrying both reference examples and the rendered scope.
 *   B. Meta review: the meta-rubric itself scores 1.0 in round 1
 *      and converges in 1 loop, every criterion 10.
 *
 * Notes, stated plainly:
 * - A throwaway worker server runs on a random port and
 *   AGENTTS_WORKER_SERVER points at it before any submit: a
 *   Host's notifyEvent posts to the default port 18741 otherwise
 *   — the production server — and test events must never land
 *   there (BRA-133).
 * - The journal is read through a read-only in-process Host over
 *   the same state dir (construction drives nothing); the runs
 *   themselves are driven only by CLI subprocesses.
 * - The fixture strings (weak rubric, examples, scope, stems) are
 *   copied verbatim from test-rubric-review.ts — this test proves
 *   the CLI path, not new review behavior; the mid control and
 *   the loud-failure cases stay in test-rubric-review.ts.
 *
 *   DURABLETS_HOST=<built C host> AGENTTS_DURABLETS_DIR=<durablets>
 *   bun tests/test-bra141.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { Host } from "../src/host";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-rubric-review-probe.ts");
const META_RUBRIC = path.join(ROOT, "workflows", "rubrics", "meta-rubric.md");
const WORKDIR = process.env.BRA141_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra141-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 21000 + Math.floor(Math.random() * 8000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// Point this process's notifyEvent (and every CLI subprocess's) at
// the TEST server: the default port is the production server.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

const BUN = "/opt/hatch-image/bin/bun";

// Fixtures, copied verbatim from tests/test-rubric-review.ts.
const WEAK_RUBRIC = [
  "# Briefing Rubric",
  "",
  "Score each paper on: concrete numbers, how it works, other work, limitations, insights.",
  "",
].join("\n");

const GOOD_EXAMPLE =
  "Paper A: FlashAttention 2,830 MB / 144.9 ms vs. DiJiang 4,085 MB / 157 ms. " +
  "The mechanism replaces softmax with a tiled online algorithm. " +
  "Relates to Hedgehog (2611.22947), which it supersedes on memory traffic. " +
  "Insight: any future linear-attention proposal needs a DRAM-traffic budget in its abstract. " +
  "Limitation: evaluated on one GPU, one config.";
const MEDIOCRE_EXAMPLE =
  "Paper B is a new attention mechanism. It improves accuracy. " +
  "Related to attention research. Interesting direction with more work needed.";

const SCOPE = {
  inScope: "one daily edition of the AI research briefing — at least five papers, verified, deduped",
  outOfScope: "papers already covered in a prior edition; anything that is not a research paper",
  boundaries: "generalizes across different days' editions, not across kinds of morning report",
};

const META_CRITERIA = [
  "coverage",
  "discrimination",
  "anchored-scores",
  "actionability",
  "checkability",
  "independence",
  "calibration",
  "open-ended-feedback",
  "drafter-shared",
  "anti-patterns",
  "versioning",
  "no-process-in-prose",
  "multiple-perspectives",
  "signs-of-generality",
];

const META_STEMS: Record<string, string> = {
  coverage: "coverage",
  discrimination: "discrimination",
  "anchored-scores": "anchor",
  actionability: "actionab",
  checkability: "checkab",
  independence: "independen",
  calibration: "calibrat",
  "open-ended-feedback": "open-ended",
  "drafter-shared": "drafter",
  "anti-patterns": "anti-pattern",
  versioning: "version",
  "no-process-in-prose": "no process",
  "multiple-perspectives": "perspective",
  "signs-of-generality": "generality",
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
    if (Date.now() > deadline) throw new Error("bra141 server did not come up");
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

function readQueue(): any[] {
  const p = path.join(STATE_DIR, "queue.json");
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}
function queueStatus(runId: string): string | null {
  return readQueue().find((e) => e.runId === runId)?.status ?? null;
}

/** Read-only journal access through an in-process Host over the
 * same state dir. Constructing a Host drives nothing. */
function readHost(): Host {
  return new Host({ stateDir: STATE_DIR });
}

function unwrapResult(e: any): unknown {
  const r = e?.result;
  if (r !== null && typeof r === "object" && !Array.isArray(r) && "value" in r) return r.value;
  return r;
}

function allEvents(host: Host, runId: string): any[] {
  const events = host.journal(runId);
  const out = [...events];
  for (const e of events) {
    if (e.event === "fork" && Array.isArray(e.childRuns)) {
      for (const child of e.childRuns) out.push(...host.journal(child));
    }
  }
  return out;
}

/** Aggregate results in journal order (one per loop) — copied from
 * test-rubric-review.ts. */
function aggregates(host: Host, runId: string): any[] {
  const out: any[] = [];
  for (const e of host.journal(runId)) {
    if (e.event !== "trap-result") continue;
    const v = unwrapResult(e) as any;
    if (v && typeof v.meanScore === "number" && typeof v.summary === "string" && typeof v.approved === "number") {
      out.push(v);
    }
  }
  return out;
}

/** Judge trap inputs, in journal order (they live in the
 * fork-child journals) — copied from test-rubric-review.ts. */
function judgeInputs(host: Host, runId: string): any[] {
  return allEvents(host, runId)
    .filter((e: any) => e.event === "trap" && e.type === "job" && e.arg?.spec === "judge")
    .map((e: any) => e.arg.input);
}

function writeInput(name: string, input: any): string {
  const p = path.join(WORKDIR, name);
  fs.writeFileSync(p, JSON.stringify(input, null, 2));
  return p;
}

/** Submit a probe run through the CLI, drive it, return the parsed
 * result output (or null, with a FAIL recorded). */
function runProbe(inputFile: string, runId: string): any | null {
  const sub = cli(["run", WORKFLOW, "--run-id", runId, "--adapter", "direct", "--input-file", inputFile, "--state-dir", STATE_DIR, "--gates", "hold"]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId}`);
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR, "--gates", "hold"]);
  check(drive.rc === 0, `DRIVE OK: queue run exits 0 for ${runId} (got ${drive.rc}: ${(drive.out + drive.err).slice(0, 200)})`);
  check(queueStatus(runId) === "done", `DONE OK: ${runId} done (got ${queueStatus(runId) ?? "missing"})`);
  const res = cli(["result", runId, "--state-dir", STATE_DIR]);
  check(res.rc === 0, `RESULT OK: result exits 0 for ${runId} (got ${res.rc})`);
  try {
    return JSON.parse(res.out);
  } catch {
    fail(`RESULT OK: result prints parseable JSON for ${runId} (got ${JSON.stringify(res.out.slice(0, 200))})`);
    return null;
  }
}

function assertReviewShape(tag: string, out: any): void {
  check(out && typeof out === "object", `${tag} OK: review output present`);
  if (!out || typeof out !== "object") return;
  const verdicts = out.lastVerdicts;
  check(Array.isArray(verdicts) && verdicts.length === 3, `${tag} OK: 3 final verdicts (got ${verdicts?.length})`);
  if (!Array.isArray(verdicts)) return;
  for (let i = 0; i < verdicts.length; i++) {
    const v = verdicts[i];
    check(
      Array.isArray(v.scores) && v.scores.length === 14,
      `${tag} OK: verdict ${i} carries 14 per-criterion scores (got ${v.scores?.length})`,
    );
    check(
      Array.isArray(v.guidedAnswers) && v.guidedAnswers.length === 5,
      `${tag} OK: verdict ${i} carries 5 guided answers (got ${v.guidedAnswers?.length})`,
    );
    check(
      typeof v.openFeedback === "string" && v.openFeedback.length > 0,
      `${tag} OK: verdict ${i} carries free-form openFeedback`,
    );
    if (Array.isArray(v.guidedAnswers)) {
      check(
        JSON.stringify(v.guidedAnswers.map((a: any) => a.question)) === JSON.stringify([1, 2, 3, 4, 5]),
        `${tag} OK: verdict ${i} guided answers are questions 1-5 in order`,
      );
    }
  }
}

async function main(): Promise<number> {
  await startServer();
  try {
    // A. Weak review: the negative control, through the CLI.
    console.log("\n=== A. weak rubric review (CLI+direct) ===");
    {
      const runId = "run-bra141-weak";
      const inputFile = writeInput("weak-input.json", {
        mode: "review",
        rubricText: WEAK_RUBRIC,
        threshold: 0.8,
        scope: SCOPE,
        artifactKind: "AI research briefing edition",
        goodExample: GOOD_EXAMPLE,
        mediocreExample: MEDIOCRE_EXAMPLE,
        metaRubricFile: META_RUBRIC,
      });
      const out = runProbe(inputFile, runId);
      const review = out?.review;
      check(review?.loops === 2, `WEAK OK: 2 loops (got ${review?.loops})`);
      check(review?.converged === true, `WEAK OK: converged (got ${review?.converged})`);
      check(review?.finalMeanScore === 1, `WEAK OK: final mean 1.0 (got ${review?.finalMeanScore})`);
      assertReviewShape("WEAK", review);
      const fixed: string = review?.rubric ?? "";
      for (const name of META_CRITERIA) {
        check(fixed.toLowerCase().includes(META_STEMS[name]), `WEAK OK: fixed rubric names "${name}"`);
      }
      const host = readHost();
      const aggs = aggregates(host, runId);
      check(aggs.length === 2, `WEAK OK: 2 aggregates (got ${aggs.length})`);
      check(aggs[0]?.meanScore === 0, `WEAK OK: round-1 aggregate mean 0 — the negative control scores low (got ${aggs[0]?.meanScore})`);
      check(aggs[1]?.meanScore === 1, `WEAK OK: round-2 aggregate mean 1.0 (got ${aggs[1]?.meanScore})`);
      check(
        Array.isArray(aggs[1]?.openFeedbackThemes) && aggs[1].openFeedbackThemes.length > 0,
        `WEAK OK: final aggregate carries openFeedbackThemes (${JSON.stringify(aggs[1]?.openFeedbackThemes)?.slice(0, 120)})`,
      );
      const inputs = judgeInputs(host, runId);
      check(inputs.length === 6, `REFS OK: 6 judge inputs across 2 loops (got ${inputs.length})`);
      if (inputs.length > 0) {
        const refs = inputs[0]?.item?.references ?? [];
        check(
          refs.length === 2 && refs[0]?.label === "good" && refs[0]?.text === GOOD_EXAMPLE,
          "REFS OK: first judge input carries the known-good example",
        );
        check(
          refs.length === 2 && refs[1]?.label === "mediocre" && refs[1]?.text === MEDIOCRE_EXAMPLE,
          "REFS OK: first judge input carries the known-mediocre example",
        );
        check(
          typeof inputs[0]?.item?.scope === "string" && inputs[0].item.scope.includes("In scope:"),
          "REFS OK: first judge input carries the rendered scope",
        );
      }
    }

    // B. Meta review: the positive control, through the CLI.
    console.log("\n=== B. meta-rubric review (CLI+direct) ===");
    {
      const runId = "run-bra141-meta";
      const inputFile = writeInput("meta-input.json", {
        mode: "review",
        rubricFile: META_RUBRIC,
        threshold: 0.8,
        scope: SCOPE,
        artifactKind: "AI research briefing edition",
        goodExample: GOOD_EXAMPLE,
        mediocreExample: MEDIOCRE_EXAMPLE,
        metaRubricFile: META_RUBRIC,
      });
      const out = runProbe(inputFile, runId);
      const review = out?.review;
      check(review?.loops === 1, `META OK: 1 loop (got ${review?.loops})`);
      check(review?.converged === true, `META OK: converged (got ${review?.converged})`);
      check(review?.finalMeanScore === 1, `META OK: final mean 1.0 (got ${review?.finalMeanScore})`);
      assertReviewShape("META", review);
      const verdicts = review?.lastVerdicts ?? [];
      for (let i = 0; i < verdicts.length; i++) {
        check(verdicts[i]?.scores?.every((s: any) => s.score === 10), `META OK: verdict ${i} scores every criterion 10`);
      }
    }
  } finally {
    await stopServer();
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA141 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log("PASS bra141 rubricReview CLI+direct e2e (weak review 0 → 1.0 in 2 loops with full verdict shape, meta review 1.0 in 1 loop with all 10s — both through the CLI on direct)");
  return 0;
}

process.exit(await main());
