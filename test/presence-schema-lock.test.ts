import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  type LyncPresence,
  type PresenceFrame,
} from "@deepfates/lync/sync-protocol";

/**
 * SCHEMA LOCK — the pinned presence contract, pinned in code.
 *
 * This is the seam a co-author (textile) builds to. It asserts the EXACT wire
 * shape of the awareness payload so neither side can drift it silently: a
 * change to the presence frame or LyncPresence that breaks this test is a
 * deliberate, reviewed contract change, never an accident.
 */
describe("presence schema lock (pinned contract)", () => {
  it("LyncPresence carries clock + state{actor,via?,focus?,typing?}", () => {
    // A fully-populated present state.
    const present: LyncPresence = {
      clock: 1,
      state: { actor: "alice", via: "textile-browser", focus: "node-42", typing: true },
    };
    // A graceful leave.
    const leave: LyncPresence = { clock: 2, state: null };
    // Optional fields really are optional.
    const minimal: LyncPresence = { clock: 3, state: { actor: "bob" } };
    // focus may be explicitly null (attention on nothing).
    const unfocused: LyncPresence = { clock: 4, state: { actor: "cara", focus: null } };

    for (const data of [present, leave, minimal, unfocused]) {
      const frame: PresenceFrame = { t: "presence", root: "story", client: "c1", data };
      const round = decodeFrame(encodeFrame(frame));
      expect(round).toEqual(frame);
    }
  });

  it("keys awareness by a per-connection `client`, distinct from the durable `actor`", () => {
    // Two clients, SAME actor (one human, two tabs) — the frame's `client`
    // distinguishes them; `actor` agrees with durable turn authorship.
    const tabA: PresenceFrame = {
      t: "presence",
      root: "story",
      client: "conn-a",
      data: { clock: 1, state: { actor: "alice" } },
    };
    const tabB: PresenceFrame = {
      t: "presence",
      root: "story",
      client: "conn-b",
      data: { clock: 1, state: { actor: "alice" } },
    };
    expect(tabA.client).not.toBe(tabB.client);
    expect(tabA.data.state?.actor).toBe(tabB.data.state?.actor);
  });

  it("rejects a presence frame missing `client` or carrying a non-LyncPresence data", () => {
    // Missing client.
    expect(
      decodeFrame('{"t":"presence","root":"r","data":{"clock":1,"state":null}}'),
    ).toMatchObject({ t: "err", reason: "malformed-presence" });
    // Missing data entirely (was optional/opaque before — now required & typed).
    expect(decodeFrame('{"t":"presence","root":"r","client":"c"}')).toMatchObject({
      t: "err",
      reason: "malformed-presence",
    });
    // clock not a nonnegative integer — a poisoned clock must never reach LWW.
    expect(
      decodeFrame('{"t":"presence","root":"r","client":"c","data":{"clock":1.5,"state":null}}'),
    ).toMatchObject({ t: "err", reason: "malformed-presence" });
    expect(
      decodeFrame('{"t":"presence","root":"r","client":"c","data":{"clock":-1,"state":null}}'),
    ).toMatchObject({ t: "err", reason: "malformed-presence" });
    // state present but actor missing.
    expect(
      decodeFrame('{"t":"presence","root":"r","client":"c","data":{"clock":1,"state":{"typing":true}}}'),
    ).toMatchObject({ t: "err", reason: "malformed-presence" });
    // Wrong field types.
    expect(
      decodeFrame('{"t":"presence","root":"r","client":"c","data":{"clock":1,"state":{"actor":"a","typing":"yes"}}}'),
    ).toMatchObject({ t: "err", reason: "malformed-presence" });
    expect(
      decodeFrame('{"t":"presence","root":"r","client":"c","data":{"clock":1,"state":{"actor":"a","focus":7}}}'),
    ).toMatchObject({ t: "err", reason: "malformed-presence" });
  });

  it("drops unknown extra fields from a newer peer inside state (forward-compatible, not fatal)", () => {
    const decoded = decodeFrame(
      '{"t":"presence","root":"r","client":"c","data":{"clock":1,"state":{"actor":"a","future":true},"extra":9}}',
    );
    // Canonicalized down to exactly the known shape — the extras are gone, not fatal.
    expect(decoded).toEqual({
      t: "presence",
      root: "r",
      client: "c",
      data: { clock: 1, state: { actor: "a" } },
    });
  });
});
