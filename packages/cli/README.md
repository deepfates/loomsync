# lync-cli

Command-line tools for lync files: append-only loom logs, one JSON event per
line, merged losslessly by set-union.

```bash
npm install -g lync-cli

lync init story.lync
printf '%s\n' '{"kind":"notes/text","author":{"actor":"you"},"payload":{"text":"Once..."}}' | lync append story.lync
lync verify story.lync
lync view story.lync --as transcript
lync merge story.lync other.lync -o merged.lync
```

Seven verbs: `init`, `append`, `verify`, `merge`, `view`, `serve` (the
line-sync relay), and `sync` (converge a file with a relay, `--follow` to stay
live). Run `lync --help` for
usage. Full docs: https://github.com/deepfates/lync#readme
