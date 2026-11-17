#!/usr/bin/env bun
/**
 * Verbatim-copy drift test (Linear BRA-88).
 *
 * The `agentts` module and the `extract` extractor each exist in more
 * than one copy, and the copies had silently diverged: the host
 * `agentts.ts` alone carried the BRA-73 call-site capture, and the
 * host `extract.ts` alone walked transitive relative imports
 * (`collectWorkflowFiles` / `depHash`). The mock plugin therefore ran
 * an older extractor (a workflow using a library file extracted under
 * the host but not under the mock) and a pre-BRA-73 module (mock
 * journals had no trap `site`). BRA-47 did not widen the drift — the
 * deltas were pre-existing — but nothing enforced the rule, so
 * nothing caught them.
 *
 * Design decisions (BRA-88, decided here, not left open):
 *
 * 1. Mechanism: SYNC CHECK, byte-identical, ZERO allow-list — not
 *    generated copies. The copies live in three packages with
 *    different consumers and no shared build step (the C host builds
 *    with `make`, Bun runs TS directly, the mock plugin is sometimes
 *    a standalone working dir), so a generator would need to run
 *    before every suite, before `make`, and in every checkout layout
 *    — new machinery for a rule the docs already state ("verbatim
 *    copy"). A check fails loudly and keeps one way of doing the
 *    thing. It is enforced twice: a fail-fast inline `cmp` gate in
 *    run.sh (before the C build — no point building on a drifted
 *    tree) and this suite, which is the authoritative spec of the
 *    rule and also proves the fixed behavior end to end.
 * 2. Canonical copies: `agentts.ts` is canonical at
 *    `packages/durablets/src/agentts.ts` (docs/ARCHITECTURE.md; the
 *    durablets package's tests import it); the host and mock copies
 *    are verbatim copies of it. `extract.ts` has no packages copy —
 *    canonical is `apps/agentts/src/extract.ts` (host); the mock
 *    copy is verbatim. This landing copied host -> canonical + mock
 *    for `agentts.ts` (the host copy was the only one with BRA-73)
 *    and host -> mock for `extract.ts`.
 * 3. No allow-list is needed because no genuine per-copy delta
 *    exists: `agentts.ts` has no imports at all, and both `extract.ts`
 *    copies import only `./gate` plus node/typescript libs, so the
 *    same bytes resolve identically from every location. Any future
 *    delta that genuinely cannot be shared must be justified in the
 *    issue that introduces it — not smuggled in as a silent edit.
 * 4. Companion edits the landing forced (behavior, not scope
 *    creep): the core driver test asserted raw C-log trap args
 *    verbatim, so it now strips the one `__agenttsSite` transport
 *    key and asserts a well-formed site instead
 *    (packages/durablets/plugin/driver.ts — test file, not the C
 *    core). And the mock plugin mirrors the host's BRA-73 handling
 *    in its ingest (promote `site`, strip the key from the journaled
 *    arg) and dispatch (strip before siteKeyFor/adapter/repair)
 *    (plugins/mock/src/mock-plugin.ts) — without that, syncing the
 *    module copies would have leaked the transport key into mock
 *    journal args and still left mock journals with no top-level
 *    `site`.
 * 5. The BRA-73 capture reads Error.stack at the call site. It
 *    behaves correctly in the C-host-bundled (QuickJS) context: the
 *    host copy was already verified live on the engine, the canonical
 *    copy goes through the identical Bun.build -> C host path, and
 *    the core suite's agentts-bundle test now asserts a well-formed
 *    site on every trap event. The transitive-import walk works from
 *    the mock plugin's location because it resolves everything
 *    relative to the workflow file, never to the extractor's own
 *    directory (the only `import.meta.dir` use is the agentts-module
 *    fallback, which resolves beside the extractor — the mock copy).
 *
 *   A. The copies are in sync per the enforced rule, and the check
 *      itself is proven by a negative control: temp copies of all
 *      five files, one perturbed, must be reported as drift (and an
 *      unperturbed temp set must pass). The temp copies are
 *      discarded — the real tree is never mutated by the control.
 *   B. Mock journals now carry trap `site` (the BRA-73 guarantee
 *      under mock): the mock suite's workflow-agentts run (all six
 *      wrappers) journals a well-formed site on every trap event,
 *      the site line is the wrapper call in the bundle, and no
 *      journaled arg carries `__agenttsSite`.
 *   C. A workflow using a library file (transitive relative import)
 *      extracts identically under host and mock: the same fixture
 *      extracted by both `extractWorkflow` copies yields the same
 *      site keys (including the library file's `job:score` site) and
 *      the same non-null `depHash`; and the fixture runs to
 *      completion under the mock plugin (the old mock extractor
 *      missed the library site, so dispatch threw "no extracted
 *      schema").
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra88.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra85 suite.)
 *
 * Run outputs go to $BRA88_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { MockPlugin } from "../plugins/mock/src/mock-plugin";
import { extractWorkflow as extractWorkflowHost } from "../src/extract";
import { extractWorkflow as extractWorkflowMock } from "../plugins/mock/src/extract";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKDIR = process.env.BRA88_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra88-"));

// The five files the sync rule covers, grouped by canonical copy.
// AGENTTS_CORE_DIR locates the core package when the host runs from
// a scratch copy (run.sh sets it, as for the checker suite); without
// it the staged-tree relative path is used.
const CANONICAL_AGENTTS = process.env.AGENTTS_CORE_DIR
  ? path.join(process.env.AGENTTS_CORE_DIR, "src", "agentts.ts")
  : path.join(ROOT, "..", "..", "packages", "durablets", "src", "agentts.ts");
const HOST_AGENTTS = path.join(ROOT, "src", "agentts.ts");
const MOCK_AGENTTS = path.join(ROOT, "plugins", "mock", "src", "agentts.ts");
const HOST_EXTRACT = path.join(ROOT, "src", "extract.ts");
const MOCK_EXTRACT = path.join(ROOT, "plugins", "mock", "src", "extract.ts");

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

/** The enforced rule: every copy byte-identical to its canonical file.
 * Returns one drift description per offending file (empty = in sync).
 * A missing file is drift, not a crash. */
function checkSync(agentts: { canonical: string; copies: string[] }, extract: { canonical: string; copies: string[] }): string[] {
  const drift: string[] = [];
  const sha = (p: string): string | null => {
    try {
      return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    } catch {
      return null;
    }
  };
  for (const [label, canonical, copies] of [
    ["agentts.ts", agentts.canonical, agentts.copies],
    ["extract.ts", extract.canonical, extract.copies],
  ] as const) {
    const want = sha(canonical);
    if (want === null) {
      drift.push(`${label}: canonical file missing: ${canonical}`);
      continue;
    }
    for (const f of copies) {
      const got = sha(f);
      if (got === null) drift.push(`${label}: copy missing: ${f}`);
      else if (got !== want) drift.push(`${label}: ${f} differs from canonical ${canonical} (BRA-88: verbatim-copy rule — sync the copies, do not edit one alone)`);
    }
  }
  return drift;
}

// ------------------------------------------------------------ A: sync + negative control
async function testSync(): Promise<void> {
  console.log("\n=== A. verbatim-copy sync (agentts.ts x3, extract.ts x2) ===");
  const drift = checkSync(
    { canonical: CANONICAL_AGENTTS, copies: [HOST_AGENTTS, MOCK_AGENTTS] },
    { canonical: HOST_EXTRACT, copies: [MOCK_EXTRACT] },
  );
  check(drift.length === 0, drift.length === 0 ? "SYNC OK: all three agentts.ts copies and both extract.ts copies are byte-identical to their canonical file" : `SYNC FAIL: ${drift.join(" | ")}`);

  // Negative control: the check must FAIL LOUDLY on a reintroduced
  // delta. Temp copies only — the real tree is never touched.
  const tmp = fs.mkdtempSync(path.join(WORKDIR, "neg-"));
  const tmpFile = (src: string, name: string): string => {
    const p = path.join(tmp, name);
    fs.copyFileSync(src, p);
    return p;
  };
  const tCanon = tmpFile(CANONICAL_AGENTTS, "canonical-agentts.ts");
  const tHost = tmpFile(HOST_AGENTTS, "host-agentts.ts");
  const tMock = tmpFile(MOCK_AGENTTS, "mock-agentts.ts");
  const tHostEx = tmpFile(HOST_EXTRACT, "host-extract.ts");
  const tMockEx = tmpFile(MOCK_EXTRACT, "mock-extract.ts");
  const tmpSet = () => checkSync(
    { canonical: tCanon, copies: [tHost, tMock] },
    { canonical: tHostEx, copies: [tMockEx] },
  );
  check(tmpSet().length === 0, "SYNC NEGATIVE CONTROL OK: unperturbed temp copies pass the check");
  fs.appendFileSync(tMock, "\n// BRA-88 negative control: one-line drift in the mock agentts copy\n");
  const drift1 = tmpSet();
  check(
    drift1.length === 1 && drift1[0].includes("mock-agentts.ts"),
    drift1.length === 1
      ? `SYNC NEGATIVE CONTROL OK: perturbed mock agentts copy is reported as drift (${drift1[0].slice(0, 120)})`
      : `SYNC NEGATIVE CONTROL FAIL: perturbing the mock agentts copy reported ${drift1.length} drift(s): ${drift1.join(" | ")}`,
  );
  fs.appendFileSync(tMockEx, "\n// BRA-88 negative control: one-line drift in the mock extract copy\n");
  const drift2 = tmpSet();
  check(
    drift2.length === 2 && drift2.some((d) => d.includes("mock-extract.ts")),
    drift2.length === 2
      ? "SYNC NEGATIVE CONTROL OK: perturbing the mock extract copy too reports exactly 2 drifts (one per perturbed file)"
      : `SYNC NEGATIVE CONTROL FAIL: two perturbed copies reported ${drift2.length} drift(s): ${drift2.join(" | ")}`,
  );
}

// ------------------------------------------------------------ B: trap site in mock journals
async function testMockTrapSite(): Promise<void> {
  console.log("\n=== B. mock journals carry trap site (BRA-73 under mock) ===");
  const workdir = path.join(WORKDIR, "mock-site");
  fs.mkdirSync(workdir, { recursive: true });
  const plugin = new MockPlugin({ workdir });
  const runId = "run-bra88-site";
  const workflow = path.join(ROOT, "plugins", "mock", "tests", "workflows", "workflow-agentts.ts");
  plugin.prepareRun(workflow, runId);
  const driverPath = plugin.driverFor(runId);
  const bundleOut = await plugin.bundle(driverPath, "bundle-agentts.js");
  let rc = plugin.startRunFrom(bundleOut, runId);
  rc = plugin.drive(runId);
  check(rc === 0, rc === 0 ? "MOCK SITE OK: workflow-agentts run completed under the mock plugin (rc 0)" : `MOCK SITE FAIL: workflow-agentts run under mock exited ${rc}`);
  if (rc !== 0) return;
  const traps = plugin.journal(runId).filter((e) => e.event === "trap");
  const expectedArgs: Record<string, any> = {
    job: { spec: "score", input: { value: 7 } },
    exec: { cmd: "echo hi" },
    gate: { question: "approve?" },
    sleep: { ms: 1000 },
    cron: { at: "2027-04-09T00:00:00Z" },
    decide: { question: "pick one", options: ["a", "b"] },
  };
  const types = ["job", "exec", "gate", "sleep", "cron", "decide"];
  check(traps.length === 6, `MOCK SITE OK: 6 trap events in the mock journal (got ${traps.length})`);
  if (traps.length !== 6) return;
  const bundleLines = fs.readFileSync(bundleOut, "utf8").split("\n");
  const seenSites = new Set<string>();
  let allOk = true;
  for (let i = 0; i < 6; i++) {
    const ev = traps[i];
    if (ev.type !== types[i] || ev.trapId !== `${runId}/trap-${i}`) {
      fail(`MOCK SITE FAIL: trap ${i} type/id wrong: ${JSON.stringify(ev)}`);
      allOk = false;
      continue;
    }
    const s = ev.site;
    const siteOk =
      s &&
      typeof s.file === "string" &&
      s.file.endsWith("bundle-agentts.js") &&
      Number.isFinite(s.line) &&
      s.line >= 1 &&
      s.line <= bundleLines.length &&
      Number.isFinite(s.column) &&
      s.column >= 1;
    if (!siteOk) {
      fail(`MOCK SITE FAIL: ${types[i]} has no well-formed trap site in the mock journal: ${JSON.stringify(s)}`);
      allOk = false;
    } else {
      seenSites.add(`${s.file}:${s.line}:${s.column}`);
      if (!bundleLines[s.line - 1].includes(`${types[i]}(`)) {
        fail(`MOCK SITE FAIL: ${types[i]} site line ${s.line} is not its wrapper call: ${(bundleLines[s.line - 1] ?? "").trim().slice(0, 80)}`);
        allOk = false;
      }
    }
    if (ev.arg && typeof ev.arg === "object" && "__agenttsSite" in ev.arg) {
      fail(`MOCK SITE FAIL: ${types[i]} journaled arg still carries the __agenttsSite transport key: ${JSON.stringify(ev.arg)}`);
      allOk = false;
    } else if (JSON.stringify(ev.arg) !== JSON.stringify(expectedArgs[types[i]])) {
      fail(`MOCK SITE FAIL: ${types[i]} journaled arg != spec: ${JSON.stringify(ev.arg)} vs ${JSON.stringify(expectedArgs[types[i]])}`);
      allOk = false;
    }
  }
  check(seenSites.size === 6, seenSites.size === 6 ? "MOCK SITE OK: all 6 trap sites are distinct call sites in the bundle" : `MOCK SITE FAIL: only ${seenSites.size} distinct sites for 6 traps`);
  if (allOk) ok("MOCK SITE OK: every mock-journal trap event carries a well-formed site on its wrapper-call line, and every journaled arg is exactly the spec (no __agenttsSite)");
}

// ------------------------------------------------------------ C: transitive imports under mock
function writeFixture(): { mainPath: string; libPath: string } {
  const dir = path.join(WORKDIR, "bra88-fixture");
  fs.mkdirSync(dir, { recursive: true });
  // The library file imports the agentts module via a relative path
  // from the fixture dir to the MOCK copy — a genuine relative
  // import, so the extractor's transitive walk must follow main ->
  // lib (lib's own agentts import is excluded from the walk, as the
  // module implementation, not a workflow trap call). The specifier
  // is extensionless, as in real workflows (`../src/agentts`): the
  // first-run gate rejects a `.ts` extension (TS5097).
  const relAgentts = path.relative(dir, MOCK_AGENTTS).split(path.sep).join("/").replace(/\.ts$/, "");
  const agenttsSpec = relAgentts.startsWith(".") ? relAgentts : `./${relAgentts}`;
  const libPath = path.join(dir, "lib.ts");
  fs.writeFileSync(
    libPath,
    `// BRA-88 fixture library file: the trap call lives here, not in\n` +
      `// the entry file — the old mock extractor never walked this far.\n` +
      `import { job } from ${JSON.stringify(agenttsSpec)};\n` +
      `\n` +
      `export interface LibScoreInput {\n` +
      `  value: number;\n` +
      `}\n` +
      `\n` +
      `export interface LibScoreResult {\n` +
      `  score: number;\n` +
      `  label: string;\n` +
      `}\n` +
      `\n` +
      `export function scoreInLibrary(value: number): LibScoreResult {\n` +
      `  return job<LibScoreInput, LibScoreResult>({ spec: "score", input: { value } });\n` +
      `}\n`,
  );
  const mainPath = path.join(dir, "main.ts");
  fs.writeFileSync(
    mainPath,
    `// BRA-88 fixture entry file: one trap of its own (exec) plus a\n` +
      `// call into the library file, whose job trap must extract too.\n` +
      `import { exec } from ${JSON.stringify(agenttsSpec)};\n` +
      `import { scoreInLibrary } from "./lib";\n` +
      `\n` +
      `declare function print(...args: unknown[]): void;\n` +
      `\n` +
      `export interface MainResult {\n` +
      `  done: boolean;\n` +
      `}\n` +
      `\n` +
      `export default function run(): MainResult {\n` +
      `  const j = scoreInLibrary(7);\n` +
      `  print("job:", JSON.stringify(j));\n` +
      `  const e = exec({ cmd: "echo hi" });\n` +
      `  print("exec:", JSON.stringify(e));\n` +
      `  print("done");\n` +
      `  return { done: true };\n` +
      `}\n`,
  );
  return { mainPath, libPath };
}

async function testTransitiveImports(): Promise<void> {
  console.log("\n=== C. transitive relative imports extract identically under host and mock ===");
  const { mainPath } = writeFixture();
  // Separate cache dirs: a shared one would let the second call hit
  // the first call's entry and make the comparison vacuous.
  const hostCache = path.join(WORKDIR, "cache-host");
  const mockCache = path.join(WORKDIR, "cache-mock");
  const hostExt = extractWorkflowHost(mainPath, hostCache);
  const mockExt = extractWorkflowMock(mainPath, mockCache);
  const hostKeys = Object.keys(hostExt.sites).sort();
  const mockKeys = Object.keys(mockExt.sites).sort();
  check(
    JSON.stringify(hostKeys) === JSON.stringify(mockKeys),
    JSON.stringify(hostKeys) === JSON.stringify(mockKeys)
      ? `EXTRACT OK: host and mock extract the same site keys (${hostKeys.join(", ")})`
      : `EXTRACT FAIL: host sites [${hostKeys.join(", ")}] != mock sites [${mockKeys.join(", ")}]`,
  );
  check(
    hostKeys.includes("job:score") && hostKeys.includes("exec"),
    hostKeys.includes("job:score") && hostKeys.includes("exec")
      ? "EXTRACT OK: the library file's job:score site (and the entry's exec site) are both extracted"
      : `EXTRACT FAIL: expected job:score + exec among [${hostKeys.join(", ")}]`,
  );
  check(
    hostExt.depHash !== null && hostExt.depHash === mockExt.depHash,
    hostExt.depHash !== null && hostExt.depHash === mockExt.depHash
      ? `EXTRACT OK: depHash is non-null and identical under host and mock (${String(hostExt.depHash).slice(0, 16)}…)`
      : `EXTRACT FAIL: depHash host=${String(hostExt.depHash)} mock=${String(mockExt.depHash)} (a null depHash means the walk saw no library file)`,
  );

  // End to end under the mock plugin: the old mock extractor missed
  // the library site, so dispatch threw "no extracted schema". The
  // fixed mock must drive the fixture to completion.
  const workdir = path.join(WORKDIR, "mock-lib");
  fs.mkdirSync(workdir, { recursive: true });
  const plugin = new MockPlugin({ workdir });
  const runId = "run-bra88-lib";
  plugin.prepareRun(mainPath, runId);
  const driverPath = plugin.driverFor(runId);
  const bundleOut = await plugin.bundle(driverPath, "bundle-bra88-lib.js");
  let rc = plugin.startRunFrom(bundleOut, runId);
  rc = plugin.drive(runId);
  check(rc === 0, rc === 0 ? "EXTRACT OK: library-file fixture runs to completion under the mock plugin (rc 0)" : `EXTRACT FAIL: library-file fixture under mock exited ${rc}`);
  if (rc !== 0) return;
  const traps = plugin.journal(runId).filter((e) => e.event === "trap");
  const trapTypes = traps.map((t) => t.type);
  check(
    JSON.stringify(trapTypes) === JSON.stringify(["job", "exec"]),
    JSON.stringify(trapTypes) === JSON.stringify(["job", "exec"])
      ? "EXTRACT OK: mock journal has both traps (library job, then entry exec), each with a site"
      : `EXTRACT FAIL: mock journal traps [${trapTypes.join(", ")}], expected [job, exec]`,
  );
  const jobEv = traps.find((t) => t.type === "job");
  check(
    !!jobEv && JSON.stringify(jobEv.arg) === JSON.stringify({ spec: "score", input: { value: 7 } }) && !!jobEv.site,
    !!jobEv && !!jobEv.site
      ? "EXTRACT OK: the library job trap dispatched with the verbatim spec and a journaled site"
      : `EXTRACT FAIL: library job trap event wrong: ${JSON.stringify(jobEv)}`,
  );
}

// ------------------------------------------------------------ main
async function main(): Promise<number> {
  console.log(`BRA-88 tests — workdir ${WORKDIR}`);
  if (!process.env.DURABLETS_HOST) {
    console.log("FAIL: DURABLETS_HOST is not set — run via ./run.sh (it builds the C host and sets it)");
    return 1;
  }
  fs.mkdirSync(WORKDIR, { recursive: true }); // mkdtemp (negative control) needs the parent to exist
  await testSync();
  await testMockTrapSite();
  await testTransitiveImports();
  if (FAILURES.length) {
    console.log(`\nFAIL bra88 suite: ${FAILURES.length} failure(s)`);
    return 1;
  }
  console.log("\nPASS bra88 verbatim-copy drift (sync check byte-identical incl. negative control, mock journals carry trap site, transitive imports extract identically under host and mock)");
  return 0;
}

process.exit(await main());
