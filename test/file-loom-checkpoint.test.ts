import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureFileLoomCheckpoint, verifyFileLoomCheckpoint } from "../src/file-loom-checkpoint.js";
import { createFileLoomCursor } from "../src/file-loom-cursor.js";
import { serializeLyncEvent } from "../src/store.js";

const temporary: string[] = [];
const author = { actor: "checkpoint-test" };

afterEach(async () => Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("file Loom checkpoint", () => {
  it("binds a selected tip to canonical prefixes while later appends continue", async () => {
    const dir = await tempDir();
    const cursor = await createFileLoomCursor<{ text: string }>({ dir, author });
    const first = await cursor.appendTurn(null, { text: "wake" });
    const selected = await cursor.appendTurn(first.id, { text: "speak" });
    const checkpoint = await captureFileLoomCheckpoint({ dir, loomId: cursor.id, tip: selected.id });
    expect(checkpoint.tip).toMatchObject({ id: selected.id, depth: 2, bodyDigest: selected.bodyDigest, chainDigest: selected.chainDigest });
    expect(checkpoint.sources.map((source) => source.file)).toEqual((await canonicalFiles(dir)).sort());

    await cursor.appendTurn(selected.id, { text: "later" });
    expect(await verifyFileLoomCheckpoint(dir, checkpoint)).toEqual(checkpoint.tip);
    cursor.close();
  });

  it("includes sidecars and rejects changed bytes inside a captured prefix", async () => {
    const dir = await tempDir();
    const cursor = await createFileLoomCursor<{ text: string }>({ dir, author });
    const root = cursor.id.slice("lync:".length);
    cursor.close();
    const sidecarTurn = {
      v: 1 as const,
      id: "sidecar-selected-turn",
      kind: "lync/turn",
      at: "2026-08-02T00:00:00.000Z",
      author,
      parents: [root],
      payload: { payload: { text: "from sidecar" }, ordinal: 0 },
    };
    const sidecar = path.join(dir, "accepted.conflicts");
    await writeFile(sidecar, `${serializeLyncEvent(sidecarTurn)}\n`);
    const checkpoint = await captureFileLoomCheckpoint({ dir, loomId: `lync:${root}`, tip: sidecarTurn.id });
    expect(checkpoint.tip.locator.file).toBe("accepted.conflicts");
    await verifyFileLoomCheckpoint(dir, checkpoint);

    const bytes = await readFile(sidecar, "utf8");
    await writeFile(sidecar, bytes.replace("from sidecar", "xxxx sidecar"));
    await expect(verifyFileLoomCheckpoint(dir, checkpoint)).rejects.toThrow(/SHA-256|changed|match/);
  });
});

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lync-checkpoint-"));
  temporary.push(dir);
  return dir;
}

async function canonicalFiles(dir: string) {
  const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
  const result = files.filter((file) => file.endsWith(".lync") || file.endsWith(".conflicts")).sort();
  if (files.includes("pending.events")) result.push("pending.events");
  return result;
}
