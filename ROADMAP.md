# Lync near-term context

The format is intentionally tiny; new meaning should land in pacts, not in the
envelope. This file preserves useful near-term context, not release authority
or automatic priority. Actionable work belongs in `.tickets`; uncited items
below are candidates until the owner ratifies them.

## Settled present

- The public package is `@deepfates/lync` 0.3.0. Committed source is 0.4.3 and
  remains unpublished; `RELEASE.md` owns that candidate boundary. Uncommitted
  presentation work is not a release fact until explicitly included.
- Keep `FORMAT.md` and the test vectors aligned as the reference other
  languages can port.

## Candidates

- Flesh out pacts for ordering, authorship, selections, scoring, retraction,
  import/transcription (deterministic ids), and training-export obligations.
- Digest splicing in the shipped writers (FORMAT recommends it; readers already
  verify spliced digests).
- Conformance fixtures and test-suite ports for non-TypeScript
  implementations.
- Build a focused viewer for branch trees, transcripts, memory/frontier views,
  conflicts, damaged lines, and suppression explanations.
- Deployment notes for long-running relays (systemd, containers, auth
  patterns beyond bearer tokens).
