# Job spec: improve-aggregate

Aggregate, de-duplicate and filter the two judges' scorecards into
one feedback set. Pure reduction — no judgement, no re-scoring, no
new opinions.

## Input

```json
{ "scorecards": [{ "judge": 0, "axisScores": [...], "findings": [...], "summary": "..." },
                 { "judge": 1, "axisScores": [...], "findings": [...], "summary": "..." }],
  "failed": 0 }
```

`scorecards` are the successful judges' scorecards; `failed` is how
many judge branches failed outright (their errors are outcomes, not
scorecards, and are NOT in this list).

## How to aggregate

- **Dedupe by finding id** (keep the first occurrence, drop the rest
  as `{finding, reason: "duplicate"}`). The two judges critique the
  same item, so they usually find the same issues.
- **Filter nits when any blocking/major finding exists**: a "nit"
  finding is dropped with reason "nit filtered: higher-severity
  findings present". When there is no blocking/major finding, nits
  are kept (they are all there is).
- `meanScore` is the mean over scorecards of the weighted axis means
  — recompute each scorecard's weighted mean from its axisScores and
  its judge index (judge j doubles axis j), then average, rounded to
  two decimals (0 when there are no scorecards).
- `summary` is `"<findings> findings, <dropped> dropped, mean
  <meanScore>"` where `<findings>` is the kept count and `<dropped>`
  is the dropped count.

## Output

```json
{ "findings": [{ "id": "finding-concrete-numbers", "criterion": "concrete numbers", "severity": "major", "detail": "...", "suggestion": "..." }],
  "dropped": [{ "finding": { "id": "finding-concrete-numbers", "...": "..." }, "reason": "duplicate" }],
  "meanScore": 0,
  "summary": "3 findings, 3 dropped, mean 0" }
```

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
