---
id: lyn-sebv
status: closed
deps: []
links: []
created: 2026-07-25T19:51:41Z
type: bug
priority: 0
assignee: deepfates
tags: [parser, security, format]
---
# Reject inherited Lync envelope fields

The duplicate-key JSON parser assigns decoded object members into ordinary objects. A __proto__ member can therefore replace the parsed object prototype, and envelope validation reads inherited v/id/kind/at/author/parents/payload or inherited author.actor as if they were present. Two adversarial lines were accepted in the focused regression before the fix.

## Acceptance Criteria

Parsed JSON objects cannot acquire attacker-controlled prototypes; every required envelope and author field must be an own property; optional/reserved-field checks use own-property semantics; adversarial top-level and author __proto__ regressions classify as garbage; the full verification suite passes.


## Notes

**2026-07-25T19:55:46Z**

Reproduced before the fix: both a top-level __proto__ carrying every required field and an author.__proto__ carrying actor classified accepted. Added own-property regressions; parser now defines JSON members as data properties and validates every envelope/author field with own semantics. pnpm verify passes 131/131.
