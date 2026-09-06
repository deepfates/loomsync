---
id: lyn-xizr
status: closed
deps: []
links: []
created: 2026-07-25T19:51:41Z
type: bug
priority: 0
assignee: deepfates
tags: [relay, conflict, durability, recovery]
---
# Replay durable relay conflict variants

Same-id different-body variants are persisted to <root>.conflicts but recovered rooms read only <root>.lync. A client arriving after restart receives the selected first line and never receives the durable conflict variant bytes.

## Acceptance Criteria

Persisted conflict variants join the room replay stream with stable cursor behavior after recovery; late and restarted clients receive every retained variant and surface the conflict through ordinary union; damaged sidecar tails remain loud; focused relay and full verification suites pass.


## Notes

**2026-07-25T19:55:46Z**

Reproduced before the fix: after a persisted same-id conflict and relay restart, a fresh subscriber received only the main variant. Durable sidecar variants now enter live and recovered replay; a truncated sidecar is sealed, reported, and not replayed as an event. pnpm verify passes 131/131.
