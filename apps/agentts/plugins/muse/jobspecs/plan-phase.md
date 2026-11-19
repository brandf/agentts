# Job spec: plan-phase

Execute one agent phase of a plan-driven-work run and return its
execution record. The record is the phase's result: the template
reviews it against the phase's acceptance criterion, so the
evidence must be computed from the actual input — never canned,
never a claim about work that did not happen.

<!-- idempotency: idempotent -->

## Input

```json
{ "phase": { "name": "summarize-baseline", "description": "Summarize the survey baseline into the run record",
    "acceptance": "baseline summary recorded", "kind": "agent", "dependsOn": ["survey-outbox", "record-baseline"] },
  "prior": [
    { "phase": "survey-outbox", "status": "executed", "ok": true,
      "evidence": "delivery-run-001.json\ndelivery-run-002.json",
      "detail": "command exit 0, 42 chars stdout" } ] }
```

- `phase` must have a non-empty string `name`, a non-empty string
  `description`, a non-empty string `acceptance`, and kind
  `"agent"`. A phase of any other kind reaching this job is a
  workflow bug — throw an error naming the phase and its kind
  (command phases never reach this job; the template routes them
  to the `exec` trap).
- `prior` is the array of execution records of the already-executed
  phases, in execution order (empty for first-wave phases). Each
  record carries `phase`, `status`, `ok`, `evidence`, `detail`.

## How to execute

- Validate the phase first — a phase without a name, description,
  or acceptance criterion fails loudly (throw an error naming the
  problem) before any record is built.
- Do the phase's work. In v0 the worker is a deterministic
  stand-in: it produces the execution record below (validation, a
  content hash of the phase, and a summary of the prior phases'
  results — the context the phase builds on). A real worker agent
  does the phase's actual work and returns its result in the same
  record shape; the record shape is the contract, the work behind
  it is the worker's.
- The content hash is `sha256[0:12]` of the canonical JSON of the
  phase object — the same phase always yields the same hash.
- The evidence is computed from the actual input: the phase name,
  its description, the prior results (one `"<phase>: ok|FAILED —
  <detail>"` entry each, `"; "`-separated, or `No prior phases.`
  when `prior` is empty), and the content hash. It must name what
  the phase did — the phase-review loop judges the acceptance
  criterion against this text.

## Output

```json
{ "phase": "summarize-baseline", "status": "executed", "ok": true,
  "evidence": "Phase \"summarize-baseline\" executed via plan-phase: Summarize the survey baseline into the run record Prior results: survey-outbox: ok — command exit 0, 42 chars stdout. Content hash 9f2c41a0b7e1.",
  "detail": "plan-phase record 9f2c41a0b7e1" }
```

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
