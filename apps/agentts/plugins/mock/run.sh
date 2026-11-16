#!/bin/sh
# Mock host plugin (Linear BRA-45) — build + full test run.
#   ./run.sh
# Builds the core C host if needed, runs the reference suite into a
# scratch dir, runs the mock suite into a scratch dir, then runs the
# swap test (byte-identical outputs under both plugins). All run
# outputs live in a mkdtemp scratch dir, never in the staged tree;
# the scratch dir is deleted on success and kept (path printed) on
# failure. Exits non-zero on any mismatch.
set -u
cd "$(dirname "$0")"
SCRIPT_DIR=$(pwd)

if [ -d "$SCRIPT_DIR/../agentts-repo/packages/durablets" ]; then
  CORE="$SCRIPT_DIR/../agentts-repo/packages/durablets"
elif [ -d "$SCRIPT_DIR/../../../../packages/durablets" ]; then
  CORE="$SCRIPT_DIR/../../../../packages/durablets"
else
  echo "cannot locate the durablets core package from $SCRIPT_DIR" >&2
  exit 1
fi

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/bra45.XXXXXX")
REFDIR="$SCRATCH/ref"
MOCKDIR="$SCRATCH/mock"
mkdir -p "$REFDIR" "$MOCKDIR"
echo "scratch: $SCRATCH"

# Build the core C host into scratch and point both suites at it.
# The Makefile puts build outputs in OUT_DIR (default ./out/); the
# driver resolves the host from $DURABLETS_HOST, else the legacy
# in-tree ./durablets binary — which the Makefile's clean target
# removes and which must not be recreated (the core's own run.sh
# likewise builds into a scratch OUT_DIR). The mock plugin resolves
# the host the same way ($DURABLETS_HOST first).
HOSTBIN="$SCRATCH/host/durablets"
echo "building the core C host..."
make -C "$CORE" OUT_DIR="$SCRATCH/host" durablets || exit 1
export DURABLETS_HOST="$HOSTBIN"

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
DURABLETS_WORKDIR="$REFDIR" bun "$CORE/plugin/driver.ts" > "$SCRATCH/ref.log" 2>&1 || {
  tail -40 "$SCRATCH/ref.log"
  echo "reference suite FAILED" >&2
  exit 1
}
tail -3 "$SCRATCH/ref.log"

echo "--- mock suite ---"
MOCK_WORKDIR="$MOCKDIR" bun tests/run-mock-suite.ts || exit 1

echo "--- swap test ---"
bun tests/swap-test.ts "$REFDIR" "$MOCKDIR" || exit 1

echo
echo "PASS mock-plugin end to end (reference suite green, mock suite green, swap test green)"
