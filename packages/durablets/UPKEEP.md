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

## Where the trees live

- `~/workspace/dquickts-build` — full checkout (git repo, HEAD at the
  pin). The BRA-42 patch sits here as an **uncommitted working-tree
  diff**; the saved `.patch` file next to this document is the durable
  copy, not this checkout.
- `~/workspace/dquickts-build-minimal` — trimmed tree (no `.git`),
  patch baked into its sources. This is what the DurableTS Makefile
  builds by default (`DQUICKTS=$(HOME)/workspace/dquickts-build-minimal`;
  see `Makefile`, "The engine tree is NOT modified").
- The trimming recipe is `experiments/dquickts-prototype/TRIM.md`:
  delete the fat (Python/C API, Rust bindings, qbun, examples, tests,
  Intl/Temporal), keep `python/opcode.h`, `compat/`, `repl.js`,
  `LICENSE`, `README.md`, `VERSION`, `Makefile`.

## Tracking upstream

Monthly, the owner runs:

```sh
git ls-remote https://github.com/stencil-hq/dquickts HEAD
```

and watches for:

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

1. Clone upstream, check out the new pin (never an unpinned HEAD).
2. Apply the TRIM.md recipe to produce a fresh minimal tree.
3. Apply `dquickts-bra42.patch` (`git apply --check` first; if it
   no longer applies cleanly, the patch must be rebased by hand and
   the new diff saved back here — do not ship a tree with a silently
   dropped patch).
4. Build: `make CONFIG_PYTHON= CONFIG_PYTHON_CAPI=
   CONFIG_TEMPORAL_INTL= qjs libquickjs.a` (~1m25s on this VM).
5. Prove the new tree: rebuild the DurableTS host against it and run
   the staged `./run.sh` end to end (reference suite, mock suite,
   host suite, profiler, checker, swap test 30/30). A re-vendor that
   does not pass the full run is not a re-vendor.
6. Update the pin in this document and in TRIM.md, and record the
   re-vendor (commit, date, reason) on BRA-31.

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
