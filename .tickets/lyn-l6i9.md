---
id: lyn-l6i9
status: closed
deps: []
links: [lyn-qoba, lyn-d9hp]
created: 2026-07-31T21:52:53Z
type: bug
priority: 0
assignee: deepfates
tags: [store, durability, retry, sync]
---
# Retry or roll back store mutations after persistence failure

BaseEventStore mutates its in-memory maps before awaiting persistence. If persist rejects, the mutation remains visible but no dirty/pending durability state remains. A reproduced fail-once store rejects the first union; retrying the identical bytes returns duplicate without another persist attempt (persistAttempts=1, durableIds empty, byId present). appendMany likewise clears batchDirty before awaiting its flush. Synced consumers can therefore treat a resent remote line as complete and advance while the event is absent from durable storage.

## Acceptance Criteria

After persistence rejects, each affected mutation is either rolled back or remains explicitly pending durability. Retrying identical append/union bytes attempts persistence again and cannot report a clean durable duplicate while the bytes are not durable. A failed appendMany flush retains dirty state and a later retry or mutation flushes all pending work. Added events, richer duplicates, conflicts, pending-parent transitions, and garbage follow the same explicit rule. SyncedStore does not advance or acknowledge a remote line as durable until persistence succeeds. Focused fail-once and permanent-failure tests cover single and batch paths across relevant backends; pnpm verify passes.


## Notes

**2026-07-31T22:21:35Z**

Implemented a serialized dirty-version persistence state machine in BaseEventStore. Failed flushes leave pendingPersistence=true; every later append/appendMany/union heals that state before classifying new input; durable subscriber emission is retained until flush success. Added fail-once single/batch regressions and a synced replay regression proving the cursor remains frozen until identical bytes heal local durability. Public diagnostics and README expose pending persistence. Full pnpm verify passes 155/155.
