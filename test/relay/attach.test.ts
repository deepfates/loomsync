import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryEventStore } from "@deepfates/lync/memory-log";
import { createLyncLooms, loomRootId } from "@deepfates/lync/looms";
import { createSyncedStore, createWebSocketTransport } from "@deepfates/lync/synced-store";
import { attachLyncServer, type AttachedLyncServer } from "../../src/relay/attach.js";

async function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, () => {
    const addr = server.address();
    resolve(typeof addr === "object" && addr ? addr.port : 0);
  }));
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

describe("attachLyncServer", () => {
  let server: Server | undefined;
  let attached: AttachedLyncServer | undefined;
  const closers: Array<() => void> = [];

  afterEach(async () => {
    for (const c of closers.splice(0)) c();
    await attached?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = attached = undefined;
  });

  it("converges through the mounted path and passes other upgrades through", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-attach-"));
    server = createServer((_r, res) => res.writeHead(200).end());
    let otherUpgrade = 0;
    server.on("upgrade", (req, socket) => {
      if (req.url !== "/lync") {
        otherUpgrade += 1;
        socket.destroy();
      }
    });
    attached = attachLyncServer(server, { storageDir: dir, path: "/lync", log: () => {} });
    const port = await listen(server);

    const store = createSyncedStore(createMemoryEventStore(), createWebSocketTransport(`ws://localhost:${port}/lync`, { reconnectMs: 0 }));
    closers.push(store.close);
    const looms = createLyncLooms<{ text: string }, { title: string }, unknown>({ store, author: { actor: "a" } });
    const info = await looms.create({ title: "t" });
    const loom = await looms.open(info.id);
    const turn = await loom.appendTurn(null, { text: "mounted path works" });

    // A second client reads it back through the same mount.
    const store2 = createSyncedStore(createMemoryEventStore(), createWebSocketTransport(`ws://localhost:${port}/lync`, { reconnectMs: 0 }));
    closers.push(store2.close);
    store2.syncRoot(loomRootId(info.id));
    expect(await waitFor(async () => (await store2.byId(turn.id)) !== null)).toBe(true);
    expect(otherUpgrade).toBe(0); // relay handled /lync; nothing leaked to the app listener
  });

  it("rejects upgrades when authenticate returns false", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-attach-"));
    server = createServer((_r, res) => res.writeHead(200).end());
    attached = attachLyncServer(server, { storageDir: dir, authenticate: () => false, log: () => {} });
    const port = await listen(server);

    const store = createSyncedStore(createMemoryEventStore(), createWebSocketTransport(`ws://localhost:${port}/lync`, { reconnectMs: 0 }));
    closers.push(store.close);
    store.syncRoot("nope");
    // The socket is rejected, so the root never goes live.
    const wentLive = await waitFor(() => store.status().liveRoots.includes("nope"), 1_500);
    expect(wentLive).toBe(false);
  });
});
