# lync

lync is the TypeScript reference implementation of the lync format: `.lync`
append-only JSONL files of interaction history. Each line is
one immutable event with an envelope, parent links, provenance, and a payload
owned by the event kind. Merge is set union by event id. Branch trees,
transcripts, memory views, and leaderboards are computed views over the same
event set.

The format layer is the durable center. A loom/turn API ships on top of the
same event stores for programs that want turns and threads instead of raw
events.

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

- `lync-core`: format parsing, event stores, computed views, references, and
  the loom API. No runtime dependencies.
- `lync-cli`: the `lync` command — `init`, `append`, `verify`, `merge`, `view`.

## Format-Layer Imports

```ts
import { LyncUnion, exportCarriedLyncBytes, parseLyncFiles } from "lync-core/events";
import { createFileEventStore, createFileLyncLooms } from "lync-core/file-log";
import { createIndexedDbEventStore } from "lync-core/idb-log";
import { createLyncLooms, createBrowserLyncLooms } from "lync-core/looms";
import { createMemoryEventStore } from "lync-core/memory-log";
import { BaseEventStore, serializeLyncEvent } from "lync-core/store";
import {
  lyncBranchTreeView,
  lyncLeaderboardView,
  lyncMemoryView,
  lyncTranscriptView,
} from "lync-core/views";
```

The seven format-layer package exports are:

- `lync-core/events`: line parsing, carried-byte export, downsets, and
  incremental union.
- `lync-core/memory-log`: in-memory event store for tests and embedded
  runtimes.
- `lync-core/file-log`: file-backed event store and `createFileLyncLooms`
  (node-only; keeps `node:fs`/`node:path` off the browser path).
- `lync-core/idb-log`: IndexedDB-backed event store.
- `lync-core/store`: base event-store contract and serialization helpers.
- `lync-core/views`: branch tree, transcript, memory, and leaderboard
  view helpers.
- `lync-core/looms`: compatibility loom API backed by event stores.

## Parse, Union, View

```ts
import { parseLyncFiles } from "lync-core/events";
import { lyncBranchTreeView, lyncMemoryView } from "lync-core/views";

const bytes = new TextEncoder().encode(
  '{"v":1,"id":"a","kind":"notes/text","at":"2026-07-06T04:12:31Z","author":{"actor":"deepfates"},"parents":[],"payload":{"text":"Once..."}}\n',
);

const parsed = parseLyncFiles([{ file: "story.lync", bytes }]);
const tree = lyncBranchTreeView(parsed);
const memory = lyncMemoryView(parsed);

console.log(parsed.lines[0].class, tree.roots, memory.frontierIds);
```

`parseLyncFiles` classifies every physical line and keeps the original bytes,
including garbage, damaged lines, nonconforming-but-carried lines, and conflict
variants. `exportCarriedLyncBytes(parsed)` re-emits the carried bytes.

`LyncUnion` performs the same union incrementally and can buffer children until
their first missing parent arrives.

## Storage

```ts
import { createMemoryEventStore } from "lync-core/memory-log";

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

## Looms

The loom API gives programs turns and threads instead of raw events, backed by
any event store:

```ts
import { createLyncLooms } from "lync-core/looms";
import { createMemoryEventStore } from "lync-core/memory-log";

const looms = createLyncLooms<{ text: string }, { title: string }>({
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

## Sync

Any lync file can converge with any other copy through a relay:

```bash
lync serve ./rooms --port 8787          # the relay: one append-only file per root
lync sync story.lync ws://host:8787     # one-shot: push what it lacks, pull what you lack
lync sync story.lync ws://host:8787 --follow   # stay live: stream both ways until Ctrl-C
```

The relay is deliberately dumb. Events are immutable and merge is union by
id, so the protocol has no merge logic: five JSON frames (`sub`, `ev`,
`live`, `presence`, `err`) that move canonical line bytes. The server never
parses a line beyond extracting its id, stores each root as a plain `.lync`
file you can read with any lync tool, and echoes accepted events to every
subscriber — echoes are duplicate no-ops under union. `seq` is a per-root
arrival counter used as a resume cursor (`<file>.sync.json`), so an offline
client reconnects exactly where it left off. Same-id-different-body is never
resolved: both variants are kept (the relay writes a `.conflicts` sidecar)
and both sides are told loudly. Presence frames are relayed, never stored.
A truncated final line after a crash is sealed and surfaced as damaged,
never eaten. `--token T` on the server requires `Authorization: Bearer T`
to connect.

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
