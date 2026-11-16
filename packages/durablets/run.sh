#!/bin/sh
# DurableTS core library (Linear BRA-43) — build + test.
#   ./run.sh [OUT_DIR=...]
# Builds the thin C host against the patched minimal dquickts tree, then
# runs the TypeScript reference plugin driver (plugin/driver.ts) under
# Bun: trap dispatch x6, all/any/race + fail-fast + nested + global
# state, cancellation x5, blob round-trip, run registry, BRA-41 error
# rehydration, no-journal-by-core, the agentts Bun.build bundle test,
# the agentts module combinator variants, the trap-boundary JSON rule
# (module side) + the direct-trap arg-in JSON rule (core side).
# Exits non-zero on any mismatch.
#
# Run-output hygiene: build outputs (the durablets binary) and test
# outputs (logs/snapshots/journals/blobs) go to a scratch dir, never
# into the package tree. OUT_DIR defaults to a fresh mktemp dir (kept
# after the run for inspection; the driver prints its workdir) — set
# OUT_DIR explicitly to reuse a directory. The staged tree stays
# sources-only.
set -u
cd "$(dirname "$0")"
if [ -z "${OUT_DIR:-}" ]; then
  OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/durablets-out.XXXXXX")"
fi
export OUT_DIR
echo "DurableTS out dir: $OUT_DIR"
make OUT_DIR="$OUT_DIR" durablets || exit 1
DURABLETS_HOST="$OUT_DIR/durablets" DURABLETS_WORKDIR="$OUT_DIR/test-runs" exec bun plugin/driver.ts
