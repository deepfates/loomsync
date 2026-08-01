# Presentation Pact

Status: v0. This pact defines the reference implementation's readable
projection boundary. It does not add fields to the Lync event envelope and it
does not make presentation output authoritative.

Lync deliberately accepts open-ended kinds and payloads. Carrying an unknown
event safely is a protocol concern; deciding which of its fields a person or
model may read is a domain concern. A presentation is the small, versioned
bridge between those two facts.

## The Boundary

`@deepfates/lync/presentation` accepts one immutable event plus an optional
causally inherited loom profile. It returns one of three decisions:

- `presented`: content or structure, its contract name, exact source envelope,
  readable sections, JSON source paths, and diagnostics;
- `unsupported`: an exact kind or profile claimed the event, but the payload
  did not satisfy that contract;
- `unclaimed`: no installed contract owns the event.

The source event is never changed. Presentation does not mint an event, add a
parent, normalize an author, choose a branch, or write its output back to a
Lync log. A consumer that exports source-preserving data keeps the original
event bytes; a presentation is only a regenerable view over them.

## Exact Claims, Then Stop

Dispatch order is:

1. an exact inherited profile;
2. an exact kind string;
3. the deliberately small generic text/message pact;
4. `unclaimed`.

Once an exact profile or kind claims an event, malformed data is
`unsupported`. It never falls through to a generic reader that happens to find
a plausible-looking string elsewhere. This prevents an older or unknown
profile from being accepted by shape and prevents private nested fields from
becoming prose by accident.

The generic pact is shallow by design. It reads only:

- `payload.text`, `payload.full_text`, `payload.fullText`, or a string
  `payload.message`;
- string `payload.message.content`;
- explicit `text` fields in `payload.message.content[]`.

It does not recurse. Tool objects, raw provider responses, reasoning, requests,
controller state, and unknown nested payloads remain unclaimed.

## Identity and Causality

Every presented value carries the exact source `id`, ordered `parents`,
`author.actor`, optional `author.via`, and `kind`. Sections name every JSON path
used to produce their text. Presentation never remints an event or turns
identifier lexicography into chronology.

`resolveLyncPresentationProfiles(events)` inherits a loom root's exact
`payload.meta.profile` through causal parents. A child with one inherited
profile receives it even when events arrive in another physical order. Fan-in
from distinct profiles resolves to no profile; the resolver does not choose a
parent, reorder the parent list, or assert that two causal parents were
simultaneous.

## Privacy and Policy Stay Upstream

Presentation is an allowlisted view, not an authorization engine. Before
calling it, a consumer must apply the Lync parser's view eligibility and
critical suppression rules plus any application policy such as `no-train`.
Withheld bodies must remain withheld; a presenter never receives them as a way
to bypass policy.

The output contains only allowlisted readable fields and envelope identity. It
does not contain the original payload object. This protects Markdown,
clustering, browser DOM, and model inputs from incidental fields, but it does
not erase the source log. A source-preserving archive may still contain private
payloads and must follow its own storage, sync, and export policy.

## Content Is Not Structure

`kind: "content"` means a readable artifact suitable for a reading surface or
for a downstream process that has independently established eligibility.
`kind: "structure"` names a container or relation so it can be shown honestly
without pretending it is prose. Presentation does not declare content
trainable, assign ChatML roles, infer a mind or perspective, or turn structure
into a training example.

Consumers choose their projection:

- Textile renders content and structure while keeping typed causal/pointer
  relations and original source records for contextual export.
- Splice's readable Markdown may render both; its training projector accepts
  only content after suppression and `no-train` checks.
- Curare embeds only content and retains the source event id as the annotation
  target.

## Shipped Contracts

The reference presenter currently carries exact, tested readers for:

- Splice source kinds: `twitter/tweet`, `twitter/like`, `bluesky/post`,
  `glowfic/post`, `glowfic/thread`, `twitter/tweet-embed`, `ocr/page`,
  `ocr/document`, and `ocr/set`;
- the structural `lync/pointer` pact;
- the Behold root profile `org.behold.inhabitant.v1`, limited to the ratified
  `behold.entity-loom.v1`, `behold.entity-turn-link.v1`,
  `behold.entity-turn.v1`, and `minecraft-human-semantic-v1` allowlists;
- the additive Behold root profile `org.behold.inhabitant.v2`, with the same
  envelope/body boundary plus typed private-whisper action results, coarse
  `sound_heard`, `behold.sound-sequence.v1` summaries, and `time_passed` pulses;
- the shallow generic text/message fields above.

The Behold presenter preserves script/model/operator provenance and distinct
success, rejection, failure, cancellation, and fallback meanings. It never
exposes raw provider exchanges or private reasoning and never claims an older
or unknown resident profile by nested shape.

The v2 sound projection names only the native sound and Behold's coarse
distance/direction. Packet volume, pitch, compaction timestamps, sequence
bookkeeping, and any unknown fields stay in the source event. Whisper text is
intentionally readable as resident conduct in this history; tool identities
and unknown input/result fields remain source-only. Every unknown field under
these v2 additions produces an explicit diagnostic rather than inferred prose.
The v1 dispatcher and projection remain unchanged.

V2 also recognizes Behold's empty-input `attack_focused_entity` and
`dig_focused_block` actions. Attack results may show only the body dispatch
status/confirmation or a typed error; they do not claim damage or expose the
private target. Dig results may show verb, material before/after, `verified`,
`observed`, and the confirmation source from `changes` or `attemptedChanges`.
World coordinates, state ids, adjacent blocks, navigation, command internals,
and detailed confirmation records remain source-only. The corresponding
`action_failed`, `controller_suspended`, `cancellation_requested`, and
`visible_block_changed` events expose only the action name, public lifecycle
reason/requester, typed error, or visible material transition; intent inputs,
timestamps, authorization records, and controller internals stay source-only.

These are presenter implementations of external domain pacts, not a kind
registry in the format. Unknown kinds remain valid Lync data. Adding a new
presenter is additive; changing the meaning or allowlist of an existing
contract requires a new contract/profile version so old projections remain
regenerable.

## Conformance Checklist

A presentation consumer conforms when:

1. It dispatches by exact profile/kind and fails a claimed malformed event
   closed instead of falling through.
2. It never recursively searches unknown payloads for prose.
3. Presented sections name their exact source paths and retain source envelope
   identity and ordered parents.
4. It applies suppression and application policy before presentation and never
   leaks withheld bodies through readable output, model input, sync, or export.
5. It treats content/structure as a projection distinction, not a training or
   authorship judgment.
6. It retains original events unchanged wherever source-preserving roundtrip or
   contextual export is promised.
