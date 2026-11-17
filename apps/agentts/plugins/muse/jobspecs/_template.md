# Job spec: <spec-name>

<!-- Template for a new job spec. A spec is prose about the work, not
about the tools: the worker adapts it to its own environment. One
file per spec, named <spec>.md, in plugins/muse/jobspecs/. The server
serves it at GET /jobspec?spec=<spec> and reports its sha256 so
workers read it only when the hash changed.

Idempotency (BRA-61): declare the re-queue policy with this line
when a re-run is NOT safe — a job that already performed a side
effect (sent something, published, charged, wrote outside its own
workspace). On lease expiry such a job FAILS instead of re-queuing,
so the coordinator/human decides. Omit the line (or write
`idempotent`) and the job re-queues as before — the default is
idempotent. Pure computation (judging, aggregating, revising text
whose effects are returned, not applied) is idempotent. -->
<!-- idempotency: idempotent -->

## What this job does

(One paragraph: what a single instance of this job produces from its
input, and what "done" looks like.)

## Input

```json
{ "...": "..." }
```

(Field-by-field: what each input field means. Name the shapes; a
worker that has to guess the input shape will guess wrong.)

## How to do it

(Numbered steps a competent worker can follow without asking. Name
the exact rules, thresholds, and edge cases — e.g. what counts as
addressed, how ties break, what to do when a field is missing.
Deterministic beats clever: the same input should give the same
output from any worker.)

## Output

```json
{ "...": "..." }
```

(Exact output shape. The host validates the result against the
workflow's type for this trap — a wrong shape throws a
ValidationError at the call site and the work is wasted.)

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
