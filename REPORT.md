# dee-rqc1 Report

Branch: `lore-union`

## What Changed

- Extended `packages/core/src/lore/events.ts` so union diagnostics carry computed body SHA-256 digests and explicit same-id conflict variants keyed by `(id, digest)`.
- Kept same-id/same-body events as one view event while retaining duplicate line diagnostics and preferring richer duplicate metadata (`sig` over digest-only, digest over bare).
- Added `LoreUnion`, an incremental union accumulator that buffers arrivals whose `parents[0]` is absent, surfaces pending overflow via `pendingOverflowCount`, and drains pending children in cascade when parents arrive.
- Preserved vector 10 behavior: `a.lore + b.lore` unions IDs 091, 092, 093; surfaces ID 094 as two conflict variants; excludes conflicts from normal views/downsets.
- Added regression tests for same-id/different-body exclusion and out-of-order pending cascade.

## Reproduce Commands

```sh
git checkout lore-union
pnpm test -- packages/core/test/lore-events.test.ts
pnpm test
pnpm typecheck
```

## Evidence Output

`pnpm test -- packages/core/test/lore-events.test.ts`

```text
✓ packages/core/test/lore-events.test.ts (21 tests) 27ms

Test Files  1 passed (1)
Tests  21 passed (21)
```

`pnpm test`

```text
✓ packages/core/test/lore-events.test.ts (21 tests) 59ms
✓ packages/core/test/memory.test.ts (6 tests) 14ms
✓ packages/index/test/memory.test.ts (5 tests) 7ms
✓ packages/client/test/testing.test.ts (2 tests) 7ms
✓ packages/index/test/automerge.test.ts (4 tests) 220ms
✓ packages/core/test/automerge.test.ts (5 tests) 305ms
✓ packages/sync-server/test/sync-server.test.ts (7 tests) 247ms
✓ packages/client/test/browser.test.ts (3 tests) 196ms
✓ packages/core/test/text-story-profile.test.ts (3 tests) 7ms
✓ packages/core/test/references.test.ts (3 tests) 9ms
✓ packages/client/test/node.test.ts (8 tests) 802ms
✓ packages/core/test/automerge-browser.test.ts (3 tests) 5ms

Test Files  12 passed (12)
Tests  70 passed (70)
```

`pnpm typecheck`

```text
packages/core build: Done
packages/sync-server build: Done
packages/index build: Done
packages/client build: Done
packages/core typecheck: Done
packages/sync-server typecheck: Done
packages/index typecheck: Done
packages/client typecheck: Done
```

## Uncertainty

- `LoreUnion` is an in-memory accumulator over the parser module, not the full durable `EventStore`/IndexedDB pending store from the backend design. It exposes pending overflow loudly and never drops pending diagnostics in this layer.
- The worktree contains unrelated pre-existing edits in client/sync-server/package files. This ticket only changed lore parser/test files plus this report.

## Tickets Filed

None.
