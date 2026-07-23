import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryEventStore } from "@deepfates/lync/memory-log";
import { createSyncedStore, createWebSocketTransport, type SyncStatus } from "@deepfates/lync/synced-store";
import { startLyncServe, type LyncSyncServer } from "@deepfates/lync/relay";

/**
 * The loss-free trial (dee-i1wc) — the world-charter milestone-6 proof.
 *
 * A real relay plus real synced stores over the global WebSocket, run through
 * the full durability gauntlet, in three legs against ONE shared root:
 *
 *   (a) a client disconnects mid-stream and reconnects;
 *   (b) the relay's storage fails mid-run (the .lync file goes read-only) and
 *       then recovers;
 *   (c) the server process restarts — a new log generation.
 *
 * The invariant asserted after the gauntlet, and the surfacing asserted per
 * leg: every event any client SUCCESSFULLY appended (local append returned
 * `added`) ends up in every other client's store AND in the relay's on-disk
 * .lync file — nothing lost, nothing silently skipped — and every failure that
 * occurred was surfaced through a status/err channel, not swallowed.
 *
 * Why leg (b)'s lost-to-disk event only reaches disk after leg (c): a relay
 * whose write fails still fans the event out and holds it in memory, so a
 * same-generation re-push is a byId duplicate no-op — the line never re-hits
 * disk until a restart drops the in-memory copy, mints a new generation, and
 * the clients resync from 0 and re-push it fresh. That is the loss-free
 * property under a storage failure: the generation reset is what closes it.
 */

const ROOT = "trial";

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

/**
 * A WebSocket subclass that records every instance it constructs, so a test
 * can force-close ONE client's live socket — a network drop for that client
 * alone, leaving the transport's auto-reconnect to bring it back.
 */
function trackedWebSocket(): { impl: typeof WebSocket; sockets: WebSocket[] } {
  const sockets: WebSocket[] = [];
  const Real = (globalThis as { WebSocket: typeof WebSocket }).WebSocket;
  class Tracked extends Real {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(this as unknown as WebSocket);
    }
  }
  return { impl: Tracked as unknown as typeof WebSocket, sockets };
}

function makeClient(url: string, actor: string) {
  const inner = createMemoryEventStore();
  const tracker = trackedWebSocket();
  const statuses: SyncStatus[] = [];
  const transport = createWebSocketTransport(url, { reconnectMs: 30, WebSocketImpl: tracker.impl });
  const store = createSyncedStore(inner, transport, { onStatus: (s) => statuses.push(s) });
  // Every appended id whose LOCAL append returned "added" — the events the
  // trial promises never to lose.
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
  return { actor, store, statuses, appended, append, sawFailure, dropSocket: () => tracker.sockets.at(-1)?.close() };
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

describe("loss-free trial (dee-i1wc): the milestone-6 durability proof", () => {
  let server: LyncSyncServer | undefined;
  let clients: Client[] = [];

  afterEach(async () => {
    for (const c of clients) c.store.close();
    clients = [];
    await server?.close();
    server = undefined;
  });

  it("runs the full gauntlet (disconnect, storage failure, restart) and loses nothing, hiding nothing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-loss-free-"));
    const roomFile = path.join(dir, `${ROOT}.lync`);
    server = await startLyncServe({ dir, log: () => {} });
    const port = server.port;
    const url = `ws://localhost:${port}`;

    const a = makeClient(url, "alice");
    const b = makeClient(url, "bob");
    const c = makeClient(url, "carol");
    clients = [a, b, c];

    // All three sync the shared root and reach live.
    for (const cl of clients) cl.store.syncRoot(ROOT);
    // The union of everything every client appended — the loss-free promise set.
    const promised = () => new Set<string>([...a.appended, ...b.appended, ...c.appended]);

    // Every promised id is durable in every client's store AND on the relay's
    // on-disk .lync file. Polls to absorb replication/persist latency.
    const assertConverged = async (label: string, extraTimeout = 8_000) => {
      const want = [...promised()];
      await waitFor(async () => {
        for (const cl of clients) {
          for (const id of want) if ((await cl.store.byId(id)) === null) return false;
        }
        const onDisk = new Set(idsOf(await readFile(roomFile, "utf8")));
        return want.every((id) => onDisk.has(id));
      }, extraTimeout).catch(async (error) => {
        // Loud, never a silent skip: report exactly what is missing where.
        const onDisk = new Set(idsOf(await readFile(roomFile, "utf8").catch(() => "")));
        const missingDisk = want.filter((id) => !onDisk.has(id));
        const missingStores: string[] = [];
        for (const cl of clients)
          for (const id of want) if ((await cl.store.byId(id)) === null) missingStores.push(`${cl.actor}:${id}`);
        throw new Error(`${label}: not converged — off disk [${missingDisk}], missing in stores [${missingStores}] (${error})`);
      });
    };

    // Root event first (a real root so children have a parent to attach to).
    await a.append(ROOT, [], "the trial begins");
    await assertConverged("seed");

    // ---- Leg (a): a client disconnects mid-stream and reconnects ----------
    // Bob's socket drops while Alice keeps appending. Bob must catch up on
    // reconnect with nothing skipped.
    b.dropSocket();
    await waitFor(() => b.store.status().connection !== "online");
    await a.append("a1", [ROOT], "appended while bob is dark");
    await a.append("a2", ["a1"], "and another");
    // Bob's transport auto-reconnects (reconnectMs) and resyncs from its cursor.
    await waitFor(() => b.store.status().connection === "online");
    await assertConverged("leg-a disconnect/reconnect");
    expect(await b.store.byId("a1")).not.toBeNull();
    expect(await b.store.byId("a2")).not.toBeNull();

    // ---- Leg (b): the relay's storage fails mid-run, then recovers --------
    // The .lync file goes read-only. Carol appends x1: the relay fans it out
    // to every client (so it is in every store) but the disk write fails and
    // is surfaced as `persist-failed`. The event is NOT yet on disk — that is
    // the point; leg (c)'s generation reset is what restores it.
    await chmod(roomFile, 0o444);
    const diskBeforeFail = new Set(idsOf(await readFile(roomFile, "utf8")));
    await c.append("x1", ["a2"], "carol's line, refused by the disk");
    // x1 reaches every client's store despite the failed persist...
    await waitFor(async () => {
      for (const cl of clients) if ((await cl.store.byId("x1")) === null) return false;
      return true;
    });
    // ...and the durability failure screamed through the status channel on
    // every subscriber (asserting the surfacing, not just the recovery).
    await waitFor(() => a.sawFailure("persist-failed") && b.sawFailure("persist-failed") && c.sawFailure("persist-failed"));
    expect(a.sawFailure("persist-failed")).toBe(true);
    expect(b.sawFailure("persist-failed")).toBe(true);
    expect(c.sawFailure("persist-failed")).toBe(true);
    expect(diskBeforeFail.has("x1")).toBe(false); // never hit disk
    expect(new Set(idsOf(await readFile(roomFile, "utf8"))).has("x1")).toBe(false);
    // Storage heals.
    await chmod(roomFile, 0o644);

    // ---- Leg (c): the server process restarts — a new generation ---------
    // The recovered log (from disk) lacks x1 and its seq sits behind the
    // clients' cursors. On restart every client detects the generation change,
    // resyncs from 0, and re-pushes its backlog — including x1, which the
    // fresh room now persists. A post-restart event also flows end to end.
    await server.close();
    server = await startLyncServe({ dir, port, log: () => {} });
    await waitFor(() => clients.every((cl) => cl.store.status().connection === "online"));
    // The generation reset was surfaced on every client, not silently applied.
    await waitFor(() => clients.every((cl) => cl.sawFailure("generation changed")));
    for (const cl of clients) expect(cl.sawFailure("generation changed")).toBe(true);

    // A brand-new event in the new generation, appended by Alice post-restart.
    await a.append("post", ["a2"], "after the restart, still one story");

    // ---- Overall: nothing lost, nothing hidden --------------------------
    // Every promised event — including x1, the one the dead disk refused — is
    // now in every client's store AND on the relay's on-disk .lync file.
    await assertConverged("overall (post-restart, disk restored)", 12_000);
    const finalDisk = new Set(idsOf(await readFile(roomFile, "utf8")));
    for (const id of [ROOT, "a1", "a2", "x1", "post"]) {
      expect(finalDisk.has(id)).toBe(true);
    }
    // The event the dead disk refused survived to disk via the generation reset.
    expect(finalDisk.has("x1")).toBe(true);
    // And every client converged on the full set.
    for (const cl of clients) {
      for (const id of [ROOT, "a1", "a2", "x1", "post"]) {
        expect(await cl.store.byId(id)).not.toBeNull();
      }
    }

    // ---- Emit an inspectable per-run trial artifact ----------------------
    // 'done' is not quietly 'tests pass': write a person-readable record of
    // every appended id, where it landed (each client's store + the relay's
    // on-disk .lync), and every surfaced failure. Keep the live artifact in
    // this trial's isolated temporary directory: recorded_at and relay
    // generation ids are intentionally different on every run, so ordinary
    // verification must never rewrite the checked-in historical witness.
    const promisedIds = [...promised()].sort();
    const landing: Record<string, { stores: Record<string, boolean>; onDisk: boolean }> = {};
    for (const id of promisedIds) {
      const stores: Record<string, boolean> = {};
      for (const cl of clients) stores[cl.actor] = (await cl.store.byId(id)) !== null;
      landing[id] = { stores, onDisk: finalDisk.has(id) };
    }
    // Every failure any client surfaced across the run — deduped, never swallowed.
    const surfacedFailures = clients.map((cl) => {
      const all = new Set<string>();
      for (const s of cl.statuses) for (const f of s.failures) all.add(f);
      for (const f of cl.store.status().failures) all.add(f);
      return { actor: cl.actor, failures: [...all] };
    });
    const artifact = {
      artifact_schema: "lync.loss-free-trial.v1",
      ticket: "dee-i1wc",
      recorded_at: new Date().toISOString(),
      owner_law: "world-charter milestone-6: durable, loss-free live sync",
      claim:
        "Every event a client SUCCESSFULLY appended (local append returned 'added') reaches every other client's store AND the relay's on-disk .lync file — through a disconnect, a storage failure, and a server restart — and every failure that occurred was surfaced, never swallowed.",
      root: ROOT,
      appended_by_client: Object.fromEntries(clients.map((cl) => [cl.actor, [...cl.appended].sort()])),
      promised_ids: promisedIds,
      landing,
      final_disk_ids: [...finalDisk].sort(),
      surfaced_failures: surfacedFailures,
      legs: [
        { leg: "a", name: "disconnect / reconnect", event_ids: ["a1", "a2"], surfaced: "bob's connection went offline then online; caught up with nothing skipped" },
        { leg: "b", name: "storage failure (.lync read-only)", event_ids: ["x1"], surfaced: "persist-failed on every client; x1 fanned to every store but not on disk until leg c" },
        { leg: "c", name: "server restart (new log generation)", event_ids: ["post"], surfaced: "generation changed on every client; backlog re-pushed, x1 finally reached disk" },
      ],
    };
    const artifactPath = path.join(dir, "loss-free-trial.json");
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + "\n");
    expect(JSON.parse(await readFile(artifactPath, "utf8"))).toEqual(artifact);

    // The artifact must describe an actually loss-free run: nothing missing.
    for (const id of promisedIds) {
      expect(landing[id].onDisk).toBe(true);
      for (const cl of clients) expect(landing[id].stores[cl.actor]).toBe(true);
    }
    // And it recorded that the durability failures WERE surfaced, not hidden.
    expect(surfacedFailures.every((c) => c.failures.some((f) => f.includes("persist-failed")))).toBe(true);
    expect(surfacedFailures.every((c) => c.failures.some((f) => f.includes("generation changed")))).toBe(true);
  }, 30_000);
});
