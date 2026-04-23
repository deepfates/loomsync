import { describe, expect, it } from "vitest";
import {
  createRootShareUrl,
  getRootIdFromUrl,
  openRootWithRetry,
} from "../src/links.js";
import { unknownRoot } from "../src/errors.js";
import type { LoomWorlds } from "../src/types.js";

describe("root link helpers", () => {
  it("reads root ids from query params and hashes", () => {
    expect(getRootIdFromUrl(new URL("https://loom.test/?story=abc"))).toBe("abc");
    expect(getRootIdFromUrl(new URL("https://loom.test/?root=def"))).toBe("def");
    expect(getRootIdFromUrl(new URL("https://loom.test/#ghi"))).toBe("ghi");
    expect(getRootIdFromUrl(new URL("https://loom.test/#root=jkl"))).toBe("jkl");
  });

  it("creates stable root share urls", () => {
    expect(
      createRootShareUrl(
        "automerge:root",
        new URL("https://loom.test/path?x=1&root=old#old"),
      ),
    ).toBe("https://loom.test/path?x=1&story=automerge%3Aroot");
  });
});

describe("openRootWithRetry", () => {
  it("retries opening roots that may still be arriving over sync", async () => {
    let attempts = 0;
    const worlds = {
      async openRoot() {
        attempts += 1;
        if (attempts < 3) throw unknownRoot("root");
        return { id: "root" };
      },
    } as unknown as LoomWorlds;

    await expect(
      openRootWithRetry(worlds, "root", { attempts: 3, delayMs: 1 }),
    ).resolves.toMatchObject({ id: "root" });
    expect(attempts).toBe(3);
  });
});
