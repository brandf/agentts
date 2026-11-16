# Combinators — `all` (collect-all + fail-fast bool), `any`, `race`
(Linear BRA-24, BRA-25, BRA-26)

The join, which the restore+eval experiment (BRA-23) did not build: the
host waits for the branch children, collects their results, and resumes
the parent snapshot with `JS_ResumeWith`, value = the joined outcome
array. Plus the fail-fast bool (BRA-25): `all([...], true)` returns bare
values on success and throws the first branch error at the call site,
siblings cancelled. Plus `any`/`race` (BRA-26): `any` returns the first
success's bare value and throws an `AggregateError` of all branch
errors if every branch fails; `race` returns or throws the first
settler's result. Still out of scope: cancellation (BRA-27).

## Result

**PASS — `all()` collect-all, the fail-fast bool, `any()`, and `race()`
work end to end.** Fork/direct test pairs, each byte-identical to its
straight-through reference (except `race([])`, which has no reference
— a straight-through run cannot complete either):

| test | what it proves |
| --- | --- |
| judges | 3 simulated judges via `all()`, one throws after scoring; the parent still gets every outcome, the failed branch as `{ ok: false, error }`; the aggregate step combines the verdicts (2 approved, 1 failed) |
| global state | branches read the fork-time snapshot; a branch write is discarded by construction — the parent's `sharedCount` is still 0 after the join; `all([])` returns `[]` with no fork and no suspension |
| nested `all()` | a branch that itself calls `all()` fans out again; the same suspend-snapshot-spawn-join machinery runs recursively, and the parent's verdicts still match |
| fail-fast bool | `all([...], true)` returns bare values in order on success; on the first branch error it throws that error at the call site (rehydrated as a real `Error`), the parent catches it, its finally block runs, and it keeps working — a further step succeeds; two branches failing proves firstness is journal order (the first failure's error wins, the later failure never runs); `all([...], false)` is collect-all, exactly like `all([...])` |
| any | the first success wins (bare value) — branch 0 fails, branch 1 succeeds, branch 2 never runs (its journal carries only a cancel event, trigger "loser in any"); all branches failing throws a real `AggregateError` holding both errors in branch order, caught with ordinary try/catch; `any([])` throws an `AggregateError` with no errors, immediately, with no fork |
| race | the first settler wins — branch 0's bare value on success, its error thrown on failure (rehydrated `Error`, caught, finally runs); the losers never run (their journals carry only cancel events, trigger "loser in race"); `race([])` never settles — a bounded drive confirms the run stays suspended with no join, no output, and no crash |

## Verdict evidence (`./run.sh`)

```
host built OK
=== judges (3 simulated judges, one throws) ===
verdicts: [{"ok":true,"value":"approved/verified"},{"ok":true,"value":"weak/retried"},{"ok":false,"error":{"name":"Error","message":"judge crashed"}}]
aggregate: {"approved":2,"failed":1,"summary":"2 approved, 1 failed"}
OUTPUT MATCH: parent byte-identical to direct reference
=== global state (branch write discarded) ===
verdicts: [{"ok":true,"value":"read:0"},{"ok":true,"value":"read:99"},{"ok":true,"value":"read:0"}]
empty all: []
sharedCount after join: 0
OUTPUT MATCH: parent byte-identical to direct reference
=== nested all() (branch fans out again) ===
verdicts: [{"ok":true,"value":"approved/nested=[{\"ok\":true,\"value\":\"approved\"},{\"ok\":true,\"value\":\"approved\"}]"},{"ok":true,"value":"weak/retried"}]
OUTPUT MATCH: parent byte-identical to direct reference
=== fail-fast bool on all() ===
values: ["approved/verified","weak/retried"]
collected false: [{"ok":true,"value":"approved/verified"},{"ok":false,"error":{"name":"Error","message":"judge crashed"}}]
caught is Error: true
finally ran
caught: judge crashed
continued: {"score":0.9,"label":"approved"}
first failure: judge timed out
OUTPUT MATCH: parent byte-identical to direct reference
=== any (first success wins; all-fail throws AggregateError) ===
winner: approved/verified
all-fail is AggregateError: true
all-fail errors: ["judge crashed","judge timed out"]
empty any is AggregateError: true
empty any errors: 0
OUTPUT MATCH: parent byte-identical to direct reference
=== race (first settler wins; failure throws) ===
winner: approved/verified
caught is Error: true
finally ran
caught: judge crashed
OUTPUT MATCH: parent byte-identical to direct reference
=== race([]) never settles (bounded drive) ===
parent suspended at race([])
FORK OK: 0-branch race fork, no children
BOUNDED DRIVE OK: still suspended, no join, no output, no crash — race([]) never settles
PASS combinator (collect-all + fail-fast + any/race)
```

Parent snapshots: 14,635 / 14,708 / 15,004 bytes at the fork (collect-all
tests); 15,638 bytes at the first fail-fast fork; 15,236 bytes at the
first `any` fork, 14,952 at the first `race` fork. The parent snapshot is
untouched by the children (sha256 checked before forking vs before the
join; children work on copies).

## How it works

- `host.c` extends the restore+eval host (`reval.c`) with a `join` mode
  plus exit code 3 (suspended at a combinator, vs 2 for a step). The
  `all` builtin stashes the thunks under a fresh Symbol key, journals
  the fork event, and suspends; the driver (`drive.py`) reads the fork
  event from the parent journal, spawns one child per branch, and joins
  with `host join <parent.snap> <branch outcome files...>`, which
  resumes the parent with the joined outcome array.
- Branch results are outcome objects: a branch that returns gives
  `{ ok: true, value }`; a branch that throws gives
  `{ ok: false, error }`, where the error is the Q13 `{ name, message }`
  record for an `Error` (a thrown non-`Error` crosses as-is). The
  branch child writes its outcome file and exits 0 — a failed outcome
  is a normal branch completion for collect-all, so `all([...])` never
  throws for a branch failure.
- Fail-fast is the same machinery with a different join. `all` takes an
  optional boolean second argument (omitted or `false` is collect-all);
  the fork event records it (`"failFast": true|false`). On success the
  driver unwraps the outcomes to bare values and joins with those, so
  the parent receives `["approved/verified", ...]`, not outcome
  objects. On the first branch error the driver stops spawning
  siblings, writes a cancel event into each remaining sibling's
  journal, and calls `host join-throw <snap> <record.json>`, which
  journals the join event (failed branch, error, cancelled list,
  completed outcomes) and resumes the parent with `JS_ResumeWith`
  throw flag set — the error rehydrated from its `{ name, message }`
  record into a real `Error`, so the parent's `catch (e)` sees
  `e instanceof Error`. The parent catches it with ordinary try/catch,
  its finally blocks run, and the run itself is NOT cancelled — the
  next step suspends and resumes normally. Which error is first is
  decided by journal order: the driver trips on the first failing
  branch outcome it records, and the join event names that branch.
- `any`/`race` are the same builtin shape with a different join
  (BRA-26). The fork event records `"kind": "any"` / `"kind": "race"`
  (no `failFast` field). `any` joins with `host join-value <snap>
  <record.json>` on the first success — the record carries the winner's
  bare value, the winner branch, the cancelled losers, and the failed
  outcomes that ran before the winner — or with `host join-aggregate
  <snap> <record.json>` if every branch failed, which rehydrates each
  branch error and resumes the parent throwing a real `AggregateError`
  (built by calling the global `AggregateError` constructor from C).
  `race` joins the same way on success, and with the existing
  `join-throw` on failure. The losers' journals get cancel events with
  trigger "loser in any" / "loser in race" and the winner branch.
  `any` and `race` were appended to the host's native registry after
  `all`, so the existing natives keep their indices.
- Empty lists follow Promise: `all([])` returns `[]` and `any([])`
  throws an `AggregateError` with no errors, both immediately with no
  fork and no suspension; `race([])` suspends on a 0-branch fork and
  never settles — the driver has nothing to spawn and nothing to join,
  so a bounded drive observes it still suspended
  (`drive(..., allow_unresolved=True)`) instead of joining. There is no
  direct reference for `race([])`: a straight-through run cannot
  complete either.
- The stash is removed on every resume path (Q13): the branch child
  deletes the symbol-keyed entry after taking the thunks (so a nested
  fork's stash cannot be confused with the outer one), and the join
  deletes it before resuming the parent. `join-value` and
  `join-aggregate` delete it too.
- Run context lives in heap globals (`__run_id`, `__journal_path`,
  `__fork_count`, `__step_count`, `__branch_index`, `__parent_fork`,
  `__outcome_path`), set from the environment by the run/branch modes
  and carried by the snapshot afterwards. Fork ids are
  `(run id, ordinal)`; child run ids derive from the fork id.

## The journal (minimal, shape-proving — not M1's full journal)

One JSON object per line, append-only. Parent journal (`run-judges.journal`):

```json
{"type":"fork","runId":"run-judges","forkId":"run-judges/fork-0","kind":"all","branches":3,"childRuns":["run-judges/fork-0/branch-0","run-judges/fork-0/branch-1","run-judges/fork-0/branch-2"]}
{"type":"join","runId":"run-judges","forkId":"run-judges/fork-0","outcome":[{"ok":true,"value":"approved/verified"},{"ok":true,"value":"weak/retried"},{"ok":false,"error":{"name":"Error","message":"judge crashed"}}]}
{"type":"step","runId":"run-judges","ordinal":0,"input":{"op":"aggregate","verdicts":[...]}}
{"type":"step-result","runId":"run-judges","ordinal":0,"result":{"approved":2,"failed":1,"summary":"2 approved, 1 failed"}}
```

Each child journal records the parent fork id (`branch-start` /
`branch-done` carry `parentForkId`); the nested fork is recorded the
same way in the branch's journal, so the whole execution is a tree of
journals linked by run ids. For a fail-fast fork the join event has a
second shape — no `outcome`, the thrown error and which branch failed
first instead — and each cancelled sibling's journal carries a cancel
event. Parent journal (`run-failfast.journal`, forks 2 and 3):

```json
{"type":"fork","runId":"run-failfast","forkId":"run-failfast/fork-2","kind":"all","branches":3,"failFast":true,"childRuns":["run-failfast/fork-2/branch-0","run-failfast/fork-2/branch-1","run-failfast/fork-2/branch-2"]}
{"type":"join","runId":"run-failfast","forkId":"run-failfast/fork-2","failedBranch":1,"error":{"name":"Error","message":"judge crashed"},"cancelled":[2],"completed":[{"ok":true,"value":"approved/verified"}]}
{"type":"step","runId":"run-failfast","ordinal":0,"input":{"op":"score","value":11}}
{"type":"step-result","runId":"run-failfast","ordinal":0,"result":{"score":0.9,"label":"approved"}}
```

Cancelled sibling's journal (`run-failfast/fork-2/branch-2`, whole file —
it never ran, so there is no `branch-start`):

```json
{"type": "cancel", "runId": "run-failfast/fork-2/branch-2", "parentForkId": "run-failfast/fork-2", "branch": 2, "trigger": "sibling failed with fail-fast on", "failedBranch": 1, "error": {"name": "Error", "message": "judge crashed"}}
```

Note the step after the fork-2 join: the parent caught the throw and
called a further step, which is how the journal proves the run itself
was not cancelled — only the siblings were.

For `any`/`race` the join event has two more shapes. Parent journal
(`run-any.journal`):

```json
{"type":"fork","runId":"run-any","forkId":"run-any/fork-0","kind":"any","branches":3,"childRuns":["run-any/fork-0/branch-0","run-any/fork-0/branch-1","run-any/fork-0/branch-2"]}
{"type":"join","runId":"run-any","forkId":"run-any/fork-0","outcome":"approved/verified","winner":1,"cancelled":[2],"completed":[{"ok":false,"error":{"name":"Error","message":"judge crashed"}}]}
{"type":"fork","runId":"run-any","forkId":"run-any/fork-1","kind":"any","branches":2,"childRuns":["run-any/fork-1/branch-0","run-any/fork-1/branch-1"]}
{"type":"join","runId":"run-any","forkId":"run-any/fork-1","aggregate":true,"errors":[{"name":"Error","message":"judge crashed"},{"name":"Error","message":"judge timed out"}],"completed":[{"ok":false,"error":{"name":"Error","message":"judge crashed"}},{"ok":false,"error":{"name":"Error","message":"judge timed out"}}],"cancelled":[]}
```

Parent journal (`run-race.journal`):

```json
{"type":"fork","runId":"run-race","forkId":"run-race/fork-0","kind":"race","branches":3,"childRuns":["run-race/fork-0/branch-0","run-race/fork-0/branch-1","run-race/fork-0/branch-2"]}
{"type":"join","runId":"run-race","forkId":"run-race/fork-0","outcome":"approved/verified","winner":0,"cancelled":[1,2],"completed":[]}
{"type":"fork","runId":"run-race","forkId":"run-race/fork-1","kind":"race","branches":2,"childRuns":["run-race/fork-1/branch-0","run-race/fork-1/branch-1"]}
{"type":"join","runId":"run-race","forkId":"run-race/fork-1","failedBranch":0,"error":{"name":"Error","message":"judge crashed"},"cancelled":[1],"completed":[]}
```

A loser's journal (`run-race/fork-0/branch-1`, whole file — it never ran,
and it would have failed if it had, which is the check that the losers
were cancelled, not executed):

```json
{"type": "cancel", "runId": "run-race/fork-0/branch-1", "parentForkId": "run-race/fork-0", "branch": 1, "trigger": "loser in race", "winner": 0}
```

`race([])` leaves only its fork event (`run-race-empty.journal`, whole
file — no join event, ever):

```json
{"type":"fork","runId":"run-race-empty","forkId":"run-race-empty/fork-0","kind":"race","branches":0,"childRuns":[]}
```

## Notes and edges

- In collect-all the error inside an outcome object stays a plain
  `{ name, message }` record (data, not a thrown `Error`); rehydration
  to `Error` applies where a combinator *throws* a branch error
  (fail-fast, `race` failure). Rehydration keys on the record shape —
  an object with string `name` and `message` — so a branch that throws
  a plain object that happens to have exactly those two string fields
  would be rehydrated as an `Error` too; a thrown non-object crosses
  as-is. `join-aggregate` rehydrates each branch error the same way,
  so a thrown non-`Error` appears in the `AggregateError`'s `.errors`
  as-is. `AggregateError` is a real global in this QuickJS (verified
  with the `qjs` binary: constructor, `instanceof`, `.errors`).
- In this experiment the driver runs branches sequentially, so for
  `race` the first branch is always the first settler — the test proves
  the join/cancel/journal mechanics for both settle outcomes, not
  time-based racing. True racing (a later branch settling first) needs
  the real scheduler (M3). The same sequential shape is why `any`'s
  "first success" is first in branch order here, and why fail-fast
  firstness is journal order.
- `any([])` throws synchronously from the builtin — no fork event, no
  suspension — so the empty case is covered by the same fork/direct
  pair as the rest of `any`. `race([])` has no direct reference at
  all: a straight-through run cannot complete either, so the test is
  standalone (bounded drive, no resolution, no crash).
- Sibling cancellation in this experiment is the scheduler refusing to
  (re)spawn the remaining siblings, recorded in their journals. The
  driver runs branches sequentially, so at the moment the first failure
  lands no sibling process is live to kill — there is nothing to
  SIGKILL. In the real engine the same decision kills live child
  processes (Q14); making the kill literal here would need long-lived
  child processes, which the host's one-slice-per-invocation shape does
  not have. The recorded facts — join event naming the failed branch,
  cancel events in the siblings' journals, cancelled siblings never
  starting — are the same either way.
- `all([])` returns `[]` immediately, with no fork event and no
  suspension (Promise.all([])) — fail-fast or not.
- The direct references model the specified semantics explicitly: the
  global-state reference saves/restores `sharedCount` around each
  branch, because a naive sequential run would leak the write into the
  parent — which is exactly the difference the discard rule exists to
  prevent.
- `JS_ResumeWith` returns the resumed execution's completion value when
  it completes (verified in source: it returns `js_resume_frame(...)`),
  which is what lets the join mode write a branch's outcome when a
  branch completes inside a nested join.
- A thunk returning `undefined` would lose its `value` key through the
  JSON round-trip (`JSON.stringify` omits it) — the JSON-able-results
  constraint, same as step results. Not exercised here; all test thunks
  return strings.

## Files

- `host.c` — host (`run` / `resume` / `branch` / `join` / `join-value`
  / `join-throw` / `join-aggregate` modes)
- `Makefile` — builds against the patched minimal dquickts tree
  (`~/workspace/dquickts-build-minimal`, BRA-42 `JS_AbandonSuspended`)
- `run.sh` — entry point; builds and runs `drive.py`
- `drive.py` — driver (mock steps, fork children from the journal,
  join / join-value / join-throw / join-aggregate, bounded drive for
  `race([])`) and all checks; exits non-zero on any mismatch
- `workflow-judges.ts` / `workflow-judges-direct.ts` — JudgeFixLoop shape
- `workflow-global.ts` / `workflow-global-direct.ts` — global-state rule
- `workflow-nested.ts` / `workflow-nested-direct.ts` — nested `all()`
- `workflow-failfast.ts` / `workflow-failfast-direct.ts` — fail-fast
  bool: bare values, throw + catch + finally + continue, firstness
- `workflow-any.ts` / `workflow-any-direct.ts` — first success wins,
  all-fail `AggregateError`, empty `any([])`
- `workflow-race.ts` / `workflow-race-direct.ts` — first settler wins,
  failure throws + catch + finally
- `workflow-race-empty.ts` — `race([])` never settles (no direct
  reference; bounded drive only)

## Run it

```sh
./run.sh   # PASS combinator (collect-all + fail-fast + any/race)
```
