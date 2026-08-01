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
- Physical package smoke install passed for `/Users/deepfates/Hacking/data/artifacts/lync/deepfates-lync-0.4.0.tgz`, SHA-256 `e41388a12d6c97e1a4ad47e1b47a983db277e7c20e2deab153aa56dddce4e069`.
- No package publication, tag, push, or release was performed.
