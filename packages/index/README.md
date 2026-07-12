# lync-index

An index of many lync looms: track a collection, upsert entries, and subscribe
to changes. Depends only on
[lync-core](https://www.npmjs.com/package/lync-core).

```bash
npm install lync-index
```

```ts
import { loomRef } from "lync-core";
import { createMemoryLoomIndexes } from "lync-index/memory";

const indexes = createMemoryLoomIndexes();
const index = await indexes.create({ title: "My looms" });

index.subscribe((event) => console.log("index changed:", event.type));
await index.addLoom(loomRef("loom-1"), { title: "Story" });

console.log((await index.entries()).map((entry) => entry.title));
```

Entries carry a loom reference, optional title/kind/meta, and timestamps.
`export()`/`import()` round-trip a whole index as a snapshot.

Typically used through
[lync-client](https://www.npmjs.com/package/lync-client), which pairs an index
with looms and reference resolution. Full docs:
https://github.com/deepfates/lync#readme
