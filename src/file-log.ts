import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Looms } from "./types.js";
import { createLyncLooms, type LyncLoomsOptions } from "./looms.js";
import { parseLyncFiles } from "./events.js";
import {
  BaseEventStore,
  type GarbageRecord,
  type StoreRecord,
  type ConflictRecord,
  type PendingRecord,
} from "./store.js";

const STORE_FILE = "events.json";
const EVENT_FILE_EXTENSIONS = [".lync"];
const CONFLICT_FILE_EXTENSION = ".conflicts";
const PENDING_FILE = "pending.events";
const GARBAGE_FILE = "garbage.json";

export interface FileEventStoreOptions {
  dir: string;
}

export class FileEventStore extends BaseEventStore {
  private ready: Promise<void>;
  private readonly persistedLines = new Map<string, Set<string>>();
  private readonly uncertainAppendFiles = new Set<string>();
  private persistedGarbage = "[]";
  private recoveredTailDiagnostic = false;

  constructor(private readonly options: FileEventStoreOptions) {
    super();
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

  override async diagnostics() {
    await this.ready;
    return super.diagnostics();
  }

  override async exportRootBytes(rootId: string) {
    await this.ready;
    return super.exportRootBytes(rootId);
  }

  protected override async persist(): Promise<void> {
    await fs.mkdir(this.options.dir, { recursive: true });
    const records = this.dumpRecords();
    const linesByFile = groupDurableLines(records);
    for (const [file, lines] of linesByFile) {
      const known = this.persistedLines.get(file) ?? new Set<string>();
      const missing = lines.filter((line) => !known.has(line));
      if (missing.length === 0) continue;
      try {
        await appendDurably(
          path.join(this.options.dir, file),
          missing,
          this.uncertainAppendFiles.has(file),
        );
        this.uncertainAppendFiles.delete(file);
      } catch (error) {
        this.uncertainAppendFiles.add(file);
        throw error;
      }
      for (const line of missing) known.add(line);
      this.persistedLines.set(file, known);
    }

    const garbage = JSON.stringify(records.garbage, null, 2);
    if (garbage !== this.persistedGarbage) {
      await writeAtomically(path.join(this.options.dir, GARBAGE_FILE), garbage);
      this.persistedGarbage = garbage;
    }
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.options.dir, { recursive: true });
    let snapshot: ReturnType<typeof validateSnapshotRecords> | undefined;
    let invalidSnapshot: unknown;
    try {
      const raw = await fs.readFile(path.join(this.options.dir, STORE_FILE), "utf8");
      snapshot = validateSnapshotRecords(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") invalidSnapshot = error;
    }

    const loadedCanonical = await this.loadLyncFiles();
    await this.loadGarbageFile();
    if (snapshot) {
      // Snapshot index fields are untrusted acceleration metadata. Only exact
      // raw lines re-enter through ordinary union semantics.
      await this.loadLines([
        ...snapshot.events.map((record) => record.bytes),
        ...snapshot.conflicts.map((record) => record.bytes),
        ...snapshot.pending.map((record) => record.bytes),
      ]);
      const knownGarbage = new Set(this.garbage.map(garbageKey));
      for (const record of snapshot.garbage) {
        if (!knownGarbage.has(garbageKey(record))) this.garbage.push(record);
      }
      await this.persist();
      await fs.rename(
        path.join(this.options.dir, STORE_FILE),
        path.join(this.options.dir, `events.legacy-${Date.now()}-${randomUUID()}.json`),
      );
      await syncDirectory(this.options.dir);
    } else if (this.recoveredTailDiagnostic) {
      await this.persist();
    }
    if (invalidSnapshot && !loadedCanonical) throw invalidSnapshot;
    if (invalidSnapshot) {
      await fs.rename(
        path.join(this.options.dir, STORE_FILE),
        path.join(this.options.dir, `events.invalid-${Date.now()}-${randomUUID()}.json`),
      );
      await syncDirectory(this.options.dir);
    }
  }

  private async loadLyncFiles(): Promise<boolean> {
    const files = await fs.readdir(this.options.dir);
    const eventFiles = files.filter(isEventFile).sort();
    if (files.includes(PENDING_FILE)) eventFiles.push(PENDING_FILE);
    const lines: string[] = [];
    for (const file of eventFiles) {
      const filePath = path.join(this.options.dir, file);
      let raw = await fs.readFile(filePath, "utf8");
      if (raw.length > 0 && !raw.endsWith("\n")) {
        const tail = raw.slice(raw.lastIndexOf("\n") + 1);
        const diagnostic = parseLyncFiles([{ file, bytes: raw }]).lines.at(-1);
        if (diagnostic?.class === "nonconforming" && diagnostic.event) {
          this.garbage.push({ reason: "nonconforming final line missing LF; sealed during recovery", bytes: tail });
          this.recoveredTailDiagnostic = true;
        }
        await fs.appendFile(filePath, "\n");
        await syncFile(filePath);
        raw += "\n";
      }
      const stored = raw.split("\n").filter((line) => line.length > 0);
      this.persistedLines.set(file, new Set(stored));
      lines.push(...stored);
    }
    await this.loadLines(lines);
    return eventFiles.length > 0;
  }

  private async loadGarbageFile(): Promise<void> {
    try {
      const raw = await fs.readFile(path.join(this.options.dir, GARBAGE_FILE), "utf8");
      const records = JSON.parse(raw) as GarbageRecord[];
      if (!Array.isArray(records)) throw new Error(`${GARBAGE_FILE} is not an array`);
      const known = new Set(this.garbage.map(garbageKey));
      for (const record of records) {
        if (!record || typeof record.reason !== "string" || typeof record.bytes !== "string") {
          throw new Error(`${GARBAGE_FILE} contains an invalid record`);
        }
        if (!known.has(garbageKey(record))) this.garbage.push(record);
      }
      this.persistedGarbage = JSON.stringify(records, null, 2);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function createFileEventStore(dir: string): FileEventStore {
  return new FileEventStore({ dir });
}

// File-backed looms live here, not in looms.ts, so the browser-reachable
// modules never statically import this node:fs/node:path file.
export function createFileLyncLooms<
  TPayload = unknown,
  TLoomMeta = unknown,
  TTurnMeta = unknown,
>(dir: string, options: Omit<LyncLoomsOptions, "store">): Looms<TPayload, TLoomMeta, TTurnMeta> {
  return createLyncLooms({ ...options, store: createFileEventStore(dir) });
}

function isEventFile(file: string): boolean {
  return (
    EVENT_FILE_EXTENSIONS.some((extension) => file.endsWith(extension)) ||
    file.endsWith(CONFLICT_FILE_EXTENSION)
  );
}

function groupDurableLines(records: {
  events: StoreRecord[];
  conflicts: ConflictRecord[];
  pending: PendingRecord[];
  garbage: GarbageRecord[];
}): Map<string, string[]> {
  const grouped = new Map<string, Set<string>>();
  const add = (file: string, line: string) => {
    const lines = grouped.get(file) ?? new Set<string>();
    lines.add(line);
    grouped.set(file, lines);
  };
  for (const event of records.events) add(`${encodeURIComponent(event.root)}.lync`, event.bytes);
  for (const conflict of records.conflicts) {
    add(`${encodeURIComponent(conflict.root)}${CONFLICT_FILE_EXTENSION}`, conflict.bytes);
  }
  for (const pending of records.pending) add(PENDING_FILE, pending.bytes);
  return new Map([...grouped].map(([file, lines]) => [file, [...lines]]));
}

async function appendDurably(file: string, lines: string[], forceDirectorySync = false): Promise<void> {
  const existed = await fileExists(file);
  const sealPartialTail = existed && await hasUnterminatedTail(file);
  const handle = await fs.open(file, "a");
  try {
    await handle.writeFile(`${sealPartialTail ? "\n" : ""}${lines.join("\n")}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!existed || forceDirectorySync) await syncDirectory(path.dirname(file));
}

async function hasUnterminatedTail(file: string): Promise<boolean> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const tail = new Uint8Array(1);
    const { bytesRead } = await handle.read(tail, 0, 1, size - 1);
    return bytesRead === 1 && tail[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

async function writeAtomically(file: string, bytes: string): Promise<void> {
  const temporary = `${file}.tmp-${randomUUID()}`;
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function garbageKey(record: GarbageRecord): string {
  return `${record.reason}\0${record.bytes}`;
}

function validateSnapshotRecords(value: unknown): {
  events: StoreRecord[];
  conflicts: ConflictRecord[];
  pending: PendingRecord[];
  garbage: GarbageRecord[];
} {
  if (!value || typeof value !== "object") throw new Error(`${STORE_FILE} is not an object`);
  const candidate = value as Record<string, unknown>;
  const arrays = ["events", "conflicts", "pending", "garbage"] as const;
  for (const key of arrays) {
    if (candidate[key] !== undefined && !Array.isArray(candidate[key])) {
      throw new Error(`${STORE_FILE}.${key} is not an array`);
    }
  }
  const records = {
    events: (candidate.events ?? []) as StoreRecord[],
    conflicts: (candidate.conflicts ?? []) as ConflictRecord[],
    pending: (candidate.pending ?? []) as PendingRecord[],
    garbage: (candidate.garbage ?? []) as GarbageRecord[],
  };
  for (const record of [...records.events, ...records.conflicts, ...records.pending]) {
    if (!record || typeof record.bytes !== "string") {
      throw new Error(`${STORE_FILE} contains a record without exact bytes`);
    }
  }
  for (const record of records.garbage) {
    if (!record || typeof record.reason !== "string" || typeof record.bytes !== "string") {
      throw new Error(`${STORE_FILE} contains an invalid garbage record`);
    }
  }
  return records;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not support opening directories as fsync handles. File data
  // is still synced above; POSIX additionally makes new names durable here.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
