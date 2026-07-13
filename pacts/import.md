# Import Pact

Status: v0. This pact codifies a shipped convention, not a proposal. The
reference implementation is splice's lync producer (`src/outputs/lync.ts` and
its tests in `tests/lync/`), which imports Twitter archives and glowfic-dl
JSON exports. Everything below is law that code already obeys.

An import is a transcription of pre-existing events, not a generation. The
content already happened, somewhere else, at some earlier time, authored by
someone who was not the importer. The importer's whole job is to carry that
fact into the envelope without adding, losing, or claiming anything. Every
rule in this pact is that sentence applied to one field.

## Identity: Deterministic Ids

Generators mint UUIDv7 because two identical generations are two events.
Imports are the opposite case, and FORMAT.md's `id` row blesses it: an
importer transcribing pre-existing events derives a deterministic UUIDv8 from
source identity. Same source record in, same event id out, every time, on
every machine.

Two consequences follow, and both are the point:

- **Re-import is a union no-op.** Run the importer twice, or on two machines,
  and merge the outputs: same id, same body bytes, one event seen twice.
  Rule 2 unions them silently. No dedup pass, no "already imported" state.
- **An upstream edit surfaces as a same-id conflict.** If the source record
  changes and you re-import, the id is the same but the body bytes differ.
  Rule 2 refuses to pick a winner and surfaces both loudly. This is a
  FEATURE: the format itself flags that the upstream mutated something it
  presented as history. Do not "fix" this by salting ids with import time —
  that trades tamper evidence for silent duplication.

For those consequences to hold, the derivation must be a pure function of
source identity: no clocks, no randomness, no importer hostname, stable
across importer versions. The reference recipe:

1. Take the identity parts, most general first, e.g.
   `("glowfic", "post", "<thread_id>", "<post_id>")` or
   `("twitter", "item", "<tweet id_str>")`. Include the source namespace and
   record type so ids cannot collide across sources or across record types
   within one source.
2. SHA-256 over the UTF-8 bytes of each part, each part followed by a single
   NUL byte (`0x00`) as terminator — including the last. The NUL terminator
   is what keeps `("a","bc")` and `("ab","c")` distinct.
3. Take the first 16 bytes of the digest. Set byte 6 to
   `(b[6] & 0x0f) | 0x80` (UUID version 8, RFC 9562 "custom") and byte 8 to
   `(b[8] & 0x3f) | 0x80` (RFC 4122 variant).
4. Format as a lowercase hex UUID: `8-4-4-4-12`.

Readers validate nothing about id shape (FORMAT.md), so the recipe binds
writers only. Any recipe with the same properties conforms; use the reference
recipe unless you have a reason, because two importers that share a recipe
and identity parts converge on the same ids for the same source, and their
outputs union.

Parents are derived with the same recipe. That means a parent reference
resolves correctly even when the parent was imported by a different run, or
has not been imported yet — a dangling parent is legal, always, and fills in
when union delivers it.

## The Author Envelope

Every axis answers a different question. The importer keeps them apart:

| Axis | Value for imports | Question it answers |
|---|---|---|
| `actor` | The ORIGINAL source identity, the most specific the source record offers (reference order: character display name, character handle, author, screen name, username, handle, account id), fallback `"unknown"` | Who produced the content? |
| `operator` | The human on whose behalf the import runs (reference default: `"deepfates"`) | Under whose responsibility? |
| `via` | The fetching tool that produced the source material, `<tool>@<version-or-unknown>`, e.g. `glowfic-dl@unknown`, `twitter-archive@unknown` | What mediated it out of the source system? |
| `imported_by` | The importer itself, `<importer>@<version>`, e.g. `splice/glowfic-json@0.1` | What transcribed it into lync? |
| `source` | Locator: `<path-or-ref>:<position>`, e.g. `https://glowfic.com/posts/5506:reply-1739834` | Where does the original live? |

The rule with teeth, from FORMAT.md and the authorship pact: **`imported_by`
is never used as `actor`.** The importer did not write the content; it may
not claim it. When the source record carries no identity at all, the honest
actor is `"unknown"` — still not the importer. The reference tests assert
`author.actor !== author.imported_by` on every event.

## Kinds Are Source-Namespaced

The namespace is the source system: `glowfic/thread`, `glowfic/post`,
`twitter/tweet`. Do not launder imported material into generic kinds; the
kind string is where a reader learns which pact (this one, plus the source's
own shape) explains the payload. A container record (a thread, a
conversation) gets its own event, and its items parent to it.

Parents transcribe the source's structure: explicit reply linkage when the
source has it; when the source is a strict sequence with no finer reply
metadata (glowfic posts are), each item parents to the previous item and the
first parents to the container event. Sequence-as-parents is honest there
because the sequence IS the source's structure.

## Payload and Time

The payload is the complete original source object. Not a summary, not the
fields you currently need — all of it, verbatim. The envelope never
interprets payloads, storage is cheap, and the field you dropped is the field
the next decade wants. Only when the source provides no raw object at all
does the importer's own normalized record stand in as payload; either way,
nothing is discarded.

`at` is the source-claimed creation time, normalized to RFC 3339:

- Already RFC 3339: use the source string verbatim. Bytes are canonical;
  never reformat a timestamp that already conforms.
- Parseable but non-conforming (e.g. `"Jan 04, 2022 7:55 PM"`): convert, and
  record the repair — original value, value used, reason — in stats.
- Missing or unparseable: substitute a deterministic fallback (the epoch, or
  the opt-in import time below) and record that too. Never substitute an
  unrecorded "now": it breaks byte determinism invisibly.

`marked` (import time) is OPT-IN, and off by default. This is a determinism
rule, not a style preference: a default of "now" would make two imports of
the same source differ in body bytes under one id, which union then surfaces
as a same-id conflict — a false alarm that buries the real one. Identical
imports must be byte-identical. Callers who want import time on record pass
it explicitly and accept that their output no longer byte-matches other runs.

A conforming import of one glowfic post, wrapped here for reading only
(stored form is one line). The id is the reference recipe applied to
`("glowfic", "post", "5506", "reply-1739834")` — reproduce it to check your
implementation:

```json
{
  "v": 1,
  "id": "bebac0c3-c485-8748-bdca-bc12dedab993",
  "kind": "glowfic/post",
  "at": "2018-06-04T21:39:00.000Z",
  "author": {
    "actor": "Carissa Sevar",
    "operator": "deepfates",
    "via": "glowfic-dl@unknown",
    "imported_by": "splice/glowfic-json@0.1",
    "source": "https://glowfic.com/posts/5506:reply-1739834"
  },
  "parents": ["<deterministic id of the previous post>"],
  "payload": { "post_id": "reply-1739834", "author": "lintamande", "...": "the complete original post object" }
}
```

## Zero Silent Drops

Every source record either becomes an event or lands in an explicit skip
entry. There is no third path. The importer returns stats:

- `sourceRecords`: how many records the source presented.
- `emitted`: how many events were produced.
- `skipped`: one entry per record that could not become an event, with its
  index, a reason, and the offending value for audit. A record with no
  stable source id cannot mint a deterministic event id — that is the
  canonical skip reason, and it is reported, not swallowed.
- `timestampFallbacks`: one entry per repaired or substituted timestamp.

The reconciliation invariant is the whole point:
`emitted + skipped.length === sourceRecords`. The reference implementation
throws rather than return stats that do not reconcile.

## Verify Before You Believe

Writing the file is not the end of the import. The importer re-parses its own
output with a conforming reader and requires EVERY line to classify
`accepted` — zero garbage, zero damaged, zero nonconforming, zero conflict
variants — and the accepted count to equal the emitted count. A failed verify
is a loud error, not a warning. Testimony ("I wrote 31 events") is not
evidence; the verifier's counts are.

## Conformance Checklist

An importer conforms to this pact when:

1. Ids are a pure deterministic function of source identity (UUIDv8), and
   re-running the importer on unchanged source yields byte-identical output.
2. `actor` is the original source identity or `"unknown"`; `imported_by`
   names the importer and is never the actor; `operator`, `via`, and `source`
   are set as above.
3. Kinds are namespaced by source system; payloads carry the complete
   original source object; parents transcribe source structure.
4. `at` is source-claimed time in RFC 3339, verbatim when already
   conforming; every repair and fallback is recorded; `marked` is opt-in.
5. Stats reconcile exactly and every drop is an explicit entry.
6. The written file verifies clean: all lines accepted.
