#!/usr/bin/env bun
/**
 * Presentations tests (BRA-109: Google Slides + JudgeFixLoop).
 *
 * Runs workflows/library/presentations.ts under the Host with the
 * mock adapter (input-dependent mock Slides workers — the same logic
 * as the real workers, so the mock run shows a real improving arc)
 * and under the direct adapter (real worker processes). The
 * JudgeFixLoop decide traps use the local decision model via
 * setCanned (the mock adapter's canned decide {choice:"a"} cannot
 * answer revise/keep/converged questions — see the host suite's
 * testJudgeFixLoopMock). Asserts the workflow's contract: the deck
 * is built from the outline, the review loop genuinely improves it
 * (trims over-full slides, shortens long bullets, adds a concrete
 * bullet, fills empty slides), it converges when the deck is fixed,
 * hits the cap honestly when the rubric names a criterion the fix
 * does not know, and invalid input fails loudly.
 *
 * Fixtures live in tests/fixtures/presentations/ (rubric.json,
 * input-converging.json, input-weak.json, input-stubborn.json,
 * input-bad-title.json, input-bad-slides.json,
 * input-bad-rubric.json). Run outputs go to $BRA109_WORKDIR
 * (scratch, set by run.sh). Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Host } from "../src/host";
import { decideLocal } from "../src/decision-model";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKFLOW = path.join(ROOT, "workflows", "library", "presentations.ts");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "presentations");
const WORKDIR = process.env.BRA109_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra109-"));

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

/** Load a fixture input, resolving a rubric file reference to an
 * absolute path (the exec `cat` reads it relative to the process
 * cwd) and pointing outDir at a scratch dir (the real write must
 * never land in the tree). */
function loadInput(name: string, outDirName: string): any {
  const input = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
  if (input.rubric && typeof input.rubric.file === "string" && !path.isAbsolute(input.rubric.file)) {
    input.rubric.file = path.join(ROOT, input.rubric.file);
  }
  input.outDir = path.join(WORKDIR, outDirName);
  return input;
}

async function runOnce(
  host: Host,
  runId: string,
  input: any,
): Promise<{ res: any; journal: any[] }> {
  host.submit(WORKFLOW, { runId, input });
  const q = await host.runQueue();
  const entry = q.find((e) => e.runId === runId);
  if (!entry) throw new Error(`run ${runId} not in queue after runQueue`);
  const res = host.result(runId);
  const journal = host.journal(runId);
  return { res, journal };
}

/** All events for a run: the parent journal plus every child
 * journal (the judge job traps are dispatched by the branch thunks,
 * so their trap events live in the child journals, not the parent's).
 * Child runs are found via the parent's fork events. */
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

function trapCounts(journal: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of journal) {
    if (e.event === "trap") {
      const key = e.type === "job" ? `job:${e.arg?.spec ?? "?"}` : e.type;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

function forkSizes(journal: any[]): number[] {
  return journal.filter((e) => e.event === "fork").map((e) => (e.childRuns ?? []).length);
}

function mockHost(stateDir: string): Host {
  const host = new Host({ stateDir, adapter: new MockAdapter() });
  host.setCanned("decide", (_type, arg) => ({ value: decideLocal(arg.question, arg.options) }));
  return host;
}

async function testMockConverging(): Promise<void> {
  console.log("\n=== presentations mock: converging fixture (rubric file) ===");
  const stateDir = path.join(WORKDIR, "mock-converging");
  const host = mockHost(stateDir);
  const input = loadInput("input-converging.json", "presentations-converging");
  const { res, journal } = await runOnce(host, "run-presentations-converging", input);
  check(res.status === "done", `CONVERGING OK: run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
  if (res.status !== "done") return;
  const out = res.output;
  check(out.loops === 2, `CONVERGING OK: early stop at loop 2 (got ${out.loops})`);
  check(out.converged === true, `CONVERGING OK: converged (got ${out.converged})`);
  check(out.finalMeanScore === 0.98, `CONVERGING OK: final mean score 0.98 (got ${out.finalMeanScore})`);
  check(out.deckId.startsWith("deck-"), `CONVERGING OK: deck id is deterministic (${out.deckId})`);
  check(out.slides === 3, `CONVERGING OK: 3 slides (got ${out.slides})`);
  check(
    out.deckPath === path.join(input.outDir, "deck.json") && out.markdownPath === path.join(input.outDir, "deck.md"),
    `CONVERGING OK: result carries the output paths (${out.deckPath}, ${out.markdownPath})`,
  );
  check(out.deck.revisions === 1, `CONVERGING OK: deck revised once (got ${out.deck.revisions})`);
  check(out.deck.text.includes(`(revised ${out.deck.revisions})`), "CONVERGING OK: deck text carries the revision marker");
  // The fix genuinely improved the deck: slide 1 trimmed from 6 to
  // 5 bullets, keeping the number-bearing evidence bullet.
  const slide1 = out.deck.slides[0];
  check(slide1.bullets.length === 5, `CONVERGING OK: slide 1 trimmed to 5 bullets (got ${slide1.bullets.length})`);
  check(
    slide1.bullets.includes("Beta reached 500 users"),
    "CONVERGING OK: trim kept the evidence bullet (Beta reached 500 users)",
  );
  check(
    !slide1.bullets.includes("Zeta retro held"),
    "CONVERGING OK: trim dropped the sixth bullet (Zeta retro held)",
  );
  // The long bullet was shortened to 12 words + ellipsis.
  const longBullet = out.deck.slides[1].bullets[0];
  check(longBullet.endsWith(" …"), `CONVERGING OK: long bullet shortened with ellipsis (got "${longBullet}")`);
  check(
    longBullet.split(/\s+/).filter(Boolean).length === 13,
    `CONVERGING OK: shortened bullet is 12 words + ellipsis (got ${longBullet.split(/\s+/).filter(Boolean).length} tokens)`,
  );
  // Three judges in parallel: each loop forks 3 branches.
  const forks = forkSizes(journal);
  check(forks.length === 2 && forks.every((n) => n === 3), `CONVERGING OK: 2 loops, each forking 3 judges (got ${JSON.stringify(forks)})`);
  const counts = trapCounts(allEvents(host, "run-presentations-converging"));
  check(counts["job:slides-create"] === 1, `CONVERGING OK: 1 slides-create trap (got ${counts["job:slides-create"]})`);
  check(counts["job:slides-render"] === 1, `CONVERGING OK: 1 slides-render trap (got ${counts["job:slides-render"]})`);
  check(counts["job:judge"] === 6, `CONVERGING OK: 6 judge traps (3 per loop, got ${counts["job:judge"]})`);
  check(counts["job:fix"] === 1, `CONVERGING OK: 1 fix trap — only loop 1 needed fixes (got ${counts["job:fix"]})`);
  check(counts["job:aggregate"] === 2, `CONVERGING OK: 2 aggregate traps (got ${counts["job:aggregate"]})`);
  check(counts["exec"] === 1, `CONVERGING OK: 1 exec trap — the rubric file read (got ${counts["exec"] ?? 0})`);
}

async function testMockWeak(): Promise<void> {
  console.log("\n=== presentations mock: weak fixture (inline rubric, all four criteria missed) ===");
  const stateDir = path.join(WORKDIR, "mock-weak");
  const host = mockHost(stateDir);
  const input = loadInput("input-weak.json", "presentations-weak");
  const { res } = await runOnce(host, "run-presentations-weak", input);
  check(res.status === "done", `WEAK OK: run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
  if (res.status !== "done") return;
  const out = res.output;
  check(out.loops === 2, `WEAK OK: fixed in 2 loops (got ${out.loops})`);
  check(out.converged === true, `WEAK OK: converged (got ${out.converged})`);
  check(out.finalMeanScore === 0.98, `WEAK OK: final mean score 0.98 (got ${out.finalMeanScore})`);
  const slide1 = out.deck.slides[0];
  const slide2 = out.deck.slides[1];
  check(slide1.bullets.length === 5, `WEAK OK: slide 1 trimmed to 5 bullets (got ${slide1.bullets.length})`);
  check(
    slide2.bullets.includes("Key point: Risks."),
    "WEAK OK: empty slide filled (Key point: Risks.)",
  );
  check(
    slide2.bullets.includes("In 2026, 3 pilot teams ran this process end to end."),
    "WEAK OK: concrete bullet added to the slide with the fewest bullets",
  );
  check(slide2.bullets.length === 2, `WEAK OK: slide 2 has exactly 2 bullets (got ${slide2.bullets.length})`);
}

async function testMockStubborn(): Promise<void> {
  console.log("\n=== presentations mock: stubborn fixture (custom rubric, unfixable criterion) ===");
  const stateDir = path.join(WORKDIR, "mock-stubborn");
  const host = mockHost(stateDir);
  const input = loadInput("input-stubborn.json", "presentations-stubborn");
  const { res } = await runOnce(host, "run-presentations-stubborn", input);
  check(res.status === "done", `STUBBORN OK: run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
  if (res.status !== "done") return;
  const out = res.output;
  check(out.loops === 3, `STUBBORN OK: hard stop at 3 loops (got ${out.loops})`);
  check(out.converged === false, `STUBBORN OK: not converged (got ${out.converged})`);
  check(out.finalMeanScore === 0, `STUBBORN OK: final mean score 0 (got ${out.finalMeanScore})`);
  check(out.deck.revisions === 0, `STUBBORN OK: deck never revised (got ${out.deck.revisions})`);
  check(!out.deck.text.includes("(revised"), "STUBBORN OK: no revision marker — the fix changed nothing");
}

async function testMockBadInputs(): Promise<void> {
  console.log("\n=== presentations mock: invalid inputs fail loudly ===");
  const cases: { name: string; input: any; needle: string }[] = [
    { name: "bad-title", input: loadInput("input-bad-title.json", "presentations-bad-title"), needle: "title" },
    { name: "bad-slides", input: loadInput("input-bad-slides.json", "presentations-bad-slides"), needle: "slides" },
    {
      name: "bad-slide-title",
      input: { title: "Bad", slides: [{ title: "", bullets: ["x"] }], outDir: path.join(WORKDIR, "presentations-bad-slide") },
      needle: "slide 1",
    },
  ];
  for (const c of cases) {
    const host = mockHost(path.join(WORKDIR, `mock-${c.name}`));
    const { res } = await runOnce(host, `run-presentations-${c.name}`, c.input);
    check(res.status === "failed", `BAD-${c.name.toUpperCase()} OK: run failed (got ${res.status})`);
    check(
      (res.error ?? "").toLowerCase().includes(c.needle),
      `BAD-${c.name.toUpperCase()} OK: error names the problem (${(res.error ?? "").slice(0, 160)})`,
    );
  }
}

async function testMockBadRubric(): Promise<void> {
  console.log("\n=== presentations mock: missing rubric file fails loudly ===");
  const stateDir = path.join(WORKDIR, "mock-bad-rubric");
  const host = mockHost(stateDir);
  const input = loadInput("input-bad-rubric.json", "presentations-bad-rubric");
  const { res } = await runOnce(host, "run-presentations-bad-rubric", input);
  check(res.status === "failed", `BAD-RUBRIC OK: run failed (got ${res.status})`);
  check(
    (res.error ?? "").includes("rubric") || (res.error ?? "").includes("no-such-rubric"),
    `BAD-RUBRIC OK: error names the rubric file (${(res.error ?? "").slice(0, 160)})`,
  );
}

async function testRealWorkers(): Promise<void> {
  console.log("\n=== presentations real workers (direct adapter, worker processes) ===");
  const stateDir = path.join(WORKDIR, "real-converging");
  const host = new Host({ stateDir, adapter: new DirectAdapter() });
  const input = loadInput("input-converging.json", "presentations-real");
  const { res } = await runOnce(host, "run-presentations-real", input);
  check(res.status === "done", `REAL OK: run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
  if (res.status !== "done") return;
  const out = res.output;
  check(out.loops === 2, `REAL OK: early stop at loop 2 (got ${out.loops})`);
  check(out.converged === true, `REAL OK: converged (got ${out.converged})`);
  check(out.finalMeanScore === 0.98, `REAL OK: final mean score 0.98 (got ${out.finalMeanScore})`);
  check(out.deck.slides[0].bullets.length === 5, `REAL OK: slide 1 trimmed to 5 bullets (got ${out.deck.slides[0].bullets.length})`);
  // The real render actually wrote the files (the mock only computes
  // paths + bytes).
  check(fs.existsSync(out.deckPath), `REAL OK: deck file written (${out.deckPath})`);
  check(fs.existsSync(out.markdownPath), `REAL OK: markdown file written (${out.markdownPath})`);
  const deckJson = JSON.parse(fs.readFileSync(out.deckPath, "utf8"));
  check(deckJson.deckId === out.deckId, `REAL OK: deck file carries the result deck id (${deckJson.deckId})`);
  const markdown = fs.readFileSync(out.markdownPath, "utf8");
  check(markdown.includes("# Quarterly review"), "REAL OK: markdown carries the deck title");
  check(markdown.includes("## Slide 1: What shipped"), "REAL OK: markdown carries the slide headings");
  check(markdown.includes("Beta reached 500 users"), "REAL OK: markdown carries the kept evidence bullet");
  check(markdown.includes(`Deck: ${out.deckId} · 3 slides`), "REAL OK: markdown carries the deck footer");
  // A bad outline fails loudly under the direct adapter too.
  const host2 = new Host({ stateDir: path.join(WORKDIR, "real-bad"), adapter: new DirectAdapter() });
  const badInput = loadInput("input-bad-title.json", "presentations-real-bad");
  const { res: badRes } = await runOnce(host2, "run-presentations-real-bad", badInput);
  check(badRes.status === "failed", `REAL-BAD OK: bad title run failed (got ${badRes.status})`);
  check(
    (badRes.error ?? "").toLowerCase().includes("title"),
    `REAL-BAD OK: error names the title (${(badRes.error ?? "").slice(0, 160)})`,
  );
}

async function main(): Promise<number> {
  await testMockConverging();
  await testMockWeak();
  await testMockStubborn();
  await testMockBadInputs();
  await testMockBadRubric();
  await testRealWorkers();
  console.log();
  if (FAILURES.length) {
    console.log(`FAIL (${FAILURES.length} check(s)):`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log(
    "PASS presentations (mock converging 2 loops + trim/evidence/shorten + mean 0.98, mock weak all-four fixed in 2 loops, mock stubborn 3-loop cap + unrevised, invalid inputs + bad rubric fail loudly, real workers + files written)",
  );
  return 0;
}

process.exit(await main());
