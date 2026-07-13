# lync v0 draft vector suite

Draft conformance vectors for the lync format spec (FORMAT.md), Part I. These are wrangling fixtures, not a
ratified format for vector metadata.

Each fixture directory contains one or more `.lync` inputs and one `expected.json`.
`10-merge-union/` intentionally has two input files. `generate.py` is the deterministic
source for the fixture bytes and computes real sha256 splices.

## Expected JSON Shape

- `line_classifications`: required per physical line, with `file`, `line`, `class`, and
  usually `id` or `reason`.
- `class`: one of `accepted`, `nonconforming`, `garbage`, `damaged`, or
  `conflict-variant`.
- `union_event_ids`: ids present in the merged event set after excluding garbage,
  damaged lines, and conflict variants. Nonconforming-but-carried events are included
  when present.
- `view_eligible_ids`: ids eligible for normal views before payload suppression is
  applied. Critical suppression withholds payload only, so suppressed ids may still be
  view-eligible.
- `suppression`: expected payload-withholding results for ignorant readers.
- `views`: named view checks. Downsets list held ids, whether the result is `partial`,
  and traversal obstacles.
- `graph_diagnostics`: expected graph-level diagnostics distinct from line damage.

Reason strings are explanatory and should not be treated as byte-exact conformance
requirements.

## Coverage

- `01-valid-events`: valid events with no digest, with digest, with digest+sig, payload
  members named `digest`/`sig`, lowercase RFC 3339 `t`/`z`, `marked`, and a final line
  missing LF classified as `nonconforming` but still view-eligible.
- `02-splice-anchoring`: byte-exact splice verification, including payload text that
  contains marker-like bytes, payload ending with reserved names, near-splice body
  bytes, and top-level reserved-name garbage.
- `03-damaged-digest`: sha256 mismatch classification, including damage winning before
  JSON duplicate-member inspection.
- `04-garbage-classes`: duplicate member names at depth, bytes outside the object,
  bad kind, unimplemented `v`, empty line, CRLF/trailing CR, and recovery after bad
  lines.
- `05-conflicts-and-duplicates`: same id/same body duplicate sightings, metadata
  disagreement for same body, same id/different body conflict variants, and undigested
  vs digested sightings.
- `06-graph-obstacles`: constructed cycles, cycle descendants, dangling parents,
  conflicted parent ids, and partial downsets.
- `07-critical-suppression`: ignorant-reader critical suppression by actor, operator,
  and imported_by intersections; per-target matching; dangling target no-op until
  union; accepted-events-only suppression; spoof-shaped negatives; empty author names
  dropped.
- `08-spelling-vs-value`: decoded string comparison for ids, kinds, author-name
  intersection, and duplicate member names.
- `09-marked-at-semantics`: `at` versus `marked`, numeric offsets, fractional seconds,
  RFC 3339 leap-second ABNF acceptance, and invalid timestamp garbage.
- `10-merge-union`: two-file union, duplicate sightings across files, same-id conflict
  across files, and a downset completed by merge.
- `11-nonconforming-carried`: unknown top-level and author fields are surfaced as
  `nonconforming` while carried and view-eligible.
- `12-invalid-sig-splice`: invalid signature grammar means no splice is detected; the
  whole line is parsed as body and reserved top-level metadata names classify as garbage.
- `13-sig-without-digest`: `sig` without `digest` is not line metadata; the whole line
  is body and the reserved top-level name classifies as garbage.

## Regeneration

Run:

```sh
python3 v0/generate.py
```

This rewrites all fixture directories. The generator intentionally emits exact bytes for
the CRLF and missing-final-LF cases.
