#!/bin/sh
# AgentTS host executable v0 (Linear BRA-44) — build + tiered test run.
#
# TIERS (BRA-137 P0; Brandon's design, Nov 19). A 30-min suite on
# every change is a terrible design, so this script runs in tiers:
#
#   ./run.sh              Tier 1 (DEFAULT): the quick tier, <3-5 min.
#                         Targeted tests for what changed (see the
#                         table below) + a sampled quick tier: the
#                         fast unit tests, the most important
#                         integration test across all features, and a
#                         small subset of e2e. This is what every
#                         change runs. A tier-1 PASS is NOT a full
#                         PASS — the final line says so.
#   ./run.sh --tier 2     Tier 2 (opt-in): broader integration + more
#                         e2e. For complex/risky changes. Everything
#                         except the bench alarms.
#   ./run.sh --tier 3     Tier 3 / full: everything, incl. bench
#   ./run.sh --full       alarms. Before a release or ~once a day,
#                         NOT on every change.
#   ./run.sh --only a,b   Run exactly sections a,b (forcing re-run),
#                         plus the gate + host build. Targets the
#                         unproven tail after a kill, or one area.
#   ./run.sh --bash       Force the bash section loop (escape hatch
#                         when the engine is down; the default is the
#                         workflow driver, BRA-164).
#   ./run.sh --workflow   Force the workflow driver (the default).
#   ./run.sh --list       List sections with tiers + measured times.
#   ./run.sh --help       This help.
#
# TARGETED TESTS — what to run for what you changed (before tier 1,
# or with --only). Obvious from the change; no guessing:
#   fix for issue BRA-NNN        tests/test-braNNN.ts, then tier 1
#   workflows/library/<x>.ts     its test (improve-loop / bra117 /
#                                bra126 / rubric-review), then tier 1
#   src/host.ts, cli.ts,         tier 1 + the issue test (tier 1's
#   src/adapter.ts               sampled integration is the coverage)
#   src/checker.ts, extract.ts,  tier 1 + test-checker.ts (the gate)
#   src/gate.ts
#   workflows/README.md,         test-bra52.ts (manifest, 84 s — slow
#   workflows/library/           and narrow, so targeted, not tier 1)
#   worker/jobspec/decision-     test-bra89.ts (trap-code pin, 58 s —
#   model/adapter/exec-script    targeted, not tier 1)
#   packages/durablets/src/      tier 2 — an engine change is risky
#   durablets.c                  by definition, NOT a 10-15 min fix
#   run.sh, bench/               tier 2 + one full pass
#   new workflow file            its new test + tier 1
#
# END-TO-END BUDGET (Brandon, Nov 19): most minor bug fixes should
# land in main in 10-15 min from pickup — implement (~5 min) +
# targeted test (~1 min) + tier 1 (228 s wall measured Nov 19 —
# 221 s of sections + setup; the mock suite alone is 65 s, see
# below) + Meroki re-run (~1 min) + close + push (~2-3 min
# mechanical). That totals ~12.8-13.8 min: it fits with ~1.5-2 min
# of slack. The mock suite
# is the cost: it is the integration anchor (284 checks across every
# trap type + the first-run gate pipeline), so it stays in tier 1 by
# design; the 3-min tier-1 target is not reachable with it included.
# (A contended run took 128 s for the mock suite alone — the shared
# 1.5 CPUs punish parallel suite runs; do not run two suites at once.)
# What else breaks the budget:
# engine changes (tier 2 by design), slow issue tests that wait real
# time (bra67's cron wait, bra83's big sleep), and the GitHub
# approval card for the push (human-gated — landing waits on the
# card, not on the harness).
#
# RESUME (BRA-137). Long runs get SIGTERM-killed by runtime VM
# replacement (~117-min cycle; a 30-min run has ~26% kill odds), so
# a run must survive being killed: each section writes a marker on
# success and progress appends to JSONL, so re-invoking ./run.sh
# skips completed sections automatically. The default resume dir is
# keyed by a fingerprint of the tree; --resume-dir <dir> reuses an
# explicit dir but REFUSES to resume if the tree changed (resuming
# across a tree change would mix results from two trees, and
# unexplained concurrent modification (BRA-136) is live). Every
# attempt leaves an exit code (143 = SIGTERM, 137 = SIGKILL) + boot
# ID in the resume dir's progress.jsonl — the evidence killed runs
# never left before. Per-attempt logs use timestamped paths, never
# one path per run: braXXX-<tier>-attemptN-YYYYMMDD-HHMM.log.
#
# WORKFLOW DRIVER (BRA-164, DEFAULT). The suite runs through the
# run-tests workflow (workflows/library/run-tests.ts), not the bash
# section loop below: the engine owns the loop, retry, report, and
# resume; run.sh keeps only the leaf (`run.sh --bash --only <slug>`
# per section). The driver splits the tier into chunks of at most 32
# sections per workflow run (the drive cap is 50 suspensions; worst
# case per chunk is 32 sections + 10 retries + 1 inventory read =
# 43 rounds). One shared resume dir per tier for the leaf calls
# (ref/mock/host write workdirs under it and swap reads them).
# Deterministic runIds (run-tests-t<T>-c<i>) so a re-invocation
# re-drives a suspended run instead of submitting a fresh one. A
# section is retried only when it did not execute (no verdict in its
# output); a section whose tests ran and failed is recorded failed,
# never retried; a section passing only after retry is flagged
# FLAKY in the summary — file it, a flaky test is a real defect.
# Unlike the bash loop the driver runs ALL sections then reports
# (no fail-fast). The inventory lives in suite-inventory.json (one
# source for slug/tier/estimate/label); run.sh validates it against
# its section definitions at startup and fails loudly on drift.
# --bash is the escape hatch when the engine itself is down.
#
# Staging hygiene: this script never writes into the tree it runs
# from. If a package's node_modules is missing, the package is copied
# to scratch (source files only) and deps are installed there; the
# plugin dir is then pointed at with $AGENTTS_PLUGINS_DIR so
# Host.loadPlugin still finds the mock plugin engine. The C host
# build is cached under the resume base (keyed by durablets.c hash +
# dquickts pin), so a warm run pays no build.
set -u
cd "$(dirname "$0")"
SCRIPT_DIR=$(pwd)
BUN=/opt/hatch-image/bin/bun

# --- argument parsing ---
TIER=1
WORKFLOW=1
ONLY=""
RESUME_DIR_ARG=""
LIST_ONLY=0
SHOW_HELP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tier) TIER="$2"; shift 2 ;;
    --tier=*) TIER="${1#--tier=}"; shift ;;
    --full) TIER=3; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    --only=*) ONLY="${1#--only=}"; shift ;;
    --resume-dir) RESUME_DIR_ARG="$2"; shift 2 ;;
    --resume-dir=*) RESUME_DIR_ARG="${1#--resume-dir=}"; shift ;;
    --bash) WORKFLOW=0; shift ;;
    --workflow) WORKFLOW=1; shift ;;
    --list) LIST_ONLY=1; shift ;;
    --help|-h) SHOW_HELP=1; shift ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
case "$TIER" in
  1|2|3) ;;
  *) echo "--tier must be 1, 2, or 3 (got $TIER)" >&2; exit 2 ;;
esac

# --- tree fingerprint (BRA-137: resume guard) ---
# sha256 over the files that can change test outcomes, plus the
# dquickts setting and the bun version. Fast (<1 s for ~600 files).
# A doc-only change does not alter it (docs are excluded), so a doc
# edit does not invalidate a resume.
fingerprint_tree() {
  {
    find "$SCRIPT_DIR/src" "$SCRIPT_DIR/workflows" "$SCRIPT_DIR/tests" "$SCRIPT_DIR/plugins" "$SCRIPT_DIR/scripts" "$SCRIPT_DIR/bench" "$SCRIPT_DIR/run.sh" "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/bun.lock" "$SCRIPT_DIR/tsconfig.json" -type f -print0 2>/dev/null | sort -z | xargs -0 -r sha256sum
    echo "DQUICKTS=${DQUICKTS:-default}"
    "$BUN" --version
  } | sha256sum | cut -c1-16
}

# --- resume dir ---
# Computed once here and reused below (the fingerprint is the resume
# key AND the guard value; computing it twice would cost ~1 s each).
FP=$(fingerprint_tree)
RESUME_BASE="${AGENTTS_RUN_RESUME_BASE:-$HOME/workspace/tmp/agentts-run-resume}"
if [ -n "$RESUME_DIR_ARG" ]; then
  RESUME_DIR="$RESUME_DIR_ARG"
  if [ -f "$RESUME_DIR/fingerprint" ]; then
    STORED_FP=$(cat "$RESUME_DIR/fingerprint")
    if [ "$STORED_FP" != "$FP" ]; then
      echo "refusing to resume in $RESUME_DIR: tree fingerprint changed ($STORED_FP -> $FP) — resuming would mix results from two trees; use a fresh resume dir" >&2
      exit 1
    fi
  fi
else
  RESUME_DIR="$RESUME_BASE/$FP"
fi
mkdir -p "$RESUME_DIR/logs" "$RESUME_DIR/.done"
if [ ! -f "$RESUME_DIR/fingerprint" ]; then
  printf '%s\n' "$FP" > "$RESUME_DIR/fingerprint"
fi
# Boot identity for the per-attempt record: kernel boot_id (changes
# on VM replacement) + PID 1 start epoch.
BOOT_ID=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
PROC1_START=$(stat -c %Y /proc/1 2>/dev/null || echo unknown)
TS_NOW() { date -u +%Y-%m-%dT%H:%M:%SZ; }
jsonl() { printf '%s\n' "$1" >> "$RESUME_DIR/progress.jsonl"; }

# --- section inventory (slug, tier, measured time) ---
# Times are wall-clock seconds from the Nov 19 timing run
# (~/workspace/tmp/tier-measure/timings.tsv); "—" = not timed
# individually (tier 2 by construction). Tier 1 must total ≤180 s
# warm; see the tier-1 budget check at the end of --list.
list_sections() {
  "$BUN" "$SCRIPT_DIR/scripts/suite-inventory.ts" list
}
if [ "$SHOW_HELP" -eq 1 ]; then
  sed -n '2,/^set -u/p' "$0" | sed -e '$d' -e 's/^# \?//'
  exit 0
fi
if [ "$LIST_ONLY" -eq 1 ]; then
  printf '%-14s %-4s %-4s %s\n' SECTION TIER SECS LABEL
  list_sections
  echo
  echo "tier-1 timed total (numeric entries only): $(list_sections | awk '$2==1 && $3 ~ /^[0-9]+$/ {s+=$3} END {print s+0}')s — TBD entries not yet timed"
  exit 0
fi

# --- inventory check (BRA-164) ---
# suite-inventory.json is the single source for slug/tier/estimate/
# label; run.sh's section definitions must agree with it. Fail loud
# on drift — a section in one and not the other means the two drivers
# would run different suites. (Labels are not compared: the JSON
# carries the short label for --list, the section call the long label
# for the section header.)
"$BUN" "$SCRIPT_DIR/scripts/suite-inventory.ts" check || exit 1

# --only validation (BRA-164): a typo'd --only slug used to silently
# run 0 sections and PASS (every section call skipped as
# tier/selection). Validate up front so the failure is loud — the
# workflow driver also depends on it: an unknown slug must fail
# with no verdict, not pass with 0 OK.
if [ -n "$ONLY" ]; then
  "$BUN" "$SCRIPT_DIR/scripts/suite-inventory.ts" sections --only "$ONLY" >/dev/null || exit 1
fi

# --- counters (for the final summary) ---
RAN=0
SKIPPED_RESUME=0
SKIPPED_TIER=0
TOTAL_OK=0
RUN_START=$(date +%s)
RAN_SLUGS=""
SCRATCH=""

# --- section runner ---
# section <slug> <tier> <label> <cmd...>
# Skips (tier filter / resume marker), runs with output teed to the
# resume-dir log AND stdout, records a marker + JSONL on success,
# prints the tail and exits 1 on failure. Exit code is captured via
# a rc file because POSIX sh has no PIPESTATUS.
section() {
  slug=$1; stier=$2; label=$3; shift 3
  # --only: run exactly the named sections, forcing re-run.
  if [ -n "$ONLY" ]; then
    case ",$ONLY," in
      *",$slug,"*) ;;
      *) SKIPPED_TIER=$((SKIPPED_TIER+1)); return 0 ;;
    esac
  elif [ "$stier" -gt "$TIER" ]; then
    SKIPPED_TIER=$((SKIPPED_TIER+1))
    return 0
  fi
  LOG="$RESUME_DIR/logs/$slug.log"
  MARK="$RESUME_DIR/.done/$slug"
  if [ -z "$ONLY" ] && [ -f "$MARK" ]; then
    oks=$(sed -n 's/^ok=//p' "$MARK" | head -1)
    echo "--- $label ---"
    echo "SKIP $slug (done, ${oks:-?} OK)"
    SKIPPED_RESUME=$((SKIPPED_RESUME+1))
    jsonl "{\"event\":\"skip\",\"section\":\"$slug\",\"ok\":${oks:-0},\"ts\":\"$(TS_NOW)\"}"
    return 0
  fi
  echo "--- $label ---"
  sec_start=$(date +%s)
  # ref/mock/host feed the swap test, so their workdirs live in the
  # resume dir (not scratch) and are wiped on re-run: a skipped
  # section reuses its outputs, a re-run gets fresh state.
  case "$slug" in
    ref) rm -rf "$REFDIR"; mkdir -p "$REFDIR" ;;
    mock) rm -rf "$MOCKDIR"; mkdir -p "$MOCKDIR" ;;
    host) rm -rf "$HOSTDIR"; mkdir -p "$HOSTDIR" ;;
  esac
  RCFILE="$SCRATCH/.rc-$slug"
  rm -f "$RCFILE"
  # The command runs in a subshell whose stdout+stderr feed tee;
  # the subshell records the command's exit code to $RCFILE.
  { "$@" 2>&1; echo $? >"$RCFILE"; } | tee "$LOG"
  rc=$(cat "$RCFILE" 2>/dev/null || echo 1)
  sec_end=$(date +%s)
  elapsed=$((sec_end-sec_start))
  if [ "$rc" -ne 0 ]; then
    echo "section $slug FAILED (rc=$rc, ${elapsed}s) — last 40 lines:" >&2
    tail -40 "$LOG" >&2
    exit 1
  fi
  # OK lines use the established marker " OK:" (the same pattern the
  # BRA-119 verification grepped for the 2702 baseline).
  oks=$(grep -c ' OK:' "$LOG" || true)
  TOTAL_OK=$((TOTAL_OK+oks))
  RAN=$((RAN+1))
  RAN_SLUGS="$RAN_SLUGS $slug"
  printf 'ok=%s\nelapsed_s=%s\nts=%s\n' "$oks" "$elapsed" "$(TS_NOW)" > "$MARK"
  jsonl "{\"event\":\"section\",\"section\":\"$slug\",\"ok\":$oks,\"elapsed_s\":$elapsed,\"rc\":0,\"ts\":\"$(TS_NOW)\"}"
}

# --- per-attempt record (BRA-137: killed runs must leave evidence) ---
# The EXIT trap records the run's exit code + boot ID; the TERM/INT
# traps record a kill (rc 143/130) before exiting, because a shell
# killed by a signal never runs its EXIT trap. A flag prevents a
# double record when the TERM handler exits through the EXIT trap.
RECORDED=0
record_attempt() {
  if [ "$RECORDED" -eq 1 ]; then return 0; fi
  RECORDED=1
  jsonl "{\"event\":\"run-end\",\"rc\":$1,\"boot\":\"$BOOT_ID\",\"proc1\":$PROC1_START,\"tier\":$TIER,\"ts\":\"$(TS_NOW)\"}"
}
cleanup() {
  rc=$?
  record_attempt "$rc"
  if [ $rc -eq 0 ]; then
    [ -n "$SCRATCH" ] && rm -rf "$SCRATCH"
  else
    echo "scratch kept for inspection: $SCRATCH" >&2
  fi
  exit $rc
}
on_kill() {
  sig_rc=$1
  echo "run.sh killed (signal, rc=$sig_rc) — partial progress is in $RESUME_DIR (re-invoke ./run.sh to resume)" >&2
  record_attempt "$sig_rc"
  exit "$sig_rc"
}
trap cleanup EXIT
trap 'on_kill 143' TERM
trap 'on_kill 130' INT

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
# ref/mock/host workdirs live in the resume dir (not scratch): the
# swap test compares their outputs, so a resumed run must find them
# where the killed run left them. The section runner wipes each on
# re-run, so a re-run gets fresh state and a skip reuses outputs.
REFDIR="$RESUME_DIR/work/ref"
MOCKDIR="$RESUME_DIR/work/mock"
HOSTDIR="$RESUME_DIR/work/host"
mkdir -p "$REFDIR" "$MOCKDIR" "$HOSTDIR"
echo "scratch: $SCRATCH"
echo "resume dir: $RESUME_DIR (tier $TIER)"
if [ -n "$ONLY" ]; then echo "only: $ONLY (forcing re-run)"; fi

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

# --- C host build (cached; BRA-137) ---
# Keyed by sha256(durablets.c) + the dquickts setting, under the
# resume base (NOT the per-fingerprint resume dir, so a doc-only
# tree change does not invalidate the build). The build is ~1.5 s,
# so the cache is about never paying it twice, not about speed.
HOST_KEY="$(sha256sum "$CORE/src/durablets.c" | cut -c1-16)-$(printf '%s' "${DQUICKTS:-default}" | sha256sum | cut -c1-8)"
HOST_CACHE="$RESUME_BASE/host-cache/$HOST_KEY"
if [ -x "$HOST_CACHE/durablets" ] && [ -f "$HOST_CACHE/key" ] && [ "$(cat "$HOST_CACHE/key")" = "$HOST_KEY" ]; then
  echo "using cached C host ($HOST_KEY)"
else
  echo "building the core C host..."
  mkdir -p "$HOST_CACHE"
  # DQUICKTS may be set by re-vendor.sh to prove a candidate engine tree;
  # unset means the production minimal tree (the Makefile default).
  make -C "$CORE" ${DQUICKTS:+DQUICKTS="$DQUICKTS"} OUT_DIR="$HOST_CACHE" durablets || exit 1
  printf '%s\n' "$HOST_KEY" > "$HOST_CACHE/key"
fi
export DURABLETS_HOST="$HOST_CACHE/durablets"

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
  (cd "$HOSTSRC" && "$BUN" install) || exit 1
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
  (cd "$MOCKSRC" && "$BUN" install) || exit 1
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

# --- workflow driver (BRA-164) ---
# Runs the tier through the run-tests workflow (workflows/library/
# run-tests.ts) instead of the bash section loop below. The engine
# owns the loop, retry, report, and resume; run.sh keeps only the
# leaf (`run.sh --bash --only <slug>` per section). Chunks of at most
# CHUNK_SIZE sections per workflow run (drive cap is 50 suspensions;
# worst case per chunk is 32 sections + 10 retries + 1 inventory
# read = 43 rounds). One shared resume dir per tier for the leaf
# calls. Deterministic runIds (run-tests-t<T>-c<i>) so a re-invocation
# re-drives a suspended run instead of submitting a fresh one.
# AGENTTS_WORKER_SERVER points at a dead port so submit/completion
# events never reach the production worker server (BRA-133;
# notifyEvent is fire-and-forget and swallows the failure). Prints
# the same PASS summary shape as the bash loop and returns 0 iff
# every section passed. Unlike the bash loop it runs ALL sections
# then reports (no fail-fast); a section passing only after retry is
# flagged FLAKY in the summary — file it.
CHUNK_SIZE=32
run_workflow_driver() {
  export AGENTTS_WORKER_SERVER="http://127.0.0.1:9"
  WF_BASE="$RESUME_DIR/workflow/tier$TIER"
  WF_RESUME="$WF_BASE/resume"
  REPO_ROOT=$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd || echo "$SCRIPT_DIR")
  mkdir -p "$WF_BASE"
  if [ -n "$ONLY" ]; then
    SECTIONS_JSON=$("$BUN" "$SCRIPT_DIR/scripts/suite-inventory.ts" sections --only "$ONLY") || return 1
  else
    SECTIONS_JSON=$("$BUN" "$SCRIPT_DIR/scripts/suite-inventory.ts" sections --tier "$TIER") || return 1
  fi
  # Split the sections into chunk files (sections-<i>.json); prints
  # "<chunk count> <section count>".
  SPLIT_OUT=$(printf '%s' "$SECTIONS_JSON" | WF_BASE="$WF_BASE" CHUNK_SIZE="$CHUNK_SIZE" "$BUN" -e '
    const raw = await new Response(Bun.stdin.stream()).text();
    const arr = JSON.parse(raw);
    const n = Number(Bun.env.CHUNK_SIZE ?? "32");
    const base = Bun.env.WF_BASE;
    let count = 0;
    for (let i = 0; i < arr.length; i += n) {
      await Bun.write(base + "/sections-" + count + ".json", JSON.stringify(arr.slice(i, i + n)));
      count++;
    }
    console.log(count + " " + arr.length);
  ') || return 1
  CHUNK_COUNT=${SPLIT_OUT%% *}
  TIER_SECTIONS=${SPLIT_OUT##* }
  TOTAL_SECTIONS=$(list_sections | wc -l)
  SKIPPED_TIER=$((TOTAL_SECTIONS - TIER_SECTIONS))
  RAN_THIS_TIME=0
  REUSED_SECTIONS=0
  i=0
  while [ "$i" -lt "$CHUNK_COUNT" ]; do
    CHUNK_DIR="$WF_BASE/chunk-$i"
    STATE_DIR="$CHUNK_DIR/state"
    RUNID="run-tests-t${TIER}-c${i}"
    REPORT="$CHUNK_DIR/report.json"
    INPUT="$CHUNK_DIR/input.json"
    mkdir -p "$CHUNK_DIR"
    # Section count of this chunk (from its sections file).
    CHUNK_SECTIONS=$(SECTIONS_FILE="$WF_BASE/sections-$i.json" "$BUN" -e 'const a = JSON.parse(await Bun.file(Bun.env.SECTIONS_FILE).text()); console.log(a.length);') || return 1
    if [ -f "$REPORT" ]; then
      # Chunk already driven by an earlier invocation; reuse its report.
      REUSED_SECTIONS=$((REUSED_SECTIONS + CHUNK_SECTIONS))
    else
      # Build the workflow input for this chunk.
      CHUNK_FILE="$WF_BASE/sections-$i.json" TIER="$TIER" REPO_ROOT="$REPO_ROOT" RUN_SH="$SCRIPT_DIR/run.sh" WF_RESUME="$WF_RESUME" CHUNK_INDEX="$i" CHUNK_COUNT="$CHUNK_COUNT" "$BUN" -e '
        const chunk = JSON.parse(await Bun.file(Bun.env.CHUNK_FILE).text());
        console.log(JSON.stringify({ tier: Number(Bun.env.TIER), sections: chunk, repoRoot: Bun.env.REPO_ROOT, runSh: Bun.env.RUN_SH, resumeDir: Bun.env.WF_RESUME, chunkIndex: Number(Bun.env.CHUNK_INDEX), chunkCount: Number(Bun.env.CHUNK_COUNT) }));
      ' > "$INPUT" || return 1
      if [ ! -f "$STATE_DIR/runs/$RUNID.json" ]; then
        "$BUN" "$HOSTSRC/src/cli.ts" run "$HOSTSRC/workflows/library/run-tests.ts" \
          --run-id "$RUNID" --input-file "$INPUT" \
          --state-dir "$STATE_DIR" --adapter direct --clock real --gates hold \
          || return 1
      fi
      "$BUN" "$HOSTSRC/src/cli.ts" queue run --state-dir "$STATE_DIR" --gates hold || return 1
      "$BUN" "$HOSTSRC/src/cli.ts" result "$RUNID" --state-dir "$STATE_DIR" > "$REPORT" || return 1
      RAN_THIS_TIME=$((RAN_THIS_TIME + CHUNK_SECTIONS))
    fi
    i=$((i+1))
  done
  # Combine the chunk reports and print the summary; the combiner
  # exits 1 iff any section failed (the summary still prints first).
  WF_BASE="$WF_BASE" CHUNK_COUNT="$CHUNK_COUNT" TIER="$TIER" ONLY="$ONLY" \
    RAN_THIS_TIME="$RAN_THIS_TIME" REUSED_SECTIONS="$REUSED_SECTIONS" \
    SKIPPED_TIER="$SKIPPED_TIER" RUN_START_S="$RUN_START" RESUME_DIR="$RESUME_DIR" \
    "$BUN" -e '
    const base = Bun.env.WF_BASE;
    const n = Number(Bun.env.CHUNK_COUNT);
    let ran = 0, passed = 0, failed = 0, totalOk = 0;
    const flaky = [];
    const failedSlugs = [];
    for (let i = 0; i < n; i++) {
      const r = JSON.parse(await Bun.file(base + "/chunk-" + i + "/report.json").text());
      ran += r.ran; passed += r.passed; failed += r.failed; totalOk += r.totalOk;
      flaky.push(...r.flaky); failedSlugs.push(...r.failedSlugs);
    }
    const summary = { tier: Number(Bun.env.TIER), ran, passed, failed, totalOk, flaky, failedSlugs };
    await Bun.write(base + "/report-tier" + Bun.env.TIER + ".json", JSON.stringify(summary, null, 2));
    const tier = Number(Bun.env.TIER);
    const tierName = (tier === 1 ? "tier 1 (quick)" : tier === 2 ? "tier 2 (broad)" : "tier 3 (full)") + (Bun.env.ONLY ? " --only " + Bun.env.ONLY : "");
    const elapsed = Math.round(Date.now() / 1000 - Number(Bun.env.RUN_START_S));
    console.log("");
    console.log("PASS " + tierName + " — " + Bun.env.RAN_THIS_TIME + " sections ran, " + totalOk + " OK, " + elapsed + "s; skipped " + Bun.env.REUSED_SECTIONS + " via resume, " + Bun.env.SKIPPED_TIER + " by tier/selection");
    if (flaky.length > 0) console.log("FLAKY: " + flaky.join(", ") + " passed only after a retry — file each as a real defect (a flaky test is worse than no test)");
    if (failed > 0) { console.log("FAILED: " + failedSlugs.join(", ")); process.exit(1); }
    if (tier < 3 && !Bun.env.ONLY) console.log("NOTE: tier " + tier + " is not the full suite — run \x27./run.sh --tier 2\x27 for broad coverage, \x27./run.sh --full\x27 before a release or ~once a day");
    console.log("resume dir: " + Bun.env.RESUME_DIR + " (workflow/tier" + tier + "/ + progress.jsonl + logs/ + .done/)");
  '
}

# --- driver selection (BRA-164) ---
# Default is the workflow driver; --bash forces the bash loop (the
# escape hatch for engine-down debugging).
if [ "$WORKFLOW" -eq 1 ]; then
  run_workflow_driver
  exit $?
fi

# --- sections ---
# Tier assignments: 1 = quick tier (default), 2 = opt-in broad tier,
# 3 = full only. Times in list_sections() are measured Nov 19; "TBD"
# marks a tier-1 assignment whose timing had not landed when this
# file was written — confirm against timings.tsv before trusting it.
section ref 2 "reference suite (core plugin/driver.ts)" \
  env DURABLETS_WORKDIR="$REFDIR" "$BUN" "$CORE/plugin/driver.ts"
section mock 1 "mock suite" \
  env MOCK_WORKDIR="$MOCKDIR" "$BUN" "$MOCKSRC/tests/run-mock-suite.ts"
section host 2 "host suite" \
  env HOST_WORKDIR="$HOSTDIR" "$BUN" "$HOSTSRC/tests/run-host-suite.ts"
section improve 2 "improve-loop tests (standard library workflow)" \
  env IMPROVE_WORKDIR="$SCRATCH/improve-loop" "$BUN" "$HOSTSRC/tests/test-improve-loop.ts"
section profiler 1 "profiler tests (BRA-30)" \
  "$BUN" "$HOSTSRC/tests/test-profiler.ts" "$HOSTSRC/tests/fixtures/profiler" "$SCRATCH/profiler-out"
section checker 1 "checker tests (BRA-29)" \
  env AGENTTS_CORE_DIR="$CORE" "$BUN" "$HOSTSRC/tests/test-checker.ts" "$HOSTSRC"
section layering 1 "layering import lint (BRA-68: core + host never import Muse-specific APIs)" \
  "$BUN" "$HOSTSRC/src/cli.ts" check --layering "$CORE/src" "$HOSTSRC/src" "$HOSTSRC/workflows" "$HOSTSRC/plugins"
section swap 2 "swap test (reference vs mock vs host)" \
  "$BUN" "$HOSTSRC/tests/swap-test-host.ts" "$REFDIR" "$MOCKDIR" "$HOSTDIR"
section workerpool 2 "worker pool suite (BRA-48: subagent pool + muse adapter)" \
  env WORKER_POOL_WORKDIR="$SCRATCH/worker-pool" "$BUN" "$HOSTSRC/tests/run-worker-pool-suite.ts"
section scheduling 2 "scheduling suite (BRA-49: admittance + dispatch)" \
  env SCHEDULING_WORKDIR="$SCRATCH/scheduling" "$BUN" "$HOSTSRC/tests/test-scheduling.ts"
section tick 2 "tick driver suite (BRA-65/66: tick agent, long-poll get-job, watchdog)" \
  env TICK_WORKDIR="$SCRATCH/tick-driver" "$BUN" "$HOSTSRC/tests/test-tick-driver.ts"
section bra61 2 "stuck-worker suite (BRA-61: nudge, idempotency policy, cost-derived lease, journal surfacing)" \
  env BRA61_WORKDIR="$SCRATCH/bra61" "$BUN" "$HOSTSRC/tests/test-bra61.ts"
section bra75 2 "crash-recovery suite (BRA-75: journal check before re-dispatch, trapId enqueue dedupe, sleep remaining time)" \
  env BRA75_WORKDIR="$SCRATCH/bra75" "$BUN" "$HOSTSRC/tests/test-bra75.ts"
section bra72 2 "queue/driver integrity suite (BRA-72: stranded running repair, driver lock, concurrent-driver refusal)" \
  env BRA72_WORKDIR="$SCRATCH/bra72" "$BUN" "$HOSTSRC/tests/test-bra72.ts"
section bra77 2 "corrupt-state resilience suite (BRA-77: atomic queue writes, backup recovery, journal quarantine)" \
  env BRA77_WORKDIR="$SCRATCH/bra77" "$BUN" "$HOSTSRC/tests/test-bra77.ts"
section bra71 2 "run-integrity suite (BRA-71: frozen workflow copy, snapshot engine-version check)" \
  env BRA71_WORKDIR="$SCRATCH/bra71" "$BUN" "$HOSTSRC/tests/test-bra71.ts"
section bra74 2 "crash-resume suite (BRA-74: resume from last blob, durable sleep deadline, adapter timeout)" \
  env BRA74_WORKDIR="$SCRATCH/bra74" "$BUN" "$HOSTSRC/tests/test-bra74.ts"
section bra76 2 "smaller-robustness-gaps suite (BRA-76: atomic snapshot writes, corrupt worker-store recovery, explicit drive cap)" \
  env BRA76_WORKDIR="$SCRATCH/bra76" "$BUN" "$HOSTSRC/tests/test-bra76.ts"
section bra67 2 "fault-injection coverage suite (BRA-67: cron across restart, complete-job never lands, VM-replacement cold start, missing engine binary)" \
  env BRA67_WORKDIR="$SCRATCH/bra67" "$BUN" "$HOSTSRC/tests/test-bra67.ts"
section bra73 2 "journal-schema suite (BRA-73: trap site per call site + bundle pinned, run-start fields, trap-dispatch split, pool worker on trap-result)" \
  env BRA73_WORKDIR="$SCRATCH/bra73" "$BUN" "$HOSTSRC/tests/test-bra73.ts"
section bra47 2 "decision-cascade suite (BRA-47: Decision shape + decisionCascade, exec -> decide -> job -> gate, per-tier thresholds, full attempt history)" \
  env BRA47_WORKDIR="$SCRATCH/bra47" "$BUN" "$HOSTSRC/tests/test-bra47.ts"
section bra52 2 "workflow-library manifest suite (BRA-52: README inventory conformance — every entry exists, gates clean, every jobspec pairing served, admittance mapping)" \
  env BRA52_WORKDIR="$SCRATCH/bra52" "$BUN" "$HOSTSRC/tests/test-bra52.ts"
section bra82 2 "enqueue-race suite (BRA-82: concurrent submits all land, live lock blocks, stale lock breaks, mid-drive submits survive)" \
  env BRA82_WORKDIR="$SCRATCH/bra82" "$BUN" "$HOSTSRC/tests/test-bra82.ts"
section bra83 2 "atomic C snapshot writes suite (BRA-83: tmp+rename+fsync in save_snapshot and write_result_json)" \
  env BRA83_WORKDIR="$SCRATCH/bra83" "$BUN" "$HOSTSRC/tests/test-bra83.ts"
section bra84 2 "torn run-entry recovery suite (BRA-84: atomic run-entry writes + backup recovery, corrupt entry with no backup is loud and stays left-running)" \
  env BRA84_WORKDIR="$SCRATCH/bra84" "$BUN" "$HOSTSRC/tests/test-bra84.ts"
section bra85 2 "state-dir relocation suite (BRA-85: relative frozenPath + load-time rebase of registry snap/out/log + frozenPath, gate + exec, relative + legacy-absolute stored forms)" \
  env BRA85_WORKDIR="$SCRATCH/bra85" "$BUN" "$HOSTSRC/tests/test-bra85.ts"
section bra88 1 "verbatim-copy drift suite (BRA-88: sync check byte-identical incl. negative control, mock journals carry trap site, transitive imports extract identically under host and mock)" \
  env BRA88_WORKDIR="$SCRATCH/bra88" AGENTTS_CORE_DIR="$CORE" "$BUN" "$HOSTSRC/tests/test-bra88.ts"
section bra89 2 "trap-code pin suite (BRA-89: worker/jobspec/decision-model/adapter/exec-script hash pin + loud refusal on mid-run edit, pool jobspec snapshot)" \
  env BRA89_WORKDIR="$SCRATCH/bra89" "$BUN" "$HOSTSRC/tests/test-bra89.ts"
section bra101 1 "HOLD-identity suite (BRA-101: adapter HOLD is the host's HOLD under the scratch-copy path)" \
  "$BUN" "$HOSTSRC/tests/test-bra101.ts"
section bra103 1 "durablets-dir suite (BRA-103: \$AGENTTS_DURABLETS_DIR export pins the C source under the scratch-copy path)" \
  "$BUN" "$HOSTSRC/tests/test-bra103.ts"
section bra106 2 "generic-specialization suite (BRA-106: extractor specializes generic trap contracts per instantiation; JudgeFixLoop calls traps directly)" \
  env BRA106_WORKDIR="$SCRATCH/bra106" "$BUN" "$HOSTSRC/tests/test-bra106.ts"
section bra112 1 "stdin one-shot suite (BRA-112: agentts run - reads the workflow from stdin, materialized content-addressed to .agentts-scratch/inline/)" \
  env BRA112_WORKDIR="$SCRATCH/bra112" "$BUN" "$HOSTSRC/tests/test-bra112.ts"
section bra90 2 "incremental snapshots suite (BRA-90: hash-linked snapshot chain — keyframe + delta per checkpoint, interval/ratio rebase, torn/corrupt/wrong-hash/missing fault injection, shared-keyframe fork, measured write amplification, legacy migration, full-only interval 0)" \
  env BRA90_WORKDIR="$SCRATCH/bra90" "$BUN" "$HOSTSRC/tests/test-bra90.ts"
section bra105 2 "run/call suite (BRA-105: sub-workflows as child runs — value through the trap, sleep suspend/resume, loud throw, nested run/call, cancellation down the tree, freeze pinning, loud refusal, fresh-process gate resume)" \
  env BRA105_WORKDIR="$SCRATCH/bra105" "$BUN" "$HOSTSRC/tests/test-bra105.ts"
section bra109 2 "presentations suite (BRA-109: Google Slides + JudgeFixLoop — deck build, review loop improves the deck, stubborn cap, invalid inputs fail loudly, real workers)" \
  env BRA109_WORKDIR="$SCRATCH/bra109" "$BUN" "$HOSTSRC/tests/test-bra109.ts"
section bra116 2 "driver endpoints suite (BRA-116: tick agent drives over HTTP — endpoint behaviour + error cases, lock refusal both directions, server-restart driver survival + driver-kill repair (BRA-175), deliver-gate end to end)" \
  env BRA116_WORKDIR="$SCRATCH/bra116" "$BUN" "$HOSTSRC/tests/test-bra116.ts"
section bra117 2 "plan-driven-work suite (BRA-117: plan → review → execute → review template — direct BRA-110 plan proof with a held gate and frozen==executed, mock mirror, stubborn cap, invalid inputs fail loudly, failing phase stops the run)" \
  env BRA117_WORKDIR="$SCRATCH/bra117" "$BUN" "$HOSTSRC/tests/test-bra117.ts"
section bra110 1 "production deliver proof suite (BRA-110: tick-loop drive + deliver on the direct adapter with a real exec, double-delivery guard, failed-run delivery, deliver refusals, coordinator read-back)" \
  env BRA110_WORKDIR="$SCRATCH/bra110" "$BUN" "$HOSTSRC/tests/test-bra110.ts"
section bra111 2 "briefing live cutover suite (BRA-111: direct adapter fails loudly without a workers-config, drives briefing jobs with one through the queue, bad configs fail loudly, checked-in config maps all five specs)" \
  env BRA111_WORKDIR="$SCRATCH/bra111" "$BUN" "$HOSTSRC/tests/test-bra111.ts"
section bra124 2 "briefing judge suite (BRA-124: consequence-led ranking — combinedScore = consequence*10 + topicScore — with recorded LLM verdicts under the direct adapter and the pool judge in production; must-read agrees with the cron edition; no judgments / incomplete coverage / out-of-range consequence all fail loudly)" \
  "$BUN" "$HOSTSRC/tests/test-bra124.ts"
section bra124pool 1 "briefing pooling-supplement suite (BRA-124 remaining: abstract-informed pooling supplement — fetch selection over the real Nov 18 title-low set, supplement selection over the real abstract scores, the displacement finding that killed displacement, and consequence fairness; TPHC/Gemma NOT promoted is pinned as the known limit)" \
  "$BUN" "$HOSTSRC/tests/test-bra124-pool.ts"
section bra121 1 "join-slice failure reporting suite (BRA-121: a throw after an all()/any()/race() join fails cleanly with the real error journaled — no join-slice crash, no 3x retry; caught-after-join happy path still completes)" \
  env BRA121_WORKDIR="$SCRATCH/bra121" "$BUN" "$HOSTSRC/tests/test-bra121.ts"
section bra125 1 "cancelled-run failure reporting suite (BRA-125: a run that fails on cancel journals its lifecycle failed event with the real error — the cancel handler prints the exception before emitting, like run/resume)" \
  env BRA125_WORKDIR="$SCRATCH/bra125" "$BUN" "$HOSTSRC/tests/test-bra125.ts"
section bra131 1 "host-result failure derivation suite (BRA-131: result() for a stepwise-driven failure reports failed with the journal's real error — same host and fresh host — for a cancel-failure and a first-slice throw; a suspended run still reports running, an unknown runId still pending)" \
  env BRA131_WORKDIR="$SCRATCH/bra131" "$BUN" "$HOSTSRC/tests/test-bra131.ts"
section bra94 1 "driver-bundle cache suite (BRA-94: a second run of the same frozen workflow + input reuses the cached bundle — same bytes, one cache entry — while a changed input or workflow rebuilds; child runs share the cache; a fresh Host hits the disk cache)" \
  env BRA94_WORKDIR="$SCRATCH/bra94" "$BUN" "$HOSTSRC/tests/test-bra94.ts"
section bra95 2 "blob-recipe suite (BRA-95: the storeBlob recipe hashed src twice — the duplicate computation is gone, the tmp/dst checks stay; a stranded delta checkpoint's manifest hashes match the bytes on disk, the run resumes with the right result, and a truncated delta or keyframe still fails loudly)" \
  env BRA95_WORKDIR="$SCRATCH/bra95" "$BUN" "$HOSTSRC/tests/test-bra95.ts"
section bra96 1 "notifyEvent suite (BRA-96: notifyEvent POSTs via a fire-and-forget in-process fetch instead of a blocking curl spawn — same payload, dead port and slow server never block the drive, a child that notifies and exits immediately still delivers, onEvent sink still takes precedence)" \
  env BRA96_WORKDIR="$SCRATCH/bra96" "$BUN" "$HOSTSRC/tests/test-bra96.ts"
section bra119 1 "gate auto-answer suite (BRA-119: the mock adapter's silent auto-\"yes\" is now loud — GATE AUTO-ANSWERED on stderr naming the run and trap, trap-dispatched and trap-result carry auto:true — while --gates hold on BOTH run and queue run holds until deliver-gate, and queued answers stay unmarked)" \
  env BRA119_WORKDIR="$SCRATCH/bra119" "$BUN" "$HOSTSRC/tests/test-bra119.ts"
section bra120 1 "mock exec canned warning suite (BRA-120: a canned exec logs CANNED EXEC naming the command and marks trap-dispatched/trap-result canned:true; cat and echo hi stay real and unmarked; queued answers unmarked)" \
  env BRA120_WORKDIR="$SCRATCH/bra120" "$BUN" "$HOSTSRC/tests/test-bra120.ts"
section bra118 1 "bundle validator string-literal suite (BRA-118: import/export inside strings and comments no longer refused — the check is a real parse (Bun.Transpiler.scan) that refuses only static import statements and any exports; a genuine top-level import is still refused loudly)" \
  env BRA118_WORKDIR="$SCRATCH/bra118" "$BUN" "$HOSTSRC/tests/test-bra118.ts"
section bra129 1 "traps in native callbacks suite (BRA-129: a trap inside a native-builtin callback (map/forEach/filter/...) is refused at extraction time naming the callback and the fix — a plain for loop or direct call instead; thunks merely created inside a callback and invoked later by all() still run)" \
  env BRA129_WORKDIR="$SCRATCH/bra129" "$BUN" "$HOSTSRC/tests/test-bra129.ts"
section bra122 1 "failed phase stdout suite (BRA-122: a failed command phase's error carries the stdout tail (last 2 KB) and stderr head (first 300 chars), each labeled, instead of stderr-only with a (no stderr) fallback; the commit step gets the same treatment; the run's lifecycle-failed journal event carries the message)" \
  env BRA122_WORKDIR="$SCRATCH/bra122" "$BUN" "$HOSTSRC/tests/test-bra122.ts"
section bra123 1 "briefing htmlPath week-Monday suite (BRA-123: the briefing workflow's returned htmlPath names the week file by its Monday, not the edition date — weekMonday computes it, one shared const for the week-page print and the return; a CLI mock run for a Nov 18 edition returns the Nov 16 file, and the real builder writes exactly that file)" \
  env BRA123_WORKDIR="$SCRATCH/bra123" "$BUN" "$HOSTSRC/tests/test-bra123.ts"
section bra133 1 "foreign event rejection suite (BRA-133: an event naming a run this state dir has never seen gets the same 404 as deliver-result — one shared runExists check — and never wakes the tick loop; a legit run's event is accepted and wakes it; no-runId events pass through)" \
  env BRA133_WORKDIR="$SCRATCH/bra133" "$BUN" "$HOSTSRC/tests/test-bra133.ts"
section bra142 1 "workflow-library pure-function unit suite (BRA-142: direct in-process unit tests — diagnosePhaseReview, decideLocal, resolveTextBlob/resolveTextRubric, planWaves/splitExecuted, and the worker's judge/fix/aggregate scoring called directly through its process entry point)" \
  env BRA142_WORKDIR="$SCRATCH/bra142" "$BUN" "$HOSTSRC/tests/test-bra142.ts"
section bra138 1 "plan-driven-work CLI e2e suite (BRA-138: the BRA-110 plan through the CLI on direct — submit, gate hold, deliver-gate approve, execute, result — with frozen == executed proven from the journal; the Host-API proof stays in test-bra117)" \
  env BRA138_WORKDIR="$SCRATCH/bra138" "$BUN" "$HOSTSRC/tests/test-bra138.ts"
section bra139 1 "run/call CLI+direct e2e suite (BRA-139: the bra105 parent fixtures through the CLI on direct — value through the trap, sleep-resume on the real clock, loud throw, two-level nesting — with run-child events and child lifecycles from the journal)" \
  env BRA139_WORKDIR="$SCRATCH/bra139" "$BUN" "$HOSTSRC/tests/test-bra139.ts"
section bra140 1 "improve-loop CLI+direct e2e suite (BRA-140: the INTEGRATION-TEST.md procedure automated — submit, queue run, result, --wait, converging 2 rounds + 3 changes, stubborn 3-round cap at 0.8, pending result prints status; the fixture's outDir and rubric path are resolved to scratch first so no write lands in the tree)" \
  env BRA140_WORKDIR="$SCRATCH/bra140" "$BUN" "$HOSTSRC/tests/test-bra140.ts"
section bra141 1 "rubricReview CLI+direct e2e suite (BRA-141: the rubric-review probe through the CLI on direct — weak review 0 -> 1.0 in 2 loops with full verdict shape, meta review 1.0 in 1 loop with all 10s; the mid control and loud-failure cases stay in test-rubric-review)" \
  env BRA141_WORKDIR="$SCRATCH/bra141" "$BUN" "$HOSTSRC/tests/test-bra141.ts"
section bra143 1 "bugfix worker direct suite (BRA-143: the bugfix worker runs for real on the direct adapter — reproduce builds a runnable copy + the real C host + runs the real CLI, post-fix signature 5 loops / converged / mean 0.85, simulated false — via the Host API and via the CLI; the worker needed four repairs to get there: plugins/ in the copy, --input-file, --wait, and whole-stdout JSON parsing)" \
  env BRA143_WORKDIR="$SCRATCH/bra143" "$BUN" "$HOSTSRC/tests/test-bra143.ts"
section bra144 1 "any/race CLI+direct suite (BRA-144: any() returns the first success and race() the first settler through the CLI on direct with real sleep traps; the losing branches never run — the marker file stays empty; sequential driver, so the first branch is always the first settler — true time-based racing needs the real scheduler (M3))" \
  env BRA144_WORKDIR="$SCRATCH/bra144" "$BUN" "$HOSTSRC/tests/test-bra144.ts"
section bra145 1 "validation refusal CLI+direct suite (BRA-145: a bad input is refused at submit with the exact text and no queue entry; a bad trap output fails the run with a ValidationError naming the trap, the attempt, the path, and the failure, journaled once — both through agentts run on direct)" \
  env BRA145_WORKDIR="$SCRATCH/bra145" "$BUN" "$HOSTSRC/tests/test-bra145.ts"
section bra146 1 "unextractable generic CLI refusal suite (BRA-146: agentts run on direct refuses a never-called generic, an inferred call, and conflicting instantiations of one spec, each with the exact cause and no queue entry; the same instantiation twice checks green)" \
  env BRA146_WORKDIR="$SCRATCH/bra146" "$BUN" "$HOSTSRC/tests/test-bra146.ts"
section bra147 1 "bundle cache CLI suite (BRA-147: bundle-cache reuse across separate CLI processes — the second process leaves the cached bundle's mtime, inode, and sha unchanged and pins a byte-identical copy; a different input misses and adds one entry, with no cross-talk)" \
  env BRA147_WORKDIR="$SCRATCH/bra147" "$BUN" "$HOSTSRC/tests/test-bra147.ts"
section bra164 1 "run-tests workflow driver suite (BRA-164: inventory check passes, agentts check passes on run-tests.ts, parseSectionOutput unit checks, a live 2-section chunk via the CLI, and a bogus-slug retry probe)" \
  env BRA164_WORKDIR="$SCRATCH/bra164" "$BUN" "$HOSTSRC/tests/test-bra164.ts"
section bra130 1 "briefing must-read consequence-led suite (BRA-130: Nov 18 regression — KRC beats LoopZip on the issue's own values while the old rankScore picks LoopZip; one consequence point cannot be overturned by numbers/fullText; tiebreaks numbers/fullText/id; unjudged reads throw; CLI mock run must-read 2611.90001; decide trap + threshold 50 gone)" \
  env BRA130_WORKDIR="$SCRATCH/bra130" "$BUN" "$HOSTSRC/tests/test-bra130.ts"
section bra132 1 "snapshot format identity gate suite (BRA-132: resume compares the snapshot format identity — blob-header build signature + dquickts pin + ordered host native names — not the full engine version; a logic-only durablets.c change resumes, a pin change / native rename / native add still refuse, legacy no-identity runs proceed on signature+pin, the override hook still refuses)" \
  env BRA132_WORKDIR="$SCRATCH/bra132" "$BUN" "$HOSTSRC/tests/test-bra132.ts"
section bra158 1 "fix verification workflow suite (BRA-158: the verify-fix workflow encodes Meroki's manual verify loop — fresh-host direct re-run, tier-1 log greps never the runner's summary, diff confinement, baseline comparison with deltas explained, verify report; it never closes issues, merges code, or decides acceptance; a false pass is not diagnosed, same limit as BRA-126)" \
  env BRA158_WORKDIR="$SCRATCH/bra158" "$BUN" "$HOSTSRC/tests/test-bra158.ts"
section bra211a 1 "launch-attribution suite (BRA-211a: run attribution + visibility + cancel — submit records launchedBy (provenance) and owner (the driving session) on the queue entry and the run entry at start, run/call children and fork branches inherit both; agentts status shows both, agentts runs [--owner S] [--launched-by S] lists runs newest-first with a default 50-row bound under the ~60KB trap cap, agentts cancel flips the entry to cancelled and journals run-cancelled; cancel is check-then-act — the driver re-reads the run's cancelled flag before the first slice and before each drive step, so a mid-drive cancel stops the drive at the next step boundary; the owner OR the launcher may cancel an attributed run, unattributed runs take the legacy operator path, and the CLI also cancels the run's server jobs best-effort)" \
  env BRA211A_WORKDIR="$SCRATCH/bra211a" "$BUN" "$HOSTSRC/tests/test-bra211a.ts"
section bra211b 1 "owner-resolution suite (BRA-211b: a job whose spec carries target owner resolves at dispatch in the Host's job-trap path to the run's owner field — not launchedBy, no fallback, refuse loudly with no owner or a named target — journals job-owner-resolved and rides the trap arg as targetSession so the enqueueing adapter stamps it on the Job record as the owner tag; JobSpec gains optional target, Job gains target + targetSession, enqueue accepts both; the direct adapter records the resolution in the journal and runs in-process; tests assert the tag, never routing — enforcement is BRA-160)" \
  env BRA211B_WORKDIR="$SCRATCH/bra211b" "$BUN" "$HOSTSRC/tests/test-bra211b.ts"
section bra217 1 "verify-fix suite-step trap cap suite (BRA-217: verify-fix no longer hauls run.sh's full stdout through the exec trap — a full tier-1's stdout is megabytes, far over the ~60KB cap, and the old summaryLine = r.stdout crashed the C host on resume; the suite run now goes through suiteRunScript / scopedSuiteRunScript, which redirect run.sh's stdout to a file in-shell and return only the PASS summary line (full runs) or a one-line exit marker (scoped runs), the merge tier1RunScript pattern applied in place; the bulk output stays on disk under the work dir)" \
  env BRA217_WORKDIR="$SCRATCH/bra217" "$BUN" "$HOSTSRC/tests/test-bra217.ts"
section bra159 1 "merge workflow suite (BRA-159: the merge workflow encodes the worker-per-copy merge — copy-time manifest base, three-way classification, baselines never merged, host.ts conflicts to a human, fresh tier-1 after the apply with log-grep counts vs the PASS line; it applies the diff but never decides acceptance; a live modification or deletion the copy never touched is preserved, not a failure — the step-7 fix)" \
  env BRA159_WORKDIR="$SCRATCH/bra159" "$BUN" "$HOSTSRC/tests/test-bra159.ts"
section bra210a 1 "triage workflow suite (BRA-210a: the triage workflow ranks the Linear backlog from Linear + GOAL.md — the fetch trap redirects the full list_issues JSON to a file and returns only a FETCHED line, the bun rank script reads it + GOAL.md from disk and writes a dated ranked queue JSON + a stable ranked-queue.json + a drift note atomically, the report carries the drift list; it proposes order and never changes it, never files, never closes; owner is required and never assumed from the launcher; cancel is check-then-act before the write step)" \
  env BRA210A_WORKDIR="$SCRATCH/bra210a" "$BUN" "$HOSTSRC/tests/test-bra210a.ts"
section bra210b 1 "breakdown workflow suite (BRA-210b: the breakdown workflow turns a filed feature issue into filed, estimated tasks with acceptance criteria and code areas — the split is supplied in the run input by the PM lead, never invented; it files each task file-first in Linear with the parent's full URL, verifies each filing by reading it back, updates the parent's Breakdown section deterministically, and is idempotent on re-run after a partial filing — a partial filing is NOT rolled back; a dry-run plans without filing; a parent that is not filed refuses as a wish; tests run only against a stub linear CLI, never the real project)" \
  env BRA210B_WORKDIR="$SCRATCH/bra210b" "$BUN" "$HOSTSRC/tests/test-bra210b.ts"
section bra210c 1 "breakdown BACKLOG.md fallback suite (BRA-210c: when a Linear create is refused with the free-plan issue limit, the breakdown workflow files the unfiled remainder to the goal's BACKLOG.md in the complete form and records the backlog md as the filing location — the verdict stays broken-down and the deviation is noted; a non-limit refusal still fails loudly with nothing half-done; a dry-run writes nothing to BACKLOG.md; a re-run finds the entry and writes nothing new; a limit refusal with no backlogPath stays loud; tests run only against a stub linear CLI, never the real project)" \
  env BRA210C_WORKDIR="$SCRATCH/bra210c" "$BUN" "$HOSTSRC/tests/test-bra210c.ts"
section lead-loop 1 "lead-loop suite (no BRA number — unfiled while the Linear limit holds: the generic lead-loop skeleton every lead boots as its main entry point — claim the next job for its owner from the launcher-supplied list, dispatch it per the table via BRA-176 dispatch whose switch is the single source of truth, submit the routed run through the scheduler with --adapter direct, progress-check the owned runs pull-only, collect completed reports, file first to BACKLOG.md in the same iteration, run periodic work on cron, park cheaply between jobs, and emit liveness to <stateDir>/liveness/<loopId>.json; owner is required and never assumed from the launcher; cancel is check-then-act before advancing; a decide is surfaced, never answered; the loop never closes an issue, merges code, or decides acceptance)" \
  env LEADLOOP_WORKDIR="$SCRATCH/lead-loop" "$BUN" "$HOSTSRC/tests/test-lead-loop.ts"
section daily-brief 1 "daily-brief suite (BRA-274: the daily brief workflow runs the 05:30 prompt / 06:30 aggregate / 07:00 brief phases — one phase per cron, crons stay as triggers; it sends no messages, the prompt payloads and the 07:00 delivery payload return in the report for the launcher; the aggregate derives decisions-needed (every needs_pm, roster order, attributed), must-know (Director-supplied run.mustKnow, then the PM report's optional mustKnow, then the first decision), risks (every solutions[].problem), per-lead sections (status + numbers with trend arrows vs the prior day) and the Director's own report (overall state from the goal notes, what changed from the ledger + status changes, what is next from the backlog + predictions) deterministically, and renders the dated HTML brief from the aggregation with the Nov 21 template structure; a missing lead report is noted with the reason named and never blocks the brief; all lead-report fields except lead and date are optional — an absent optional field is empty, never invalid; a wrong shape on a present field is invalid and recorded missing-with-reason; the brief phase validates the aggregation's date before rendering and refuses loudly on a missing or wrong-date aggregation; the predictor record is read and logged, never scored; owner is required, never assumed from the launcher; cancel is check-then-act before any read or write; dry-run writes nothing)" \
  env BRA274_WORKDIR="$SCRATCH/daily-brief" "$BUN" "$HOSTSRC/tests/test-bra274.ts"
section land-queue 1 "land-queue suite (BRA-261: the land queue workflow is the file's single writer — it orders the landing queue from the queue file (ready first by ready_at ascending, then blocked, then paused, then landed as history; order reassigned 1..N), demotes a ready entry whose verification failed or is missing to blocked with the failure named in the notes, never promotes on its own, applies caller updates by issue before ordering (an unknown issue refuses the run), reads/writes via exec traps in the dispatch pattern (base64 chunks + temp + rename + read-back, never trap stdout, never Buffer), and carries the settled MergeAuthorization from merge.ts verbatim; cancel is check-then-act before any read or write; a null/absent run is refused, never dereferenced; dry-run orders and writes nothing, the file byte-identical after)" \
  env BRA261_WORKDIR="$SCRATCH/land-queue" "$BUN" "$HOSTSRC/tests/test-bra261.ts"
section rebase 1 "rebase suite (BRA-262: the rebase workflow brings a copy onto the latest tree before merging — the three-way diff comes from the merge workflow's own sparse-diff script, each copy-changed file is classified with classifyMergeFile, a conflict (both sides changed the file differently) refuses loudly before anything is written with the conflicting files named and the copy's manifest byte-identical, a clean rebase re-records the manifest against current live in-shell (live hashes, temp + rename, the record-copy-manifest.sh format) and verifies it by re-running the sparse diff (every entry must have base == live), a manifest already current reports rebased and writes nothing, a baselines change is not a rebase conflict; the rebase never writes live and never merges; cancel is check-then-act before any read or write; dry-run plans and writes nothing)" \
  env BRA262_WORKDIR="$SCRATCH/rebase" "$BUN" "$HOSTSRC/tests/test-bra262.ts"
section test-batching 1 "test-batching suite (BRA-263: the test-batching workflow verifies a stack of changes passes together without re-verifying each change from scratch — it runs the named higher-tier suites per change, batched, and reports per change (change, suite, pass/fail, log path) plus the stack verdict (all passed, or the failing change + suite named); a failed change never rides a passing stack; per-suite results are recorded incrementally (atomic write per suite) so a resumed batch skips completed suites; the workflow does not edit the queue file, it returns per-change results for the caller to apply; cancel is check-then-act before any run; dry-run plans and writes nothing)" \
  env BRA263_WORKDIR="$SCRATCH/test-batching" "$BUN" "$HOSTSRC/tests/test-bra263.ts"
section bra251 1 "dependency mapping suite (BRA-251: the dependency-mapping workflow persists triage's ranked queue into the dependency graph the scheduler reads — nodes are the queue items with their rank, edges are dependsOn/blocks from the items' lists plus derived conflict edges for ready/gated items sharing a non-unknown codeArea; the graph is a pure function of the queue, so the same queue yields the byte-identical graph; a bun graph script reads the queue + GOAL.md from disk and writes a dated graph JSON + a stable dependency-graph.json atomically, returning only a one-line summary — the graph itself never crosses a trap boundary; owner is required and never assumed from the launcher; cancel is check-then-act before the write step)" \
  env BRA251_WORKDIR="$SCRATCH/bra251" "$BUN" "$HOSTSRC/tests/test-bra251.ts"
section bra252 1 "daily queue feed suite (BRA-252: the daily-feed workflow publishes the prioritized queue the fleet works from each day, derived from the triage ranked queue + the dependency graph + GOAL.md — ready + gated-but-speculable items in queue rank order, each carrying conflictsWith from the graph's conflict edges; blocked/parked are counted, never fed; a missing graph refuses loudly; the graph's triageId must match the queue's; feed items whose GOAL.md position disagrees with their rank carry a drift note in triage's categories, feed items only; tests use a hand-built graph fixture, never Worker C's output)" \
  env BRA252_WORKDIR="$SCRATCH/bra252" "$BUN" "$HOSTSRC/tests/test-bra252.ts"
section bra160 1 "dynamic scheduler suite (BRA-160: the OS thread scheduler — owner-routed dispatch in DispatchScheduler (shared queue with an owner tag: decide owner-only, job/exec owner-preferred with work-stealing from the deepest other-owner queue, priority dominating owner preference, serial-commit lock on spec merge), dead-owner detection via GET /owners + pure detectDeadOwners (lease expiry primary, Director supervision secondary, Director-settled), reassignment via POST /reassign-run + the reassignRun workflow (retags queued + running jobs in place, including any pending decide, and updates the queue + registry run records; deduped jobs carry the NEW tag on re-dispatch — 2611dee1); owner required, never assumed from the launcher; cancel is check-then-act before the reassign step)" \
  env BRA160_WORKDIR="$SCRATCH/bra160" "$BUN" "$HOSTSRC/tests/test-bra160.ts"
section bra213 1 "long-lived workers suite (BRA-213: workers are long-lived looping sub-agents owned by a lead — stable worker id + owner session presented at get-job (the server records the owner, last presentation wins), idle timeout 30 minutes by default with a lead override, clean shutdown on lead close (finish the in-flight job, then exit; a closed worker never claims another job), the worker registry via GET /workers + POST /register-worker + POST /close-worker (owner + spawned-at + last-seen + status alive/idle/closed/dead, dead derived never self-reported; a worker with no owner is refused at registration); the manageWorkers workflow (register/list/close); NOT persisted — no memory file, no chat session; a killed worker's leased job re-queues on lease expiry and completes on another worker — the kill test proves it; owner required, never assumed from the launcher; cancel is check-then-act before the lifecycle step)" \
  env BRA213_WORKDIR="$SCRATCH/bra213" "$BUN" "$HOSTSRC/tests/test-bra213.ts"
section bra214 1 "large trap result suite (BRA-214: a trap result at or above the 64KB inline threshold travels file-backed (agentts-file: marker, BRA-171) and must not crash the C host on resume — the crash was a stale pre-BRA-171 binary JSON-parsing the marker (SyntaxError: unexpected token: 'agentts'); the C host now prints its source hash via durablets version (Makefile bakes sha256(durablets.c + durablets.h)), and the TS host verifies it once per Host before the first file-backed delivery, failing loudly with a named BRA-214 error on any mismatch (including unknown — a binary built without the flag); the 64KB inline threshold is intentional (half Linux's 128KB MAX_ARG_STRLEN) and stays; a new explicit bound caps file-backed results at 16MB, above which the delivery fails loudly naming the limit before any file is written or resume spawned; the regression test drives a large exec trap at 59,561 B and 64,111 B (Quality's sizes), 66,000 B, 162,000 B (real-manifest size) and 1,000,000 B, plus a hostile stale-binary case and a cross-shift kill-and-resume case)" \
  env BRA214_WORKDIR="$SCRATCH/bra214" "$BUN" "$HOSTSRC/tests/test-bra214.ts"
section bra176 1 "dispatch suite (BRA-176: the dispatch workflow matches task kinds to the workflows that run them — an explicit switch on the task's triage tag (bare name or workflow:<name> label) builds each routed run's two-layer input from the task's fields and writes the routing handoff JSON the scheduler consumes (atomic write + read-back, in base64 chunks so the routing table never crosses a trap boundary); it never submits runs, never calls sub-workflows in-run, never creates queue entries — the §D no-submit check proves the queue byte-identical and no jobs enqueued; only READY tasks route (gated/blocked/parked refuse with the reason named), every routed task carries a caller-supplied assignment whose owner must be a looping session per the roster, tasks process in input order, never re-sorted; owner required, never assumed from the launcher; cancel is check-then-act before the write step)" \
  env BRA176_WORKDIR="$SCRATCH/bra176" "$BUN" "$HOSTSRC/tests/test-bra176.ts"
section bra178 1 "garbage collection suite (BRA-178: GC reclaims finished runs after the retention window (project.retentionDays, default 30 days from the ledger record's finishedAt) — archive before delete to <stateDir>/archive/<runId>/ (journal + run entry + run.json with the queue entry + ledger record + frozen hash), then delete the live queue entry + journal + work dir + per-run blobs, verify the paths are gone, then append exactly one collected record to the append-only ledger (never delete a ledger line); kept runs (agentts run --keep) are never collected, queued/running/held runs never, at any age; frozen closures are never deleted (shared, content-addressed); idempotent — a second run reclaims nothing and appends no duplicate collected record; a corrupt journal or queue entry refuses the whole run, nothing deleted; owner required, never assumed from the launcher; cancel is check-then-act before any collection)" \
  env BRA178_WORKDIR="$SCRATCH/bra178" "$BUN" "$HOSTSRC/tests/test-bra178.ts"
section throughput-report 1 "throughput report suite (BRA-247: the throughput-report workflow reads the run ledger tail, the audit baselines file, the land queue and the merge reports, and reports tasks completed, landings, median pickup-to-landed, median verify time, the cost of a kill and the stalled steps for one day — the Director's counting rule: a task counts when it is completed verified work, landings listed separately, nothing double-counted; verify time is the merge report's suite.elapsedMs; pickup is the copy creation time (the copy's manifest copiedAt, else the copy dir mtime; earliest copy wins); the run-to-item join attributes build time and window membership when the runId's middle key equals the issue key after normalization; a close time counts only as closed <ISO> in the queue notes; a missing source is reported with the reason named, never a refusal; an entry whose only defect is an unknown status is skipped-with-reason and named, and a pending_qa entry is counted as pending and shown as awaiting Quality; the ledger tail is byte-capped and reports printed/total; owner required, never assumed from the launcher; cancel is check-then-act before any read or write; dry-run plans and writes nothing)" \
  env BRA247_WORKDIR="$SCRATCH/throughput-report" "$BUN" "$HOSTSRC/tests/test-bra247.ts"
section bottleneck-detect 1 "bottleneck detection suite (BRA-248: the bottleneck-detect workflow re-derives 247's decomposition from the same sources, cross-checks it against 247's report when one is supplied, identifies the bottleneck as the component with the largest median share of pickup-to-landed (machine-down overrides at share 1.0, below 0.5 no single stage dominates, no complete decomposition means unknown), evaluates Brandon's P0 bar (expected ETA saving = probability x share x median pickup-to-landed x items blocked must beat the fix cost), and files a P0 with numbers to BACKLOG.md only when a throughput stage of the machine is the bottleneck and the bar passes — never a second filing while the first is unanswered; a bottleneck that is not a stage, or that fails the bar, is reported, not filed; owner required, never assumed from the launcher; cancel is check-then-act before any read or write; dry-run plans and writes nothing)" \
  env BRA248_WORKDIR="$SCRATCH/bottleneck-detect" "$BUN" "$HOSTSRC/tests/test-bra248.ts"
section server-restart 1 "server auto-restart suite (BRA-245: the server-restart workflow detects a down worker server or a dead tick with pending work, restarts the server once with the standing command, and verifies /health answers ok:true within 30 attempts one second apart — a restart that is not verified is reported as not-verified, never as up; an already-up server is verified only, never restarted; a stale tick with the server up is reported with the tick agent's restart named as the watchdog cron's job, never a server restart; one run makes at most one restart attempt; the trigger is a 15-minute cron invoking the CLI; owner required, never assumed from the launcher; cancel is check-then-act before any read or write; dry-run plans and writes nothing)" \
  env BRA245_WORKDIR="$SCRATCH/server-restart" "$BUN" "$HOSTSRC/tests/test-bra245.ts"
section vm-recovery 1 "VM-replacement recovery suite (BRA-246: the vm-recovery workflow detects a VM replacement from the boot-id record it writes itself (first run establishes the record, never a replacement), restarts the server with 245's helpers and verifies /health, then classifies every queue entry stranded at running by mirroring the engine's classifyStrandedEntry evidence (journal lifecycle, registry rc, snapshot blob) and names the resume dir + resume point per run — suite runs resume via run.sh --resume-dir at the first unfinished tier-1 section, workflow runs via the queue drive from the blob; a run with no resume dir recorded is could-not-resume with the reason named, never silently dropped; the trigger is a systemd user unit delivered to the state dir and enabled once by hand; the workflow never drives the resumes itself; owner required, never assumed from the launcher; cancel is check-then-act before any read or write; dry-run plans and writes nothing)" \
  env BRA246_WORKDIR="$SCRATCH/vm-recovery" "$BUN" "$HOSTSRC/tests/test-bra246.ts"
section push 1 "push manifest + push suite (BRA-260: the push workflow rebuilds the push manifest from the dev baseline, verifies every file against origin, pushes to dev, verifies what landed via the GitHub API, and reports back with the commit — under Landing's landing authorization, never a per-push Brandon approval; a file that doesn't match origin refuses loudly and nothing is pushed; a push the API can't confirm is reported as not-verified, never as landed; an interrupted push verifies what landed before retrying, never blind-retry; a held push reports the hold and stops; the queue file is never rewritten; owner required, never assumed from the launcher; cancel is check-then-act before any read or write; dry-run plans and writes nothing)" \
  env BRA260_WORKDIR="$SCRATCH/push" "$BUN" "$HOSTSRC/tests/test-bra260.ts"
section dual-report 1 "dual-report verification suite (BRA-256: the dual-report workflow re-verifies a fixed item end to end by driving the test-batching workflow in-run as a child run, and dual-reports the verdict to the owning lead's chat AND to the Director in the same run — never only in Quality's own chat; a FAIL names the failure + evidence in both payloads; an unable-to-verify item is reported with the reason named, never dropped; an item with no owning lead goes to the Director, recorded; the workflow never files a bug and never packages a handoff; owner required, never assumed from the launcher; cancel is check-then-act before any read or write; dry-run plans and writes nothing)" \
  env BRA256_WORKDIR="$SCRATCH/dual-report" "$BUN" "$HOSTSRC/tests/test-bra256.ts"
section bra175 1 "queue-drive self-deadlock suite (BRA-175: POST /queue/run drove the queue with a Host inside the server process, so the muse adapter's sync calls to its own server — /health, /enqueue, /job-status — timed out against the blocked event loop; the server now drives the queue in a child process, so its loop stays free and the pool path works as the CLI path does; a muse run driven only through POST /queue/run completes with a live pool verdict)" \
  env BRA175_WORKDIR="$SCRATCH/bra175" "$BUN" "$HOSTSRC/tests/test-bra175.ts"
section bra180 1 "workers-config queue-drive suite (BRA-180: BRA-175 moved the queue drive into a child process but driveQueue spawned it with --workers-config and no --adapter, so makeHost defaulted the child to mock and refused the config — every drive on a --workers-config server failed before runQueue ever ran; the child now carries --adapter direct, and a direct run driven only through POST /queue/run on a --workers-config server completes with the worker script's live result)" \
  env BRA180_WORKDIR="$SCRATCH/bra180" "$BUN" "$HOSTSRC/tests/test-bra180.ts"
section bra171 1 "E2BIG trap-result delivery suite (BRA-171: a trap result whose JSON exceeds Linux's 128KB single-argv cap failed the resume spawn with E2BIG, so the run could not be resumed — the bench section's ~230KB result was undeliverable; results at or above 64KB now travel through a scratch file the C host reads, small results stay inline, both deliver paths covered, a missing file fails loudly)" \
  env BRA171_WORKDIR="$SCRATCH/bra171" "$BUN" "$HOSTSRC/tests/test-bra171.ts"
section bra179 1 "E2BIG job-input spawn suite (BRA-179: a job input whose JSON exceeds Linux's 128KB single-argv cap failed the worker spawn with E2BIG — the direct adapter and the pool worker-loop both passed the payload inline, and the muse adapter's sync curl --data did too; inputs at or above 64KB now travel through a scratch file with the agentts-file: marker, small inputs stay inline, all three worker scripts plus the pool fixtures read the marker, a missing file fails loudly; the two-full-page judge job that broke the first rubricReview run now completes)" \
  env BRA179_WORKDIR="$SCRATCH/bra179" "$BUN" "$HOSTSRC/tests/test-bra179.ts"
section bra174 1 "spawnSync stdout cap suite (BRA-174: Bun/Node spawnSync caps captured stdout at ~1MB by default, so anything larger failed the spawn with ENOBUFS — the three big arXiv list pages always failed fetchText's curl-first path and every discover relied on the Bun fetch fallback; the spawn sites that can realistically exceed the cap now pass maxBuffer 16MB, with the per-site audit in tests/test-bra174.ts)" \
  env BRA174_WORKDIR="$SCRATCH/bra174" "$BUN" "$HOSTSRC/tests/test-bra174.ts"
section bra111-runner 1 "trial-runner seen-state suite (BRA-111: briefing-prep copied the seen list from a hardcoded live path, so a trial could only dedupe against the frozen pre-cron state by swapping the live file out — a crash mid-run would leave the frozen state in place and corrupt every later cron dedupe; prep now takes an optional seen source, threaded through BriefingInput.seenSourcePath, and the cron path omits it and behaves byte-identically)" \
  "$BUN" "$HOSTSRC/tests/test-bra111-runner.ts"
section bra166 1 "workflow efficiency audit suite (BRA-166: the bench had a tighten-only ratchet for the C-host suite, but no equivalent existed for workflows — a workflow could get slower or more token-hungry across releases and nothing flagged it; the audit reads the BRA-165 ledger, keeps per-workflow baselines (median active wall clock + tokens per run) under <stateDir>/ledger/, flags a confirmed regression with numbers, tightens baselines automatically on sustained improvement, and loosens only by a human decision with a recorded reason; tokens stay explicit unknown until an adapter reports them)" \
  env BRA166_WORKDIR="$SCRATCH/bra166" "$BUN" "$HOSTSRC/tests/test-bra166.ts"
section bra162 1 "mock-mode briefing without judgmentsPath suite (BRA-162: the workflow passed judgmentsPath into the judge job even when no verdicts file existed, and the trap JSON boundary rejects undefined — a mock run with no judgments file died at the judge step; the judge job now omits the key when absent and the mock adapter's neutral-5 fixture carries the run; the with-judgments trial run selects identically)" \
  env BRA162_WORKDIR="$SCRATCH/bra162" "$BUN" "$HOSTSRC/tests/test-bra162.ts"
section bra165 1 "workflow run ledger suite (BRA-165: the cost model records per-call-site wall-time actuals and tier timings are recorded per run.sh section, but nothing aggregates per-run totals and nothing records tokens anywhere — a terminal run now leaves one record in <stateDir>/ledger/run-ledger.jsonl with wall clock, trap/job counts, and tokens as reported (explicit null when none report: the complete-job payload carries no token counts and no adapter reports them today); the scheduler can rank queued work by ledger cost via rankQueueByLedgerCost)" \
  env BRA165_WORKDIR="$SCRATCH/bra165" "$BUN" "$HOSTSRC/tests/test-bra165.ts"
section bra126 2 "phase-review diagnosis suite (BRA-126: a failing phase review diagnoses its root-cause level itself — work / workflow / rubric, possibly several at once — with a reason and a fix routing per level, carried into the template result; a three-level failure is named as all three; a converged review gets no diagnosis)" \
  env BRA126_WORKDIR="$SCRATCH/bra126" "$BUN" "$HOSTSRC/tests/test-bra126.ts"
section bra98 1 "lazy journal loading suite (BRA-98: construction loads no journals — a corrupt line is not discovered until the run is first accessed, first access loads + quarantines, append works for loaded and unloaded runs, underscore run ids load correctly)" \
  env BRA98_WORKDIR="$SCRATCH/bra98" "$BUN" "$HOSTSRC/tests/test-bra98.ts"
section rubric 2 "rubric-review suite (rubric-rubric: rubricReview library workflow — TextRubric inline/file resolution, three-judge + fix loop carrying open-ended feedback, reference-examples enforcement, negative-control weak rubric scores 0 then converges, meta-rubric self-scores 1.0)" \
  env RUBRIC_REVIEW_WORKDIR="$SCRATCH/rubric-review" "$BUN" "$HOSTSRC/tests/test-rubric-review.ts"
section bra134 1 "snapshot convert suite (BRA-134: agentts snapshot convert converts a suspended run's snapshot from one dquickts engine build to another by strip-and-recompile — the old snapshot's bytecode cells are recompiled from their recorded sources with the new engine's compile helper, re-linked into the old snapshot (atoms, cpool, frame pcs), and the state dir rewritten under the new engine version + format identity — so the run resumes under the new engine with the same result; a snapshot already at the target version is reported as already-converted, not rewritten; all 7 fault-matrix cases refuse loudly with exit 2, no output, no state touched; the e2e proves the converted run resumes with the identical result (RIGHT/7) while the unconverted copy is refused by the BRA-132 format gate)" \
  env BRA134_WORKDIR="$SCRATCH/bra134" "$BUN" "$HOSTSRC/tests/test-bra134.ts"
section bra153 1 "direct handler tests suite (BRA-153: direct in-process handler tests for the six driver endpoints — driveQueue, deliverResult, queueList, deliveries, escalate, deliverGate — measured by branch-exercise count over their 20 decision points, 0/20 before, 20/20 after; covers the 409 lock refusal, the 500s, workers-config loading, failed/done/idempotent deliveries, the escalate host-throw branch, and the fork-suspended deliverGate 400 the e2e said no deterministic workflow produces)" \
  env BRA153_WORKDIR="$SCRATCH/bra153" "$BUN" "$HOSTSRC/tests/test-bra153.ts"

# --- bench (tier 3 only; BRA-93) ---
# Benchmark regression alarms (bench/check.sh runs the suite itself).
# On a resumed run (any section was skipped via markers) the bench
# runs with --no-ratchet: observations from a resumed pass mix two
# process lifetimes and must not ratchet baselines. A fresh full run
# records history (plain form) so green runs count toward the ratchet.
if [ "$TIER" -ge 3 ] && [ -z "$ONLY" ]; then
  if [ "$SKIPPED_RESUME" -gt 0 ]; then
    section bench 3 "benchmark regression alarms (BRA-93)" \
      "$SCRIPT_DIR/bench/check.sh" --reps 5 --no-ratchet
  else
    section bench 3 "benchmark regression alarms (BRA-93)" \
      "$SCRIPT_DIR/bench/check.sh" --reps 5
  fi
elif [ -n "$ONLY" ]; then
  case ",$ONLY," in
    *",bench,"*)
      section bench 3 "benchmark regression alarms (BRA-93)" \
        "$SCRIPT_DIR/bench/check.sh" --reps 5 --no-ratchet
      ;;
  esac
else
  # Bench is tier 3 only; count it as tier-skipped so the summary is honest.
  SKIPPED_TIER=$((SKIPPED_TIER+1))
fi

# --- summary ---
# The final line names the tier and what was skipped, so a tier-1
# PASS can never be mistaken for a full PASS.
RUN_END=$(date +%s)
RUN_ELAPSED=$((RUN_END-RUN_START))
echo
case "$TIER" in
  1) TIER_NAME="tier 1 (quick)" ;;
  2) TIER_NAME="tier 2 (broad)" ;;
  3) TIER_NAME="tier 3 (full)" ;;
esac
if [ -n "$ONLY" ]; then TIER_NAME="$TIER_NAME --only $ONLY"; fi
echo "PASS $TIER_NAME — $RAN sections ran, $TOTAL_OK OK, ${RUN_ELAPSED}s; skipped $SKIPPED_RESUME via resume, $SKIPPED_TIER by tier/selection"
if [ "$TIER" -lt 3 ] && [ -z "$ONLY" ]; then
  echo "NOTE: tier $TIER is not the full suite — run './run.sh --tier 2' for broad coverage, './run.sh --full' before a release or ~once a day"
fi
echo "resume dir: $RESUME_DIR (progress.jsonl + logs/ + .done/)"
