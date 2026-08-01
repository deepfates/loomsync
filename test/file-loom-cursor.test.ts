import fsPromises, {
  appendFile,
  readFile,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseLyncFiles } from "../src/events.js";
import {
  createFileLoomCursor,
  openFileLoomCursor,
  type FileLoomCursor,
} from "../src/file-loom-cursor.js";
import { serializeLyncEvent } from "../src/store.js";

const temporary: string[] = [];
const author = { actor: "cursor-test" };

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Node file Loom cursor", () => {
  it("keeps branch selection explicit and streams only the selected ancestry", async () => {
    const cursor = await createCursor<{ text: string }, { name: string }, { mood: string }>({
      meta: { name: "resident" },
    });
    const first = await cursor.appendTurn(null, { text: "wake" }, { mood: "curious" });
    const selected = await cursor.appendTurn(first.id, { text: "walk" });
    const sibling = await cursor.appendTurn(first.id, { text: "stay" });

    expect(await cursor.info()).toMatchObject({ id: cursor.id, meta: { name: "resident" } });
    expect((await cursor.childrenOf(first.id)).map((ref) => ref.id)).toEqual([
      selected.id,
      sibling.id,
    ]);
    const selectedRef = (await cursor.childrenOf(first.id)).find((ref) => ref.id === selected.id)!;
    expect(selected.chainDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(selected.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(selected.depth).toBe(2);
    expect(selected.locator).toMatchObject({ terminator: "\n", line: 3 });
    expect(path.isAbsolute(selected.locator.source)).toBe(false);
    expect(selectedRef.chainDigest).toBe(selected.chainDigest);
    expect((await cursor.getTurn(selected.id))?.locator).toEqual(selected.locator);
    expect((await cursor.leaves()).map((ref) => ref.id).sort()).toEqual(
      [selected.id, sibling.id].sort(),
    );
    expect(await cursor.depth(selected.id)).toBe(2);
    expect((await cursor.refAtDepth(selected.id, 1))?.id).toBe(first.id);
    expect((await cursor.tail(selected.id, 1)).map((turn) => turn.payload.text)).toEqual(["walk"]);

    const scanned = [];
    for await (const turn of cursor.scanThread({ tip: selected.id })) scanned.push(turn.payload.text);
    expect(scanned).toEqual(["wake", "walk"]);
    await expect(async () => {
      for await (const _ of cursor.scanThread({ tip: selected.id, through: sibling.id })) void _;
    }).rejects.toThrow("not an ancestor");

    cursor.close();
    await expect(cursor.info()).rejects.toThrow("closed");
  });

  it("rebuilds a disposable payload-free catalog from canonical bytes", async () => {
    const secret = "private-payload-that-must-not-enter-sqlite-4d7d8d";
    const cursor = await createCursor<{ secret: string }>();
    const turn = await cursor.appendTurn(null, { secret });
    const { catalogFile, id } = cursor;
    const dir = path.dirname(catalogFile);
    cursor.close();

    expect((await readFile(catalogFile)).includes(Buffer.from(secret))).toBe(false);
    await unlink(catalogFile);
    const reopened = await openFileLoomCursor<{ secret: string }>({ dir, loomId: id, author });
    const rebuilt = await reopened.getTurn(turn.id);
    expect(rebuilt?.payload).toEqual({ secret });
    expect(rebuilt?.chainDigest).toBe(turn.chainDigest);
    expect(rebuilt?.locator).toEqual(turn.locator);
    expect((await readFile(catalogFile)).includes(Buffer.from(secret))).toBe(false);
    reopened.close();
  });

  it("reuses an unchanged catalog without rescanning canonical payload bytes", async () => {
    const cursor = await createCursor<{ value: number }>();
    await cursor.appendTurn(null, { value: 1 });
    const { catalogFile, id } = cursor;
    const dir = path.dirname(catalogFile);
    cursor.close();

    const catalog = new DatabaseSync(catalogFile);
    catalog.prepare("INSERT INTO metadata (key, value) VALUES ('test-sentinel', 'retained')").run();
    catalog.close();
    const reopened = await openFileLoomCursor({ dir, loomId: id, author });
    reopened.close();

    const checked = new DatabaseSync(catalogFile);
    expect(
      checked.prepare("SELECT value FROM metadata WHERE key = 'test-sentinel'").get(),
    ).toEqual({ value: "retained" });
    checked.close();
  });

  it("applies existing union conflicts retroactively instead of choosing a variant", async () => {
    const cursor = await createCursor<{ value: string }>();
    const turn = await cursor.appendTurn(null, { value: "canonical" });
    const { catalogFile, id } = cursor;
    const dir = path.dirname(catalogFile);
    cursor.close();

    const canonicalFile = (await files(dir)).find((file) => file.endsWith(".lync"))!;
    const canonical = await readFile(path.join(dir, canonicalFile), "utf8");
    const event = parseLyncFiles([{ file: canonicalFile, bytes: canonical }]).lines.find(
      (line) => line.id === turn.id,
    )?.event;
    if (!event) throw new Error("test turn missing");
    const conflict = structuredClone(event);
    conflict.payload.payload = { value: "conflicting" };
    await writeFile(path.join(dir, "late.conflicts"), `${serializeLyncEvent(conflict)}\n`);

    const reopened = await openFileLoomCursor({ dir, loomId: id, author });
    expect(await reopened.hasTurn(turn.id)).toBe(false);
    expect(await reopened.getTurn(turn.id)).toBeNull();
    reopened.close();
  });

  it("rejects an appended id already present only as conflict variants", async () => {
    const ids = [
      "019fbdb6-1000-7000-8000-000000000001",
      "019fbdb6-1000-7000-8000-000000000002",
    ];
    const dir = await tempDir();
    const cursor = await createFileLoomCursor<{ value: string }>({
      dir,
      author,
      createId: () => ids.shift()!,
    });
    const turn = await cursor.appendTurn(null, { value: "first" });
    const loomId = cursor.id;
    cursor.close();
    const original = await eventById(dir, turn.id);
    const conflict = structuredClone(original);
    conflict.payload.payload = { value: "second" };
    await writeFile(path.join(dir, "collision.conflicts"), `${serializeLyncEvent(conflict)}\n`);

    const reopened = await openFileLoomCursor({
      dir,
      loomId,
      author,
      createId: () => turn.id,
    });
    expect(await reopened.hasTurn(turn.id)).toBe(false);
    await expect(reopened.appendTurn(null, { value: "third" })).rejects.toThrow(
      `Duplicate Loom turn id: ${turn.id}`,
    );
    reopened.close();
  });

  it("does not rewrite or reclassify a complete final event missing LF", async () => {
    const cursor = await createCursor<{ value: string }>();
    const turn = await cursor.appendTurn(null, { value: "complete" });
    const dir = path.dirname(cursor.catalogFile);
    const loomId = cursor.id;
    cursor.close();
    const file = await canonicalFile(dir);
    const terminated = await readFile(file);
    await writeFile(file, terminated.subarray(0, terminated.byteLength - 1));
    const before = await readFile(file);

    const reopened = await openFileLoomCursor<{ value: string }>({ dir, loomId, author });
    expect((await reopened.getTurn(turn.id))?.payload).toEqual({ value: "complete" });
    expect(await readFile(file)).toEqual(before);
    const catalog = new DatabaseSync(reopened.catalogFile);
    expect(catalog.prepare("SELECT class FROM lines WHERE id = ?").get(turn.id)).toEqual({
      class: "nonconforming",
    });
    catalog.close();
    await expect(reopened.appendTurn(turn.id, { value: "later" })).rejects.toThrow(
      "not LF-terminated",
    );
    reopened.close();
  });

  it("rejects a selected thread with a non-Loom intermediate event", async () => {
    const cursor = await createCursor();
    const dir = path.dirname(cursor.catalogFile);
    const loomId = cursor.id;
    const root = loomId.slice("lync:".length);
    cursor.close();
    const middle = {
      v: 1 as const,
      id: "foreign-middle",
      kind: "notes/text",
      at: "2026-08-01T00:00:00.000Z",
      author,
      parents: [root],
      payload: { text: "not a Loom turn" },
    };
    const turn = {
      v: 1 as const,
      id: "turn-through-foreign",
      kind: "lync/turn",
      at: "2026-08-01T00:00:01.000Z",
      author,
      parents: [middle.id],
      payload: { payload: { value: true }, ordinal: 0 },
    };
    const malformed = {
      v: 1 as const,
      id: "turn-without-payload",
      kind: "lync/turn",
      at: "2026-08-01T00:00:02.000Z",
      author,
      parents: [root],
      payload: { ordinal: 0 },
    };
    await appendFile(
      await canonicalFile(dir),
      `${serializeLyncEvent(middle)}\n${serializeLyncEvent(turn)}\n${serializeLyncEvent(malformed)}\n`,
    );

    const reopened = await openFileLoomCursor({ dir, loomId, author });
    expect(await reopened.hasTurn(turn.id)).toBe(false);
    expect(await reopened.hasTurn(malformed.id)).toBe(false);
    await expect(reopened.depth(turn.id)).rejects.toThrow(/Unknown Loom turn|foreign ancestry/);
    reopened.close();
  });

  it("rebuilds before answering a stale omission after same-size parent rewrite", async () => {
    const ids = [
      "019fbdb6-3000-7000-8000-000000000001",
      "019fbdb6-3000-7000-8000-000000000002",
      "019fbdb6-3000-7000-8000-000000000003",
      "019fbdb6-3000-7000-8000-000000000004",
    ];
    const dir = await tempDir();
    const cursor = await createFileLoomCursor<{ value: string }>({
      dir,
      author,
      createId: () => ids.shift()!,
    });
    const first = await cursor.appendTurn(null, { value: "first" });
    const second = await cursor.appendTurn(null, { value: "second" });
    const child = await cursor.appendTurn(first.id, { value: "child" });
    const oldChain = (await cursor.childrenOf(first.id))[0]!.chainDigest;
    const loomId = cursor.id;
    cursor.close();
    const file = await canonicalFile(dir);
    const identity = await stat(file);
    const original = await readFile(file, "utf8");
    const changed = original.replace(
      `"parents":["${first.id}"]`,
      `"parents":["${second.id}"]`,
    );
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    await writeFile(file, changed);
    await utimes(file, identity.atime, identity.mtime);

    const reopened = await openFileLoomCursor({ dir, loomId, author });
    expect((await reopened.childrenOf(first.id)).map((ref) => ref.id)).not.toContain(child.id);
    const moved = await reopened.childrenOf(second.id);
    expect(moved.map((ref) => ref.id)).toContain(child.id);
    expect(moved.find((ref) => ref.id === child.id)?.chainDigest).not.toBe(oldChain);
    reopened.close();
  });

  it("fences an external append before returning a stale negative", async () => {
    const cursor = await createCursor();
    const dir = path.dirname(cursor.catalogFile);
    const root = cursor.id.slice("lync:".length);
    const external = {
      v: 1 as const,
      id: "external-after-open",
      kind: "lync/turn",
      at: "2026-08-01T00:00:00.000Z",
      author,
      parents: [root],
      payload: { payload: { seen: true }, ordinal: 0 },
    };
    await appendFile(await canonicalFile(dir), `${serializeLyncEvent(external)}\n`);
    await expect(cursor.hasTurn(external.id)).rejects.toThrow("close and reopen");
    cursor.close();

    const reopened = await openFileLoomCursor({ dir, loomId: `lync:${root}`, author });
    expect(await reopened.hasTurn(external.id)).toBe(true);
    reopened.close();
  });

  it("answers hasTurn and a bounded tail without decoding the full ancestry", async () => {
    const cursor = await createCursor<{ step: number }>();
    let parent: string | null = null;
    const turnIds: string[] = [];
    for (let step = 0; step < 64; step += 1) {
      parent = (await cursor.appendTurn(parent, { step })).id;
      turnIds.push(parent);
    }
    const tip = parent!;
    const originalRead = fs.readSync;
    let reads = 0;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      reads += 1;
      return originalRead(...args);
    }) as typeof fs.readSync;
    try {
      expect(await cursor.hasTurn(tip)).toBe(true);
      expect(reads).toBe(0);
      expect((await cursor.childrenOf(turnIds[62]!))[0]?.id).toBe(tip);
      expect((await cursor.refAtDepth(tip, 1))?.id).toBe(turnIds[0]);
      expect(reads).toBe(0);
      expect((await cursor.tail(tip, 12)).map((turn) => turn.payload.step)).toEqual(
        Array.from({ length: 12 }, (_, index) => 52 + index),
      );
      expect(reads).toBe(12);
    } finally {
      fs.readSync = originalRead;
      cursor.close();
    }
  });

  it("poisons rather than committing a wrong locator when another writer wins the append race", async () => {
    const ids = [
      "019fbdb6-2000-7000-8000-000000000001",
      "019fbdb6-2000-7000-8000-000000000002",
    ];
    const dir = await tempDir();
    const cursor = await createFileLoomCursor<{ owner: string }>({
      dir,
      author,
      createId: () => ids.shift()!,
    });
    const root = cursor.id.slice("lync:".length);
    const competitor = serializeLyncEvent({
      v: 1,
      id: "competing-writer",
      kind: "lync/turn",
      at: "2026-08-01T00:00:00.000Z",
      author,
      parents: [root],
      payload: { payload: { owner: "other" }, ordinal: 0 },
    });
    const originalOpen = fsPromises.open;
    let injected = false;
    fsPromises.open = (async (file, flags, ...rest) => {
      if (!injected && flags === "a+" && String(file).endsWith(".lync")) {
        injected = true;
        const competing = await originalOpen(file, "a");
        await competing.writeFile(`${competitor}\n`);
        await competing.sync();
        await competing.close();
      }
      return originalOpen(file, flags, ...rest);
    }) as typeof fsPromises.open;
    try {
      await expect(cursor.appendTurn(null, { owner: "cursor" })).rejects.toThrow(
        "locator raced another writer",
      );
    } finally {
      fsPromises.open = originalOpen;
      cursor.close();
    }

    const reopened = await openFileLoomCursor<{ owner: string }>({ dir, loomId: `lync:${root}`, author });
    expect((await reopened.getTurn("019fbdb6-2000-7000-8000-000000000002"))?.payload).toEqual({
      owner: "cursor",
    });
    expect((await reopened.getTurn("competing-writer"))?.payload).toEqual({ owner: "other" });
    reopened.close();
  });

  it("leaves a canonical turn durable when the catalog transaction fails", async () => {
    const ids = [
      "019fbdb6-0000-7000-8000-000000000001",
      "019fbdb6-0000-7000-8000-000000000002",
    ];
    const dir = await tempDir();
    const cursor = await createFileLoomCursor<{ durable: boolean }>({
      dir,
      author,
      createId: () => ids.shift()!,
    });
    const catalog = new DatabaseSync(cursor.catalogFile);
    catalog.exec(`
      CREATE TRIGGER reject_cursor_line BEFORE INSERT ON lines
      BEGIN SELECT RAISE(ABORT, 'injected catalog failure'); END
    `);
    catalog.close();

    await expect(cursor.appendTurn(null, { durable: true })).rejects.toThrow(
      /canonical.*durable but catalog update failed/i,
    );
    cursor.close();

    const reopened = await openFileLoomCursor<{ durable: boolean }>({
      dir,
      loomId: "lync:019fbdb6-0000-7000-8000-000000000001",
      author,
    });
    expect((await reopened.getTurn("019fbdb6-0000-7000-8000-000000000002"))?.payload).toEqual({
      durable: true,
    });
    reopened.close();
  });
});

async function createCursor<TPayload, TLoomMeta = unknown, TTurnMeta = unknown>(options?: {
  meta?: TLoomMeta;
}): Promise<FileLoomCursor<TPayload, TLoomMeta, TTurnMeta>> {
  return createFileLoomCursor<TPayload, TLoomMeta, TTurnMeta>({
    dir: await tempDir(),
    author,
    ...(options?.meta === undefined ? {} : { meta: options.meta }),
  });
}

async function tempDir() {
  const dir = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), "lync-file-cursor-")),
  );
  temporary.push(dir);
  return dir;
}

async function files(dir: string) {
  return import("node:fs/promises").then((fs) => fs.readdir(dir));
}

async function canonicalFile(dir: string) {
  const file = (await files(dir)).find((entry) => entry.endsWith(".lync"));
  if (!file) throw new Error("canonical test file missing");
  return path.join(dir, file);
}

async function eventById(dir: string, id: string) {
  const file = await canonicalFile(dir);
  const name = path.basename(file);
  const event = parseLyncFiles([{ file: name, bytes: await readFile(file) }]).lines.find(
    (line) => line.id === id,
  )?.event;
  if (!event) throw new Error(`test event missing: ${id}`);
  return event;
}
