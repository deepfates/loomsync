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
    const db = await openDb(this.idb, this.dbName);
    const tx = db.transaction(["events", "conflicts", "pending"], "readwrite");
    const records = this.dumpRecords();
    const conflicts: ConflictRow[] = records.conflicts.map((record) => ({ ...record, key: [record.id, record.digest] }));
    const pending: PendingRow[] = records.pending.map((record) => ({ ...record, key: [record.missingParent, record.digest] }));
    await Promise.all([
      clearAndPut(tx.objectStore("events"), records.events),
      clearAndPut(tx.objectStore("conflicts"), conflicts),
      clearAndPut(tx.objectStore("pending"), pending),
      txDone(tx),
    ]);
    db.close();
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

async function clearAndPut<T>(store: IDBObjectStore, records: readonly T[]): Promise<void> {
  await requestDone(store.clear());
  for (const record of records) await requestDone(store.put(record));
}

function requestDone(req: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
