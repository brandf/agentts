#!/usr/bin/env bun
/**
 * Mock adapter silently fakes exec success (Linear BRA-120).
 *
 * The mock adapter — the default outside the production state dir —
 * answered every exec trap except `cat` and `echo hi` with a canned
 * {stdout: "", exitCode: 0} without running anything and without any
 * warning: a real workflow run under mock that depends on exec passed
 * vacuously. Found Nov 18 while verifying BRA-116: three consecutive
 * runs "passed" all seven mechanical checks; the only tells were
 * empty stdout and wallMs 0 in the journal.
 *
 * The fix is a signal, not a behavior change (Brandon, Nov 18: the
 * mock must not run anything — only `cat` / `echo hi` stay real):
 *   - a canned exec logs CANNED EXEC on stderr, naming the command,
 *     and the answer carries `canned: true` (host-side-only
 *     provenance on TrapAnswer, carried through repairs and the
 *     BRA-75 re-dispatch check, like worker/tokens/auto);
 *   - the journal's trap-dispatched AND trap-result events for the
 *     canned exec carry `canned: true`. `cat`, `echo hi`, and a
 *     queued (deliberate) answer never carry it, and the marking
 *     never crosses into the engine.
 *
 * What this proves (CLI-driven, mock adapter, own state dirs,
 * workflow-bra120-exec.ts — one canned exec, one cat, one echo hi):
 *   A. Canned exec is loud + marked (the issue reproduction):
 *      submit + drive — the run completes, the canned exec returns
 *      {stdout: "", exitCode: 0}, the queue-run stderr carries the
 *      CANNED EXEC line naming the command exactly once (cat and
 *      echo hi do not warn), and the journal's trap-dispatched AND
 *      trap-result events for the canned exec carry `canned: true`
 *      while the cat and echo hi events carry none.
 *   B. In-process: the adapter answers a canned exec with the canned
 *      result + the exact warning + canned: true; cat reads for real
 *      with no warning and no marking; echo hi returns "hi\n" with
 *      no warning and no marking; a QUEUED exec answer is delivered
 *      as-is with no warning and no marking.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra120.ts
 *   (run.sh sets DURABLETS_HOST and runs this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Host } from "../src/host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA120_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra120-"));
fs.mkdirSync(WORKDIR, { recursive: true });

const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra120-exec.ts");
const CAT_FILE = path.join(WORKDIR, "cat-target.txt");
const CAT_CONTENT = "bra120 cat target\nsecond line\n";
fs.writeFileSync(CAT_FILE, CAT_CONTENT);

// The exact warning the mock adapter emits for a canned exec —
// quoted here, never paraphrased (the command is the workflow's
// canned exec: `ls -la`).
const CANNED_LS_LINE =
  `[mock] CANNED EXEC: command "ls -la" was NOT run — returning simulated {stdout: "", exitCode: 0}. Only cat and echo hi execute for real under --adapter mock.`;

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

function journalEvents(stateDir: string, runId: string): any[] {
  const p = path.join(stateDir, "journals", `${runId}.journal`);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
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

// Map each exec trap to its journal events via the `trap` event's
// arg (cmd), which names the command the workflow passed.
function execEvents(events: any[]): Record<string, { dispatched: any | undefined; result: any | undefined }> {
  const byCmd: Record<string, { dispatched: any | undefined; result: any | undefined }> = {};
  for (const e of events) {
    if (e.event === "trap" && e.type === "exec" && typeof e.arg?.cmd === "string") {
      const trapId = e.trapId;
      byCmd[e.arg.cmd] = {
        dispatched: events.find((x) => x.event === "trap-dispatched" && x.trapId === trapId),
        result: events.find((x) => x.event === "trap-result" && x.trapId === trapId),
      };
    }
  }
  return byCmd;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------- A. canned exec is loud + marked
{
  const sd = stateDirFor("cli");
  const runId = "bra120-cli";
  const sub = cli([
    "run",
    WORKFLOW,
    "--run-id",
    runId,
    "--input",
    JSON.stringify({ file: CAT_FILE }),
    "--state-dir",
    sd,
  ]);
  check(sub.rc === 0 && sub.out.includes(`RUN ${runId}`), `A SUBMIT OK: ${runId} submitted (rc ${sub.rc})`);
  const drive = cli(["queue", "run", "--state-dir", sd]);
  check(drive.rc === 0, `A DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  const res = getResult(sd, runId);
  check(res?.status === "done", `A RESULT OK: run completed (got ${res?.status})`);
  const out = (res?.output as any) ?? {};
  check(
    out.canned?.stdout === "" && out.canned?.exitCode === 0,
    `A CANNED OK: canned exec returned {stdout: "", exitCode: 0} (got ${JSON.stringify(out.canned)})`,
  );
  check(
    out.cat?.stdout === CAT_CONTENT && out.cat?.exitCode === 0,
    `A CAT OK: cat read the file for real (got ${JSON.stringify(out.cat)?.slice(0, 80)})`,
  );
  check(
    out.echo?.stdout === "hi\n" && out.echo?.exitCode === 0,
    `A ECHO OK: echo hi returned "hi\\n" (got ${JSON.stringify(out.echo)})`,
  );
  check(
    drive.err.includes(CANNED_LS_LINE),
    `A LOUD OK: queue-run stderr carries the exact CANNED EXEC line naming "ls -la"`,
  );
  check(
    countOccurrences(drive.err, "CANNED EXEC") === 1,
    `A ONCE OK: exactly one CANNED EXEC line — cat and echo hi do not warn (got ${countOccurrences(drive.err, "CANNED EXEC")})`,
  );
  const events = journalEvents(sd, runId);
  const byCmd = execEvents(events);
  check(
    Object.keys(byCmd).sort().join(",") === "cat,echo hi,ls",
    `A MAP OK: all three exec traps found in the journal (got ${Object.keys(byCmd).sort().join(",")})`,
  );
  const canned = byCmd["ls"];
  check(canned?.dispatched !== undefined, `A JOURNAL OK: a trap-dispatched event exists for the canned exec`);
  check(
    canned?.dispatched?.result?.value?.stdout === "" && canned?.dispatched?.result?.value?.exitCode === 0,
    `A ANSWER OK: the dispatched canned answer is {stdout: "", exitCode: 0} (got ${JSON.stringify(canned?.dispatched?.result?.value)})`,
  );
  check(canned?.dispatched?.canned === true, `A MARKED OK: trap-dispatched carries canned: true (got canned=${canned?.dispatched?.canned})`);
  check(canned?.result?.canned === true, `A MARKED OK: trap-result carries canned: true (got canned=${canned?.result?.canned})`);
  // The workflow itself sees exactly the old shape — the marking
  // never crosses into the engine.
  check(
    canned?.result?.result?.stdout === "" && !("canned" in (canned?.result?.result ?? {})),
    `A SHAPE OK: the workflow-visible result is exactly {stdout: "", exitCode: 0} (got ${JSON.stringify(canned?.result?.result)})`,
  );
  const cat = byCmd["cat"];
  check(cat?.dispatched?.canned !== true, `A UNMARKED OK: the cat trap-dispatched carries no canned marking (got canned=${cat?.dispatched?.canned})`);
  check(cat?.result?.canned !== true, `A UNMARKED OK: the cat trap-result carries no canned marking (got canned=${cat?.result?.canned})`);
  const echo = byCmd["echo hi"];
  check(echo?.dispatched?.canned !== true, `A UNMARKED OK: the echo hi trap-dispatched carries no canned marking (got canned=${echo?.dispatched?.canned})`);
  check(echo?.result?.canned !== true, `A UNMARKED OK: the echo hi trap-result carries no canned marking (got canned=${echo?.result?.canned})`);
}

// ---------------------------------------------------------------- B. in-process adapter answers
{
  const adapter = new MockAdapter({ gates: "auto" });
  const ctx = { runId: "bra120-inproc", trapId: "trap-0", ordinal: 0 };
  const seen: string[] = [];
  const origError = console.error;
  console.error = (...a: any[]) => {
    seen.push(a.map(String).join(" "));
  };
  try {
    // B1: a canned exec warns exactly, returns the canned result, and is marked.
    seen.length = 0;
    const canned = adapter.answer("exec", { cmd: "pwd" }, { ...ctx, trapId: "trap-1" }) as any;
    check(
      canned?.value?.stdout === "" && canned?.value?.exitCode === 0,
      `B CANNED OK: canned exec returned {stdout: "", exitCode: 0} (got ${JSON.stringify(canned?.value)})`,
    );
    check(canned?.canned === true, `B MARKED OK: the canned answer carries canned: true (got canned=${canned?.canned})`);
    const expectedPwd =
      `[mock] CANNED EXEC: command "pwd" was NOT run — returning simulated {stdout: "", exitCode: 0}. Only cat and echo hi execute for real under --adapter mock.`;
    check(
      seen.length === 1 && seen[0] === expectedPwd,
      `B LOUD OK: exactly the expected warning, naming "pwd" (got ${JSON.stringify(seen)})`,
    );
    // B2: cat reads for real, silently and unmarked.
    seen.length = 0;
    const cat = adapter.answer("exec", { cmd: "cat", args: [CAT_FILE] }, { ...ctx, trapId: "trap-2" }) as any;
    check(
      cat?.value?.stdout === CAT_CONTENT && cat?.value?.exitCode === 0,
      `B CAT OK: cat read the file for real (got ${JSON.stringify(cat?.value)?.slice(0, 80)})`,
    );
    check(!("canned" in (cat ?? {})), `B CAT OK: the cat answer carries no canned marking`);
    check(seen.length === 0, `B CAT OK: cat emitted no warning (got ${JSON.stringify(seen)})`);
    // B3: echo hi returns "hi\n", silently and unmarked.
    seen.length = 0;
    const echo = adapter.answer("exec", { cmd: "echo hi" }, { ...ctx, trapId: "trap-3" }) as any;
    check(
      echo?.value?.stdout === "hi\n" && echo?.value?.exitCode === 0,
      `B ECHO OK: echo hi returned "hi\\n" (got ${JSON.stringify(echo?.value)})`,
    );
    check(!("canned" in (echo ?? {})), `B ECHO OK: the echo hi answer carries no canned marking`);
    check(seen.length === 0, `B ECHO OK: echo hi emitted no warning (got ${JSON.stringify(seen)})`);
    // B4: a queued exec answer is deliberate — delivered as-is,
    // silently and unmarked.
    seen.length = 0;
    adapter.queueAnswer("exec", { value: { stdout: "queued\n", exitCode: 0 } });
    const queued = adapter.answer("exec", { cmd: "pwd" }, { ...ctx, trapId: "trap-4" }) as any;
    check(
      queued?.value?.stdout === "queued\n" && queued?.value?.exitCode === 0,
      `B QUEUED OK: the queued answer was delivered as-is (got ${JSON.stringify(queued?.value)})`,
    );
    check(!("canned" in (queued ?? {})), `B QUEUED OK: the queued answer carries no canned marking`);
    check(seen.length === 0, `B QUEUED OK: the queued answer emitted no warning (got ${JSON.stringify(seen)})`);
  } finally {
    console.error = origError;
  }
}

// ---------------------------------------------------------------- verdict
if (FAILURES.length) {
  console.log(`\nFAIL bra120 mock exec canned warning (${FAILURES.length} failures)`);
  process.exit(1);
}
console.log(`\nPASS bra120 mock exec canned warning (canned exec logs CANNED EXEC naming the command and marks trap-dispatched/trap-result canned:true; cat and echo hi stay real and unmarked; queued answers unmarked)`);
