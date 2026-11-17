#!/usr/bin/env bash
# Re-vendor dquickts at a pinned commit and prove the result.
#
#   ./re-vendor.sh <commit> [--swap] [--dest <path>]
#
# <commit> is a full or short upstream commit hash (never an unpinned
# HEAD). The script:
#   1. clones upstream and checks out <commit>,
#   2. applies the BRA-42 patch (git apply --check first; refuses to
#      proceed if it no longer applies cleanly),
#   3. copies the keep-list from experiments/dquickts-prototype/TRIM.md
#      into a candidate minimal tree (a missing keep-list file fails
#      loudly — the list must be updated, not silently skipped),
#   4. builds the candidate (make ... qjs libquickjs.a),
#   5. writes a VENDORED_FROM stamp into the candidate,
#   6. proves the candidate by running the full staged ./run.sh
#      against it (run.sh forwards $DQUICKTS to the durablets build),
#   7. installs the PROVEN candidate as the package's vendored engine
#      tree (default packages/durablets/vendor/dquickts — the
#      Makefile default, so plain `make` works after this), replacing
#      whatever was there. A candidate that fails the prove step is
#      never installed.
#
# With --swap it ALSO syncs the proven candidate to the VM-local
# production minimal tree (~/workspace/dquickts-build-minimal) and
# rebases the agentts-patched branch in the full checkout onto
# <commit> — Brandon's working-copy workflow. Both are skipped with
# a note when those trees do not exist (a clean checkout has neither).
# --dest <path> (or $DQUICKTS_DEST) overrides the install destination.
#
# Either way the pin in UPKEEP.md / TRIM.md and the BRA-31 record are
# updated by hand afterwards — the script prints exactly what to change.
#
# The work directory lives under this package dir (real disk): the
# engine build fails on the 512MB /tmp. It is removed on exit.
set -euo pipefail

UPSTREAM="https://github.com/stencil-hq/dquickts"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
PATCH="$REPO/packages/durablets/dquickts-bra42.patch"
TRIM="$REPO/experiments/dquickts-prototype/TRIM.md"
DEST="${DQUICKTS_DEST:-$REPO/packages/durablets/vendor/dquickts}"
# VM-local working copies (Brandon's machine only; --swap targets).
MINIMAL="$HOME/workspace/dquickts-build-minimal"
FULL="$HOME/workspace/dquickts-build"
RUN_SH="$REPO/apps/agentts/run.sh"

COMMIT="${1:-}"
if [ -z "$COMMIT" ]; then
  echo "usage: $0 <commit> [--swap] [--dest <path>]" >&2
  exit 2
fi
shift
SWAP=false
while [ $# -gt 0 ]; do
  case "$1" in
    --swap) SWAP=true; shift ;;
    --dest)
      [ -n "${2:-}" ] || { echo "usage: $0 <commit> [--swap] [--dest <path>]" >&2; exit 2; }
      DEST="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; echo "usage: $0 <commit> [--swap] [--dest <path>]" >&2; exit 2 ;;
  esac
done

[ -f "$PATCH" ] || { echo "patch not found: $PATCH" >&2; exit 1; }
[ -f "$TRIM" ] || { echo "trim recipe not found: $TRIM" >&2; exit 1; }

WORK="$(mktemp -d "$SCRIPT_DIR/.re-vendor-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
CLONE="$WORK/clone"
CANDIDATE="$WORK/minimal"

echo "== clone $UPSTREAM @ $COMMIT =="
git clone --quiet "$UPSTREAM" "$CLONE"
git -C "$CLONE" checkout --quiet "$COMMIT"
PIN="$(git -C "$CLONE" rev-parse HEAD)"
echo "checked out $PIN"

echo "== apply BRA-42 patch (with --check) =="
git -C "$CLONE" apply --check "$PATCH" || {
  echo "PATCH DOES NOT APPLY CLEANLY — rebase it by hand, save the new diff to $PATCH, and re-run. Refusing to proceed." >&2
  exit 1
}
git -C "$CLONE" apply "$PATCH"
echo "patch applied"

echo "== copy keep-list from TRIM.md =="
mkdir -p "$CANDIDATE"
sed -n '/<!-- keep-list-start -->/,/<!-- keep-list-end -->/p' "$TRIM" \
  | grep -v '<!--' | grep -v '^$' > "$WORK/keep-list.txt"
while IFS= read -r f || [ -n "$f" ]; do
  [ -f "$CLONE/$f" ] || {
    echo "KEEP-LIST FILE MISSING UPSTREAM: $f — update TRIM.md; refusing to proceed." >&2
    exit 1
  }
  mkdir -p "$CANDIDATE/$(dirname "$f")"
  cp "$CLONE/$f" "$CANDIDATE/$f"
done < "$WORK/keep-list.txt"
echo "copied $(wc -l < "$WORK/keep-list.txt") files"

echo "== build candidate =="
make -C "$CANDIDATE" CONFIG_PYTHON= CONFIG_PYTHON_CAPI= CONFIG_TEMPORAL_INTL= qjs libquickjs.a

echo "== write VENDORED_FROM stamp =="
cat > "$CANDIDATE/VENDORED_FROM" <<EOF
Upstream: $UPSTREAM
Pinned commit: $PIN
Patch: BRA-42 JS_AbandonSuspended (+30 lines, quickjs.c +21, quickjs.h +9) — applied
  Patch file: packages/durablets/dquickts-bra42.patch
  Upstream issue: https://github.com/stencil-hq/dquickts/issues/19
Trim recipe: experiments/dquickts-prototype/TRIM.md (keep-list)
Vendored: $(date +%F)
Built with: make CONFIG_PYTHON= CONFIG_PYTHON_CAPI= CONFIG_TEMPORAL_INTL= qjs libquickjs.a
EOF

echo "== prove: full staged suite against the candidate =="
DQUICKTS="$CANDIDATE" "$RUN_SH"
echo "PROVEN: candidate at $PIN passes the full suite."

echo "== install: proven candidate -> $DEST =="
mkdir -p "$DEST"
rsync -a --delete "$CANDIDATE/" "$DEST/"
[ -f "$DEST/libquickjs.a" ] || { echo "INSTALL FAILED: no libquickjs.a in $DEST" >&2; exit 1; }
echo "INSTALLED: $DEST (pinned commit $PIN)"

if [ -d "$MINIMAL" ]; then
  echo "== candidate vs current minimal tree (sources only, informational) =="
  diff -rq --exclude=.obj --exclude=libquickjs.a --exclude=qjs --exclude=qjsc \
    --exclude=repl.c --exclude=VENDORED_FROM "$MINIMAL" "$CANDIDATE" | head -20 || true
fi

if [ "$SWAP" = true ]; then
  if [ -d "$MINIMAL" ]; then
    echo "== swap: sync the VM-local production minimal tree =="
    rsync -a --delete "$CANDIDATE/" "$MINIMAL/"
  else
    echo "== swap: no VM-local minimal tree at $MINIMAL — skipping that sync =="
  fi
  if [ -d "$FULL/.git" ]; then
    echo "== swap: rebase the patch branch onto $PIN =="
    git -C "$FULL" fetch --quiet origin
    git -C "$FULL" checkout --quiet agentts-patched
    git -C "$FULL" rebase --quiet "$PIN" || {
      echo "REBASE CONFLICT — resolve it in $FULL, then re-run the prove step. The minimal tree is already swapped; do not leave it half-proven." >&2
      exit 1
    }
    echo "SWAPPED to $PIN."
  else
    echo "== swap: no full checkout at $FULL — skipping the rebase =="
  fi
fi

echo "Next (by hand): update the pin in packages/durablets/UPKEEP.md (and in TRIM.md if the recipe changed), and record the re-vendor (commit, date, reason) on BRA-31."
echo "Build the core with: make -C packages/durablets durablets   (uses $DEST by default)"
