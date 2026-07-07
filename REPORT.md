# dee-x7tp Report

Branch: `lore-storage`

## Delivered

- Added a shared lore `EventStore` interface plus memory, filesystem, and IndexedDB-shaped implementations.
- Added `createLoreLooms`, `createFileLoreLooms`, and `createBrowserLoreLooms` over the event store.
- Filesystem store writes byte-preserving `.lore` files per root plus an `events.json` state file for roots/conflicts/pending.
- IndexedDB store uses the required stores: `events`, `conflicts`, and `pending`.
- Added round-trip tests for memory, file, and IndexedDB-shaped stores: write via backend, export raw lore bytes, union into a fresh store, compare bytes exactly.
- Added `scripts/migrate-automerge-to-lore.ts` for one-time migration from a copied Automerge file store to native lorefiles.

## Interface Assumptions

- Implemented the loom/core seam first (`packages/core/src/types.ts` / `memory.ts` behavior). The index lore backend from the design doc is not implemented in this branch.
- Migration uses the design doc fallback of public/synthesized `LoomSnapshot` conversion. It preserves loom/turn visible history as lore events with `author.imported_by`, `author.source`, and top-level `marked`; it does not yet emit one lore event per low-level Automerge change.

## Evidence

Commands run:

```sh
pnpm vitest run packages/core/test/lore-storage.test.ts
pnpm test
pnpm typecheck
cp -R /Users/deepfates/Hacking/github/deepfates/textile/.data/lync /private/tmp/lync-automerge-copy
node --experimental-strip-types scripts/migrate-automerge-to-lore.ts /private/tmp/lync-automerge-copy /private/tmp/lync-lore-migrated
python3 /Users/deepfates/Hacking/github/deepfates/portfolio-audit-20260701/lore-tools/verify.py /private/tmp/lync-lore-migrated/*.lore
```

Results:

- `pnpm vitest run packages/core/test/lore-storage.test.ts`: 3 tests passed.
- `pnpm test`: 13 files passed, 73 tests passed.
- `pnpm typecheck`: build and typecheck passed for core, index, client, sync-server.
- Corpus copy size: `61M /Users/deepfates/Hacking/github/deepfates/textile/.data/lync`.
- Distinct copied Automerge doc prefixes: 130.
- Migration run against the copy was interrupted after the Automerge Repo loader stalled. Partial output: 8 lorefiles, 3,013 stored lore events, store diagnostics `conflicts=0`, `pending=0`, `garbage=0`.
- Canonical verifier accepted the 8 emitted lorefiles: 3,012 `.lore` lines, all `accepted`, ids unique.

## Migration Blocker

The full-corpus migration acceptance gate is not satisfied. The Automerge Repo/FileStorageAdapter loader migrated 8 source docs, then hung inside document loading/`whenReady` despite per-doc timeout and isolated Repo attempts; the process required Ctrl-C. No chunk contents were printed.

The un-migrated corpus is therefore explicitly not claimed zero-loss in this branch. The blocker is filed as `dee-rv6i`.

## Discovered Tickets

- `dee-rv6i` - Automerge corpus migration loader hangs before full lync conversion.
