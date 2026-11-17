#!/bin/sh
# Bench alarm check (BRA-93): run the benchmark suite and fail loudly
# on any metric that breaches its recorded threshold.
#   bench/check.sh [--reps N] [--no-ratchet] [--results FILE]
#   bench/check.sh loosen <metric> <newBaseline> --reason "..."
# Exit 0: all green. Exit 1: any breach / missing metric / suite failure.
# See bench/README.md for the threshold + ratchet rules.
set -u
cd "$(dirname "$0")/.."
exec /opt/hatch-image/bin/bun bench/check.ts "$@"
