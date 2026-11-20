#!/usr/bin/env bun
/**
 * E2BIG on trap-result delivery (Linear BRA-171, output side).
 *
 *   A. Large exec result, direct adapter, CLI-driven (host.ts
 *      deliverResult): `cat` of a ~200KB file. The exec answer JSON
 *      exceeds Linux's 128KB single-argv cap (MAX_ARG_STRLEN), so
 *      the resume spawn fails E2BIG on un-fixed code. The run must
 *      complete with the full content (length + first/last line).
 *   B. Small exec result, same path: inline delivery unchanged.
 *   C. Large job throw, in-process Host + MockAdapter (host.ts
 *      deliverThrow): a 200KB Error message queued as the job
 *      answer; the workflow catches it and returns its length.
 *   D. Small job throw, same path: inline delivery unchanged.
 *   E. Large job value via MockPlugin (mock-plugin.ts
 *      deliverResult): a 200KB label queued as the job answer; the
 *      workflow returns its length.
 *   F. Large job throw via MockPlugin (mock-plugin.ts
 *      deliverThrow): same shape as C through the mock host.
 *   G. Cleanup: no `*.trap-result-*.json` scratch files remain
 *      under any state dir used (the file-based delivery must not
 *      litter the state dir).
 *   H. Loud failure: the C host invoked directly with a bogus
 *      `agentts-file:` marker refuses loudly (rc 1, the file named
 *      on stderr, a lifecycle `failed` line) instead of resuming
 *      with a wrong or empty result.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra171.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra158 suite.)
 * Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): the all-join path has
 * the same shape — host.ts:5927 passes branch outcomes inline as
 * argv (`["join", snap, ...outcomes]`), so a >128KB branch outcome
 * would E2BIG there too. That is a separate site (not deliverResult /
 * deliverThrow) and is left for a follow-up, not fixed here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { Host } from "../src/host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";
import { MockPlugin, prefixFor } from "../plugins/mock/src/mock-plugin";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const TESTS = path.join(ROOT, "tests", "workflows");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA171_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra171-"));
fs.mkdirSync(WORKDIR, { recursive: true });

// BRA-133 rule: never let an in-process submit post to the production
// worker server (port 18741). A dead port keeps notifyEvent local:
// the fire-and-forget post fails silently instead of reaching
// production. (The CLI children inherit this too.)
process.env.AGENTTS_WORKER_SERVER = "http://127.0.0.1:9";

// > 128KB MAX_ARG_STRLEN (131072), < 1MB spawnSync stdout cap
// (BRA-174) — comfortably inside the exec path on both sides.
const BIG_LEN = 200_000;

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

/** Deterministic big file: numbered 100-char lines + "\n". Returns the
 * expected {len, head, tail} read back from the file itself. */
function writeBigFile(filePath: string, targetBytes: number): { len: number; head: string; tail: string } {
  const lines: string[] = [];
  let n = 0;
  let bytes = 0;
  while (bytes < targetBytes) {
    const line = `line-${String(n).padStart(6, "0")}:` + "x".repeat(88);
    lines.push(line);
    bytes += line.length + 1;
    n++;
  }
  const text = lines.join("\n") + "\n";
  fs.writeFileSync(filePath, text);
  const back = fs.readFileSync(filePath, "utf8");
  const split = back.split("\n");
  return { len: back.length, head: split[0], tail: split[split.length - 2] };
}

function cli(args: string[]): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function parseOutLines(outPath: string): Record<string, string> {
  const lines: Record<string, string> = {};
  if (!fs.existsSync(outPath)) return lines;
  for (const line of fs.readFileSync(outPath, "utf8").split("\n")) {
    const i = line.indexOf(": ");
    if (i >= 0) lines[line.slice(0, i)] = line.slice(i + 2);
  }
  return lines;
}

async function main(): Promise<void> {
  // ---------------------------------------------------------- A + B: CLI
  const cliState = path.join(WORKDIR, "cli-state");
  fs.mkdirSync(cliState, { recursive: true });
  const bigFile = path.join(WORKDIR, "big.txt");
  const expected = writeBigFile(bigFile, BIG_LEN);
  check(expected.len > 131_072, `SETUP OK: big file is ${expected.len} bytes (> 128KB cap)`);
  const smallFile = path.join(WORKDIR, "small.txt");
  fs.writeFileSync(smallFile, "hello small\n");

  // A. Large exec result through the direct adapter.
  const big = cli([
    "run", path.join(TESTS, "workflow-bra171.ts"),
    "--run-id", "run-bra171-big",
    "--input", JSON.stringify({ filePath: bigFile }),
    "--adapter", "direct", "--state-dir", cliState, "--wait",
  ]);
  let bigOut: any = null;
  try {
    bigOut = JSON.parse(big.out);
  } catch {
    bigOut = null;
  }
  check(big.rc === 0, `A BIG OK: CLI --wait exited 0 (got ${big.rc}; err: ${big.err.slice(0, 300)})`);
  check(bigOut !== null, `A BIG OK: CLI printed parseable result JSON (got ${JSON.stringify(big.out).slice(0, 200)})`);
  check(bigOut?.len === expected.len, `A BIG OK: exec result delivered whole — len ${bigOut?.len} (expected ${expected.len})`);
  check(
    bigOut?.head === expected.head && bigOut?.tail === expected.tail,
    `A BIG OK: head/tail match (${JSON.stringify(bigOut?.head)} / ${JSON.stringify(bigOut?.tail)})`,
  );

  // B. Small exec result: the inline path is unchanged.
  const small = cli([
    "run", path.join(TESTS, "workflow-bra171.ts"),
    "--run-id", "run-bra171-small",
    "--input", JSON.stringify({ filePath: smallFile }),
    "--adapter", "direct", "--state-dir", cliState, "--wait",
  ]);
  let smallOut: any = null;
  try {
    smallOut = JSON.parse(small.out);
  } catch {
    smallOut = null;
  }
  check(small.rc === 0, `B SMALL OK: CLI --wait exited 0 (got ${small.rc}; err: ${small.err.slice(0, 300)})`);
  check(
    smallOut?.len === 12 && smallOut?.head === "hello small" && smallOut?.tail === "hello small",
    `B SMALL OK: small exec result delivered inline (got ${JSON.stringify(smallOut)})`,
  );

  // --------------------------------------- C + D: Host + MockAdapter
  const hostState = path.join(WORKDIR, "host-state");
  fs.mkdirSync(hostState, { recursive: true });
  const bigMessage = "E".repeat(BIG_LEN);

  // C. Large throw through host.ts deliverThrow.
  {
    const adapter = new MockAdapter({ gates: "auto" });
    adapter.queueAnswer("job", { throw: { name: "Error", message: bigMessage } });
    const host = new Host({ stateDir: hostState, adapter });
    host.submit(path.join(TESTS, "workflow-bra171-throw.ts"), { runId: "run-bra171-big-throw" });
    await host.runQueue();
    const res = host.result("run-bra171-big-throw");
    check(res.status === "done", `C THROW OK: run done (got ${res.status}: ${res.error ?? ""})`);
    check(
      res.output?.caughtLen === BIG_LEN,
      `C THROW OK: 200KB throw delivered whole — caughtLen ${res.output?.caughtLen} (expected ${BIG_LEN})`,
    );
    check(res.output?.caughtIsError === true, `C THROW OK: throw rehydrated as a real Error (got ${res.output?.caughtIsError})`);
  }

  // D. Small throw: the inline path is unchanged.
  {
    const adapter = new MockAdapter({ gates: "auto" });
    adapter.queueAnswer("job", { throw: { name: "Error", message: "boom" } });
    const host = new Host({ stateDir: hostState, adapter });
    host.submit(path.join(TESTS, "workflow-bra171-throw.ts"), { runId: "run-bra171-small-throw" });
    await host.runQueue();
    const res = host.result("run-bra171-small-throw");
    check(res.status === "done", `D THROW OK: run done (got ${res.status}: ${res.error ?? ""})`);
    check(
      res.output?.caughtLen === 4 && res.output?.caughtIsError === true,
      `D THROW OK: small throw delivered inline (got ${JSON.stringify(res.output)})`,
    );
  }

  // --------------------------------------------- E + F: MockPlugin host
  const mockState = path.join(WORKDIR, "mock-state");
  fs.mkdirSync(mockState, { recursive: true });

  // E. Large job value through mock-plugin.ts deliverResult.
  {
    const plugin = new MockPlugin({ workdir: mockState });
    plugin.queueAnswer("job", { value: { score: 9, label: "Y".repeat(BIG_LEN) } });
    let rc = -1;
    let driveErr = "";
    try {
      rc = await plugin.startRun(path.join(TESTS, "workflow-bra171-job.ts"), "run-bra171-big-value");
      check(rc === 2, `E VALUE OK: run suspended at the trap (got ${rc}, expected 2)`);
      rc = plugin.drive("run-bra171-big-value");
    } catch (e) {
      // The mock host propagates a spawn failure (unlike Host.runQueue,
      // which records it as a failed run) — record it and keep going
      // so F still reports its own result.
      driveErr = e instanceof Error ? e.message : String(e);
      rc = -1;
    }
    check(rc === 0, `E VALUE OK: drive completed (got ${rc}${driveErr ? `; err: ${driveErr.slice(0, 200)}` : ""})`);
    const lines = parseOutLines(path.join(mockState, prefixFor("run-bra171-big-value") + ".out"));
    check(
      lines["labelLen"] === String(BIG_LEN),
      `E VALUE OK: 200KB job value delivered whole — labelLen ${lines["labelLen"]} (expected ${BIG_LEN})`,
    );
    check(lines["score"] === "9", `E VALUE OK: score carried through (got ${lines["score"]})`);
  }

  // F. Large job throw through mock-plugin.ts deliverThrow.
  {
    const plugin = new MockPlugin({ workdir: mockState });
    plugin.queueAnswer("job", { throw: { name: "Error", message: "Z".repeat(BIG_LEN) } });
    let rc = -1;
    let driveErr = "";
    try {
      rc = await plugin.startRun(path.join(TESTS, "workflow-bra171-throw.ts"), "run-bra171-big-throw");
      check(rc === 2, `F THROW OK: run suspended at the trap (got ${rc}, expected 2)`);
      rc = plugin.drive("run-bra171-big-throw");
    } catch (e) {
      driveErr = e instanceof Error ? e.message : String(e);
      rc = -1;
    }
    check(rc === 0, `F THROW OK: drive completed (got ${rc}${driveErr ? `; err: ${driveErr.slice(0, 200)}` : ""})`);
    const lines = parseOutLines(path.join(mockState, prefixFor("run-bra171-big-throw") + ".out"));
    check(
      lines["caughtLen"] === String(BIG_LEN),
      `F THROW OK: 200KB throw delivered whole — caughtLen ${lines["caughtLen"]} (expected ${BIG_LEN})`,
    );
    check(lines["caughtIsError"] === "true", `F THROW OK: throw rehydrated as a real Error (got ${lines["caughtIsError"]})`);
  }

  // ----------------------------------- H: missing file fails loudly
  // Invoke the C host directly against section A's (completed) blob
  // with a bogus file marker: the read happens before any resume
  // work, so the blob is untouched — the failure must be loud (rc 1,
  // the file named on stderr, a lifecycle `failed` line), never a
  // silent resume with a wrong or empty result.
  {
    const hostBin = process.env.DURABLETS_HOST ?? "";
    const snap = path.join(cliState, "blobs", "run-bra171-big.snap");
    check(hostBin !== "", `H LOUD OK: DURABLETS_HOST is set (${hostBin || "(unset)"})`);
    check(fs.existsSync(snap), `H LOUD OK: section A left a blob to resume (${snap})`);
    if (hostBin && fs.existsSync(snap)) {
      const r = spawnSync(hostBin, ["resume", snap, "agentts-file:/does/not/exist-bra171.json"], {
        encoding: "utf8",
      });
      const errText = r.stderr ?? "";
      check(r.status === 1, `H LOUD OK: bogus file marker exits 1 (got ${r.status})`);
      check(
        errText.includes("cannot read result file /does/not/exist-bra171.json"),
        `H LOUD OK: stderr names the missing file (got ${JSON.stringify(errText.slice(0, 300))})`,
      );
      check(
        errText.includes('"failed"'),
        `H LOUD OK: a lifecycle failed line is emitted (got ${JSON.stringify(errText.slice(0, 300))})`,
      );
    }
  }

  // --------------------------------------------- G: no scratch litter
  const leftovers: string[] = [];
  for (const sd of [cliState, hostState, mockState]) {
    const slices = path.join(sd, "slices");
    if (!fs.existsSync(slices)) continue;
    for (const f of fs.readdirSync(slices)) {
      if (f.includes(".trap-result-")) leftovers.push(path.join(slices, f));
    }
    // The mock plugin writes its scratch next to the .out files, not
    // under slices/ — sweep the workdir too.
    for (const f of fs.readdirSync(sd)) {
      if (f.includes(".trap-result-")) leftovers.push(path.join(sd, f));
    }
  }
  // The mock plugin's workdir IS mockState, already swept above; the
  // CLI/host state dirs share WORKDIR's slices layout.
  check(leftovers.length === 0, `G CLEANUP OK: no *.trap-result-*.json scratch files left (got ${JSON.stringify(leftovers)})`);

  if (FAILURES.length) {
    console.log(`\nFAIL bra171 E2BIG delivery (${FAILURES.length} failures)`);
    process.exit(1);
  }
  console.log(`\nPASS bra171 E2BIG delivery`);
}

main().catch((e) => {
  console.log(`FAIL: uncaught ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
