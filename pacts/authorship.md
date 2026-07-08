# Authorship Pact Stub

Status: stub.

The envelope already separates provenance axes:

- `actor` is the content producer.
- `via` is the app, runtime, or tool that mediated production.
- `operator` is the responsible human when different from the actor.
- `imported_by` is only for converters.
- `source` is the original location for imported material.

Guidance with teeth:

- A converter importing old archives is never the `actor`; it sets
  `imported_by` and preserves the original actor, or uses `unknown` when that is
  the honest value.
- Apps should set `via` instead of overwriting `actor`.
- Model names, REPLs, filesystem probes, and other producing environments can be
  actors when they produced the content.
- Authorship queries and training exports should key on `actor` first, then use
  `operator`, `via`, `imported_by`, and `source` as separate filters rather than
  collapsing them into one display string.

Open points:

- Define recommended naming schemes for models, apps, and importers.
- Define signature/key binding guidance without making it required by the base
  format.
- Add examples for human-authored, model-authored, tool-result, and imported
  events.
