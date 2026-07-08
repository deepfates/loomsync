import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLoreLooms } from "../src/lore/looms.js";
import { createFileEventStore } from "../src/lore/file-log.js";
import { createIndexedDbEventStore } from "../src/lore/idb-log.js";
import { createMemoryEventStore } from "../src/lore/memory-log.js";
import type { EventStore } from "../src/lore/store.js";

type Payload = { text: string };
type LoomMeta = { title: string };

describe("lore storage backends", () => {
  it("round-trips byte-identical events through the memory store", async () => {
    await assertRoundTrip(createMemoryEventStore());
  });

  it("round-trips byte-identical events through the file store", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lync-lore-file-"));
    const written = await assertRoundTrip(createFileEventStore(dir));
    expect(await createFileEventStore(dir).exportRootBytes?.(written.rootId)).toEqual(written.bytes);
  });

  it("round-trips byte-identical events through the IndexedDB-shaped store", async () => {
    const indexedDB = createFakeIndexedDB();
    const written = await assertRoundTrip(createIndexedDbEventStore({ dbName: "test", indexedDB }));
    expect(await createIndexedDbEventStore({ dbName: "test", indexedDB }).exportRootBytes?.(written.rootId)).toEqual(written.bytes);
  });
});

async function assertRoundTrip(store: EventStore) {
  let nextId = 0;
  let nextTime = 1000;
  const looms = createLoreLooms<Payload, LoomMeta>({
    store,
    author: { actor: "tester" },
    createId: () => `event-${++nextId}`,
    now: () => nextTime++,
  });
  const info = await looms.create({ title: "Story" });
  const loom = await looms.open(info.id);
  const first = await loom.appendTurn(null, { text: "A" });
  await loom.appendTurn(first.id, { text: "B" });
  const before = await store.exportRootBytes?.(info.id.slice("lore:".length));

  const clone = createMemoryEventStore();
  for (const line of (before ?? "").trimEnd().split("\n")) {
    if (line) await clone.union(line);
  }
  const after = await clone.exportRootBytes?.(info.id.slice("lore:".length));
  expect(after).toEqual(before);

  const reopened = await looms.open(info.id);
  expect(await reopened.export()).toEqual(await loom.export());
  return { rootId: info.id.slice("lore:".length), bytes: before };
}

function createFakeIndexedDB(): IDBFactory {
  const dbs = new Map<string, FakeDatabaseData>();
  return {
    open(name: string) {
      const request = new FakeOpenRequest();
      queueMicrotask(() => {
        let data = dbs.get(name);
        const firstOpen = !data;
        if (!data) {
          data = { stores: new Map() };
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
    return new FakeObjectStore(this.data.stores.get(name)!);
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
    return new FakeObjectStore(store) as unknown as IDBObjectStore;
  }
}

class FakeObjectStore {
  constructor(private readonly records: Map<string, unknown>) {}

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
      this.records.clear();
      request.onsuccess?.({} as Event);
    });
    return request as unknown as IDBRequest;
  }

  put(record: { id?: string; key?: string[] }) {
    const request = new FakeRequest();
    queueMicrotask(() => {
      this.records.set(record.id ?? JSON.stringify(record.key), record);
      request.onsuccess?.({} as Event);
    });
    return request as unknown as IDBRequest;
  }
}
