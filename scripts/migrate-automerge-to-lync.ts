import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Automerge,
  initializeWasm,
  type Chunk,
  type DocumentId,
  type StorageAdapterInterface,
  type StorageKey,
} from "@automerge/automerge-repo/slim";
import { createLoreLooms } from "../packages/core/dist/lore/looms.js";
import { BaseEventStore } from "../packages/core/dist/lore/store.js";
import type { LoomSnapshot, Turn } from "../packages/core/dist/types.js";

const ROOT_CHILDREN_KEY = "__root__";

interface LoomDoc {
  version: 1;
  root: { id: string; meta?: unknown; createdAt: number };
  nodes: Record<string, Turn<unknown, unknown>>;
  children: Record<string, string[]>;
}

interface MigrationFailure {
  docId: string;
  reason: string;
  chunkBytes: number;
  chunkFiles: number;
  chunks: string[];
  beforeEvents?: number;
  afterEvents?: number;
}

interface MigrationReport {
  sourceDir: string;
  outDir: string;
  docsSeen: number;
  loomsMigrated: number;
  beforeEvents: number;
  afterEvents: number;
  docs: MigrationDocReport[];
  failures: MigrationFailure[];
}

interface MigrationDocReport {
  docId: string;
  beforeEvents: number;
  afterEvents: number;
  chunkBytes: number;
  chunkFiles: number;
}

async function migrate(source: string, out: string): Promise<MigrationReport> {
  await initializeAutomerge();
  await fs.mkdir(out, { recursive: true });
  const docIds = await listDocumentIds(source);
  const store = new MigrationEventStore(out);
  const looms = createLoreLooms({
    store,
    author: { actor: "unknown", imported_by: "lync-automerge-migrator@0.1" },
  });
  const failures: MigrationFailure[] = [];
  const docs: MigrationDocReport[] = [];
  let beforeEvents = 0;
  let afterEvents = 0;
  let loomsMigrated = 0;
  let report: MigrationReport = {
    sourceDir: source,
    outDir: out,
    docsSeen: docIds.length,
    loomsMigrated,
    beforeEvents,
    afterEvents,
    docs,
    failures,
  };
  await writeReport(out, report);

  for (const docId of docIds) {
    const stats = await chunkStats(source, docId);
    let docBeforeEvents: number | undefined;
    let docAfterEvents: number | undefined;
    try {
      const doc = await loadDoc(source, docId);
      if (!isLoomDoc(doc)) {
        failures.push(failure(docId, "loaded Automerge doc is not loom-shaped", stats));
        report = updateReport(report, { loomsMigrated, beforeEvents, afterEvents });
        await writeReport(out, report);
        continue;
      }
      docBeforeEvents = countLoomDocEvents(doc);
      const snapshot = snapshotFromDoc(doc);
      const imported = await looms.import(snapshot);
      const loom = await looms.open(imported.id);
      const migrated = await loom.export();
      assertIsomorphic(snapshot, migrated);
      docAfterEvents = countSnapshotEvents(migrated);
      if (docBeforeEvents !== docAfterEvents) {
        throw new Error(`event count mismatch: before=${docBeforeEvents} after=${docAfterEvents}`);
      }
      docs.push({
        docId,
        beforeEvents: docBeforeEvents,
        afterEvents: docAfterEvents,
        chunkBytes: stats.bytes,
        chunkFiles: stats.files,
      });
      beforeEvents += docBeforeEvents;
      afterEvents += docAfterEvents;
      loomsMigrated++;
      await store.flushRoot(rootId(imported.id));
    } catch (error) {
      failures.push(failure(docId, error instanceof Error ? error.message : String(error), stats, docBeforeEvents, docAfterEvents));
    }
    report = updateReport(report, { loomsMigrated, beforeEvents, afterEvents });
    await writeReport(out, report);
  }

  return report;
}

async function initializeAutomerge(): Promise<void> {
  const slimEntrypoint = fileURLToPath(import.meta.resolve("@automerge/automerge-repo/slim"));
  const wasmPath = path.resolve(path.dirname(slimEntrypoint), "../../..", "automerge", "dist", "automerge.wasm");
  await initializeWasm(await fs.readFile(wasmPath));
}

async function loadDoc(source: string, docId: string): Promise<unknown> {
  const adapter = new FileStorageAdapter(source);
  const binary = await loadDocData(adapter, docId);
  if (!binary) throw new Error("no Automerge chunks found for document");
  return Automerge.loadIncremental(Automerge.init(), binary);
}

async function loadDocData(adapter: StorageAdapterInterface, docId: string): Promise<Uint8Array | null> {
  const chunks = [
    ...(await adapter.loadRange([docId as DocumentId, "snapshot"])),
    ...(await adapter.loadRange([docId as DocumentId, "incremental"])),
  ];
  const binaries = chunks.map((chunk) => chunk.data).filter((data): data is Uint8Array => data !== undefined);
  if (binaries.length === 0) return null;
  return mergeArrays(binaries);
}

function isLoomDoc(value: unknown): value is LoomDoc {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LoomDoc>;
  return candidate.version === 1 && isRecord(candidate.root) && isRecord(candidate.nodes) && isRecord(candidate.children);
}

function snapshotFromDoc(doc: LoomDoc): LoomSnapshot<unknown, unknown, unknown> {
  const turns: Turn<unknown, unknown>[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null) => {
    const key = parentId ?? ROOT_CHILDREN_KEY;
    for (const turnId of doc.children[key] ?? []) {
      if (seen.has(turnId)) throw new Error(`cycle or duplicate child reference at ${turnId}`);
      const turn = doc.nodes[turnId];
      if (!turn) throw new Error(`child list references missing turn ${turnId}`);
      seen.add(turnId);
      turns.push(turn);
      visit(turnId);
    }
  };
  visit(null);
  for (const turn of Object.values(doc.nodes)) {
    if (!seen.has(turn.id)) throw new Error(`unreachable turn ${turn.id}`);
  }
  return { loom: doc.root, turns };
}

function countLoomDocEvents(doc: LoomDoc): number {
  return Object.keys(doc.nodes).length + 1;
}

function countSnapshotEvents(snapshot: LoomSnapshot<unknown, unknown, unknown>): number {
  return snapshot.turns.length + 1;
}

function assertIsomorphic(
  before: LoomSnapshot<unknown, unknown, unknown>,
  after: LoomSnapshot<unknown, unknown, unknown>,
): void {
  const normalize = (snapshot: LoomSnapshot<unknown, unknown, unknown>) =>
    snapshot.turns.map((turn) => ({
      parentIndex: turn.parentId === null ? null : snapshot.turns.findIndex((candidate) => candidate.id === turn.parentId),
      payload: turn.payload,
      meta: turn.meta,
      createdAt: turn.createdAt,
    }));
  if (JSON.stringify(before.loom.meta) !== JSON.stringify(after.loom.meta)) {
    throw new Error("loom meta mismatch after migration");
  }
  if (JSON.stringify(normalize(before)) !== JSON.stringify(normalize(after))) {
    throw new Error("turn topology/payload mismatch after migration");
  }
}

async function listDocumentIds(dir: string): Promise<string[]> {
  const files = await fs.readdir(dir);
  return [
    ...new Set(
      files
        .map((file) => file.split("."))
        .filter((parts) => parts[1] === "snapshot" || parts[1] === "incremental")
        .map(([docId]) => docId)
        .filter(Boolean),
    ),
  ].sort();
}

async function chunkStats(dir: string, docId: string): Promise<{ bytes: number; files: number; chunks: string[] }> {
  const files = (await fs.readdir(dir)).filter((file) => file.startsWith(`${docId}.`)).sort();
  let bytes = 0;
  for (const file of files) bytes += (await fs.stat(path.join(dir, file))).size;
  return { bytes, files: files.length, chunks: files.map((file) => path.join(dir, file)) };
}

function failure(
  docId: string,
  reason: string,
  stats: { bytes: number; files: number; chunks: string[] },
  beforeEvents?: number,
  afterEvents?: number,
): MigrationFailure {
  return {
    docId,
    reason,
    chunkBytes: stats.bytes,
    chunkFiles: stats.files,
    chunks: stats.chunks,
    ...(beforeEvents === undefined ? {} : { beforeEvents }),
    ...(afterEvents === undefined ? {} : { afterEvents }),
  };
}

function updateReport(
  report: MigrationReport,
  counts: Pick<MigrationReport, "loomsMigrated" | "beforeEvents" | "afterEvents">,
): MigrationReport {
  return {
    ...report,
    ...counts,
  };
}

async function writeReport(out: string, report: MigrationReport): Promise<void> {
  const reportPath = path.join(out, "migration-report.json");
  const tmpPath = `${reportPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(report, null, 2));
  await fs.rename(tmpPath, reportPath);
}

function mergeArrays(arrays: Uint8Array[]): Uint8Array {
  const size = arrays.reduce((total, array) => total + array.length, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const array of arrays) {
    merged.set(array, offset);
    offset += array.length;
  }
  return merged;
}

function rootId(loomId: string): string {
  if (!loomId.startsWith("lore:")) throw new Error(`expected imported lync loom id, got ${loomId}`);
  return loomId.slice("lore:".length);
}

class MigrationEventStore extends BaseEventStore {
  private readonly dir: string;

  constructor(dir: string) {
    super();
    this.dir = dir;
  }

  async flushRoot(root: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, `${encodeURIComponent(root)}.lync`), await this.exportRootBytes(root));
  }
}

class FileStorageAdapter implements StorageAdapterInterface {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    try {
      return toUint8Array(await fs.readFile(this.filePath(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.filePath(key), data);
  }

  async remove(key: StorageKey): Promise<void> {
    try {
      await fs.unlink(this.filePath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const prefix = this.keyToFilename(keyPrefix);
    const files = await fs.readdir(this.dir);
    return Promise.all(
      files
        .filter((file) => !prefix || file === prefix || file.startsWith(`${prefix}.`))
        .map(async (file) => ({
          key: this.filenameToKey(file),
          data: toUint8Array(await fs.readFile(path.join(this.dir, file))),
        })),
    );
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const prefix = this.keyToFilename(keyPrefix);
    const files = await fs.readdir(this.dir);
    await Promise.all(
      files
        .filter((file) => !prefix || file === prefix || file.startsWith(`${prefix}.`))
        .map((file) => fs.unlink(path.join(this.dir, file))),
    );
  }

  private filePath(key: StorageKey) {
    return path.join(this.dir, this.keyToFilename(key));
  }

  private keyToFilename(key: StorageKey) {
    return key.map((part) => encodeURIComponent(part)).join(".");
  }

  private filenameToKey(filename: string): StorageKey {
    return filename.split(".").map((part) => decodeURIComponent(part));
  }
}

function toUint8Array(data: Uint8Array) {
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const [sourceDir, outDir] = process.argv.slice(2);
if (!sourceDir || !outDir) {
  console.error("usage: node --experimental-strip-types scripts/migrate-automerge-to-lync.ts <copy-of-.data/lync> <out-dir>");
  process.exit(2);
}

const report = await migrate(sourceDir, outDir);
console.log(JSON.stringify(report, null, 2));
if (report.failures.length) process.exitCode = 1;
