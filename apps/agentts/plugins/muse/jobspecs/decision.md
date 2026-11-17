# Job spec: decision

<!-- A generic decision job: the job tier of decisionCascade
(apps/agentts/src/agentts.ts, BRA-47). One agent session answers one
decision — pick one of the given options — and reports its choice
with a SELF-REPORTED confidence. The cascade reads that confidence
field; it never infers one. Pure computation (no side effects):
idempotent. -->

<!-- idempotency: idempotent -->

## What this job does

Answer a single decision: choose exactly one option from the given
list for the given question, and report how confident you are in
that choice. The answer is a decision, not a judgement — do not
re-score, re-read, or re-argue the question; pick from the options
given.

## Input

```json
{ "question": "Should we converge or keep revising?",
  "options": ["converge", "revise"],
  "context": "Mean score 0.82, threshold 0.8, round 2 of the loop." }
```

- `question`: the decision to make, as one question. Answer THIS
  question — do not substitute a different one.
- `options`: the complete list of allowed choices. The choice MUST
  be one of these, spelled exactly as listed.
- `context` (optional): extra facts the caller wants the decider to
  weigh (scores, thresholds, prior attempts). It is background, not
  a second question.

## How to do it

1. Read the question and the options. If the question carries a
   machine-readable signal (a score vs. a threshold, a count vs. a
   limit), apply it: the option the signal points at is the choice.
2. If there is no decisive signal, weigh the context and pick the
   option the evidence best supports. Never invent a new option:
   when none of the options fits, pick the closest one and say so
   in `reason` — do not return an option that is not listed.
3. Set `confidence` to your honest self-reported confidence in the
   choice, 0–1. Calibrate it: 0.5 is a coin flip between the options,
   0.7 is a lean with real evidence behind it, 0.9 is near-certain.
   Do NOT report 1.0 — a single agent session is never certain —
   and do NOT inflate: an inflated confidence decides a cascade
   tier that should have escalated. When you are guessing, say so
   with a low number, not with a confident-sounding reason.
4. `reason` is one or two sentences: what decided it (the signal,
   the key fact) — not a restatement of the question.

## Output

```json
{ "choice": "converge",
  "confidence": 0.82,
  "reason": "Mean score 0.82 is above the 0.8 threshold." }
```

- `choice`: exactly one of the input `options`, spelled exactly as
  listed. The host validates the result against the workflow's type
  for this trap — a choice outside the options is an abstention in
  the cascade (the tier escalates), and the work is wasted.
- `confidence`: a number in [0, 1]. Outside that range the cascade
  treats the answer as an abstention.
- `reason` (optional): one or two sentences, the deciding fact.

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
