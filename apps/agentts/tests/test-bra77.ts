#!/usr/bin/env bun
/**
 * Corrupt-state resilience test (Linear BRA-77 — G5 + G15, the
 * BRA-62 audit's corrupt-state gaps).
 *
 * Proves the Host survives corrupt state instead of bricking or
 * silently losing work:
 *
 *   A. Atomic queue writes (G5): a torn queue.json is never
 *      produced by a crash, and a torn file is recovered from the
 *      backup — never silently treated as empty.
 *      A1. Drive a run to done, then truncate queue.json to 40
 *          bytes (a torn write). `queue list` exits 0, shows the
 *          entry recovered from queue.json.bak (one write behind:
 *          "running", the pre-completion state), says CORRUPT QUEUE
 *          on stderr, and restores queue.json on disk to the backup
 *          content. `queue run` then completes it via the BRA-72
 *          auto-repair (journal shows lifecycle completed → done,
 *          trap count unchanged — no re-drive).
 *      A2. A stray queue.json.<pid>.tmp file is ignored — the queue
 *          reads fine (tmp files are never read).
 *      A3. Kill-during-drive: strand a run (SIGKILL mid-exec, as in
 *          BRA-72) and assert queue.json still parses (either the
 *          old or the new content — never torn) and the backup
 *          parses too.
 *   B. Corrupt queue read fails loudly (G5): a corrupt queue.json
 *      with no usable backup is an error, never an empty queue.
 *      B1. Garbage queue.json + missing backup: `queue list` and
 *          `queue repair` both exit non-zero and say "queue.json is
 *          corrupt" and "queue.json.bak is missing" — the run is
 *          never silently listed as nothing.
 *      B2. queue.json that parses but is not an array, with a
 *          corrupt backup: same loud failure, naming the shape
 *          problem ("not an array").
 *   C. Corrupt journal line (G15): the Host starts, keeps the good
 *      lines, and reports the corruption.
 *      C1. Append garbage + truncated JSON + bad-shape lines (a
 *          bare number, null, an object with no `event`) to a
 *          completed run's journal: a new Host starts (`queue list`
 *          exits 0), `result` still returns the output, `status`
 *          shows only the good events, stderr says CORRUPT JOURNAL,
 *          corruption.log records all five lines (runId, line
 *          numbers), and the journal FILE still holds the bad lines
 *          (forensics — the quarantine is in-memory, not a rewrite).
 *      C2. A bad line spliced into the MIDDLE of a journal: the
 *          good lines before and after it are kept, in order.
 *      C3. A second Host construction does not grow corruption.log
 *          (the durable log is deduped).
 *   D. Repair after a corrupt journal (G15 regression): the exact
 *      failure BRA-72 could not survive — the constructor bricked,
 *      so repair could not run at all.
 *      D1. Strand a run, then corrupt its journal: `queue repair`
 *          exits 0 and prints `REPAIR <runId>: running -> queued`,
 *          and `queue run` completes it.
 *      D2. Strand a run, corrupt its journal AND truncate
 *          queue.json (good backup): `queue repair` exits 0 (the
 *          Host starts), both corruptions are reported, and `queue
 *          run` completes the run.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra77.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra72 suite.)
 *
 * Run outputs go to $BRA77_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The drive child processes are killed in a
 * finally block, even on failure. Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): the read-modify-write
 * race between a concurrent `submit` (enqueue) and a live drive —
 * atomic tmp+rename makes each write all-or-nothing, but two
 * processes can still read, modify, and write in an interleaving
 * that loses one entry (last writer wins). Closing that needs a
 * queue lock around enqueue's read-modify-write, which is a
 * follow-up, not this issue. And fsync is not used (same as the
 * driver-lock heartbeat): the threat model is a process crash, not
 * power loss.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA77_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra77-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

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

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Drive the queue in a child process (the CLI blocks in the exec
 * trap; this process must stay free to kill it). */
function driveChild(): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", STATE_DIR], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
}

const queuePath = path.join(STATE_DIR, "queue.json");
const queueBackupPath = path.join(STATE_DIR, "queue.json.bak");
const corruptionLogPath = path.join(STATE_DIR, "corruption.log");
const journalPath = (runId: string): string => path.join(STATE_DIR, "journals", `${runId}.journal`);

/** Parse queue.json directly — throws on corrupt content, so a torn
 * file fails this test loudly instead of being silently swallowed
 * (the old readQueue returned [] on any error). */
function readQueueStrict(): any[] {
  return JSON.parse(fs.readFileSync(queuePath, "utf8"));
}
function readBackupStrict(): any[] {
  return JSON.parse(fs.readFileSync(queueBackupPath, "utf8"));
}
function queueStatus(runId: string): string | null {
  try {
    return readQueueStrict().find((e) => e.runId === runId)?.status ?? null;
  } catch {
    return null;
  }
}
function setQueueStatus(runId: string, status: string): boolean {
  if (!fs.existsSync(queuePath)) return false;
  const q = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  const e = q.find((x: any) => x.runId === runId);
  if (!e) return false;
  e.status = status;
  fs.writeFileSync(queuePath, JSON.stringify(q, null, 2));
  return true;
}
/** Good journal events only (tolerant parse, as the Host loads). */
function readJournal(runId: string): any[] {
  const p = journalPath(runId);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        const v = JSON.parse(l);
        return v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as any).event === "string" ? v : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
function readJournalRawLines(runId: string): string[] {
  const p = journalPath(runId);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
}
function readCorruptionLog(): any[] {
  if (!fs.existsSync(corruptionLogPath)) return [];
  return fs
    .readFileSync(corruptionLogPath, "utf8")
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
function markerLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  fail(`timeout waiting for: ${what}`);
  return false;
}

function submit(workflow: string, runId: string, input: unknown): string {
  const inputFile = path.join(WORKDIR, `${runId}.input.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const r = cli(["run", workflow, "--run-id", runId, "--input-file", inputFile, "--adapter", "direct", "--state-dir", STATE_DIR]);
  check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `SUBMIT OK: ${runId} submitted (rc ${r.rc})`);
  return runId;
}

function getResult(runId: string): any | null {
  const r = cli(["result", runId, "--state-dir", STATE_DIR]);
  if (r.rc !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

function statusEvents(runId: string): number | null {
  const r = cli(["status", runId, "--state-dir", STATE_DIR]);
  if (r.rc !== 0) return null;
  const m = r.out.match(/^events: (\d+)$/m);
  return m ? Number(m[1]) : null;
}

/** Strand a run: drive it in a child, wait for the entry to flip
 * to "running" AND the marker file to appear (the exec trap has
 * dispatched — the run is suspended with a registry entry and a
 * snapshot blob on disk), then SIGKILL the child. Waiting for the
 * marker matters: killing right after the "running" flip can land
 * before the first slice returns, leaving a never-started run
 * instead of a suspended one. Returns the child (already dead). */
async function strandRun(runId: string, marker: string): Promise<Subprocess> {
  const child = driveChild();
  const flipped = await waitFor(() => queueStatus(runId) === "running", 10_000, `${runId} entry -> running`);
  check(flipped, `STRAND OK: ${runId} entry flipped to running before the kill`);
  const dispatched = await waitFor(() => markerLines(marker) >= 1, 10_000, `${runId} marker written (exec dispatched)`);
  check(dispatched, `STRAND OK: ${runId} exec dispatched (marker written) before the kill`);
  child.kill(9);
  await child.exited;
  check(queueStatus(runId) === "running", `STRAND OK: ${runId} entry still "running" after the kill (stranded, not driven)`);
  return child;
}

const children: Subprocess[] = [];
const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts");

async function scenarioA(): Promise<void> {
  console.log("\n=== A. atomic queue writes / torn-write recovery ===");
  // A1: torn queue.json + good backup -> recovered, reported, restored.
  const runId = "bra77-a1";
  const marker = path.join(WORKDIR, "bra77-a1.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 0 });
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `A1 DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  check(queueStatus(runId) === "done", `A1 DRIVE OK: ${runId} done`);
  const trapsBefore = readJournal(runId).filter((e) => e.event === "trap").length;
  check(fs.existsSync(queueBackupPath), "A1 SETUP OK: queue.json.bak exists after the drive");
  // Simulate a torn write: truncate queue.json to 40 bytes.
  const full = fs.readFileSync(queuePath, "utf8");
  fs.writeFileSync(queuePath, full.slice(0, 40));
  check(!(() => { try { JSON.parse(fs.readFileSync(queuePath, "utf8")); return true; } catch { return false; } })(), "A1 SETUP OK: truncated queue.json is unparseable (torn write)");
  const list = cli(["queue", "list", "--state-dir", STATE_DIR]);
  check(list.rc === 0, `A1 RECOVER OK: queue list exited 0 on a torn queue.json (got ${list.rc})`);
  check(
    list.out.includes(`running ${runId}`),
    `A1 RECOVER OK: queue list shows ${runId} running — recovered from the backup (one write behind the done state)`,
  );
  const combined = `${list.out}\n${list.err}`;
  check(
    combined.includes("CORRUPT QUEUE") && combined.includes("recovered") && combined.includes("queue.json.bak"),
    `A1 RECOVER OK: recovery reported loudly (CORRUPT QUEUE + recovered + queue.json.bak)`,
  );
  // The recovered queue was written back to queue.json atomically.
  let restored: any[] | null = null;
  try {
    restored = readQueueStrict();
  } catch {
    restored = null;
  }
  check(restored !== null && restored.some((e) => e.runId === runId && e.status === "running"), "A1 RECOVER OK: queue.json on disk restored to the backup content (parseable, entry running)");
  check(
    readCorruptionLog().some((r) => r.kind === "queue-recovered" && r.file === "queue.json"),
    "A1 RECOVER OK: corruption.log records the queue recovery",
  );
  // The recovered queue is usable: the auto-repair re-classifies the
  // entry from the journal (lifecycle completed -> done) without
  // re-driving the exec.
  const drive2 = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive2.rc === 0, `A1 RECOVER OK: queue run exited 0 after recovery (got ${drive2.rc})`);
  check(queueStatus(runId) === "done", `A1 RECOVER OK: ${runId} done after recovery`);
  const trapsAfter = readJournal(runId).filter((e) => e.event === "trap").length;
  check(trapsAfter === trapsBefore, `A1 RECOVER OK: trap count unchanged (${trapsBefore} -> ${trapsAfter}) — no re-drive happened`);
  const res = getResult(runId);
  check(res?.exitCode === 0, `A1 RECOVER OK: ${runId} result still returns the output (exitCode ${res?.exitCode})`);

  // A2: a stray tmp file is ignored — tmp files are never read.
  fs.writeFileSync(path.join(STATE_DIR, "queue.json.12345.tmp"), "garbage {{{ not json");
  const list2 = cli(["queue", "list", "--state-dir", STATE_DIR]);
  check(list2.rc === 0 && list2.out.includes(runId), "A2 TMP OK: queue list exits 0 with a stray queue.json.<pid>.tmp present (tmp files are never read)");

  // A3: kill-during-drive — queue.json is old or new, never torn.
  const runId3 = "bra77-a3";
  const marker3 = path.join(WORKDIR, "bra77-a3.marker");
  submit(WORKFLOW, runId3, { markerFile: marker3, sleepMs: 5000 });
  const child = await strandRun(runId3, marker3);
  children.push(child);
  let queueParses = false;
  let entryStatus: string | null = null;
  try {
    const q = readQueueStrict();
    queueParses = true;
    entryStatus = q.find((e) => e.runId === runId3)?.status ?? null;
  } catch {
    queueParses = false;
  }
  check(queueParses, "A3 CRASH OK: queue.json still parses after SIGKILL mid-drive (old or new, never torn)");
  check(entryStatus === "queued" || entryStatus === "running", `A3 CRASH OK: ${runId3} entry is ${entryStatus} after the kill (a whole state, never a torn one)`);
  let backupParses = false;
  try {
    readBackupStrict();
    backupParses = true;
  } catch {
    backupParses = false;
  }
  check(backupParses, "A3 CRASH OK: queue.json.bak also parses after SIGKILL mid-drive");
}

async function scenarioB(): Promise<void> {
  console.log("\n=== B. corrupt queue read fails loudly ===");
  // B1: garbage queue.json + missing backup.
  const runId = "bra77-b1";
  const marker = path.join(WORKDIR, "bra77-b1.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 0 });
  check(queueStatus(runId) === "queued", `B1 SETUP OK: ${runId} queued before corruption`);
  fs.writeFileSync(queuePath, "this is not json at all {{{");
  if (fs.existsSync(queueBackupPath)) fs.rmSync(queueBackupPath);
  const list = cli(["queue", "list", "--state-dir", STATE_DIR]);
  const listCombined = `${list.out}\n${list.err}`;
  check(list.rc !== 0, `B1 LOUD OK: queue list exited non-zero on a corrupt queue.json with no backup (got ${list.rc})`);
  check(
    listCombined.includes("queue.json is corrupt") && listCombined.includes("queue.json.bak is missing"),
    `B1 LOUD OK: queue list said "queue.json is corrupt" and "queue.json.bak is missing" (out: ${list.out.trim().split("\n")[0] ?? ""} / err: ${list.err.trim().split("\n")[0] ?? ""})`,
  );
  check(!list.out.includes(runId), `B1 LOUD OK: the run is NOT silently listed as nothing — the command failed instead of printing an empty queue`);
  const repair = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  const repairCombined = `${repair.out}\n${repair.err}`;
  check(repair.rc !== 0, `B1 LOUD OK: queue repair also exited non-zero (got ${repair.rc})`);
  check(repairCombined.includes("queue.json is corrupt"), "B1 LOUD OK: queue repair reported the corruption too");
  // Restore a usable queue so later scenarios are not affected.
  // The restored entry keeps its input, or the next `queue run`
  // would drive it with no input and fail.
  fs.writeFileSync(queuePath, JSON.stringify([{ runId, workflowPath: path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), adapter: "direct", status: "queued", input: { markerFile: marker, sleepMs: 0 }, enqueuedAt: new Date().toISOString() }], null, 2));

  // B2: queue.json parses but is not an array, backup also corrupt.
  const runId2 = "bra77-b2";
  const marker2 = path.join(WORKDIR, "bra77-b2.marker");
  submit(WORKFLOW, runId2, { markerFile: marker2, sleepMs: 0 });
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `B2 SETUP OK: queue run exited 0 (got ${drive.rc})`);
  fs.writeFileSync(queuePath, `{"not": "an array"}`);
  fs.writeFileSync(queueBackupPath, "also garbage {{{");
  const list2 = cli(["queue", "list", "--state-dir", STATE_DIR]);
  const combined2 = `${list2.out}\n${list2.err}`;
  check(list2.rc !== 0, `B2 LOUD OK: queue list exited non-zero on a non-array queue.json with a corrupt backup (got ${list2.rc})`);
  check(
    combined2.includes("not an array") && combined2.includes("also corrupt"),
    `B2 LOUD OK: failure named the shape problem ("not an array") and the backup ("also corrupt")`,
  );
  // Restore a usable queue for the remaining scenarios.
  fs.writeFileSync(queuePath, JSON.stringify([{ runId: runId2, workflowPath: path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), adapter: "direct", status: "done", enqueuedAt: new Date().toISOString() }], null, 2));
  fs.rmSync(queueBackupPath, { force: true });
}

async function scenarioC(): Promise<void> {
  console.log("\n=== C. corrupt journal line is quarantined, Host starts ===");
  // C1: garbage + truncated JSON + bad-shape lines appended to a
  // completed run's journal.
  const runId = "bra77-c1";
  const marker = path.join(WORKDIR, "bra77-c1.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 0 });
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `C1 DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  check(queueStatus(runId) === "done", `C1 DRIVE OK: ${runId} done`);
  const goodCount = readJournal(runId).length;
  check(goodCount > 0, `C1 SETUP OK: journal has ${goodCount} good events before corruption`);
  const badLines = ["this is not json", `{"event":"trap","runId":"${runId}","trap`, "42", "null", `{"noEvent":true}`];
  for (const l of badLines) fs.appendFileSync(journalPath(runId), l + "\n");
  const list = cli(["queue", "list", "--state-dir", STATE_DIR]);
  check(list.rc === 0, `C1 START OK: queue list exited 0 with a corrupt journal line present (got ${list.rc}) — the Host starts`);
  const combined = `${list.out}\n${list.err}`;
  check(
    combined.includes("CORRUPT JOURNAL") && combined.includes(`${runId}.journal`),
    `C1 REPORT OK: corruption reported (CORRUPT JOURNAL + ${runId}.journal on stderr)`,
  );
  const res = getResult(runId);
  check(res?.exitCode === 0, `C1 RESULT OK: ${runId} result still returns the output after journal corruption (exitCode ${res?.exitCode})`);
  const events = statusEvents(runId);
  check(events === goodCount, `C1 GOOD OK: status shows only the ${goodCount} good events (${events}) — the 5 bad lines are quarantined, not counted`);
  const good = readJournal(runId);
  check(good.every((e) => typeof e.event === "string"), "C1 GOOD OK: every kept journal event has a string `event` field");
  check(
    good.some((e) => e.event === "lifecycle" && e.lifecycle === "completed"),
    "C1 GOOD OK: the lifecycle completed event survived the quarantine",
  );
  const raw = readJournalRawLines(runId);
  check(raw.includes("this is not json"), "C1 FILE OK: the journal FILE still holds the bad lines (forensics — quarantine is in-memory, not a rewrite)");
  const logRecs = readCorruptionLog().filter((r) => r.kind === "journal-line" && r.runId === runId);
  check(logRecs.length === 5, `C1 LOG OK: corruption.log records all 5 quarantined lines (${logRecs.length})`);
  check(
    logRecs.every((r, i) => r.lineNo === goodCount + 1 + i),
    `C1 LOG OK: corruption.log line numbers are ${goodCount + 1}..${goodCount + 5} (the appended lines)`,
  );
  check(
    logRecs.map((r) => r.reason).some((s: string) => s.includes("unparseable")) &&
      logRecs.map((r) => r.reason).some((s: string) => s.includes("not a journal event")),
    "C1 LOG OK: corruption.log distinguishes unparseable lines from bad-shape lines",
  );

  // C2: a bad line spliced into the MIDDLE of a journal.
  const runId2 = "bra77-c2";
  const marker2 = path.join(WORKDIR, "bra77-c2.marker");
  submit(WORKFLOW, runId2, { markerFile: marker2, sleepMs: 0 });
  const drive2 = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive2.rc === 0, `C2 DRIVE OK: queue run exited 0 (got ${drive2.rc})`);
  const lines = readJournalRawLines(runId2);
  const goodCount2 = lines.length;
  check(goodCount2 > 1, `C2 SETUP OK: journal has ${goodCount2} good lines before splicing`);
  const first = lines[0];
  const last = lines[lines.length - 1];
  fs.writeFileSync(journalPath(runId2), [lines[0], "GARBAGE-MIDDLE", ...lines.slice(1)].join("\n") + "\n");
  const events2 = statusEvents(runId2);
  check(events2 === goodCount2, `C2 MIDDLE OK: status shows all ${goodCount2} good events (${events2}) with a bad line in the middle`);
  const good2 = readJournal(runId2);
  check(
    JSON.stringify(good2[0]) === first && JSON.stringify(good2[good2.length - 1]) === last,
    "C2 MIDDLE OK: the good lines before and after the bad line are kept, in order (first and last events unchanged)",
  );
  const logRecs2 = readCorruptionLog().filter((r) => r.kind === "journal-line" && r.runId === runId2);
  check(logRecs2.length === 1 && logRecs2[0].lineNo === 2, `C2 LOG OK: corruption.log records the middle line at lineNo 2 (${logRecs2.length} record(s))`);

  // C3: a second Host construction does not grow corruption.log.
  const before = readCorruptionLog().length;
  const list2 = cli(["queue", "list", "--state-dir", STATE_DIR]);
  check(list2.rc === 0, `C3 DEDUP OK: second queue list exited 0 (got ${list2.rc})`);
  const after = readCorruptionLog().length;
  check(after === before, `C3 DEDUP OK: corruption.log did not grow on a second load (${before} -> ${after} records)`);
}

async function scenarioD(): Promise<void> {
  console.log("\n=== D. repair after a corrupt journal (G15 regression) ===");
  // D1: strand a run, then corrupt its journal — repair must run.
  // Before BRA-77 the constructor threw here and repair could not
  // run at all.
  const runId = "bra77-d1";
  const marker = path.join(WORKDIR, "bra77-d1.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  fs.appendFileSync(journalPath(runId), "garbage line after the strand\n");
  const repair = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair.rc === 0, `D1 REPAIR OK: queue repair exited 0 with a corrupt journal line (got ${repair.rc}) — the Host starts now`);
  check(
    repair.out.includes(`REPAIR ${runId}: running -> queued`),
    `D1 REPAIR OK: repair reported ${runId} running -> queued (out: ${repair.out.trim().split("\n").find((l) => l.includes("REPAIR")) ?? "(none)"})`,
  );
  check(queueStatus(runId) === "queued", `D1 REPAIR OK: ${runId} entry is queued after repair`);
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `D1 RECOVER OK: queue run exited 0 (got ${drive.rc})`);
  const res = getResult(runId);
  check(queueStatus(runId) === "done" && res?.exitCode === 0, `D1 RECOVER OK: ${runId} completed after repair with a corrupt journal (exitCode ${res?.exitCode})`);

  // D2: both corruptions at once — corrupt journal AND torn queue.
  const runId2 = "bra77-d2";
  const marker2 = path.join(WORKDIR, "bra77-d2.marker");
  submit(WORKFLOW, runId2, { markerFile: marker2, sleepMs: 5000 });
  const child2 = await strandRun(runId2, marker2);
  children.push(child2);
  fs.appendFileSync(journalPath(runId2), "garbage line after the strand\n");
  const full2 = fs.readFileSync(queuePath, "utf8");
  fs.writeFileSync(queuePath, full2.slice(0, 40));
  const repair2 = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair2.rc === 0, `D2 REPAIR OK: queue repair exited 0 with BOTH corruptions present (got ${repair2.rc})`);
  const combined2 = `${repair2.out}\n${repair2.err}`;
  check(
    combined2.includes("CORRUPT JOURNAL") && combined2.includes("CORRUPT QUEUE"),
    "D2 REPAIR OK: both corruptions were reported (CORRUPT JOURNAL + CORRUPT QUEUE)",
  );
  const drive2 = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive2.rc === 0, `D2 RECOVER OK: queue run exited 0 (got ${drive2.rc})`);
  const res2 = getResult(runId2);
  check(queueStatus(runId2) === "done" && res2?.exitCode === 0, `D2 RECOVER OK: ${runId2} completed with both corruptions present (exitCode ${res2?.exitCode})`);
  const logKinds = new Set(readCorruptionLog().map((r) => r.kind));
  check(
    logKinds.has("journal-line") && logKinds.has("queue-recovered"),
    "D2 LOG OK: corruption.log holds both a journal-line record and a queue-recovered record",
  );
}

try {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
} finally {
  for (const c of children) {
    try {
      c.kill(9);
    } catch {
      /* already dead */
    }
  }
}

if (FAILURES.length) {
  console.log(`\nFAIL bra77 corrupt-state resilience suite (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra77 corrupt-state resilience suite (atomic queue writes + backup recovery, loud corrupt-queue failure, journal quarantine, repair after corrupt journal)");
