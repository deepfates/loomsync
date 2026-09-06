---
id: lyn-hh9v
status: in_progress
deps: []
links: []
created: 2026-08-01T13:55:07Z
type: feature
priority: 0
assignee: deepfates
tags: [loom, cursor, storage, long-running]
---
# Keep selected Loom access bounded as canonical files grow

Current file-backed Lync eagerly retains canonical lines, decoded events, and a complete fold. This makes resident controller memory grow with total private history even when the consumer needs only a bounded tail or exact range. Add a Node-only appendable file-Loom cursor over canonical Lync bytes using a disposable disk-backed locator/topology catalog. Canonical JSONL remains sole authority; the catalog must be rebuildable and must share existing union/conflict semantics rather than inventing another parser.

## Design

Expose explicit-tip lazy tail, exact range/thread scan, ancestry lookup, append, and close operations. Keep existing eager and browser APIs compatible. Persist no private payload bodies in the catalog. Canonical append and fsync precede catalog update; recovery reconciles canonical bytes and fails closed on branch ambiguity or corruption. First falsify the Node 22 runtime boundary and storage-adapter seam before freezing the schema.

## Acceptance Criteria

On the retained approximately 100 MB Behold lives and generated 0.5 to 2 GB histories, child-process measurements show no payload-sized heap slope, bounded cache and decoded-tail retention, exact eager/indexed/cursor parity for accepted events conflicts topology and suppression, stable append/range/decision latency within declared bounds, exact crash/rebuild behavior at canonical/catalog boundaries, and explicit resource release on close. Deleting the catalog and rebuilding it produces the same selected Loom truth from unchanged canonical bytes.

## 2026-08-01 implementation checkpoint

Phase A/B now has an optional Node >=22.13 subpath with explicit tips,
ancestry/tail/range reads,
canonical-first append, close, a payload-free SQLite locator/topology catalog,
shared indexed-union bucket adjudication, unchanged-manifest catalog reuse,
and canonical rebuild after catalog deletion, source change, or an injected
post-fsync catalog failure. The eager and browser entry points remain intact.

Exercised: the full 199-test/package verification passed; Node 22.14 created,
appended, and read a Loom; and the final implementation opened a generated
537,635,938-byte, 4,096-turn history in a fresh child in 18.9 seconds with
423,648 bytes of post-GC heap growth at open and 2,034,928 bytes after reading
a 12-turn tail (RSS grew 53,821,440 bytes). A separate instrumented 64-turn
chain proved `hasTurn` decoded zero events and `tail(12)` decoded exactly 12;
a compact 4,096-depth chain also opened and returned depth/tail/chain digest.
The catalog did not contain a test payload marker.

Still open, so this ticket remains in progress: retained Behold-history parity,
the 2 GB end of the range, suppression/graph parity beyond Loom ancestry,
declared append/range latency bounds, a broader crash matrix, and suffix-only
reconciliation. A valid missing-LF final event is preserved and readable but
requires an explicit repair path before append can resume. A changed source
currently causes a complete bounded-memory rebuild; it is not yet an
incremental suffix reconcile.

## Notes

**2026-08-01T15:07:22Z**

Principal retained-life gate after d7aea47 used disposable snapshots of active Behold episode 000002 canonical files, never the live sources. Ash: 79,436,582 bytes/1,507 turns, 3.76s first index, +557,400 heap bytes at open and +1,160,744 after tail(12). Reed: 30,754,540 bytes/629 turns, 1.49s first index, +538,560 heap bytes at open and +1,249,680 after tail(12). Unchanged reopen was 31-36ms. Eager Loom count equaled cursor depth for both and decoded last-12 tails had exact parity after excluding cursor-only locator/digest metadata. This crosses the retained ~100MB Behold parity checkpoint. Ticket remains in_progress for 2GB, broader vector/crash/latency bounds, suffix reconciliation, and missing-LF repair.
