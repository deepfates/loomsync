# Lync architecture

This document is for maintainers and integrators deciding where a behavior or
piece of state belongs. It describes the current responsibility boundaries;
[FORMAT.md](../FORMAT.md) remains the normative protocol.

## Responsibility layers

Lync has four layers with different authorities:

1. **Format.** The event envelope, canonical bytes, line classification,
   same-id union, graph diagnostics, and ignorant-reader suppression rules.
   These are portable and transport-independent.
2. **Pacts and profiles.** Exact kind or profile contracts give domain meaning
   to otherwise opaque payloads. An implementation that does not know a pact
   still carries and traverses its events.
3. **Reference implementation.** Parsers, stores, views, Looms, indexes,
   presenters, and clients implement useful operations over the format.
4. **Transport and applications.** The relay and sync clients move canonical
   lines. Applications decide authorization, branch choice, rendering,
   training eligibility, and which domain pacts to install.

New domains extend pacts and presentation profiles; they do not require a new
envelope field or a forced cross-domain ontology. That is the format's current
extension boundary, not a promise that this repository will implement every
domain.

## State ownership

| State | Authority | Derived or ephemeral state |
| --- | --- | --- |
| Event history | Exact stored `.lync` line bytes and retained sidecars | Parsed objects, graph indexes, views, and presentations |
| Event identity | The event `id` plus body-byte equality rules in `FORMAT.md` | A chosen richer stored sighting when digest/signature metadata differs |
| Causality | Ordered `parents` in each event | Roots, leaves, depths, threads, downsets, and missing-parent diagnostics |
| Domain meaning | The exact kind/profile pact | Rendered prose, roles, rankings, and export rows |
| Loom contents | Lync events in the backing event store | Loom folds, thread selections, and URL references |
| File-Loom catalog | Canonical files | SQLite locators, topology, and digests; the catalog is disposable |
| Relay history | Per-root append-only files and conflict sidecars | In-memory room maps, replay sequence, and subscriber counts |
| Presence | Each connected client's participant roster | Relay fan-out only; the relay never stores presence frames |
| Export | Source event set plus exporter version and choices | Transcript, SFT, preference, or other consumer output |

A presentation or export is never written back as event truth. A mutation,
judgment, selection, correction, or retraction becomes a new event instead.

## Read paths

Small and ordinary event sets use `parseLyncFiles` or an `EventStore`, which
retain the union needed by synchronous views. Re-readable large sources use
`indexLyncSources`: it retains locators, envelope topology, classifications,
and digests while re-reading exact lines and one payload at a time.

Long-running Node processes that need one explicitly selected Loom can use the
SQLite-backed file cursor. Payloads remain in canonical JSONL and are
authenticated when read. The cursor does not choose a branch tip. Its catalog
can be deleted and rebuilt, but current source changes trigger a complete
bounded-memory rebuild rather than suffix reconciliation. The open
[`lyn-hh9v`](../.tickets/lyn-hh9v.md) ticket records the remaining scale,
latency, crash-matrix, and missing-final-LF work; passing earlier retained-life
and generated-history exercises does not close those wider criteria.

## Write and durability boundaries

`BaseEventStore` serializes durable flushes. A failed flush leaves explicit
pending-persistence state; a later union or append must heal that state before
it can report clean durability. The Node file store treats canonical journals
as authority and old `events.json` snapshots as untrusted replicas to migrate,
not as a source allowed to shadow newer canonical lines.

The relay accepts and broadcasts canonical line strings, but a disk failure can
temporarily leave an accepted room line in memory. `status()` exposes that lag
as `pendingUnpersisted`. The next duplicate push, a later append, or `close()`
retries pending lines in order. `close()` rejects if accepted lines still
cannot complete their file append. The relay does not `fsync` those files or
their directory: a zero pending count supports ordinary process-restart
recovery, not a host-crash or power-loss durability guarantee. The Node file
store has the stronger synced-write boundary described in the library guide.

File order is never causal order. Relay `seq` is only a replay cursor within a
single recovered room generation. Clients reset a cursor and re-union from
zero when the generation changes.

## Failure posture

- Unknown kinds are carried, not guessed at.
- Damaged, garbage, nonconforming, conflicting, dangling, cyclic, and partial
  input is surfaced explicitly according to the format taxonomy.
- Presentation claims exact kinds or profiles and fails a malformed claimed
  event closed; it does not recursively search unknown payloads for prose.
- Application suppression and authorization happen before presentation.
- Sync convergence does not imply durable persistence; store and relay status
  report durability separately.
- A fixture or local trial proves its bounded behavior only. The retained
  trials and project tickets state which larger conditions were actually
  exercised.

## Deliberate boundaries

The format does not define storage engines, sync protocols, key infrastructure,
a kind registry, query engines, global ordering, authorization, or deployment
topology. The package ships some of those tools as conveniences, but a format
implementation is complete without them. Applications remain responsible for
their policy, useful user experience, and the meaning of their domain events.
