# lync-core

The reference implementation of the lync format: `.lync` append-only JSONL
files of interaction history. Each line is one immutable event with an
envelope, parent links, provenance, and a payload owned by the event kind.
Merge is set union by event id. Branch trees, transcripts, memory views, and
leaderboards are computed views over the same event set.

Zero runtime dependencies. Runs in Node (>=22) and the browser.

```bash
npm install lync-core
```

## Parse, union, view

```ts
import { parseLyncFiles } from "lync-core/events";
import { lyncBranchTreeView, lyncTranscriptView } from "lync-core/views";

const bytes = new TextEncoder().encode(
  '{"v":1,"id":"root","kind":"notes/text","at":"2026-07-06T04:12:31Z","author":{"actor":"you"},"parents":[],"payload":{"text":"Once..."}}\n',
);

const parsed = parseLyncFiles([{ file: "story.lync", bytes }]);
console.log(parsed.lines[0].class); // "accepted"
console.log(lyncBranchTreeView(parsed).roots);
console.log(lyncTranscriptView(parsed, "root").path);
```

`parseLyncFiles` classifies every physical line and keeps the original bytes —
accepted events, nonconforming-but-carried lines, damaged lines, garbage, and
conflict variants (same id, different bytes) are all preserved and reported,
never silently dropped. `exportCarriedLyncBytes(parsed)` re-emits the carried
bytes.

## Stores and looms

Event stores share one contract over memory, file, and IndexedDB backends. The
loom API gives programs turns and threads instead of raw events, on top of any
store:

```ts
import { createLyncLooms } from "lync-core/looms";
import { createMemoryEventStore } from "lync-core/memory-log";

const looms = createLyncLooms({
  store: createMemoryEventStore(),
  author: { actor: "you", via: "my-app@0.1" },
});

const info = await looms.create({ title: "Story" });
const loom = await looms.open(info.id);
const first = await loom.appendTurn(null, { text: "Once..." });
await loom.appendTurn(first.id, { text: "Then..." });
```

## Live sync

Wrap any store in `createSyncedStore` and it converges with a relay
([lync-server](https://www.npmjs.com/package/lync-server)) over five JSON
frames. Local appends push, remote lines surface reactively, offline appends
queue and flush on reconnect:

<!-- example: fragment — wraps an undefined localStore and needs a live relay; covered by the synced-store tests -->
```ts
import { createSyncedStore, createWebSocketTransport } from "lync-core/synced-store";

const store = createSyncedStore(localStore, createWebSocketTransport("wss://host/lync"));
```

## Subpath exports

- `lync-core/events` — line parsing, carried-byte export, incremental union
- `lync-core/store` — the event-store contract and serialization
- `lync-core/memory-log`, `lync-core/file-log`, `lync-core/idb-log` — stores
- `lync-core/views` — branch tree, transcript, memory, leaderboard
- `lync-core/looms` — the loom/turn API
- `lync-core/synced-store` — live sync decorator and WebSocket transport
- `lync-core/uuid` — zero-dep UUIDv7 for event ids

Normative format spec:
[FORMAT.md](https://github.com/deepfates/lync/blob/main/FORMAT.md). Import and
export conventions:
[pacts/](https://github.com/deepfates/lync/tree/main/pacts). Full docs:
https://github.com/deepfates/lync#readme
