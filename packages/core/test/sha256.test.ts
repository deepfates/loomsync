import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/sha256.js";

function nodeHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("sha256Hex", () => {
  it("matches published NIST vectors", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("agrees with node:crypto across every padding-block boundary", () => {
    // Lengths 0..200 cover the 55/56-byte and 119/120-byte padding edges where
    // a length that pushes the 64-bit count into a fresh block is easy to break.
    for (let len = 0; len <= 200; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 31 + len * 7) & 0xff;
      expect(sha256Hex(bytes)).toBe(nodeHex(bytes));
    }
  });

  it("agrees with node:crypto on random inputs", () => {
    for (let t = 0; t < 500; t++) {
      const bytes = new Uint8Array(randomBytes(Math.floor(Math.random() * 1024)));
      expect(sha256Hex(bytes)).toBe(nodeHex(bytes));
    }
  });

  it("hashes only the viewed window of a subarray", () => {
    const backing = new Uint8Array(100).map((_, i) => i & 0xff);
    const view = backing.subarray(10, 40);
    expect(sha256Hex(view)).toBe(nodeHex(view));
  });
});
