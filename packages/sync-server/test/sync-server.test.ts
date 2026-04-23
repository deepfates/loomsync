import { describe, expect, it } from "vitest";
import { createLoomSyncServer } from "../src/index.js";

describe("loom sync server", () => {
  it("starts a WebSocket-backed Automerge repo and closes cleanly", async () => {
    const server = createLoomSyncServer();

    expect(server.url.startsWith("ws://")).toBe(true);
    expect(server.repo.peerId).toBeTruthy();

    await server.close();
  });
});
