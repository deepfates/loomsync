# TypeScript library guide

This guide is for applications consuming `@deepfates/lync`. It describes the
committed, unpublished 0.4.3 source. npm still serves 0.3.0, so check the
registry version before assuming these exports are installed:

<!-- example: fragment — live registry lookup and installation -->
```bash
npm view @deepfates/lync version
npm install @deepfates/lync
```

The package has no runtime dependencies. Its declared core floor is Node 19;
browser-safe paths need Web Crypto. The built-in WebSocket transport needs
Node 21 unless you provide a `WebSocket` implementation, the SQLite file-Loom
cursor needs Node 22.13, and the relay needs an operator-installed `ws` server
package. Importing the root or a browser-safe subpath does not load those
stricter Node surfaces.

## Choose a data path

- Use `parseLyncFiles` for complete files that fit comfortably in memory and
  need synchronous views or exact carried-byte export.
- Use an `EventStore` when events arrive incrementally or an application needs
  subscriptions, Looms, IndexedDB, or append-only Node journals.
- Use `indexLyncSources` for large re-readable browser or Node sources when raw
  corpus bytes and parsed payload graphs must not be retained by the index.
- Use the Node file-Loom cursor for one explicitly selected long-lived Loom
  backed by canonical files. It does not choose among tips.

## Parse, union, and view

```ts
import { parseLyncFiles } from "@deepfates/lync/events";
import { lyncBranchTreeView, lyncTranscriptView } from "@deepfates/lync/views";

const bytes = new TextEncoder().encode(
  '{"v":1,"id":"root","kind":"notes/text","at":"2026-07-06T04:12:31Z","author":{"actor":"you"},"parents":[],"payload":{"text":"Once..."}}\n',
);

const parsed = parseLyncFiles([{ file: "story.lync", bytes }]);
console.log(parsed.lines[0].class);
console.log(lyncBranchTreeView(parsed).roots);
console.log(lyncTranscriptView(parsed, "root").entries.map((entry) => entry.id));
```

`parseLyncFiles` classifies every physical line and keeps its original bytes.
`exportCarriedLyncBytes` re-emits carried bytes. `LyncUnion` applies the same
rules incrementally and buffers children whose parents have not arrived.

The shipped views are branch tree, transcript, memory, and leaderboard. A
transcript caller supplies the head and may supply `chooseParent` at fan-in;
views report partial traversal rather than filling holes or resolving
conflicts.

## Stores and Looms

Memory, IndexedDB, and Node file stores share the `EventStore` contract. Raw
stored lines enter through `union`; structured event bodies enter through
`append`. Diagnostics distinguish conflicts, pending parents, garbage, and a
failed durable flush that remains pending.

```ts
import { createLyncLooms } from "@deepfates/lync/looms";
import { createMemoryEventStore } from "@deepfates/lync/memory-log";

const looms = createLyncLooms({
  store: createMemoryEventStore(),
  author: { actor: "you", via: "my-app@0.1" },
});

const info = await looms.create({ title: "Story" });
const loom = await looms.open(info.id);
const first = await loom.appendTurn(null, { text: "Once..." });
await loom.appendTurn(first.id, { text: "Then..." });
```

The Node file store appends accepted lines to `<root>.lync`, conflicts to
`<root>.conflicts`, unresolved lines to `pending.events`, and exact garbage
records to `garbage.json`. On open, canonical journals win over legacy
`events.json` snapshots; unique snapshot bytes are healed into the journals
and the old snapshot is retained as an ignored migration artifact.

Loom snapshot import can use a store's optional `appendMany` capability for
one causally ordered flush. IndexedDB writes only changed records in that
transaction.

## Large re-readable sources

`indexLyncSources` scans async byte streams with explicit `maxChunkBytes` and
`maxLineBytes` admission bounds. It retains source locators, envelopes,
digests, topology, diagnostics, and policy state—not raw lines or parsed
payload objects. The caller's source remains the byte authority.

<!-- example: fragment — browser File adapter with application-owned expectedSha256 -->
```ts
import { indexLyncSources } from "@deepfates/lync/indexed-union";

const indexed = await indexLyncSources([{
  file: file.name,
  size: file.size,
  expectedSha256,
  async *stream() {
    const reader = file.stream().getReader();
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        yield item.value;
      }
    } finally {
      reader.releaseLock();
    }
  },
  async read(start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  },
}]);

for await (const { event } of indexed.events()) {
  console.log(event.id, indexed.presentationProfile(event.id));
}
```

An optional whole-source SHA-256 is checked during indexing. Every lazy read
also verifies its byte range, line terminator, and indexed identity, so a
changed, truncated, or reordered backing source fails closed.

## Selected file-Loom access

`@deepfates/lync/file-loom-cursor` is a Node-only SQLite catalog over canonical
Lync files. It supports explicit-tip ancestry, tail and range reads, append,
and close while payloads remain in JSONL and are verified on demand. An
unchanged source manifest reuses the catalog. A source change or catalog fault
currently causes a complete bounded-memory rebuild; a missing final LF can be
read but must be repaired explicitly before append resumes.

`@deepfates/lync/file-loom-checkpoint` captures an explicitly selected tip
against exact byte prefixes of the complete canonical source set. Verification
later authenticates those prefixes and recomputes Loom ancestry, depth, body
digest, chain digest, and locator. Later appends do not invalidate an older
checkpoint; mutation or truncation inside a captured prefix does.

The file cursor has passed bounded retained-life and generated-history
exercises, but its wider 2 GB, crash-matrix, latency, suffix-reconciliation,
and repair criteria remain open in [`lyn-hh9v`](../.tickets/lyn-hh9v.md).

## Presentation

Presentation turns an eligible event into allowlisted readable content or
structure without changing the event. Exact kind/profile contracts claim an
event before the shallow generic text pact; malformed claimed events fail
closed and unknown payloads are never recursively searched for prose.

```ts
import { presentLyncEvent } from "@deepfates/lync/presentation";

const result = presentLyncEvent({
  v: 1,
  id: "event-1",
  kind: "notes/text",
  at: "2026-07-06T04:12:31Z",
  author: { actor: "you" },
  parents: [],
  payload: { text: "Once..." },
});
if (result.status === "presented") {
  console.log(result.presentation.kind, result.presentation.text);
  console.log(result.presentation.source.id);
}
```

Apply view eligibility, critical suppression, authorization, and application
policy before presentation. A presentation is not a source-preserving export
and does not decide whether content is trainable. The exact dispatch and
consumer obligations are in the [presentation pact](../pacts/presentation.md).

## Indexes, references, and client

An index tracks a collection of Loom references and emits changes. The client
pairs Looms with indexes and resolves Loom, turn, thread, and index references
to and from URLs.

```ts
import { createLyncLooms } from "@deepfates/lync/looms";
import { createMemoryEventStore } from "@deepfates/lync/memory-log";
import { createMemoryLoomIndexes } from "@deepfates/lync/indexes/memory";
import { createLoomClient } from "@deepfates/lync/client";

const client = createLoomClient({
  looms: createLyncLooms({ store: createMemoryEventStore(), author: { actor: "you" } }),
  indexes: createMemoryLoomIndexes(),
});

const info = await client.looms.create({ title: "Story" });
const ref = client.references.loom(info.id);
const url = client.references.toUrl(ref, new URL("https://example.com/story"));
const opened = await client.openReference(client.references.fromUrl(new URL(url)));
console.log(opened.kind);
```

`@deepfates/lync/client/testing` provides a fully in-memory client for tests;
passing `createId` and `now` makes it deterministic.

## Live sync and presence

`createSyncedStore` decorates any event store. Local appends are offered to the
transport; remote lines enter through the same `union` path; offline appends
queue and flush after reconnect. Loom subscriptions therefore see local and
remote turns through the store's existing notification boundary.

<!-- example: fragment — requires an application render loop, ids, and a live relay -->
```ts
import { createMemoryEventStore } from "@deepfates/lync/memory-log";
import { createLyncLooms } from "@deepfates/lync/looms";
import { createSyncedStore, createWebSocketTransport } from "@deepfates/lync/synced-store";

const transport = createWebSocketTransport("wss://host/lync");
const store = createSyncedStore(createMemoryEventStore(), transport, {
  onStatus: (status) => console.log(status.connection, status.liveRoots),
});
const looms = createLyncLooms({ store, author: { actor: "alice" } });
const loom = await looms.open(loomId);
loom.subscribe(() => render(loom));
await loom.appendTurn(parentId, { text: "typed live" });
```

Node's built-in WebSocket global is unflagged from Node 21. On an older Node
runtime, pass `options.WebSocketImpl`; browsers already provide it.

Presence is ephemeral and transport-agnostic. Each client owns its roster;
clocks order participant state, heartbeats refresh liveness, TTL sweeps remove
silent peers, and `state: null` is a graceful leave. Relay presence frames are
never persisted.

## Complete 0.4.3 subpath reference

This table is derived from the `exports` map in `package.json`; that map is the
authority if the two ever disagree.

| Import | Environment | Responsibility |
| --- | --- | --- |
| `@deepfates/lync` | Browser / Node 19+ | Browser-safe root barrel: errors, IndexedDB, indexed union, Looms, memory store, store types, views, references, and shared types |
| `@deepfates/lync/errors` | Browser / Node 19+ | Structured Loom errors and error codes |
| `@deepfates/lync/memory` | Browser / Node 19+ | Convenience in-memory Loom construction |
| `@deepfates/lync/events` | Browser / Node 19+ | Physical-line parsing, carried-byte export, and incremental union |
| `@deepfates/lync/indexed-union` | Browser / Node 19+ | Bounded raw-payload indexing over re-readable sources |
| `@deepfates/lync/file-log` | Node 19+ | Canonical append-only file event store and file-backed Loom convenience |
| `@deepfates/lync/file-loom-cursor` | Node 22.13+ | SQLite-backed, explicit-tip file-Loom access |
| `@deepfates/lync/file-loom-checkpoint` | Node 19+ | Capture and verify selected tips against canonical source prefixes |
| `@deepfates/lync/idb-log` | Browser | IndexedDB event store |
| `@deepfates/lync/looms` | Browser / Node 19+ | Loom and turn API over an event store |
| `@deepfates/lync/memory-log` | Browser / Node 19+ | In-memory event store |
| `@deepfates/lync/store` | Browser / Node 19+ | Event-store contract, diagnostics, and serialization |
| `@deepfates/lync/views` | Browser / Node 19+ | Branch tree, transcript, memory, and leaderboard views |
| `@deepfates/lync/presentation` | Browser / Node 19+ | Exact kind/profile readable projection |
| `@deepfates/lync/profiles/text-story` | Browser / Node 19+ | Typed text-story Loom profile and validators |
| `@deepfates/lync/references` | Browser / Node 19+ | Loom, turn, thread, and index references and URL encoding |
| `@deepfates/lync/types` | Browser / Node 19+ | Shared Loom, turn, index, and reference types |
| `@deepfates/lync/sync-protocol` | Browser / Node 19+ | `sub`, `ev`, `live`, `presence`, and `err` frame types and codecs |
| `@deepfates/lync/synced-store` | Browser; Node 21+ by default | Live-sync store decorator and WebSocket transport; older Node may inject `WebSocketImpl` |
| `@deepfates/lync/presence-awareness` | Browser / Node 19+ | Per-client participant roster and heartbeat/TTL state machine |
| `@deepfates/lync/uuid` | Browser / Node 19+ | Zero-dependency UUIDv7 generation |
| `@deepfates/lync/indexes` | Browser / Node 19+ | Loom index public barrel |
| `@deepfates/lync/indexes/entries` | Browser / Node 19+ | Index entry upsert helper |
| `@deepfates/lync/indexes/memory` | Browser / Node 19+ | In-memory Loom indexes |
| `@deepfates/lync/indexes/types` | Browser / Node 19+ | Loom index interfaces and events |
| `@deepfates/lync/client` | Browser / Node 19+ | Loom client over Looms, indexes, and references |
| `@deepfates/lync/client/testing` | Browser / Node 19+ | Deterministic in-memory test client |
| `@deepfates/lync/client/types` | Browser / Node 19+ | Client and opened-reference types |
| `@deepfates/lync/relay` | Node 19+ plus `ws` | Standalone, attached, and low-level WebSocket relay APIs |

The command is installed as `lync`; it is not a JavaScript export. See the
[CLI guide](./cli.md). Relay deployment and recovery belong in the
[operator runbook](./relay.md).
