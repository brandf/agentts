#!/usr/bin/env bun
/**
 * Driver-bundle cache keyed by frozenHash (Linear BRA-94, Tier 4 Low).
 *
 * From the BRA-93 performance audit, item 9 — verdict WORTH DOING,
 * post-MVP. Measured: Bun.build of the driver bundle cost 5.08ms per
 * run (bundle_ms baseline 3.21ms after ratcheting), ~7% of a 69ms warm
 * run — rebuilt on every run even though the workflow closure is
 * frozen by content hash (BRA-71).
 *
 * The fix (BRA-94), in src/host.ts:
 *  - bundle() and bundleSync() consult a disk cache before building:
 *    stateDir/bundles/<key>/bundle.js (+ bundle.js.map). The cache is
 *    on disk, not in memory, on purpose: CLI invocations are separate
 *    processes (submit, then queue run), so an in-memory cache would
 *    never hit across the production path.
 *  - The key is the sha256 of the bundle's inputs (BRA-93 item 9's
 *    prescription, extended): the frozenHash from the driver's import
 *    specifier (the driver imports the frozen entry path, so the hash
 *    IS the closure content — a changed workflow gets a different
 *    hash and misses), the JSON text of the entry(...) call (the
 *    driver bakes the validated input in, so the same closure with a
 *    different input is a different bundle — a frozenHash-only key
 *    would silently run the first input), the engineVersion, the
 *    Bun.version (the bundler), and DRIVER_TEMPLATE_VERSION (bump
 *    when the driverFor template changes). Content-addressed means
 *    there is no invalidation: a changed input or closure changes
 *    the key and misses.
 *  - A driver with no key — a live-path driver (it names no content,
 *    so caching it could serve a bundle built from a file edited
 *    since) or a hand-written one — is never cached and builds every
 *    time, as before.
 *  - Publish is atomic (copy bundle+map into a unique tmp dir, rename
 *    into place); a publish race falls back to the winner (same key
 *    means same inputs, so the content is identical). A lookup
 *    requires the bundle file; the map is optional, like pinBundle.
 *  - pinBundle is unchanged: every run still gets its own pinned
 *    copy under runs/ (the cache is the shared build, the pin is the
 *    run's record).
 *
 * This test drives the cache under the Host with the direct adapter
 * (real C host), on the same Host and on a FRESH Host over the same
 * stateDir (proving the disk cache survives processes):
 *  A. Same frozen workflow + same input reuses the cached bundle
 *     (async bundle() path): the second bundle() returns the cached
 *     path, byte-identical to the first build, and the cache holds
 *     exactly 1 entry.
 *  B. Same closure, different input misses: a second cache entry
 *     appears, and the two bundles bake their own inputs.
 *  C. Changed workflow misses: editing the workflow (a comment —
 *     content is content) gets a new frozenHash and a third entry.
 *  D. Full runs execute from cached bundles (submit + runQueue +
 *     result, correct outputs), add no cache entries, pin byte-
 *     identical per-run copies — and a fresh Host over the same
 *     stateDir hits the disk cache.
 *  E. Child runs reuse the cache too (sync bundleSync path): the
 *     BRA-105 parent runs the child twice; the first parent run
 *     caches the parent bundle + the child bundle (+2 entries), the
 *     second adds none.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra94.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra131 suite.)
 *
 * Run outputs go to $BRA94_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): the cache-hit latency
 * itself — timing assertions are flaky, so the win is proven by the
 * bench (bundle_ms before/after), not here. This test proves the
 * cache is CORRECT (hits only when the inputs match) and that runs
 * execute from it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Host } from "../src/host";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WF_SRC = path.join(ROOT, "bench", "workflows", "bench-trivial.ts");
const PARENT = path.join(ROOT, "tests", "workflows", "workflow-bra105-parent.ts");
const WORKDIR = process.env.BRA94_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra94-"));

// The workflow under test is a COPY, so section C can edit it without
// touching the repo file. (The copy's closure hash is its own; the
// content is bench-trivial verbatim until edited.)
const WF = path.join(WORKDIR, "wf", "bench-trivial.ts");
fs.mkdirSync(path.dirname(WF), { recursive: true });
fs.copyFileSync(WF_SRC, WF);

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
const bundlesDir = path.join(stateDir, "bundles");
const cacheEntries = (): string[] =>
  fs.existsSync(bundlesDir) ? fs.readdirSync(bundlesDir).filter((f) => !f.startsWith(".tmp-")) : [];
const sumTo = (n: number): number => (n * (n - 1)) / 2;

const host = new Host({ stateDir, adapter: new DirectAdapter() });

// --- A. Same frozen workflow + same input reuses the cached bundle.
const a1 = "bra94-a1";
host.submit(WF, { runId: a1, input: { n: 1000 } });
const d1 = host.driverFor(a1);
const b1 = await host.bundle(d1, "bundle-bra94-a1.js");
check(
  b1 === path.join(stateDir, "slices", "bundle-bra94-a1.js"),
  `A OK: first build lands in the workdir (got ${b1})`,
);
check(cacheEntries().length === 1, `A OK: one cache entry after the first build (got ${JSON.stringify(cacheEntries())})`);
const cached1 = path.join(bundlesDir, cacheEntries()[0]!, "bundle.js");
check(fs.existsSync(cached1), `A OK: cached bundle exists (${cached1})`);
check(fs.existsSync(`${cached1}.map`), `A OK: cached source map exists (${cached1}.map)`);
check(
  fs.readFileSync(cached1, "utf8") === fs.readFileSync(b1, "utf8"),
  `A OK: cached bundle is byte-identical to the built bundle`,
);
const a2 = "bra94-a2";
host.submit(WF, { runId: a2, input: { n: 1000 } });
const d2 = host.driverFor(a2);
// Premise check: the two drivers differ ONLY in the runId comment.
const stripFirst = (s: string): string => s.split("\n").slice(1).join("\n");
check(
  stripFirst(fs.readFileSync(d1, "utf8")) === stripFirst(fs.readFileSync(d2, "utf8")),
  `A OK: the two drivers differ only in the runId comment line`,
);
const b2 = await host.bundle(d2, "bundle-bra94-a2.js");
check(b2 === cached1, `A OK: second bundle() returns the cached path (got ${b2})`);
check(cacheEntries().length === 1, `A OK: still one cache entry after the reuse (got ${JSON.stringify(cacheEntries())})`);
check(
  fs.readFileSync(d2, "utf8").includes(`entry({"n":1000});`) &&
    fs.readFileSync(b2, "utf8").includes("{ n: 1000 }"),
  `A OK: cached bundle bakes the submitted input (driver entry({"n":1000}); bundle run({ n: 1000 }))`,
);

// --- B. Same closure, different input misses.
const b1id = "bra94-b1";
host.submit(WF, { runId: b1id, input: { n: 5 } });
const b3 = await host.bundle(host.driverFor(b1id), "bundle-bra94-b1.js");
check(b3 !== b2, `B OK: different input builds a different bundle (got ${b3})`);
check(cacheEntries().length === 2, `B OK: two cache entries after the input change (got ${JSON.stringify(cacheEntries())})`);
check(
  fs.readFileSync(host.driverFor(b1id), "utf8").includes(`entry({"n":5});`) &&
    fs.readFileSync(b3, "utf8").includes("{ n: 5 }"),
  `B OK: the new bundle bakes the new input (driver entry({"n":5}); bundle run({ n: 5 }))`,
);
check(
  fs.readFileSync(b2, "utf8").includes("{ n: 1000 }") && !fs.readFileSync(b2, "utf8").includes("{ n: 5 }"),
  `B OK: the cached bundle still bakes the old input (no cross-talk)`,
);

// --- C. Changed workflow misses (a comment changes the closure content).
fs.appendFileSync(WF, "\n// bra94: edited workflow — new closure hash.\n");
const c1 = "bra94-c1";
host.submit(WF, { runId: c1, input: { n: 1000 } });
const b4 = await host.bundle(host.driverFor(c1), "bundle-bra94-c1.js");
check(b4 !== b2 && b4 !== b3, `C OK: edited workflow builds a different bundle (got ${b4})`);
check(cacheEntries().length === 3, `C OK: three cache entries after the workflow edit (got ${JSON.stringify(cacheEntries())})`);

// --- D. Full runs execute from cached bundles; a fresh Host hits the disk cache.
await host.runQueue();
for (const [id, n] of [
  ["bra94-a1", 1000],
  ["bra94-a2", 1000],
  ["bra94-b1", 5],
  ["bra94-c1", 1000],
] as const) {
  const r = host.result(id);
  check(
    r.status === "done" && (r.output as { n: number } | undefined)?.n === sumTo(n),
    `D OK: ${id} completed with the right output (got ${JSON.stringify(r)})`,
  );
}
check(cacheEntries().length === 3, `D OK: full runs added no cache entries (got ${JSON.stringify(cacheEntries())})`);
const pinA1 = path.join(stateDir, "runs", "bra94-a1.bundle.js");
const pinA2 = path.join(stateDir, "runs", "bra94-a2.bundle.js");
check(fs.existsSync(pinA1) && fs.existsSync(pinA2), `D OK: both runs pinned their own bundle copies`);
check(
  fs.readFileSync(pinA1, "utf8") === fs.readFileSync(pinA2, "utf8"),
  `D OK: the two same-input runs pinned byte-identical bundles`,
);
const fresh = new Host({ stateDir, adapter: new DirectAdapter() });
const f1 = "bra94-fresh";
fresh.submit(WF, { runId: f1, input: { n: 1000 } });
const bf = await fresh.bundle(fresh.driverFor(f1), "bundle-bra94-fresh.js");
check(bf.startsWith(bundlesDir + path.sep), `D OK: fresh Host hits the disk cache (got ${bf})`);
check(cacheEntries().length === 3, `D OK: fresh Host added no cache entries (got ${JSON.stringify(cacheEntries())})`);

// --- E. Child runs reuse the cache too (sync bundleSync path).
const beforeE = cacheEntries().length;
const p1 = "bra94-parent-1";
host.submit(PARENT, { runId: p1 });
await host.runQueue();
const r1 = host.result(p1);
check(
  r1.status === "done" &&
    (r1.output as { doubled: number; label: string } | undefined)?.doubled === 42 &&
    (r1.output as { doubled: number; label: string } | undefined)?.label === "n=21",
  `E OK: first parent run completed through the child (got ${JSON.stringify(r1)})`,
);
check(
  cacheEntries().length === beforeE + 2,
  `E OK: first parent run cached the parent bundle + the child bundle (got ${cacheEntries().length}, expected ${beforeE + 2})`,
);
const p2 = "bra94-parent-2";
host.submit(PARENT, { runId: p2 });
await host.runQueue();
const r2 = host.result(p2);
check(r2.status === "done", `E OK: second parent run completed (got ${JSON.stringify(r2)})`);
check(
  cacheEntries().length === beforeE + 2,
  `E OK: second parent run added no cache entries — parent + child both hit (got ${cacheEntries().length})`,
);

if (FAILURES.length) {
  console.log(`\nFAIL: ${FAILURES.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nPASS bra94 driver-bundle cache (same frozen workflow + input reuses the cached bundle; changed input or workflow rebuilds; child runs share the cache; fresh Host hits the disk cache)`);
