import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, extractLineId, type SyncFrame } from "@deepfates/lync/sync-protocol";

describe("lync sync protocol frames", () => {
  it("round-trips every frame kind", () => {
    const frames: SyncFrame[] = [
      { t: "sub", root: "story", since: 0 },
      { t: "ev", root: "story", line: '{"id":"a"}', seq: 3 },
      { t: "ev", root: "story", line: '{"id":"b"}' },
      { t: "live", root: "story", seq: 7 },
      {
        t: "presence",
        root: "story",
        client: "client-1",
        data: { clock: 4, state: { actor: "alice", via: "textile-browser", focus: "node-7", typing: true } },
      },
      { t: "presence", root: "story", client: "client-1", data: { clock: 5, state: null } },
      { t: "err", root: "story", reason: "same-id-conflict", detail: "a" },
    ];
    for (const frame of frames) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it("returns err frames for malformed input instead of throwing", () => {
    expect(decodeFrame("not json").t).toBe("err");
    expect(decodeFrame("[1,2]").t).toBe("err");
    expect(decodeFrame('{"t":"warp"}')).toMatchObject({ t: "err", reason: "unknown-frame-kind" });
    expect(decodeFrame('{"t":"sub","root":"r","since":-1}')).toMatchObject({ t: "err", reason: "malformed-sub" });
    expect(decodeFrame('{"t":"live","root":"r"}')).toMatchObject({ t: "err", reason: "malformed-live" });
  });

  it("extracts ids without trusting the rest of the line", () => {
    expect(extractLineId('{"id":"x","junk":{"id":"y"}}')).toBe("x");
    expect(extractLineId("{broken")).toBeUndefined();
    expect(extractLineId('{"noid":true}')).toBeUndefined();
  });
});

describe("cursor integrity (dee-inzc blocker)", () => {
  it("rejects fractional and non-finite cursors in sub/live/ev frames", () => {
    expect(decodeFrame('{"t":"sub","root":"r","since":0.5}')).toMatchObject({ t: "err", reason: "malformed-sub" });
    expect(decodeFrame('{"t":"sub","root":"r","since":null}')).toMatchObject({ t: "err", reason: "malformed-sub" });
    expect(decodeFrame('{"t":"live","root":"r","seq":1.5}')).toMatchObject({ t: "err", reason: "malformed-live" });
    expect(decodeFrame('{"t":"ev","root":"r","line":"{}","seq":2.5}')).toMatchObject({ t: "err", reason: "malformed-ev" });
    // Integers still pass.
    expect(decodeFrame('{"t":"sub","root":"r","since":0}').t).toBe("sub");
    expect(decodeFrame('{"t":"live","root":"r","seq":7}').t).toBe("live");
  });
});

describe("log generation field (dee-u6tq)", () => {
  it("round-trips gen on ev and live frames", () => {
    const frames: SyncFrame[] = [
      { t: "ev", root: "story", line: '{"id":"a"}', seq: 3, gen: "gen-1" },
      { t: "live", root: "story", seq: 7, gen: "gen-1" },
    ];
    for (const frame of frames) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it("stays tolerant of gen's absence — old peers decode fine, both directions", () => {
    // Old server -> new client: no gen on the wire.
    expect(decodeFrame('{"t":"ev","root":"r","line":"{}","seq":2}')).toEqual({ t: "ev", root: "r", line: "{}", seq: 2 });
    expect(decodeFrame('{"t":"live","root":"r","seq":7}')).toEqual({ t: "live", root: "r", seq: 7 });
    // New client -> old server: encoding without gen adds nothing.
    expect(encodeFrame({ t: "ev", root: "r", line: "{}" })).not.toContain("gen");
    // An unknown extra field from a NEWER peer is dropped, not fatal.
    expect(decodeFrame('{"t":"live","root":"r","seq":7,"gen":"g","future":true}')).toEqual({ t: "live", root: "r", seq: 7, gen: "g" });
  });

  it("rejects a non-string gen — a cursor reset must never act on noise", () => {
    expect(decodeFrame('{"t":"ev","root":"r","line":"{}","seq":2,"gen":42}')).toMatchObject({ t: "err", reason: "malformed-ev" });
    expect(decodeFrame('{"t":"live","root":"r","seq":7,"gen":{}}')).toMatchObject({ t: "err", reason: "malformed-live" });
  });
});

describe("uuidv7 minting", () => {
  it("mints valid, time-ordered UUIDv7", async () => {
    const { uuidv7 } = await import("@deepfates/lync/uuid");
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13) < b.slice(0, 13) || a.slice(0, 13) === b.slice(0, 13)).toBe(true);
    expect(uuidv7()).not.toEqual(uuidv7()); // two generations are two events
  });
});
