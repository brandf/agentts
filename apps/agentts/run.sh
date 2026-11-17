#!/bin/sh
# AgentTS host executable v0 (Linear BRA-44) — build + full test run.
#   ./run.sh
# Builds the core C host into a scratch dir, runs the reference suite
# (core plugin/driver.ts), the mock suite, and the host suite into
# scratch dirs, then runs the swap test (same workflows under the
# reference plugin, the mock plugin, and the host must be
# byte-identical), plus the layering import lint (BRA-68: core + host
# never import Muse-specific APIs). All run outputs live in a mkdtemp scratch dir,
# never in the staged tree; the scratch dir is deleted on success and
# kept (path printed) on failure. Exits non-zero on any mismatch.
#
# Staging hygiene: this script never writes into the tree it runs
# from. If a package's node_modules is missing, the package is copied
# to scratch (source files only) and deps are installed there; the
# plugin dir is then pointed at with $AGENTTS_PLUGINS_DIR so
# Host.loadPlugin still finds the mock plugin engine.
set -u
cd "$(dirname "$0")"
SCRIPT_DIR=$(pwd)

# Locate the durablets core package:
#   working dir: ~/workspace/agentts-host -> ../agentts-repo/packages/durablets
#   staged:      ~/workspace/agentts-repo/apps/agentts -> ../../packages/durablets
if [ -d "$SCRIPT_DIR/../agentts-repo/packages/durablets" ]; then
  CORE="$SCRIPT_DIR/../agentts-repo/packages/durablets"
elif [ -d "$SCRIPT_DIR/../../packages/durablets" ]; then
  CORE="$SCRIPT_DIR/../../packages/durablets"
else
  echo "cannot locate the durablets core package from $SCRIPT_DIR" >&2
  exit 1
fi
# The DurableTS package dir the C host is built from (BRA-103): the
# host records a content hash of src/durablets.c in the engine version
# (BRA-71 G10), and it locates the package relative to its own file —
# which misses when this script copies the host sources to scratch
# (the scratch copy holds apps/agentts only, not packages/), so the
# version records durablets-unknown and the bra71 B3 check fails.
# This script is the only party that knows which durablets.c the
# binary was built from (make -C "$CORE" below), so export it: the
# host takes it as its first package-dir candidate. In place it is
# the same dir the host would resolve anyway, so export
# unconditionally — one way, not a scratch-only branch.
export AGENTTS_DURABLETS_DIR="$CORE"
# Locate the mock plugin (its node_modules decide whether a scratch
# copy is needed; see below):
#   working dir: ~/workspace/agentts-host -> ../agentts-mock-plugin
#   staged:      ~/workspace/agentts-repo/apps/agentts -> plugins/mock
if [ -d "$SCRIPT_DIR/../agentts-mock-plugin" ]; then
  MOCK="$SCRIPT_DIR/../agentts-mock-plugin"
elif [ -d "$SCRIPT_DIR/../agentts-repo/apps/agentts/plugins/mock" ]; then
  MOCK="$SCRIPT_DIR/../agentts-repo/apps/agentts/plugins/mock"
elif [ -d "$SCRIPT_DIR/plugins/mock" ]; then
  MOCK="$SCRIPT_DIR/plugins/mock"
else
  echo "cannot locate the mock plugin from $SCRIPT_DIR" >&2
  exit 1
fi

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/bra44.XXXXXX")
REFDIR="$SCRATCH/ref"
MOCKDIR="$SCRATCH/mock"
HOSTDIR="$SCRATCH/host"
mkdir -p "$REFDIR" "$MOCKDIR" "$HOSTDIR"
echo "scratch: $SCRATCH"

# --- verbatim-copy sync gate (BRA-88: fail fast, before the build) ---
# agentts.ts is canonical at packages/durablets/src/agentts.ts (host
# and mock copies must be byte-identical to it); extract.ts is
# canonical at apps/agentts/src/extract.ts (mock copy byte-identical).
# Zero allow-list: no per-copy delta exists (agentts.ts has no imports;
# both extract.ts copies import only ./gate + node/ts libs), so any
# difference is drift. tests/test-bra88.ts is the authoritative spec
# of this rule (incl. a negative control); this gate just refuses to
# burn a C build + full run on a drifted tree.
for pair in "$CORE/src/agentts.ts:$SCRIPT_DIR/src/agentts.ts" "$CORE/src/agentts.ts:$MOCK/src/agentts.ts" "$SCRIPT_DIR/src/extract.ts:$MOCK/src/extract.ts"; do
  a="${pair%%:*}"; b="${pair#*:}"
  if ! cmp -s "$a" "$b"; then
    echo "BRA-88 verbatim-copy drift: $b differs from canonical $a — sync the copies, do not edit one alone" >&2
    exit 1
  fi
done
echo "verbatim-copy sync gate green (agentts.ts x3, extract.ts x2)"

HOSTBIN="$SCRATCH/host-bin/durablets"
echo "building the core C host..."
# DQUICKTS may be set by re-vendor.sh to prove a candidate engine tree;
# unset means the production minimal tree (the Makefile default).
make -C "$CORE" ${DQUICKTS:+DQUICKTS="$DQUICKTS"} OUT_DIR="$SCRATCH/host-bin" durablets || exit 1
export DURABLETS_HOST="$HOSTBIN"

# Host source dir: run in place when its deps are already installed
# (the working dir), otherwise copy the sources to scratch and install
# there — never install node_modules into the tree this script runs from.
HOSTSRC="$SCRIPT_DIR"
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "host deps missing — copying host sources to scratch and installing there..."
  HOSTSRC="$SCRATCH/host-src"
  mkdir -p "$HOSTSRC"
  cp -r "$SCRIPT_DIR/src" "$SCRIPT_DIR/workflows" "$SCRIPT_DIR/tests" "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/bun.lock" "$SCRIPT_DIR/tsconfig.json" "$HOSTSRC/"
  # The worker pool suite + muse adapter live partly under plugins/
  # (worker-loop.ts, jobspecs, the plugin seam) — copy that too.
  if [ -d "$SCRIPT_DIR/plugins" ]; then cp -r "$SCRIPT_DIR/plugins" "$HOSTSRC/"; fi
  (cd "$HOSTSRC" && /opt/hatch-image/bin/bun install) || exit 1
fi

# Mock source dir: same rule — the working mock dir has node_modules;
# the staged tree must never gain them. (The mock plugin has no
# tsconfig.json; Bun strips types, so none is needed.)
MOCKSRC="$MOCK"
if [ ! -d "$MOCK/node_modules" ]; then
  echo "mock deps missing — copying mock sources to scratch and installing there..."
  MOCKSRC="$SCRATCH/mock-src"
  mkdir -p "$MOCKSRC"
  cp -r "$MOCK/src" "$MOCK/tests" "$MOCK/package.json" "$MOCK/bun.lock" "$MOCKSRC/"
  (cd "$MOCKSRC" && /opt/hatch-image/bin/bun install) || exit 1
fi

# When the host runs from a scratch copy, point the plugin dir at the
# COPIED plugins (BRA-101), not the original tree: adapters import
# HOLD from ../../../src/adapter relative to their own file, so an
# adapter loaded from the original tree gets a different HOLD Symbol
# instance than the scratch host's — `answer === HOLD` is false and
# the host fails the gate (`answer is not an Object`). The scratch
# copy includes plugins/ wholesale (above), plus the src/ and
# workflows/ the adapters import, so the copied tree is complete for
# adapters. When the host runs in place, the original tree IS the
# host's tree, so point at it as before: from the staged tree that
# is ./plugins; from the working dir the staged mock plugin is the
# one Host.loadPlugin resolves, so export it too when it exists.
if [ "$HOSTSRC" != "$SCRIPT_DIR" ] && [ -d "$HOSTSRC/plugins" ]; then
  export AGENTTS_PLUGINS_DIR="$HOSTSRC/plugins"
elif [ -d "$SCRIPT_DIR/plugins" ]; then
  export AGENTTS_PLUGINS_DIR="$SCRIPT_DIR/plugins"
elif [ -d "$SCRIPT_DIR/../agentts-repo/apps/agentts/plugins" ]; then
  export AGENTTS_PLUGINS_DIR="$SCRIPT_DIR/../agentts-repo/apps/agentts/plugins"
fi

cleanup() {
  rc=$?
  if [ $rc -eq 0 ]; then
    rm -rf "$SCRATCH"
  else
    echo "scratch kept for inspection: $SCRATCH" >&2
  fi
  exit $rc
}
trap cleanup EXIT

echo "--- reference suite (core plugin/driver.ts) ---"
DURABLETS_WORKDIR="$REFDIR" /opt/hatch-image/bin/bun "$CORE/plugin/driver.ts" > "$SCRATCH/ref.log" 2>&1 || {
  tail -40 "$SCRATCH/ref.log"
  echo "reference suite FAILED" >&2
  exit 1
}
tail -3 "$SCRATCH/ref.log"

echo "--- mock suite ---"
MOCK_WORKDIR="$MOCKDIR" /opt/hatch-image/bin/bun "$MOCKSRC/tests/run-mock-suite.ts" || exit 1

echo "--- host suite ---"
HOST_WORKDIR="$HOSTDIR" /opt/hatch-image/bin/bun "$HOSTSRC/tests/run-host-suite.ts" || exit 1

echo "--- improve-loop tests (standard library workflow) ---"
IMPROVE_WORKDIR="$SCRATCH/improve-loop" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-improve-loop.ts" || exit 1

echo "--- profiler tests (BRA-30) ---"
# Fixtures live in the tree; all outputs go to a scratch dir, never
# into the staged tree.
/opt/hatch-image/bin/bun "$HOSTSRC/tests/test-profiler.ts" "$HOSTSRC/tests/fixtures/profiler" "$SCRATCH/profiler-out" || exit 1

echo "--- checker tests (BRA-29) ---"
# Pure TypeScript (no C host needed): schema compatibility, layering,
# class/empty contracts, wiring, real workflows, type-negatives.
# AGENTTS_CORE_DIR locates the core's type-negatives fixtures when
# the host runs from a scratch copy (staged tree).
AGENTTS_CORE_DIR="$CORE" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-checker.ts" "$HOSTSRC" || exit 1

echo "--- layering import lint (BRA-68: core + host never import Muse-specific APIs) ---"
# The M2 layering rule (src/checker.ts) over the real tree — core src,
# host src, workflows, plugins — but not tests/ (test drivers import
# adapters to test them; test-checker covers those fixtures). This is
# the enforced form of the lint: `agentts check --layering` on its
# own defaults to src/ + plugins/ + workflows/ from apps/agentts.
# A violation fails loudly (exit 1), never a silent default.
/opt/hatch-image/bin/bun "$HOSTSRC/src/cli.ts" check --layering "$CORE/src" "$HOSTSRC/src" "$HOSTSRC/workflows" "$HOSTSRC/plugins" || exit 1

echo "--- swap test (reference vs mock vs host) ---"
/opt/hatch-image/bin/bun "$HOSTSRC/tests/swap-test-host.ts" "$REFDIR" "$MOCKDIR" "$HOSTDIR" || exit 1

echo "--- worker pool suite (BRA-48: subagent pool + muse adapter) ---"
WORKER_POOL_WORKDIR="$SCRATCH/worker-pool" /opt/hatch-image/bin/bun "$HOSTSRC/tests/run-worker-pool-suite.ts" || exit 1

echo "--- scheduling suite (BRA-49: admittance + dispatch) ---"
SCHEDULING_WORKDIR="$SCRATCH/scheduling" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-scheduling.ts" || exit 1

echo "--- tick driver suite (BRA-65/66: tick agent, long-poll get-job, watchdog) ---"
TICK_WORKDIR="$SCRATCH/tick-driver" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-tick-driver.ts" || exit 1

echo "--- stuck-worker suite (BRA-61: nudge, idempotency policy, cost-derived lease, journal surfacing) ---"
BRA61_WORKDIR="$SCRATCH/bra61" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra61.ts" || exit 1

echo "--- crash-recovery suite (BRA-75: journal check before re-dispatch, trapId enqueue dedupe, sleep remaining time) ---"
BRA75_WORKDIR="$SCRATCH/bra75" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra75.ts" || exit 1

echo "--- queue/driver integrity suite (BRA-72: stranded running repair, driver lock, concurrent-driver refusal) ---"
BRA72_WORKDIR="$SCRATCH/bra72" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra72.ts" || exit 1

echo "--- corrupt-state resilience suite (BRA-77: atomic queue writes, backup recovery, journal quarantine) ---"
BRA77_WORKDIR="$SCRATCH/bra77" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra77.ts" || exit 1

echo "--- run-integrity suite (BRA-71: frozen workflow copy, snapshot engine-version check) ---"
BRA71_WORKDIR="$SCRATCH/bra71" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra71.ts" || exit 1

echo "--- crash-resume suite (BRA-74: resume from last blob, durable sleep deadline, adapter timeout) ---"
BRA74_WORKDIR="$SCRATCH/bra74" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra74.ts" || exit 1

echo "--- smaller-robustness-gaps suite (BRA-76: atomic snapshot writes, corrupt worker-store recovery, explicit drive cap) ---"
BRA76_WORKDIR="$SCRATCH/bra76" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra76.ts" || exit 1

echo "--- fault-injection coverage suite (BRA-67: cron across restart, complete-job never lands, VM-replacement cold start, missing engine binary) ---"
BRA67_WORKDIR="$SCRATCH/bra67" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra67.ts" || exit 1

echo "--- journal-schema suite (BRA-73: trap site per call site + bundle pinned, run-start fields, trap-dispatch split, pool worker on trap-result) ---"
BRA73_WORKDIR="$SCRATCH/bra73" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra73.ts" || exit 1

echo "--- decision-cascade suite (BRA-47: Decision shape + decisionCascade, exec -> decide -> job -> gate, per-tier thresholds, full attempt history) ---"
BRA47_WORKDIR="$SCRATCH/bra47" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra47.ts" || exit 1

echo "--- workflow-library manifest suite (BRA-52: README inventory conformance — every entry exists, gates clean, every jobspec pairing served, admittance mapping) ---"
BRA52_WORKDIR="$SCRATCH/bra52" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra52.ts" || exit 1

echo "--- enqueue-race suite (BRA-82: concurrent submits all land, live lock blocks, stale lock breaks, mid-drive submits survive) ---"
BRA82_WORKDIR="$SCRATCH/bra82" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra82.ts" || exit 1

echo "--- atomic C snapshot writes suite (BRA-83: tmp+rename+fsync in save_snapshot and write_result_json) ---"
BRA83_WORKDIR="$SCRATCH/bra83" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra83.ts" || exit 1

echo "--- torn run-entry recovery suite (BRA-84: atomic run-entry writes + backup recovery, corrupt entry with no backup is loud and stays left-running) ---"
BRA84_WORKDIR="$SCRATCH/bra84" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra84.ts" || exit 1

echo "--- state-dir relocation suite (BRA-85: relative frozenPath + load-time rebase of registry snap/out/log + frozenPath, gate + exec, relative + legacy-absolute stored forms) ---"
BRA85_WORKDIR="$SCRATCH/bra85" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra85.ts" || exit 1

echo "--- verbatim-copy drift suite (BRA-88: sync check byte-identical incl. negative control, mock journals carry trap site, transitive imports extract identically under host and mock) ---"
BRA88_WORKDIR="$SCRATCH/bra88" AGENTTS_CORE_DIR="$CORE" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra88.ts" || exit 1

echo "--- trap-code pin suite (BRA-89: worker/jobspec/decision-model/adapter/exec-script hash pin + loud refusal on mid-run edit, pool jobspec snapshot) ---"
BRA89_WORKDIR="$SCRATCH/bra89" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra89.ts" || exit 1

echo "--- HOLD-identity suite (BRA-101: adapter HOLD is the host's HOLD under the scratch-copy path) ---"
/opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra101.ts" || exit 1

echo "--- durablets-dir suite (BRA-103: \$AGENTTS_DURABLETS_DIR export pins the C source under the scratch-copy path) ---"
/opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra103.ts" || exit 1

echo "--- generic-specialization suite (BRA-106: extractor specializes generic trap contracts per instantiation; JudgeFixLoop calls traps directly) ---"
BRA106_WORKDIR="$SCRATCH/bra106" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-bra106.ts" || exit 1

# BRA-93: benchmark regression alarms (bench/check.sh runs the suite
# itself; --no-ratchet keeps a suite run from recording history —
# use the plain form in CI so green runs count toward the ratchet).
# (|| exit 1 added: run.sh has no set -e, so a bare call would NOT
# fail the run on a breach — every other suite line carries it.)
./bench/check.sh --reps 3 || exit 1

echo
echo "PASS host end to end (reference suite green, mock suite green, host suite green, profiler green, checker green, layering import lint green, swap test green, worker pool green, scheduling green, tick driver green — incl. disconnect unregisters the waiter — bra61 stuck-worker green, bra75 crash-recovery green, bra72 queue/driver integrity green, bra77 corrupt-state resilience green, bra71 run-integrity green, bra74 crash-resume green, bra76 smaller-robustness-gaps green, bra67 fault-injection coverage green, bra73 journal-schema green, bra47 decision-cascade green, bra52 workflow-library manifest green, bra82 enqueue-race green, bra83 atomic C snapshot writes green, bra84 torn run-entry recovery green, bra85 state-dir relocation green, bra88 verbatim-copy drift green, and bra89 trap-code pin green, bra101 HOLD-identity green, bra103 durablets-dir green, and bra106 generic specialization green, benchmark regression alarms green)"
