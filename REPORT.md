# dee-8e4b Report

Branch: `fold-up`

## What Changed

- Folded textile's vendored websocket sync adapter into `packages/client/src/sync.ts`.
- Wired `createNodeLoomClient` through `createWebSocketSyncAdapter`, preserving `syncUrl` and adding `sync`/expanded `websocket` options plus sync status/auth type exports from `packages/client/src/node.ts`.
- Folded the browser Automerge import delta into `packages/core/src/browser.ts` and added the direct `@automerge/automerge` package dependency for `@lync/core`.
- Folded textile's sync-server hardening into `packages/sync-server/src/index.ts`: bounded shutdown, shutdown error tolerance, upgrade rejection responses, closing-state rejection, tracked upgrade sockets, and `maxConnections`.
- Folded the grown node client and sync-server tests from textile.
- Added the direct `isomorphic-ws` dependency to `@lync/client` because the new client sync module imports it.

## Parity Checks

Vendor files copied with exact source parity:

```sh
diff -u packages/client/src/sync.ts /Users/deepfates/Hacking/github/deepfates/textile/vendor/lync/packages/client/src/sync.ts
diff -u packages/sync-server/src/index.ts /Users/deepfates/Hacking/github/deepfates/textile/vendor/lync/packages/sync-server/src/index.ts
diff -u packages/client/test/node.test.ts /Users/deepfates/Hacking/github/deepfates/textile/vendor/lync/packages/client/test/node.test.ts
diff -u packages/sync-server/test/sync-server.test.ts /Users/deepfates/Hacking/github/deepfates/textile/vendor/lync/packages/sync-server/test/sync-server.test.ts
diff -u packages/core/src/browser.ts /Users/deepfates/Hacking/github/deepfates/textile/vendor/lync/packages/core/src/browser.ts
```

All returned no diff.

`packages/client/src/node.ts` differs from textile only by de-vendored imports:

```diff
-} from "@lync/core/automerge";
+} from "../../core/src/automerge";
-} from "@lync/index/automerge";
+} from "../../index/src/automerge";
```

## Reproduce Commands

```sh
git checkout fold-up
pnpm install --offline
pnpm exec vitest run packages/client/test/node.test.ts packages/client/test/browser.test.ts packages/core/test/automerge-browser.test.ts packages/sync-server/test/sync-server.test.ts
pnpm test
pnpm -r typecheck
(cd /Users/deepfates/Hacking/github/deepfates/textile && bun test ./server ./client)
```

## Evidence

`pnpm exec vitest run packages/client/test/node.test.ts packages/client/test/browser.test.ts packages/core/test/automerge-browser.test.ts packages/sync-server/test/sync-server.test.ts`

```text
Test Files  4 passed (4)
Tests  21 passed (21)
```

`pnpm test`

```text
Test Files  12 passed (12)
Tests  68 passed (68)
```

`pnpm -r typecheck`

```text
packages/core typecheck: Done
packages/sync-server typecheck: Done
packages/index typecheck: Done
packages/client typecheck: Done
```

Textile suite:

```text
bun test ./server ./client
75 pass
0 fail
133 expect() calls
Ran 75 tests across 11 files.
```

Note: the first sandboxed textile run failed one port-binding test with `Failed to start server. Is port 0 in use?`. Rerunning the same command outside the sandbox passed.

## Not Folded

- Generated build outputs, `node_modules`, tsbuildinfo files, and unrelated package/readme differences were not folded.
- `textile/scripts/vendor-lync.sh` was not edited because textile is read-only for this task. The required fix is to change its default from `"$ROOT/../loomsync"` to `"$ROOT/../lync"` and keep the existing source marker check.
- The textile repo had pre-existing local changes outside `vendor/lync`; I did not modify them.

## Tickets Filed

None.
