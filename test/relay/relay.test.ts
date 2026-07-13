import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryEventStore } from "lync-core/memory-log";
import { createLyncLooms, loomRootId } from "lync-core/looms";
import { createSyncedStore, createWebSocketTransport } from "lync-core/synced-store";
import { createLyncRelay } from "../../src/relay/relay.js";

/**
 * The relay mounted on an app's own HTTP server at a path — the embedding
 * textile needs. Two synced clients converge through it.
 */

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: condition not met within timeout");
}

describe("createLyncRelay mounted on an existing server", () => {
  let server: Server | undefined;
  const closers: Array<() => void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("relays only its own path and converges two embedded clients", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-relay-"));
    const relay = createLyncRelay({ dir, log: () => {} });
    closers.push(() => void relay.close());

    server = createServer((_req, res) => res.writeHead(200).end("app"));
    server.on("upgrade", (req, socket, head) => {
      if (req.url === "/lync") relay.handleUpgrade(req, socket, head);
      else socket.destroy();
    });
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, () => {
        const addr = server!.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    const url = `ws://localhost:${port}/lync`;

    const mk = (actor: string) => {
      const store = createSyncedStore(createMemoryEventStore(), createWebSocketTransport(url, { reconnectMs: 0 }));
      const looms = createLyncLooms<{ text: string }, { title: string }, unknown>({ store, author: { actor } });
      closers.push(store.close);
      return { store, looms };
    };
    const a = mk("alice");
    const b = mk("bob");
    await new Promise((r) => setTimeout(r, 200));

    const info = await a.looms.create({ title: "mounted" });
    const loomA = await a.looms.open(info.id);
    const t1 = await loomA.appendTurn(null, { text: "hello from the app server" });

    const root = loomRootId(info.id);
    b.store.syncRoot(root);
    await waitFor(async () => (await b.store.byId(t1.id)) !== null);
    const loomB = await b.looms.open(info.id);
    const thread = await loomB.threadTo(t1.id);
    expect(thread.map((t) => t.payload.text)).toEqual(["hello from the app server"]);
  });
});

describe("createLyncRelay durability failures", () => {
  it("surfaces a persist failure loudly, still broadcasts, and does not wedge the room", async () => {
    const { chmod, mkdtemp } = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const { createServer } = await import("node:http");
    const { createWebSocketTransport } = await import("lync-core/synced-store");

    const dir = await mkdtemp(nodePath.join(os.tmpdir(), "lync-persist-"));
    // Read-only dir: recovery (no existing files) succeeds, but every append fails.
    await chmod(dir, 0o555);

    const relay = createLyncRelay({ dir, log: () => {} });
    const server = createServer((_r, res) => res.writeHead(200).end());
    server.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head));
    const port = await new Promise<number>((resolve) => server.listen(0, () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    }));
    const url = `ws://localhost:${port}`;

    const evs: string[] = [];
    const errs: string[] = [];
    const t = createWebSocketTransport(url, { reconnectMs: 0 });
    t.onFrame((f) => {
      if (f.t === "err") errs.push(f.reason);
      if (f.t === "ev") evs.push(f.line);
    });
    const line = (id: string) => JSON.stringify({ v: 1, id, kind: "lync/artifact", at: "2026-07-08T21:00:00Z", author: { actor: "x" }, parents: [], payload: {} });

    try {
      t.send({ t: "sub", root: "wedged", since: 0 });
      t.send({ t: "ev", root: "wedged", line: line("e1") });
      await new Promise((r) => setTimeout(r, 250));
      // Second write proves the first failure did NOT wedge the room.
      t.send({ t: "ev", root: "wedged", line: line("e2") });
      await new Promise((r) => setTimeout(r, 250));

      // Both events were broadcast (live delivery survived the disk failure)...
      expect(evs.filter((l) => l.includes('"e1"')).length).toBeGreaterThanOrEqual(1);
      expect(evs.filter((l) => l.includes('"e2"')).length).toBeGreaterThanOrEqual(1);
      // ...and each durability failure was surfaced loudly, never hidden.
      expect(errs.filter((r) => r === "persist-failed").length).toBeGreaterThanOrEqual(2);
    } finally {
      t.close();
      await relay.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await chmod(dir, 0o755);
    }
  });
});
