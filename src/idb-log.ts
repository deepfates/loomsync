import { BaseEventStore, type ConflictRecord, type PendingRecord, type StoreRecord } from "./store.js";

export interface IndexedDbEventStoreOptions {
  dbName?: string;
  indexedDB?: IDBFactory;
}

const VERSION = 1;

/**
 * A conflict/pending record as it lives in IndexedDB: the in-memory record plus
 * the composite `[id, digest]` primary key the object store is keyed on. Events
 * are stored as-is (keyed on their own `id`), so they need no wrapper row type.
 */
type StoreKey = [string, string];
type ConflictRow = ConflictRecord & { key: StoreKey };
type PendingRow = PendingRecord & { key: StoreKey };

export class IndexedDbEventStore extends BaseEventStore {
  private readonly dbName: string;
  private readonly idb: IDBFactory;
  private readonly persistedEvents = new Map<string, string>();
  private readonly persistedConflicts = new Map<string, string>();
  private readonly persistedPending = new Map<string, string>();
  private ready: Promise<void>;

  constructor(options: IndexedDbEventStoreOptions = {}) {
    super();
    this.dbName = options.dbName ?? "lync";
    this.idb = options.indexedDB ?? indexedDB;
    this.ready = this.load();
  }

  override async append(ev: Parameters<BaseEventStore["append"]>[0]) {
    await this.ready;
    return super.append(ev);
  }

  override async appendMany(events: Parameters<BaseEventStore["appendMany"]>[0]) {
    await this.ready;
    return super.appendMany(events);
  }

  override async union(line: string) {
    await this.ready;
    return super.union(line);
  }

  override async byId(id: string) {
    await this.ready;
    return super.byId(id);
  }

  override async byRoot(rootId: string) {
    await this.ready;
    return super.byRoot(rootId);
  }

  override async roots(kind?: "lync/loom" | "lync/index") {
    await this.ready;
    return super.roots(kind);
  }

  override async exportRootBytes(rootId: string) {
    await this.ready;
    return super.exportRootBytes(rootId);
  }

  protected override async persist(): Promise<void> {
    const events = [...this.events.values()]
      .filter((event) => this.persistedEvents.get(event.body.id) !== event.bytes)
      .map((event): StoreRecord => ({
        id: event.body.id,
        root: event.root,
        kind: event.body.kind,
        at: event.body.at,
        bytes: event.bytes,
      }));
    const conflicts = [...this.conflicts.values()]
      .filter((record) => this.persistedConflicts.get(conflictStorageKey(record)) !== record.bytes)
      .map((record): ConflictRow => ({ ...record, key: [record.id, record.digest] }));
    const pending = [...this.pending.values()]
      .filter((record) => this.persistedPending.get(pendingStorageKey(record)) !== record.bytes)
      .map((record): PendingRow => ({ ...record, key: [record.missingParent, record.digest] }));
    const currentPendingKeys = new Set([...this.pending.values()].map(pendingStorageKey));
    const pendingDeletes = [...this.persistedPending.keys()].filter((key) => !currentPendingKeys.has(key));
    if (events.length === 0 && conflicts.length === 0 && pending.length === 0 && pendingDeletes.length === 0) {
      return;
    }

    const db = await openDb(this.idb, this.dbName);
    const tx = db.transaction(["events", "conflicts", "pending"], "readwrite");
    const completed = txDone(tx);
    await Promise.all([
      putSequentially(tx.objectStore("events"), events),
      putSequentially(tx.objectStore("conflicts"), conflicts),
      putSequentially(tx.objectStore("pending"), pending),
      deleteSequentially(tx.objectStore("pending"), pendingDeletes.map((key) => JSON.parse(key) as StoreKey)),
      completed,
    ]);
    db.close();
    for (const record of events) this.persistedEvents.set(record.id, record.bytes);
    for (const record of conflicts) this.persistedConflicts.set(JSON.stringify(record.key), record.bytes);
    for (const record of pending) this.persistedPending.set(JSON.stringify(record.key), record.bytes);
    for (const key of pendingDeletes) this.persistedPending.delete(key);
  }

  private async load(): Promise<void> {
    const db = await openDb(this.idb, this.dbName);
    const tx = db.transaction(["events", "conflicts", "pending"], "readonly");
    const [events, conflicts, pending] = await Promise.all([
      getAll<StoreRecord>(tx.objectStore("events")),
      getAll<ConflictRow>(tx.objectStore("conflicts")),
      getAll<PendingRow>(tx.objectStore("pending")),
      txDone(tx),
    ]);
    await this.loadRecords({ events, conflicts, pending });
    for (const record of events) this.persistedEvents.set(record.id, record.bytes);
    for (const record of conflicts) this.persistedConflicts.set(JSON.stringify(record.key), record.bytes);
    for (const record of pending) this.persistedPending.set(JSON.stringify(record.key), record.bytes);
    db.close();
  }
}

export function createIndexedDbEventStore(options: IndexedDbEventStoreOptions = {}): IndexedDbEventStore {
  return new IndexedDbEventStore(options);
}

function openDb(idb: IDBFactory, dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(dbName, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("events")) {
        const events = db.createObjectStore("events", { keyPath: "id" });
        events.createIndex("root", "root");
        events.createIndex("root_kind", ["root", "kind"]);
      }
      if (!db.objectStoreNames.contains("conflicts")) {
        db.createObjectStore("conflicts", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("pending")) {
        const pending = db.createObjectStore("pending", { keyPath: "key" });
        pending.createIndex("missingParent", "missingParent");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAll<T>(store: IDBObjectStore): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req: IDBRequest<T[]> = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function conflictStorageKey(record: ConflictRecord): string {
  return JSON.stringify([record.id, record.digest]);
}

function pendingStorageKey(record: PendingRecord): string {
  return JSON.stringify([record.missingParent, record.digest]);
}

function putSequentially<T>(store: IDBObjectStore, records: readonly T[]): Promise<void> {
  return runSequentially(records, (record) => store.put(record));
}

function deleteSequentially(store: IDBObjectStore, keys: readonly IDBValidKey[]): Promise<void> {
  return runSequentially(keys, (key) => store.delete(key));
}

function runSequentially<T>(
  values: readonly T[],
  request: (value: T) => IDBRequest,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let index = 0;
    const next = () => {
      if (index >= values.length) {
        resolve();
        return;
      }
      const current = request(values[index++]!);
      current.onsuccess = next;
      current.onerror = () => reject(current.error);
    };
    next();
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
