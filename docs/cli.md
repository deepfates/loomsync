# Lync command-line guide

The `lync` command is for people creating, inspecting, and converging `.lync`
files from a shell. It is a thin interface over the reference parser and relay;
[FORMAT.md](../FORMAT.md) defines the files themselves.

The CLI documented here belongs to the committed, unpublished 0.4.3 source.
npm currently serves 0.3.0, so confirm the published version before installing
globally:

<!-- example: fragment — live registry lookup and global installation -->
```bash
npm view @deepfates/lync version
npm install -g @deepfates/lync
lync --help
```

From a built source checkout, use `node bin/lync.js` wherever this guide says
`lync`.

## A complete local file journey

```bash
lync init story.lync
printf '%s\n' '{"kind":"notes/text","author":{"actor":"you"},"payload":{"text":"Once..."}}' | lync append story.lync
lync verify story.lync
lync view story.lync --as transcript
printf '%s\n' '{"kind":"notes/text","author":{"actor":"friend"},"payload":{"text":"Then..."}}' | lync append other.lync
lync merge story.lync other.lync -o merged.lync
lync view merged.lync --as tree
```

The output file remains ordinary JSONL. `view` prints derived JSON and never
changes the input.

## Commands

| Command | Present behavior |
| --- | --- |
| `lync init [file]` | Creates or truncates `file` to an empty valid Lync file. With no file, it only validates the invocation. |
| `lync append <file>` | Reads one JSON object from standard input, fills default envelope fields, validates it, appends one LF-terminated event, and prints its id. |
| `lync verify <files>` | Classifies all physical lines, reports non-accepted lines plus pending parents and graph diagnostics, and prints per-file and total counts. |
| `lync merge <files> -o <out>` | Writes a deterministic carried union without rewriting event body bytes. |
| `lync view <file> [--as transcript\|tree]` | Prints a computed JSON transcript or branch tree. Transcript is the default. |
| `lync serve [dir] [--port N] [--token T]` | Runs the optional WebSocket relay over `dir` until SIGINT or SIGTERM. |
| `lync sync <file> <url> [--root R] [--follow]` | Pushes local lines and pulls missing relay lines; `--follow` stays connected. |

Run `lync --help` for the concise inventory. Unknown commands and invalid
arguments exit 2.

## Append defaults and validation

Input must contain a namespaced `kind` and `author.actor`. If omitted, `append`
adds:

- `v: 1`;
- a UUIDv7 `id`;
- an RFC 3339 current timestamp in `at`;
- `parents: []`;
- `payload: {}`.

Caller-supplied `id`, `at`, `parents`, `payload`, `marked`, and `critical` are
preserved after validation. The command serializes the resulting object once
and appends it. It does not currently add the optional digest splice.

If a non-empty existing file lacks a final LF, `append` writes a separator LF
before the new event. Run `verify` first when that condition is unexpected;
the pre-existing final line may be nonconforming or invalid.

## Verification and exit status

`verify` prints counts for `accepted`, `nonconforming`, `garbage`, `damaged`,
and `conflict-variant` lines. It also prints pending-parent and graph-obstacle
records.

- Exit 0 means every line was accepted and there were no pending parents or
  graph diagnostics.
- Exit 1 means the input was read but at least one format or graph issue was
  surfaced.
- Exit 2 means usage or I/O failed.

Exit 0 proves conformance of the bytes examined. It does not prove that an
application understands each event kind or that the history is useful.

## Merge behavior

For each union event id, `merge` emits one exact stored sighting. A digested
sighting is preferred over an undigested one, and a signed digested sighting
over an unsigned one; remaining ties are stable. Other carried physical lines,
including damage, garbage, and conflict variants, remain surfaced in output
rather than being silently discarded.

The command does not overwrite its inputs, but `-o` follows ordinary file
write semantics and replaces an existing output path.

## View behavior and limits

Tree output includes each eligible node's parents, children, missing or
conflicted parents, suppression state, and graph obstacles. Transcript output
walks one parent path back from a chosen head and includes the head's downset
and partial status.

The CLI does not currently accept an explicit transcript head or fan-in parent
choice. It chooses the lexicographically final eligible leaf as the head and
the first held parent at fan-in. Applications that need deliberate selection
should call `lyncTranscriptView(result, head, { chooseParent })` from
`@deepfates/lync/views`.

## Sync

<!-- example: fragment — requires a long-running relay and follow mode is interactive -->
```bash
lync serve ./rooms --port 8787
lync sync story.lync ws://localhost:8787
lync sync story.lync ws://localhost:8787 --follow
```

The tokenless `serve` command is only for an isolated local development
environment; it listens on all network interfaces and must not be exposed to
external ingress. The current `lync sync` command cannot send the bearer header
required by `serve --token`. See [relay operations](./relay.md) for the
authenticated integration boundary.

`sync` uses Node's built-in WebSocket and therefore needs Node 21 or newer. It
uses the local file itself as the offline queue: complete local lines are
offered to the relay, and new remote lines are appended locally. A cursor in
`<file>.sync.json` advances only after a received line reaches a durable local
state or is explicitly surfaced as unusable.

The default relay root is derived from the input filename; `--root` overrides
it. `--follow` watches complete local appends and continues until interrupted.
A changed relay generation resets the saved sequence to zero and re-unions the
room so a stale cursor cannot silently skip recovered lines. Duplicates are
no-ops; surfaced same-id conflicts make the command exit 1.

If the local file has a non-LF-terminated final line, `sync` seals it with an LF
and reports that recovery before connecting. Inspect the result with `verify`.

The relay's dependency, storage, authentication, durability, and embedding
details are in [relay operations](./relay.md).
