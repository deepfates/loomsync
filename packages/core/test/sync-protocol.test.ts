import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, extractLineId, type SyncFrame } from "lync-core/sync-protocol";

describe("lync sync protocol frames", () => {
  it("round-trips every frame kind", () => {
    const frames: SyncFrame[] = [
      { t: "sub", root: "story", since: 0 },
      { t: "ev", root: "story", line: '{"id":"a"}', seq: 3 },
      { t: "ev", root: "story", line: '{"id":"b"}' },
      { t: "live", root: "story", seq: 7 },
      { t: "presence", root: "story", data: { cursor: 4 } },
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
