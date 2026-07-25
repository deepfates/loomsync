---
id: lyn-dz8o
status: closed
deps: []
links: []
created: 2026-07-25T19:51:41Z
type: bug
priority: 0
assignee: deepfates
tags: [relay, durability, shutdown]
---
# Make relay close honor durable-write failures

Accepted lines whose append failed remain in room.unpersisted, but close waits only the already-settled write chain. It neither retries pending bytes nor rejects when they still cannot be persisted, contradicting the close durability promise.

## Acceptance Criteria

Close retries every pending room write in append order; it resolves only when accepted lines are durable, rejects with actionable room/id details if they remain pending, tears down sockets/server on either outcome, and has regressions for recovered and permanent write failures; the full verification suite passes.


## Notes

**2026-07-25T19:55:46Z**

Reproduced before the fix: close neither retried a pending append after storage recovered nor rejected while storage remained unwritable. Close now stops intake, drains queued frames, retries pending writes in order, closes transport, and rejects with room:id if durability still fails. pnpm verify passes 131/131.
