# Restore+eval experiment (Linear BRA-23)

The one unverified step of the parallel-steps design (plan doc Q13):
can a runtime restored from a dquickts snapshot accept a fresh eval
while a suspended execution sits in it?

## Result

**PASS — with a design correction.** The driver eval works on the
restored runtime and the thunk's steps suspend/resume across processes,
but only after the child first abandons the parent's suspended
execution. As specified (no abandon step), the experiment FAILS: the
thunk's first `step()` throws `TypeError: this call cannot be suspended`.
The correction, its mechanism, and what it means for the engine are
below; the experiment code implements the corrected shape.

## What was tested

- Parent workflow (`workflow-fork.ts`) calls `all([() => judgePath(7),
  () => judgePath(3)])`. The `all` builtin stashes the thunks array
  under a fresh Symbol key (`agentts:stash`) on the global object —
  exactly the hidden spot Q13 specifies — and suspends via
  `JS_SuspendCall`. The host snapshots (14,157 bytes) and exits.
- Each child loads a COPY of the parent snapshot and, instead of
  resuming the suspended `all` call, evals a driver (`__stash[i]()`)
  that pulls its thunk from the stash and calls it as a top-level
  execution. The thunk runs two mock steps (`score`, `verify`) with
  canned results, suspending/resuming across processes like any other
  workflow.
- The straight-through reference (`workflow-direct.ts`) runs the same
  thunk bodies directly, with no combinator.

## Verdict evidence (`./run.sh`)

- Direct run: exit 0, prints
  `branch 0 result: "approved/verified"` and
  `branch 1 result: "weak/retried"`.
- Parent: exit 2 (suspended at `all`), snapshot 14,157 bytes.
- Branch 0 and branch 1: exit 0, each printing its result line.
- Concatenated branch outputs are **byte-identical** to the direct run
  (`cmp` passes).
- The parent snapshot file is **untouched** by the children (sha256
  checked before/after; children work on copies).

## The failure as specified, and the correction

As specified, the child evals the driver on the restored runtime while
the parent's `all()` suspension is still pending. The driver runs and
the thunk runs — but the thunk's first `step()` throws:

```
[host] step({"op":"score","value":7}) — suspending
exception: TypeError: this call cannot be suspended
```

Root cause, read in engine source (`quickjs.c`, `js_can_suspend_from`):

```c
if (rt->suspended || !sf)
    return FALSE; /* only one suspended execution at a time */
```

While the parent's execution is suspended, no new suspension is
possible — `JS_SuspendCall` throws. The driver-eval shape itself
satisfies the suspend rule (driver evaluated by the host = HOST entry,
thunk called from it = DIRECT frames, all normal); the blocker is
only the single-suspension slot already being occupied.

Correction implemented in `reval.c` (`branch` mode): the child first
abandons the parent's suspended call with
`JS_ResumeWith(ctx, "abandoned: ...", throw_flag=1)`, letting the
parent workflow unwind in this scratch copy. The parent's own snapshot
file is untouched, so the host can still resume it at join time. After
the abandon, `suspended=0` and the driver's steps suspend/resume
normally. The log shows it:

```
[host] restored runtime suspended=1 before driver eval
[host] parent call abandoned (unwound with: abandoned: parent call
discarded in branch child); suspended=0
[host] global has 2 symbol-keyed properties
[host] symbol key: Symbol.toStringTag -> other
[host] symbol key: agentts:stash -> array (stash?)
[host] evaluating driver: __stash[0]()
```

(The other symbol key on the global is the well-known
`Symbol.toStringTag`; the stash is found as the array-valued one.)

## What the correction means for the engine

The resume-with-throw abandon is a stand-in, not the final mechanism:
it runs the parent workflow's unwind code in the child, so any
`catch`/`finally` around `all()` in the parent would execute there —
and a `catch`/`finally` that calls `step()` would suspend mid-unwind
in the child. The sound fix is a small addition to our vendored fork:
a public abandon API that drops `rt->suspended` (terminating the
suspended frames, as `js_abort_suspended_frames` already does on a
failed resume) without running any parent code. That is the follow-up
to file before `all` is implemented.

The fallback from Q13 stands unchanged: if abandoning proves
unworkable, branches become named top-level functions with JSON inputs
— branches as module functions the host invokes by name, using only
verified machinery (plain eval + suspend/resume, as in the dquickts
prototype). It costs closures-by-value: branch inputs must be JSON.

## Incidental findings

- `JS_SetProperty*` returns TRUE on success, -1 on failure. The first
  run of this experiment misread it as 0-on-success, so `all()` returned
  `JS_EXCEPTION` without suspending and the snapshot was never
  attempted. The misleading symptom was a snapshot "failure" whose
  printed exception was the suspension marker itself
  (`JS_TAG_CATCH_OFFSET`, which `JS_ToString` renders as
  `[unsupported type]`). Fixed by checking `< 0`.
- `JS_IsSuspended()` alone cannot tell whether a fresh eval suspended
  or failed while a suspension is already pending; `JS_IsSuspendException()`
  is the precise check (suspension marker vs real error).
- Snapshot bytes are not stable run to run (they embed random state /
  time origin); the parent-untouched check compares hashes within one
  run, not across runs.

## Files

- `reval.c` — experiment host (`run` / `resume` / `branch` modes)
- `Makefile` — builds against the minimal dquickts tree
  (`~/workspace/dquickts-build-minimal`, pinned commit 96a9a79)
- `run.sh` — drives the whole experiment and checks the result
- `workflow-fork.ts` — parent workflow (forks two judge branches)
- `workflow-direct.ts` — straight-through reference

## Run it

```sh
./run.sh   # PASS restore+eval
```
