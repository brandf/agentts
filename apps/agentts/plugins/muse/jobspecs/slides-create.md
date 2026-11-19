# Job spec: slides-create

Build a presentation deck from an outline. Validate the outline
first — an invalid outline fails loudly (throw an error naming the
problem) before any deck is built; do not build a deck from an
outline that is not there.

## Input

```json
{ "title": "Quarterly review",
  "slides": [{ "title": "What shipped", "bullets": ["3 teams shipped in Q3"], "notes": "open with the win" }] }
```

- `title` must be a non-empty string.
- `slides` must be a non-empty array (at least one slide).
- Every slide must have a non-empty string `title` and a `bullets`
  array (which may be empty — an empty slide is a weak deck, not an
  invalid one; the review step's "complete" criterion catches it).
- `notes` is optional, a string.

## How to build

- The deck id is deterministic: `deck-<sha256[0:12] of
  "<title>\n<JSON.stringify(slides)>"` — the same outline always
  yields the same id. (v0: this is a local computation, not a live
  Google Slides call; the deck id names the deck the live adapter
  will create later.)
- Clean each slide: `title` as-is, `bullets` stringified, `notes`
  kept only when it is a string.
- The deck's `text` is the rendering the judges score against:
  the title, then per slide `Slide N: <title>` followed by one
  `- <bullet>` line per bullet, joined with newlines.
- `revisions` starts at 0.

## Output

```json
{ "deckId": "deck-9f2c41a0b7e1",
  "title": "Quarterly review",
  "slides": [{ "title": "What shipped", "bullets": ["3 teams shipped in Q3"] }],
  "text": "Quarterly review\nSlide 1: What shipped\n- 3 teams shipped in Q3",
  "revisions": 0 }
```

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
