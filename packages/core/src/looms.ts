import {
  brokenTopology,
  closedHandle,
  cycleDetected,
  duplicateTurnId,
  invalidSnapshot,
  missingParent,
  unknownLoom,
} from "./errors.js";
import { assertJsonEncodable, cloneJson } from "./json.js";
import type {
  Loom,
  LoomEvent,
  LoomId,
  LoomInfo,
  LoomListener,
  Looms,
  LoomSnapshot,
  Turn,
  TurnId,
} from "./types.js";
import type { LyncEventBody } from "./events.js";
import { createIndexedDbEventStore, type IndexedDbEventStoreOptions } from "./idb-log.js";
import type { EventStore, StoredEvent } from "./store.js";

const LYNC_PREFIX = "lync:";

export interface LyncAuthor {
  actor: string;
  operator?: string;
  via?: string;
  imported_by?: string;
  source?: string;
}

export interface LyncLoomsOptions {
  store: EventStore;
  author: LyncAuthor;
  now?: () => number;
  createId?: () => string;
}

interface Fold<TPayload, TLoomMeta, TTurnMeta> {
  loom: LoomInfo<TLoomMeta>;
  turns: Map<TurnId, Turn<TPayload, TTurnMeta>>;
  children: Map<TurnId | null, TurnId[]>;
}

export function createLyncLooms<
  TPayload = unknown,
  TLoomMeta = unknown,
  TTurnMeta = unknown,
>(options: LyncLoomsOptions): Looms<TPayload, TLoomMeta, TTurnMeta> {
  validateAuthor(options.author);
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? createUuidLike;

  const mint = (
    kind: string,
    parents: string[],
    payload: Record<string, unknown>,
    atMs = now(),
    author: LyncAuthor = options.author,
    marked?: string,
  ): LyncEventBody => ({
    v: 1,
    id: createId(),
    kind,
    at: new Date(atMs).toISOString(),
    author: compactAuthor(author),
    parents,
    payload,
    ...(marked === undefined ? {} : { marked }),
  });

  return {
    async create(meta) {
      assertJsonEncodable(meta, "loom meta");
      const event = mint("lync/loom", [], omitUndefined({ meta: cloneJson(meta) }));
      const result = await options.store.append(event);
      if (result.status !== "added" && result.status !== "duplicate") {
        throw new Error(`Unable to create lync loom: ${result.status}`);
      }
      return eventToLoomInfo(result.event.body);
    },

    async get(loomId) {
      const root = rootId(loomId);
      if (!root) return null;
      const event = await options.store.byId(root);
      if (!event || event.body.kind !== "lync/loom") return null;
      return foldLoom<TPayload, TLoomMeta, TTurnMeta>(await options.store.byRoot(root), loomId).loom;
    },

    async open(loomId) {
      const root = rootId(loomId);
      if (!root) throw unknownLoom(loomId);
      const event = await options.store.byId(root);
      if (!event || event.body.kind !== "lync/loom") throw unknownLoom(loomId);
      return new LyncLoom<TPayload, TLoomMeta, TTurnMeta>(loomId, root, options.store, mint);
    },

    async import(snapshot) {
      validateSnapshot(snapshot);
      const importMarked = new Date(now()).toISOString();
      const sourceBase = `lync-import/${snapshot.loom.id}`;
      const loomEvent = mint(
        "lync/loom",
        [],
        omitUndefined({ meta: cloneJson(snapshot.loom.meta) }),
        snapshot.loom.createdAt,
        { ...options.author, source: sourceBase },
        importMarked,
      );
      await options.store.append(loomEvent);
      const newLoomId = `${LYNC_PREFIX}${loomEvent.id}`;
      const idMap = new Map<TurnId, TurnId>();
      const ordered = topological(snapshot.turns);
      const siblingOrdinal = new Map<TurnId | null, number>();
      for (const turn of ordered) {
        const parent = turn.parentId === null ? loomEvent.id : idMap.get(turn.parentId);
        if (!parent) throw missingParent(turn.parentId ?? "");
        const ordinalKey = turn.parentId;
        const ordinal = siblingOrdinal.get(ordinalKey) ?? 0;
        siblingOrdinal.set(ordinalKey, ordinal + 1);
        const event = mint(
          "lync/turn",
          [parent],
          omitUndefined({ payload: cloneJson(turn.payload), meta: cloneJson(turn.meta), ordinal }),
          turn.createdAt,
          { ...options.author, source: `${sourceBase}#${turn.id}` },
          importMarked,
        );
        await options.store.append(event);
        idMap.set(turn.id, event.id);
      }
      const fold = foldLoom<TPayload, TLoomMeta, TTurnMeta>(
        await options.store.byRoot(loomEvent.id),
        newLoomId,
      );
      return fold.loom;
    },
  };
}

export function createBrowserLyncLooms<
  TPayload = unknown,
  TLoomMeta = unknown,
  TTurnMeta = unknown,
>(idbOptions: IndexedDbEventStoreOptions & Omit<LyncLoomsOptions, "store">): Looms<TPayload, TLoomMeta, TTurnMeta> {
  const { author, now, createId, ...storeOptions } = idbOptions;
  return createLyncLooms({ author, now, createId, store: createIndexedDbEventStore(storeOptions) });
}

class LyncLoom<TPayload, TLoomMeta, TTurnMeta>
  implements Loom<TPayload, TLoomMeta, TTurnMeta>
{
  private closed = false;
  private readonly listeners = new Set<LoomListener<TPayload, TLoomMeta, TTurnMeta>>();
  private readonly unsubscribe: () => void;

  constructor(
    readonly id: LoomId,
    private readonly root: string,
    private readonly store: EventStore,
    private readonly mint: (
      kind: string,
      parents: string[],
      payload: Record<string, unknown>,
      atMs?: number,
    ) => LyncEventBody,
  ) {
    this.unsubscribe = store.subscribe(root, async (event) => {
      if (this.closed) return;
      if (event.body.kind === "lync/turn") {
        const fold = await this.fold();
        const turn = fold.turns.get(event.body.id);
        if (turn) this.emit({ type: "turn-added", loomId: this.id, turn: cloneJson(turn) });
      }
      if (event.body.kind === "lync/loom-meta") {
        this.emit({ type: "loom-updated", loom: await this.info() });
      }
    });
  }

  async info(): Promise<LoomInfo<TLoomMeta>> {
    this.assertOpen();
    return cloneJson((await this.fold()).loom);
  }

  async updateMeta(meta: TLoomMeta): Promise<LoomInfo<TLoomMeta>> {
    this.assertOpen();
    assertJsonEncodable(meta, "loom meta");
    const result = await this.store.append(this.mint("lync/loom-meta", [this.root], { meta: cloneJson(meta) }));
    if (result.status !== "added" && result.status !== "duplicate") {
      throw new Error(`Unable to update loom meta: ${result.status}`);
    }
    return this.info();
  }

  async appendTurn(
    parentId: TurnId | null,
    payload: TPayload,
    meta?: TTurnMeta,
  ): Promise<Turn<TPayload, TTurnMeta>> {
    this.assertOpen();
    assertJsonEncodable(payload, "turn payload");
    assertJsonEncodable(meta, "turn meta");
    const fold = await this.fold();
    if (parentId !== null && !fold.turns.has(parentId)) throw missingParent(parentId);
    const parent = parentId ?? this.root;
    const ordinal = (fold.children.get(parentId) ?? []).length;
    const result = await this.store.append(
      this.mint("lync/turn", [parent], omitUndefined({ payload: cloneJson(payload), meta: cloneJson(meta), ordinal })),
    );
    if (result.status === "duplicate" || result.status === "conflict") throw duplicateTurnId(result.event.body.id);
    if (result.status !== "added") throw new Error(`Unable to append turn: ${result.status}`);
    const next = await this.fold();
    const turn = next.turns.get(result.event.body.id);
    if (!turn) throw brokenTopology(`Appended turn missing from fold: ${result.event.body.id}`);
    return cloneJson(turn);
  }

  async getTurn(turnId: TurnId): Promise<Turn<TPayload, TTurnMeta> | null> {
    this.assertOpen();
    return cloneJson((await this.fold()).turns.get(turnId) ?? null);
  }

  async hasTurn(turnId: TurnId): Promise<boolean> {
    this.assertOpen();
    return (await this.fold()).turns.has(turnId);
  }

  async childrenOf(parentId: TurnId | null): Promise<Turn<TPayload, TTurnMeta>[]> {
    this.assertOpen();
    const fold = await this.fold();
    if (parentId !== null && !fold.turns.has(parentId)) throw missingParent(parentId);
    return cloneJson((fold.children.get(parentId) ?? []).map((id) => mustTurn(fold, id)));
  }

  async threadTo(turnId: TurnId): Promise<Turn<TPayload, TTurnMeta>[]> {
    this.assertOpen();
    const fold = await this.fold();
    const thread: Turn<TPayload, TTurnMeta>[] = [];
    const seen = new Set<TurnId>();
    let current: TurnId | null = turnId;
    while (current !== null) {
      if (seen.has(current)) throw cycleDetected(current);
      seen.add(current);
      const turn = fold.turns.get(current);
      if (!turn) throw brokenTopology(`Thread references missing turn: ${current}`);
      thread.push(turn);
      current = turn.parentId;
    }
    return cloneJson(thread.reverse());
  }

  async leaves(): Promise<Turn<TPayload, TTurnMeta>[]> {
    this.assertOpen();
    const fold = await this.fold();
    const leaves: Turn<TPayload, TTurnMeta>[] = [];
    const visit = (parent: TurnId | null) => {
      for (const id of fold.children.get(parent) ?? []) {
        const turn = mustTurn(fold, id);
        if ((fold.children.get(id) ?? []).length === 0) leaves.push(turn);
        else visit(id);
      }
    };
    visit(null);
    return cloneJson(leaves);
  }

  subscribe(listener: LoomListener<TPayload, TLoomMeta, TTurnMeta>): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async export(): Promise<LoomSnapshot<TPayload, TLoomMeta, TTurnMeta>> {
    this.assertOpen();
    const fold = await this.fold();
    const turns: Turn<TPayload, TTurnMeta>[] = [];
    const visit = (parent: TurnId | null) => {
      for (const id of fold.children.get(parent) ?? []) {
        const turn = mustTurn(fold, id);
        turns.push(turn);
        visit(id);
      }
    };
    visit(null);
    return cloneJson({ loom: fold.loom, turns });
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.unsubscribe();
  }

  private async fold(): Promise<Fold<TPayload, TLoomMeta, TTurnMeta>> {
    return foldLoom(await this.store.byRoot(this.root), this.id);
  }

  private assertOpen(): void {
    if (this.closed) throw closedHandle();
  }

  private emit(event: LoomEvent<TPayload, TLoomMeta, TTurnMeta>): void {
    for (const listener of this.listeners) listener(event);
  }
}

function foldLoom<TPayload, TLoomMeta, TTurnMeta>(
  events: StoredEvent[],
  loomId: LoomId,
): Fold<TPayload, TLoomMeta, TTurnMeta> {
  const root = events.find((event) => event.body.kind === "lync/loom" && `${LYNC_PREFIX}${event.body.id}` === loomId);
  if (!root) throw unknownLoom(loomId);
  let loom = eventToLoomInfo<TLoomMeta>(root.body);
  const metaEvents = events.filter((event) => event.body.kind === "lync/loom-meta").sort(compareNewest);
  const newestMeta = metaEvents[metaEvents.length - 1];
  if (newestMeta) {
    loom = omitUndefined({ ...loom, meta: cloneJson(newestMeta.body.payload.meta as TLoomMeta) });
  }
  const turns = new Map<TurnId, Turn<TPayload, TTurnMeta>>();
  const children = new Map<TurnId | null, TurnId[]>([[null, []]]);
  const turnEvents = events.filter((event) => event.body.kind === "lync/turn");
  for (const event of turnEvents.sort(compareTurnOrder)) {
    const parentEventId = event.body.parents[0];
    const parentId = parentEventId === root.body.id ? null : parentEventId;
    const turn = omitUndefined({
      id: event.body.id,
      loomId,
      parentId,
      payload: cloneJson(event.body.payload.payload as TPayload),
      meta: cloneJson(event.body.payload.meta as TTurnMeta),
      createdAt: Date.parse(event.body.at),
    });
    turns.set(turn.id, turn);
    children.set(turn.id, children.get(turn.id) ?? []);
    const bucket = children.get(parentId) ?? [];
    bucket.push(turn.id);
    children.set(parentId, bucket);
  }
  return { loom, turns, children };
}

function eventToLoomInfo<TMeta = unknown>(event: LyncEventBody): LoomInfo<TMeta> {
  return omitUndefined({
    id: `${LYNC_PREFIX}${event.id}`,
    meta: cloneJson(event.payload.meta as TMeta),
    createdAt: Date.parse(event.at),
  });
}

function compareNewest(a: StoredEvent, b: StoredEvent): number {
  return a.body.at.localeCompare(b.body.at) || a.body.id.localeCompare(b.body.id);
}

function compareTurnOrder(a: StoredEvent, b: StoredEvent): number {
  return (
    Number(a.body.payload.ordinal) - Number(b.body.payload.ordinal) ||
    a.body.id.localeCompare(b.body.id)
  );
}

function mustTurn<TPayload, TTurnMeta>(fold: Fold<TPayload, unknown, TTurnMeta>, id: TurnId) {
  const turn = fold.turns.get(id);
  if (!turn) throw brokenTopology(`Child list references missing turn: ${id}`);
  return turn;
}

function rootId(id: LoomId): string | null {
  return id.startsWith(LYNC_PREFIX) ? id.slice(LYNC_PREFIX.length) : null;
}

function validateAuthor(author: LyncAuthor): void {
  if (!author || typeof author.actor !== "string" || author.actor.length === 0) {
    throw new Error("Lync author.actor is required");
  }
}

function compactAuthor(author: LyncAuthor): LyncEventBody["author"] {
  return omitUndefined({
    actor: author.actor,
    operator: author.operator || undefined,
    via: author.via || undefined,
    imported_by: author.imported_by || undefined,
    source: author.source || undefined,
  });
}

function validateSnapshot(snapshot: LoomSnapshot<unknown, unknown, unknown>): void {
  if (!snapshot || typeof snapshot !== "object") throw invalidSnapshot("Snapshot must be an object");
  if (!snapshot.loom || typeof snapshot.loom.id !== "string") throw invalidSnapshot("Snapshot needs a loom id");
  if (!Array.isArray(snapshot.turns)) throw invalidSnapshot("Snapshot turns must be an array");
  assertJsonEncodable(snapshot, "loom snapshot");
  const ids = new Set<TurnId>();
  for (const turn of snapshot.turns) {
    if (!turn || typeof turn.id !== "string") throw invalidSnapshot("Every turn needs a string id");
    if (ids.has(turn.id)) throw duplicateTurnId(turn.id);
    if (turn.loomId !== snapshot.loom.id) throw invalidSnapshot(`Turn ${turn.id} belongs to ${turn.loomId}, expected ${snapshot.loom.id}`);
    ids.add(turn.id);
  }
  for (const turn of snapshot.turns) {
    if (turn.parentId !== null && !ids.has(turn.parentId)) throw missingParent(turn.parentId);
  }
  topological(snapshot.turns);
}

function topological<T extends { id: TurnId; parentId: TurnId | null }>(turns: T[]): T[] {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const ordered: T[] = [];
  const visiting = new Set<TurnId>();
  const visited = new Set<TurnId>();
  const visit = (turn: T) => {
    if (visited.has(turn.id)) return;
    if (visiting.has(turn.id)) throw cycleDetected(turn.id);
    visiting.add(turn.id);
    if (turn.parentId !== null) {
      const parent = byId.get(turn.parentId);
      if (!parent) throw missingParent(turn.parentId);
      visit(parent);
    }
    visiting.delete(turn.id);
    visited.add(turn.id);
    ordered.push(turn);
  };
  for (const turn of turns) visit(turn);
  return ordered;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function createUuidLike(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
