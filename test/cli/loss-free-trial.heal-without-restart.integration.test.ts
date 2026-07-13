import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryEventStore } from "@deepfates/lync/memory-log";
import { createSyncedStore, createWebSocketTransport, type SyncStatus } from "@deepfates/lync/synced-store";
import { startLyncServe, type LyncSyncServer } from "@deepfates/lync/relay";

/**
 * Heal-without-restart (dee-1pfp) — the last known durability hole in the relay.
 *
 * The sibling of the loss-free trial. That trial proves a disk failure heals
 * across a server RESTART (the generation reset re-pushes the lost line). This
 * proves the relay's on-disk log converges ON ITS OWN, with NO restart:
 *
 *   1. The relay's `<root>.lync` goes read-only. Alice appends X: it fans out
 *      to every client (in every store) but the disk write fails and
 *      `persist-failed` surfaces. X is NOT on disk — the relay holds it as
 *      pending-unpersisted, in memory, broadcast, but off the durable log.
 *   2. The disk heals. NO server restart, NO reconnect, NO new generation.
 *   3. Bob appends Y to the SAME root. That next activity first flushes the
 *      pending X (now that the disk is writable), in append order, then Y.
 *
 * Assert: BOTH X and Y are on the relay's on-disk .lync file, and BOTH are in
 * every client's store. The previously-refused X reached disk via the
 * next-activity flush alone — the retry is load-bearing (neuter it and X never
 * lands without a restart, and this test fails).
 */

const ROOT = "heal";

function idsOf(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return (JSON.parse(line) as { id?: string }).id ?? "<none>";
      } catch {
        return "<damaged>";
      }
    });
}

function makeClient(url: string, actor: string) {
  const inner = createMemoryEventStore();
  const statuses: SyncStatus[] = [];
  const transport = createWebSocketTransport(url, { reconnectMs: 30 });
  const store = createSyncedStore(inner, transport, { onStatus: (s) => statuses.push(s) });
  const appended = new Set<string>();
  const append = async (id: string, parents: string[], text: string) => {
    const result = await store.append({
      v: 1,
      id,
      kind: "lync/artifact",
      at: "2026-07-08T21:00:00Z",
      author: { actor },
      parents,
      payload: { text },
    });
    if (result.status === "added") appended.add(id);
    return result;
  };
  const sawFailure = (needle: string) =>
    statuses.some((s) => s.failures.some((f) => f.includes(needle))) ||
    store.status().failures.some((f) => f.includes(needle));
  return { actor, store, statuses, appended, append, sawFailure };
}
type Client = ReturnType<typeof makeClient>;

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "condition not met";
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      last = String(error);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: ${last} within ${timeoutMs}ms`);
}

describe("heal-without-restart (dee-1pfp): the relay's on-disk log converges with no restart", () => {
  let server: LyncSyncServer | undefined;
  let clients: Client[] = [];

  afterEach(async () => {
    for (const c of clients) c.store.close();
    clients = [];
    await server?.close();
    server = undefined;
  });

  it("a transiently-failed line reaches disk on the next activity, no restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-heal-"));
    const roomFile = path.join(dir, `${ROOT}.lync`);
    server = await startLyncServe({ dir, log: () => {} });
    const startedPort = server.port;
    const url = `ws://localhost:${startedPort}`;

    const a = makeClient(url, "alice");
    const b = makeClient(url, "bob");
    clients = [a, b];
    for (const cl of clients) cl.store.syncRoot(ROOT);

    // Seed a real root, and prove it is durable everywhere before we break the
    // disk (so the failure below is the ONLY thing off disk).
    await a.append(ROOT, [], "the story begins");
    await waitFor(async () => {
      for (const cl of clients) if ((await cl.store.byId(ROOT)) === null) return false;
      return new Set(idsOf(await readFile(roomFile, "utf8"))).has(ROOT);
    });

    // ---- Storage fails: Alice's X reaches every client but not disk --------
    await chmod(roomFile, 0o444);
    await a.append("X", [ROOT], "alice's line, refused by the disk");
    // X is in every client's store despite the failed persist...
    await waitFor(async () => {
      for (const cl of clients) if ((await cl.store.byId("X")) === null) return false;
      return true;
    });
    // ...the durability failure screamed on every subscriber...
    await waitFor(() => a.sawFailure("persist-failed") && b.sawFailure("persist-failed"));
    expect(a.sawFailure("persist-failed")).toBe(true);
    expect(b.sawFailure("persist-failed")).toBe(true);
    // ...and X genuinely never hit disk.
    expect(new Set(idsOf(await readFile(roomFile, "utf8"))).has("X")).toBe(false);

    // ---- The disk heals. NO restart, NO reconnect, NO new generation. -----
    await chmod(roomFile, 0o644);

    // ---- Next activity on the SAME root, SAME running server --------------
    // Bob appends Y. The relay flushes the pending X first (append order), then
    // Y. Both must land on disk without any restart having happened.
    await b.append("Y", ["X"], "bob's line, after the disk healed");

    // The heart of the proof: BOTH X (the refused line) and Y are now on the
    // relay's on-disk .lync file.
    await waitFor(async () => {
      const onDisk = new Set(idsOf(await readFile(roomFile, "utf8")));
      return onDisk.has("X") && onDisk.has("Y") && onDisk.has(ROOT);
    }, 8_000).catch(async (error) => {
      const onDisk = [...new Set(idsOf(await readFile(roomFile, "utf8").catch(() => "")))];
      throw new Error(`X did not heal to disk without a restart — on disk: [${onDisk}] (${error})`);
    });
    const finalDisk = new Set(idsOf(await readFile(roomFile, "utf8")));
    expect(finalDisk.has("X")).toBe(true);
    expect(finalDisk.has("Y")).toBe(true);
    expect(finalDisk.has(ROOT)).toBe(true);

    // Strict on-disk append order: the earlier line X is never written after Y.
    const order = idsOf(await readFile(roomFile, "utf8"));
    expect(order.indexOf("X")).toBeLessThan(order.indexOf("Y"));

    // Both lines are in every client's store too.
    for (const cl of clients) {
      expect(await cl.store.byId("X")).not.toBeNull();
      expect(await cl.store.byId("Y")).not.toBeNull();
    }

    // The server was never restarted: same instance, same port throughout.
    expect(server.port).toBe(startedPort);
    // No generation change was ever surfaced (a restart would have minted one).
    expect(a.sawFailure("generation changed")).toBe(false);
    expect(b.sawFailure("generation changed")).toBe(false);
  }, 30_000);
});
