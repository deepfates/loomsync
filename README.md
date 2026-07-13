# lync

lync is a file format for append-only interaction history, and `lync-core` is
its reference implementation — one package that ships the parser, event
stores, computed views, the loom API, live sync, the `lync` command, and the
sync relay. Zero runtime dependencies.

A `.lync` file is UTF-8 JSONL: each line is one immutable event with an
envelope, parent links, provenance, and a payload owned by the event kind.
Merge is set union by event id. Branch trees, transcripts, memory views, and
leaderboards are computed views over the same event set — never stored as
truth themselves.

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
npm install lync-core
```

Runs in Node (>=22) and the browser. No dependencies.

### Parse, union, view

```ts
import { parseLyncFiles } from "lync-core/events";
import { lyncBranchTreeView, lyncTranscriptView } from "lync-core/views";

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

### Stores and looms

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

The store API accepts raw lines through `union(line)` and structured event
bodies through `append(event)`. It reports conflicts, pending parents, garbage,
and accepted events without making file order meaningful.

### Indexes

An index tracks a collection of looms — upsert entries, subscribe to changes:

```ts
import { loomRef } from "lync-core";
import { createMemoryLoomIndexes } from "lync-core/indexes/memory";

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
import { createLyncLooms } from "lync-core/looms";
import { createMemoryEventStore } from "lync-core/memory-log";
import { createMemoryLoomIndexes } from "lync-core/indexes/memory";
import { createLoomClient } from "lync-core/client";

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

`lync-core/client/testing` ships `createTestLoomClient`, a fully in-memory
client for tests and embedded experiments — deterministic when you pass
`createId` and `now`.

### Live sync inside an app

The sync protocol runs in a browser or Node app with no CLI. Wrap any event
store in `createSyncedStore`; looms and indexes built over it update live as
collaborators append, because they already recompute through the store's
`subscribe`:

<!-- example: fragment — needs a live relay and an app render loop; covered by the synced-store tests -->
```ts
import { createMemoryEventStore } from "lync-core/memory-log";
import { createLyncLooms } from "lync-core/looms";
import { createSyncedStore, createWebSocketTransport } from "lync-core/synced-store";

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
in Node.

### Subpath exports

- `lync-core/events` — line parsing, carried-byte export, incremental union
- `lync-core/store` — the event-store contract and serialization
- `lync-core/memory-log`, `lync-core/file-log`, `lync-core/idb-log` — stores
  (`file-log` is node-only; it keeps `node:fs` off the browser path)
- `lync-core/views` — branch tree, transcript, memory, leaderboard
- `lync-core/looms` — the loom/turn API
- `lync-core/references` — loom/turn/thread/index references and URLs
- `lync-core/synced-store` — live sync decorator and WebSocket transport
- `lync-core/sync-protocol` — the five sync frames, encode/decode
- `lync-core/uuid` — zero-dep UUIDv7 for event ids
- `lync-core/indexes`, `lync-core/indexes/entries`,
  `lync-core/indexes/memory`, `lync-core/indexes/types` — loom indexes
- `lync-core/client`, `lync-core/client/testing`, `lync-core/client/types` —
  the loom client
- `lync-core/relay` — the sync relay (see [The Relay](#the-relay))

## The Command

The package installs a `lync` bin with seven verbs: `init`, `append`,
`verify`, `merge`, `view`, `serve`, and `sync`.

```bash
npm install -g lync-core
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

`lync sync` uses Node's built-in WebSocket — no install beyond the package.
`lync serve` runs the relay and needs `ws` present (`npm install ws`); see
below.

## The Relay

The relay is deliberately dumb. Events are immutable and merge is union by
id, so the protocol has no merge logic: five JSON frames (`sub`, `ev`,
`live`, `presence`, `err`) that move canonical line bytes. The server never
parses a line beyond extracting its id, stores each root as a plain `.lync`
file you can read with any lync tool, and echoes accepted events to every
subscriber — echoes are duplicate no-ops under union. `seq` is a per-root
arrival counter used as a resume cursor (`<file>.sync.json`), so an offline
client reconnects exactly where it left off.

Running a relay is the one thing that needs a WebSocket server, and Node does
not ship one — so the relay acquires [`ws`](https://www.npmjs.com/package/ws)
lazily at the moment you construct it. `lync-core` declares no dependency on
`ws` at all: install it yourself next to your server
(`npm install ws`), and everything else in the package works without it.
If you bundle a server that runs the relay, mark `ws` as external — the
acquisition is a dynamic require that bundlers cannot see through.

Standalone:

<!-- example: daemon — expect "relay on" -->
```ts
import { startLyncServe } from "lync-core/relay";

const server = await startLyncServe({ dir: "./rooms", port: 8787 });
console.log("relay on", server.port);
// later: await server.close();
```

On an existing HTTP server:

<!-- example: fragment — embeds into an existing app server (free variables: app, checkSession) -->
```ts
import { createServer } from "node:http";
import { attachLyncServer } from "lync-core/relay";

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
your own `upgrade` listener.

Guarantees: same-id-different-bytes is never resolved — both variants are
kept (a `.conflicts` sidecar) and both sides are told loudly. Persist failures
are broadcast, never swallowed. A truncated final line after a crash is
sealed and surfaced as damaged, never eaten. Presence frames are relayed,
never stored. `--token T` (or `token` in the API) requires
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
