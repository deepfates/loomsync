# Relay operations

This runbook is for operators and server integrators running Lync's optional
WebSocket relay. The relay moves immutable canonical line bytes; it is not part
of the [Lync format](../FORMAT.md), does not interpret event payloads, and does
not choose or merge application state.

The API described here belongs to the committed, unpublished 0.4.3 source. npm
still serves 0.3.0; confirm package availability before deployment.

## Runtime and dependency

Run the relay on Node 19 or newer. The package has zero declared runtime
dependencies, so an operator must install `ws` beside the server:

```bash
npm install @deepfates/lync ws
```

`ws` is acquired only when a relay is constructed. Browser-safe package paths
do not load it. When bundling a server, keep `ws` external because the relay
loads it dynamically.

## Standalone command

<!-- example: fragment — long-running server stopped by a signal -->
```bash
lync serve ./rooms --port 8787
```

The command creates `./rooms` if needed, listens on plain HTTP/WebSocket, and
runs until SIGINT or SIGTERM. It listens on all network interfaces. The
tokenless command above is only for an isolated local development environment
whose network policy rejects external ingress; do not run it on an externally
reachable host. `--token` is optional; when present, every upgrade must send
`Authorization: Bearer <token>`. The standalone server does not provide TLS,
token rotation, rate limits, or account management. Put it behind
infrastructure that owns those concerns when they are required.

A client converges a local file with a room as follows:

<!-- example: fragment — requires the long-running relay above -->
```bash
lync sync story.lync ws://localhost:8787 --root story
lync sync story.lync ws://localhost:8787 --root story --follow
```

`lync sync` needs Node 21 because the CLI uses Node's built-in WebSocket. See
the [CLI guide](./cli.md) for cursor and local-file recovery behavior. The
current CLI cannot add an `Authorization` header, so it cannot connect to a
relay started with `--token`. Authenticated deployments need a programmatic
client whose WebSocket implementation supplies the bearer header.

## Storage layout

Each root name is restricted to ASCII letters, digits, `.`, `_`, and `-`. A
room owns these files under the configured directory:

- `<root>.lync`: append-only primary line history;
- `<root>.conflicts`: retained same-id, different-body variants.

Clients keep replay cursors separately in `<local-file>.sync.json`; the relay
does not persist its per-process generation or sequence counter.

Same id plus the same verified body bytes is a duplicate even when the stored
digest or signature splice differs. Same id plus different body bytes is
retained as a conflict variant, replayed to late clients, and surfaced with an
error frame. The relay never silently selects a winner.

Presence frames are fanned out to current subscribers and never written to
disk.

## Programmatic standalone server

<!-- example: daemon — expect "relay on" -->
```ts
import { startLyncServe } from "@deepfates/lync/relay";

const server = await startLyncServe({ dir: "./rooms", port: 0 });
console.log("relay on", server.port);

for (const room of server.status()) {
  console.log(room.root, room.seq, room.subscribers, room.pendingUnpersisted);
}

await server.close();
```

Port `0` selects a free port. `close()` stops intake, closes sockets, and
retries pending durable writes before resolving.

## Attach to an existing HTTP server

<!-- example: fragment — requires application request handling and session policy -->
```ts
import { createServer } from "node:http";
import { attachLyncServer } from "@deepfates/lync/relay";

const httpServer = createServer(app);
const lync = attachLyncServer(httpServer, {
  storageDir: "./rooms",
  path: "/lync",
  keepAliveInterval: 30_000,
  maxConnections: 500,
  authenticate: (request) => checkSession(request),
});
httpServer.listen(3000);

// During application shutdown:
await lync.close();
```

`attachLyncServer` handles only upgrades whose URL path matches `path`
(default `/lync`) and leaves other upgrades to the host application. The
optional bearer token check runs before `authenticate`. `maxConnections`
returns HTTP 503 when the live socket count is at the configured limit.

For servers that already own upgrade routing, use `createLyncRelay` and call
`handleUpgrade`; for an already-upgraded compatible socket, call
`handleConnection`.

## Health and durability

All three relay entry points expose a read-only `status()` snapshot. Each live
room reports:

| Field | Meaning |
| --- | --- |
| `root` | Room and storage basename |
| `generation` | Fresh identifier for this recovered in-memory log generation |
| `seq` | Per-generation arrival/replay counter; not causal order |
| `subscribers` | Current subscribed socket count |
| `pendingUnpersisted` | Accepted and broadcast lines still awaiting disk persistence |

Healthy durable operation has `pendingUnpersisted: 0`. Reading status does not
open rooms or retry writes. Export the snapshot into the host application's
existing health/metrics system if monitoring is required; the package does not
ship a metrics endpoint.

A primary-file append failure is broadcast as `persist-failed`, leaves the
line visible in memory, and increments `pendingUnpersisted`. The next duplicate
push or room append retries pending lines in order. `close()` also retries and
rejects with the affected room/id when accepted bytes still cannot be made
durable. Treat a rejection as an incomplete shutdown requiring operator
attention; do not report the relay as durably drained.

A conflict-sidecar write failure is surfaced as `conflict-persist-failed`; an
unpersisted conflict variant cannot be recovered after process loss.

## Restart and recovery

On first access after restart, a room recovers its primary file and conflict
sidecar. Persisted conflict variants re-enter the replay stream. A truncated
final line is sealed with LF, retained as damaged evidence, logged, and
reported to subscribers; it is not replayed as an event.

Every recovery mints a new `generation`. A client cursor's `seq` is valid only
inside the generation that issued it. The shipped sync client detects a change,
resets to zero, and re-unions the backlog; duplicates make replay safe.

Back up the storage directory as append-only source data. Do not reformat,
normalize line endings, or JSON-pretty-print `.lync` and `.conflicts` files:
exact bytes participate in digest verification and same-id comparison. Verify
copies with `lync verify` before treating them as healthy replacements.

## Protocol and security boundary

The relay accepts five JSON frame types: `sub`, `ev`, `live`, `presence`, and
`err`. `@deepfates/lync/sync-protocol` owns their TypeScript codec. The relay
extracts an id and applies the format's byte-level digest-splice rule, but it
does not validate a full event envelope or authorize event meaning. Consumers
must still parse received lines, apply critical suppression and application
policy, and refuse unsupported domain claims.

The built-in bearer token is one shared secret and is sent in the WebSocket
upgrade. Use TLS when crossing an untrusted network. Per-user identity,
fine-grained room authorization, secret distribution, storage encryption,
retention policy, and disaster-recovery targets remain responsibilities of the
deployment that embeds the relay.
