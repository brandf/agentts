#!/usr/bin/env bun
/**
 * Dedicated CLI test for the bundle cache (Linear BRA-147, Low).
 *
 * Bundling had integration-mock (run-host-suite bundle section) and
 * integration-real (tests/test-bra94.ts: cache reuse, child-run
 * sharing, fresh-Host disk cache) coverage, but no dedicated CLI
 * test: cache reuse across separate CLI processes was unproven. The
 * e2e column was incidental only (every CLI+direct submit bundles).
 * BRA-94's correctness claim is the cache key (frozenHash + input
 * JSON + engine version). This test proves the same key through the
 * real path, across processes.
 *
 * Three separate `agentts run --wait` processes over one state dir,
 * same workflow (bench-trivial.ts), via the CLI on direct:
 *   A. First process (n=1000) builds and caches: exactly 1 cache
 *      entry afterwards; the cached bundle bakes { n: 1000 }; the
 *      run completes with the right output (499500).
 *   B. Second process, same workflow + same input, different runId:
 *      still exactly 1 cache entry, and the cached bundle's mtime,
 *      inode, and sha256 are UNCHANGED — the second process reused
 *      the cached bundle instead of rebuilding (publish is atomic
 *      rename, so a rebuild would change mtime and inode). Its
 *      pinned per-run bundle is byte-identical to the cached one,
 *      and it completes with the right output.
 *   C. Third process, same workflow, different input (n=5): a
 *      second cache entry appears (a miss, as the key requires),
 *      the new bundle bakes { n: 5 }, the old cached bundle still
 *      bakes { n: 1000 } (no cross-talk), and it completes with
 *      the right output (10).
 *
 * Notes, stated plainly:
 * - The mtime/inode/sha triple is the cache-hit proof, not just
 *   "both runs succeeded": a rebuild publishes by atomic rename
 *   into place, which always changes mtime and inode.
 * - AGENTTS_WORKER_SERVER points at a closed port: a Host's
 *   notifyEvent must never post test events to the production
 *   server (port 18741) — the BRA-133 lesson. The dead port fails
 *   fast and is swallowed.
 *
 *   bun tests/test-bra147.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const WORKDIR = process.env.BRA147_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "bra147-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const STATE_DIR = path.join(WORKDIR, "state");
const BUNDLES_DIR = path.join(STATE_DIR, "bundles");
const WF = path.join(ROOT, "bench", "workflows", "bench-trivial.ts");
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
function parseJson(out: string): any | null {
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
const sumTo = (n: number): number => (n * (n - 1)) / 2;
const cacheEntries = (): string[] =>
  fs.existsSync(BUNDLES_DIR) ? fs.readdirSync(BUNDLES_DIR).filter((f) => !f.startsWith(".tmp-")) : [];
const shaFile = (p: string): string => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function runCli(runId: string, n: number): { rc: number; out: any | null; raw: string } {
  const r = cli([
    "run", WF, "--adapter", "direct", "--state-dir", STATE_DIR,
    "--run-id", runId, "--input", JSON.stringify({ n }), "--wait",
  ]);
  return { rc: r.rc, out: parseJson(r.out), raw: `${r.out}\n${r.err}` };
}

// ---------------------------------------------------------------- A. first process builds + caches
let cachedPath = "";
let cachedMtime = 0;
let cachedIno = 0;
let cachedSha = "";
{
  const { rc, out, raw } = runCli("bra147-a", 1000);
  check(rc === 0, `A CLI OK: first CLI process exited 0 (got ${rc}${rc !== 0 ? ` — ${raw.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` : ""})`);
  check(out !== null && out.n === sumTo(1000), `A OUT OK: first run returns the right output (got ${JSON.stringify(out)?.slice(0, 80)})`);
  check(cacheEntries().length === 1, `A CACHE OK: exactly 1 cache entry after the first build (got ${JSON.stringify(cacheEntries())})`);
  cachedPath = path.join(BUNDLES_DIR, cacheEntries()[0]!, "bundle.js");
  check(fs.existsSync(cachedPath), `A CACHE OK: cached bundle exists (${cachedPath})`);
  check(
    fs.readFileSync(cachedPath, "utf8").includes("{ n: 1000 }"),
    `A CACHE OK: cached bundle bakes the submitted input ({ n: 1000 })`,
  );
  const st = fs.statSync(cachedPath);
  cachedMtime = st.mtimeMs;
  cachedIno = st.ino;
  cachedSha = shaFile(cachedPath);
}

// ---------------------------------------------------------------- B. second process reuses across processes
{
  const { rc, out, raw } = runCli("bra147-b", 1000);
  check(rc === 0, `B CLI OK: second CLI process exited 0 (got ${rc}${rc !== 0 ? ` — ${raw.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` : ""})`);
  check(out !== null && out.n === sumTo(1000), `B OUT OK: second run returns the right output (got ${JSON.stringify(out)?.slice(0, 80)})`);
  check(cacheEntries().length === 1, `B CACHE OK: still exactly 1 cache entry after the second process (got ${JSON.stringify(cacheEntries())})`);
  const st = fs.statSync(cachedPath);
  check(
    st.mtimeMs === cachedMtime && st.ino === cachedIno && shaFile(cachedPath) === cachedSha,
    `B HIT OK: cached bundle untouched by the second process (mtime ${st.mtimeMs} vs ${cachedMtime}, ino ${st.ino} vs ${cachedIno}, sha ${shaFile(cachedPath).slice(0, 12)} vs ${cachedSha.slice(0, 12)}) — reused, not rebuilt`,
  );
  const pinB = path.join(STATE_DIR, "runs", "bra147-b.bundle.js");
  check(fs.existsSync(pinB), `B PIN OK: second run pinned its own bundle copy (${pinB})`);
  check(
    fs.existsSync(pinB) && fs.readFileSync(pinB, "utf8") === fs.readFileSync(cachedPath, "utf8"),
    `B PIN OK: the second run's pinned bundle is byte-identical to the cached bundle`,
  );
}

// ---------------------------------------------------------------- C. different input misses
{
  const { rc, out, raw } = runCli("bra147-c", 5);
  check(rc === 0, `C CLI OK: third CLI process exited 0 (got ${rc}${rc !== 0 ? ` — ${raw.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` : ""})`);
  check(out !== null && out.n === sumTo(5), `C OUT OK: third run returns the right output (got ${JSON.stringify(out)?.slice(0, 80)})`);
  check(cacheEntries().length === 2, `C MISS OK: two cache entries after the input change (got ${JSON.stringify(cacheEntries())})`);
  const other = cacheEntries().filter((e) => path.join(BUNDLES_DIR, e, "bundle.js") !== cachedPath);
  check(other.length === 1, `C MISS OK: exactly one new entry appeared (got ${JSON.stringify(other)})`);
  if (other.length === 1) {
    const otherBundle = path.join(BUNDLES_DIR, other[0]!, "bundle.js");
    check(
      fs.readFileSync(otherBundle, "utf8").includes("{ n: 5 }"),
      `C MISS OK: the new bundle bakes the new input ({ n: 5 })`,
    );
  }
  check(
    fs.readFileSync(cachedPath, "utf8").includes("{ n: 1000 }") && !fs.readFileSync(cachedPath, "utf8").includes("{ n: 5 }"),
    `C CLEAN OK: the old cached bundle still bakes the old input (no cross-talk)`,
  );
}

if (FAILURES.length) {
  console.log(`\ntest-bra147: ${FAILURES.length} FAILURE(S)`);
  process.exit(1);
}
console.log(
  "\nPASS bra147 bundle cache across CLI processes (second process reuses the cached bundle — mtime, inode, and sha unchanged; a different input misses and adds one entry)",
);
