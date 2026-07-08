# Ordering Pact Stub

Status: stub.

Some worlds need one canonical sequence in addition to parent links. That
sequence is pact data, not format data.

The expected shape is an event whose payload carries the world's canonical
`seq`, plus whatever authority, epoch, or stream identifier that world needs.
Readers that understand the pact may sort or reject by that sequence. Readers
that do not understand it still carry the event, traverse its parents, and merge
it by union.

Open points:

- Define the kind string.
- Define whether `seq` is a number, decimal string, or tuple.
- Define authority and fork rules for worlds that can split.
- Add one valid example and one invalid example.
