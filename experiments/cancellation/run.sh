#!/bin/sh
# cancellation prototype (Linear BRA-27, plan doc section 8 prototype 3,
# design Q14): cancel a pending step, cancel a whole combinator, sticky
# cancellation, the cancel-versus-complete race (both orders), nested
# (recursive) propagation.
#   ./run.sh
# Builds the host and drives the five scripted scenarios through
# drive.py (mock steps, cancellations via host cancel, journal checks).
# Exits non-zero on any mismatch.
set -u
cd "$(dirname "$0")"
exec python3 drive.py
