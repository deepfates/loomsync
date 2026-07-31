---
id: lyn-d9hp
status: closed
deps: []
links: [lyn-qoba, lyn-l6i9]
created: 2026-07-31T21:50:52Z
type: task
priority: 1
assignee: deepfates
tags: [file-store, performance, long-life]
---
# Make sequential file-backed Loom appends incremental

Ordinary FileEventStore append serializes the entire in-memory store, rewrites events.json, and rewrites every root .lync file. Recovery without a snapshot unions each canonical line through the same persistence path, causing a whole-store rewrite after every recovered event. LyncLoom.appendTurn folds the full root before and after append, while its always-installed store subscription schedules another full fold even when the application has no listeners. Behold directly uses this path for resident lives. On a disposable copy of OxfordIris (37,959,035 canonical bytes, 745 events), opening took 1,229 ms and adding a 289-byte turn took 633 ms while the implementation rewrote roughly 81 MB; the same append on an in-memory store still took 385 ms.

## Acceptance Criteria

Appending one causally valid child does not rewrite or copy already-held canonical bytes or an all-roots snapshot. Rebuilding derived state from canonical files does not persist once per input line or perform quadratic cumulative writes. Required durable write volume and fold work are bounded by the new event plus bounded metadata rather than historical payload bytes. With no Loom listeners, append performs no notification-only fold; subscribed listeners receive exactly one correct event. Hardware-independent long-root regressions instrument bytes, records, persistence calls, and folds to prove ordinary append and canonical recovery do not grow quadratically with historical payload size. Exact export bytes, conflict behavior, reopen behavior, and existing APIs remain compatible; pnpm verify passes.

## Notes

**2026-07-31T21:51:32Z**

2026-07-31 independent stress measurements: OxfordMoss 760-event life ordinary append rewrote approximately 85.2 MB in 265 ms; cold open reached approximately 790 MB RSS in 1.49 s. Snapshot-free recovery currently persists after every super.union line: calculated cumulative root rewrites 14.05 GiB Moss / 13.08 GiB Iris, about 30.19/28.08 GiB including JSON. A 100-line 5.07 MB disposable recovery took 754 ms. Positive boundary: parseLyncFiles plus exportCarried over episode 000029's 75,012,413-byte union preserved 1,452 events and exact bytes in 2.59 s at 482 MB peak, so no separate parser-correctness ticket was filed.

**2026-07-31T22:32:50Z**

The FileEventStore half is now implemented under lyn-qoba: future writes append+fsync only missing canonical lines; no events.json rewrite; snapshot-free recovery hydrates without persistence; legacy snapshots migrate once. Disposable Iris append fell from 633 ms / roughly 81 MB rewritten to 407 ms / 266 bytes appended. Remaining d9hp work is Loom/store read indexing and removal of repeated full-root folds, plus hardware-independent long-root regression.

**2026-07-31T22:37:00Z**

Completed long-life derivation work. BaseEventStore now exposes a monotonic per-root revision. LyncLoom caches one fold, applies ordinary added turns incrementally, skips notification work with no listeners, and checks revisions so conflicts/richer invisible mutations force a full correct refold. A 200-turn 4 KiB-payload regression performs one byRoot read total and delivers exactly 200 notifications; conflict regression proves invalidation. On a disposable migrated Iris life, one 264 ms warm fold was followed by file-backed appends of 19.3, 15.2, 7.5, 7.6, and 5.5 ms. Full pnpm verify passes 163/163.
