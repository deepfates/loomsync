---
id: lyn-gisl
status: closed
deps: []
links: []
created: 2026-08-02T11:07:41Z
type: bug
priority: 1
assignee: deepfates
tags: [behold, presentation, textile]
---
# Present held-focus placement in Behold resident histories

Textile’s real indexed import of Behold Oxford episode 000019 reads all 869 resident events, including null cognition, but emits unsupported_action_input for Sedge turns 382 and 384 because the v2 Behold presenter has no branch for place_held_against_focus with its valid empty input object. Those are retained historical false-affordance choices; hiding the input makes the otherwise readable life less exact.

## Design

Add the smallest v2 action presenter for place_held_against_focus. Describe only the resident’s attempted focused placement, consume no unapproved input fields, preserve the existing source-only diagnostics, and do not infer that an item existed or placement succeeded; the separate outcome remains authoritative.

## Acceptance Criteria

The two exact episode-000019 source turns project without unsupported_action_input and say only that Sedge attempted to place the held item against the focused block. Existing Behold presentation tests remain unchanged, a focused empty-input regression passes, and the full Lync check passes. Textile may vendor the resulting candidate through its existing provenance workflow; no publication is required.


## Notes

**2026-08-02T11:14:58Z**

Implemented the minimal v2 presenter for empty-input place_held_against_focus without inferring inventory or success. Focused 30-test presenter suite and full pnpm verify pass: 25 files, 208 tests, typecheck, README examples, and packed artifact. Textile candidate update and exact episode import remain downstream integration work.
