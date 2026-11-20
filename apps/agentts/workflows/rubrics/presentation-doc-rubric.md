# Presentation-Document Rubric (v0.1)

**Status:** v0.1, written Nov 19, 2026. The rubric that judges
presentation documents: a single-page visual companion to a
technical reference — diagrams, tables, and prose that explain a
system's architecture to a reader who may never open the reference.
It judges the page, not the system the page describes.

**How it is used:** `workflows/library/improve-loop.ts` reads this
file's criteria (as the JSON projection in
`presentation-doc-rubric.json`) and scores a page against it.
Threshold is a separate numeric input to the workflow (default
0.8), not something parsed from this file. The drafter reads this
rubric before drafting: it is written in plain actionable language
for the person building the page.

**Scale:** 0–10 per criterion. Every criterion defines what **0**,
**5**, and **10** mean. **Interpolate:** a score is not one of the
three anchors — a 7 means the page sits between the 5-anchor and
the 10-anchor, closer to 10; say in one line which side of each
anchor it falls on and why. Do not round to 0, 5, or 10 unless the
page genuinely matches an anchor exactly. Score each criterion
independently; a page can be beautiful and still fail accuracy.

## Scope

**In scope:** single-page presentation documents that explain a
system's architecture visually — a hero idea, layered diagrams,
a run-lifecycle stepper, tables, and an honest-limits section —
written as a companion to a technical reference the page cites.
The rubric judges the page as a companion: accuracy is judged
against the cited reference and the code it cites, everything
else from the page alone.

**Out of scope:** the technical reference itself (judged by its
own standards — a reference is not a presentation document);
slide decks (a different medium with its own workflow —
`workflows/library/presentations.ts`); marketing pages (their
job is persuasion, not explanation).

**Boundaries:** a claim the page makes about the system is judged
against the reference section it cites, not against the judge's
prior knowledge. A page that invents a claim the reference never
makes fails accuracy even if the claim is plausible. Visual
quality is judged at desktop and phone width — a page that
breaks at phone width fails visual clarity even if the desktop
render is flawless.

## Accuracy perspective

### Graded questions

**1. Accurate claims.** Does every factual claim on the page trace
to code or to a cited section of the reference — and do the
numbers (counts, timings, caps, versions) match the code as of
the stated alignment date?
- **0:** Claims that contradict the code or the reference, or
  numbers that are wrong (a stale count, a cap that changed, a
  gate that was narrowed). A reader who trusts the page is misled.
- **5:** Claims are broadly right, but one or two numbers are stale
  or a mechanism is described in its old form (an engine-version
  gate described as a full-version check after it was narrowed to
  a format identity).
- **10:** Every claim traces to code or a cited reference section,
  and every number matches the code as of the stated alignment
  date. The alignment date is on the page, and the page says what
  changed since it.

**2. Worked example.** Does the page show at least one concrete
worked example — code a reader can copy, in the real shape, with
the rules that make it work stated beside it?
- **0:** No worked example. The page describes the shape in prose
  only; a reader cannot see what a workflow actually looks like.
- **5:** An example is present but simplified past honesty — it
  omits a rule the real shape needs (a trap that cannot suspend
  in a callback, the JSON boundary), or the example would not run.
- **10:** A real example in the real shape, with the rules beside
  it — the entry shape, the trap boundary, what the host refuses.
  A reader can copy it and know what would break if they changed
  it.

### Open-ended questions

- Which claim on this page would a reader most likely act on
  wrongly, and what would the correct claim be?

## Completeness perspective

### Graded questions

**3. Complete coverage.** Does the page cover every major part of
the system — layers, run lifecycle, traps, worker pool,
scheduling, state on disk, portability, honest limits — with each
section covering its topic, not just its heading?
- **0:** A major part is missing entirely (no scheduling, no state
  layout, no limits) or a section is a heading with no content.
- **5:** All parts are present, but one is thin — a paragraph where
  the system needs a diagram, or a diagram with no explanation of
  what it shows.
- **10:** Every major part is present and covered to the depth its
  importance demands, including the subtle ones (the trap-dispatch
  split, the drive cap, the swap test). Nothing that matters is
  left to the reader's imagination.

### Open-ended questions

- What part of the system does this page leave a reader unable to
  explain after reading it?

## Honest-limits perspective

### Graded questions

**4. Limits stated.** Does the page state what is not built and
where the design stops, in the same voice as the rest — so no
section reads as if the system had no limits?
- **0:** No limits section, or limits are hidden in a footnote.
  The page reads as a sales document.
- **5:** Limits are listed, but softened — a limit stated as a
  future feature, or a known gap described as if it were already
  handled.
- **10:** Limits are stated plainly, each with what it costs the
  reader and what would change it. A limit the page corrects in a
  later revision is recorded as corrected, not silently rewritten.

**5. Known gaps.** Are known gaps named explicitly, with what is
unknown and what would settle it?
- **0:** No gap is named. The page implies everything is known.
- **5:** Gaps are named but without what would settle them — the
  reader knows something is unknown but not how it becomes known.
- **10:** Every known gap names what is unknown, what evidence
  would settle it, and who owns settling it. A gap the page hides
  is a gap the reader inherits.

### Open-ended questions

- What limitation would a careful reader discover the hard way,
  because this page does not state it?

## Visual-clarity perspective

### Graded questions

**6. Diagram clarity.** Is every diagram labeled, captioned, and
explained in the surrounding text?
- **0:** Diagrams with no labels, no captions, or captions that
  restate the title. A reader who cannot see the diagram gets
  nothing from the text around it.
- **5:** Diagrams are labeled and captioned, but the text does not
  say what the diagram is for — the reader sees the picture
  without knowing which question it answers.
- **10:** Every diagram carries a figure label, a caption that
  states what it shows, and surrounding text that says which
  question it answers. A reader who reads only the captions still
  gets the argument.

**7. Sections navigable.** Can the page be navigated by section —
sticky navigation, anchors, and headings that say what each
section answers?
- **0:** No navigation. A long page with no way to jump to a
  section, or headings that do not match the content beneath
  them.
- **5:** Navigation exists but is incomplete — some sections
  unreachable from the nav, or headings that describe the topic
  without saying what question the section answers.
- **10:** Every section is reachable from the navigation, every
  heading says what the section answers, and the order follows
  the reader's questions (idea first, mechanism second, limits
  last).

### Open-ended questions

- Where does the layout fight the reader — a diagram that needs
  scrolling to read, a table that overflows, a stepper that hides
  its content?

## Audience-fit perspective

### Graded questions

**8. Audience stated.** Does the page state who it is for and what
background it assumes, so a reader can tell in the first screen
whether it is written for them?
- **0:** No audience anywhere. A newcomer and an expert read the
  same page with no signal about which one it addresses.
- **5:** The audience is implied (a code sample assumes a
  developer) but never stated — the reader guesses from the
  vocabulary.
- **10:** The audience and assumed background are stated up front,
  in one place, in plain words. A reader outside the audience
  knows where to go instead.

**9. Prerequisites stated.** Are prerequisites stated — what the
reader is assumed to know before starting, and where to go if
they do not know it?
- **0:** No prerequisites. Terms appear with no definition and no
  pointer — the reader who lacks the background is stranded.
- **5:** Prerequisites are partly stated (one term defined, others
  assumed) or stated without a pointer to where to learn them.
- **10:** Prerequisites are stated with pointers — each assumed
  piece of background names where it is explained, in the
  reference or elsewhere.

### Open-ended questions

- Who would bounce off this page in the first minute, and what
  sentence would have kept them?

## Coverage, discrimination, calibration

Coverage: the nine criteria above score every quality dimension
that distinguishes a good presentation document from a bad one —
accuracy (claims, example), completeness (coverage), honest
limits (limits, gaps), visual clarity (diagrams, navigation),
audience fit (audience, prerequisites). Nothing that decides
good-vs-bad is left unscored.

Discrimination: real pages land across the scale. A page with
stale numbers and no limits scores mid-range; a page that is
accurate, complete, and honest scores high; a page that also
states its audience and prerequisites scores at the top. The
anchors say what the difference is.

Calibration: the threshold is 0.8, calibrated against reference
examples — the current architecture page passes (accurate except
for the stale claims this rubric's first run found, complete,
honest, clear, audience unstated), and a weakened copy with the
limits section removed and recovery overstated fails. The rubric
says why each lands where it does.

## Actionability, checkability, independence

Actionability: every failing score names the concrete change —
what to add, remove, or rewrite, and what the fixed version looks
like. A 3 on accurate claims names the stale number and the
current one; a 3 on audience stated names the sentence to add.

Checkability: every criterion is verifiable from the page itself,
except accuracy — which is checked against the cited reference
section and the code it cites, because a presentation document
cannot verify its own claims. No criterion depends on guessing
the author's intent. A criterion that cannot be checked from the
page plus its cited sources is not in this rubric.

Independence: the criteria are orthogonal. One flaw costs one
score — a stale number costs accurate claims, not complete
coverage; a missing limits section costs limits stated, not known
gaps (a page can state limits and still hide a gap, and vice
versa). No criterion can be derived from another.

## Open-ended feedback, drafter-shared

Open-ended feedback: judges give guided open-ended answers every
round — the questions under each perspective above, plus the five
guided questions below — and the feedback reaches the fix step
alongside the scores. The run result records it so a human can
read it.

Drafter-shared: this rubric is written in plain actionable
language for the person building the page — no scoring jargon the
drafter cannot use — and the workflow hands it to the draft step
before drafting begins. A drafter who reads this rubric knows
what to put on the page and what to leave out.

## Anti-patterns, versioning, no process in prose

Anti-patterns: the known failure modes for presentation
documents, each with its tell —
- **Stale numbers:** a count, timing, or cap that changed since
  the alignment date (tell: the alignment date is old, or the
  number disagrees with the reference).
- **Overstatement corrected in re-audit:** a claim the first build
  got wrong and a later audit fixed (tell: recovery described as
  automatic where the reference says a run waits for the
  coordinator).
- **Assertion as fix:** an appended sentence that asserts
  compliance ("Audience: this page states its audience") instead
  of demonstrating it (tell: the sentence names the criterion
  without adding the content the criterion asks for).
- **Color-only meaning:** a distinction carried only by color, so
  it vanishes for a reader who cannot see it (tell: the legend
  has no text labels beside the colors).
- **Mobile overflow:** content that scrolls the whole page
  sideways at phone width (tell: a table or diagram wider than
  the viewport with no contained scroll region).

Versioning: this rubric is a versioned file with a change log
below, and every judging record names the version used.

No process in prose: this rubric carries data only —
perspectives, graded questions with anchors, open-ended
questions. Nothing about how the judging happens; the workflow
owns all of that. There is no process in this prose.

## Multiple perspectives, signs of generality

Multiple perspectives: the rubric is organized into five distinct
perspectives — accuracy, completeness, honest limits, visual
clarity, audience fit — each with anchored graded questions and
open-ended questions. The perspectives are genuinely different
lenses on the page, not rewordings of one another: a judge
role-playing accuracy checks claims against code, while a judge
role-playing audience fit checks who the page is for.

Signs of generality: the criteria are written in class terms —
presentation documents that explain a system visually — not in
terms of this one page. Nothing references a specific instance
(no criterion names AgentTS, DurableTS, or any section of this
page). The claimed scope matches what the criteria cover: a
narrow rubric, judged on generalizing across its narrow class
(different architecture pages, not different kinds of document).
Validation: run Nov 19, 2026 — record in the BRA-167 report.
Round-1 scores are the measure; final convergence to 1.0 is not
evidence of quality.

## Guided open-ended questions (asked of every judge, every round)

1. What quality dimension does this rubric miss entirely — something
   a bad presentation document could hide behind?
2. Construct a bad presentation document that would PASS this rubric.
   What does it look like?
3. Where would two careful judges disagree on a score, and what
   wording causes the disagreement?
4. What does this rubric reward that it should not, or punish that
   it should not?
5. Free-form: anything else the scores did not capture.

## Version

v0.1 (Nov 19, 2026). Change log: created as the ad hoc first use
of the presentation-doc rubric on the AgentTS architecture page
(BRA-167 litmus follow-up) — criteria drawn from the page's own
dimensions plus the meta-rubric's 14 criteria, each named in the
prose above so the v0 stem-checking judge can score them.
