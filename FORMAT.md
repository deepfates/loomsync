# The lync format

Status: v0 draft. Conventional extension: `.lync`.

This document defines the lync format: a file format for append-only
interaction histories. It is self-contained; no prior lync implementation
context is required.

## What This Is

A `.lync` file keeps everything people, models, tools, and importers write,
try, reject, judge, and decide, including branches not taken, as one
append-only body of data. Any tool can read it, any trainer can learn from it,
and any future session can reconstruct context from it.

The unit is an event: someone, at some time, produced this content, in the
context of these prior events. Events are immutable; the file only grows.
Everything you actually look at, such as a branch tree, transcript, memory
view, training set, or leaderboard of scored drafts, is a view computed from
events and never stored as truth itself. Because events never change, combining
two copies is set union.

## Part I: Protocol

Everything in Part I is normative.

## The Event

One shape. Everything is an instance of it.

```json
{
  "v": 1,
  "id": "0197f3a2-8c1e-7d40-b3a1-9e2d4c5f6a7b",
  "kind": "textile/turn",
  "at": "2026-07-06T04:12:31Z",
  "author": { "actor": "deepfates" },
  "parents": ["0197f3a2-1111-..."],
  "payload": { "text": "The bear stood at the lip of the falls and waited." }
}
```

| Field | Required | Type | Meaning |
|---|---|---|---|
| `v` | yes | int | Envelope version. Writers never invent top-level fields; readers tolerate unknown ones as future-version diagnostics. |
| `id` | yes | string; UUIDv7 is a writer obligation | Identity of the event, not the content. Two identical generations are two events. The embedded timestamp is untrusted input; `at` and `marked` carry time claims. Readers compare ids as opaque decoded strings and validate nothing about their shape. |
| `kind` | yes | string, `namespace/name` | What sort of event this is. Opaque to the protocol. Must contain at least one `/`; the part before the first `/` is the namespace and the rest is the name, both non-empty. The name may itself contain `/`. The namespace tells you whose pact defines it; the protocol never interprets it and there is no registry. |
| `at` | yes | RFC 3339 | When the content came into being, as claimed by the author. A claim, not a proof. |
| `author` | yes | object | Provenance: who made this, under whose responsibility, through what. |
| `parents` | yes | list of ids, may be empty, ordered | The prior events this was made from. What positions mean is defined by the kind's pact; duplicate entries are legal because positions are not sets. |
| `payload` | yes | object | Kind-defined content. It may be `{}`; members may hold any JSON values, subject only to the duplicate-member-name rule. The envelope never interprets it. |
| `marked` | no | RFC 3339 | When this event was written, if different from `at`, when the content came into being. Set once by the event's writer; never per-copy. Defaults to `at`. |
| `critical` | no | bool | Reader-safety flag. Default false. |
| `digest` | recommended | line metadata | Not a body field. Spliced onto the stored line per "Bytes Are Canonical." `sha256:` fingerprint of the event's body bytes. Optional: a line without one is conforming; a line with one is self-checking. |
| `sig` | no | line metadata | Not a body field. Spliced after `digest`, which it requires. Ed25519 over the digest, encoded as standard base64: `A-Z a-z 0-9 + /`, non-empty, `=` only as trailing padding, length a multiple of 4, no whitespace, not base64url. Signature verification, key discovery, and author-to-key binding are pact-level; a base reader preserves and surfaces signatures without verifying them. |

Writers at `v: 1` never emit top-level fields beyond this table; anything else
belongs in payload. Readers that meet an unknown top-level field carry the line
and surface it as nonconforming rather than rejecting it. A reader that does
not implement a line's `v` treats the line as unreadable: skipped and surfaced,
like garbage, because it cannot know the envelope it is looking at. A line with
duplicate JSON member names is garbage because parsers disagree about
duplicates.

The names `digest` and `sig` are reserved top-level body names. Writers never
emit them as body members. Payloads may use those names freely.

## The Author Object

`author` answers several different questions, kept as separate axes because
they are different claims:

```json
"author": {
  "actor": "claude-haiku-4-5",
  "operator": "deepfates",
  "via": "textile@0.9",
  "imported_by": "chatgpt-export-converter@0.1",
  "source": "chatgpt-export/conv_8f2#msg14"
}
```

Types: `actor` is required and a non-empty string. `operator`, `via`,
`imported_by`, and `source` are optional strings. An empty optional string is
treated as absent. Members beyond these five are handled like unknown
top-level fields: writers do not emit them at `v: 1`; readers carry and
surface them.

The rule that matters most: a converter importing old archives is
`imported_by`, never `actor`. It preserves the original actor, or `"unknown"`
when that is the honest value. For imports, `at` is the original creation time
and `marked` is the import time. Environments count as actors too: a REPL that
computes an excerpt or a filesystem that reports a result can honestly be an
actor.

## The Three Rules

1. Events are immutable and the file is append-only. Correction, judgment, and
   retraction are new events pointing at old ones.

2. Merge is union by id. Replicas, copies, and strangers' files combine by set
   union of events. Sameness is judged on body bytes: same id and same body is
   one event seen twice. Differing spliced `digest` or `sig` metadata is a
   disagreement to surface, not a second event. Same `id` with different body
   bytes is never silently resolved; both variants are surfaced loudly and
   excluded from normal views. File order carries no meaning; structure lives
   entirely in `parents`. A reader holding half a file has a complete, valid
   view of every subgraph it holds.

3. Unknown kinds are traversed, not interpreted. A reader that does not
   understand a kind must still carry the event, follow its parents, and
   include it in union. It must not drop it and must not guess at its meaning.
   If an event it does not understand has `critical: true` and its author names
   intersect the target's, the reader must not surface the payloads of that
   event's parents in display or export. Author names of an event are its
   `actor`, `operator`, and `imported_by`, nulls and empties dropped, compared
   as decoded string values. Readers that understand the kind follow its pact
   instead, where "understands" means the reader ships an implementation for
   that exact kind string. A pact may override only the interpretation of its
   own kinds, never the rules of Part I.

Precisely, for an ignorant reader: a critical event's targets are exactly its
parents, each compared independently per target. A critical kind must put only
targets in `parents` and carry any context in payload. Suppression withholds
payload only; envelope fields may be shown so traversal, audit, and "why is
this hidden" explanations still work. Suppression applies to direct parents
only, not ancestors. It is a computed view over held events: a dangling target
is nothing-to-suppress until union delivers it, at which point suppression
applies. Only accepted events trigger suppression. A critical line that is
garbage, damaged, or a same-id conflict variant is excluded from views like any
other and suppresses nothing.

## Bytes Are Canonical

An event's body is its first serialization: the complete JSON object as its
writer first emitted it, without `digest` and `sig`. Those exact bytes are
frozen forever. The digest is `sha256:` over the body bytes. Hash what you
store; store what you hash.

When a writer stores the digest, the splice is byte-exact. The stored line is
the body with its final `}` replaced by:

```text
,"digest":"sha256:<64 lowercase hex>"[,"sig":"<base64>"]}
```

Those literal bytes, in that order, with no whitespace anywhere in the splice.
Detection is anchored at the end of the line, never searched: a line has a
splice if and only if its final bytes match the grammar above. If the line's
end does not match, the whole line is body. A payload merely containing the
marker bytes is untouched, and a near-splice is just body bytes for JSON
parsing to judge. Verification is then a byte slice, not a parse: the body is
everything before the splice plus a closing `}`; hash it and compare.

The reserved-names rule is top-level only and deterministic: a parsed body
object containing top-level `digest` or `sig` members is garbage. Payloads may
use those names freely. A tool may add the splice to an undigested stored line;
the body bytes are untouched, so this is not reserialization.

No JSON canonicalization algorithm, no key ordering, no number normalization.
Any process that reformats a `.lync` file has destroyed it, and the digests
will say so.

A line whose digest fails verification is damaged: carried and surfaced with
its bytes intact, permanently excluded from views and exports, never parsed for
content, never adjudicating anything. No healing linkage is computed; a
damaged line cannot be safely parsed, so no reader can know which event it was.
If an accepted copy of the event exists anywhere in the union, the event is
visible through that copy while the damaged line remains surfaced damage. A
line without a digest is conforming, merely not self-checking.

Classification precedence, so independent readers agree: splice detection and
digest verification run first on raw bytes; a splice-valid but hash-failing
line is damaged and classification stops. Then JSON parsing runs. Then
envelope validation runs. Parse or envelope failure is garbage. Duplicate
member names must be rejected at every object depth.

The digest names the bytes; the signature signs the digest. Content
addressing, tamper evidence, and same-id-conflict detection all follow from
this rule.

## Encoding

A `.lync` file is UTF-8, no BOM, one event per line (JSONL), each line a
single complete JSON object, LF-terminated. Lines never wrap and never contain
raw newlines; JSON string escapes carry them. A CR is a content byte, not a
line ending. In a CRLF file, the CR is trailing content after the JSON object,
so such lines classify as garbage deterministically. A CR inside a JSON string
is string content. Empty lines are garbage. A final line missing its LF is
processed if otherwise valid and surfaced as nonconforming. A line is exactly
one JSON object: any bytes outside it, including leading or trailing
whitespace, are trailing data and therefore garbage.

Timestamps are validated against the ABNF of RFC 3339 section 5.6 exactly. The
ABNF permits lowercase `t` and `z`, fractional seconds, any numeric offset, and
a seconds value of 60. Timestamps are never normalized.

Files may be concatenated, split, and reordered freely. A tool that writes a
merged file emits one stored line per accepted event, bytes verbatim. The
comparator is: digested beats undigested; among digested, signed beats
unsigned; beyond that the tie-break is the tool's, but must be stable. It
re-emits damaged lines verbatim because they may be someone's only copy. It
may omit or retain garbage lines, surfacing either way. Validity is per-line.

MIME type: `application/x-lync+jsonl`.

Spelling versus value: JSON lets one string be spelled many ways. Everywhere
Part I compares strings, including id union and parent resolution, the `kind`
slash rule, author-name intersection, and duplicate-member detection, the
comparison is of decoded string values, never token spelling. Raw bytes matter
to exactly one thing: the digest. Writers should emit these fields unescaped,
but readers compare values regardless.

## Hostile Data

Ids are mintable and parents are claims, so a reader will eventually meet a
file that lies. Reader obligations make implementations fail the same way
instead of diverging silently.

Cycles: honest writers cannot create a cycle accidentally because citing a
parent requires knowing its id. Acyclicity is an emergent property of
unguessable names, not an enforced rule. Readers must terminate anyway by
tracking visited ids during traversal. They surface the cycle as damage, never
loop and never crash.

Duplicate ids: two lines with the same `id` and same bytes are one event seen
twice. The same `id` with different bytes follows rule 2: surface and do not
pick a winner.

Dangling parents: legal, always. Records travel in pieces. A parent you do not
hold is a fact about your copy, not an error in the file. A parent id that
resolves only to a same-id conflict is unavailable due to conflict: traversal
stops there and says so. Events on a detected cycle are carried and merged like
anything else, but their ancestry is not well-founded. Cycle damage is a graph
diagnostic, distinct from damaged lines. Traversal obstacles unify: a view
whose walk meets a dangling parent, conflicted id, or cycle reports its result
as partial and surfaces the obstacle.

Garbage lines: a line that does not parse, or parses but violates the envelope
(missing or mistyped required fields, duplicate member names, reserved
top-level names in the body, bytes outside the object, or a `v` the reader
does not implement) is skipped and surfaced per line. There is no separate
"malformed splice" case: a line whose end does not match the splice grammar
has no splice, and its body's fate is decided by parsing. A spliced line whose
digest fails is damaged and never parsed, even if its body also contains
duplicate members.

Damaged lines: a line whose stored digest fails verification is carried and
surfaced, excluded from views until a verifying copy arrives.

Silence is the only forbidden response. Surfacing means, at minimum, the
classification, the reason, and the source location when available.

The classification taxonomy is normative and closed:

- `accepted`
- `nonconforming`: carried, surfaced, still in views; a diagnostic, not an
  exclusion
- `garbage`
- `damaged`
- `conflict variant`
- graph diagnostics: `cycle`, `dangling`, `unavailable-due-to-conflict`,
  `partial`

View-eligible events are accepted and nonconforming union events minus conflict
variants, with critical suppression applied. Reason wording is the
implementation's own. Conformance is judged on which events are accepted, how
they merge, and which are eligible for views, never on byte-identical
diagnostic text. Depth limits and resource caps are an implementation's right;
capped results are partial and surfaced.

That is the entire protocol: an envelope, three rules, a digest rule, an
encoding, and a hostile-data posture.

## Part II: Pacts

Nothing in Part II is required to read, write, merge, or verify a `.lync` file.
This is the layer where meaning lives: vocabularies that communities of tools
agree on. A pact binds its signatories; the protocol binds everyone.

## Vocabulary Worth Borrowing

Where a community has already converged, borrow; mint only where you are
genuinely first. Current recommendations:

- `lync/artifact`: a thing someone produced from prior things, such as prose,
  code, a prediction, a tool result, an imported message, or a computed excerpt.
  `parents` are what it was made from, in order.
- `lync/annotation`: an authored claim about one or more events. `parents` are
  the targets. Scores, critiques, rewards, receipts, labels, and selections are
  relations-as-events.
- `lync/pointer`: a named reference that moves without mutating. Payload
  `{"name": "...", "target": "<id>"}`; live value is newest per actor and name.
  Older pointers are history.
- `lync/tombstone`: retraction, written `critical: true` so rule 3 binds even
  readers that have never heard of tombstones. `parents[0]` is the target.

Historical namespace spellings are frozen wire vocabulary. Shipped kind strings
such as `lync/annotation`, `lync/artifact`, `lync/turn`, and `lync/loom` are
exact-match data in stored files; the lync brand does not rename shipped kinds.

Annotation labels may include `selection`, `score`, `decision`, `no-train`,
`aborted`, `revision`, `excerpt`, and `ordinal`. Chat roles can borrow ChatML
(`system`, `user`, `assistant`, `tool`). Annotation motivations can borrow W3C
Web Annotation vocabulary.

Selection is revealed before declared. If you extended a branch, the tree
already shows your choice; record nothing. Write a `selection` annotation only
where topology cannot reveal it: a judge picks best-of-N and nothing gets
extended, or an optimizer archives two of five.

Obligations are conventions with a badge. `no-train` and tombstones cannot be
enforced by a format at a distance. The pact makes the request legible and
makes honoring suppression a testable conformance claim a reader can earn or
lose.

## Manifests

Kinds are open, but pact semantics must not live in tribal memory. A pact ships
a manifest: per kind, payload schema, parent-role meanings, and one example.
With the manifest a reader interprets; without it, rule 3 already guarantees
safe traversal.

Manifest changes are additive-only. New fields are optional. Existing fields,
types, and meanings are frozen forever. A breaking change takes a new kind
name. This is how a ten-year corpus stays readable by year-one tools.

## Views

The event graph is a partial order; useful views are classic objects of one:

- Thread: a chain from a leaf to root; a chosen path, transcript, or session.
- Alternatives: an antichain of events sharing a parent; drafts that competed,
  plus revisions of them.
- Context: a downset containing everything an event descends from; what a mind
  loads to stand where that event stood.
- Frontier: an antichain under score dominance, a different order than
  causality; the optimizer's live edge, computed and never stored.

A useful implementation answers all four. Context and alternatives are
computable from the envelope alone. Thread, when parent choice through fan-in
matters, and frontier, when annotations must be interpreted as scores, require
pact knowledge.

## Exports

SFT: root-to-leaf threads of artifacts, filtered through tombstones and
no-train, plus a windowed mode: per-step slices with their immediate context.

Preference: revealed choices from extended branches and declared choices from
selection annotations, each with full context, judge identity, and basis.

The unusual commitment is to record alternatives and choice at generation time
so training exports do not require reconstruction.

## Large Payloads

Text rides inline. Media and oversized members ride beside the file as
content-addressed blobs, referenced from payloads as
`{"blob":"sha256:..."}`. This is a pact convention because the envelope never
looks inside payloads.

## Deliberately Absent

Sync protocols, storage engines, query engines, key infrastructure, a kind
registry, ordering authorities, agent-to-agent requests, and sibling
display-order beyond pact-defined payload fields are absent from Part I.

Ordering for a live multiplayer world is its own pact. If a world needs a
global sequence, it carries `seq` in payload. Who may fork it is governance,
not data.

## Worked Example

Five events: a paragraph, two alternatives, a judge's score, and a declared
choice. Non-normative shorthand: ids are shown as `A` to `E` and digests are
elided for readability only. Conforming writers mint UUIDv7 ids and should
splice digests per "Bytes Are Canonical."

```jsonl
{"v":1,"id":"A","kind":"lync/artifact","at":"2026-07-06T04:10:00Z","author":{"actor":"deepfates"},"parents":[],"payload":{"text":"The bear stood at the lip of the falls."}}
{"v":1,"id":"B","kind":"lync/artifact","at":"2026-07-06T04:10:09Z","author":{"actor":"claude-haiku-4-5","operator":"deepfates","via":"textile@0.9"},"parents":["A"],"payload":{"text":"It did not move for an hour, and the river brought it everything.","ordinal":0}}
{"v":1,"id":"C","kind":"lync/artifact","at":"2026-07-06T04:10:09Z","author":{"actor":"claude-haiku-4-5","operator":"deepfates","via":"textile@0.9"},"parents":["A"],"payload":{"text":"Downstream, the younger bears fought over shallows.","ordinal":1}}
{"v":1,"id":"D","kind":"lync/annotation","at":"2026-07-06T04:10:11Z","author":{"actor":"witness-panel-v3"},"parents":["B"],"payload":{"label":"score","value":0.91}}
{"v":1,"id":"E","kind":"lync/annotation","at":"2026-07-06T04:10:15Z","author":{"actor":"deepfates"},"parents":["B","C"],"payload":{"label":"selection","chosen":["B"],"shown":["B","C"],"basis":"human pick"}}
```

Event `E` exists because nothing was extended yet, so the graph alone cannot
say which future was chosen. Had the next event simply continued from `B`, that
continuation would be the declaration.

From five lines, the alternatives at `A` are `B` and `C`. The SFT export reads
the root and chosen continuation. The preference pair is `B` over `C`, chosen
by `deepfates`, with a judge's score on record. A reader that understands none
of these kinds still merges this file with any other, verifies every digest,
walks every parent, and lies about nothing.

## Ambiguity Notes

Reserved top-level field names such as `digest` and `sig` are wire-format
semantics and are not renamed.
