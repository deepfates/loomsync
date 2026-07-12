# lync-server

The lync line-sync relay. It moves canonical `.lync` line bytes between
subscribers over five JSON frames (`sub`, `ev`, `live`, `presence`, `err`) and
has no merge logic — lync events are immutable and merge is set union by id,
so echoes are duplicate no-ops. Each root is stored as a plain append-only
`.lync` file you can read with any lync tool. The relay never parses a line
beyond extracting its id.

```bash
npm install lync-server
```

## Standalone

```ts
import { startLyncServe } from "lync-server";

const server = await startLyncServe({ dir: "./rooms", port: 8787 });
console.log("relay on", server.port);
// later: await server.close();
```

## On an existing HTTP server

```ts
import { createServer } from "node:http";
import { attachLyncServer } from "lync-server";

const httpServer = createServer(app);
const lync = attachLyncServer(httpServer, {
  storageDir: "./rooms",
  path: "/lync",              // default
  keepAliveInterval: 30_000,  // optional: ping through idle proxies
  maxConnections: 500,        // optional
  authenticate: (req) => checkSession(req), // optional, after token check
});
httpServer.listen(3000);
```

For full control, `createLyncRelay` gives you `handleUpgrade` to call from
your own `upgrade` listener.

Guarantees: same-id-different-bytes is never resolved — both variants are
kept (a `.conflicts` sidecar) and both sides are told loudly. Persist failures
are broadcast, never swallowed. A truncated final line after a crash is
sealed and surfaced as damaged, never eaten. `token` requires
`Authorization: Bearer <token>` on every upgrade.

Client side: `lync sync` from
[lync-cli](https://www.npmjs.com/package/lync-cli), or `createSyncedStore`
from [lync-core](https://www.npmjs.com/package/lync-core) inside an app. Full
docs: https://github.com/deepfates/lync#readme
