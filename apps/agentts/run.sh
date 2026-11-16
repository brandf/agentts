#!/bin/sh
# AgentTS host executable v0 (Linear BRA-44) — build + full test run.
#   ./run.sh
# Builds the core C host into a scratch dir, runs the reference suite
# (core plugin/driver.ts), the mock suite, and the host suite into
# scratch dirs, then runs the swap test (same workflows under the
# reference plugin, the mock plugin, and the host must be
# byte-identical). All run outputs live in a mkdtemp scratch dir,
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

HOSTBIN="$SCRATCH/host-bin/durablets"
echo "building the core C host..."
make -C "$CORE" OUT_DIR="$SCRATCH/host-bin" durablets || exit 1
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

# When the host runs from a scratch copy, its plugin candidates (sibling
# plugins/ dir, working-dir-relative repo path) no longer resolve — point
# it at the real plugins dir. From the staged tree that is ./plugins;
# from the working dir the staged mock plugin is the one
# Host.loadPlugin resolves, so export it too when it exists.
if [ -d "$SCRIPT_DIR/plugins" ]; then
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

echo "--- swap test (reference vs mock vs host) ---"
/opt/hatch-image/bin/bun "$HOSTSRC/tests/swap-test-host.ts" "$REFDIR" "$MOCKDIR" "$HOSTDIR" || exit 1

echo "--- worker pool suite (BRA-48: subagent pool + muse adapter) ---"
WORKER_POOL_WORKDIR="$SCRATCH/worker-pool" /opt/hatch-image/bin/bun "$HOSTSRC/tests/run-worker-pool-suite.ts" || exit 1

echo "--- scheduling suite (BRA-49: admittance + dispatch) ---"
SCHEDULING_WORKDIR="$SCRATCH/scheduling" /opt/hatch-image/bin/bun "$HOSTSRC/tests/test-scheduling.ts" || exit 1

echo
echo "PASS host end to end (reference suite green, mock suite green, host suite green, profiler green, swap test green, worker pool green, scheduling green)"
