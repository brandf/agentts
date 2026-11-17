#!/usr/bin/env bun
/**
 * Torn run-entry recovery test (Linear BRA-84).
 *
 * Proves a torn runs/<run>.json no longer silently drops a suspended
 * run into left-running, and a corrupt entry with no backup is loud,
 * not silent:
 *
 *   A. Main repro (the issue): strand a run suspended at a trap with
 *      its blob intact, truncate runs/<run>.json to 40 bytes (a torn
 *      write), run `queue repair`.
 *      A1. Repair exits 0 and reports `REPAIR <run>: running ->
 *          queued` — NOT left-running. stderr says CORRUPT RUN
 *          ENTRY + recovered + .json.bak, corruption.log records a
 *          run-entry-recovered entry, and runs/<run>.json on disk is
 *          restored from the backup (parseable, rc 2). `queue run`
 *          then completes the run through the normal BRA-74
 *          resume-from-blob path: result exitCode 0, and the journal
 *          holds a trap-dispatch with redispatched:true — the trap
 *          was re-dispatched from the intact blob, not restarted
 *          from scratch (a fresh start would wipe the journal, so no
 *          prior trap-dispatch would exist to re-dispatch). The
 *          marker file has 2 lines: the exec re-runs after a crash
 *          during dispatch, the documented BRA-72 behaviour.
 *   B. Torn-write shapes (atomic saveRunEntry).
 *      B1. Kill mid-drive never tears either file: strand a run
 *          (SIGKILL mid-exec) and assert runs/<run>.json AND
 *          runs/<run>.json.bak both still parse — old or new, never
 *          torn — and hold identical content (the BRA-84 mirror:
 *          saveRunEntry writes the backup first, then the entry,
 *          both via atomicWriteFile). The mirror exists because a
 *          suspended run's entry is typically saved exactly once
 *          before the strand, so the BRA-77 "back up the previous
 *          good file" pattern would leave no backup at all.
 *      B2. A stray runs/<run>.json.<pid>.tmp file is ignored — the
 *          queue still lists, tmp files are never read.
 *      B3. The other torn shape: truncate a stranded run's entry to
 *          0 bytes (empty file). Repair recovers it from the backup
 *          and `queue run` completes it.
 *   C. No-backup corrupt case — loud, not silent, and still safe.
 *      The decision (see host.ts loadRunEntriesFromDisk): the Host
 *      still starts — one bad run entry must not brick the whole
 *      state dir the way a corrupt queue.json does — but the entry
 *      is dropped only with a CORRUPT RUN ENTRY warning on stderr,
 *      a run-entry-corrupt record in corruption.log, and a repair
 *      report that names the corrupt entry file as the cause. The
 *      run stays left-running: re-driving would restart from
 *      scratch and could double-execute the dispatched trap, so the
 *      BRA-72 caution stands — it is just no longer silent about
 *      why. Guessing at (or silently dropping) the entry is never
 *      an option.
 *      C1. Entry torn + .bak deleted: `queue list` exits 0 (the
 *          Host starts), stderr says CORRUPT RUN ENTRY + "no usable
 *          backup", corruption.log holds run-entry-corrupt, `queue
 *          repair` reports `running -> left-running` with a reason
 *          naming the corrupt registry entry, the queue entry stays
 *          "running", and `queue run` does NOT complete the run.
 *      C2. Entry valid JSON but wrong shape (`{}` — parses, no
 *          runId) + no backup: the same loud path, same
 *          left-running verdict. A file that parses but fails
 *          validation is corrupt for recovery purposes too.
 *      C3. Entry torn + .bak also corrupt: the same loud path,
 *          naming the backup as "also corrupt".
 *      C4. A second Host construction does not grow corruption.log
 *          (the durable log is deduped).
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra84.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra83 suite.)
 *
 * Run outputs go to $BRA84_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The drive child processes are killed in a
 * finally block, even on failure. Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): a torn entry whose
 * backup holds a DIFFERENT (older) rc is not exercised — the mirror
 * makes the backup the same content as the entry, so a one-save
 * staleness can only arise from a kill between the two atomic
 * writes, and rc 1/2/3 all repair to "queued" when the blob is
 * intact. And fsync is not used (same as the driver-lock heartbeat
 * and the BRA-77 queue writes): the threat model is a process crash,
 * not power loss.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA84_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra84-"));
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
const corruptionLogPath = path.join(STATE_DIR, "corruption.log");
const runEntryPath = (runId: string): string => path.join(STATE_DIR, "runs", `${runId}.json`);
const runEntryBackupPath = (runId: string): string => path.join(STATE_DIR, "runs", `${runId}.json.bak`);
const journalPath = (runId: string): string => path.join(STATE_DIR, "journals", `${runId}.journal`);

/** Parse queue.json directly — throws on corrupt content, so a torn
 * file fails this test loudly instead of being silently swallowed. */
function readQueueStrict(): any[] {
  return JSON.parse(fs.readFileSync(queuePath, "utf8"));
}
function queueStatus(runId: string): string | null {
  try {
    return readQueueStrict().find((e) => e.runId === runId)?.status ?? null;
  } catch {
    return null;
  }
}
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
function parseFile(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
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
  console.log("\n=== A. torn run entry is recovered from backup, run resumes ===");
  const runId = "bra84-a1";
  const marker = path.join(WORKDIR, "bra84-a1.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  check(fs.existsSync(runEntryPath(runId)), `A1 SETUP OK: runs/${runId}.json exists after the strand`);
  check(fs.existsSync(runEntryBackupPath(runId)), `A1 SETUP OK: runs/${runId}.json.bak exists after the strand (saveRunEntry mirrors the entry)`);
  const blobExists = fs.existsSync(path.join(STATE_DIR, "blobs", `${runId}.snap`));
  check(blobExists, `A1 SETUP OK: snapshot blob for ${runId} is on disk (intact blob to resume from)`);
  // Simulate a torn write: truncate the entry to 40 bytes.
  const full = fs.readFileSync(runEntryPath(runId), "utf8");
  fs.writeFileSync(runEntryPath(runId), full.slice(0, 40));
  check(parseFile(runEntryPath(runId)) === null, "A1 SETUP OK: truncated runs/bra84-a1.json is unparseable (torn write)");
  check(parseFile(runEntryBackupPath(runId)) !== null, "A1 SETUP OK: runs/bra84-a1.json.bak still parses after the tear");

  const repair = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair.rc === 0, `A1 REPAIR OK: queue repair exited 0 with a torn run entry (got ${repair.rc})`);
  check(
    repair.out.includes(`REPAIR ${runId}: running -> queued`),
    `A1 REPAIR OK: repair reported ${runId} running -> queued — NOT left-running (out: ${repair.out.trim().split("\n").find((l) => l.includes("REPAIR")) ?? "(none)"})`,
  );
  check(!repair.out.includes("left-running"), "A1 REPAIR OK: no left-running verdict anywhere in the repair report");
  const combined = `${repair.out}\n${repair.err}`;
  check(
    combined.includes("CORRUPT RUN ENTRY") && combined.includes("recovered") && combined.includes(".json.bak"),
    "A1 REPAIR OK: recovery reported loudly (CORRUPT RUN ENTRY + recovered + .json.bak)",
  );
  const restored = parseFile(runEntryPath(runId));
  check(restored !== null && restored.runId === runId && restored.rc === 2, `A1 REPAIR OK: runs/${runId}.json on disk restored from the backup (runId ${restored?.runId}, rc ${restored?.rc})`);
  check(queueStatus(runId) === "queued", `A1 REPAIR OK: ${runId} entry is queued after repair`);
  check(
    readCorruptionLog().some((r) => r.kind === "run-entry-recovered" && r.file === `${runId}.json`),
    "A1 REPAIR OK: corruption.log records the run-entry recovery",
  );

  // The recovered entry resumes through the normal BRA-74 path.
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `A1 RESUME OK: queue run exited 0 after recovery (got ${drive.rc})`);
  check(queueStatus(runId) === "done", `A1 RESUME OK: ${runId} done after recovery`);
  const res = getResult(runId);
  check(res?.exitCode === 0, `A1 RESUME OK: ${runId} result returns the output (exitCode ${res?.exitCode})`);
  const redispatched = readJournal(runId).some((e) => e.event === "trap-dispatch" && e.redispatched === true);
  check(redispatched, "A1 RESUME OK: journal holds a trap-dispatch with redispatched:true — the trap was re-dispatched from the intact blob, not restarted from scratch");
  check(markerLines(marker) === 2, `A1 RESUME OK: marker file has 2 lines (exec re-ran after the crash during dispatch — the documented BRA-72 behaviour, not a silent restart)`);
}

async function scenarioB(): Promise<void> {
  console.log("\n=== B. atomic run-entry writes / torn-write shapes ===");
  // B1: kill mid-drive never tears either file, and the backup
  // mirrors the entry.
  const runId = "bra84-b1";
  const marker = path.join(WORKDIR, "bra84-b1.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  const entry = parseFile(runEntryPath(runId));
  const backup = parseFile(runEntryBackupPath(runId));
  check(entry !== null, "B1 CRASH OK: runs/bra84-b1.json still parses after SIGKILL mid-drive (old or new, never torn)");
  check(backup !== null, "B1 CRASH OK: runs/bra84-b1.json.bak also parses after SIGKILL mid-drive");
  check(
    entry !== null && backup !== null && JSON.stringify(entry) === JSON.stringify(backup),
    "B1 MIRROR OK: entry and backup hold identical content after the kill (saveRunEntry mirrors the new entry into .bak first)",
  );

  // B2: a stray tmp file is ignored — tmp files are never read.
  fs.writeFileSync(path.join(STATE_DIR, "runs", `${runId}.json.12345.tmp`), "garbage {{{ not json");
  const list = cli(["queue", "list", "--state-dir", STATE_DIR]);
  check(list.rc === 0 && list.out.includes(runId), "B2 TMP OK: queue list exits 0 with a stray runs/<run>.json.<pid>.tmp present (tmp files are never read)");

  // B3: the other torn shape — truncate the entry to 0 bytes.
  const runId3 = "bra84-b3";
  const marker3 = path.join(WORKDIR, "bra84-b3.marker");
  submit(WORKFLOW, runId3, { markerFile: marker3, sleepMs: 5000 });
  const child3 = await strandRun(runId3, marker3);
  children.push(child3);
  fs.writeFileSync(runEntryPath(runId3), "");
  check(parseFile(runEntryPath(runId3)) === null, "B3 SETUP OK: runs/bra84-b3.json truncated to 0 bytes is unparseable (empty torn write)");
  const repair3 = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair3.rc === 0, `B3 REPAIR OK: queue repair exited 0 with an empty run entry (got ${repair3.rc})`);
  check(
    repair3.out.includes(`REPAIR ${runId3}: running -> queued`),
    `B3 REPAIR OK: repair reported ${runId3} running -> queued (empty file recovered from backup)`,
  );
  const drive3 = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive3.rc === 0, `B3 RESUME OK: queue run exited 0 (got ${drive3.rc})`);
  const res3 = getResult(runId3);
  check(queueStatus(runId3) === "done" && res3?.exitCode === 0, `B3 RESUME OK: ${runId3} completed after empty-file recovery (exitCode ${res3?.exitCode})`);
}

async function scenarioC(): Promise<void> {
  console.log("\n=== C. corrupt run entry with no usable backup is loud, not silent ===");
  // C1: entry torn + backup deleted.
  const runId = "bra84-c1";
  const marker = path.join(WORKDIR, "bra84-c1.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  fs.rmSync(runEntryBackupPath(runId));
  fs.writeFileSync(runEntryPath(runId), "torn {{{ garbage");
  const list = cli(["queue", "list", "--state-dir", STATE_DIR]);
  check(list.rc === 0, `C1 LOUD OK: queue list exited 0 with a corrupt run entry and no backup (got ${list.rc}) — the Host still starts`);
  const listCombined = `${list.out}\n${list.err}`;
  check(
    listCombined.includes("CORRUPT RUN ENTRY") && listCombined.includes("no usable backup"),
    "C1 LOUD OK: the load said CORRUPT RUN ENTRY + no usable backup (stderr, not silent)",
  );
  check(
    readCorruptionLog().some((r) => r.kind === "run-entry-corrupt" && r.file === `${runId}.json`),
    "C1 LOUD OK: corruption.log records the unrecoverable run entry (run-entry-corrupt)",
  );
  const repair = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair.rc === 0, `C1 LOUD OK: queue repair exited 0 (got ${repair.rc})`);
  const repairLine = repair.out.trim().split("\n").find((l) => l.includes(`REPAIR ${runId}:`)) ?? "(none)";
  check(
    repair.out.includes(`REPAIR ${runId}: running -> left-running`),
    `C1 SAFE OK: repair reported ${runId} running -> left-running — the run is NOT re-driven (out: ${repairLine})`,
  );
  check(
    repairLine.includes("registry entry file is corrupt") && repairLine.includes("no usable backup"),
    "C1 SAFE OK: the left-running reason names the corrupt registry entry file and the missing backup (the cause is visible in the repair report, not just the log)",
  );
  check(queueStatus(runId) === "running", `C1 SAFE OK: ${runId} entry stays "running" after repair (left-running flips nothing)`);
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `C1 SAFE OK: queue run exited 0 (got ${drive.rc})`);
  check(queueStatus(runId) === "running" && getResult(runId) === null, `C1 SAFE OK: ${runId} did NOT complete on queue run — it stays stranded for a human, with no result`);

  // C2: entry valid JSON but wrong shape ({}) + no backup.
  const runId2 = "bra84-c2";
  const marker2 = path.join(WORKDIR, "bra84-c2.marker");
  submit(WORKFLOW, runId2, { markerFile: marker2, sleepMs: 5000 });
  const child2 = await strandRun(runId2, marker2);
  children.push(child2);
  fs.rmSync(runEntryBackupPath(runId2));
  fs.writeFileSync(runEntryPath(runId2), "{}");
  const repair2 = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair2.rc === 0, `C2 SHAPE OK: queue repair exited 0 on a valid-JSON wrong-shape entry (got ${repair2.rc})`);
  check(
    repair2.out.includes(`REPAIR ${runId2}: running -> left-running`),
    `C2 SHAPE OK: repair reported ${runId2} running -> left-running — a file that parses but fails validation is corrupt too`,
  );
  check(
    readCorruptionLog().some((r) => r.kind === "run-entry-corrupt" && r.file === `${runId2}.json`),
    "C2 SHAPE OK: corruption.log records the wrong-shape entry as run-entry-corrupt",
  );

  // C3: entry torn + backup also corrupt.
  const runId3 = "bra84-c3";
  const marker3 = path.join(WORKDIR, "bra84-c3.marker");
  submit(WORKFLOW, runId3, { markerFile: marker3, sleepMs: 5000 });
  const child3 = await strandRun(runId3, marker3);
  children.push(child3);
  fs.writeFileSync(runEntryPath(runId3), "torn {{{ garbage");
  fs.writeFileSync(runEntryBackupPath(runId3), "also garbage {{{");
  const repair3 = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair3.rc === 0, `C3 BACKUP OK: queue repair exited 0 with entry and backup both corrupt (got ${repair3.rc})`);
  const repair3Combined = `${repair3.out}\n${repair3.err}`;
  check(
    repair3.out.includes(`REPAIR ${runId3}: running -> left-running`),
    `C3 BACKUP OK: repair reported ${runId3} running -> left-running`,
  );
  check(
    repair3Combined.includes("also corrupt"),
    "C3 BACKUP OK: the failure named the backup as also corrupt",
  );

  // C4: a second Host construction does not grow corruption.log.
  const before = readCorruptionLog().length;
  const list2 = cli(["queue", "list", "--state-dir", STATE_DIR]);
  check(list2.rc === 0, `C4 DEDUP OK: second queue list exited 0 (got ${list2.rc})`);
  const after = readCorruptionLog().length;
  check(after === before, `C4 DEDUP OK: corruption.log did not grow on a second load (${before} -> ${after} records)`);
}

try {
  await scenarioA();
  await scenarioB();
  await scenarioC();
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
  console.log(`\nFAIL bra84 torn run-entry recovery suite (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra84 torn run-entry recovery suite (torn entry recovered from backup and resumed from blob, atomic mirror writes, corrupt entry with no backup is loud and stays left-running)");
