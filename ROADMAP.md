# lync Roadmap

This is the small, near-term roadmap. The format is intentionally tiny; new
meaning should land in pacts, not in the envelope.

## Now

- First public release of the one package: `lync-core` (library, indexes,
  client, relay, and the `lync` command).
- Keep `FORMAT.md` and the test vectors aligned as the reference other
  languages can port.

## Next

- Flesh out pacts for ordering, authorship, selections, scoring, retraction,
  import/transcription (deterministic ids), and training-export obligations.
- Digest splicing in the shipped writers (FORMAT recommends it; readers already
  verify spliced digests).
- Conformance fixtures and test-suite ports for non-TypeScript
  implementations.

## Later

- Build a focused viewer for branch trees, transcripts, memory/frontier views,
  conflicts, damaged lines, and suppression explanations.
- Deployment notes for long-running relays (systemd, containers, auth
  patterns beyond bearer tokens).
