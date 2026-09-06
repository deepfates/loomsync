---
id: lyn-8gww
status: closed
deps: []
links: []
created: 2026-08-01T05:55:36Z
type: task
priority: 0
assignee: deepfates
tags: [behold, presenter, textile, conformance]
---
# Add an additive Behold resident presentation profile

Implement the Lync side of Behold's next additive resident presentation pact. Preserve org.behold.inhabitant.v1 exactly; add a separately dispatched version that extends the ratified human-semantic vocabulary required by current ordinary Behold histories.

## Acceptance Criteria

The new exact profile preserves v1 privacy/provenance behavior and renders typed whisper input/result plus sound_heard, sound_sequence_heard, and time_passed observation events. Unknown fields remain source-only with explicit diagnostics. Fixture and presenter conformance tests prove v1 output unchanged and v2 coverage. Package checks pass and a local consumable artifact/version is available to Behold; no publication.

## Completion Evidence

- Added exact `org.behold.inhabitant.v2` / `org.behold.presentation.inhabitant-turn.v2` dispatch without changing v1 dispatch. The complete canonical v1 projection remains SHA-256 `46febbe7a89951e5ea57593366cb39134d64430bb09aaa8a1ff510a8e052f6c0`.
- The v2 fixture covers private whisper input/result, coarse single and compacted sound perception, elapsed-time pulses, and explicit source-only diagnostics for unknown or intentionally withheld fields.
- `pnpm verify` passed: 22 files, 165 tests, typecheck, path guard, and README examples.
- Physical package smoke install initially appeared to pass for the workshop artifact `deepfates-lync-0.4.0.tgz`, SHA-256 `e41388a12d6c97e1a4ad47e1b47a983db277e7c20e2deab153aa56dddce4e069`; the reopening below supersedes that handoff.
- No package publication, tag, push, or release was performed.

## Reopened: artifact identity falsification

Behold's exact install of the first `0.4.0` handoff resolved stale package
contents despite the handed-off tar bytes containing v2. Reusing the existing
package version and filename made the dependency handoff ambiguous and the
smoke test did not directly exercise the extracted archive. The replacement
must use a new immutable package identity and test the packed bytes themselves.

## Replacement Artifact Evidence

- Package identity advanced to `0.4.1`; `prepack` now rebuilds `dist`.
- `check:package` packs to a fresh temporary directory, extracts that exact
  archive, imports its physical `package/dist/presentation.js`, and executes
  the exact v2 root profile and contract. It is part of `pnpm verify`.
- `pnpm verify` passed again: 22 files, 165 tests, typecheck, path guard,
  examples, and the extracted-package behavior check.
- Replacement workshop artifact `deepfates-lync-0.4.1.tgz` has SHA-256
  `0230b18b564f88af0dbefc5d21e7b75757ab33d461e155079ab0b36e93fae655`.
  A second direct extraction of that durable artifact confirmed the v2 export
  and `org.behold.presentation.inhabitant-turn.v2` execution.
- The superseded `0.4.0` artifact remains untouched as negative evidence. No
  publication, tag, push, or release was performed.

## Reopened: ordinary material/lifecycle vocabulary

Behold's first exact v2 union proved that successful and interrupted material
conduct still fell through the v2 presenter's conservative allowlist. Extend
v2 only for the demonstrated focused attack/dig action shapes, their safe
change evidence, and `action_failed`, `controller_suspended`,
`cancellation_requested`, and `visible_block_changed` observations. V1 and the
existing v2 sound/time/whisper projection remain frozen.

## Material/lifecycle completion evidence

- Focused tests use the demonstrated Behold shapes for attack failure/success,
  verified `mud_bricks` to `air` digging, interrupted attempted digging, and
  all four requested observation events. They assert that targets, coordinates,
  state ids, command errors, controller inputs, and timestamps do not render.
- The canonical v1 projection SHA remains
  `46febbe7a89951e5ea57593366cb39134d64430bb09aaa8a1ff510a8e052f6c0`;
  the prior v2 sound/time/whisper tests also remain green.
- Directly projecting Behold episode `000002` exercised three requested actions
  and seven requested observation events with zero unsupported input, outcome,
  or requested-event diagnostics.
- `pnpm verify` passed: 22 files, 168 tests, typecheck, path guard, examples,
  and the physical package behavior check.
- Immutable workshop artifact `deepfates-lync-0.4.2.tgz`, SHA-256
  `c83b01766b73656a334d49b28e54056472e2b171a981560ded642524fed3aba8`,
  was separately extracted and exercised for verified material presentation and
  coordinate withholding. No publication, tag, push, or release was performed.
