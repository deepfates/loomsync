import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLyncLooms } from "../src/looms.js";
import { createFileEventStore } from "../src/file-log.js";
import { createIndexedDbEventStore } from "../src/idb-log.js";
import { createMemoryEventStore } from "../src/memory-log.js";
import { BaseEventStore, type EventStore } from "../src/store.js";

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
});

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
