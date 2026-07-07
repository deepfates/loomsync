# dee-ievy Report

Branch: `lore-rung1`

## What Changed

- Added `packages/core/src/lore/events.ts`, a LORE-V0 Part I line reader and union classifier.
- Exported the parser from `@lync/core` and the subpath `@lync/core/lore/events`.
- Added vector-driven tests that consume all 13 fixture directories directly from `portfolio-audit-20260701/lore-vectors-draft`.
- Added explicit tests for unknown-field carry/surfacing, duplicate decoded JSON member names as garbage, and byte-preserving export of garbage/damaged lines.
- Fixed bounce finding 1: only `accepted` critical events can trigger payload suppression; nonconforming critical events are still carried and surfaced but have no suppression power.
- Fixed bounce finding 2: digest/sig splice detection now runs on raw line bytes before UTF-8 decoding, so digest mismatch classification wins even when invalid UTF-8 appears in the body bytes.
- Folded the reviewer’s hostile probes into permanent regression tests for nonconforming critical suppression and raw-byte-first digest classification.
- Added a README usage section for parsing lorefiles.

## Reproduce Commands

```sh
git checkout lore-rung1
pnpm test -- packages/core/test/lore-events.test.ts
pnpm verify
```

## Evidence Output

`pnpm test -- packages/core/test/lore-events.test.ts`

```text
✓ packages/core/test/lore-events.test.ts (19 tests) 18ms

Test Files  1 passed (1)
Tests  19 passed (19)
```

`pnpm verify`

```text
✓ packages/core/test/lore-events.test.ts (19 tests) 28ms
✓ packages/core/test/text-story-profile.test.ts (3 tests) 8ms
✓ packages/core/test/memory.test.ts (6 tests) 9ms
✓ packages/client/test/testing.test.ts (2 tests) 8ms
✓ packages/sync-server/test/sync-server.test.ts (6 tests) 109ms
✓ packages/index/test/automerge.test.ts (4 tests) 148ms
✓ packages/core/test/automerge.test.ts (5 tests) 178ms
✓ packages/client/test/browser.test.ts (3 tests) 128ms
✓ packages/client/test/node.test.ts (2 tests) 186ms
✓ packages/core/test/references.test.ts (3 tests) 20ms
✓ packages/index/test/memory.test.ts (5 tests) 10ms
✓ packages/core/test/automerge-browser.test.ts (3 tests) 5ms

Test Files  12 passed (12)
Tests  61 passed (61)

packages/core typecheck: Done
packages/sync-server typecheck: Done
packages/index typecheck: Done
packages/client typecheck: Done
```

## Uncertainty

- The parser/classifier is implemented for Part I and fixture coverage. It does not yet implement the full `createLoreLooms` backend from later design sections.

## Tickets Filed

None.
