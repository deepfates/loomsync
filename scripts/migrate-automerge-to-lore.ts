import fs from "node:fs/promises";
import path from "node:path";
import { Repo, type Chunk, type StorageAdapterInterface, type StorageKey } from "@automerge/automerge-repo";
import { createLoreLooms } from "../packages/core/dist/lore/looms.js";
import { createFileEventStore } from "../packages/core/dist/lore/file-log.js";
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
}

interface MigrationReport {
  sourceDir: string;
  outDir: string;
  docsSeen: number;
  loomsMigrated: number;
  beforeEvents: number;
  afterEvents: number;
  failures: MigrationFailure[];
}

async function migrate(source: string, out: string): Promise<MigrationReport> {
  await fs.mkdir(out, { recursive: true });
  const docIds = await listDocumentIds(source);
  const store = createFileEventStore(out);
  const looms = createLoreLooms({
    store,
    author: { actor: "unknown", imported_by: "lync-automerge-migrator@0.1" },
  });
  const failures: MigrationFailure[] = [];
  let beforeEvents = 0;
  let loomsMigrated = 0;

  for (const docId of docIds) {
    const stats = await chunkStats(source, docId);
    try {
      const doc = await loadDoc(source, docId, 500);
      if (!isLoomDoc(doc)) continue;
      const snapshot = snapshotFromDoc(doc);
      beforeEvents += snapshot.turns.length + 1;
      const imported = await looms.import(snapshot);
      const lore = await looms.open(imported.id);
      const migrated = await lore.export();
      assertIsomorphic(snapshot, migrated);
      loomsMigrated++;
    } catch (error) {
      failures.push({
        docId,
        reason: error instanceof Error ? error.message : String(error),
        chunkBytes: stats.bytes,
        chunkFiles: stats.files,
      });
    }
  }

  const diagnostics = await store.diagnostics?.();
  const report: MigrationReport = {
    sourceDir: source,
    outDir: out,
    docsSeen: docIds.length,
    loomsMigrated,
    beforeEvents,
    afterEvents: diagnostics?.events ?? 0,
    failures,
  };
  await fs.writeFile(path.join(out, "migration-report.json"), JSON.stringify(report, null, 2));
  return report;
}

async function loadDoc(source: string, docId: string, timeoutMs: number): Promise<unknown> {
  const repo = new Repo({ storage: new FileStorageAdapter(source), network: [] });
  try {
    return await withTimeout(
      (async () => {
        const handle = await repo.find(`automerge:${docId}` as never);
        await handle.whenReady();
        return handle.doc();
      })(),
      timeoutMs,
      `timed out opening Automerge doc ${docId}`,
    );
  } finally {
    repo.shutdown();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
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
  return [...new Set(files.map((file) => file.split(".")[0]).filter(Boolean))].sort();
}

async function chunkStats(dir: string, docId: string): Promise<{ bytes: number; files: number }> {
  const files = (await fs.readdir(dir)).filter((file) => file.startsWith(`${docId}.`));
  let bytes = 0;
  for (const file of files) bytes += (await fs.stat(path.join(dir, file))).size;
  return { bytes, files: files.length };
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
  console.error("usage: node --experimental-strip-types scripts/migrate-automerge-to-lore.ts <copy-of-.data/lync> <out-dir>");
  process.exit(2);
}

const report = await migrate(sourceDir, outDir);
console.log(JSON.stringify(report, null, 2));
if (report.failures.length) process.exitCode = 1;
