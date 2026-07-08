# lync Roadmap

This is the small, near-term roadmap. The format is intentionally tiny; new
meaning should land in pacts, not in the envelope.

## Now

- Harden the shipped `lync` CLI for `verify`, `merge`, `view`, `init`, and
  `append` workflows over `.lync` files.
- Finish the native sync replacement (`dee-9l2l`) so Automerge becomes only the
  legacy transport path.
- Keep `FORMAT.md` and the test vectors aligned as the reference other
  languages can port.

## Next

- Flesh out pacts for ordering, authorship, selections, scoring, retraction,
  and training-export obligations.
- Rename legacy internal paths once compatibility allows it.
- Publish packages after Textile consumes lync as a dependency instead of a
  vendored copy.

## Later

- Build a focused viewer for branch trees, transcripts, memory/frontier views,
  conflicts, damaged lines, and suppression explanations.
- Add deployment notes for sync services once native sync is the default.
- Add conformance fixtures for non-TypeScript implementations.
