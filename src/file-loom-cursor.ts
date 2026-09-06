import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseLyncLine,
  type LyncEventBody,
  type LyncLineClass,
} from "./events.js";
import {
  adjudicateIndexedLyncBucket,
  compactIndexedLyncLine,
  isCompactUnionCandidate,
  type CompactIndexedLyncLine,
} from "./compact-union.js";
import { assertJsonEncodable, cloneJson } from "./json.js";
import { Sha256, sha256Hex } from "./sha256.js";
import { serializeLyncEvent } from "./store.js";
import { uuidv7 } from "./uuid.js";
import type { LoomInfo, Turn } from "./types.js";

type DatabaseSync = import("node:sqlite").DatabaseSync;
type StatementSync = import("node:sqlite").StatementSync;

const LYNC_PREFIX = "lync:";
const CATALOG_FILE = ".lync-file-loom-cursor-v1.sqlite";
const CATALOG_PROTOCOL = "lync/file-loom-cursor-catalog/v1";
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const SCAN_CHUNK_BYTES = 64 * 1024;

class CanonicalAppendRaceError extends Error {}

export interface FileLoomCursorAuthor {
  actor: string;
  operator?: string;
  via?: string;
  imported_by?: string;
  source?: string;
}

export interface FileLoomTurnRef {
  id: string;
  loomId: string;
  parentId: string | null;
  depth: number;
  bodyDigest: string;
  /** Derived digest binding this exact root-to-turn canonical prefix. */
  chainDigest: string;
}

export interface FileLoomCanonicalLocator {
  source: string;
  line: number;
  start: number;
  end: number;
  terminator: "" | "\n";
  rawSha256: string;
}

export type FileLoomTurn<TPayload = unknown, TMeta = unknown> = Turn<TPayload, TMeta> & {
  depth: number;
  /** Digest of this turn's canonical event body. */
  bodyDigest: string;
  /** Derived digest binding this exact root-to-turn canonical prefix. */
  chainDigest: string;
  /** Exact authenticated canonical source location; never an absolute path. */
  locator: FileLoomCanonicalLocator;
};

export interface FileLoomCursorOptions {
  dir: string;
  loomId: string;
  author: FileLoomCursorAuthor;
  now?: () => number;
  createId?: () => string;
  maxLineBytes?: number;
}

export interface CreateFileLoomCursorOptions<TMeta = unknown>
  extends Omit<FileLoomCursorOptions, "loomId"> {
  meta?: TMeta;
}

export interface FileLoomThreadScanOptions {
  /** Explicit selected tip. The cursor never chooses a branch. */
  tip: string;
  /** Optional inclusive endpoint which must be an ancestor of tip. */
  through?: string;
  /** Optional exclusive ancestor of through. */
  after?: string;
}

export interface FileLoomCursor<TPayload = unknown, TLoomMeta = unknown, TTurnMeta = unknown> {
  readonly id: string;
  readonly catalogFile: string;
  info(): Promise<LoomInfo<TLoomMeta>>;
  hasTurn(turnId: string): Promise<boolean>;
  getTurn(turnId: string): Promise<FileLoomTurn<TPayload, TTurnMeta> | null>;
  childrenOf(parentId: string | null, limit?: number): Promise<FileLoomTurnRef[]>;
  leaves(limit?: number): Promise<FileLoomTurnRef[]>;
  depth(turnId: string): Promise<number>;
  refAtDepth(tip: string, depth: number): Promise<FileLoomTurnRef | null>;
  tail(tip: string, limit?: number): Promise<FileLoomTurn<TPayload, TTurnMeta>[]>;
  scanThread(options: FileLoomThreadScanOptions): AsyncIterable<FileLoomTurn<TPayload, TTurnMeta>>;
  appendTurn(
    parentId: string | null,
    payload: TPayload,
    meta?: TTurnMeta,
  ): Promise<FileLoomTurn<TPayload, TTurnMeta>>;
  close(): void;
}

/**
 * Open a Node-only, explicit-tip Loom cursor. The SQLite catalog contains only
 * disposable locators and topology; canonical JSONL remains sole authority.
 * This optional subpath requires Node >=22.13, where node:sqlite is unflagged.
 */
export async function openFileLoomCursor<
  TPayload = unknown,
  TLoomMeta = unknown,
  TTurnMeta = unknown,
>(options: FileLoomCursorOptions): Promise<FileLoomCursor<TPayload, TLoomMeta, TTurnMeta>> {
  const sqlite = await loadSqlite();
  validateOptions(options);
  await fsPromises.mkdir(options.dir, { recursive: true });
  const catalogFile = path.join(options.dir, CATALOG_FILE);
  const database = await openOrRebuildCatalog(
    sqlite.DatabaseSync,
    options.dir,
    catalogFile,
    maxLineBytes(options),
  );
  const root = loomRootId(options.loomId);
  const cursor = new SqliteFileLoomCursor<TPayload, TLoomMeta, TTurnMeta>({
    ...options,
    catalogFile,
    root,
    database,
  });
  try {
    await cursor.info();
    return cursor;
  } catch (error) {
    cursor.close();
    throw error;
  }
}

/** Create one canonical Loom root, fsync it, then open its explicit-tip cursor. */
export async function createFileLoomCursor<
  TPayload = unknown,
  TLoomMeta = unknown,
  TTurnMeta = unknown,
>(
  options: CreateFileLoomCursorOptions<TLoomMeta>,
): Promise<FileLoomCursor<TPayload, TLoomMeta, TTurnMeta>> {
  await loadSqlite();
  validateAuthor(options.author);
  assertJsonEncodable(options.meta, "loom meta");
  await fsPromises.mkdir(options.dir, { recursive: true });
  const id = (options.createId ?? uuidv7)();
  const event: LyncEventBody = {
    v: 1,
    id,
    kind: "lync/loom",
    at: new Date((options.now ?? Date.now)()).toISOString(),
    author: compactAuthor(options.author),
    parents: [],
    payload: options.meta === undefined ? {} : { meta: cloneJson(options.meta) },
  };
  const file = canonicalRootFile(options.dir, id);
  if (await fileExists(file)) throw new Error(`Lync Loom root already exists: ${id}`);
  await appendCanonicalLine(file, serializeLyncEvent(event));
  return openFileLoomCursor<TPayload, TLoomMeta, TTurnMeta>({
    ...options,
    loomId: `${LYNC_PREFIX}${id}`,
  });
}

class SqliteFileLoomCursor<TPayload, TLoomMeta, TTurnMeta>
  implements FileLoomCursor<TPayload, TLoomMeta, TTurnMeta>
{
  readonly id: string;
  readonly catalogFile: string;
  private closed = false;
  private poisoned: Error | null = null;
  private readonly database: DatabaseSync;
  private readonly root: string;
  private readonly dir: string;
  private readonly author: FileLoomCursorAuthor;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxLineBytes: number;

  constructor(options: FileLoomCursorOptions & {
    catalogFile: string;
    root: string;
    database: DatabaseSync;
  }) {
    this.id = options.loomId;
    this.catalogFile = options.catalogFile;
    this.database = options.database;
    this.root = options.root;
    this.dir = options.dir;
    this.author = { ...options.author };
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? uuidv7;
    this.maxLineBytes = maxLineBytes(options);
  }

  async info(): Promise<LoomInfo<TLoomMeta>> {
    this.assertOpen();
    await this.assertSourcesCurrent();
    const event = this.readEvent(this.root);
    if (!event || event.kind !== "lync/loom" || event.parents.length !== 0) {
      throw new Error(`Unknown or conflicted Lync Loom: ${this.id}`);
    }
    return omitUndefined({
      id: this.id,
      meta: cloneJson(event.payload.meta as TLoomMeta),
      createdAt: Date.parse(event.at),
    });
  }

  async hasTurn(turnId: string): Promise<boolean> {
    this.assertOpen();
    await this.assertSourcesCurrent();
    return this.turnDepthOrNull(turnId) !== null;
  }

  async getTurn(turnId: string): Promise<FileLoomTurn<TPayload, TTurnMeta> | null> {
    this.assertOpen();
    await this.assertSourcesCurrent();
    if (this.turnDepthOrNull(turnId) === null) return null;
    return this.readTurn(turnId);
  }

  async childrenOf(parentId: string | null, limit = 64): Promise<FileLoomTurnRef[]> {
    this.assertOpen();
    await this.assertSourcesCurrent();
    const parent = parentId ?? this.root;
    if (parentId !== null && this.turnDepthOrNull(parentId) === null) {
      throw new Error(`Unknown Loom turn: ${parentId}`);
    }
    const bounded = boundedLimit(limit, 1, 1024, 64);
    const rows = this.database
      .prepare(`
        SELECT e.id, n.root_id, n.parent_id, e.body_digest, n.chain_digest, n.depth
        FROM loom_nodes n JOIN events e ON e.id = n.id
        WHERE n.root_id = ? AND n.parent_id = ? AND n.depth > 0
        ORDER BY COALESCE(e.ordinal, 0), e.id
        LIMIT ?
      `)
      .all(this.root, parent, bounded + 1) as unknown as Array<LoomNodeRow & { depth: number }>;
    if (rows.length > bounded) {
      throw new Error(`Loom parent ${parentId ?? "<root>"} has more than ${bounded} children`);
    }
    return rows.map((row) => this.refFromRow(row, Number(row.depth)));
  }

  async leaves(limit = 1024): Promise<FileLoomTurnRef[]> {
    this.assertOpen();
    await this.assertSourcesCurrent();
    const bounded = boundedLimit(limit, 1, 100_000, 1024);
    const rows = this.database
      .prepare(`
        SELECT e.id, n.root_id, n.parent_id, e.body_digest, n.depth, n.chain_digest
        FROM loom_nodes n JOIN events e ON e.id = n.id
        WHERE n.root_id = ? AND n.depth > 0 AND NOT EXISTS (
          SELECT 1 FROM loom_nodes child
          WHERE child.root_id = n.root_id AND child.parent_id = n.id
        )
        ORDER BY n.depth, n.id
        LIMIT ?
      `)
      .all(this.root, bounded + 1) as unknown as Array<LoomNodeRow & { depth: number }>;
    if (rows.length > bounded) throw new Error(`Loom ${this.id} has more than ${bounded} leaves`);
    return rows.map((row) => this.refFromRow(row, Number(row.depth)));
  }

  async depth(turnId: string): Promise<number> {
    this.assertOpen();
    await this.assertSourcesCurrent();
    return this.turnDepth(turnId);
  }

  async refAtDepth(tip: string, depth: number): Promise<FileLoomTurnRef | null> {
    this.assertOpen();
    await this.assertSourcesCurrent();
    if (!Number.isSafeInteger(depth) || depth < 1) throw new Error("Loom depth must be a positive integer");
    const tipDepth = this.turnDepth(tip);
    if (depth > tipDepth) return null;
    const row = this.ancestorRow(tip, tipDepth - depth);
    if (!row) return null;
    return this.refFromRow(row, depth);
  }

  async tail(tip: string, limit = 12): Promise<FileLoomTurn<TPayload, TTurnMeta>[]> {
    this.assertOpen();
    await this.assertSourcesCurrent();
    const bounded = boundedLimit(limit, 0, 1024, 12);
    if (bounded === 0) return [];
    const depth = this.turnDepth(tip);
    const afterDepth = Math.max(0, depth - bounded);
    const turns: FileLoomTurn<TPayload, TTurnMeta>[] = [];
    for await (const turn of this.scanDepthRange(tip, afterDepth, depth)) turns.push(turn);
    return turns;
  }

  async *scanThread(
    options: FileLoomThreadScanOptions,
  ): AsyncIterable<FileLoomTurn<TPayload, TTurnMeta>> {
    this.assertOpen();
    await this.assertSourcesCurrent();
    const tipDepth = this.turnDepth(options.tip);
    const through = options.through ?? options.tip;
    const throughDepth = this.turnDepth(through);
    if (throughDepth > tipDepth || this.ancestorIdAtDepth(options.tip, throughDepth) !== through) {
      throw new Error(`Loom turn ${through} is not an ancestor of explicit tip ${options.tip}`);
    }
    let afterDepth = 0;
    if (options.after !== undefined) {
      afterDepth = this.turnDepth(options.after);
      if (
        afterDepth >= throughDepth ||
        this.ancestorIdAtDepth(through, afterDepth) !== options.after
      ) {
        throw new Error(`Loom turn ${options.after} is not an earlier ancestor of ${through}`);
      }
    }
    yield* this.scanDepthRange(through, afterDepth, throughDepth);
  }

  async appendTurn(
    parentId: string | null,
    payload: TPayload,
    meta?: TTurnMeta,
  ): Promise<FileLoomTurn<TPayload, TTurnMeta>> {
    this.assertOpen();
    await this.assertSourcesCurrent();
    assertJsonEncodable(payload, "turn payload");
    assertJsonEncodable(meta, "turn meta");
    const parent = parentId ?? this.root;
    const parentNode = this.loomNode(parent);
    if (!parentNode || parentNode.root_id !== this.root) {
      throw new Error(`Unknown Loom turn: ${parentId ?? "<root>"}`);
    }
    if (parentId !== null) {
      if (!this.readTurn(parentId)) throw new Error(`Unknown Loom turn: ${parentId}`);
    }
    const ordinalRow = this.database
      .prepare("SELECT COUNT(*) AS count FROM loom_nodes WHERE root_id = ? AND parent_id = ?")
      .get(this.root, parent) as { count: number | bigint };
    const ordinal = Number(ordinalRow.count);
    const id = this.createId();
    if (this.hasPhysicalCandidate(id)) throw new Error(`Duplicate Loom turn id: ${id}`);
    const event: LyncEventBody = {
      v: 1,
      id,
      kind: "lync/turn",
      at: new Date(this.now()).toISOString(),
      author: compactAuthor(this.author),
      parents: [parent],
      payload: omitUndefined({
        payload: cloneJson(payload),
        meta: cloneJson(meta),
        ordinal,
      }),
    };
    const line = serializeLyncEvent(event);
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
      throw new Error(`Lync turn exceeds maxLineBytes ${this.maxLineBytes}`);
    }
    const file = canonicalRootFile(this.dir, this.root);
    const fileName = path.basename(file);
    const source = this.sourceRow(fileName);
    let locator: CanonicalAppendLocator | undefined;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      await this.assertSourcesCurrent();
      const stat = await fsPromises.stat(file);
      if (stat.size !== Number(source.size)) {
        throw new Error(`Canonical Lync source changed outside this cursor: ${fileName}`);
      }
      if (stat.size > 0 && !(await endsWithLf(file, stat.size))) {
        throw new Error(`Canonical Lync source is not LF-terminated: ${fileName}`);
      }
      locator = await appendCanonicalLine(file, line, {
        start: Number(source.size),
        line: Number(source.line_count) + 1,
      });
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      if (error instanceof CanonicalAppendRaceError) {
        this.poison(
          new Error(
            `Canonical Loom turn ${id} may be durable but its locator raced another writer; reopen to reconcile`,
            { cause: error },
          ),
        );
      }
      throw error;
    }
    const diagnostic = parseLyncLine({
      file: path.basename(file),
      line: locator.line,
      bytes: new TextEncoder().encode(line),
      terminator: "\n",
    });
    const compact = compactIndexedLyncLine(diagnostic, {
      source: Number(source.source),
      file: fileName,
      line: locator.line,
      start: locator.start,
      end: locator.end,
      terminator: "\n",
    });
    if (!isCompactUnionCandidate(compact) || compact.id !== id || !compact.envelope) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      this.poison(new Error("Fresh Loom turn did not parse as an accepted union candidate"));
    }
    try {
      this.insertCompactLine(compact, ordinal);
      this.insertEvent(compact, ordinal);
      const chainDigest = prefixDigest(parentNode.chain_digest, compact.bodyDigest);
      this.database
        .prepare(
          "INSERT INTO loom_nodes (id, root_id, parent_id, depth, chain_digest) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, this.root, parent, Number(parentNode.depth) + 1, chainDigest);
      this.database
        .prepare(
          `UPDATE sources SET size = ?, line_count = ?, mtime_ms = ?, dev = ?, ino = ?,
           ctime_ns = ?, sha256 = NULL WHERE source = ?`,
        )
        .run(
          locator.end + 1,
          locator.line,
          locator.mtimeMs,
          locator.dev,
          locator.ino,
          locator.ctimeNs,
          compact.locator.source,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      this.poison(
        new Error(
          `Canonical Loom turn ${id} is durable but catalog update failed; reopen to reconcile`,
          { cause: error },
        ),
      );
    }
    try {
      await this.assertSourcesCurrent();
    } catch (error) {
      this.poison(
        new Error(
          `Canonical Loom turn ${id} is durable but another writer advanced the source; reopen to reconcile`,
          { cause: error },
        ),
      );
    }
    const appended = this.loomNode(id);
    if (!appended) throw new Error(`Appended Loom topology missing: ${id}`);
    return {
      ...turnFromEvent<TPayload, TTurnMeta>(event, this.id, this.root),
      depth: Number(appended.depth),
      bodyDigest: compact.bodyDigest,
      chainDigest: appended.chain_digest,
      locator: {
        source: fileName,
        line: locator.line,
        start: locator.start,
        end: locator.end,
        terminator: "\n",
        rawSha256: compact.rawSha256,
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private async *scanDepthRange(
    tip: string,
    afterDepth: number,
    throughDepth: number,
  ): AsyncIterable<FileLoomTurn<TPayload, TTurnMeta>> {
    const statement = this.database.prepare(`
      WITH RECURSIVE ancestry(id, parent_id, body_digest, chain_digest, depth) AS (
        SELECT n.id, n.parent_id, e.body_digest, n.chain_digest, ?
        FROM loom_nodes n JOIN events e ON e.id = n.id
        WHERE n.id = ? AND n.root_id = ? AND n.depth > 0
        UNION ALL
        SELECT parent.id, parent.parent_id, e.body_digest, parent.chain_digest, ancestry.depth - 1
        FROM loom_nodes parent JOIN ancestry ON parent.id = ancestry.parent_id
        JOIN events e ON e.id = parent.id
        WHERE ancestry.depth > ? AND parent.depth > 0
      )
      SELECT ancestry.id, ancestry.parent_id, ancestry.body_digest, ancestry.chain_digest,
             ancestry.depth
      FROM ancestry
      WHERE ancestry.depth > ?
      ORDER BY ancestry.depth ASC
    `);
    const iterator = statement.iterate(
      throughDepth,
      tip,
      this.root,
      afterDepth + 1,
      afterDepth,
    ) as Iterable<
      LoomNodeRow
    >;
    for (const row of iterator) {
      this.assertOpen();
      const turn = this.readTurn(row.id);
      if (!turn) throw new Error(`Indexed Loom turn became unavailable: ${row.id}`);
      yield turn;
    }
  }

  private ancestorIdAtDepth(tip: string, depth: number): string | null {
    const tipDepth = this.turnDepth(tip);
    return this.ancestorRow(tip, tipDepth - depth)?.id ?? null;
  }

  private ancestorRow(tip: string, steps: number): LoomNodeRow | null {
    const row = this.database
      .prepare(`
        WITH RECURSIVE ancestry(id, root_id, parent_id, body_digest, chain_digest, depth, step) AS (
          SELECT n.id, n.root_id, n.parent_id, e.body_digest, n.chain_digest, n.depth, 0
          FROM loom_nodes n JOIN events e ON e.id = n.id
          WHERE n.id = ? AND n.root_id = ? AND n.depth > 0
          UNION ALL
          SELECT parent.id, parent.root_id, parent.parent_id, e.body_digest,
                 parent.chain_digest, parent.depth, ancestry.step + 1
          FROM loom_nodes parent JOIN ancestry ON parent.id = ancestry.parent_id
          JOIN events e ON e.id = parent.id
          WHERE ancestry.step < ? AND parent.depth > 0
        )
        SELECT id, root_id, parent_id, body_digest, chain_digest, depth
        FROM ancestry WHERE step = ?
      `)
      .get(tip, this.root, steps, steps) as LoomNodeRow | undefined;
    return row ?? null;
  }

  private turnDepthOrNull(turnId: string): number | null {
    try {
      return this.turnDepth(turnId);
    } catch {
      return null;
    }
  }

  private turnDepth(turnId: string): number {
    const node = this.loomNode(turnId);
    if (!node || node.root_id !== this.root || Number(node.depth) < 1) {
      throw new Error(`Unknown Loom turn: ${turnId}`);
    }
    return Number(node.depth);
  }

  private readTurn(id: string): FileLoomTurn<TPayload, TTurnMeta> | null {
    const exact = this.readEventRecord(id);
    if (!exact) return null;
    const { event, row } = exact;
    validateLoomTurn(event);
    const node = this.loomNode(id);
    if (!node || node.root_id !== this.root || node.depth < 1) {
      throw new Error(`Invalid Lync Loom turn topology: ${id}`);
    }
    return {
      ...turnFromEvent<TPayload, TTurnMeta>(event, this.id, this.root),
      depth: Number(node.depth),
      bodyDigest: node.body_digest,
      chainDigest: node.chain_digest,
      locator: locatorFromRow(row),
    };
  }

  private readEvent(id: string): LyncEventBody | null {
    return this.readEventRecord(id)?.event ?? null;
  }

  private readEventRecord(id: string): { event: LyncEventBody; row: ExactEventRow } | null {
    const row = this.database
      .prepare(`
        SELECT e.id, e.body_digest, l.source, l.line, l.start, l.end, l.terminator,
               l.raw_sha256, s.file
        FROM events e
        JOIN lines l ON l.source = e.source AND l.line = e.line
        JOIN sources s ON s.source = l.source
        WHERE e.id = ?
      `)
      .get(id) as ExactEventRow | undefined;
    if (!row) return null;
    const exact = readExactSourceLine(this.dir, row);
    const diagnostic = parseLyncLine({
      file: row.file,
      line: Number(row.line),
      bytes: exact.body,
      terminator: row.terminator === 1 ? "\n" : "",
    });
    if (!diagnostic.event || diagnostic.id !== id || diagnostic.bodyDigest !== row.body_digest) {
      throw new Error(`Canonical Lync event no longer matches catalog at ${row.file}:${row.line}`);
    }
    return { event: diagnostic.event, row };
  }

  private hasPhysicalCandidate(id: string) {
    return Boolean(
      this.database
        .prepare(`
          SELECT 1 FROM lines
          WHERE id = ? AND body_digest IS NOT NULL AND envelope IS NOT NULL
            AND class IN ('accepted', 'nonconforming', 'conflict-variant')
          LIMIT 1
        `)
        .get(id),
    );
  }

  private loomNode(id: string): LoomNodeRow | null {
    return (
      (this.database
        .prepare(`
          SELECT n.id, n.root_id, n.parent_id, n.depth, n.chain_digest, e.body_digest
          FROM loom_nodes n JOIN events e ON e.id = n.id
          WHERE n.id = ?
        `)
        .get(id) as LoomNodeRow | undefined) ?? null
    );
  }

  private async assertSourcesCurrent() {
    const expectedFiles = canonicalSourceFiles(await fsPromises.readdir(this.dir));
    const rows = this.database
      .prepare(
        "SELECT source, file, size, mtime_ms, dev, ino, ctime_ns FROM sources ORDER BY source",
      )
      .all() as unknown as SourceIdentityRow[];
    if (rows.length !== expectedFiles.length) {
      throw new Error("Canonical Lync source set changed; close and reopen the cursor");
    }
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.file !== expectedFiles[index]) {
        throw new Error("Canonical Lync source order changed; close and reopen the cursor");
      }
      const actual = await sourceIdentity(path.join(this.dir, row.file));
      if (!sameSourceIdentity(row, actual)) {
        throw new Error(`Canonical Lync source changed: ${row.file}; close and reopen the cursor`);
      }
    }
  }

  private sourceRow(file: string): SourceIdentityRow & { line_count: number } {
    const row = this.database
      .prepare(
        `SELECT source, file, size, line_count, mtime_ms, dev, ino, ctime_ns
         FROM sources WHERE file = ?`,
      )
      .get(file) as (SourceIdentityRow & { line_count: number }) | undefined;
    if (!row) throw new Error(`Canonical Lync source is absent from catalog: ${file}`);
    return row;
  }

  private insertCompactLine(line: CompactIndexedLyncLine, ordinal: number | null) {
    insertCompactLine(this.database.prepare(INSERT_LINE_SQL), line, ordinal);
  }

  private insertEvent(line: CompactIndexedLyncLine, ordinal: number | null) {
    if (!isCompactUnionCandidate(line)) throw new Error("Cannot index a non-candidate event");
    this.database
      .prepare(INSERT_EVENT_SQL)
      .run(
        line.id,
        line.locator.source,
        line.locator.line,
        line.bodyDigest,
        line.envelope.kind,
        line.envelope.at,
        line.envelope.parents[0] ?? null,
        line.envelope.parents.length,
        ordinal,
      );
  }

  private refFromRow(row: LoomNodeRow, depth: number): FileLoomTurnRef {
    return {
      id: row.id,
      loomId: this.id,
      parentId: row.parent_id === this.root ? null : row.parent_id,
      depth,
      bodyDigest: row.body_digest,
      chainDigest: row.chain_digest,
    };
  }

  private assertOpen() {
    if (this.closed) throw new Error(`Lync file Loom cursor ${this.id} is closed`);
    if (this.poisoned) throw this.poisoned;
  }

  private poison(error: Error): never {
    this.poisoned = error;
    throw error;
  }
}

interface EventRow {
  id: string;
  parent_id: string | null;
  body_digest: string;
}

interface LoomNodeRow extends EventRow {
  root_id: string;
  depth: number;
  chain_digest: string;
}

interface CanonicalAppendLocator {
  start: number;
  end: number;
  line: number;
  mtimeMs: number;
  dev: string;
  ino: string;
  ctimeNs: string;
}

interface SourceIdentityRow {
  source: number;
  file: string;
  size: number;
  mtime_ms: number;
  dev: string;
  ino: string;
  ctime_ns: string;
}

interface ExactEventRow {
  id: string;
  body_digest: string;
  source: number;
  file: string;
  line: number;
  start: number;
  end: number;
  terminator: number;
  raw_sha256: string;
}

interface CatalogLineRow extends ExactEventRow {
  parsed_class: LyncLineClass;
  class: LyncLineClass;
  reason: string;
  has_digest: number | null;
  has_sig: number | null;
  duplicate_sighting: number;
  metadata_disagreement: number;
  digest: string | null;
  sig: string | null;
  nonconforming_reasons: string | null;
  envelope: string | null;
  ordinal: number | null;
}

const INSERT_LINE_SQL = `
  INSERT INTO lines (
    source, line, start, end, terminator, parsed_class, class, reason, id,
    has_digest, has_sig, duplicate_sighting, metadata_disagreement, body_digest,
    raw_sha256, digest, sig, nonconforming_reasons, envelope, ordinal
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_EVENT_SQL = `
  INSERT INTO events (id, source, line, body_digest, kind, at, parent_id, parent_count, ordinal)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

async function openOrRebuildCatalog(
  Database: typeof import("node:sqlite").DatabaseSync,
  directory: string,
  catalogFile: string,
  lineLimit: number,
) {
  const reusable = await openMatchingCatalog(Database, directory, catalogFile);
  if (reusable) return reusable;
  await rebuildCatalog(Database, directory, catalogFile, lineLimit);
  const database = new Database(catalogFile);
  configureOpenCatalog(database);
  return database;
}

async function openMatchingCatalog(
  Database: typeof import("node:sqlite").DatabaseSync,
  directory: string,
  catalogFile: string,
): Promise<DatabaseSync | null> {
  if (!(await fileExists(catalogFile))) return null;
  const database = new Database(catalogFile);
  try {
    configureOpenCatalog(database);
    const expected = canonicalSourceFiles(await fsPromises.readdir(directory));
    const rows = database
      .prepare(
        "SELECT source, file, size, mtime_ms, dev, ino, ctime_ns FROM sources ORDER BY source",
      )
      .all() as unknown as SourceIdentityRow[];
    if (rows.length !== expected.length) throw new Error("canonical source set changed");
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.file !== expected[index]) throw new Error("canonical source order changed");
      const identity = await sourceIdentity(path.join(directory, row.file));
      if (!sameSourceIdentity(row, identity)) {
        throw new Error(`canonical source identity changed: ${row.file}`);
      }
    }
    return database;
  } catch {
    try {
      database.close();
    } catch {}
    return null;
  }
}

async function rebuildCatalog(
  Database: typeof import("node:sqlite").DatabaseSync,
  directory: string,
  catalogFile: string,
  lineLimit: number,
) {
  const temporary = `${catalogFile}.tmp-${process.pid}-${randomUUID()}`;
  await fsPromises.rm(temporary, { force: true });
  const database = new Database(temporary);
  let committed = false;
  try {
    configureBuildCatalog(database);
    createSchema(database);
    database.exec("BEGIN IMMEDIATE");
    const files = canonicalSourceFiles(await fsPromises.readdir(directory));
    const insertSource = database.prepare(
      `INSERT INTO sources
       (source, file, size, line_count, mtime_ms, dev, ino, ctime_ns, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateSource = database.prepare(
      `UPDATE sources SET size = ?, line_count = ?, mtime_ms = ?, dev = ?, ino = ?,
       ctime_ns = ?, sha256 = ? WHERE source = ?`,
    );
    const insertLine = database.prepare(INSERT_LINE_SQL);
    for (let source = 0; source < files.length; source += 1) {
      const file = files[source]!;
      // The line table references its source; create the identity before streaming lines.
      insertSource.run(source, file, 0, 0, 0, "", "", "", null);
      const identity = await scanCanonicalSource({
        file: path.join(directory, file),
        source,
        lineLimit,
        onLine(compact, ordinal) {
          insertCompactLine(insertLine, compact, ordinal);
        },
      });
      updateSource.run(
        identity.size,
        identity.lineCount,
        identity.mtimeMs,
        identity.dev,
        identity.ino,
        identity.ctimeNs,
        identity.sha256,
        source,
      );
    }
    await adjudicateCatalog(database, directory);
    materializeLoomTopology(database);
    database
      .prepare("INSERT INTO metadata (key, value) VALUES ('protocol', ?)")
      .run(CATALOG_PROTOCOL);
    database.exec("COMMIT");
    committed = true;
  } finally {
    if (!committed) {
      try {
        database.exec("ROLLBACK");
      } catch {}
    }
    database.close();
  }
  if (!committed) {
    await fsPromises.rm(temporary, { force: true });
    throw new Error("Unable to rebuild Lync file Loom catalog");
  }
  await fsPromises.rename(temporary, catalogFile);
  await syncDirectory(directory);
}

async function adjudicateCatalog(database: DatabaseSync, directory: string) {
  const nextId = database.prepare(`
    SELECT id FROM lines
    WHERE id IS NOT NULL AND id > ? AND body_digest IS NOT NULL AND envelope IS NOT NULL
      AND class IN ('accepted', 'nonconforming')
    GROUP BY id ORDER BY id LIMIT 1
  `);
  const bucketStatement = database.prepare(`
    SELECT l.*, s.file
    FROM lines l JOIN sources s ON s.source = l.source
    WHERE l.id = ? AND l.body_digest IS NOT NULL AND l.envelope IS NOT NULL
      AND l.class IN ('accepted', 'nonconforming')
    ORDER BY l.source, l.start, l.line
  `);
  const updateLine = database.prepare(`
    UPDATE lines SET class = ?, reason = ?, duplicate_sighting = ?, metadata_disagreement = ?
    WHERE source = ? AND line = ?
  `);
  const insertEvent = database.prepare(INSERT_EVENT_SQL);
  let previousId = "";
  while (true) {
    const next = nextId.get(previousId) as { id: string } | undefined;
    if (!next) break;
    const id = next.id;
    previousId = id;
    const rows = bucketStatement.all(id) as unknown as CatalogLineRow[];
    const bucket = rows.map(compactFromCatalogRow);
    const result = await adjudicateIndexedLyncBucket(bucket, async (line) =>
      readExactBodyFromCompact(directory, line),
    );
    for (const line of bucket) {
      updateLine.run(
        line.class,
        line.reason,
        line.duplicateSighting ? 1 : 0,
        line.metadataDisagreement ? 1 : 0,
        line.locator.source,
        line.locator.line,
      );
    }
    if (!result.accepted || result.conflictGroups.length > 0) continue;
    const line = result.accepted;
    if (!isCompactUnionCandidate(line)) continue;
    insertEvent.run(
      line.id,
      line.locator.source,
      line.locator.line,
      line.bodyDigest,
      line.envelope.kind,
      line.envelope.at,
      line.envelope.parents[0] ?? null,
      line.envelope.parents.length,
      rows.find(
        (row) => row.source === line.locator.source && row.line === line.locator.line,
      )?.ordinal ?? null,
    );
  }
}

async function scanCanonicalSource(options: {
  file: string;
  source: number;
  lineLimit: number;
  onLine: (line: CompactIndexedLyncLine, ordinal: number | null) => void;
}) {
  const handle = await fsPromises.open(options.file, "r");
  const stat = await handle.stat();
  const identity = await handle.stat({ bigint: true });
  const sourceHash = new Sha256();
  const chunk = new Uint8Array(SCAN_CHUNK_BYTES);
  const lineBuffer = new Uint8Array(options.lineLimit);
  let offset = 0;
  let lineStart = 0;
  let lineLength = 0;
  let lineNumber = 1;
  const file = path.basename(options.file);

  const consume = (terminator: "" | "\n") => {
    const bytes = lineBuffer.slice(0, lineLength);
    const diagnostic = parseLyncLine({ file, line: lineNumber, bytes, terminator });
    const compact = compactIndexedLyncLine(diagnostic, {
      source: options.source,
      file,
      line: lineNumber,
      start: lineStart,
      end: lineStart + lineLength,
      terminator,
    });
    const ordinal =
      diagnostic.event?.kind === "lync/turn" &&
      diagnostic.event.parents.length === 1 &&
      "payload" in diagnostic.event.payload &&
      Number.isInteger(diagnostic.event.payload.ordinal) &&
      Number(diagnostic.event.payload.ordinal) >= 0
        ? Number(diagnostic.event.payload.ordinal)
        : null;
    options.onLine(compact, ordinal);
    lineNumber += 1;
    lineLength = 0;
    lineStart = terminator ? offset + 1 : offset;
  };

  try {
    while (offset < stat.size) {
      const length = Math.min(chunk.byteLength, stat.size - offset);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead === 0) throw new Error(`Canonical Lync source truncated during scan: ${file}`);
      const bytes = chunk.subarray(0, bytesRead);
      sourceHash.update(bytes);
      for (let index = 0; index < bytesRead; index += 1) {
        const value = bytes[index]!;
        if (value === 0x0a) consume("\n");
        else {
          if (lineLength >= options.lineLimit) {
            throw new Error(`Canonical Lync line exceeds maxLineBytes at ${file}:${lineNumber}`);
          }
          lineBuffer[lineLength] = value;
          lineLength += 1;
        }
        offset += 1;
      }
    }
    if (lineLength > 0) consume("");
    return {
      size: stat.size,
      lineCount: lineNumber - 1,
      mtimeMs: Number(identity.mtimeNs) / 1_000_000,
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
      ctimeNs: identity.ctimeNs.toString(),
      sha256: sourceHash.digestHex(),
    };
  } finally {
    await handle.close();
  }
}

function createSchema(database: DatabaseSync) {
  database.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE sources (
      source INTEGER PRIMARY KEY,
      file TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL,
      line_count INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      dev TEXT NOT NULL,
      ino TEXT NOT NULL,
      ctime_ns TEXT NOT NULL,
      sha256 TEXT
    ) STRICT;
    CREATE TABLE lines (
      source INTEGER NOT NULL,
      line INTEGER NOT NULL,
      start INTEGER NOT NULL,
      end INTEGER NOT NULL,
      terminator INTEGER NOT NULL,
      parsed_class TEXT NOT NULL,
      class TEXT NOT NULL,
      reason TEXT NOT NULL,
      id TEXT,
      has_digest INTEGER,
      has_sig INTEGER,
      duplicate_sighting INTEGER NOT NULL,
      metadata_disagreement INTEGER NOT NULL,
      body_digest TEXT,
      raw_sha256 TEXT NOT NULL,
      digest TEXT,
      sig TEXT,
      nonconforming_reasons TEXT,
      envelope TEXT,
      ordinal INTEGER,
      PRIMARY KEY (source, line),
      FOREIGN KEY (source) REFERENCES sources(source)
    ) STRICT;
    CREATE INDEX lines_id_order ON lines(id, source, start, line);
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      source INTEGER NOT NULL,
      line INTEGER NOT NULL,
      body_digest TEXT NOT NULL,
      kind TEXT NOT NULL,
      at TEXT NOT NULL,
      parent_id TEXT,
      parent_count INTEGER NOT NULL,
      ordinal INTEGER,
      FOREIGN KEY (source, line) REFERENCES lines(source, line)
    ) STRICT;
    CREATE INDEX events_parent_order ON events(parent_id, kind, ordinal, id);
    CREATE TABLE loom_nodes (
      id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL,
      parent_id TEXT,
      depth INTEGER NOT NULL,
      chain_digest TEXT NOT NULL,
      FOREIGN KEY (id) REFERENCES events(id)
    ) STRICT;
    CREATE INDEX loom_nodes_parent ON loom_nodes(root_id, parent_id, depth, id);
  `);
}

function materializeLoomTopology(database: DatabaseSync) {
  database.function("lync_chain_digest", (parent, body) => {
    if ((parent !== null && typeof parent !== "string") || typeof body !== "string") {
      throw new Error("Invalid Loom chain digest inputs");
    }
    return prefixDigest(parent, body);
  });
  database.exec(`
    INSERT INTO loom_nodes (id, root_id, parent_id, depth, chain_digest)
    WITH RECURSIVE valid(id, root_id, parent_id, depth, chain_digest) AS (
      SELECT id, id, NULL, 0, lync_chain_digest(NULL, body_digest) FROM events
      WHERE kind = 'lync/loom' AND parent_count = 0
      UNION ALL
      SELECT child.id, valid.root_id, child.parent_id, valid.depth + 1,
             lync_chain_digest(valid.chain_digest, child.body_digest)
      FROM events child JOIN valid ON child.parent_id = valid.id
      WHERE child.kind = 'lync/turn' AND child.parent_count = 1 AND child.ordinal IS NOT NULL
    )
    SELECT id, root_id, parent_id, depth, chain_digest FROM valid
  `);
}

function configureBuildCatalog(database: DatabaseSync) {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA temp_store = FILE;
    PRAGMA cache_size = -8192;
    PRAGMA foreign_keys = ON;
  `);
}

function configureOpenCatalog(database: DatabaseSync) {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA temp_store = FILE;
    PRAGMA cache_size = -8192;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
  const protocol = database
    .prepare("SELECT value FROM metadata WHERE key = 'protocol'")
    .get() as { value: string } | undefined;
  if (Number(version.user_version) !== 1 || protocol?.value !== CATALOG_PROTOCOL) {
    throw new Error("Invalid Lync file Loom cursor catalog");
  }
}

function insertCompactLine(
  statement: StatementSync,
  line: CompactIndexedLyncLine,
  ordinal: number | null,
) {
  statement.run(
    line.locator.source,
    line.locator.line,
    line.locator.start,
    line.locator.end,
    line.locator.terminator ? 1 : 0,
    line.parsedClass,
    line.class,
    line.reason,
    line.id ?? null,
    line.hasDigest === undefined ? null : line.hasDigest ? 1 : 0,
    line.hasSig === undefined ? null : line.hasSig ? 1 : 0,
    line.duplicateSighting ? 1 : 0,
    line.metadataDisagreement ? 1 : 0,
    line.bodyDigest ?? null,
    line.rawSha256,
    line.digest ?? null,
    line.sig ?? null,
    line.nonconformingReasons ? JSON.stringify(line.nonconformingReasons) : null,
    line.envelope ? JSON.stringify(line.envelope) : null,
    ordinal,
  );
}

function compactFromCatalogRow(row: CatalogLineRow): CompactIndexedLyncLine {
  return {
    locator: {
      source: Number(row.source),
      file: row.file,
      line: Number(row.line),
      start: Number(row.start),
      end: Number(row.end),
      terminator: row.terminator === 1 ? "\n" : "",
    },
    parsedClass: row.parsed_class,
    class: row.class,
    reason: row.reason,
    ...(row.id ? { id: row.id } : {}),
    ...(row.has_digest !== null ? { hasDigest: row.has_digest === 1 } : {}),
    ...(row.has_sig !== null ? { hasSig: row.has_sig === 1 } : {}),
    ...(row.duplicate_sighting ? { duplicateSighting: true } : {}),
    ...(row.metadata_disagreement ? { metadataDisagreement: true } : {}),
    ...(row.body_digest ? { bodyDigest: row.body_digest } : {}),
    rawSha256: row.raw_sha256,
    ...(row.digest ? { digest: row.digest } : {}),
    ...(row.sig ? { sig: row.sig } : {}),
    ...(row.nonconforming_reasons
      ? { nonconformingReasons: JSON.parse(row.nonconforming_reasons) as string[] }
      : {}),
    ...(row.envelope
      ? { envelope: JSON.parse(row.envelope) as NonNullable<CompactIndexedLyncLine["envelope"]> }
      : {}),
  };
}

function readExactBodyFromCompact(directory: string, line: CompactIndexedLyncLine) {
  const exact = readExactSourceLine(directory, {
    ...line.locator,
    terminator: line.locator.terminator ? 1 : 0,
    raw_sha256: line.rawSha256,
    body_digest: line.bodyDigest ?? "",
    id: line.id ?? "",
  });
  const diagnostic = parseLyncLine({
    file: line.locator.file,
    line: line.locator.line,
    bytes: exact.body,
    terminator: line.locator.terminator,
  });
  if (!diagnostic.bodyBytes || diagnostic.bodyDigest !== line.bodyDigest) {
    throw new Error(
      `Canonical Lync body changed during adjudication at ${line.locator.file}:${line.locator.line}`,
    );
  }
  return diagnostic.bodyBytes;
}

function locatorFromRow(row: ExactEventRow): FileLoomCanonicalLocator {
  return {
    source: row.file,
    line: Number(row.line),
    start: Number(row.start),
    end: Number(row.end),
    terminator: row.terminator === 1 ? "\n" : "",
    rawSha256: row.raw_sha256,
  };
}

function readExactSourceLine(directory: string, row: ExactEventRow) {
  const terminatorBytes = row.terminator === 1 ? 1 : 0;
  const length = Number(row.end) - Number(row.start) + terminatorBytes;
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid Lync catalog locator");
  const bytes = new Uint8Array(length);
  const descriptor = fs.openSync(path.join(directory, row.file), "r");
  try {
    const read = fs.readSync(descriptor, bytes, 0, bytes.byteLength, Number(row.start));
    if (read !== bytes.byteLength) {
      throw new Error(`Canonical Lync source truncated at ${row.file}:${row.line}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (terminatorBytes && bytes.at(-1) !== 0x0a) {
    throw new Error(`Canonical Lync line terminator changed at ${row.file}:${row.line}`);
  }
  const body = terminatorBytes ? bytes.subarray(0, bytes.byteLength - 1) : bytes;
  if (sha256Hex(body) !== row.raw_sha256) {
    throw new Error(`Canonical Lync source changed or reordered at ${row.file}:${row.line}`);
  }
  return { bytes, body };
}

async function appendCanonicalLine(
  file: string,
  line: string,
  known?: { start: number; line: number },
) {
  const existed = await fileExists(file);
  const before = existed ? await fsPromises.stat(file) : null;
  const start = known?.start ?? before?.size ?? 0;
  const lineNumber = known?.line ?? (before && before.size > 0 ? (await countLf(file)) + 1 : 1);
  if (before && before.size !== start) throw new Error(`Canonical Lync source changed before append`);
  const encoded = new TextEncoder().encode(`${line}\n`);
  const expectedSize = start + encoded.byteLength;
  const handle = await fsPromises.open(file, "a+");
  let mtimeMs = 0;
  let dev = "";
  let ino = "";
  let ctimeNs = "";
  try {
    await handle.writeFile(encoded);
    await handle.sync();
    const after = await handle.stat();
    const afterIdentity = await handle.stat({ bigint: true });
    if (after.size !== expectedSize) {
      throw new CanonicalAppendRaceError(
        `Canonical Lync source size ${after.size} did not match expected ${expectedSize}`,
      );
    }
    const exact = new Uint8Array(encoded.byteLength);
    const { bytesRead } = await handle.read(exact, 0, exact.byteLength, start);
    if (bytesRead !== encoded.byteLength || !bytesEqual(exact, encoded)) {
      throw new CanonicalAppendRaceError("Canonical Lync append locator did not read back exactly");
    }
    mtimeMs = Number(afterIdentity.mtimeNs) / 1_000_000;
    dev = afterIdentity.dev.toString();
    ino = afterIdentity.ino.toString();
    ctimeNs = afterIdentity.ctimeNs.toString();
  } finally {
    await handle.close();
  }
  if (!existed) await syncDirectory(path.dirname(file));
  return {
    start,
    end: expectedSize - 1,
    line: lineNumber,
    mtimeMs,
    dev,
    ino,
    ctimeNs,
  };
}

async function endsWithLf(file: string, size: number) {
  const handle = await fsPromises.open(file, "r");
  try {
    const byte = new Uint8Array(1);
    const { bytesRead } = await handle.read(byte, 0, 1, size - 1);
    return bytesRead === 1 && byte[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

async function countLf(file: string) {
  const handle = await fsPromises.open(file, "r");
  const chunk = new Uint8Array(SCAN_CHUNK_BYTES);
  let offset = 0;
  let count = 0;
  try {
    const size = (await handle.stat()).size;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.byteLength, size - offset),
        offset,
      );
      if (!bytesRead) break;
      for (let index = 0; index < bytesRead; index += 1) if (chunk[index] === 0x0a) count += 1;
      offset += bytesRead;
    }
    return count;
  } finally {
    await handle.close();
  }
}

function turnFromEvent<TPayload, TMeta>(
  event: LyncEventBody,
  loomId: string,
  root: string,
): Turn<TPayload, TMeta> {
  validateLoomTurn(event);
  return omitUndefined({
    id: event.id,
    loomId,
    parentId: event.parents[0] === root ? null : event.parents[0]!,
    payload: cloneJson(event.payload.payload as TPayload),
    meta: cloneJson(event.payload.meta as TMeta),
    createdAt: Date.parse(event.at),
  });
}

function validateLoomTurn(event: LyncEventBody) {
  if (
    event.kind !== "lync/turn" ||
    event.parents.length !== 1 ||
    !Number.isInteger(event.payload.ordinal) ||
    Number(event.payload.ordinal) < 0 ||
    !("payload" in event.payload)
  ) {
    throw new Error(`Invalid Lync Loom turn: ${event.id}`);
  }
}

function canonicalRootFile(directory: string, root: string) {
  return path.join(directory, `${encodeURIComponent(root)}.lync`);
}

function isCanonicalSourceFile(file: string) {
  return file.endsWith(".lync") || file.endsWith(".conflicts") || file === "pending.events";
}

function canonicalSourceFiles(files: string[]) {
  const ordinary = files
    .filter((file) => file.endsWith(".lync") || file.endsWith(".conflicts"))
    .sort();
  if (files.includes("pending.events")) ordinary.push("pending.events");
  return ordinary;
}

function loomRootId(loomId: string) {
  if (!loomId.startsWith(LYNC_PREFIX) || loomId.length === LYNC_PREFIX.length) {
    throw new Error(`Invalid Lync Loom id: ${loomId}`);
  }
  return loomId.slice(LYNC_PREFIX.length);
}

function validateOptions(options: FileLoomCursorOptions) {
  if (!options || typeof options.dir !== "string" || options.dir.length === 0) {
    throw new Error("Lync file Loom cursor requires a directory");
  }
  loomRootId(options.loomId);
  validateAuthor(options.author);
  maxLineBytes(options);
}

function validateAuthor(author: FileLoomCursorAuthor) {
  if (!author || typeof author.actor !== "string" || author.actor.length === 0) {
    throw new Error("Lync file Loom cursor author.actor must be non-empty");
  }
  for (const field of ["operator", "via", "imported_by", "source"] as const) {
    if (author[field] !== undefined && typeof author[field] !== "string") {
      throw new Error(`Lync file Loom cursor author.${field} must be a string`);
    }
  }
}

function compactAuthor(author: FileLoomCursorAuthor): LyncEventBody["author"] {
  return omitUndefined({
    actor: author.actor,
    operator: author.operator,
    via: author.via,
    imported_by: author.imported_by,
    source: author.source,
  });
}

function maxLineBytes(options: { maxLineBytes?: number }) {
  const value = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("maxLineBytes must be positive");
  return value;
}

function boundedLimit(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function omitUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function prefixDigest(parent: string | null, body: string) {
  return sha256Hex(new TextEncoder().encode(`lync-prefix-v1\0${parent ?? ""}\0${body}`));
}

async function sourceIdentity(file: string): Promise<Omit<SourceIdentityRow, "source" | "file">> {
  const stat = await fsPromises.stat(file, { bigint: true });
  return {
    size: Number(stat.size),
    mtime_ms: Number(stat.mtimeNs) / 1_000_000,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    ctime_ns: stat.ctimeNs.toString(),
  };
}

function sameSourceIdentity(
  expected: Pick<SourceIdentityRow, "size" | "mtime_ms" | "dev" | "ino" | "ctime_ns">,
  actual: Omit<SourceIdentityRow, "source" | "file">,
) {
  return (
    Number(expected.size) === actual.size &&
    Number(expected.mtime_ms) === actual.mtime_ms &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.ctime_ns === actual.ctime_ns
  );
}

async function fileExists(file: string) {
  try {
    await fsPromises.stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const handle = await fsPromises.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function loadSqlite() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(
      `@deepfates/lync/file-loom-cursor requires Node >=22.13 (current ${process.versions.node})`,
    );
  }
  return import("node:sqlite");
}
