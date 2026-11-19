#!/usr/bin/env bun
/**
 * Host lazy per-run journal loading (Linear BRA-98).
 *
 * The Host constructor used to call loadJournalsFromDisk, which
 * parsed EVERY .journal file in the state dir into memory — every
 * CLI invocation paid a full replay of all history into RAM, even
 * though the host only ever appends and every read is per-run.
 * Measured before this fix (~/workspace/bra98-measure.ts, median
 * of 5): 1M events -> 374 ms construction / +143 MB RSS (single
 * journal), 248 ms / +100 MB (10 x 100k journals). After: ~6.5 ms
 * / +0.5 MB, with the parse cost moved to first access of the run.
 *
 * The fix (BRA-98), in src/host.ts:
 *  - No journal is loaded at construction. journal() loads one
 *    run's journal from disk on first access (loadJournal) and
 *    caches it under the EXACT run id — the path comes from
 *    journalPath(runId), so the old lossy filename -> runId
 *    derivation (and the double parse it forced in
 *    registerLoadedRunEntry) is gone.
 *  - journalEvent appends to the file only when the run is not
 *    loaded, and never creates a partial in-memory list (a list
 *    holding only new events would shadow the on-disk history).
 *    When the run is loaded, list and file stay in sync.
 *  - A missing file is never cached, so a journalEvent that creates
 *    the file afterwards is picked up by the next journal() call.
 *  - Corrupt lines are still quarantined exactly as before
 *    (BRA-77 G15: skipped, recorded in corruption + corruption.log,
 *    warned about) — the discovery just moves from construction
 *    to first access of the run.
 *
 * This test seeds journal files directly (no C host needed — the
 * default mock adapter is enough) and asserts:
 *  A. Construction loads nothing: no corruption recorded and no
 *     CORRUPT JOURNAL warning, even though a seeded journal holds
 *     a corrupt line.
 *  B. First access loads + quarantines: journal() returns the good
 *     events, corruption is recorded (in-memory + corruption.log),
 *     and a second access does not re-parse (corruption stays 1).
 *  C. Append for an UNLOADED run: the event lands in the file and
 *     a later journal() returns the full history (old + new).
 *  D. Append for a LOADED run: list and file stay in sync.
 *  E. A run id containing "_" loads correctly (the eager loader
 *     keyed it under "…/…" and journal() returned [] for it).
 *  F. An unknown run still returns [].
 *  G. A brand-new run (no file): append creates the file, a later
 *     access reads it back.
 *
 *   bun tests/test-bra98.ts
 *   (run.sh sets BRA98_WORKDIR and runs this after the bra126 suite.)
 *
 * Run outputs go to $BRA98_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Host } from "../src/host";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKDIR = process.env.BRA98_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra98-"));

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

const stateDir = path.join(WORKDIR, "state");
const jdir = path.join(stateDir, "journals");
fs.mkdirSync(jdir, { recursive: true });
function seedJournal(runId: string, lines: string[]): void {
  fs.writeFileSync(path.join(jdir, runId.replace(/\//g, "_") + ".journal"), lines.join("\n") + "\n");
}
const ev = (runId: string, n: number) => JSON.stringify({ event: "alpha", runId, n });
// run-a: 4 good events with a corrupt line between them.
seedJournal("run-a", [ev("run-a", 1), ev("run-a", 2), "NOT JSON {{{", ev("run-a", 3), ev("run-a", 4)]);
seedJournal("run-b", [ev("run-b", 1), ev("run-b", 2)]);
seedJournal("run-c", [ev("run-c", 1), ev("run-c", 2)]);
seedJournal("my_run", [ev("my_run", 1), ev("my_run", 2)]);

// --- A. Construction loads nothing.
const warnings: string[] = [];
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
};
let host: Host;
try {
  host = new Host({ stateDir });
} finally {
  console.warn = origWarn;
}
check(
  host.corruption.length === 0,
  `LAZY OK: no corruption recorded at construction (got ${host.corruption.length})`,
);
check(
  !warnings.some((w) => w.includes("CORRUPT JOURNAL")),
  `LAZY OK: no CORRUPT JOURNAL warning at construction (got ${warnings.length} warning(s))`,
);

// --- B. First access loads + quarantines.
const aEvents = host.journal("run-a");
check(aEvents.length === 4, `LOAD OK: first journal() returns the 4 good events (got ${aEvents.length})`);
check(
  aEvents.map((e) => e.n).join(",") === "1,2,3,4",
  `LOAD OK: good events in file order (got ${aEvents.map((e) => e.n).join(",")})`,
);
check(host.corruption.length === 1, `LOAD OK: corrupt line quarantined on first access (got ${host.corruption.length})`);
check(
  host.corruption[0]?.kind === "journal-line" && host.corruption[0]?.runId === "run-a",
  `LOAD OK: corruption record names run-a (got ${JSON.stringify(host.corruption[0])})`,
);
const clog = path.join(stateDir, "corruption.log");
check(
  fs.existsSync(clog) && fs.readFileSync(clog, "utf8").includes("run-a"),
  `LOAD OK: corruption.log records run-a (exists=${fs.existsSync(clog)})`,
);
check(host.journal("run-a").length === 4, `LOAD OK: second journal() returns the same 4 events (cached)`);
check(
  host.corruption.length === 1,
  `LOAD OK: no re-parse on second access (corruption still ${host.corruption.length})`,
);

// --- C. Append for an UNLOADED run (fresh host, run-b never accessed).
const host2 = new Host({ stateDir });
host2.journalEvent("run-b", { event: "probe", runId: "run-b", n: 3 });
const bEvents = host2.journal("run-b");
check(bEvents.length === 3, `APPEND-UNLOADED OK: journal() returns full history after file-only append (got ${bEvents.length})`);
check(
  bEvents.map((e) => e.n).join(",") === "1,2,3",
  `APPEND-UNLOADED OK: appended event lands last, history intact (got ${bEvents.map((e) => e.n).join(",")})`,
);
check(
  host2.corruption.length === 0,
  `APPEND-UNLOADED OK: untouched runs stay unloaded (corruption ${host2.corruption.length})`,
);
check(host2.journal("run-b").length === 3, `APPEND-UNLOADED OK: second journal() still 3 events (cached)`);

// --- D. Append for a LOADED run.
const cFirst = host2.journal("run-c");
check(cFirst.length === 2, `APPEND-LOADED OK: first journal() loads run-c (got ${cFirst.length})`);
host2.journalEvent("run-c", { event: "probe", runId: "run-c", n: 3 });
const cEvents = host2.journal("run-c");
check(cEvents.length === 3, `APPEND-LOADED OK: list grows to 3 after append (got ${cEvents.length})`);
const cFile = fs.readFileSync(path.join(jdir, "run-c.journal"), "utf8").trim().split("\n");
check(cFile.length === 3, `APPEND-LOADED OK: file grows to 3 lines after append (got ${cFile.length})`);

// --- E. A run id containing "_" loads correctly.
const uEvents = host2.journal("my_run");
check(uEvents.length === 2, `UNDERSCORE OK: journal("my_run") returns its 2 events (got ${uEvents.length})`);
check(
  uEvents.map((e) => e.n).join(",") === "1,2",
  `UNDERSCORE OK: underscore run events in order (got ${uEvents.map((e) => e.n).join(",")})`,
);

// --- F. An unknown run still returns [].
check(host2.journal("no-such-run").length === 0, `UNKNOWN OK: unknown runId returns []`);
check(
  host2.corruption.length === 0,
  `UNKNOWN OK: unknown runId records no corruption (got ${host2.corruption.length})`,
);

// --- G. A brand-new run (no file): append creates the file, later access reads it.
host2.journalEvent("brand-new", { event: "first", runId: "brand-new", n: 1 });
const gEvents = host2.journal("brand-new");
check(gEvents.length === 1, `NEW-RUN OK: journal() after file-creating append returns the event (got ${gEvents.length})`);
check(
  gEvents[0]?.event === "first",
  `NEW-RUN OK: the event is the appended one (got ${JSON.stringify(gEvents[0])})`,
);

if (FAILURES.length) {
  console.log(`\nFAIL bra98 lazy journal loading (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log(
  "\nPASS bra98 lazy journal loading (construction loads no journals; first access loads + quarantines; append works loaded and unloaded; underscore run ids load)",
);
