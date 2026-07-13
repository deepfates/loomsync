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
import { serializeLyncEvent } from "@deepfates/lync/store";

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
