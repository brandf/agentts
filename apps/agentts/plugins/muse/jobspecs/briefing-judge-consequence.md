# Job spec: briefing-judge-consequence

Score each paper's abstract for CONSEQUENCE — whether the paper
changes what is true, what works, or what to build. You are the LLM
judge: read the abstract (fetch it yourself when it is not in the
input — `https://arxiv.org/abs/<id>` or the arXiv API), think about
what the paper actually establishes, and score it. Do not score from
the title alone, and do not score from keyword matching: a paper
that says "benchmark" in the title but only runs its own method on
its own benchmark is not consequential.

## Input

```json
{ "papers": [
    { "id": "2611.22947",
      "title": "The Kernel Reality Check: ...",
      "abstract": "Full abstract text, or \"\" when the list page carried none — fetch it.",
      "score": 8,
      "topics": ["significance", "architecture-attention"],
      "reason": "significance(2), architecture-attention(1)" },
    ... ] }
```

`score` / `topics` / `reason` are the keyword topicScore — context
only, never the basis for your score. Score every paper in the
input; a missing verdict is a failure of the whole job, so if an
abstract cannot be fetched after two attempts, say so in that
paper's `error` field and give no score — do not invent one.

## How to score consequence (0-10)

Ask: does this paper change what is true, what works, or what to
build? Score the establishment, not the topic.

- **0-2**: incremental method/variation; no existing claim is
  tested; results are self-referential (beats its own baseline on
  its own benchmark).
- **3-4**: solid method or measurement; additive — does not
  challenge or change any existing claim.
- **5-6**: measures or compares against existing work in a way that
  constrains what is true (a benchmark, a careful ablation, a
  profiling study) — narrows the space without overturning anything.
- **7-8**: overturns, corrects, or relocates an existing claim — a
  benchmark audit showing a widely-used method does not do what is
  claimed; a diagnosis showing a failure lives elsewhere than
  assumed; a failed replication; a fix to a widely-used component.
- **9-10**: changes what the field should build or believe at scale
  — a result that invalidates a research direction, or a measurement
  that reorders priorities across many papers.

Calibration: most papers score 3-6; 8+ is rare; 9-10 exceptional.
When in doubt between two adjacent scores, take the lower one — the
ranking must not be inflated by generosity.

## Output

```json
{ "ok": true, "error": "",
  "scores": [
    { "id": "2611.22947", "consequence": 9,
      "reasons": "Benchmarks five efficient-attention methods against FlashAttention at scale and finds the claimed gains do not hold; overturns five years of linear-attention claims.",
      "evidence": "Abstract reports ... (quote the decisive sentence)." },
    ... ] }
```

`reasons` states the consequential claim in one or two sentences.
`evidence` quotes (or closely paraphrases, with the paper's own
numbers) the decisive sentence from the abstract. Every input paper
appears exactly once in `scores`, in input order.

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
