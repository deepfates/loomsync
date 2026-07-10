# Export Pact

Status: v0, and younger than the import pact. The view functions it names are
shipped (`packages/core/src/views.ts`); the export file formats built on them
are still settling. The principles are law; the column schemas are early.

An export is a projection: a view computed over the event set, written down
for a consumer that cannot or will not read `.lync`. It is never a mutation.
The `.lync` file remains the source of truth; the export is a derived,
disposable artifact. If an export and the events disagree, the events win and
the export is stale. Nothing an exporter does writes back — a judgment made
while exporting (a score, a selection, a no-train flag) is a new event
appended by whoever made it, and the next export sees it.

Two obligations define a conforming export:

- **Regenerable.** Same event set plus same exporter version yields the same
  export. No hidden state, no clock in the output rows (an export manifest
  may carry a timestamp; the rows may not depend on one).
- **Says what it dropped.** Every projection excludes things — that is what
  makes it a projection. The exclusions are reported, never silent: damaged
  and garbage lines, conflict variants, suppressed payloads, annotations it
  could not interpret (`ignoredAnnotationIds`), events filtered by
  `no-train` or tombstones, and any traversal obstacle (dangling parent,
  cycle, conflict) that made the result `partial`. A partial export must say
  it is partial. Silence is the only forbidden response; that rule does not
  stop at the file boundary.

All exports project over view-eligible events only (FORMAT.md's taxonomy:
accepted and nonconforming union events, minus conflict variants, with
critical suppression applied). An exporter never reaches past that line: a
suppressed payload stays out of the export, and a same-id conflict is
reported as a conflict, never resolved by picking a favorite.

## The Two Blessed Projection Families

### Readable transcripts

View functions: `lyncBranchTreeView` and `lyncTranscriptView`.

The branch tree is the whole graph made legible: every eligible event with
its parents, children, roots, and leaves, plus explicit `missingParents` and
`conflictedParents` per node and a `partial` flag when anything is
unresolved. The transcript is one thread through it: from a chosen head,
walk parents to a root (caller-supplied `chooseParent` decides at fan-in;
default is the first held parent), reverse, and number by depth. The view
carries the head's full downset and its obstacles alongside the path, so a
transcript that could not see everything says so.

A transcript export renders those entries — actor, time, payload text — in
whatever format the consumer reads. What it must keep: each rendered entry
points back to its event id, and the head, the parent choices, and any
`partial` flag ride along. A transcript is a choice of path through
alternatives; an export that hides which path was chosen is not regenerable.

### Training data

View function: `lyncLeaderboardView`, over `lync/annotation` events. This
family is not an add-on; it is in the spec's worked example. Five events —
a paragraph `A`, alternatives `B` and `C`, a judge's `score` on `B`, and a
declared `selection` of `B` over `C` — already contain a preference pair:
`B` over `C`, chosen by `deepfates`, with a judge's score on record. The
format's unusual commitment is recording alternatives and choice at
generation time so training exports are reads, not reconstructions.

The annotation payloads the view interprets, exactly as shipped:

- `label: "score"` — numeric value in payload `value` (fallback `score`);
  targets are the annotation's parents; each target accumulates
  `scoreTotal`, `scoreCount`, `scoreMean`, and a per-score record of the
  judge (`author`), time, and `basis`.
- `label: "selection"` — payload `chosen` (array of ids) and `shown` (array
  of ids); targets are `shown` when non-empty, else the annotation's
  parents; each target learns whether it was selected, by whom, and on what
  `basis`. Selection is revealed before declared: an extended branch already
  IS the choice, so declared selections exist only where topology cannot
  reveal one.
- Anything the view cannot interpret (non-numeric score, empty `chosen`)
  lands in `ignoredAnnotationIds` — dropped-but-reported.

From these the two export shapes FORMAT.md names:

- **Preference pairs (DPO-shaped):** chosen-over-shown-but-not-chosen, from
  revealed choices (extended branches) and declared choices (selection
  annotations), each pair with its full context (the shared downset), the
  judge's identity, and the basis.
- **SFT rows:** root-to-leaf threads of artifacts, filtered through
  tombstones and `no-train`, with a windowed mode (per-step slices with
  immediate context). Scores and selections rank which leaves are worth
  exporting; the leaderboard's ordering (selected count, then mean score,
  then total, then id) is the shipped tie-break.

## What an Exporter Must Preserve, and Must Never Do

Must preserve, in every family:

- **Provenance columns.** Every exported row points back to the event ids it
  was computed from: the artifact ids in a transcript or SFT row, the
  chosen/rejected ids and the annotation id behind a preference pair. An
  export you cannot trace back to events is an assertion, not a projection.
- **Author axes as axes.** Judge identity is the annotation's `author`
  object; keep `actor`, `operator`, `via`, `imported_by` distinct rather
  than collapsing them into one display string (authorship pact).
- **The drop report and the partial flag**, as above.

Must never:

- **Invent content.** No paraphrase, no synthesized turns, no filled gaps. A
  hole in the graph is exported as a hole (and reported), not smoothed over.
- **Silently dedupe or resolve conflicts.** Two same-id variants are a
  surfaced disagreement; an exporter that quietly picks one has forged
  history. Exclude both from rows, report the conflict.
- **Leak suppressed payloads.** Honoring critical suppression in exports is
  the testable conformance claim of FORMAT.md's obligations section; an
  exporter that ships a tombstoned payload has lost the badge.
- **Claim authority.** An export is never merged back as truth and never
  cited as evidence over the events it came from.

## Open Points

- Exact column schemas for the SFT and DPO row formats, and the manifest
  shape for the drop report.
- The windowed SFT mode's window rules.
- How blob-referenced payloads (`{"blob":"sha256:..."}`) ride in exports:
  inline, sidecar, or reference.
- Whether a transcript export standard (markdown? ChatML?) is worth blessing
  or should stay per-consumer.
