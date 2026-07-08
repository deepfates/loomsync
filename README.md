# lync

lync is the TypeScript reference implementation of the lync format: files of
lore stored as `.lync` append-only JSONL interaction histories. Each line is
one immutable event with an envelope, parent links, provenance, and a payload
owned by the event kind. Merge is set union by event id. Branch trees,
transcripts, memory views, and leaderboards are computed views over the same
event set.

The current library keeps the old loom/turn API while the format layer becomes
the durable center. Automerge is the current sync transport, scheduled for
replacement in `dee-9l2l`; it is not the data model.

## Ninety-Second Story

The shipped `lync` CLI has five verbs: `verify`, `merge`, `view`, `init`, and
`append`. From a fresh clone, run these from the repo root after
`pnpm install && pnpm build`; `pnpm exec lync` resolves the workspace binary. A
published or globally installed package drops the `pnpm exec` prefix and you
call `lync` directly. A complete first mile looks like this:

```bash
pnpm exec lync init story.lync
printf '%s\n' '{"id":"root","kind":"notes/text","at":"2026-07-06T04:12:31Z","author":{"actor":"deepfates","via":"example@0.1"},"parents":[],"payload":{"text":"Once..."}}' | pnpm exec lync append story.lync
pnpm exec lync verify story.lync
pnpm exec lync view story.lync --as transcript
printf '%s\n' '{"id":"note-2","kind":"notes/text","at":"2026-07-06T04:13:00Z","author":{"actor":"deepfates","via":"example@0.1"},"parents":["root"],"payload":{"text":"Then..."}}' | pnpm exec lync append imported.lync
pnpm exec lync merge story.lync imported.lync -o merged.lync
pnpm exec lync view merged.lync --as tree
```

Under those verbs, every line has the same envelope:

```json
{"v":1,"id":"root","kind":"notes/text","at":"2026-07-06T04:12:31Z","author":{"actor":"deepfates","via":"example@0.1"},"parents":[],"payload":{"text":"Once..."}}
```

That line can be copied to another file, merged back later, verified byte for
byte, and read by software that has never heard of `notes/text`. Unknown
kinds are carried and traversed; meaning belongs to pacts layered above the
format.

TODO(positioning): pending the market-sweep verdict, tighten the public
positioning paragraph against adjacent products using the old contested term.

## The Format

See [FORMAT.md](./FORMAT.md) for the normative lync format specification.

The short version:

- A `.lync` file is UTF-8 JSONL, no BOM, one event object per LF-terminated
  line.
- The required event fields are `v`, `id`, `kind`, `at`, `author`, `parents`,
  and `payload`.
- `author.actor` is the content producer; `author.via` is the app or runtime;
  converters use `imported_by` and preserve the original actor.
- Events are immutable. Correction, judgment, selection, and retraction are new
  events that point at prior events.
- Merge is union by event id. Same id plus same body bytes is one event seen
  twice; same id plus different body bytes is a surfaced conflict variant and is
  excluded from ordinary views.
- Stored line metadata may splice `digest` and `sig` at the end of the line.
  `digest` and `sig` are reserved top-level body names; payloads may use those
  names freely.
- Views are computed. The package currently ships branch tree, transcript,
  memory, and leaderboard helpers.

## Packages

- `@lync/core`: format parsing, event stores, computed views, references, and
  the compatibility loom API.
- `@lync/client`: browser, Node, and test runtime clients for the compatibility
  API.
- `@lync/sync-server`: the current Automerge WebSocket relay.
- `@lync/index`: legacy synced indexes of loom references.

## Format-Layer Imports

The format-layer subpaths currently keep their internal path names for
compatibility. Import them by path; do not treat those path segments as public
vocabulary.

```ts
import { LoreUnion, exportCarriedLoreBytes, parseLoreFiles } from "@lync/core/lore/events";
import { createFileEventStore } from "@lync/core/lore/file-log";
import { createIndexedDbEventStore } from "@lync/core/lore/idb-log";
import { createLoreLooms, createFileLoreLooms, createBrowserLoreLooms } from "@lync/core/lore/looms";
import { createMemoryEventStore } from "@lync/core/lore/memory-log";
import { BaseEventStore, serializeLoreEvent } from "@lync/core/lore/store";
import {
  loreBranchTreeView,
  loreLeaderboardView,
  loreMemoryView,
  loreTranscriptView,
} from "@lync/core/lore/views";
```

The seven format-layer package exports are:

- `@lync/core/lore/events`: line parsing, carried-byte export, downsets, and
  incremental union.
- `@lync/core/lore/memory-log`: in-memory event store for tests and embedded
  runtimes.
- `@lync/core/lore/file-log`: file-backed event store.
- `@lync/core/lore/idb-log`: IndexedDB-backed event store.
- `@lync/core/lore/store`: base event-store contract and serialization helpers.
- `@lync/core/lore/views`: branch tree, transcript, memory, and leaderboard
  view helpers.
- `@lync/core/lore/looms`: compatibility loom API backed by event stores.

## Parse, Union, View

```ts
import { parseLoreFiles } from "@lync/core/lore/events";
import { loreBranchTreeView, loreMemoryView } from "@lync/core/lore/views";

const bytes = new TextEncoder().encode(
  '{"v":1,"id":"a","kind":"notes/text","at":"2026-07-06T04:12:31Z","author":{"actor":"deepfates"},"parents":[],"payload":{"text":"Once..."}}\n',
);

const parsed = parseLoreFiles([{ file: "story.lync", bytes }]);
const tree = loreBranchTreeView(parsed);
const memory = loreMemoryView(parsed);

console.log(parsed.lines[0].class, tree.roots, memory.frontierIds);
```

`parseLoreFiles` classifies every physical line and keeps the original bytes,
including garbage, damaged lines, nonconforming-but-carried lines, and conflict
variants. `exportCarriedLoreBytes(parsed)` re-emits the carried bytes.

`LoreUnion` performs the same union incrementally and can buffer children until
their first missing parent arrives.

## Storage

```ts
import { createMemoryEventStore } from "@lync/core/lore/memory-log";

const store = createMemoryEventStore();
await store.append({
  v: 1,
  id: "root",
  kind: "lync/loom",
  at: "2026-07-06T04:12:31Z",
  author: { actor: "deepfates", via: "example@0.1" },
  parents: [],
  payload: { meta: { title: "Story" } },
});

await store.append({
  v: 1,
  id: "turn-1",
  kind: "lync/turn",
  at: "2026-07-06T04:12:32Z",
  author: { actor: "deepfates", via: "example@0.1" },
  parents: ["root"],
  payload: { payload: { text: "Once..." }, ordinal: 0 },
});

console.log((await store.byRoot("root")).map((event) => event.body.id));
```

The store API accepts raw lines through `union(line)` and structured event
bodies through `append(event)`. It reports conflicts, pending parents, garbage,
and accepted events without making file order meaningful.

## Compatibility Looms

The loom API remains for existing users and for the current Automerge-backed
clients. It now has an event-store implementation:

```ts
import { createLoreLooms } from "@lync/core/lore/looms";
import { createMemoryEventStore } from "@lync/core/lore/memory-log";

const looms = createLoreLooms<{ text: string }, { title: string }>({
  store: createMemoryEventStore(),
  author: { actor: "deepfates", via: "example@0.1" },
  createId: (() => {
    let n = 0;
    return () => `id-${++n}`;
  })(),
});

const info = await looms.create({ title: "Story" });
const loom = await looms.open(info.id);
const first = await loom.appendTurn(null, { text: "Once..." });
const next = await loom.appendTurn(first.id, { text: "Then..." });

console.log((await loom.threadTo(next.id)).map((turn) => turn.payload.text));
```

## Migration

`scripts/migrate-automerge-to-lync.ts` migrates old Automerge loom storage into
the event-store implementation. Build first, then run the script against an
Automerge storage directory and an output directory:

```bash
pnpm build
node scripts/migrate-automerge-to-lync.ts <automerge-storage-dir> <out-dir>
```

The script writes a migration report as it goes, verifies migrated snapshots are
isomorphic to the source loom shape, and records per-document failures instead
of aborting the whole migration. Migrated roots are written as `.lync` files.
The file event store reads both `.lync` and legacy `.lore` files so old
exports can be mixed with newly migrated roots during a transition.

## Sync Server

`@lync/sync-server` provides the current Automerge WebSocket relay. Its default
WebSocket path is `/lync`. The exported factory is `createLyncServer`.

`authenticate` is synchronous by design in the server API. Return `false` to
reject an upgrade; if the predicate throws, lync rejects the upgrade instead of
accepting it.

## Development

```bash
pnpm install
pnpm build
pnpm exec lync --help
pnpm test
pnpm verify
```

`pnpm verify` runs tests, builds packages, and typechecks emitted package
surfaces.

For a fresh clone, `pnpm install && pnpm build` is the supported setup sequence.
After that, `pnpm exec lync --help` should print the CLI help from the workspace
root. `scripts/fresh-clone-smoke.sh` verifies that sequence in a temporary clone
and runs the CLI story path: init, append, view, concatenate, merge, and verify.
