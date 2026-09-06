import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLyncLooms } from "../src/looms.js";
import { createFileEventStore } from "../src/file-log.js";
import { createIndexedDbEventStore } from "../src/idb-log.js";
import { createMemoryEventStore } from "../src/memory-log.js";
import { BaseEventStore, serializeLyncEvent, type EventStore } from "../src/store.js";
import type { LyncEventBody } from "../src/events.js";
import { sha256Hex } from "../src/sha256.js";

type Payload = { text: string };
type LoomMeta = { title: string };

describe("lync storage backends", () => {
  it("round-trips byte-identical events through the memory store", async () => {
    await assertRoundTrip(createMemoryEventStore());
  });

  it("round-trips byte-identical events through the file store", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lync-file-"));
    const written = await assertRoundTrip(createFileEventStore(dir));
    expect(await createFileEventStore(dir).exportRootBytes?.(written.rootId)).toEqual(written.bytes);
  });

  it("loads only .lync event files and ignores other extensions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lync-mixed-"));
    await fs.writeFile(
      path.join(dir, "new.lync"),
      '{"v":1,"id":"new-root","kind":"lync/artifact","at":"2026-07-06T04:10:00Z","author":{"actor":"tester"},"parents":[],"payload":{"text":"new extension"}}\n',
    );
    await fs.writeFile(
      path.join(dir, "other.txt"),
      '{"v":1,"id":"other-root","kind":"lync/artifact","at":"2026-07-06T04:10:00Z","author":{"actor":"tester"},"parents":[],"payload":{"text":"not an event file"}}\n',
    );

    const store = createFileEventStore(dir);
    await expect(store.byId("new-root")).resolves.toMatchObject({ body: { id: "new-root" } });
    await expect(store.byId("other-root")).resolves.toBeNull();
    await expect(store.diagnostics()).resolves.toMatchObject({ events: 1 });
  });

  it("reconciles newer canonical lines instead of letting a valid legacy snapshot shadow them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lync-reconcile-"));
    const root = storageEvent("canonical-root");
    const child = storageEvent("canonical-child", [root.id]);
    const grandchild = storageEvent("canonical-grandchild", [child.id]);
    const rootLine = serializeLyncEvent(root);
    const childLine = serializeLyncEvent(child);
    const canonicalFile = path.join(dir, `${encodeURIComponent(root.id)}.lync`);
    await fs.writeFile(canonicalFile, `${rootLine}\n${childLine}\n`);
    await fs.writeFile(
      path.join(dir, "events.json"),
      JSON.stringify({
        events: [{ id: root.id, root: "forged-root", kind: root.kind, at: root.at, bytes: rootLine }],
        conflicts: [],
        pending: [],
        garbage: [],
      }),
    );

    const reopened = createFileEventStore(dir);
    await expect(reopened.byId(child.id)).resolves.toMatchObject({ body: { id: child.id } });
    await expect(reopened.union(serializeLyncEvent(grandchild))).resolves.toMatchObject({ status: "added" });
    expect(await fs.readFile(canonicalFile, "utf8")).toBe(
      `${rootLine}\n${childLine}\n${serializeLyncEvent(grandchild)}\n`,
    );
  });

  it("recovers either side of a snapshot/canonical persistence interruption", async () => {
    const snapshotOnlyDir = await fs.mkdtemp(path.join(os.tmpdir(), "lync-snapshot-only-"));
    const root = storageEvent("snapshot-root");
    const rootLine = serializeLyncEvent(root);
    await fs.writeFile(
      path.join(snapshotOnlyDir, "events.json"),
      JSON.stringify({
        events: [{ id: root.id, root: "forged-root", kind: root.kind, at: root.at, bytes: rootLine }],
        conflicts: [],
        pending: [],
        garbage: [],
      }),
    );
    const fromSnapshot = createFileEventStore(snapshotOnlyDir);
    await expect(fromSnapshot.byId(root.id)).resolves.toMatchObject({ body: { id: root.id } });
    await expect(
      fs.readFile(path.join(snapshotOnlyDir, `${encodeURIComponent(root.id)}.lync`), "utf8"),
    ).resolves.toBe(`${rootLine}\n`);
    await expect(fs.stat(path.join(snapshotOnlyDir, "forged-root.lync"))).rejects.toMatchObject({ code: "ENOENT" });

    const canonicalOnlyDir = await fs.mkdtemp(path.join(os.tmpdir(), "lync-canonical-only-"));
    await fs.writeFile(path.join(canonicalOnlyDir, `${encodeURIComponent(root.id)}.lync`), `${rootLine}\n`);
    await fs.writeFile(path.join(canonicalOnlyDir, "events.json"), '{"events":');
    const fromCanonical = createFileEventStore(canonicalOnlyDir);
    await expect(fromCanonical.byId(root.id)).resolves.toMatchObject({ body: { id: root.id } });
    expect((await fs.readdir(canonicalOnlyDir)).some((file) => file.startsWith("events.invalid-"))).toBe(true);
  });

  it("rebuilds conflicts, pending lines, and garbage without an events snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lync-rebuild-"));
    const store = createFileEventStore(dir);
    const root = storageEvent("rebuild-root");
    const child = { ...storageEvent("rebuild-child", [root.id]), payload: { version: 1 } };
    const variant = { ...child, payload: { version: 2 } };
    const pending = storageEvent("waiting-child", ["missing-parent"]);
    const childLine = serializeLyncEvent(child);
    const variantLine = serializeLyncEvent(variant);
    await store.append(root);
    await store.append(child);
    await expect(store.union(variantLine)).resolves.toMatchObject({ status: "conflict" });
    await expect(store.union(serializeLyncEvent(pending))).resolves.toMatchObject({ status: "buffered" });
    await expect(store.union("not json")).resolves.toMatchObject({ status: "garbage" });

    const canonical = await fs.readFile(path.join(dir, `${encodeURIComponent(root.id)}.lync`), "utf8");
    const conflicts = await fs.readFile(path.join(dir, `${encodeURIComponent(root.id)}.conflicts`), "utf8");
    expect(canonical).toContain(`${childLine}\n`);
    expect(conflicts).toContain(`${childLine}\n`);
    expect(conflicts).toContain(`${variantLine}\n`);
    await expect(fs.stat(path.join(dir, "events.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const reopened = createFileEventStore(dir);
    await expect(reopened.diagnostics()).resolves.toMatchObject({
      events: 2,
      conflicts: 2,
      pending: 1,
      garbage: 1,
      pendingPersistence: false,
    });
  });

  it("seals a truncated canonical tail before a later append", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lync-tail-"));
    const root = storageEvent("tail-root");
    const child = storageEvent("tail-child", [root.id]);
    const canonicalFile = path.join(dir, `${encodeURIComponent(root.id)}.lync`);
    await fs.writeFile(canonicalFile, `${serializeLyncEvent(root)}\n{\"v\":1`);

    const reopened = createFileEventStore(dir);
    await expect(reopened.diagnostics()).resolves.toMatchObject({ events: 1, garbage: 1 });
    await reopened.append(child);
    expect(await fs.readFile(canonicalFile, "utf8")).toBe(
      `${serializeLyncEvent(root)}\n{\"v\":1\n${serializeLyncEvent(child)}\n`,
    );
  });

  it("seals a partial failed append before retrying its full event", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lync-partial-append-"));
    const store = createFileEventStore(dir);
    await store.diagnostics();
    const root = storageEvent("partial-append-root");
    const line = serializeLyncEvent(root);
    const canonicalFile = path.join(dir, `${encodeURIComponent(root.id)}.lync`);
    const originalOpen = fs.open;
    let injected = false;
    fs.open = (async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (!injected && String(file).endsWith(".lync") && flags === "a") {
        injected = true;
        handle.writeFile = (async (data: string | Uint8Array) => {
          await handle.write(String(data).slice(0, 10));
          throw Object.assign(new Error("injected partial ENOSPC"), { code: "ENOSPC" });
        }) as typeof handle.writeFile;
      }
      return handle;
    }) as typeof fs.open;
    try {
      await expect(store.append(root)).rejects.toThrow("injected partial ENOSPC");
    } finally {
      fs.open = originalOpen;
    }

    expect(await fs.readFile(canonicalFile, "utf8")).toBe(line.slice(0, 10));
    await expect(store.append(root)).resolves.toMatchObject({ status: "duplicate" });
    await expect(store.diagnostics()).resolves.toMatchObject({ pendingPersistence: false });
    expect(await fs.readFile(canonicalFile, "utf8")).toBe(`${line.slice(0, 10)}\n${line}\n`);

    const reopened = createFileEventStore(dir);
    await expect(reopened.byId(root.id)).resolves.toMatchObject({ body: { id: root.id } });
    await expect(reopened.diagnostics()).resolves.toMatchObject({ events: 1, garbage: 1 });
  });

  it("safely replays a complete append whose sync failed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lync-failed-sync-"));
    const store = createFileEventStore(dir);
    await store.diagnostics();
    const root = storageEvent("failed-sync-root");
    const line = serializeLyncEvent(root);
    const canonicalFile = path.join(dir, `${encodeURIComponent(root.id)}.lync`);
    const originalOpen = fs.open;
    let injected = false;
    fs.open = (async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (!injected && String(file).endsWith(".lync") && flags === "a") {
        injected = true;
        handle.sync = async () => {
          throw Object.assign(new Error("injected sync ENOSPC"), { code: "ENOSPC" });
        };
      }
      return handle;
    }) as typeof fs.open;
    try {
      await expect(store.append(root)).rejects.toThrow("injected sync ENOSPC");
    } finally {
      fs.open = originalOpen;
    }

    expect(await fs.readFile(canonicalFile, "utf8")).toBe(`${line}\n`);
    await expect(store.append(root)).resolves.toMatchObject({ status: "duplicate" });
    await expect(store.diagnostics()).resolves.toMatchObject({ pendingPersistence: false });
    expect(await fs.readFile(canonicalFile, "utf8")).toBe(`${line}\n${line}\n`);

    const reopened = createFileEventStore(dir);
    await expect(reopened.byId(root.id)).resolves.toMatchObject({ body: { id: root.id } });
    await expect(reopened.diagnostics()).resolves.toMatchObject({ events: 1, garbage: 0 });
  });

  it("accepts but permanently surfaces a complete final event that lacked LF", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lync-no-lf-"));
    const root = storageEvent("no-lf-root");
    const line = serializeLyncEvent(root);
    const canonicalFile = path.join(dir, `${encodeURIComponent(root.id)}.lync`);
    await fs.writeFile(canonicalFile, line);

    const recovered = createFileEventStore(dir);
    await expect(recovered.byId(root.id)).resolves.toMatchObject({ body: { id: root.id } });
    await expect(recovered.diagnostics()).resolves.toMatchObject({ events: 1, garbage: 1 });
    expect(await fs.readFile(canonicalFile, "utf8")).toBe(`${line}\n`);

    const reopened = createFileEventStore(dir);
    await expect(reopened.diagnostics()).resolves.toMatchObject({ events: 1, garbage: 1 });
  });

  it("appends a richer exact-body sighting without overwriting its earlier physical line", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lync-richer-"));
    const root = storageEvent("richer-root");
    const plain = serializeLyncEvent(root);
    const digest = sha256Hex(new TextEncoder().encode(plain));
    const richer = plain.replace(/}$/, `,"digest":"sha256:${digest}"}`);
    const store = createFileEventStore(dir);
    await store.union(plain);
    await expect(store.union(richer)).resolves.toMatchObject({ status: "duplicate" });

    const canonicalFile = path.join(dir, `${encodeURIComponent(root.id)}.lync`);
    expect(await fs.readFile(canonicalFile, "utf8")).toBe(`${plain}\n${richer}\n`);
    const reopened = createFileEventStore(dir);
    await expect(reopened.exportRootBytes(root.id)).resolves.toBe(`${richer}\n`);
  });

  it("round-trips byte-identical events through the IndexedDB-shaped store", async () => {
    const indexedDB = createFakeIndexedDB();
    const written = await assertRoundTrip(createIndexedDbEventStore({ dbName: "test", indexedDB }));
    expect(await createIndexedDbEventStore({ dbName: "test", indexedDB }).exportRootBytes?.(written.rootId)).toEqual(written.bytes);
  });

  it("persists sequential IndexedDB events incrementally", async () => {
    const metrics: FakeMetrics = { puts: 0, clears: 0, deletes: 0, activePuts: 0, maxActivePuts: 0 };
    const store = createIndexedDbEventStore({
      dbName: "incremental",
      indexedDB: createFakeIndexedDB(metrics),
    });
    let nextId = 0;
    const looms = createLyncLooms<Payload, LoomMeta>({
      store,
      author: { actor: "tester" },
      createId: () => `incremental-${++nextId}`,
      now: () => 1000 + nextId,
    });
    const info = await looms.create({ title: "Incremental" });
    const loom = await looms.open(info.id);
    let parent: string | null = null;
    for (let index = 0; index < 50; index += 1) {
      parent = (await loom.appendTurn(parent, { text: String(index) })).id;
    }

    expect(metrics).toEqual({ puts: 51, clears: 0, deletes: 0, activePuts: 0, maxActivePuts: 1 });
  });

  it("persists an imported loom snapshot in one batch", async () => {
    class CountingStore extends BaseEventStore {
      flushes = 0;

      protected override async persist() {
        this.flushes += 1;
      }
    }

    const store = new CountingStore();
    let nextId = 0;
    const looms = createLyncLooms<Payload, LoomMeta>({
      store,
      author: { actor: "tester" },
      createId: () => `batch-${++nextId}`,
      now: () => 1000,
    });
    await looms.import({
      loom: { id: "source", meta: { title: "Batch" }, createdAt: 1000 },
      turns: Array.from({ length: 100 }, (_, index) => ({
        id: `source-${index}`,
        loomId: "source",
        parentId: index === 0 ? null : `source-${index - 1}`,
        payload: { text: String(index) },
        createdAt: 1001 + index,
      })),
    });

    expect(store.flushes).toBe(1);
    await expect(store.diagnostics()).resolves.toMatchObject({ events: 101 });
  });

  it("retries a dirty added event before treating identical bytes as a duplicate", async () => {
    const store = new FailOnceStore();
    const emitted: string[] = [];
    store.subscribe("retry-root", (event) => emitted.push(event.body.id));
    const event = storageEvent("retry-root");

    await expect(store.union(serializeLyncEvent(event))).rejects.toThrow("injected persist failure");
    await expect(store.diagnostics()).resolves.toMatchObject({
      events: 1,
      pendingPersistence: true,
    });
    expect(store.durableIds).toEqual([]);
    expect(emitted).toEqual([]);

    await expect(store.union(serializeLyncEvent(event))).resolves.toMatchObject({ status: "duplicate" });
    await expect(store.diagnostics()).resolves.toMatchObject({ pendingPersistence: false });
    expect(store.persistAttempts).toBe(2);
    expect(store.durableIds).toEqual(["retry-root"]);
    expect(emitted).toEqual(["retry-root"]);
  });

  it("retains dirty batch state after a failed flush", async () => {
    const store = new FailOnceStore();
    const event = storageEvent("batch-retry-root");

    await expect(store.appendMany([event])).rejects.toThrow("injected persist failure");
    await expect(store.diagnostics()).resolves.toMatchObject({ pendingPersistence: true });
    expect(store.durableIds).toEqual([]);

    await expect(store.appendMany([event])).resolves.toMatchObject([{ status: "duplicate" }]);
    await expect(store.diagnostics()).resolves.toMatchObject({ pendingPersistence: false });
    expect(store.persistAttempts).toBe(2);
    expect(store.durableIds).toEqual(["batch-retry-root"]);
  });

  it("keeps sequential Loom append derivation bounded while notifying exactly once", async () => {
    const store = new CountingRootStore();
    let nextId = 0;
    const looms = createLyncLooms<{ text: string }, LoomMeta>({
      store,
      author: { actor: "fold-test" },
      createId: () => `fold-${++nextId}`,
      now: () => 1000 + nextId,
    });
    const info = await looms.create({ title: "Long" });
    const loom = await looms.open(info.id);
    const notified: string[] = [];
    loom.subscribe((event) => {
      if (event.type === "turn-added") notified.push(event.turn.id);
    });

    let parent: string | null = null;
    for (let index = 0; index < 200; index += 1) {
      parent = (await loom.appendTurn(parent, { text: `${index}:${"x".repeat(4096)}` })).id;
    }
    expect(store.byRootReads).toBe(1);
    expect(notified).toHaveLength(200);
    await expect(loom.threadTo(parent!)).resolves.toHaveLength(200);
    expect(store.byRootReads).toBe(1);
  });

  it("invalidates the incremental Loom fold when an unseen conflict changes a root", async () => {
    const store = new CountingRootStore();
    let nextId = 0;
    const looms = createLyncLooms<{ text: string }, LoomMeta>({
      store,
      author: { actor: "conflict-test" },
      createId: () => `conflict-${++nextId}`,
      now: () => 1000 + nextId,
    });
    const info = await looms.create({ title: "Conflict" });
    const loom = await looms.open(info.id);
    const turn = await loom.appendTurn(null, { text: "first" });
    expect(store.byRootReads).toBe(1);

    const lines = (await store.exportRootBytes(info.id.slice("lync:".length))).trimEnd().split("\n");
    const readsBeforeConflict = store.byRootReads;
    const original = JSON.parse(lines.find((line) => JSON.parse(line).id === turn.id)!);
    original.payload.payload = { text: "variant" };
    await expect(store.union(serializeLyncEvent(original))).resolves.toMatchObject({ status: "conflict" });
    await expect(loom.getTurn(turn.id)).resolves.toBeNull();
    expect(store.byRootReads).toBe(readsBeforeConflict + 1);
  });
});

class FailOnceStore extends BaseEventStore {
  persistAttempts = 0;
  durableIds: string[] = [];

  protected override async persist() {
    this.persistAttempts += 1;
    if (this.persistAttempts === 1) throw new Error("injected persist failure");
    this.durableIds = this.dumpRecords().events.map((record) => record.id).sort();
  }
}

class CountingRootStore extends BaseEventStore {
  byRootReads = 0;

  override async byRoot(rootId: string) {
    this.byRootReads += 1;
    return super.byRoot(rootId);
  }
}

function storageEvent(id: string, parents: string[] = []): LyncEventBody {
  return {
    v: 1,
    id,
    kind: "storage/probe",
    at: "2026-07-31T00:00:00.000Z",
    author: { actor: "storage-test" },
    parents,
    payload: {},
  };
}

async function assertRoundTrip(store: EventStore) {
  let nextId = 0;
  let nextTime = 1000;
  const looms = createLyncLooms<Payload, LoomMeta>({
    store,
    author: { actor: "tester" },
    createId: () => `event-${++nextId}`,
    now: () => nextTime++,
  });
  const info = await looms.create({ title: "Story" });
  const loom = await looms.open(info.id);
  const first = await loom.appendTurn(null, { text: "A" });
  await loom.appendTurn(first.id, { text: "B" });
  const before = await store.exportRootBytes?.(info.id.slice("lync:".length));

  const clone = createMemoryEventStore();
  for (const line of (before ?? "").trimEnd().split("\n")) {
    if (line) await clone.union(line);
  }
  const after = await clone.exportRootBytes?.(info.id.slice("lync:".length));
  expect(after).toEqual(before);

  const reopened = await looms.open(info.id);
  expect(await reopened.export()).toEqual(await loom.export());
  return { rootId: info.id.slice("lync:".length), bytes: before };
}

interface FakeMetrics {
  puts: number;
  clears: number;
  deletes: number;
  activePuts: number;
  maxActivePuts: number;
}

function createFakeIndexedDB(
  metrics: FakeMetrics = { puts: 0, clears: 0, deletes: 0, activePuts: 0, maxActivePuts: 0 },
): IDBFactory {
  const dbs = new Map<string, FakeDatabaseData>();
  return {
    open(name: string) {
      const request = new FakeOpenRequest();
      queueMicrotask(() => {
        let data = dbs.get(name);
        const firstOpen = !data;
        if (!data) {
          data = { stores: new Map(), metrics };
          dbs.set(name, data);
        }
        request.result = new FakeDatabase(data) as unknown as IDBDatabase;
        if (firstOpen) request.onupgradeneeded?.({} as IDBVersionChangeEvent);
        request.onsuccess?.({} as Event);
      });
      return request as unknown as IDBOpenDBRequest;
    },
  } as IDBFactory;
}

interface FakeDatabaseData {
  stores: Map<string, Map<string, unknown>>;
  metrics: FakeMetrics;
}

class FakeOpenRequest {
  result!: IDBDatabase;
  error: DOMException | null = null;
  onsuccess: ((this: IDBRequest, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBRequest, ev: Event) => unknown) | null = null;
  onupgradeneeded: ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown) | null = null;
}

class FakeRequest<T = unknown> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((this: IDBRequest, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBRequest, ev: Event) => unknown) | null = null;
}

class FakeDatabase {
  constructor(private readonly data: FakeDatabaseData) {}

  get objectStoreNames() {
    return { contains: (name: string) => this.data.stores.has(name) };
  }

  createObjectStore(name: string) {
    this.data.stores.set(name, new Map());
    return new FakeObjectStore(this.data.stores.get(name)!, this.data.metrics);
  }

  transaction(storeNames: string[]) {
    return new FakeTransaction(this.data, storeNames);
  }

  close() {}
}

class FakeTransaction {
  oncomplete: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onabort: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  error: DOMException | null = null;

  constructor(
    private readonly data: FakeDatabaseData,
    private readonly storeNames: string[],
  ) {
    void this.storeNames;
    queueMicrotask(() => this.oncomplete?.({} as Event));
  }

  objectStore(name: string) {
    const store = this.data.stores.get(name);
    if (!store) throw new Error(`Missing fake store: ${name}`);
    return new FakeObjectStore(store, this.data.metrics) as unknown as IDBObjectStore;
  }
}

class FakeObjectStore {
  constructor(
    private readonly records: Map<string, unknown>,
    private readonly metrics: FakeMetrics,
  ) {}

  createIndex() {
    return {};
  }

  getAll() {
    const request = new FakeRequest<unknown[]>();
    queueMicrotask(() => {
      request.result = [...this.records.values()];
      request.onsuccess?.({} as Event);
    });
    return request as unknown as IDBRequest;
  }

  clear() {
    const request = new FakeRequest();
    queueMicrotask(() => {
      this.metrics.clears += 1;
      this.records.clear();
      request.onsuccess?.({} as Event);
    });
    return request as unknown as IDBRequest;
  }

  put(record: { id?: string; key?: string[] }) {
    const request = new FakeRequest();
    this.metrics.activePuts += 1;
    this.metrics.maxActivePuts = Math.max(this.metrics.maxActivePuts, this.metrics.activePuts);
    queueMicrotask(() => {
      this.metrics.puts += 1;
      this.metrics.activePuts -= 1;
      this.records.set(record.id ?? JSON.stringify(record.key), record);
      request.onsuccess?.({} as Event);
    });
    return request as unknown as IDBRequest;
  }

  delete(key: string | string[]) {
    const request = new FakeRequest();
    queueMicrotask(() => {
      this.metrics.deletes += 1;
      this.records.delete(typeof key === "string" ? key : JSON.stringify(key));
      request.onsuccess?.({} as Event);
    });
    return request as unknown as IDBRequest;
  }
}
