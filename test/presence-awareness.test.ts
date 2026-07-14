import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresenceAwareness, type PresenceDelta } from "@deepfates/lync/presence-awareness";
import type { LyncPresence } from "@deepfates/lync/sync-protocol";

/**
 * The awareness state machine in isolation — driven deterministically, and
 * once over REAL setInterval timers (fake-clocked) to prove start()'s
 * heartbeat + TTL wiring, not just the hand-driven methods.
 */

function collector() {
  const deltas: Array<{ root: string; delta: PresenceDelta }> = [];
  return {
    deltas,
    onDelta: (root: string, delta: PresenceDelta) => deltas.push({ root, delta }),
    added: () => deltas.flatMap((d) => d.delta.added.map((p) => p.client)),
    updated: () => deltas.flatMap((d) => d.delta.updated.map((p) => p.client)),
    removed: () => deltas.flatMap((d) => d.delta.removed.map((p) => p.client)),
  };
}

describe("presence awareness state machine", () => {
  it("adds, updates, and LWW-rejects a stale clock per participant", () => {
    const c = collector();
    const aware = createPresenceAwareness({ client: "me", send: () => {}, onDelta: c.onDelta });

    aware.receive("story", "peer", { clock: 1, state: { actor: "bob", typing: false } }, 1000);
    aware.receive("story", "peer", { clock: 3, state: { actor: "bob", typing: true } }, 1100);
    // Stale clock (< last applied): no state transition, but still heard-from.
    aware.receive("story", "peer", { clock: 2, state: { actor: "bob", typing: false } }, 1200);

    expect(c.added()).toEqual(["peer"]);
    expect(c.updated()).toEqual(["peer"]);
    const roster = aware.roster("story");
    expect(roster).toHaveLength(1);
    expect(roster[0].state.typing).toBe(true); // clock-3 state, not clock-2
    expect(roster[0].lastSeen).toBe(1200); // stale frame still refreshed liveness
  });

  it("never tracks itself", () => {
    const c = collector();
    const aware = createPresenceAwareness({ client: "me", send: () => {}, onDelta: c.onDelta });
    aware.receive("story", "me", { clock: 1, state: { actor: "alice" } }, 0);
    expect(aware.roster("story")).toEqual([]);
    expect(c.deltas).toEqual([]);
  });

  it("removes a participant immediately on a state=null leave", () => {
    const c = collector();
    const aware = createPresenceAwareness({ client: "me", send: () => {}, onDelta: c.onDelta });
    aware.receive("story", "peer", { clock: 1, state: { actor: "bob" } }, 0);
    aware.receive("story", "peer", { clock: 2, state: null }, 10);
    expect(c.removed()).toEqual(["peer"]);
    expect(aware.roster("story")).toEqual([]);
  });

  it("removes a participant past the TTL on sweep, and a heartbeat clock refreshes liveness", () => {
    const c = collector();
    const aware = createPresenceAwareness({
      client: "me",
      send: () => {},
      onDelta: c.onDelta,
      ttlMs: 100,
    });
    aware.receive("story", "peer", { clock: 1, state: { actor: "bob" } }, 0);
    // Heartbeat at t=80 re-sends the SAME clock; must still refresh lastSeen.
    aware.receive("story", "peer", { clock: 1, state: { actor: "bob" } }, 80);
    aware.sweep(150); // 150 - 80 = 70 <= 100 ttl -> survives
    expect(aware.roster("story")).toHaveLength(1);
    aware.sweep(200); // 200 - 80 = 120 > 100 -> removed
    expect(c.removed()).toEqual(["peer"]);
    expect(aware.roster("story")).toEqual([]);
  });

  it("recovers a TTL-dropped participant from a later same-clock heartbeat", () => {
    const c = collector();
    const aware = createPresenceAwareness({ client: "me", send: () => {}, onDelta: c.onDelta, ttlMs: 100 });
    aware.receive("story", "peer", { clock: 5, state: { actor: "bob" } }, 0);
    aware.sweep(200); // dropped
    expect(aware.roster("story")).toEqual([]);
    // Same clock arrives again -> unknown client now -> re-added.
    aware.receive("story", "peer", { clock: 5, state: { actor: "bob" } }, 210);
    expect(aware.roster("story").map((p) => p.client)).toEqual(["peer"]);
    expect(c.added()).toEqual(["peer", "peer"]);
  });

  it("setLocal mints strictly-increasing clocks and sends typed frames", () => {
    const sent: Array<{ root: string; client: string; data: LyncPresence }> = [];
    const aware = createPresenceAwareness({
      client: "me",
      send: (root, client, data) => sent.push({ root, client, data }),
    });
    const c1 = aware.setLocal("story", { actor: "me", typing: true });
    const c2 = aware.setLocal("story", { actor: "me", typing: false });
    const c3 = aware.setLocal("story", null); // leave
    expect([c1, c2, c3]).toEqual([1, 2, 3]);
    expect(sent.map((s) => s.client)).toEqual(["me", "me", "me"]);
    expect(sent[2].data.state).toBeNull();
  });

  describe("real timers (start/stop)", () => {
    afterEach(() => vi.useRealTimers());

    it("emits heartbeats every heartbeatMs and sweeps stale peers at ttl", () => {
      vi.useFakeTimers();
      const sent: LyncPresence[] = [];
      const c = collector();
      const aware = createPresenceAwareness({
        client: "me",
        send: (_root, _client, data) => sent.push(data),
        onDelta: c.onDelta,
        heartbeatMs: 1000,
        ttlMs: 2500,
        sweepMs: 1000,
        now: () => Date.now(),
      });
      aware.setLocal("story", { actor: "me", typing: false }); // clock 1, sent once
      aware.receive("story", "peer", { clock: 1, state: { actor: "bob" } });
      aware.start();

      vi.advanceTimersByTime(3000); // 3 heartbeats + 3 sweeps
      // Heartbeats re-sent our state (same clock 1) 3 times, plus the initial send.
      expect(sent.length).toBe(4);
      expect(sent.every((d) => d.clock === 1)).toBe(true);
      // Peer last heard at t=0; by t=3000 that is > 2500 ttl -> swept.
      expect(c.removed()).toEqual(["peer"]);

      aware.stop();
      const after = sent.length;
      vi.advanceTimersByTime(5000);
      expect(sent.length).toBe(after); // timers cleared -> no more heartbeats
    });
  });
});
