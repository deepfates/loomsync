import type { LyncEventBody } from "./events.js";
import { parseLyncFiles } from "./events.js";
import { sha256Hex } from "./sha256.js";

export interface StoredEvent {
  body: LyncEventBody;
  bytes: string;
  root: string;
}

export type AppendResult =
  | { status: "added"; event: StoredEvent }
  | { status: "duplicate"; event: StoredEvent }
  | { status: "buffered"; missingParent: string; bytes: string }
  | { status: "conflict"; event: StoredEvent; conflictWith: StoredEvent }
  | { status: "garbage"; reason: string; bytes: string };

export type EventBatch = Iterable<LyncEventBody> | AsyncIterable<LyncEventBody>;

export interface EventStore {
  append(ev: LyncEventBody): Promise<AppendResult>;
  /** Append one causally ordered group with at most one durable store flush. */
  appendMany?(events: EventBatch): Promise<AppendResult[]>;
  union(line: string): Promise<AppendResult>;
  byId(id: string): Promise<StoredEvent | null>;
  byRoot(rootId: string): Promise<StoredEvent[]>;
  subscribe(rootId: string, listener: (ev: StoredEvent) => void): () => void;
  roots(kind?: "lync/loom" | "lync/index"): Promise<StoredEvent[]>;
  exportRootBytes?(rootId: string): Promise<string>;
  diagnostics?(): Promise<EventStoreDiagnostics>;
}

export interface EventStoreDiagnostics {
  events: number;
  conflicts: number;
  pending: number;
  garbage: number;
}

export interface StoreRecord {
  id: string;
  root: string;
  kind: string;
  at: string;
  bytes: string;
}

export interface ConflictRecord {
  id: string;
  digest: string;
  root: string;
  bytes: string;
}

export interface PendingRecord {
  missingParent: string;
  digest: string;
  bytes: string;
}

export interface GarbageRecord {
  reason: string;
  bytes: string;
}

export abstract class BaseEventStore implements EventStore {
  protected readonly events = new Map<string, StoredEvent>();
  protected readonly conflicts = new Map<string, ConflictRecord>();
  protected readonly pending = new Map<string, PendingRecord>();
  protected readonly garbage: GarbageRecord[] = [];
  private readonly listeners = new Map<string, Set<(ev: StoredEvent) => void>>();
  private batchDepth = 0;
  private batchDirty = false;

  async append(ev: LyncEventBody): Promise<AppendResult> {
    return this.ingest(serializeLyncEvent(ev), false);
  }

  async appendMany(events: EventBatch): Promise<AppendResult[]> {
    this.batchDepth += 1;
    try {
      const results: AppendResult[] = [];
      for await (const event of events) results.push(await this.ingest(serializeLyncEvent(event), false));
      return results;
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.batchDirty) {
        this.batchDirty = false;
        await this.persist();
      }
    }
  }

  async union(line: string): Promise<AppendResult> {
    return this.ingest(line, true);
  }

  async byId(id: string): Promise<StoredEvent | null> {
    return this.isConflicted(id) ? null : (this.events.get(id) ?? null);
  }

  async byRoot(rootId: string): Promise<StoredEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.root === rootId && !this.isConflicted(event.body.id))
      .sort(compareStored);
  }

  subscribe(rootId: string, listener: (ev: StoredEvent) => void): () => void {
    const set = this.listeners.get(rootId) ?? new Set();
    set.add(listener);
    this.listeners.set(rootId, set);
    return () => set.delete(listener);
  }

  async roots(kind?: "lync/loom" | "lync/index"): Promise<StoredEvent[]> {
    return [...this.events.values()]
      .filter((event) => !this.isConflicted(event.body.id))
      .filter((event) => event.body.id === event.root)
      .filter((event) => event.body.kind === "lync/loom" || event.body.kind === "lync/index")
      .filter((event) => kind === undefined || event.body.kind === kind)
      .sort(compareStored);
  }

  async exportRootBytes(rootId: string): Promise<string> {
    const events = await this.byRoot(rootId);
    return events.map((event) => event.bytes).join("\n") + (events.length ? "\n" : "");
  }

  async diagnostics(): Promise<EventStoreDiagnostics> {
    return {
      events: this.events.size,
      conflicts: this.conflicts.size,
      pending: this.pending.size,
      garbage: this.garbage.length,
    };
  }

  protected async loadRecords(records: {
    events?: StoreRecord[];
    conflicts?: ConflictRecord[];
    pending?: PendingRecord[];
    garbage?: GarbageRecord[];
  }): Promise<void> {
    for (const record of records.events ?? []) {
      const parsed = parseStoredLine(record.bytes);
      if (parsed.ok) this.events.set(parsed.event.body.id, { ...parsed.event, root: record.root });
    }
    for (const record of records.conflicts ?? []) {
      this.conflicts.set(conflictKey(record.id, record.digest), record);
    }
    for (const record of records.pending ?? []) {
      this.pending.set(pendingKey(record.missingParent, record.digest), record);
    }
    this.garbage.push(...(records.garbage ?? []));
  }

  protected dumpRecords(): {
    events: StoreRecord[];
    conflicts: ConflictRecord[];
    pending: PendingRecord[];
    garbage: GarbageRecord[];
  } {
    return {
      events: [...this.events.values()].map((event) => ({
        id: event.body.id,
        root: event.root,
        kind: event.body.kind,
        at: event.body.at,
        bytes: event.bytes,
      })),
      conflicts: [...this.conflicts.values()],
      pending: [...this.pending.values()],
      garbage: [...this.garbage],
    };
  }

  protected async persist(): Promise<void> {}

  private async persistMutation(): Promise<void> {
    if (this.batchDepth > 0) {
      this.batchDirty = true;
      return;
    }
    await this.persist();
  }

  private async ingest(line: string, allowBuffer: boolean): Promise<AppendResult> {
    const parsed = parseStoredLine(line);
    if (!parsed.ok) {
      const result = { status: "garbage", reason: parsed.reason, bytes: line } as const;
      this.garbage.push({ reason: parsed.reason, bytes: line });
      await this.persistMutation();
      return result;
    }

    const body = parsed.event.body;
    const known = validateKnownLyncEvent(body);
    if (known !== null) {
      const result = { status: "garbage", reason: known, bytes: line } as const;
      this.garbage.push({ reason: known, bytes: line });
      await this.persistMutation();
      return result;
    }

    const parent = body.parents[0];
    const root =
      body.parents.length === 0
        ? body.id
        : this.events.get(parent)?.root;
    if (root === undefined) {
      if (!allowBuffer) {
        const result = { status: "garbage", reason: `missing parent: ${parent}`, bytes: line } as const;
        this.garbage.push({ reason: result.reason, bytes: line });
        await this.persistMutation();
        return result;
      }
      const record = { missingParent: parent, digest: bodyDigest(parsed.bodyBytes), bytes: line };
      this.pending.set(pendingKey(record.missingParent, record.digest), record);
      await this.persistMutation();
      return { status: "buffered", missingParent: parent, bytes: line };
    }

    const event = { ...parsed.event, root };
    const existing = this.events.get(body.id);
    if (existing) {
      if (stripSplice(existing.bytes) === stripSplice(line)) {
        if (isRicherLine(line, existing.bytes)) {
          this.events.set(body.id, event);
          await this.persistMutation();
        }
        return { status: "duplicate", event: this.events.get(body.id)! };
      }
      const digest = bodyDigest(parsed.bodyBytes);
      const existingDigest = bodyDigest(new TextEncoder().encode(stripSplice(existing.bytes)));
      this.conflicts.set(conflictKey(existing.body.id, existingDigest), {
        id: existing.body.id,
        digest: existingDigest,
        root: existing.root,
        bytes: existing.bytes,
      });
      this.conflicts.set(conflictKey(body.id, digest), { id: body.id, digest, root, bytes: line });
      await this.persistMutation();
      return { status: "conflict", event, conflictWith: existing };
    }

    this.events.set(body.id, event);
    await this.persistMutation();
    this.emit(event);
    await this.drain(body.id);
    return { status: "added", event };
  }

  private async drain(parentId: string): Promise<void> {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const record of [...this.pending.values()].filter((item) => item.missingParent === parentId)) {
        this.pending.delete(pendingKey(record.missingParent, record.digest));
        await this.ingest(record.bytes, true);
        progressed = true;
      }
    }
  }

  private emit(event: StoredEvent): void {
    for (const listener of this.listeners.get(event.root) ?? []) listener(event);
  }

  private isConflicted(id: string): boolean {
    for (const conflict of this.conflicts.values()) if (conflict.id === id) return true;
    return false;
  }
}

export function serializeLyncEvent(ev: LyncEventBody): string {
  const fields: [string, unknown][] = [
    ["v", ev.v],
    ["id", ev.id],
    ["kind", ev.kind],
    ["at", ev.at],
    ["author", ev.author],
    ["parents", ev.parents],
    ["payload", ev.payload],
  ];
  if (ev.marked !== undefined) fields.push(["marked", ev.marked]);
  if (ev.critical !== undefined) fields.push(["critical", ev.critical]);
  return `{${fields.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(",")}}`;
}

function parseStoredLine(line: string):
  | { ok: true; event: StoredEvent; bodyBytes: Uint8Array }
  | { ok: false; reason: string } {
  const normalized = line.endsWith("\n") ? line.slice(0, -1) : line;
  const parsed = parseLyncFiles([{ file: "<store>", bytes: `${normalized}\n` }]);
  const diagnostic = parsed.lines[0];
  if (!diagnostic?.event || (diagnostic.class !== "accepted" && diagnostic.class !== "nonconforming")) {
    return { ok: false, reason: diagnostic?.reason ?? "unparseable lync line" };
  }
  return {
    ok: true,
    event: { body: diagnostic.event, bytes: normalized, root: diagnostic.event.id },
    bodyBytes: diagnostic.bodyBytes ?? new TextEncoder().encode(stripSplice(normalized)),
  };
}

function validateKnownLyncEvent(body: LyncEventBody): string | null {
  if (!body.kind.startsWith("lync/")) return null;
  if (body.kind === "lync/loom" || body.kind === "lync/index") {
    return body.parents.length === 0 ? null : `${body.kind} must not have parents`;
  }
  if (body.kind === "lync/turn") {
    if (body.parents.length !== 1) return "lync/turn must have exactly one parent";
    if (!Number.isInteger(body.payload.ordinal) || (body.payload.ordinal as number) < 0) {
      return "lync/turn payload.ordinal must be a non-negative integer";
    }
    if (!("payload" in body.payload)) return "lync/turn payload.payload is required";
    return null;
  }
  if (body.kind === "lync/loom-meta") {
    if (body.parents.length !== 1) return "lync/loom-meta must have exactly one parent";
    if (!("meta" in body.payload)) return "lync/loom-meta payload.meta is required";
    return null;
  }
  if (body.kind === "lync/index-meta") {
    if (body.parents.length !== 1) return "lync/index-meta must have exactly one parent";
    if (!("meta" in body.payload)) return "lync/index-meta payload.meta is required";
    return null;
  }
  if (body.kind === "lync/index-entry") {
    if (body.parents.length !== 1) return "lync/index-entry must have exactly one parent";
    if (typeof body.payload.loomId !== "string") return "lync/index-entry payload.loomId is required";
    if ("ordinal" in body.payload && (!Number.isInteger(body.payload.ordinal) || (body.payload.ordinal as number) < 0)) {
      return "lync/index-entry payload.ordinal must be a non-negative integer";
    }
    return null;
  }
  return null;
}

function compareStored(a: StoredEvent, b: StoredEvent): number {
  return a.body.at.localeCompare(b.body.at) || a.body.id.localeCompare(b.body.id);
}

function stripSplice(line: string): string {
  return line.replace(/,"digest":"sha256:[0-9a-f]{64}"(?:,"sig":"[A-Za-z0-9+/]+={0,2}")?}$/, "}");
}

function bodyDigest(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

function conflictKey(id: string, digest: string): string {
  return `${id}\0${digest}`;
}

function pendingKey(missingParent: string, digest: string): string {
  return `${missingParent}\0${digest}`;
}

function isRicherLine(candidate: string, current: string): boolean {
  const score = (line: string) => (line.includes(',"digest"') ? 1 : 0) + (line.includes(',"sig"') ? 1 : 0);
  return score(candidate) > score(current);
}
