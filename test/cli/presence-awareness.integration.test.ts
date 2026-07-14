import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryEventStore } from "@deepfates/lync/memory-log";
import { createSyncedStore, createWebSocketTransport, type SyncedStore } from "@deepfates/lync/synced-store";
import { startLyncServe, type LyncSyncServer } from "@deepfates/lync/relay";
import { createPresenceAwareness, type PresenceAwareness, type PresenceDelta } from "@deepfates/lync/presence-awareness";

/**
 * Awareness end to end: a REAL relay + two REAL synced stores over the global
 * WebSocket. Peer A's typed presence reaches peer B; A going silent times out
 * of B's roster; a null leave removes A immediately; and the relay writes
 * NOTHING to disk for presence. This retires the untested-primitive gap — the
 * only presence test before this was a codec roundtrip.
 */

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: condition not met within timeout");
}

interface Peer {
  store: SyncedStore;
  aware: PresenceAwareness;
  deltas: Array<{ root: string; delta: PresenceDelta }>;
  /** Live roster keyed by client id, folded from the deltas (what B "sees"). */
  seen: Map<string, PresenceDelta["added"][number]>;
}

// A shrunk TTL so "A goes silent for ~30s" runs in milliseconds. The awareness
// default is 30_000ms (see presence-awareness); we drive the same machine with
// ttlMs=120 and hand-tick `sweep`, so the test is deterministic, not timed.
const TTL_MS = 120;

function makePeer(url: string, actor: string): Peer {
  const deltas: Array<{ root: string; delta: PresenceDelta }> = [];
  const seen = new Map<string, PresenceDelta["added"][number]>();
  const inner = createMemoryEventStore();
  const transport = createWebSocketTransport(url, { reconnectMs: 0 });
  let aware: PresenceAwareness;
  const store = createSyncedStore(inner, transport, {
    onPresence: (root, client, presence) => aware.receive(root, client, presence),
  });
  aware = createPresenceAwareness({
    client: `${actor}-conn`,
    ttlMs: TTL_MS,
    send: (root, client, data) => store.presence(root, client, data),
    onDelta: (root, delta) => {
      deltas.push({ root, delta });
      for (const p of [...delta.added, ...delta.updated]) seen.set(p.client, p);
      for (const p of delta.removed) seen.delete(p.client);
    },
  });
  return { store, aware, deltas, seen };
}

describe("presence awareness over a real relay", () => {
  let server: LyncSyncServer | undefined;
  let dir: string;
  const closers: Array<() => void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await server?.close();
    server = undefined;
  });

  it("delivers typed presence A->B, TTL-removes a silent A, removes A on leave, and never touches disk", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "lync-presence-"));
    server = await startLyncServe({ dir, log: () => {} });
    const url = `ws://localhost:${server.port}`;
    const root = "presence-room"; // never carries a durable event

    const a = makePeer(url, "alice");
    const b = makePeer(url, "bob");
    closers.push(a.store.close, b.store.close);

    // Both must subscribe to the room to be in the relay's fanout set.
    a.store.syncRoot(root);
    b.store.syncRoot(root);
    await waitFor(() => {
      const room = server!.status().find((r) => r.root === root);
      return (room?.subscribers ?? 0) >= 2;
    });

    const dirBefore = (await readdir(dir)).sort();

    // ── ACCEPTANCE 1: A's typed presence (cursor/focus/typing + actor) reaches B.
    a.aware.setLocal(root, { actor: "alice", via: "textile-browser", focus: "node-7", typing: true });
    await waitFor(() => b.seen.has("alice-conn"));
    const seenA = b.seen.get("alice-conn")!;
    expect(seenA.state).toEqual({ actor: "alice", via: "textile-browser", focus: "node-7", typing: true });
    expect(seenA.client).toBe("alice-conn"); // keyed by client id, not actor

    // An update (A moves its cursor + stops typing) is applied by clock order.
    a.aware.setLocal(root, { actor: "alice", focus: "node-9", typing: false });
    await waitFor(() => b.seen.get("alice-conn")?.state.focus === "node-9");
    expect(b.seen.get("alice-conn")!.state.typing).toBe(false);

    // ── ACCEPTANCE 2: A goes silent -> removed from B's roster after the TTL.
    // No more frames from A. B's TTL sweep (shrunk to 120ms) drops it.
    await new Promise((r) => setTimeout(r, TTL_MS + 40));
    b.aware.sweep();
    expect(b.aware.roster(root)).toEqual([]);
    expect(b.seen.has("alice-conn")).toBe(false);
    const removedByTtl = b.deltas.flatMap((d) => d.delta.removed.map((p) => p.client));
    expect(removedByTtl).toContain("alice-conn");

    // ── ACCEPTANCE 3: a state=null leave removes A immediately.
    // A rejoins, B sees it, then A leaves gracefully.
    a.aware.setLocal(root, { actor: "alice", typing: false });
    await waitFor(() => b.seen.has("alice-conn"));
    const beforeLeave = b.deltas.length;
    a.aware.setLocal(root, null); // graceful leave
    await waitFor(() => !b.seen.has("alice-conn"));
    const leaveDelta = b.deltas.slice(beforeLeave).flatMap((d) => d.delta.removed.map((p) => p.client));
    expect(leaveDelta).toContain("alice-conn");
    expect(b.aware.roster(root)).toEqual([]);

    // ── ACCEPTANCE 4: the relay wrote NOTHING to disk for presence.
    const dirAfter = (await readdir(dir)).sort();
    expect(dirAfter).toEqual(dirBefore); // no new files from any presence traffic
    expect(dirAfter).not.toContain(`${root}.lync`); // presence-only root has no log
  });
});
