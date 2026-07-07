# dee-2fpi Report

Branch: `lore-verify`

## What Changed

- Added regression coverage for LORE-V0 digest/signature splice verification in `packages/core/test/lore-events.test.ts`.
- Covered structurally valid standard-base64 signatures with matching digests: the base reader preserves and surfaces `sig`/`hasSig` without cryptographic verification.
- Covered invalid signature splice syntax: base64url characters and length-mod-4 failures are treated as body bytes, so reserved top-level `digest`/`sig` classify as garbage instead of being repaired or dropped.

## Reproduce Commands

```sh
git checkout lore-verify
pnpm vitest run packages/core/test/lore-events.test.ts
pnpm verify
pnpm vitest run packages/client/test/node.test.ts
pnpm typecheck
```

## Evidence

`pnpm vitest run packages/core/test/lore-events.test.ts`

```text
Test Files  1 passed (1)
Tests  21 passed (21)
```

This includes the acceptance vectors 02, 03, 08, 12, and 13 through the existing vector loop, plus explicit signature-preservation and invalid-signature syntax regressions.

`pnpm verify`

```text
Test Files  1 failed | 11 passed (12)
Tests  1 failed | 69 passed (70)

FAIL packages/client/test/node.test.ts > node loom client > keeps local loom operations alive when websocket sync is unavailable
AssertionError: expected false to be true
packages/client/test/node.test.ts:86
```

`pnpm vitest run packages/client/test/node.test.ts`

```text
Test Files  1 failed (1)
Tests  1 failed | 7 passed (8)

FAIL packages/client/test/node.test.ts > node loom client > keeps local loom operations alive when websocket sync is unavailable
AssertionError: expected false to be true
packages/client/test/node.test.ts:86
```

`pnpm typecheck`

```text
packages/core build: src/lore/idb-log.ts(68,30): error TS2322: Type 'unknown[]' is not assignable to type 'StoreRecord[]'.
packages/core build: src/lore/idb-log.ts(68,38): error TS2322: Type 'unknown[]' is not assignable to type 'ConflictRecord[]'.
packages/core build: src/lore/idb-log.ts(68,49): error TS2322: Type 'unknown[]' is not assignable to type 'PendingRecord[]'.
```

## Notes

- The lore verification suite passes.
- Full repo verification is blocked by out-of-scope client sync and storage/typecheck failures.
- The worktree contains untracked storage files I did not create: `packages/core/src/lore/file-log.ts`, `idb-log.ts`, `looms.ts`, `memory-log.ts`, and `store.ts`. They are not included in this ticket commit.

## Tickets Filed

- `dee-nqo7` - discovered persistent client sync test failure in `packages/client/test/node.test.ts`.
- `dee-m2jm` - discovered storage `idb-log.ts` typecheck failure from out-of-scope concurrent storage files.
