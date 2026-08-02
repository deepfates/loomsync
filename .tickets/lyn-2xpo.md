---
id: lyn-2xpo
status: closed
deps: []
links: []
created: 2026-08-02T06:49:52Z
type: feature
priority: 0
assignee: deepfates
tags: [loom, checkpoint, behold, durability]
---
# Bind selected Loom tips to exact canonical source prefixes

Expose a Lync-owned checkpoint API that captures one explicit Loom tip against exact bounded prefixes of every canonical source (.lync, .conflicts, pending.events), then later verifies accepted union status, ancestry, depth, body digest, chain digest, and locator from those same authenticated prefixes even after ordinary appends.

## Design

Use the existing indexed-union parser/adjudication as the bounded byte authority. Lync alone owns canonical source enumeration and Loom ancestry/chain semantics. The checkpoint stores only ordered relative source names, byte lengths, SHA-256 digests, Loom id, and selected-tip identity; it copies no source bytes and changes no format.

## Acceptance Criteria

A selected tip in an ordinary source or sidecar verifies from exact captured prefixes; later canonical appends do not change the checkpoint; mutation/truncation/reordering within a prefix fails closed; conflicted, foreign-ancestry, and malformed turns cannot be selected; Behold can consume the API without duplicating Lync source or Loom semantics; tests, typecheck, package checks pass; no publication.

## Resolution

Added the Node-only `@deepfates/lync/file-loom-checkpoint` boundary. Capture
freezes the ordered canonical source set as byte lengths and SHA-256 digests,
then derives an explicit selected turn through the existing indexed-union
adjudication. Verification authenticates precisely those prefixes and
recomputes Loom ancestry, depth, body and chain digests, and the exact locator;
later appends remain valid. Sidecar-selected turns and prefix mutation are
covered directly. The complete 201-test suite, typecheck, README examples, and
packed-artifact check pass. No package was published.
