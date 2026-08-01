---
id: lyn-hh9v
status: open
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

