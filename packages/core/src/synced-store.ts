import type { EventStore, StoredEvent, AppendResult } from "./store.js";
import type { LyncEventBody } from "./events.js";
import { decodeFrame, encodeFrame, type SyncFrame } from "./sync-protocol.js";

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
  onPresence?: (root: string, data: unknown) => void;
}

export interface SyncedStore extends EventStore {
  /** Begin syncing a root: push local backlog, then subscribe from the cursor. */
  syncRoot(rootId: string): void;
  /** Relay an ephemeral presence frame for a root; never stored. */
  presence(root: string, data: unknown): void;
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
  let connection: SyncConnectionState = transport.state;

  const emitStatus = () => {
    options.onStatus?.({
      connection,
      liveRoots: [...liveRoots],
      conflicts: [...conflicts],
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

  transport.onFrame((frame) => {
    switch (frame.t) {
      case "ev": {
        // Remote line: ingest through union WITHOUT re-pushing (the relay has
        // already fanned it out). Subscribers fire via the inner store.
        void inner.union(frame.line);
        if (typeof frame.seq === "number") {
          cursors.set(frame.root, Math.max(cursors.get(frame.root) ?? 0, frame.seq));
        }
        return;
      }
      case "live": {
        cursors.set(frame.root, Math.max(cursors.get(frame.root) ?? 0, frame.seq));
        liveRoots.add(frame.root);
        emitStatus();
        return;
      }
      case "presence": {
        options.onPresence?.(frame.root, frame.data);
        return;
      }
      case "err": {
        if (frame.reason === "same-id-conflict" && frame.detail) {
          conflicts.add(frame.detail);
          emitStatus();
        }
        return;
      }
      default:
        return;
    }
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
    presence: (root, data) => transport.send({ t: "presence", root, data }),
    status: () => ({ connection, liveRoots: [...liveRoots], conflicts: [...conflicts] }),
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
