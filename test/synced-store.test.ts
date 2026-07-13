import { describe, expect, it } from "vitest";
import { createMemoryEventStore } from "@deepfates/lync/memory-log";
import { createLyncLooms } from "@deepfates/lync/looms";
import {
  createSyncedStore,
  type SyncConnectionState,
  type SyncStatus,
  type SyncTransport,
} from "@deepfates/lync/synced-store";
import type { SyncFrame } from "@deepfates/lync/sync-protocol";
import { serializeLyncEvent, type AppendResult, type EventStore, type StoredEvent } from "@deepfates/lync/store";

function mockTransport(initial: SyncConnectionState = "online") {
  const frameHandlers = new Set<(frame: SyncFrame) => void>();
  const openHandlers = new Set<() => void>();
  const stateHandlers = new Set<(state: SyncConnectionState) => void>();
  const sent: SyncFrame[] = [];
  let state = initial;
  const transport: SyncTransport = {
    send: (frame) => sent.push(frame),
    onFrame: (h) => (frameHandlers.add(h), () => frameHandlers.delete(h)),
    onOpen: (h) => (openHandlers.add(h), () => openHandlers.delete(h)),
    onStateChange: (h) => (stateHandlers.add(h), () => stateHandlers.delete(h)),
    get state() {
      return state;
    },
    close: () => {},
  };
  return {
    transport,
    sent,
    inject: (frame: SyncFrame) => frameHandlers.forEach((h) => h(frame)),
    open: () => openHandlers.forEach((h) => h()),
    setState: (next: SyncConnectionState) => {
      state = next;
      stateHandlers.forEach((h) => h(next));
    },
  };
}

const body = (id: string, parents: string[], text: string) => ({
  v: 1 as const,
  id,
  kind: "lync/artifact",
  at: "2026-07-08T21:00:00Z",
  author: { actor: "test" },
  parents,
  payload: { text },
});

describe("createSyncedStore", () => {
  it("pushes local appends to the relay and subscribes to the touched root", async () => {
    const mock = mockTransport();
    const store = createSyncedStore(createMemoryEventStore(), mock.transport);
    const result = await store.append(body("root", [], "hello"));
    expect(result.status).toBe("added");

    const evFrames = mock.sent.filter((f) => f.t === "ev");
    const subFrames = mock.sent.filter((f) => f.t === "sub");
    expect(evFrames).toHaveLength(1);
    expect(evFrames[0]).toMatchObject({ t: "ev" });
    expect(subFrames.length).toBeGreaterThanOrEqual(1);
  });

  it("ingests a remote event reactively — a root subscriber fires — without echoing it back", async () => {
    const mock = mockTransport();
    const store = createSyncedStore(createMemoryEventStore(), mock.transport);

    // Establish the root locally, then watch it for reactive updates.
    await store.union(serializeLyncEvent(body("r1", [], "seed")));
    let fired = 0;
    store.subscribe("r1", () => {
      fired += 1;
    });

    const sentBefore = mock.sent.length;
    // A remote peer's event arrives over the transport.
    mock.inject({ t: "ev", root: "r1", seq: 2, line: serializeLyncEvent(body("remote", ["r1"], "from afar")) });
    await new Promise((r) => setTimeout(r, 10));

    expect(fired).toBeGreaterThanOrEqual(1); // the subscriber recomputed reactively
    expect(await store.byId("remote")).not.toBeNull(); // ingested via union
    // The remote line was NOT re-pushed to the relay (no echo loop).
    const freshEv = mock.sent.slice(sentBefore).filter((f) => f.t === "ev" && f.line.includes("from afar"));
    expect(freshEv).toHaveLength(0);
  });

  it("reflects live and conflict frames in status", async () => {
    const statuses: SyncStatus[] = [];
    const mock = mockTransport();
    const store = createSyncedStore(createMemoryEventStore(), mock.transport, {
      onStatus: (s) => statuses.push(s),
    });
    store.syncRoot("r1");
    mock.inject({ t: "live", root: "r1", seq: 5 });
    mock.inject({ t: "err", root: "r1", reason: "same-id-conflict", detail: "dup-id" });
    // Frames apply in a serialized chain (unions are awaited in arrival
    // order), so settle before reading status.
    await new Promise((r) => setTimeout(r, 10));

    const status = store.status();
    expect(status.liveRoots).toContain("r1");
    expect(status.conflicts).toContain("dup-id");
    expect(statuses.length).toBeGreaterThanOrEqual(2);
  });

  it("re-pushes local backlog and re-subscribes on reconnect", async () => {
    const mock = mockTransport("online");
    const store = createSyncedStore(createMemoryEventStore(), mock.transport);
    await store.append(body("root", [], "made offline-ish"));
    const before = mock.sent.length;

    mock.setState("offline");
    mock.setState("online");
    mock.open(); // transport re-announces
    await new Promise((r) => setTimeout(r, 10));

    const after = mock.sent.slice(before);
    expect(after.some((f) => f.t === "sub" && f.root === "root")).toBe(true);
    expect(after.some((f) => f.t === "ev")).toBe(true); // backlog re-pushed
  });
});

/**
 * An EventStore decorator whose union can be made to fail on command — the
 * shape of a full disk or a dead IndexedDB. Records call/finish order so
 * ordering tests can prove unions are serialized.
 */
function breakableStore(inner: EventStore) {
  let broken = false;
  let delayNextMs = 0;
  const unionLog: string[] = [];
  const store: EventStore = {
    append: (ev) => inner.append(ev),
    union: async (line: string): Promise<AppendResult> => {
      unionLog.push(`start:${JSON.parse(line).id}`);
      const delay = delayNextMs;
      delayNextMs = 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (broken) {
        unionLog.push(`fail:${JSON.parse(line).id}`);
        throw new Error("injected store-write failure");
      }
      const result = await inner.union(line);
      unionLog.push(`done:${JSON.parse(line).id}`);
      return result;
    },
    byId: (id) => inner.byId(id),
    byRoot: (rootId) => inner.byRoot(rootId),
    subscribe: (rootId, listener) => inner.subscribe(rootId, listener),
    roots: (kind) => inner.roots(kind),
  };
  return {
    store,
    unionLog,
    setBroken: (b: boolean) => (broken = b),
    delayNext: (ms: number) => (delayNextMs = ms),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

describe("awaited union (dee-s6dc): the receive cursor advances only on inspected success", () => {
  const line = (id: string, parents: string[], text: string) => serializeLyncEvent(body(id, parents, text));

  it("a failed union on frame k freezes the cursor at k-1, surfaces the failure, and the event applies after heal + resubscribe", async () => {
    const statuses: SyncStatus[] = [];
    const mock = mockTransport();
    const flaky = breakableStore(createMemoryEventStore());
    const store = createSyncedStore(flaky.store, mock.transport, { onStatus: (s) => statuses.push(s) });
    store.syncRoot("r1");
    await settle();

    // Frame 1 lands; the store then breaks; frame 2 (seq k=2) fails; frame 3
    // still applies (arrival order is preserved past the failure).
    mock.inject({ t: "ev", root: "r1", seq: 1, line: line("r1", [], "one") });
    await settle();
    flaky.setBroken(true);
    mock.inject({ t: "ev", root: "r1", seq: 2, line: line("lost", ["r1"], "two, refused by disk") });
    await settle();
    flaky.setBroken(false);
    mock.inject({ t: "ev", root: "r1", seq: 3, line: line("later", ["r1"], "three") });
    mock.inject({ t: "live", root: "r1", seq: 3 });
    await settle();

    // The failure screamed through onStatus and status().
    expect(store.status().failures.some((f) => f.includes("injected store-write failure"))).toBe(true);
    expect(statuses.some((s) => s.failures.some((f) => f.includes("injected store-write failure")))).toBe(true);
    // The failed line is NOT in the store; the later one is (order held).
    expect(await store.byId("lost")).toBeNull();
    expect(await store.byId("later")).not.toBeNull();

    // The cursor stayed at k-1 = 1: the resubscribe after reconnect asks the
    // relay for everything from there — the lost line gets re-fetched.
    mock.setState("offline");
    mock.setState("online");
    mock.open();
    await settle();
    const resub = mock.sent.filter((f) => f.t === "sub" && f.root === "r1").at(-1)!;
    expect(resub).toMatchObject({ t: "sub", since: 1 });

    // The store has healed; the relay replays from the cursor; all applies.
    mock.inject({ t: "ev", root: "r1", seq: 2, line: line("lost", ["r1"], "two, refused by disk") });
    mock.inject({ t: "ev", root: "r1", seq: 3, line: line("later", ["r1"], "three") });
    mock.inject({ t: "live", root: "r1", seq: 3 });
    await settle();
    expect(await store.byId("lost")).not.toBeNull();

    // And the cursor thawed: the next resubscribe resumes past the hole.
    mock.setState("offline");
    mock.setState("online");
    mock.open();
    await settle();
    const finalSub = mock.sent.filter((f) => f.t === "sub" && f.root === "r1").at(-1)!;
    expect(finalSub).toMatchObject({ t: "sub", since: 3 });
  });

  it("a live frame cannot leapfrog a failed union: the frozen cursor wins over live's seq", async () => {
    const mock = mockTransport();
    const flaky = breakableStore(createMemoryEventStore());
    const store = createSyncedStore(flaky.store, mock.transport, {});
    store.syncRoot("r1");
    await settle();

    flaky.setBroken(true);
    mock.inject({ t: "ev", root: "r1", seq: 1, line: line("r1", [], "refused") });
    mock.inject({ t: "live", root: "r1", seq: 5 }); // relay is far ahead
    await settle();
    flaky.setBroken(false);

    mock.setState("offline");
    mock.setState("online");
    mock.open();
    await settle();
    const resub = mock.sent.filter((f) => f.t === "sub" && f.root === "r1").at(-1)!;
    expect(resub).toMatchObject({ t: "sub", since: 0 }); // NOT 5
  });

  it("unions apply strictly in arrival order — a slow union never lets a later frame pass it", async () => {
    const mock = mockTransport();
    const flaky = breakableStore(createMemoryEventStore());
    const store = createSyncedStore(flaky.store, mock.transport, {});
    store.syncRoot("r1");
    await settle();

    flaky.delayNext(60); // frame 1's union is slow
    mock.inject({ t: "ev", root: "r1", seq: 1, line: line("r1", [], "slow") });
    mock.inject({ t: "ev", root: "r1", seq: 2, line: line("fast", ["r1"], "fast") });
    await new Promise((r) => setTimeout(r, 150));

    expect(await store.byId("fast")).not.toBeNull();
    // The second union START comes after the first union DONE: serialized.
    const relevant = flaky.unionLog.filter((entry) => entry.endsWith(":r1") || entry.endsWith(":fast"));
    expect(relevant).toEqual(["start:r1", "done:r1", "start:fast", "done:fast"]);
  });

  it("garbage from the relay is surfaced, never silently skipped — and never wedges the cursor", async () => {
    const statuses: SyncStatus[] = [];
    const mock = mockTransport();
    const store = createSyncedStore(createMemoryEventStore(), mock.transport, { onStatus: (s) => statuses.push(s) });
    store.syncRoot("r1");
    await settle();

    mock.inject({ t: "ev", root: "r1", seq: 1, line: '{"id":"junk","not":"a lync event"}' });
    mock.inject({ t: "ev", root: "r1", seq: 2, line: line("r1", [], "real") });
    mock.inject({ t: "live", root: "r1", seq: 2 });
    await settle();

    expect(store.status().failures.some((f) => f.includes("garbage"))).toBe(true);
    expect(await store.byId("r1")).not.toBeNull();
    // Unusable bytes stay unusable on any re-fetch: the cursor moves past them.
    mock.setState("offline");
    mock.setState("online");
    mock.open();
    await settle();
    const resub = mock.sent.filter((f) => f.t === "sub" && f.root === "r1").at(-1)!;
    expect(resub).toMatchObject({ t: "sub", since: 2 });
  });
});

describe("generation change in the synced store (dee-u6tq)", () => {
  const line = (id: string, parents: string[], text: string) => serializeLyncEvent(body(id, parents, text));

  it("resets the cursor to 0 and resubscribes when the server's generation changes", async () => {
    const statuses: SyncStatus[] = [];
    const mock = mockTransport();
    const store = createSyncedStore(createMemoryEventStore(), mock.transport, { onStatus: (s) => statuses.push(s) });
    store.syncRoot("r1");
    await settle();

    // Generation g1: three events, cursor 3.
    mock.inject({ t: "ev", root: "r1", seq: 1, line: line("r1", [], "one"), gen: "g1" });
    mock.inject({ t: "ev", root: "r1", seq: 2, line: line("two", ["r1"], "two"), gen: "g1" });
    mock.inject({ t: "ev", root: "r1", seq: 3, line: line("three", ["r1"], "three"), gen: "g1" });
    mock.inject({ t: "live", root: "r1", seq: 3, gen: "g1" });
    await settle();

    // The server restarted (lost the unpersisted third event): new generation,
    // and its live sits BEHIND our cursor. Pre-fix we would idle forever and
    // silently skip the next persisted event.
    const before = mock.sent.length;
    mock.inject({ t: "live", root: "r1", seq: 2, gen: "g2" });
    await settle();

    const resub = mock.sent.slice(before).filter((f) => f.t === "sub" && f.root === "r1");
    expect(resub).toEqual([{ t: "sub", root: "r1", since: 0 }]);
    // The reset is surfaced, not silent.
    expect(store.status().failures.some((f) => f.includes("generation changed"))).toBe(true);

    // The new generation's backlog replays; a NEW event (seq 3 in g2) lands.
    mock.inject({ t: "ev", root: "r1", seq: 1, line: line("r1", [], "one"), gen: "g2" });
    mock.inject({ t: "ev", root: "r1", seq: 2, line: line("two", ["r1"], "two"), gen: "g2" });
    mock.inject({ t: "ev", root: "r1", seq: 3, line: line("fresh", ["r1"], "post-restart"), gen: "g2" });
    mock.inject({ t: "live", root: "r1", seq: 3, gen: "g2" });
    await settle();
    expect(await store.byId("fresh")).not.toBeNull();

    // Cursor now belongs to g2: next resubscribe resumes from 3.
    mock.setState("offline");
    mock.setState("online");
    mock.open();
    await settle();
    const finalSub = mock.sent.filter((f) => f.t === "sub" && f.root === "r1").at(-1)!;
    expect(finalSub).toMatchObject({ t: "sub", since: 3 });
  });

  it("frames without gen (old server) never trigger a reset", async () => {
    const mock = mockTransport();
    const store = createSyncedStore(createMemoryEventStore(), mock.transport, {});
    store.syncRoot("r1");
    await settle();
    mock.inject({ t: "ev", root: "r1", seq: 1, line: line("r1", [], "one") });
    mock.inject({ t: "live", root: "r1", seq: 1 });
    await settle();
    expect(mock.sent.filter((f) => f.t === "sub" && f.since === 0)).toHaveLength(1); // only the original
    expect(store.status().failures).toEqual([]);
  });
});

