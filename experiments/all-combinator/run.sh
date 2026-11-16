#!/bin/sh
# combinator experiment (Linear BRA-24, BRA-25, BRA-26): collect-all
# plus the fail-fast bool on all(), plus any() and race().
#   ./run.sh
# Builds the host and drives the fork/direct test pairs through
# drive.py (mock steps, fork children from the journal, join, checks).
# Exits non-zero on any mismatch.
set -u
cd "$(dirname "$0")"
exec python3 drive.py
