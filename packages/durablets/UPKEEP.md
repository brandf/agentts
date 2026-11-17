# dquickts upkeep plan (M4, Linear BRA-31)

dquickts is the JavaScript engine under DurableTS: a fork of QuickJS
with durable execution (suspend / snapshot / resume). The DurableTS C
host (`src/durablets.c`) links `libquickjs.a` from a vendored copy of
the tree — the engine is never fetched at build time, so an upstream
stall costs us future fixes, not today's build. This document is the
upkeep plan BRA-31 requires: who owns the tree, what the pin is, how
upstream is tracked, how to re-vendor, what triggers a re-vendor or a
fork decision, and what happens if upstream stalls.

## Owner

**Brandon** (repo owner, sole maintainer). The owner:

- checks upstream monthly (see "Tracking upstream");
- decides re-vendor vs. stay on the pin;
- decides fork vs. move off (see "Triggers" below);
- keeps this document and the pin current when either changes.

There is no second maintainer today; if one appears, name them here.

## The pin

- **Upstream:** https://github.com/stencil-hq/dquickts
- **Pinned commit:** `96a9a79` (2026-11-11, "fix(arrays): removed all
  elements above a decreased sparse length"). Verified 2026-11-16:
  upstream HEAD is still `96a9a79` — no new commits since the pin.
- **QuickJS baseline:** dquickts tracks upstream QuickJS 2026-06-04
  (see the tree's `VERSION` file).
- **Local patch (BRA-42):** `JS_AbandonSuspended` — `+30` lines
  (`quickjs.c` +21, `quickjs.h` +9). It terminates a suspended
  execution without running its code; frames are released via
  `js_abort_suspended_frames()`, the same path a failed resume takes.
  The patch is **not upstream**. It is saved as
  `dquickts-bra42.patch` next to this file and must be re-applied on
  every re-vendor. Verified 2026-11-16: the patch applies cleanly to
  a pristine `96a9a79` clone (`git apply --check` passes; the patched
  function is present in `quickjs.c` ×2 / `quickjs.h` ×1 after apply).
  The patch is also a commit on the `agentts-patched` branch of the
  full checkout (`a9bd6ec`, on top of the pin; the commit diff is
  byte-identical to the `.patch` file). Re-vendor rebases that branch
  onto the new pin. Upstream issue:
  https://github.com/stencil-hq/dquickts/issues/19 (filed 2026-11-16;
  watched daily by cron `dquickts-issue-19-watch` through Dec 7,
  2026). If upstream accepts it, the patch file here is deleted and
  the pin moves to a commit that contains it.

## Where the trees live

- `packages/durablets/vendor/dquickts` — the vendored trimmed tree
  (no `.git`), patch baked into its sources. This is what the
  DurableTS Makefile builds by default (`DQUICKTS` defaults to this
  path; see `Makefile`, "The engine tree is NOT modified"). It is
  installed by `packages/durablets/re-vendor.sh` (which proves the
  candidate against the full suite before installing it), is
  gitignored, and is rebuilt per checkout — a fresh clone has no
  tree until `re-vendor.sh` runs. It carries a `VENDORED_FROM` stamp
  (upstream commit, patch, date, recipe).
- `~/workspace/dquickts-build` — Brandon's full checkout (git repo).
  `master` tracks upstream at the pin; the BRA-42 patch is a commit
  on the local branch `agentts-patched` (`a9bd6ec`, on top of the
  pin). The saved `.patch` file next to this document is the durable
  copy and the upstream-issue artifact; the branch is the working
  copy.
- `~/workspace/dquickts-build-minimal` — Brandon's VM-local
  production minimal tree (no `.git`), patch baked into its sources.
  Legacy working copy: `re-vendor.sh --swap` keeps it in sync with
  the vendored tree above, and it remains the fallback the host
  checks for the `VENDORED_FROM` stamp when no vendored tree is
  present. Nothing in the repo defaults to it any more.
- The trimming recipe is `experiments/dquickts-prototype/TRIM.md`:
  a keep-list (31 files) — the minimal tree is built by copying only
  those files out of a pristine checkout, so new upstream fat is
  excluded by default and a missing keep-list file fails loudly.

## Tracking upstream

Monthly, the cron `dquickts-upstream-check` runs (1st of the month,
~8am) and compares `git ls-remote https://github.com/stencil-hq/dquickts HEAD`
against the pin here. It reports to the AgentTS side chat only when
HEAD moved (with what changed and a re-vendor recommendation) or when
the 6-month stall signal is hit; silent otherwise. The owner still
decides re-vendor vs. stay on the pin. It watches for:

- **New commits** — anything since the pin, especially in
  `quickjs-snapshot.c`, the resume/suspend paths, and `VERSION`.
- **Snapshot-compatibility breaks** — a change to the snapshot
  format or to `JS_ResumeWith` / the snapshot ABI. Snapshots written
  by one engine version are not guaranteed to load under another;
  any such change forces a coordinated upgrade (re-vendor + snapshot
  migration, never a silent swap).
- **QuickJS version bumps** in `VERSION` (the fork tracks upstream
  QuickJS; a bump can bring behavior changes beyond dquickts itself).
- **Security fixes** in QuickJS that dquickts inherits.
- **Activity signals** — last commit date, open issues about
  suspend/snapshot. Silence here is the stall signal (see below).

## Vendoring procedure (re-vendor)

Scripted: `packages/durablets/re-vendor.sh <commit> [--swap]
[--dest <path>]`.
It clones upstream, checks out the pin (never an unpinned HEAD),
applies `dquickts-bra42.patch` (`git apply --check` first — if it no
longer applies cleanly, the patch must be rebased by hand and the new
diff saved back here; do not ship a tree with a silently dropped
patch), copies the TRIM.md keep-list into a candidate minimal tree,
builds it (`make CONFIG_PYTHON= CONFIG_PYTHON_CAPI=
CONFIG_TEMPORAL_INTL= qjs libquickjs.a`, ~1m25s on this VM), writes
the `VENDORED_FROM` stamp, and proves the candidate by running the
staged `./run.sh` end to end against it (`run.sh` forwards `$DQUICKTS`
to the durablets build for this; unset means the vendored tree, the
Makefile default). A re-vendor that does not pass the full run is not
a re-vendor: the candidate is only installed afterwards, into
`packages/durablets/vendor/dquickts` by default (`--dest` or
`$DQUICKTS_DEST` overrides). `--swap` additionally syncs the proven
candidate to the VM-local production minimal tree
(`~/workspace/dquickts-build-minimal`) and rebases `agentts-patched`
onto the new pin — skipped with a note when those trees do not exist.
Then, by hand: update the pin in this document (and in TRIM.md if
the recipe changed), and record the re-vendor (commit, date, reason)
on BRA-31.

Dry-run of this procedure at the current pin (`96a9a79`): run
2026-11-16 — PROVEN. Clone → patch (`git apply --check` clean) →
31 keep-list files → build → stamp → full staged `./run.sh` against
the candidate: exit 0, 1048 OK, 14 PASS, 0 failures. The candidate's
sources diffed identical to the current minimal tree (no
differences), so the recipe reproduces the tree exactly at the same
pin. Log `/tmp/re-vendor-dryrun.log`.

## Triggers

**Re-vendor** when any of these is true:

- upstream ships a fix for a bug we have hit, or a security fix in
  QuickJS we inherit;
- we need a newer QuickJS feature or a dquickts feature added
  upstream;
- a snapshot-compatibility break forces a coordinated upgrade;
- scheduled review: revisit the pin at least every 6 months even if
  nothing is broken.

**Fork decision** (freeze the vendored tree as our own and own the C
code) when any of these is true:

- upstream stalls: no commits for 6+ months **and** unanswered
  suspend/snapshot issues — the fork is effectively ours already;
- upstream changes direction (drops durable execution, or relicenses
  in a way we cannot follow);
- a re-vendor is blocked by an upstream regression with no fix
  forthcoming.

Forking costs the C surface we actually touch: the snapshot/resume
paths in `quickjs.c` plus `durablets.c`. That is a bounded burden,
not an open-ended one — the rest of QuickJS we consume as-is.

## If upstream stalls

Keep running on the pinned + patched tree. It works today, it is
vendored (not fetched), and a stall does not break any build. Do
**not** move off dquickts on stall alone. Moving off means
re-implementing suspend/snapshot on another engine (vanilla QuickJS
or V8) — a multi-week project — and is justified only if the pinned
tree develops an **unfixable defect** (a crash or correctness bug in
the suspend/snapshot path with no workaround in `durablets.c`).

**Contribute back** is preferred to carrying a private patch forever:
if we fix a bug in the fork, upstream a PR. `JS_AbandonSuspended`
(BRA-42) is the standing candidate — it generalizes beyond AgentTS.
If upstream accepts it, the patch file here is deleted and the pin
moves to a commit that contains it.

## What never to do

- Never point the Makefile at an unpinned upstream HEAD.
- Never fetch dquickts at build time; the build consumes the vendored
  tree only.
- Never re-vendor without re-applying the BRA-42 patch and running
  the full staged `./run.sh`.
