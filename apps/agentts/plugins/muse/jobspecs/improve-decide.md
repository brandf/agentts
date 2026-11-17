# Job spec: improve-decide

Decide whether (and what) fixes are needed, from the aggregated
feedback. A decision, not a judgement — apply the rule below, do not
re-score or re-read the item.

## Input

```json
{ "aggregated": { "findings": [{ "id": "finding-concrete-numbers", "severity": "major", "...": "..." }], "dropped": [...], "meanScore": 0, "summary": "..." },
  "round": 1 }
```

## The rule

- `needsFix` is true when ANY finding is "blocking" or "major".
  "nit" and "minor" findings never trigger a fix on their own.
- When `needsFix` is true, `fixes` is one entry per blocking/major
  finding: `{findingId: <id>, action: <the finding's suggestion>}`.
  `reason` is `"<n> finding(s) need fixes: <id1>, <id2>, ..."`.
- When `needsFix` is false, `fixes` is empty and `reason` is "no
  blocking/major findings — no fixes needed".

`round` is informational (which loop round this decision is for); it
does not change the rule.

## Output

```json
{ "needsFix": true,
  "fixes": [{ "findingId": "finding-concrete-numbers", "action": "Address the \"concrete numbers\" criterion: ..." }],
  "reason": "3 finding(s) need fixes: finding-concrete-numbers, finding-worked-example, finding-clear-recommendation" }
```

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
