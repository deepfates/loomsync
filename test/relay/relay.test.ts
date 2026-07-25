import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryEventStore } from "@deepfates/lync/memory-log";
import { createLyncLooms, loomRootId } from "@deepfates/lync/looms";
import { createSyncedStore, createWebSocketTransport } from "@deepfates/lync/synced-store";
import { decodeFrame, encodeFrame, type SyncFrame } from "../../src/sync-protocol.js";
import { createLyncRelay, type LyncRelaySocket } from "../../src/relay/relay.js";

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

class TestSocket implements LyncRelaySocket {
  readyState = 1;
  readonly OPEN = 1;
  readonly sent: SyncFrame[] = [];
  private readonly messageListeners: Array<(data: { toString(): string }) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private readonly errorListeners: Array<(error: unknown) => void> = [];

  send(data: string): void {
    this.sent.push(decodeFrame(data));
  }

  ping(): void {}

  terminate(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    for (const listener of this.closeListeners) listener();
  }

  on(event: "message" | "close" | "error", listener: ((data: { toString(): string }) => void) | (() => void) | ((error: unknown) => void)): this {
    if (event === "message") this.messageListeners.push(listener as (data: { toString(): string }) => void);
    else if (event === "close") this.closeListeners.push(listener as () => void);
    else this.errorListeners.push(listener as (error: unknown) => void);
    return this;
  }

  receive(frame: SyncFrame): void {
    const raw = encodeFrame(frame);
    for (const listener of this.messageListeners) listener({ toString: () => raw });
  }
}

function artifactLine(id: string, text = id): string {
  return JSON.stringify({
    v: 1,
    id,
    kind: "lync/artifact",
    at: "2026-07-08T21:00:00Z",
    author: { actor: "x" },
    parents: [],
    payload: { text },
  });
}

function withDigest(body: string, sig?: string): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return `${body.slice(0, -1)},"digest":"sha256:${digest}"${sig ? `,"sig":"${sig}"` : ""}}`;
}

describe("createLyncRelay union and recovery invariants", () => {
  it("treats differing digest/signature metadata over identical body bytes as one event", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-relay-body-"));
    const relay = createLyncRelay({ dir, log: () => {} });
    const socket = new TestSocket();
    relay.handleConnection(socket);
    socket.receive({ t: "sub", root: "same-body", since: 0 });
    await waitFor(() => socket.sent.some((frame) => frame.t === "live"));

    const body = artifactLine("same", "same bytes");
    socket.receive({ t: "ev", root: "same-body", line: body });
    await waitFor(() => relay.status().find((room) => room.root === "same-body")?.seq === 1);
    socket.receive({ t: "ev", root: "same-body", line: withDigest(body, "QUJDRA==") });
    const tail = artifactLine("tail");
    socket.receive({ t: "ev", root: "same-body", line: tail });
    await waitFor(() => relay.status().find((room) => room.root === "same-body")?.seq === 2);

    expect(relay.status().find((room) => room.root === "same-body")?.seq).toBe(2);
    expect(socket.sent.filter((frame) => frame.t === "err" && frame.reason === "same-id-conflict")).toEqual([]);
    await expect(readFile(path.join(dir, "same-body.conflicts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(dir, "same-body.lync"), "utf8")).toBe(`${body}\n${tail}\n`);
    await relay.close();
  });

  it("replays persisted conflict variants to a client that arrives after restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-relay-conflict-replay-"));
    const first = artifactLine("duel", "first");
    const second = artifactLine("duel", "second");

    const relay1 = createLyncRelay({ dir, log: () => {} });
    const writer = new TestSocket();
    relay1.handleConnection(writer);
    writer.receive({ t: "sub", root: "duel", since: 0 });
    await waitFor(() => writer.sent.some((frame) => frame.t === "live"));
    writer.receive({ t: "ev", root: "duel", line: first });
    writer.receive({ t: "ev", root: "duel", line: second });
    await waitFor(() => writer.sent.some((frame) => frame.t === "err" && frame.reason === "same-id-conflict"));
    await relay1.close();

    const relay2 = createLyncRelay({ dir, log: () => {} });
    const reader = new TestSocket();
    relay2.handleConnection(reader);
    reader.receive({ t: "sub", root: "duel", since: 0 });
    await waitFor(() => reader.sent.some((frame) => frame.t === "live"));

    expect(reader.sent.filter((frame): frame is Extract<SyncFrame, { t: "ev" }> => frame.t === "ev").map((frame) => frame.line)).toEqual([
      first,
      second,
    ]);
    await relay2.close();
  });

  it("seals and reports a truncated conflict sidecar without replaying it as an event", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-relay-conflict-tail-"));
    const first = artifactLine("duel", "first");
    const truncated = artifactLine("duel", "truncated").slice(0, -1);
    await writeFile(path.join(dir, "duel.lync"), `${first}\n`);
    await writeFile(path.join(dir, "duel.conflicts"), truncated);

    const relay = createLyncRelay({ dir, log: () => {} });
    const reader = new TestSocket();
    relay.handleConnection(reader);
    reader.receive({ t: "sub", root: "duel", since: 0 });
    await waitFor(() => reader.sent.some((frame) => frame.t === "live"));

    expect(reader.sent.some((frame) => frame.t === "err" && frame.reason === "recovered-damaged-tail" && frame.detail?.includes("conflict sidecar"))).toBe(true);
    expect(reader.sent.filter((frame): frame is Extract<SyncFrame, { t: "ev" }> => frame.t === "ev").map((frame) => frame.line)).toEqual([first]);
    expect(await readFile(path.join(dir, "duel.conflicts"), "utf8")).toBe(`${truncated}\n`);
    await relay.close();
  });

  it("retries pending durable writes during close", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-relay-close-retry-"));
    const relay = createLyncRelay({ dir, log: () => {} });
    const socket = new TestSocket();
    relay.handleConnection(socket);
    socket.receive({ t: "sub", root: "closing", since: 0 });
    await waitFor(() => socket.sent.some((frame) => frame.t === "live"));

    await chmod(dir, 0o555);
    const line = artifactLine("pending");
    socket.receive({ t: "ev", root: "closing", line });
    await waitFor(() => relay.status().find((room) => room.root === "closing")?.pendingUnpersisted === 1);
    await chmod(dir, 0o755);

    await relay.close();
    expect(socket.readyState).not.toBe(socket.OPEN);
    expect(await readFile(path.join(dir, "closing.lync"), "utf8")).toBe(`${line}\n`);
  });

  it("rejects close when accepted lines still cannot be made durable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-relay-close-fail-"));
    const relay = createLyncRelay({ dir, log: () => {} });
    const socket = new TestSocket();
    relay.handleConnection(socket);
    socket.receive({ t: "sub", root: "closing", since: 0 });
    await waitFor(() => socket.sent.some((frame) => frame.t === "live"));

    await chmod(dir, 0o555);
    try {
      socket.receive({ t: "ev", root: "closing", line: artifactLine("pending") });
      await waitFor(() => relay.status().find((room) => room.root === "closing")?.pendingUnpersisted === 1);
      await expect(relay.close()).rejects.toThrow(/closing:pending/);
      expect(socket.readyState).not.toBe(socket.OPEN);
    } finally {
      await chmod(dir, 0o755);
    }
  });
});

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
    const { createWebSocketTransport } = await import("@deepfates/lync/synced-store");

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
      await chmod(dir, 0o755);
      await relay.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("createLyncRelay status() — read-only observability", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  // Boot a throwaway HTTP server around a relay; return its ws url. Teardown
  // (relay flush + server close) is registered so each test stays isolated.
  async function boot(relay: ReturnType<typeof createLyncRelay>): Promise<string> {
    const httpServer = createServer((_r, res) => res.writeHead(200).end());
    httpServer.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head));
    const port = await new Promise<number>((resolve) =>
      httpServer.listen(0, () => {
        const a = httpServer.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      }),
    );
    cleanups.push(async () => {
      await relay.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    return `ws://localhost:${port}`;
  }

  const line = (id: string) =>
    JSON.stringify({ v: 1, id, kind: "lync/artifact", at: "2026-07-08T21:00:00Z", author: { actor: "x" }, parents: [], payload: {} });

  it("reports each room's seq and live subscriber count accurately", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-status-"));
    const relay = createLyncRelay({ dir, log: () => {} });
    const url = await boot(relay);

    // Three sockets on "alpha", one on "beta".
    const subs = Array.from({ length: 4 }, () => createWebSocketTransport(url, { reconnectMs: 0 }));
    cleanups.push(() => {
      for (const t of subs) t.close();
    });
    subs[0].send({ t: "sub", root: "alpha", since: 0 });
    subs[1].send({ t: "sub", root: "alpha", since: 0 });
    subs[2].send({ t: "sub", root: "alpha", since: 0 });
    subs[3].send({ t: "sub", root: "beta", since: 0 });
    // Two accepted lines into alpha => seq 2; one into beta => seq 1.
    subs[0].send({ t: "ev", root: "alpha", line: line("a1") });
    subs[0].send({ t: "ev", root: "alpha", line: line("a2") });
    subs[3].send({ t: "ev", root: "beta", line: line("b1") });

    const byRoot = () => new Map(relay.status().map((r) => [r.root, r]));
    await waitFor(() => {
      const s = byRoot();
      return (
        s.get("alpha")?.seq === 2 &&
        s.get("alpha")?.subscribers === 3 &&
        s.get("beta")?.seq === 1 &&
        s.get("beta")?.subscribers === 1
      );
    });

    const s = byRoot();
    expect(s.get("alpha")).toMatchObject({ root: "alpha", seq: 2, subscribers: 3, pendingUnpersisted: 0 });
    expect(s.get("beta")).toMatchObject({ root: "beta", seq: 1, subscribers: 1, pendingUnpersisted: 0 });
    // generation is a stable non-empty id for a live room.
    expect(typeof s.get("alpha")?.generation).toBe("string");
    expect((s.get("alpha")?.generation ?? "").length).toBeGreaterThan(0);
  });

  it("shows durability lag, heals to 0 on the next flush, and mutates nothing when read", async () => {
    const { chmod } = await import("node:fs/promises");
    const dir = await mkdtemp(path.join(os.tmpdir(), "lync-status-lag-"));
    const relay = createLyncRelay({ dir, log: () => {} });
    const url = await boot(relay);
    cleanups.push(async () => void (await chmod(dir, 0o755).catch(() => {})));

    const t = createWebSocketTransport(url, { reconnectMs: 0 });
    cleanups.push(() => t.close());
    t.send({ t: "sub", root: "lag", since: 0 });
    await waitFor(() => relay.status().some((r) => r.root === "lag"));

    const of = (root: string) => relay.status().find((r) => r.root === root);

    // Freeze the disk so the next append cannot land — the line is accepted
    // into memory (seq consumed) but stays unpersisted.
    await chmod(dir, 0o555);
    t.send({ t: "ev", root: "lag", line: line("d1") });
    await waitFor(() => (of("lag")?.pendingUnpersisted ?? 0) >= 1);

    const stuck = of("lag")!;
    expect(stuck.pendingUnpersisted).toBe(1);
    expect(stuck.seq).toBe(1);

    // status() is strictly read-only: repeated calls change nothing.
    for (let i = 0; i < 5; i += 1) relay.status();
    const afterReads = of("lag")!;
    expect(afterReads.seq).toBe(1);
    expect(afterReads.pendingUnpersisted).toBe(1);
    expect(afterReads.subscribers).toBe(1);

    // Heal the disk, then trigger a flush with the next append — persistPending
    // drains the backlog in order before writing the new line.
    await chmod(dir, 0o755);
    t.send({ t: "ev", root: "lag", line: line("d2") });
    await waitFor(() => (of("lag")?.pendingUnpersisted ?? 1) === 0);

    const healed = of("lag")!;
    expect(healed.pendingUnpersisted).toBe(0);
    // The room still works: the second line was accepted, so seq advanced.
    expect(healed.seq).toBe(2);
  });
});
