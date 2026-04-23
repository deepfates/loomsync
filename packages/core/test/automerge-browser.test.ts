import { describe, expect, it } from "vitest";
import { createBrowserAutomergeRepoConfig } from "../src/index.js";

class FakeStorage {
  constructor(
    readonly database?: string,
    readonly store?: string,
  ) {}
}

class FakeBroadcast {
  constructor(readonly options?: { channelName: string; peerWaitMs?: number }) {}
}

class FakeWebSocket {
  constructor(
    readonly url: string,
    readonly retryInterval?: number,
  ) {}
}

describe("browser Automerge repo factory", () => {
  it("assembles IndexedDB, BroadcastChannel, and WebSocket adapters", async () => {
    const config = createBrowserAutomergeRepoConfig({
      indexedDb: { database: "loom-test", store: "docs" },
      broadcastChannel: { channelName: "loom-test-channel", peerWaitMs: 5 },
      websocket: { url: "wss://sync.example", retryInterval: 50 },
      adapters: {
        IndexedDBStorageAdapter: FakeStorage,
        BroadcastChannelNetworkAdapter: FakeBroadcast,
        WebSocketClientAdapter: FakeWebSocket,
      },
    });

    expect(config.storage).toBeInstanceOf(FakeStorage);
    expect((config.storage as FakeStorage).database).toBe("loom-test");
    expect(config.network).toHaveLength(2);
    expect(config.network[0]).toBeInstanceOf(FakeBroadcast);
    expect(config.network[1]).toBeInstanceOf(FakeWebSocket);
  });
});
