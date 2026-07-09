# lync-core

Core APIs for lync files: append-only loom logs where each line is one JSON
event, files are merged losslessly by set-union, and every physical line is
classified and kept.

```ts
import { parseLoreFiles } from "lync-core/lore/events";
import { createMemoryEventStore } from "lync-core/lore/memory-log";

const store = createMemoryEventStore();
await store.append({
  v: 1,
  id: "root",
  kind: "lync/loom",
  at: "2026-07-06T04:12:31Z",
  author: { actor: "you" },
  parents: [],
  payload: { meta: { title: "Story" } },
});

const parsed = parseLoreFiles([{ file: "story.lync", bytes: line }]);
console.log(parsed.unionEventIds);
```

Full format spec, subpath exports, and examples:
https://github.com/deepfates/lync#readme
