# lync-cli

The `lync` command: work with `.lync` files — append-only JSONL interaction
history where each line is one immutable event and merge is set union by
event id.

```bash
npm install -g lync-cli
```

## Seven verbs

```bash
lync init story.lync
printf '%s\n' '{"kind":"notes/text","author":{"actor":"you"},"payload":{"text":"Once..."}}' | lync append story.lync
lync verify story.lync
lync view story.lync --as transcript
lync merge story.lync other.lync -o merged.lync
```

`append` fills the envelope for you: a UUIDv7 id, the current timestamp, `v`,
and `parents` default in; anything you supply is kept. `verify` reports what
every physical line is — accepted, nonconforming, damaged, garbage, or
conflict variant — and never drops bytes. `view` renders `transcript` or
`tree`.

## Sync

Any lync file can converge with any other copy through a relay:

```bash
lync serve ./rooms --port 8787              # the relay: one append-only file per root
lync sync story.lync ws://host:8787         # one-shot: push what it lacks, pull what you lack
lync sync story.lync ws://host:8787 --follow  # stay live until Ctrl-C
```

The relay stores each root as a plain `.lync` file you can read with any lync
tool. Same-id-different-bytes is never resolved: both variants are kept and
both sides are told loudly. An interrupted sync resumes from a per-root cursor
(`<file>.sync.json`).

Run `lync --help` for full usage. Format spec and docs:
https://github.com/deepfates/lync#readme
