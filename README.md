# lync

Most software forgets. Edit a document, choose one generated answer, or merge
two people's work, and the alternatives and decisions that produced the result
disappear.

Lync keeps the causal record. A `.lync` file is an append-only list of immutable
events: what someone wrote, what it followed from, which alternatives existed,
and what was later judged or chosen. Old events stay. Two copies combine by set
union, so branches survive instead of being flattened into one final transcript.

A Lync file is more than a transcript. The same event set can carry text and
media artifacts, model and program traces, judgments and selections, resident
lives, and world histories without forcing those domains into one ontology.
The envelope preserves causal references and integrity; versioned pacts define
domain meaning and applications choose the views they need.

`@deepfates/lync` is the TypeScript reference implementation. It provides the
parser, event stores, computed views, Loom APIs, presentation profiles, live
sync, a CLI, and a WebSocket relay. The format is the durable boundary;
everything else is a tool or interpretation layered above it.

> **Status:** the format is a v0 draft. The normative contract is
> [FORMAT.md](./FORMAT.md). The `v:1` envelope has not changed since its first
> publication; any incompatible envelope change requires a new version.

## Choose your path

| You want to… | Start here |
| --- | --- |
| Implement the format in another language | [FORMAT.md](./FORMAT.md), then the [v0 conformance vectors](./test/vectors/v0/README.md) |
| Integrate the TypeScript library | [Library guide and complete subpath reference](./docs/library.md) |
| Create, verify, merge, or view files from a shell | [CLI guide](./docs/cli.md) |
| Run or embed a sync relay | [Relay operations](./docs/relay.md) |
| Understand state ownership and failure boundaries | [Architecture](./docs/architecture.md) |
| Interpret imports, exports, authorship, ordering, or readable projections | [Pacts](./pacts/) |

## Version truth

The reviewed committed source is `@deepfates/lync` **0.4.3**. The npm registry
currently serves **0.3.0**. Uncommitted working-tree changes are not part of
the committed candidate.

Publishing and tagging require an explicit owner decision. Do not assume a
source-only subpath exists in the registry package; check before installing:

<!-- example: fragment — live registry lookup -->
```bash
npm view @deepfates/lync version
```

Use the committed source when following 0.4.3 documentation. The committed
candidate's contents, runtime floors, and publication gate are in
[RELEASE.md](./RELEASE.md).

## Try the causal record

From a source checkout, install exactly the locked dependencies and build the
0.4.3 command:

<!-- example: fragment — source-checkout setup, exercised by the fresh-clone smoke -->
```bash
pnpm install --frozen-lockfile
pnpm build
node bin/lync.js --help
```

Then run one history in a disposable directory. It starts once, forks into two
files, and reunites without losing either alternative:

<!-- example: fragment — source-checkout CLI path; exercised as a disposable journey -->
```bash
lync_bin="$(pwd)/bin/lync.js"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/lync-fork.XXXXXX")"
cd "$work_dir"
node "$lync_bin" init beginning.lync
printf '%s\n' '{"id":"0197f3a2-8c1e-7d40-b3a1-9e2d4c5f6a7b","kind":"notes/text","author":{"actor":"you"},"payload":{"text":"The bear reached the river."}}' | node "$lync_bin" append beginning.lync
cp beginning.lync quiet.lync
cp beginning.lync crossing.lync
printf '%s\n' '{"id":"0197f3a2-8c1f-7d40-b3a1-9e2d4c5f6a7b","kind":"notes/text","author":{"actor":"you"},"parents":["0197f3a2-8c1e-7d40-b3a1-9e2d4c5f6a7b"],"payload":{"text":"It waited and listened."}}' | node "$lync_bin" append quiet.lync
printf '%s\n' '{"id":"0197f3a2-8c20-7d40-b3a1-9e2d4c5f6a7b","kind":"notes/text","author":{"actor":"friend"},"parents":["0197f3a2-8c1e-7d40-b3a1-9e2d4c5f6a7b"],"payload":{"text":"It stepped into the current."}}' | node "$lync_bin" append crossing.lync
node "$lync_bin" merge quiet.lync crossing.lync -o merged.lync
node "$lync_bin" verify merged.lync
node "$lync_bin" view merged.lync --as tree
```

The published 0.3.0 CLI may differ; inspect its own `lync --help` rather than
treating this source example as evidence for the registry artifact.

The result has one root and two leaves. `merge` retains both siblings rather
than deciding which continuation won. `append` fills in the current timestamp
and any omitted envelope defaults; the explicit UUIDv7 ids make the causal
relationships readable in the example. `verify` classifies every physical
line and exits nonzero for nonconforming data, damage, conflicts, pending
parents, or graph obstacles.

The [CLI guide](./docs/cli.md) defines every verb and its important limits.

## Try the library

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

The parser retains and reports accepted, nonconforming, damaged, garbage, and
same-id conflict-variant lines. Views are computed from eligible events; they
do not replace the source bytes. See the [library guide](./docs/library.md) for
stores, Looms, large-file paths, presentation, references, indexes, and sync.

## Implemented now

- The reference parser implements byte preservation, digest splicing, same-id
  union, hostile-data classification, graph diagnostics, and critical
  suppression from `FORMAT.md`.
- The reference implementation exposes browser-safe parsing and IndexedDB
  paths, Node file and SQLite paths, Loom and index APIs, presentation
  profiles, sync clients, and a relay. [`package.json`](./package.json) owns the
  exact committed exports; [docs/library.md](./docs/library.md) explains how to
  choose among them.
- The CLI has seven verbs: `init`, `append`, `verify`, `merge`, `view`, `serve`,
  and `sync`.
- The relay stores canonical lines in append-only files, retains conflicts,
  surfaces persistence failures, and treats presence as ephemeral.

## Exercised evidence

- Thirteen conformance-vector sets run through the eager parser, and the
  indexed-union tests run the same set through the re-readable path.
- The checked-in [loss-free trial](./docs/trials/loss-free-trial.json) records
  one bounded disconnect, storage-failure, and relay-restart exercise in which
  every successfully appended event reached three client stores and relay
  disk, with failures surfaced.
- The repository verification gate runs unit and integration tests, typecheck,
  executable README examples, and a physical packed-artifact smoke. CI
  adds the fresh-clone CLI journey on Node 22.

This evidence establishes those bounded mechanics. It does not establish that
every deployment is production-ready, that every application kind is
understood, or that the broader causal-record experience is complete.

## Known limits and decisions

- The format remains a draft and the committed 0.4.3 candidate is not
  published. Publication and tagging remain an owner decision.
- The SQLite file-Loom cursor has passed retained-life and generated-history
  exercises, but its wider scale, crash, latency, suffix-reconciliation, and
  missing-final-LF criteria remain open in
  [`.tickets/lyn-hh9v`](./.tickets/lyn-hh9v.md).
- Lync is not a mutable shared-document CRDT: concurrent replicas converge
  because events do not change. Presence is the sole shipped ephemeral surface
  and uses per-participant clocks.

## Sources of authority

- [FORMAT.md](./FORMAT.md) owns the `.lync` protocol. [SPEC.md](./SPEC.md) is
  only a compatibility pointer.
- [`package.json`](./package.json) owns committed package identity, exports,
  supported core runtime, and packed files. Source and tests own implementation
  behavior; uncommitted changes are not release facts.
- `lync --help` owns the concise command inventory; [docs/cli.md](./docs/cli.md)
  explains its behavior.
- [docs/relay.md](./docs/relay.md) is the operator runbook. The format does not
  require this relay or any sync protocol.
- [Pacts](./pacts/) own typed meanings above the open event envelope. Unknown
  kinds remain valid data and must not be guessed at.
- [RELEASE.md](./RELEASE.md) owns the committed unpublished 0.4.3 candidate
  boundary. Bounded unfinished implementation work lives in
  [`.tickets`](./.tickets/). [ROADMAP.md](./ROADMAP.md) retains near-term
  context and candidates; it is not package or release authority.

## Development

Requires pnpm 9.15 and a supported Node runtime. CI exercises Node 22.

<!-- example: fragment — repository setup commands require a source checkout -->
```bash
pnpm install --frozen-lockfile
pnpm build
node bin/lync.js --help
pnpm test
pnpm verify
```

`pnpm verify` runs the path guard, tests, build and typecheck, executable README
examples, and a physical packed-artifact check. The fresh-clone
smoke script separately runs setup plus the CLI init/append/view/merge/verify
journey in a temporary clone.

The package has zero runtime dependencies. The relay is optional and loads the
operator-provided `ws` package only when constructed.
