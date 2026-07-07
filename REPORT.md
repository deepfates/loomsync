# dee-rqc1 Report

Branch: `lore-union`

## What Changed

- Extended `packages/core/src/lore/events.ts` so union diagnostics carry computed body SHA-256 digests and explicit same-id conflict variants keyed by `(id, digest)`.
- Kept same-id/same-body events as one view event while retaining duplicate line diagnostics and preferring richer duplicate metadata (`sig` over digest-only, digest over bare).
- Added `LoreUnion`, an incremental union accumulator that buffers arrivals whose `parents[0]` is absent, surfaces pending overflow via `pendingOverflowCount`, and drains pending children in cascade when parents arrive.
- Fixed `LoreUnion` commutativity so buffered, never-accepted ids no longer count as present parents.
- Fixed `LoreUnion` conflict handling so every same-id/different-body arrival after the first conflict returns `status: "conflict"` and is recorded as a conflict variant.
- Documented the FR2-5 ruling at the in-memory `pendingLimit` site: this layer keeps pending diagnostics past the loud counter; durable bounds belong to storage.
- Preserved vector 10 behavior: `a.lore + b.lore` unions IDs 091, 092, 093; surfaces ID 094 as two conflict variants; excludes conflicts from normal views/downsets.
- Added regression tests for same-id/different-body exclusion, out-of-order pending cascade, order-independent buffered parents, and third-variant streaming conflicts.

## Reproduce Commands

```sh
git checkout lore-union
pnpm install
pnpm test -- packages/core/test/lore-events.test.ts
pnpm test
pnpm typecheck
(cd /Users/deepfates/Hacking/github/deepfates && tk show dee-rqc1)
```

## Evidence Output

`pnpm install`

```text
Lockfile is up to date, resolution step is skipped
Packages: +76
Done in 6.1s
```

`pnpm test -- packages/core/test/lore-events.test.ts`

```text
✓ packages/core/test/lore-events.test.ts (23 tests) 41ms

Test Files  1 passed (1)
Tests  23 passed (23)
```

`pnpm test`

```text
✓ packages/core/test/lore-events.test.ts (23 tests) 106ms
✓ packages/core/test/memory.test.ts (6 tests) 11ms
✓ packages/client/test/testing.test.ts (2 tests) 7ms
✓ packages/core/test/automerge-browser.test.ts (3 tests) 10ms
✓ packages/index/test/memory.test.ts (5 tests) 28ms
✓ packages/core/test/automerge.test.ts (5 tests) 502ms
✓ packages/sync-server/test/sync-server.test.ts (6 tests) 121ms
✓ packages/client/test/browser.test.ts (3 tests) 595ms
✓ packages/index/test/automerge.test.ts (4 tests) 628ms
✓ packages/core/test/text-story-profile.test.ts (3 tests) 10ms
✓ packages/core/test/references.test.ts (3 tests) 12ms
✓ packages/client/test/node.test.ts (2 tests) 322ms

Test Files  12 passed (12)
Tests  65 passed (65)
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

Reviewer probes covered by focused test:

```text
LoreUnion B(parent A), C(parent B), A absent across three orderings:
unionEventIds = ["independent"]; pending = grandchild->child, child->missing-root in every ordering.

LoreUnion same id with three different body byte variants:
statuses = added, conflict, conflict; conflictIds = ["same"]; unionEventIds = []; conflictVariants = 3.
```

## Uncertainty

- `LoreUnion` is an in-memory accumulator over the parser module, not the full durable `EventStore`/IndexedDB pending store from the backend design. It exposes pending overflow loudly and never drops pending diagnostics in this layer.
- Built in an isolated `/private/tmp/lync-lore-union` worktree because the main checkout was on `lore-verify` with unrelated dirty files from the collision scan.

## Tickets Filed

None.
