# Job spec: aggregate

Reduce a set of judge verdicts to one aggregate score. Pure
reduction — no judgement, no re-scoring, no new opinions.

## Input

```json
{ "verdicts": [{ "score": 0.55, "label": "weak", "notes": "..." }],
  "failed": 0,
  "threshold": 0.8 }
```

`verdicts` are the successful judges' verdicts; `failed` is how
many judge branches failed outright (their errors are outcomes, not
verdicts, and are NOT in this list).

Two shapes share this spec across workflows; tell them apart by the
INPUT shape, not by guessing:
- **JudgeVerdicts** (`{score}`): reduce to a mean (this spec's main
  shape — see below).
- **Outcome objects** (`{ok: boolean}`): count ok/failed instead and
  return `{approved, failed, summary}` with NO meanScore field.

## How to aggregate (JudgeVerdict shape)

- `scores` = the verdicts' numeric scores (skip any verdict without
  a number).
- `meanScore` = the mean of scores, rounded to two decimals (0 when
  there are no scores).
- `approved` = how many scores are >= threshold.
- `failed` = the input's `failed` count (NOT verdicts.length -
  approved — the caller already counted branch failures).
- `summary` = `"<approved> approved, <failed> failed, mean <meanScore>"`.

## Output

```json
{ "approved": 0, "failed": 0, "meanScore": 0.55, "summary": "0 approved, 0 failed, mean 0.55" }
```

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
