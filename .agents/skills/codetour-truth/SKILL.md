---
name: codetour-truth
description: Keep CodeTour walkthroughs as verified maps of current repository behavior. Use when creating or editing `.tour` files, changing a file or behavior referenced by `.tours`, or reviewing architectural, safety, persistence, UI-flow, or verification changes that can stale a tour.
---

# Truth pass

A CodeTour is a **verified map**, not a summary cached from memory. Treat every sentence in an affected step as a claim that must still be supported by the repository at the end of the change.

## 1. Find the affected map

Read every `.tours/**/*.tour` file. Mark a step affected when any of these is true:

- its `file` or `directory` changed;
- its description names a changed symbol, interface, invariant, flow, command, test, or decision;
- its tour ordering (`isPrimary` or `nextTour`) changed;
- the change alters a cross-cutting product boundary described by the tour, even if the anchored file did not change.

For a new tour, every step is affected. The affected set is complete only when each changed behavior has been checked against the tour index, not merely when changed filenames have been compared.

## 2. Re-derive each affected step

For every affected step:

1. Read the anchored declaration or section in its surrounding implementation context.
2. Split the description into factual claims. Find repository evidence for each claim in current code, an accepted ADR, configuration, or a behavioral test.
3. Rewrite, narrow, move, or remove every claim whose evidence is missing, contradicted, or only historical. Describe observable responsibility and boundaries; omit implementation trivia that does not aid the walkthrough.
4. Prefer a stable, unique `pattern` over `line`. Anchor the declaration or heading that owns the described behavior. Keep `line` only when ordinal position itself matters.
5. Preserve the numbered story: tour filenames and titles use consecutive two-digit chapters (`01`, `02`, …), step titles use consecutive chapter-local numbers (`01.01`, `01.02`, …), and each `nextTour` names the next chapter's exact title.
6. Keep the learning path narrative and progressively granular. Begin with user intent and vocabulary, follow one concrete flow in chronological order, then deepen into policy, edge boundaries, persistence, and proof. Each step should connect what the reader just learned to why the next location matters.
7. Check the path's logic: prerequisites appear earlier, only the first chapter is primary, and the final chapter has no `nextTour`.

A comment or older tour is not evidence for current behavior. An accepted ADR supports intent and boundaries; current implementation and tests support what the plugin actually does. Where they disagree, report the discrepancy and make the tour state only what is presently true.

## 3. Run the mechanical check

Run:

```bash
node .agents/skills/codetour-truth/validate-tours.mjs
```

Fix every reported malformed file, missing target, duplicate title, broken tour link, invalid line, invalid regular expression, or non-unique pattern. Then run the repository verification that exercises any behavior whose description changed.

## Completion criterion

The truth pass is complete only when:

- every affected tour step and every changed behavior has been accounted for;
- every factual clause in an affected description has current repository evidence;
- all tour targets open at the intended unique location;
- tour ordering forms a valid path; and
- the mechanical validator and behavior-specific verification both pass.
