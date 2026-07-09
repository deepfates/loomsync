import { describe, expect, it } from "vitest";
import {
  decodeReference,
  encodeReference,
  indexRef,
  loomRef,
  parseReference,
  referenceFromUrl,
  referenceToUrl,
  threadRef,
  turnRef,
} from "../src/index.js";

describe("references", () => {
  it("roundtrips every reference kind through encoding", () => {
    const refs = [
      loomRef("automerge:loom"),
      turnRef("automerge:loom", "turn-1"),
      threadRef("automerge:loom", "turn-1"),
      indexRef("automerge:index"),
    ];

    for (const ref of refs) {
      expect(decodeReference(encodeReference(ref))).toEqual(ref);
    }
  });

  it("parses only valid v1 reference shapes", () => {
    expect(parseReference({ v: 1, kind: "loom", loomId: "l" })).toEqual(loomRef("l"));
    expect(() => parseReference({ v: 1, kind: "loom" })).toThrowError(
      /Invalid reference shape/,
    );
    expect(() => decodeReference("not-base64-json")).toThrowError(
      /Invalid encoded reference/,
    );
  });

  it("roundtrips through ?ref= urls without slug or title hints", () => {
    const ref = threadRef("automerge:loom", "turn-1");
    const url = referenceToUrl(
      ref,
      new URL("https://loom.test/story?old=1#stale"),
    );

    expect(url.startsWith("https://loom.test/story?ref=")).toBe(true);
    expect(url).not.toContain("old=1");
    expect(url).not.toContain("#stale");
    expect(referenceFromUrl(new URL(url))).toEqual(ref);
    expect(referenceFromUrl(new URL("https://loom.test/"))).toBeNull();
  });

  it("does not require Buffer when browser base64 globals exist", () => {
    const originalBuffer = globalThis.Buffer;
    const originalBtoa = globalThis.btoa;
    const originalAtob = globalThis.atob;
    try {
      // @ts-expect-error exercises the browser bundle path under a Node test runner.
      delete globalThis.Buffer;
      globalThis.btoa = (value: string) => originalBuffer.from(value, "binary").toString("base64");
      globalThis.atob = (value: string) => originalBuffer.from(value, "base64").toString("binary");

      const ref = threadRef("lync:loom", "turn-unicode-\u2713");
      expect(decodeReference(encodeReference(ref))).toEqual(ref);
    } finally {
      globalThis.Buffer = originalBuffer;
      globalThis.btoa = originalBtoa;
      globalThis.atob = originalAtob;
    }
  });
});
