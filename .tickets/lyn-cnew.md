---
id: lyn-cnew
status: closed
deps: []
links: []
created: 2026-08-01T23:52:19Z
type: bug
priority: 1
assignee: deepfates
tags: [behold, presentation, reader]
---
# Bring current Behold resident-v2 presentation pact upstream

Textile's retained qualified-habitat histories exposed that Lync 0.4.3's canonical org.behold.inhabitant.v2 presenter lags current public resident events and settlements. Textile carries a bounded local overlay for lifecycle events, wait settlement, truthful chat/whisper dispatch, and focused-use failure so the live reader is usable now; Lync should own equivalent pact behavior before the next package handoff.

## Acceptance Criteria

Canonical Lync presentation tests cover the current Behold v2 public shapes exercised by retained qualified-habitat episodes, distinguish input dispatch from recipient/world confirmation, present known action failures without coordinates or private targets, retain fail-closed diagnostics for unknown shapes, and a freshly packed candidate lets Textile remove the consumer-local overlay without changing exact source bytes or public prose.


## Notes

**2026-08-02T00:25:06Z**

Exact qualified-habitat episode 000004 exposed recipient-side private speech mispresentation: Behold now records chat_received.channel=private, while the canonical v2 presenter labeled every chat_received event Public chat. Updated the v2 presenter to distinguish Private whisper, preserve v1/no-channel public rendering, fail closed on unknown explicit channels, and added a focused canonical-v2 test.

**2026-08-02T08:20:00Z**

The Lync-owned candidate now covers the remaining exact qualified-habitat
episode 000013 public shapes: bounded experience-pressure summaries, witnessed
entity death, resident private-life reads and receipts, body-life and
observation-gap invalidation, focused-use dispatch without claiming a world
effect, container inspection, stop, the existing Textile lifecycle/wait/chat
overlay vocabulary, and generic factual action failures. Reprojecting the
authenticated 51,374,811-byte episode prefixes presented all 627 resident
turns plus two roots with zero `unsupported_*` diagnostics; 9,186 remaining
diagnostics are named source-only or withheld fields.

The same pact accepts the exact coordinate-free `behold.body-transition.v1`
receipt only when its protocol, observation semantics, egocentric frame,
units, finite measurements, sample count, and compatibility `bodyMoved`
threshold agree. It renders measured motion while saying cause is unknown,
withholds extra coordinate-shaped fields, and fails closed on malformed or
inconsistent receipts. The canonical v1 golden projection remains byte-stable.
Focused presentation tests pass 28/28; the complete suite passes 206/206,
typecheck, README examples, path guard, and physical packed-artifact checks
pass. Keep this ticket in progress until Textile removes its local overlay and
an adversarial consumer parity check confirms the freshly packed presenter;
no package was published.

**2026-08-02T08:25:42Z**

Downstream parity is complete at clean Textile commit
`2d87e285eaf4c70cde615e26aead8855f0d3c1ed`. Textile consumes the exact packed
candidate from Lync `6e0734d` (SHA-256
`90a6a551f4bbc709192d06cec71d4df26ce4e6554add90c7407900bdca250f91`)
through `@deepfates/lync/presentation` and removed its tracked local Behold
presenter overlay. Its existing exact-prose and fail-closed presentation tests
remain green. Adversarial projection of Behold episode 000014 presented all 692
source events (690 readable turns and two roots) with zero unsupported,
unclaimed, or nonconforming events and without retaining source bytes or private
payload objects. Textile's full gate passed 225 tests with one opt-in scale test
skipped, plus lint and both production builds. No package was published.
