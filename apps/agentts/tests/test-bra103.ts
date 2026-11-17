#!/usr/bin/env bun
/**
 * DurableTS-dir regression test (Linear BRA-103).
 *
 * Root cause: when node_modules is missing, run.sh copies the host
 * sources to scratch ($SCRATCH/host-src, apps/agentts only) and runs
 * the host from there — but durabletsPackageDirs() (src/host.ts)
 * locates the DurableTS package relative to the host file, so under
 * the scratch copy neither candidate exists (the copy holds no
 * packages/), hashDurabletsC() returns "unknown", and the queue entry
 * records dquickts-<pin>+durablets-unknown — which the BRA-71 B3
 * check refuses. The fix: run.sh exports $AGENTTS_DURABLETS_DIR,
 * the package dir the C host binary was built from, and the host
 * takes it as its first package-dir candidate.
 *
 * This test pins the wiring by replaying the scratch layout in
 * miniature: it copies src/ + plugins/ + workflows/ (the dirs the
 * copied host imports from — the mock adapter imports
 * workflows/bugfix-worker) to a temp dir with no packages/ sibling, then
 * spawns a child bun process that imports the copied host and prints
 * engineVersion():
 *   A. With $AGENTTS_DURABLETS_DIR unset in the child, the version
 *      records durablets-unknown — the bug, reproduced. (Also
 *      asserts the copy really is a scratch layout: neither relative
 *      candidate holds src/durablets.c.)
 *   B. With $AGENTTS_DURABLETS_DIR set to the real package dir, the
 *      version's durablets half is the sha256[0:16] of the real
 *      src/durablets.c — the hash comes from the exported dir, not
 *      from a guess. On old code (no env support) B still records
 *      "unknown" and fails.
 *   C. run.sh actually exports the var: it is set in this process
 *      and points at a dir holding src/durablets.c. (If it regresses
 *      and stops exporting, C fails here instead of the suite dying
 *      later at B3.)
 *
 * Only the durablets half is asserted: the dquickts pin half resolves
 * through the same candidates, but under a scratch copy with no
 * vendored tree and no $DQUICKTS it legitimately falls back to the
 * legacy minimal tree (or "unknown" on a machine without one) —
 * that is a separate concern, and B3 in the full suite asserts the
 * full shape end to end.
 *
 * Run: bun tests/test-bra103.ts (run.sh runs it after the bra101
 * suite, with $AGENTTS_DURABLETS_DIR set by run.sh). No state dir
 * outside the temp copy, no C host binary needed (the child passes a
 * dummy hostPath; engineVersion() never touches the binary). Exit 0
 * on PASS, 1 on any mismatch.
 */
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");

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

const shaFile16 = (p: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);
const durabletsHalf = (version: string): string | null => {
  const m = version.match(/\+durablets-([0-9a-f]{16}|unknown)$/);
  return m ? m[1] : null;
};

// C. run.sh exports the var, pointing at a real package dir.
const envDir = process.env.AGENTTS_DURABLETS_DIR;
check(
  typeof envDir === "string" && envDir.length > 0,
  `BRA103 EXPORT OK: $AGENTTS_DURABLETS_DIR is set (got ${envDir ?? "(unset)"} — run.sh must export it; run this test via run.sh)`,
);
const envC = envDir ? path.join(envDir, "src", "durablets.c") : "";
check(
  !!envDir && fs.existsSync(envC),
  `BRA103 EXPORT OK: $AGENTTS_DURABLETS_DIR holds src/durablets.c (${envC || "(no dir)"})`,
);
if (FAILURES.length) {
  console.log(`\nFAIL bra103 durablets-dir suite (${FAILURES.length} failure(s))`);
  process.exit(1);
}
const expectedHash = shaFile16(envC);

// Scratch-layout copy: src/ + plugins/ + workflows/ only, no
// packages/ sibling. node_modules is symlinked in (not copied) so
// the copied host's `typescript` import resolves exactly as the
// real tree's does.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bra103-"));
try {
  const HOSTSRC = path.join(TMP, "host-src");
  fs.mkdirSync(HOSTSRC);
  fs.cpSync(path.join(ROOT, "src"), path.join(HOSTSRC, "src"), { recursive: true });
  fs.cpSync(path.join(ROOT, "plugins"), path.join(HOSTSRC, "plugins"), { recursive: true });
  fs.cpSync(path.join(ROOT, "workflows"), path.join(HOSTSRC, "workflows"), { recursive: true });
  const nodeModules = path.join(ROOT, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    fail(`BRA103 SETUP: ${nodeModules} missing — run bun install first (run.sh does this before the suites)`);
    throw new Error("setup failed");
  }
  fs.symlinkSync(nodeModules, path.join(TMP, "node_modules"), "dir");

  // A0. The copy really is a scratch layout: neither relative
  // candidate (the two durabletsPackageDirs() fallbacks, resolved
  // from the copy) holds src/durablets.c.
  const copyHere = path.join(HOSTSRC, "src");
  const relCandidates = [
    path.resolve(copyHere, "..", "..", "..", "packages", "durablets"),
    path.resolve(copyHere, "..", "..", "agentts-repo", "packages", "durablets"),
  ];
  check(
    relCandidates.every((d) => !fs.existsSync(path.join(d, "src", "durablets.c"))),
    `BRA103 LAYOUT OK: scratch copy has no packages/ sibling (relative candidates ${relCandidates.join(", ")} hold no durablets.c)`,
  );

  // Child: construct a Host from the copy and print engineVersion().
  // hostPath is a dummy — engineVersion() never touches the binary —
  // and stateDir stays inside the temp copy so nothing leaks.
  const CHILD = path.join(HOSTSRC, "print-version.ts");
  fs.writeFileSync(
    CHILD,
    `import { Host } from "./src/host";\n` +
      `const h = new Host({ hostPath: "/nonexistent-durablets-binary", stateDir: ${JSON.stringify(path.join(TMP, "state"))} });\n` +
      `console.log(h.engineVersion());\n`,
  );
  const runChild = (extraEnv: Record<string, string | undefined>): string => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    // Scrub the test hooks / overrides so the child measures the real
    // resolution: the version-override hook would fake the answer,
    // and $DQUICKTS would pin the dquickts half from outside.
    delete env.AGENTTS_ENGINE_VERSION_OVERRIDE;
    delete env.DQUICKTS;
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const r = spawnSync(process.execPath, [CHILD], { encoding: "utf8", env });
    if (r.status !== 0) {
      fail(`BRA103 CHILD: child bun process exited ${r.status} — ${String(r.stderr ?? "").slice(0, 300)}`);
      return "";
    }
    return String(r.stdout ?? "").trim();
  };

  // A. Unset: the bug, reproduced — durablets-unknown.
  const versionUnset = runChild({ AGENTTS_DURABLETS_DIR: undefined });
  if (versionUnset) {
    check(
      durabletsHalf(versionUnset) === "unknown",
      `BRA103 UNSET OK: scratch-copy host with $AGENTTS_DURABLETS_DIR unset records durablets-unknown (got ${versionUnset})`,
    );
  }

  // B. Set: the fix — the durablets half is the real source hash.
  const versionSet = runChild({ AGENTTS_DURABLETS_DIR: envDir });
  if (versionSet) {
    check(
      durabletsHalf(versionSet) === expectedHash,
      `BRA103 SET OK: scratch-copy host with $AGENTTS_DURABLETS_DIR set records the real durablets.c hash ${expectedHash} (got ${versionSet})`,
    );
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (FAILURES.length) {
  console.log(`\nFAIL bra103 durablets-dir suite (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra103 durablets-dir suite (run.sh exports the package dir; the scratch-copy host hashes the real durablets.c)");
