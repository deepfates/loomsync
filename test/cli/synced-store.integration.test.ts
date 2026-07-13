import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryEventStore } from "@deepfates/lync/memory-log";
import { createLyncLooms, loomRootId } from "@deepfates/lync/looms";
import { createSyncedStore, createWebSocketTransport } from "@deepfates/lync/synced-store";
import { startLyncServe, type LyncSyncServer } from "@deepfates/lync/relay";

/**
 * The embedded browser story, proven end to end: a real relay, two clients
 * over the global WebSocket, looms built on synced stores. A turn appended on
 * client A appears in client B's loom reactively — the thing textile's
 * status-only socket never actually did.
 */

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: condition not met within timeout");
}

function client(url: string, actor: string) {
  const inner = createMemoryEventStore();
  const transport = createWebSocketTransport(url, { reconnectMs: 0 });
  const store = createSyncedStore(inner, transport);
  const looms = createLyncLooms<{ text: string }, { title: string }, { role: string }>({
    store,
    author: { actor },
  });
  return { store, looms };
}

describe("embedded synced looms over a real relay", () => {
  let server: LyncSyncServer | undefined;
  const closers: Array<() => void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await server?.close();
    server = undefined;
  });

  it("delivers a turn appended on client A to client B's loom, reactively", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-embed-"));
    server = await startLyncServe({ dir, log: () => {} });
    const url = `ws://localhost:${server.port}`;

    const a = client(url, "alice");
    const b = client(url, "bob");
    closers.push(a.store.close, b.store.close);

    // A creates a loom and seeds a turn.
    const info = await a.looms.create({ title: "shared story" });
    const loomA = await a.looms.open(info.id);
    const first = await loomA.appendTurn(null, { text: "Once upon a time" }, { role: "prose" });

    // B learns the loom id (in an app this comes via the index), syncs its
    // root, waits for the backlog, then opens it.
    const root = loomRootId(info.id);
    b.store.syncRoot(root);
    await waitFor(async () => (await b.store.byId(root)) !== null);
    const loomB = await b.looms.open(info.id);

    let bReacted = 0;
    loomB.subscribe(() => {
      bReacted += 1;
    });

    // A appends a second turn (child of the first) AFTER B is watching.
    const second = await loomA.appendTurn(first.id, { text: "the end." }, { role: "prose" });

    // B converges on the second turn and its full thread reads root→first→second.
    await waitFor(async () => (await b.store.byId(second.id)) !== null);
    const threadB = await loomB.threadTo(second.id);
    expect(threadB.map((t) => t.payload.text)).toEqual(["Once upon a time", "the end."]);
    expect(bReacted).toBeGreaterThanOrEqual(1); // B's loom recomputed live

    // And the reverse direction: B appends, A sees it live.
    const reply = await loomB.appendTurn(second.id, { text: "a reply from bob" }, { role: "prose" });
    await waitFor(async () => (await a.store.byId(reply.id)) !== null);
    const threadA = await loomA.threadTo(reply.id);
    expect(threadA.map((t) => t.payload.text)).toEqual(["Once upon a time", "the end.", "a reply from bob"]);
  });
});
