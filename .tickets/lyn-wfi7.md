---
id: lyn-wfi7
status: closed
deps: []
links: []
created: 2026-07-25T19:51:41Z
type: bug
priority: 0
assignee: deepfates
tags: [relay, format, conflict]
---
# Use Lync body-byte equality in relay union

The relay compares complete stored line strings for same-id union. FORMAT.md defines sameness by event body bytes, so a plain line and the same body with valid digest/signature metadata are currently surfaced and persisted as a false conflict.

## Acceptance Criteria

The relay compares the byte-exact body recovered by the canonical splice grammar; digest/signature metadata differences over identical body bytes are duplicate no-ops; actual body changes remain conflicts; focused relay and full verification suites pass.


## Notes

**2026-07-25T19:55:46Z**

Reproduced before the fix: a plain stored line followed by the same body with a valid digest/signature emitted same-id-conflict and created a sidecar. Relay now compares verified byte-exact bodies; a later distinct event proves the duplicate frame was fully processed. pnpm verify passes 131/131.
