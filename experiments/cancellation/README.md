# Cancellation prototype (BRA-27)

Proves cancellation end to end, per plan doc §8 prototype 3 and
design Q14. The driver (`drive.py`) is the environment here: it
delivers step results, so it also delivers cancellations.

## Run it

```sh
./run.sh        # builds the host, drives all five scenarios
```

Exit 0 on PASS, 1 on any mismatch. The host builds against the
patched minimal dquickts tree (`~/workspace/dquickts-build-minimal`,
`JS_AbandonSuspended`).

## What is proved (one scripted scenario each)

1. **Cancel a pending step** (`workflow-cancel-step.ts`). The driver
   lets the workflow suspend at the step, then delivers a
   cancellation instead of a result. The workflow sees a
   `CancellationError` at the step call site (a real `Error`,
   `instanceof Error` is true), its `finally` block runs, and the
   journal records the cancellation event — what (`step`, ordinal 0),
   when (epoch seconds), why (`reason: "user abort"`), trigger
   (`"user abort"`). No `step-result` ever appears for the cancelled
   step.
2. **Cancel a whole `all()` in flight**
   (`workflow-cancel-combinator.ts`). Three branches, each suspended
   at its first step when the driver cancels the parent combinator
   and each child. The `all()` call throws a `CancellationError` at
   the call site, the parent's `finally` runs, and no join event
   appears — the fork was cancelled, not joined. Each child's journal
   records a cancel event (trigger `"parent cancelled"`, parent fork
   id, branch index) and the child catches its own cancellation,
   returning `"cancelled:CancellationError"` as a successful outcome.
3. **Sticky cancellation** (`workflow-sticky.ts`). After the cancel,
   the workflow's next `step()` call and its next `all()` call both
   throw `CancellationError` immediately — no dispatch, no
   suspension, no fork. The journal has exactly one step event
   (ordinal 0) and no fork event at all.
4. **Cancel-versus-complete race** (`workflow-race-order.ts`, both
   orders). Result-first: the driver delivers the first step's
   result, then cancels the second step — the first result is kept,
   and the journal shows the `step-result` recorded before the
   cancel event. Cancel-first: the driver cancels the first step
   before any result arrives — no `step-result` ever appears, and
   the run is sticky afterwards, so the second step also throws at
   once. Whichever is recorded in the journal first wins.
5. **Nested propagation** (`workflow-nested-cancel.ts`). The parent
   forks `all()` with two branches; branch 0 fans out again (its own
   `all()` with two sub-branches); branch 1 does one step. The
   driver cancels the whole tree deepest-first: grandchildren, then
   branch 0, then branch 1, then the parent. Every journal (parent,
   both branches, both grandchildren) records exactly one cancel
   event. Branch 0 and the grandchildren do not catch the
   cancellation, so their outcomes are failed `CancellationError`s;
   branch 1 catches it and returns cleanly. No join event appears
   in the parent's or branch 0's journal.

## How it works

### `host cancel <snap> <cancel.json>`

Restores a snapshot suspended at a step or a combinator, journals
the cancel event, sets the run's cancellation token, deletes the
stash (Q13: removed on every resume path), and resumes the suspended
wait with `JS_ResumeWith` throw flag set, throwing a real
`CancellationError`. Then as `resume`: if the resumed execution
suspends again it saves (exit 2/3), if it completes it exits 0, and
if it throws uncaught in a branch run that is a failed outcome
(`{ ok: false, error: { name: "CancellationError", ... } }`), not a
host error.

The cancel record is JSON:

```json
{"reason": "user abort", "trigger": "user abort",
 "what": "step", "ordinal": 0}
{"reason": "user abort", "trigger": "parent cancelled",
 "what": "fork", "forkId": "run-x/fork-0",
 "cancelled": ["run-x/fork-0/branch-0", "..."],
 "parentForkId": "run-x/fork-0", "branch": 1}
```

The **reason** is the why, and it propagates unchanged down a
cancelled tree; the **trigger** is local to the event (`"user
abort"`, `"parent cancelled"`). Optional fields (`ordinal`,
`forkId`, `cancelled`, `parentForkId`, `branch`) are journalled
only when present. `"when"` (epoch seconds) is added by the host.

### The cancellation token (sticky)

`__cancelled` is a heap global, so it rides along in the snapshot.
`host cancel` sets it to 1 and stores the reason in
`__cancel_reason`. `step()` and `all()`/`any()`/`race()` check it
first: on a cancelled run they throw a `CancellationError`
immediately, without journaling a dispatch, forking, or suspending.
A branch starts uncancelled (`set_branch_context` resets the
token): cancellation of a branch arrives via the driver, never by
inheriting the parent's token.

### Cancel event shape

```json
{"type":"cancel","runId":"run-cancel-step","what":"step",
 "ordinal":0,"trigger":"user abort","reason":"user abort",
 "when":1794793832}
{"type":"cancel","runId":"run-x","what":"fork",
 "forkId":"run-x/fork-0","trigger":"user abort",
 "reason":"user abort","when":1794793832,
 "cancelled":["run-x/fork-0/branch-0","run-x/fork-0/branch-1"]}
```

One JSON object per line, same as the all-combinator journals. The
event is recorded before the workflow sees the throw, so journal
order decides the cancel-versus-complete race.

## Files

| File | What it is |
| --- | --- |
| `host.c` | Combinator host + the `cancel` mode and the sticky token |
| `drive.py` | Driver + checks: the run registry, `cancel_run` / `cancel_tree`, the five scenarios |
| `run.sh` | `./run.sh` — build + drive, exit non-zero on any mismatch |
| `workflow-cancel-step.ts` | Behavior 1 |
| `workflow-cancel-combinator.ts` | Behavior 2 |
| `workflow-sticky.ts` | Behavior 3 |
| `workflow-race-order.ts` | Behavior 4 (both scenarios) |
| `workflow-nested-cancel.ts` | Behavior 5 |
| `Makefile` | Builds `host` against the patched minimal tree |

## Result

```
PASS cancellation (pending step + whole combinator + sticky +
race both orders + nested tree)
```

## Notes / limits

- The driver runs children sequentially and cancels them by
  delivering `host cancel` to each suspended child snapshot; in the
  real engine the same decision kills live child processes (Q14).
- Cancelling stops the wait and asks the executor to stop, but does
  not undo effects already performed (Q14's honest limit) — no
  compensation here.
- A cancelled step is not retried (Q14, see Q10).
- Queued-step removal and per-executor abort signals are driver
  concerns in this experiment: the driver simply never delivers a
  result to a cancelled wait, and the host's sticky token refuses
  any further dispatch.
