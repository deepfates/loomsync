# lync

> **Status:** the lync format is a v0 draft (see [FORMAT.md](./FORMAT.md));
> the `v:1` event envelope has not changed since first publication and any
> change would come with a version bump. This package is the reference
> implementation.

Most software forgets. Edit a document and yesterday's version is gone. Write
with an AI that offers three options and the two you do not pick vanish. Let a
tool merge two people's edits and you get one result with no memory of who did
what or what was dropped. The story of how a thing came to be is thrown away at
every step.

lync keeps it. A `.lync` file is a list of events, one per line, in plain text.
Each line records one thing that happened. Someone wrote a sentence, marked a
version as good, or chose one branch over another. You never edit a line. To
change something you add a new line that points at the old one and says what
changed. The old line stays.

That one rule, only ever add and never edit, is where everything good comes
from. You can always see the whole history, every version and every branch you
did not take. Merging two copies is safe and boring, because you keep every
event from both and there are no edits to fight over. If the same event ever
shows up two different ways, lync keeps both and says so out loud instead of
quietly picking one. And because the file is plain text with a written-down
spec, you can still read it in twenty years, on a computer that has never heard
of this software.

A lync file is more than a transcript, because it keeps the branches and the
choices. From the same file you can make a readable document to hand someone,
or training data built from the exact versions you marked as good.

`@deepfates/lync` is the reference implementation. One package, zero runtime
dependencies, holding the parser, the event stores, the computed views, the
loom API, live sync, the `lync` command, and the sync relay. The format is the
durable center. Everything else is a tool that reads and writes it.

The long horizon is broader than conversation logs. The same event set can
carry text and media artifacts, derivations and deterministic compositions,
model/program traces, judgments and optimizer lineages, resident lives, and
world histories. These domains do not share one forced ontology: the envelope
preserves causal references and integrity, while versioned pacts define typed
relationships and applications choose projections appropriate to them.

This checkout is version 0.4.2; npm currently serves 0.3.0 pending an
owner-approved release. The format remains a v0 draft in both. Use a source
checkout when following 0.4-only documentation, and check
`npm view @deepfates/lync version` before assuming the published package has
the same surface. See the [0.4 release candidate notes](./RELEASE.md) for the
exact contract and runtime boundary.

## The Format

The normative specification is [FORMAT.md](./FORMAT.md). It is self-contained:
no code in this repository is required to implement it.

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
- Views are computed. This package ships branch tree, transcript, memory, and
  leaderboard helpers.

Every line has the same envelope:

```json
{"v":1,"id":"root","kind":"notes/text","at":"2026-07-06T04:12:31Z","author":{"actor":"deepfates","via":"example@0.1"},"parents":[],"payload":{"text":"Once..."}}
```

That line can be copied to another file, merged back later, verified byte for
byte, and read by software that has never heard of `notes/text`. Unknown
kinds are carried and traversed; meaning belongs to pacts layered above the
format — see [pacts/import.md](./pacts/import.md) (imports are transcription:
deterministic ids, provenance preserved, zero silent drops) and
[pacts/export.md](./pacts/export.md) (exports are projections of the event
log, including training data).

## Why not Yjs / Automerge?

Because there is nothing to merge. CRDT libraries solve concurrent mutation
of shared state — two people editing the same paragraph — and they solve it
well; if your data mutates, use one. lync events never mutate: correction,
judgment, and retraction are new events pointing at old ones, so two replicas
combine by plain set union of ids, with no operational transform, no vector
clocks, no merge algorithm at all. The same id with different bytes is not
resolved cleverly — both variants are kept and surfaced loudly. That trade
buys a durable plain-text format any transport converges (a relay, `rsync`,
an email attachment), at the cost of not being a live shared document. The
one ephemeral surface, presence, uses last-writer-wins clocks, not a CRDT.

## Conformance Vectors

The format is meant to be implemented in other languages, and the test
vectors are the product that makes a port checkable:
[test/vectors/v0](./test/vectors/v0). Each case is a directory holding a raw
input file (`input.lync`, or `a.lync` + `b.lync` for the merge case) and an
`expected.json` with the required classification of every physical line —
accepted, nonconforming, garbage, damaged, conflict-variant — plus union ids,
pending parents, and graph diagnostics. The thirteen cases cover valid events,
splice anchoring, damaged digests, garbage classes, same-id conflicts and
duplicates, graph obstacles, critical suppression, spelling-versus-value
equality, `marked`/`at` semantics, merge union, carried nonconforming lines,
and invalid signature splices.

A new implementation ports the vector suite first, this package's test suite
second, and its design never. `test/vectors/v0/README.md` documents the
expected-output schema; `generate.py` regenerates digests deterministically.

## The Library

```bash
npm install @deepfates/lync
```

Runs in Node and the browser. No dependencies. The browser-safe core
(parse, stores, views, looms, indexes, the loom client) needs only the Web
Crypto global, so its floor is **Node >=19** (or any browser) — that is the
`engines.node` the package declares. Two surfaces need a stricter runtime, and
that requirement is pinned where it applies, not on the whole package: the ws
sync transport (`@deepfates/lync/synced-store` `createWebSocketTransport`) and
`lync sync` reach for the built-in `WebSocket` global, unflagged only on **Node
>=21** — pass your own `WebSocketImpl` to run them on anything older. See
[Live sync inside an app](#live-sync-inside-an-app) and [The Command](#the-command).

### Parse, union, view

```ts
import { parseLyncFiles } from "@deepfates/lync/events";
import { lyncBranchTreeView, lyncTranscriptView } from "@deepfates/lync/views";

const bytes = new TextEncoder().encode(
  '{"v":1,"id":"root","kind":"notes/text","at":"2026-07-06T04:12:31Z","author":{"actor":"you"},"parents":[],"payload":{"text":"Once..."}}\n',
);

const parsed = parseLyncFiles([{ file: "story.lync", bytes }]);
console.log(parsed.lines[0].class); // "accepted"
console.log(lyncBranchTreeView(parsed).roots);
console.log(lyncTranscriptView(parsed, "root").entries.map((entry) => entry.id));
```

`parseLyncFiles` classifies every physical line and keeps the original bytes —
accepted events, nonconforming-but-carried lines, damaged lines, garbage, and
conflict variants (same id, different bytes) are all preserved and reported,
never silently dropped. `exportCarriedLyncBytes(parsed)` re-emits the carried
bytes. `LyncUnion` performs the same union incrementally and can buffer
children until their first missing parent arrives.

For source sets too large to retain twice in a browser, use the re-readable
indexed union. It applies the same line parser and union rules while retaining
only source locators, envelope topology, digests, diagnostics, and policy
state. Payload graphs exist for one line at a time; exact source lines and
view-eligible events are re-read lazily and verified against their indexed
bytes before they are returned.

<!-- example: fragment — browser File adapter; indexed-union tests exercise the exact source contract -->
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
  // Present, index, or reduce this event; the next event is still on disk.
  console.log(event.id, indexed.presentationProfile(event.id));
}
```

`maxChunkBytes` and `maxLineBytes` are explicit admission bounds. A source must
replay its declared length; an optional expected SHA-256 is authenticated in
the indexing pass. Every lazy read also verifies its exact byte range and line
terminator, so a changed, truncated, or reordered backing source fails closed.
`ownership` reports observed input size and the retained locator/envelope
counts; `retainedRawBytes` and `retainedPayloadObjects` are zero by contract.
The source object itself remains the byte authority and is not counted as index
ownership. Existing eager APIs are unchanged for small, source-preserving
workflows.

### Present known events without guessing

`@deepfates/lync/presentation` is the browser-safe readable boundary for open
Lync payloads. It dispatches exact kind and causally inherited profile
contracts, preserves source identity and ordered parents, names the JSON paths
used by every section, and distinguishes readable content from honest
structure. A claimed-but-malformed kind/profile is explicitly unsupported; an
unknown payload is never searched recursively for plausible prose.

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

Presentation is a non-mutating view, not an authorization or export engine.
Callers apply critical suppression and application policy first and retain the
original event bytes for source-preserving archives. The exact dispatch,
privacy, profile inheritance, and consumer obligations are in
[`pacts/presentation.md`](./pacts/presentation.md).

### Stores and looms

Event stores share one contract over memory, file, and IndexedDB backends. The
loom API gives programs turns and threads instead of raw events, on top of any
store:

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

The store API accepts raw lines through `union(line)` and structured event
bodies through `append(event)`. It reports conflicts, pending parents, garbage,
accepted events, and whether a failed durable flush remains pending without
making file order meaningful. Loom snapshot import
uses the optional `appendMany(events)` store capability to preserve causal order
with one durable flush; IndexedDB writes only changed records and streams them
sequentially within that transaction.

The Node file store keeps accepted lines in append-only `<root>.lync` files,
same-id variants in `<root>.conflicts`, unresolved lines in `pending.events`,
and exact garbage records in `garbage.json`. Older `events.json` snapshots are
untrusted replicas: one open re-unions their raw bytes with the canonical
directory, durably heals any unique bytes, and preserves the snapshot as an
ignored `events.legacy-*.json` artifact. Snapshot index fields never override
the event bytes themselves.

### Indexes

An index tracks a collection of looms — upsert entries, subscribe to changes:

```ts
import { loomRef } from "@deepfates/lync";
import { createMemoryLoomIndexes } from "@deepfates/lync/indexes/memory";

const indexes = createMemoryLoomIndexes();
const index = await indexes.create({ title: "My looms" });

index.subscribe((event) => console.log("index changed:", event.type));
await index.addLoom(loomRef("loom-1"), { title: "Story" });

console.log((await index.entries()).map((entry) => entry.title));
```

Entries carry a loom reference, optional title/kind/meta, and timestamps.
`export()`/`import()` round-trip a whole index as a snapshot.

### The loom client

One object that pairs looms with an index and resolves
loom/turn/thread/index references to and from URLs:

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

// Round-trip a reference through a shareable URL (?ref=...).
// In the browser, pass `window.location` instead of a URL object.
const url = client.references.toUrl(ref, new URL("https://example.com/story"));
const opened = await client.openReference(client.references.fromUrl(new URL(url)));
console.log(opened.kind); // "loom" — opened.loom is ready to appendTurn
```

`@deepfates/lync/client/testing` ships `createTestLoomClient`, a fully in-memory
client for tests and embedded experiments — deterministic when you pass
`createId` and `now`.

### Live sync inside an app

The sync protocol runs in a browser or Node app with no CLI. Wrap any event
store in `createSyncedStore`; looms and indexes built over it update live as
collaborators append, because they already recompute through the store's
`subscribe`:

<!-- example: fragment — needs a live relay and an app render loop; covered by the synced-store tests -->
```ts
import { createMemoryEventStore } from "@deepfates/lync/memory-log";
import { createLyncLooms } from "@deepfates/lync/looms";
import { createSyncedStore, createWebSocketTransport } from "@deepfates/lync/synced-store";

const transport = createWebSocketTransport("wss://host/lync");
const store = createSyncedStore(createMemoryEventStore(), transport, {
  onStatus: (s) => console.log("sync:", s.connection, "live:", s.liveRoots),
});
const looms = createLyncLooms({ store, author: { actor: "alice" } });

const loom = await looms.open(loomId);
loom.subscribe(() => render(loom)); // fires on local AND remote turns
await loom.appendTurn(parentId, { text: "typed live" });
```

Local appends are pushed to the relay; remote lines are ingested through the
same `union` path and surface reactively. Offline appends queue and flush on
reconnect; the store re-subscribes automatically. The transport is an
interface — pass your own for tests or a non-WebSocket carrier. The client
side uses the platform's built-in WebSocket: no dependency, in the browser or
in Node. **Runtime floor for this surface:** the built-in `WebSocket` global is
unflagged only on **Node >=21** (the browser always has it); on older Node,
`createWebSocketTransport` throws unless you pass `options.WebSocketImpl` (e.g.
the `ws` package). This is stricter than the package's `engines.node` (>=19),
which is set for the browser-safe core alone.

### Presence: who is here right now

Presence is the one ephemeral thing in lync: the relay fans out `presence`
frames and never stores them, so every client keeps its OWN roster of who is
present. `@deepfates/lync/presence-awareness` is that roster — a small
state machine with last-writer-wins clocks per participant, TTL sweeps for
peers that go quiet, and heartbeats so late joiners recover you. It is keyed
by client (one person on two devices is two participants), and `state: null`
is a graceful leave.

The machine is pure and transport-agnostic. Below, two participants are wired
directly to each other; in an app you wire `send` to `SyncedStore.presence`
and feed `SyncedStore.onPresence` into `receive`, then call `start()` for
real heartbeat and sweep timers:

```ts
import { createPresenceAwareness } from "@deepfates/lync/presence-awareness";

const alice = createPresenceAwareness({
  client: "alice-laptop",
  send: (root, client, data) => bob.receive(root, client, data),
});
const bob = createPresenceAwareness({
  client: "bob-phone",
  send: (root, client, data) => alice.receive(root, client, data),
  onDelta: (root, delta) =>
    console.log(root, "joined:", delta.added.map((p) => p.state.actor)),
});

alice.setLocal("story", { actor: "alice", typing: true });
console.log(bob.roster("story").map((p) => `${p.state.actor} typing=${p.state.typing}`));
alice.setLocal("story", null); // graceful leave: bob's roster drops alice at once
console.log("after leave:", bob.roster("story").length); // 0
```

`roster(root)` is the current view, `onDelta` fires on every add, update, and
remove (including TTL timeouts). Clocks order states; liveness is separate,
so a heartbeat refreshes a peer without burning a new clock.

### Subpath exports

- `@deepfates/lync/events` — line parsing, carried-byte export, incremental union
- `@deepfates/lync/indexed-union` — bounded raw-payload indexing over re-readable sources
- `@deepfates/lync/store` — the event-store contract and serialization
- `@deepfates/lync/memory-log`, `@deepfates/lync/file-log`, `@deepfates/lync/idb-log` — stores
  (`file-log` is node-only; it keeps `node:fs` off the browser path)
- `@deepfates/lync/views` — branch tree, transcript, memory, leaderboard
- `@deepfates/lync/presentation` — exact kind/profile readable projection
- `@deepfates/lync/looms` — the loom/turn API
- `@deepfates/lync/references` — loom/turn/thread/index references and URLs
- `@deepfates/lync/synced-store` — live sync decorator and WebSocket transport
- `@deepfates/lync/sync-protocol` — the five sync frames, encode/decode
- `@deepfates/lync/presence-awareness` — client-side who-is-here roster over presence frames
- `@deepfates/lync/uuid` — zero-dep UUIDv7 for event ids
- `@deepfates/lync/indexes`, `@deepfates/lync/indexes/entries`,
  `@deepfates/lync/indexes/memory`, `@deepfates/lync/indexes/types` — loom indexes
- `@deepfates/lync/client`, `@deepfates/lync/client/testing`, `@deepfates/lync/client/types` —
  the loom client
- `@deepfates/lync/relay` — the sync relay (see [The Relay](#the-relay))

## The Command

The package installs a `lync` bin with seven verbs: `init`, `append`,
`verify`, `merge`, `view`, `serve`, and `sync`.

```bash
npm install -g @deepfates/lync
```

```bash
lync init story.lync
printf '%s\n' '{"kind":"notes/text","author":{"actor":"you"},"payload":{"text":"Once..."}}' | lync append story.lync
lync verify story.lync
lync view story.lync --as transcript
printf '%s\n' '{"kind":"notes/text","author":{"actor":"friend"},"payload":{"text":"Then..."}}' | lync append other.lync
lync merge story.lync other.lync -o merged.lync
lync view merged.lync --as tree
```

`append` fills the envelope for you: a UUIDv7 id, the current timestamp, `v`,
and `parents` default in; anything you supply is kept. `verify` reports what
every physical line is — accepted, nonconforming, damaged, garbage, or
conflict variant — and never drops bytes; it exits 0 only when every line is
accepted. `view` renders `transcript` or `tree`.

Any lync file can converge with any other copy through a relay:

<!-- example: fragment — needs a live relay pair; the serve/sync path is covered by the relay and cli test suites -->
```bash
lync serve ./rooms --port 8787              # the relay: one append-only file per root
lync sync story.lync ws://host:8787         # one-shot: push what it lacks, pull what you lack
lync sync story.lync ws://host:8787 --follow  # stay live until Ctrl-C
```

`lync sync` uses Node's built-in `WebSocket` — no install beyond the package,
but that global is unflagged only on **Node >=21**, so the sync verb needs that
runtime (stricter than the package's `engines.node` >=19 core floor). `lync
serve` runs the relay and needs `ws` present (`npm install ws`); see below.

## The Relay

The relay is deliberately dumb. Events are immutable and merge is union by
id, so the protocol has no merge logic: five JSON frames (`sub`, `ev`,
`live`, `presence`, `err`) that move canonical line bytes. The server never
interprets an event envelope or payload: it extracts the id and applies only
the byte-level digest-splice rule needed to compare same-id bodies. It stores
each root as a plain `.lync` file plus a `.conflicts` sidecar and echoes
accepted events to every subscriber — echoes are duplicate no-ops under
union. `seq` is a per-root replay counter used as a resume cursor
(`<file>.sync.json`), so an offline client reconnects exactly where it left
off.

Running a relay is the one thing that needs a WebSocket server, and Node does
not ship one — so the relay acquires [`ws`](https://www.npmjs.com/package/ws)
lazily at the moment you construct it. `@deepfates/lync` declares no dependency on
`ws` at all: install it yourself next to your server
(`npm install ws`), and everything else in the package works without it.
If you bundle a server that runs the relay, mark `ws` as external — the
acquisition is a dynamic require that bundlers cannot see through.

Standalone:

<!-- example: daemon — expect "relay on" -->
```ts
import { startLyncServe } from "@deepfates/lync/relay";

const server = await startLyncServe({ dir: "./rooms", port: 8787 });
console.log("relay on", server.port);

// Look inside a running relay — read-only, mutates nothing. Each record is
// { root, generation, seq, subscribers, pendingUnpersisted }, where
// pendingUnpersisted is the durability lag: lines in memory but not yet on disk.
for (const room of server.status()) {
  console.log(room.root, "seq", room.seq, "subs", room.subscribers, "lag", room.pendingUnpersisted);
}
// later: await server.close();
```

On an existing HTTP server:

<!-- example: fragment — embeds into an existing app server (free variables: app, checkSession) -->
```ts
import { createServer } from "node:http";
import { attachLyncServer } from "@deepfates/lync/relay";

const httpServer = createServer(app);
const lync = attachLyncServer(httpServer, {
  storageDir: "./rooms",
  path: "/lync",              // default
  keepAliveInterval: 30_000,  // optional: ping through idle proxies
  maxConnections: 500,        // optional
  authenticate: (req) => checkSession(req), // optional, after token check
});
httpServer.listen(3000);
```

For full control, `createLyncRelay` gives you `handleUpgrade` to call from
your own `upgrade` listener. All three (`createLyncRelay`, `startLyncServe`,
`attachLyncServer`) expose `status()` — a read-only snapshot of every live
room's seq, subscriber count, and pending-unpersisted durability lag.

Guarantees: same id plus the same body bytes is one event even when stored
digest/signature metadata differs. Same id plus different body bytes is never
resolved — every retained variant is kept in a `.conflicts` sidecar, replayed
to late clients, and surfaced loudly. Persist failures are broadcast, never
swallowed. `close()` retries pending appends and rejects with the affected
room/id if accepted bytes still cannot be made durable. A truncated final line
after a crash is sealed and surfaced as damaged, never eaten. Presence frames
are relayed, never stored. `--token T` (or `token` in the API) requires
`Authorization: Bearer T` on every upgrade.

The relay is a tool shipped beside the format, not part of it: FORMAT.md
deliberately excludes sync protocols, and any transport that moves canonical
line bytes and unions by id converges the same files without this relay.

## Development

<!-- example: fragment — repo setup commands that need a checkout, not a scratch dir; scripts/fresh-clone-smoke.sh runs this exact sequence in a temporary clone -->
```bash
pnpm install
pnpm build
node bin/lync.js --help
pnpm test
pnpm verify
```

`pnpm verify` runs the path guard, tests, build + typecheck, and executes
every fenced example in this README against the built package
(`pnpm check:examples`). README examples are contract: a block runs
as-written unless an `<!-- example: fragment -->` comment above it declares
why it can't run alone.

For a fresh clone, `pnpm install && pnpm build` is the supported setup
sequence. After that, `node bin/lync.js --help` prints the CLI help.
`scripts/fresh-clone-smoke.sh` verifies that sequence in a temporary clone
and runs the CLI story path: init, append, view, concatenate, merge, and
verify.

Project-owned implementation work is tracked in `.tickets/`; run `tk list`
from this repository to inspect it. Cross-project corpus coordination remains
in the workshop root ledger.
