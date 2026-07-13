# Open Questions

These are draft-suite assumptions where the spec was readable but still left runner
policy or vector-schema choices to us.

1. Should `nonconforming` events appear in an aggregate called "accepted events"?
   The suite avoids that label and uses `union_event_ids` plus `view_eligible_ids`,
   because Part I gives `nonconforming` its own line class while also saying it is
   carried and remains in views.

2. For duplicate sightings of the same id and same body bytes, should every physical
   line be classified `accepted`, or should later sightings have a distinct line
   diagnostic class? The suite keeps the closed taxonomy by marking the later lines
   `accepted` with `duplicate_sighting: true`.

3. For same id and different body bytes, should the first physical line initially be
   `accepted` and later retroactively become `conflict-variant`, or should all variants
   be reported as `conflict-variant` in final results? The suite expects all physical
   variants for that id to be `conflict-variant`.

4. Metadata disagreement for same body bytes is required to be surfaced, but its shape
   is not specified. The suite represents it as `metadata_disagreement: true` on the
   duplicate sighting lines.

5. `sig` grammar is specified, but signature verification is pact-level. The suite only
   checks syntactic preservation with a valid base64 value and does not include invalid
   signature grammar vectors yet. If signature grammar failure is envelope garbage,
   additional vectors should be added.

6. RFC 3339 validation is pinned to section 5.6 ABNF, which permits seconds value `60`.
   The suite treats `2026-12-31T23:59:60Z` as accepted without checking whether the date
   is an actual leap second.

7. The suite treats unknown top-level fields and unknown author fields as
   `nonconforming`, carried, and view-eligible. That follows the prose, but an
   implementation-facing vector schema might want a clearer aggregate name for these
   than either "accepted" or "valid".

8. Critical suppression is represented as payload withholding for target ids while the
   ids remain view-eligible. If a runner exposes view payload state inline rather than
   through a separate `suppression` section, the vector schema should be normalized.

9. The suite includes `generate.py` in the draft directory for reproducibility. If the
   eventual golden vector package should contain only static fixtures, delete the
   generator after ratification and preserve its checksum elsewhere.
