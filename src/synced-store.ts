import type { EventStore, StoredEvent, AppendResult } from "./store.js";
import type { LyncEventBody } from "./events.js";
import { decodeFrame, encodeFrame, type LyncPresence, type SyncFrame } from "./sync-protocol.js";

/**
 * Live sync for an EventStore, built on the dumb line-union protocol.
 *
 * A synced store is an ordinary EventStore: looms and indexes built over it
 * recompute reactively through its existing `subscribe`, whether an event
 * arrived from a local append or a remote peer. The decorator adds exactly
 * two behaviors — local appends are pushed to the relay, and remote lines are
 * ingested through the same `union` path — because immutable events plus
 * union-by-id make redundancy harmless and merge logic unnecessary.
 *
 * The transport is abstract so this is testable without a socket. A
 * browser-and-Node WebSocket transport is provided below with zero
 * dependencies (global `WebSocket`, present in browsers and Node ≥ 21).
 */

export type SyncConnectionState = "connecting" | "online" | "offline";

export interface SyncStatus {
  connection: SyncConnectionState;
  /** Roots that have received their backlog and are live. */
  liveRoots: string[];
  /** Ids that arrived as same-id-different-body conflicts, surfaced never resolved. */
  conflicts: string[];
  /**
   * Every ingest failure, surfaced never swallowed: a remote line the local
   * store could not durably accept (store write threw) or rejected as
   * garbage. A store-write failure also freezes the root's resume cursor so
   * the line is re-fetched on the next resubscribe instead of being skipped.
   */
  failures: string[];
}

export interface SyncTransport {
  send(frame: SyncFrame): void;
  /** Register a frame handler; returns an unsubscribe. */
  onFrame(handler: (frame: SyncFrame) => void): () => void;
  /** Fires on every (re)connection, so callers can re-subscribe. */
  onOpen(handler: () => void): () => void;
  onStateChange(handler: (state: SyncConnectionState) => void): () => void;
  readonly state: SyncConnectionState;
  close(): void;
}

export interface SyncedStoreOptions {
  onStatus?: (status: SyncStatus) => void;
  /**
   * Fires for every inbound presence frame: the root, the sender's per-client
   * participant id, and the typed awareness payload. Ephemeral — never a stored
   * event. Feed this straight into a PresenceAwareness (see presence-awareness).
   */
  onPresence?: (root: string, client: string, presence: LyncPresence) => void;
}

export interface SyncedStore extends EventStore {
  /** Begin syncing a root: push local backlog, then subscribe from the cursor. */
  syncRoot(rootId: string): void;
  /** Relay an ephemeral presence frame for a root; never stored. */
  presence(root: string, client: string, data: LyncPresence): void;
  status(): SyncStatus;
  close(): void;
}

export function createSyncedStore(
  inner: EventStore,
  transport: SyncTransport,
  options: SyncedStoreOptions = {},
): SyncedStore {
  const syncedRoots = new Set<string>();
  const liveRoots = new Set<string>();
  const cursors = new Map<string, number>();
  const conflicts = new Set<string>();
  const failures: string[] = [];
  // Server log generation per root. A cursor is only meaningful inside the
  // generation that issued it (a failed relay disk write still consumes a
  // seq, so a restarted server's recovered log can sit BEHIND our cursor).
  // On a generation change the cursor resets to 0 and we resubscribe; union
  // makes the re-download duplicate no-ops.
  const generations = new Map<string, string>();
  // Roots whose cursor is frozen because a union failed (store write threw):
  // the cursor must not advance past the hole, or the line would be skipped
  // forever. Cleared on resync — the resubscribe re-fetches from the frozen
  // cursor and each refetched line advances it again as its union succeeds.
  const stalledRoots = new Set<string>();
  // Outstanding `sub` frames per root: each sub is answered by exactly one
  // `live`, in order. While a generation-reset sub is stacked behind an
  // earlier one (count > 1), cursor advances are suppressed — frames from the
  // superseded sub carry seqs the reset backlog has not re-covered yet, and
  // trusting them would re-poison the freshly reset cursor.
  const pendingLives = new Map<string, number>();
  let connection: SyncConnectionState = transport.state;

  const emitStatus = () => {
    options.onStatus?.({
      connection,
      liveRoots: [...liveRoots],
      conflicts: [...conflicts],
      failures: [...failures],
    });
  };

  const pushLine = (root: string, line: string) => {
    transport.send({ t: "ev", root, line });
  };

  const ensureSynced = (rootId: string) => {
    if (syncedRoots.has(rootId)) return;
    syncedRoots.add(rootId);
    void resync(rootId);
  };

  // Push a locally-added event. If its root isn't synced yet, begin syncing —
  // resync re-pushes the whole local backlog (this event included), so we must
  // not also push it here, or the relay sees it twice.
  const pushAdded = (event: StoredEvent) => {
    if (syncedRoots.has(event.root)) {
      pushLine(event.root, event.bytes);
    } else {
      ensureSynced(event.root);
    }
  };

  async function resync(rootId: string): Promise<void> {
    if (transport.state !== "online") return; // resumes on the next onOpen
    // Push any local events the relay may not have (offline appends included);
    // duplicates are no-ops under union on the server.
    for (const event of await inner.byRoot(rootId)) {
      pushLine(rootId, event.bytes);
    }
    // A frozen cursor thaws here: the sub below re-fetches from it, and each
    // refetched line advances it again as its union succeeds.
    stalledRoots.delete(rootId);
    // A fresh connection: any lives owed by subs on the dead connection will
    // never arrive, so the count restarts at this sub's one.
    pendingLives.set(rootId, 1);
    transport.send({ t: "sub", root: rootId, since: cursors.get(rootId) ?? 0 });
  }

  transport.onOpen(() => {
    for (const rootId of syncedRoots) void resync(rootId);
  });

  transport.onStateChange((state) => {
    connection = state;
    if (state !== "online") liveRoots.clear();
    emitStatus();
  });

  /**
   * Returns true when the server's generation differs from the one this root's
   * cursor belongs to — in which case the cursor has been reset to 0 and a
   * fresh `sub` from 0 is already on the wire. Frames without gen (old
   * servers) never trigger a reset.
   */
  const generationChanged = (root: string, gen: string | undefined): boolean => {
    if (gen === undefined) return false;
    const known = generations.get(root);
    if (known === gen) return false;
    generations.set(root, gen);
    if (known === undefined) return false; // first sighting: adopt
    failures.push(`generation changed for ${root} (${known} -> ${gen}); resyncing from 0`);
    cursors.set(root, 0);
    stalledRoots.delete(root);
    pendingLives.set(root, (pendingLives.get(root) ?? 0) + 1);
    emitStatus();
    transport.send({ t: "sub", root, since: 0 });
    return true;
  };

  const advanceCursor = (root: string, seq: number) => {
    if (stalledRoots.has(root)) return; // frozen behind a failed union
    if ((pendingLives.get(root) ?? 0) > 1) return; // a reset-sub's backlog is still owed
    cursors.set(root, Math.max(cursors.get(root) ?? 0, seq));
  };

  async function handleFrame(frame: SyncFrame): Promise<void> {
    switch (frame.t) {
      case "ev": {
        // Remote line: ingest through union WITHOUT re-pushing (the relay has
        // already fanned it out). Subscribers fire via the inner store. The
        // union is awaited and inspected BEFORE the cursor advances — a line
        // the local store failed to accept must be re-fetched, never skipped.
        generationChanged(frame.root, frame.gen);
        let outcome: AppendResult;
        try {
          outcome = await inner.union(frame.line);
        } catch (error) {
          // Store write failed: the line is NOT durable locally. Freeze the
          // cursor so the next resubscribe re-fetches it, and scream.
          failures.push(`store failed to ingest a synced line for ${frame.root}: ${String(error)}`);
          stalledRoots.add(frame.root);
          emitStatus();
          return;
        }
        switch (outcome.status) {
          case "conflict":
            conflicts.add(outcome.event.body.id);
            emitStatus();
            break;
          case "garbage":
            // Unusable bytes stay unusable on any re-fetch: surfaced loudly,
            // and the cursor may advance past them.
            failures.push(`synced line rejected as garbage for ${frame.root}: ${outcome.reason}`);
            emitStatus();
            break;
          default:
            break; // added / duplicate / buffered: durably in the store's hands
        }
        if (typeof frame.seq === "number") advanceCursor(frame.root, frame.seq);
        return;
      }
      case "live": {
        // A stale live is not live: either its generation is dead (the
        // resubscribe from 0 is already on the wire) or it answers a sub a
        // generation reset has since superseded. Wait for the real one.
        const changed = generationChanged(frame.root, frame.gen);
        const outstanding = Math.max(0, (pendingLives.get(frame.root) ?? 1) - 1);
        pendingLives.set(frame.root, outstanding);
        if (changed || outstanding > 0) return;
        advanceCursor(frame.root, frame.seq);
        liveRoots.add(frame.root);
        emitStatus();
        return;
      }
      case "presence": {
        options.onPresence?.(frame.root, frame.client, frame.data);
        return;
      }
      case "err": {
        if (frame.reason === "same-id-conflict" && frame.detail) {
          conflicts.add(frame.detail);
        } else {
          // Every other relay-side failure — persist-failed, conflict-persist-failed,
          // recovered-damaged-tail, line-without-id, unexpected-live-from-client,
          // server-error — is a failure the client must see, never a silent drop.
          // A durability failure on the relay reaches the client's status channel.
          const where = frame.root ? ` for ${frame.root}` : "";
          const detail = frame.detail ? ` (${frame.detail})` : "";
          failures.push(`relay error${where}: ${frame.reason}${detail}`);
        }
        emitStatus();
        return;
      }
      default:
        return;
    }
  }

  // Frames apply strictly in arrival order: each union is awaited before the
  // next frame is touched, so a slow union can never let a later frame (or a
  // `live` cursor jump) leapfrog a failure. handleFrame never rejects — the
  // catch above is the only throw path and it returns — but the chain guards
  // anyway so one surprise cannot wedge sync forever.
  let frameChain: Promise<void> = Promise.resolve();
  transport.onFrame((frame) => {
    frameChain = frameChain.then(
      () => handleFrame(frame),
      () => handleFrame(frame),
    );
  });

  return {
    async append(ev: LyncEventBody): Promise<AppendResult> {
      const result = await inner.append(ev);
      if (result.status === "added") pushAdded(result.event);
      return result;
    },
    async union(line: string): Promise<AppendResult> {
      const result = await inner.union(line);
      if (result.status === "added") pushAdded(result.event);
      return result;
    },
    byId: (id) => inner.byId(id),
    byRoot: (rootId) => {
      ensureSynced(rootId);
      return inner.byRoot(rootId);
    },
    subscribe: (rootId, listener) => {
      ensureSynced(rootId);
      return inner.subscribe(rootId, listener);
    },
    roots: (kind) => inner.roots(kind),
    ...(inner.exportRootBytes ? { exportRootBytes: (rootId: string) => inner.exportRootBytes!(rootId) } : {}),
    ...(inner.diagnostics ? { diagnostics: () => inner.diagnostics!() } : {}),
    syncRoot: ensureSynced,
    presence: (root, client, data) => transport.send({ t: "presence", root, client, data }),
    status: () => ({ connection, liveRoots: [...liveRoots], conflicts: [...conflicts], failures: [...failures] }),
    close: () => transport.close(),
  };
}

export interface WebSocketTransportOptions {
  /** Override the WebSocket constructor (e.g. `ws` in Node < 21, or a fake in tests). */
  WebSocketImpl?: typeof WebSocket;
  /** Reconnect backoff in ms. Default 1500. Set 0 to disable auto-reconnect. */
  reconnectMs?: number;
}

/**
 * A reconnecting WebSocket transport. Sends while offline are queued and
 * flushed on connect; a dropped socket schedules a reconnect and the synced
 * store re-subscribes via `onOpen`. Nothing is silently dropped: an unsent
 * frame waits in the queue rather than vanishing.
 */
export function createWebSocketTransport(url: string, options: WebSocketTransportOptions = {}): SyncTransport {
  const WS = options.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) {
    throw new Error("createWebSocketTransport: no WebSocket implementation available; pass options.WebSocketImpl");
  }
  const reconnectMs = options.reconnectMs ?? 1500;
  const frameHandlers = new Set<(frame: SyncFrame) => void>();
  const openHandlers = new Set<() => void>();
  const stateHandlers = new Set<(state: SyncConnectionState) => void>();
  const queue: SyncFrame[] = [];

  let socket: WebSocket | undefined;
  let state: SyncConnectionState = "connecting";
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const setState = (next: SyncConnectionState) => {
    if (state === next) return;
    state = next;
    for (const handler of stateHandlers) handler(next);
  };

  const connect = () => {
    if (closed) return;
    setState("connecting");
    const ws = new WS(url);
    socket = ws;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      setState("online");
      while (queue.length > 0) ws.send(encodeFrame(queue.shift()!));
      for (const handler of openHandlers) handler();
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      if (socket !== ws) return;
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const frame = decodeFrame(raw);
      for (const handler of frameHandlers) handler(frame);
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = undefined;
      setState("offline");
      scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      if (socket !== ws) return;
      // A failed connection surfaces as a close on most stacks; force it.
      try {
        ws.close();
      } catch {
        socket = undefined;
        setState("offline");
        scheduleReconnect();
      }
    });
  };

  const scheduleReconnect = () => {
    if (closed || reconnectMs <= 0 || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectMs);
  };

  connect();

  return {
    send(frame) {
      if (socket && state === "online" && socket.readyState === socket.OPEN) {
        socket.send(encodeFrame(frame));
      } else {
        queue.push(frame);
      }
    },
    onFrame(handler) {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    },
    onOpen(handler) {
      openHandlers.add(handler);
      return () => openHandlers.delete(handler);
    },
    onStateChange(handler) {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },
    get state() {
      return state;
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      socket = undefined;
      setState("offline");
    },
  };
}
