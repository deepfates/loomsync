import type { LyncPresence } from "./sync-protocol.js";

/**
 * Client-side awareness on top of lync's ephemeral presence frame.
 *
 * The relay is a stateless fanout: it holds no roster and persists nothing.
 * Every participant instead maintains its OWN view of who is present by
 * listening to the presence frames the relay echoes. This module is that view
 * — a per-root, per-participant state machine implementing the pinned presence
 * contract:
 *
 *   - Identity is a per-client id (a participant). One `actor` (human) may run
 *     several clients; the map is keyed by client, never by actor.
 *   - `clock` is a monotonic uint minted by the sender. A remote entry's STATE
 *     is applied IFF its clock is strictly greater than the last one seen from
 *     that client — last-writer-wins per participant, no CRDT merge.
 *   - Any inbound frame (even a stale-clock heartbeat) counts as "heard from"
 *     and refreshes lastSeen; a participant not heard from within the TTL is
 *     removed locally. Liveness (heard-from) and versioning (clock) are
 *     separate on purpose, so a heartbeat need not burn a new clock.
 *   - `state === null` is a graceful leave: remove that participant at once.
 *   - Self re-broadcasts its current state on a heartbeat so late joiners and
 *     peers who TTL'd it out recover it.
 *
 * The machine is pure and injectable: `receive`, `sweep`, and `heartbeat` are
 * driven explicitly (deterministic in tests with an injected `now`), while
 * `start()` wires real intervals over them for production use.
 */

/** A present participant, as this client currently sees them. */
export interface PresenceParticipant {
  /** The sender's per-client participant id (the map key). */
  client: string;
  /** Their last applied non-null state (they are present, so state is set). */
  state: NonNullable<LyncPresence["state"]>;
  /** The clock of that applied state. */
  clock: number;
  /** `now` at which we last heard ANY frame from this client. */
  lastSeen: number;
}

/** What changed in one roster transition, keyed by client via each entry. */
export interface PresenceDelta {
  added: PresenceParticipant[];
  updated: PresenceParticipant[];
  /** Their last known state before they left / timed out. */
  removed: PresenceParticipant[];
}

export interface PresenceAwarenessOptions {
  /** This client's stable participant id. Defaults to a random id. */
  client?: string;
  /** Outbound: send a presence frame. Wire to `SyncedStore.presence`. */
  send: (root: string, client: string, data: LyncPresence) => void;
  /** Fires whenever a root's remote roster changes. */
  onDelta?: (root: string, delta: PresenceDelta) => void;
  /** Self re-broadcast period, ms. Default 15_000. */
  heartbeatMs?: number;
  /** Remove a participant not heard from within this many ms. Default 30_000. */
  ttlMs?: number;
  /** How often `start()` runs the TTL sweep, ms. Default = heartbeatMs. */
  sweepMs?: number;
  /** Injectable clock (ms). Default `Date.now`. */
  now?: () => number;
}

type Timer = ReturnType<typeof setInterval>;

interface LocalRoot {
  clock: number;
  /** Our last SENT state for this root; null once we have left. */
  state: LyncPresence["state"];
}

export interface PresenceAwareness {
  /** This client's participant id (the `client` on every frame it sends). */
  readonly client: string;
  /**
   * Publish this client's presence on a root. Mints a strictly-greater clock,
   * remembers the state for heartbeats, and sends the frame. Pass `null` to
   * leave gracefully (peers remove this client immediately). Returns the clock.
   */
  setLocal(root: string, state: LyncPresence["state"], now?: number): number;
  /** Ingest one inbound presence frame (from `SyncedStore.onPresence`). */
  receive(root: string, client: string, presence: LyncPresence, now?: number): void;
  /** Re-broadcast current local state on every joined root (heartbeat tick). */
  heartbeat(now?: number): void;
  /** Remove participants past the TTL on every root (sweep tick). */
  sweep(now?: number): void;
  /** Current remote roster for a root (excludes self). */
  roster(root: string): PresenceParticipant[];
  /** Begin real-timer heartbeats + TTL sweeps. Idempotent. */
  start(): void;
  /** Stop timers and leave every joined root gracefully. */
  stop(): void;
}

let idCounter = 0;
function defaultClientId(): string {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `client-${Date.now().toString(36)}-${idCounter}-${rand}`;
}

export function createPresenceAwareness(options: PresenceAwarenessOptions): PresenceAwareness {
  const client = options.client ?? defaultClientId();
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const ttlMs = options.ttlMs ?? 30_000;
  const sweepMs = options.sweepMs ?? heartbeatMs;
  const now = options.now ?? (() => Date.now());

  // Remote participants: root -> client -> entry. Never contains `client`.
  const rosters = new Map<string, Map<string, PresenceParticipant>>();
  // Our own last-sent state per root, for heartbeats.
  const locals = new Map<string, LocalRoot>();
  let heartbeatTimer: Timer | undefined;
  let sweepTimer: Timer | undefined;

  const view = (p: PresenceParticipant): PresenceParticipant => ({ ...p, state: { ...p.state } });

  const emit = (root: string, delta: PresenceDelta) => {
    if (delta.added.length === 0 && delta.updated.length === 0 && delta.removed.length === 0) return;
    options.onDelta?.(root, delta);
  };

  const rosterFor = (root: string): Map<string, PresenceParticipant> => {
    let m = rosters.get(root);
    if (!m) {
      m = new Map();
      rosters.set(root, m);
    }
    return m;
  };

  return {
    client,

    setLocal(root, state, at = now()) {
      const prev = locals.get(root);
      const clock = (prev?.clock ?? 0) + 1;
      locals.set(root, { clock, state });
      // A graceful leave need not keep re-broadcasting; drop the local record
      // AFTER sending the null so the frame still carries the bumped clock.
      const data: LyncPresence = { clock, state };
      options.send(root, client, data);
      if (state === null) locals.delete(root);
      void at; // `at` reserved for callers that pin send time; clock is the ordering key
      return clock;
    },

    receive(root, from, presence, at = now()) {
      if (from === client) return; // never track ourselves
      const map = rosterFor(root);
      const entry = map.get(from);

      // Stale or equal clock: still "heard from" (refresh liveness), but LWW
      // rejects the state — no transition. A heartbeat re-sending the same
      // clock lands here for peers who already have us.
      if (entry && presence.clock <= entry.clock) {
        entry.lastSeen = at;
        return;
      }

      // Strictly newer clock (or a client we do not know yet).
      if (presence.state === null) {
        // Graceful leave. Unknown client: nothing to remove.
        if (entry) {
          map.delete(from);
          emit(root, { added: [], updated: [], removed: [view(entry)] });
        }
        return;
      }

      if (entry) {
        entry.clock = presence.clock;
        entry.state = presence.state;
        entry.lastSeen = at;
        emit(root, { added: [], updated: [view(entry)], removed: [] });
      } else {
        const fresh: PresenceParticipant = {
          client: from,
          state: presence.state,
          clock: presence.clock,
          lastSeen: at,
        };
        map.set(from, fresh);
        emit(root, { added: [view(fresh)], updated: [], removed: [] });
      }
    },

    heartbeat(at = now()) {
      for (const [root, local] of locals) {
        if (local.state === null) continue;
        // Re-send WITHOUT bumping the clock: this is liveness, not a new state.
        options.send(root, client, { clock: local.clock, state: local.state });
      }
      void at;
    },

    sweep(at = now()) {
      for (const [root, map] of rosters) {
        const removed: PresenceParticipant[] = [];
        for (const [from, entry] of map) {
          if (at - entry.lastSeen > ttlMs) {
            map.delete(from);
            removed.push(view(entry));
          }
        }
        if (removed.length > 0) emit(root, { added: [], updated: [], removed });
      }
    },

    roster(root) {
      const map = rosters.get(root);
      return map ? [...map.values()].map(view) : [];
    },

    start() {
      if (heartbeatTimer === undefined) {
        heartbeatTimer = setInterval(() => this.heartbeat(), heartbeatMs);
        if (typeof (heartbeatTimer as { unref?: () => void }).unref === "function") {
          (heartbeatTimer as { unref: () => void }).unref();
        }
      }
      if (sweepTimer === undefined) {
        sweepTimer = setInterval(() => this.sweep(), sweepMs);
        if (typeof (sweepTimer as { unref?: () => void }).unref === "function") {
          (sweepTimer as { unref: () => void }).unref();
        }
      }
    },

    stop() {
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      // Leave every root we are still present on.
      for (const [root, local] of [...locals]) {
        if (local.state !== null) this.setLocal(root, null);
      }
    },
  };
}
