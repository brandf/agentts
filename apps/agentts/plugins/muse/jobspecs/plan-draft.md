# Job spec: plan-draft

Draft a plan from a request and phase outlines: validate the
outlines, sequence the phases, render the plan text. The plan is
data, not prose — the review loop scores it structurally, so every
rule below must hold exactly.

<!-- idempotency: idempotent -->

## Input

```json
{ "request": "Prove the production deliver half end to end (BRA-110)",
  "context": "the production state dir already drives runs; the deliver half is unproven",
  "phaseOutlines": [
    { "name": "survey-outbox", "description": "List the delivery outbox",
      "acceptance": "delivery records listed", "kind": "command",
      "command": "ls", "args": ["-1", "/path/to/outbox"] },
    { "name": "record-baseline", "description": "Write the baseline record",
      "acceptance": "baseline written", "kind": "command",
      "command": "sh", "args": ["-c", "printf 'baseline\\n' > /path/to/baseline.txt"],
      "dependsOn": ["survey-outbox"] } ] }
```

- `request` must be a non-empty string.
- `phaseOutlines` must be a non-empty array (at least one phase).
- Every outline must have a non-empty string `name` (unique across
  the plan), a non-empty string `description`, and a non-empty
  string `acceptance` (a testable criterion for the phase — the
  phase-review loop judges the phase's evidence against it).
- `kind` is `"agent"` or `"command"`. A `"command"` phase must have
  a non-empty string `command` (and optional `args` / `cwd`). An
  `"agent"` phase must NOT carry a `command`.
- `dependsOn`, when present, must be an array of phase names listed
  EARLIER in the plan (a phase cannot depend on itself or on a
  later phase — that keeps the graph acyclic by construction). An
  omitted `dependsOn` means "the previous phase" (a serial chain);
  an explicit empty array means "no dependencies" (first wave).
- `context` is optional, a string.

## How to draft

- Validate first, in the order above — an invalid outline fails
  loudly (throw an error naming the problem) before any plan is
  built; do not draft a plan from outlines that are not there.
- Fill in `dependsOn`: omitted becomes `[<previous phase name>]`
  (or `[]` for the first phase); explicit values pass through.
- Do NOT fill in `reviewPoints` or `gatePlacement` — the
  JudgeFixLoop fix adds them, which is the plan loop's improving
  arc. A plan that already carries them converges in loop 1.
- Render `text`: the request, then one block per phase —
  `Phase N: <name> — <description>`, `  Executes via: agent
  (plan-phase)` or `  Executes via: command: <cmd> <args>`,
  `  Acceptance: <acceptance>`, `  Depends on: <names or "none">`
  — joined with newlines.
- `revisions` starts at 0.

## Output

```json
{ "request": "Prove the production deliver half end to end (BRA-110)",
  "context": "the production state dir already drives runs; the deliver half is unproven",
  "phases": [
    { "name": "survey-outbox", "description": "List the delivery outbox",
      "acceptance": "delivery records listed", "kind": "command",
      "command": "ls", "args": ["-1", "/path/to/outbox"], "dependsOn": [] },
    { "name": "record-baseline", "description": "Write the baseline record",
      "acceptance": "baseline written", "kind": "command",
      "command": "sh", "args": ["-c", "printf 'baseline\\n' > /path/to/baseline.txt"],
      "dependsOn": ["survey-outbox"] } ],
  "text": "Plan: Prove the production deliver half end to end (BRA-110)\nPhase 1: survey-outbox — List the delivery outbox\n  Executes via: command: ls -1 /path/to/outbox\n  Acceptance: delivery records listed\n  Depends on: none\nPhase 2: record-baseline — Write the baseline record\n  Executes via: command: sh -c printf 'baseline\\n' > /path/to/baseline.txt\n  Acceptance: baseline written\n  Depends on: survey-outbox",
  "revisions": 0 }
```

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
