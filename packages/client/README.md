# lync-client

The lync loom client: one object that pairs looms
([lync-core](https://www.npmjs.com/package/lync-core)) with an index
([lync-index](https://www.npmjs.com/package/lync-index)) and resolves
loom/turn/thread/index references to and from URLs.

```bash
npm install lync-client
```

```ts
import { createLyncLooms } from "lync-core/looms";
import { createMemoryEventStore } from "lync-core/memory-log";
import { createMemoryLoomIndexes } from "lync-index/memory";
import { createLoomClient } from "lync-client";

const client = createLoomClient({
  looms: createLyncLooms({ store: createMemoryEventStore(), author: { actor: "you" } }),
  indexes: createMemoryLoomIndexes(),
});

const info = await client.looms.create({ title: "Story" });
const ref = client.references.loom(info.id);

// Round-trip a reference through a shareable URL (?ref=...).
// In the browser, pass `window.location` instead of a URL object.
const url = client.references.toUrl(ref, new URL("https://example.com/story"));
const opened = await client.openReference(client.references.fromUrl(new URL(url)));
console.log(opened.kind); // "loom" — opened.loom is ready to appendTurn
```

Full docs: https://github.com/deepfates/lync#readme
