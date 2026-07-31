---
id: lyn-qoba
status: open
deps: [lyn-l6i9]
links: [lyn-d9hp, lyn-l6i9]
created: 2026-07-31T21:50:52Z
type: bug
priority: 0
assignee: deepfates
tags: [file-store, durability, recovery]
---
# Make canonical .lync bytes authoritative across FileEventStore restart

FileEventStore treats events.json as a derived snapshot when writing, but as the exclusive source when reopening whenever it is parseable. A reproduced case appends a valid causal child to root.lync after the snapshot exists: a reopened store cannot find the child; deleting events.json makes it visible. If the shadowed store performs one later ordinary append, its whole-file rewrite deletes that valid child from the canonical file. This can silently discard unioned or recovered history, contrary to README/FORMAT's append-only .lync durable center. Whole-file replacement also lacks an exercised crash boundary.

## Acceptance Criteria

On restart, valid canonical .lync additions, conflict variants, pending parents, and diagnostics are never silently shadowed by a derived snapshot. Snapshot/canonical divergence or corruption is reconciled without losing exact accepted bytes or fails loudly and actionably. An append resolves only when its exact new bytes are recoverable after restart. Fault-injection tests before, during, and after each persistence phase recover either the complete old union or complete new union, never partial/silent loss; exact body bytes, conflicts, pending records, and garbage survive rebuild; pnpm verify passes.

## Notes

**2026-07-31T21:51:32Z**

2026-07-31 independent stress reproduction on main 43d563e: externalPresentOnDiskBefore=true, externalVisibleAfterReopen=false, externalPresentAfterOrdinaryAppend=false. Relevant implementation: src/file-log.ts load/persist/writeLyncFiles and src/store.ts dump/load. Behold only recovers syntactically invalid events.json; a parseable divergent snapshot remains trusted.
