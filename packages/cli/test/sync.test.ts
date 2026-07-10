import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startLyncServe, type LyncSyncServer } from "lync-server";
import { syncOnce } from "../src/sync.js";

const quiet = { write: () => true } as const;

function collect() {
  const chunks: string[] = [];
  return {
    io: { write: (chunk: string) => (chunks.push(chunk), true) },
    text: () => chunks.join(""),
  };
}

function eventLine(id: string, parents: string[], text: string): string {
  return JSON.stringify({
    v: 1,
    id,
    kind: "lync/artifact",
    at: "2026-07-08T21:00:00Z",
    author: { actor: "sync-test" },
    parents,
    payload: { text },
  });
}

function idsOf(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return (JSON.parse(line) as { id?: string }).id ?? "<none>";
      } catch {
        return "<damaged>";
      }
    })
    .sort();
}

describe("lync serve + sync", () => {
  let server: LyncSyncServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("converges two divergent files through the relay", async () => {
    const serverDir = await mkdtemp(path.join(os.tmpdir(), "lync-serve-"));
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "lync-client-"));
    server = await startLyncServe({ dir: serverDir, log: () => {} });
    const url = `ws://localhost:${server.port}`;

    const fileA = path.join(clientDir, "story.lync");
    const fileB = path.join(clientDir, "b", "..", "story-b.lync");
    await writeFile(fileA, `${eventLine("root", [], "once")}\n${eventLine("a1", ["root"], "fork a")}\n`);
    await writeFile(fileB, `${eventLine("root", [], "once")}\n${eventLine("b1", ["root"], "fork b")}\n`);

    await syncOnce({ file: fileA, url, root: "story", out: quiet, err: quiet });
    await syncOnce({ file: fileB, url, root: "story", out: quiet, err: quiet });
    await syncOnce({ file: fileA, url, root: "story", out: quiet, err: quiet });

    const a = idsOf(await readFile(fileA, "utf8"));
    const b = idsOf(await readFile(fileB, "utf8"));
    expect(a).toEqual(["a1", "b1", "root"]);
    expect(b).toEqual(a);
    expect(new Set(a).size).toBe(a.length);
  });

  it("resumes exactly from the stored cursor: new events only, no re-fetch of the backlog", async () => {
    const serverDir = await mkdtemp(path.join(os.tmpdir(), "lync-serve-"));
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "lync-client-"));
    server = await startLyncServe({ dir: serverDir, log: () => {} });
    const url = `ws://localhost:${server.port}`;

    const fileA = path.join(clientDir, "a.lync");
    const fileB = path.join(clientDir, "b.lync");
    await writeFile(fileA, `${eventLine("root", [], "once")}\n`);
    await writeFile(fileB, "");

    await syncOnce({ file: fileA, url, root: "tale", out: quiet, err: quiet });
    await syncOnce({ file: fileA, url, root: "tale", out: quiet, err: quiet }); // settles cursor past echoes
    const offlineCursor = JSON.parse(await readFile(`${fileA}.sync.json`, "utf8")) as { seq: number };
    expect(offlineCursor.seq).toBeGreaterThanOrEqual(1);

    // While A is offline, B contributes one new event.
    await writeFile(fileB, `${eventLine("root", [], "once")}\n${eventLine("late", ["root"], "while away")}\n`);
    await syncOnce({ file: fileB, url, root: "tale", out: quiet, err: quiet });

    const result = await syncOnce({ file: fileA, url, root: "tale", out: quiet, err: quiet });
    expect(result.received).toBe(1);
    const ids = idsOf(await readFile(fileA, "utf8"));
    expect(ids).toEqual(["late", "root"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("recovers a kill-9 truncated tail: sealed as damaged, surfaced, never eaten", async () => {
    const serverDir = await mkdtemp(path.join(os.tmpdir(), "lync-serve-"));
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "lync-client-"));
    const full = eventLine("survivor", [], "made it");
    const partial = '{"v":1,"id":"torn","kind":"lync/artifa';
    await writeFile(path.join(serverDir, "crash.lync"), `${full}\n${partial}`);

    server = await startLyncServe({ dir: serverDir, log: () => {} });
    const url = `ws://localhost:${server.port}`;
    const file = path.join(clientDir, "crash.lync");
    await writeFile(file, "");

    const errs = collect();
    const result = await syncOnce({ file, url, root: "crash", out: quiet, err: errs.io });

    expect(result.received).toBe(1); // the survivor
    // The sealed damaged tail is surfaced via the recovery note, NOT replayed
    // as a phantom event — so it is never mis-served, and never appended.
    expect(result.surfaced).toBe(0);
    expect(errs.text()).toContain("sealed truncated final line");
    expect(idsOf(await readFile(file, "utf8"))).toEqual(["survivor"]);
    // The damaged bytes still live in the server file — sealed, never eaten.
    const serverText = await readFile(path.join(serverDir, "crash.lync"), "utf8");
    expect(serverText).toContain(partial);
    expect(serverText.endsWith("\n")).toBe(true);
  });

  it("surfaces same-id-different-body as a conflict on both sides and keeps both bytes", async () => {
    const serverDir = await mkdtemp(path.join(os.tmpdir(), "lync-serve-"));
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "lync-client-"));
    server = await startLyncServe({ dir: serverDir, log: () => {} });
    const url = `ws://localhost:${server.port}`;

    const fileA = path.join(clientDir, "a.lync");
    const fileB = path.join(clientDir, "b.lync");
    await writeFile(fileA, `${eventLine("same-id", [], "first telling")}\n`);
    await writeFile(fileB, `${eventLine("same-id", [], "second telling")}\n`);

    await syncOnce({ file: fileA, url, root: "duel", out: quiet, err: quiet });
    const errs = collect();
    const result = await syncOnce({ file: fileB, url, root: "duel", out: quiet, err: errs.io });

    expect(result.conflicts).toBe(1);
    expect(errs.text()).toContain("same-id conflict surfaced by server");
    const sidecar = path.join(serverDir, "duel.conflicts");
    expect(existsSync(sidecar)).toBe(true);
    expect(await readFile(sidecar, "utf8")).toContain("second telling");
    // B keeps its own bytes; the server keeps A's. Nothing was resolved.
    expect(await readFile(fileB, "utf8")).toContain("second telling");
    expect(await readFile(path.join(serverDir, "duel.lync"), "utf8")).toContain("first telling");
  });

  it("fails loudly instead of hanging when the relay is unreachable", async () => {
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "lync-client-"));
    const file = path.join(clientDir, "alone.lync");
    await writeFile(file, "");
    await expect(
      syncOnce({ file, url: "ws://localhost:9", root: "alone", timeoutMs: 3_000, out: quiet, err: quiet }),
    ).rejects.toThrow();
  });

  it("rejects unauthorized clients when a token is required", async () => {
    const serverDir = await mkdtemp(path.join(os.tmpdir(), "lync-serve-"));
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "lync-client-"));
    server = await startLyncServe({ dir: serverDir, token: "sesame", log: () => {} });
    const file = path.join(clientDir, "locked.lync");
    await writeFile(file, "");
    await expect(
      syncOnce({ file, url: `ws://localhost:${server.port}`, root: "locked", timeoutMs: 3_000, out: quiet, err: quiet }),
    ).rejects.toThrow();
  });
});

describe("lync sync --follow", () => {
  let server: LyncSyncServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("streams events both ways while live", async () => {
    const serverDir = await mkdtemp(path.join(os.tmpdir(), "lync-serve-"));
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "lync-client-"));
    server = await startLyncServe({ dir: serverDir, log: () => {} });
    const url = `ws://localhost:${server.port}`;

    const fileA = path.join(clientDir, "a.lync");
    const fileB = path.join(clientDir, "b.lync");
    await writeFile(fileA, `${eventLine("root", [], "once")}\n`);
    await writeFile(fileB, "");

    const stopper = new AbortController();
    const follower = syncOnce({
      file: fileA, url, root: "livewire", follow: true, stopSignal: stopper.signal, out: quiet, err: quiet,
    });

    // Wait until the follower's push landed on the relay.
    await waitFor(async () => existsSync(path.join(serverDir, "livewire.lync")));

    // A remote peer contributes while A is following: A receives it live.
    await writeFile(fileB, `${eventLine("root", [], "once")}\n${eventLine("remote", ["root"], "from B")}\n`);
    await syncOnce({ file: fileB, url, root: "livewire", out: quiet, err: quiet });
    await waitFor(async () => (await readFile(fileA, "utf8")).includes('"remote"'));

    // A local append while following: pushed to the relay without re-syncing.
    await appendFile(fileA, `${eventLine("local-live", ["root"], "typed live")}\n`);
    await waitFor(async () => (await readFile(path.join(serverDir, "livewire.lync"), "utf8")).includes('"local-live"'));

    stopper.abort();
    const result = await follower;
    expect(result.received).toBeGreaterThanOrEqual(1);
    expect(idsOf(await readFile(fileA, "utf8"))).toEqual(["local-live", "remote", "root"]);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor: condition not met within timeout");
}

describe("cursor corruption recovery (dee-inzc blocker)", () => {
  let server: LyncSyncServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("a fractional cursor file resets to 0 and receives the FULL backlog, never skipping it", async () => {
    const serverDir = await mkdtemp(path.join(os.tmpdir(), "lync-serve-"));
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "lync-client-"));
    // Server already holds two events.
    await writeFile(
      path.join(serverDir, "story.lync"),
      `${eventLine("root", [], "one")}\n${eventLine("late", ["root"], "two")}\n`,
    );
    server = await startLyncServe({ dir: serverDir, log: () => {} });
    const url = `ws://localhost:${server.port}`;

    const file = path.join(clientDir, "story.lync");
    await writeFile(file, "");
    // A corrupt (fractional) cursor — pre-fix this silently skipped the whole
    // backlog and then persisted seq 2 as live: a permanent miss.
    await writeFile(`${file}.sync.json`, `${JSON.stringify({ url, root: "story", seq: 0.5 })}\n`);

    const result = await syncOnce({ file, url, root: "story", out: quiet, err: quiet });
    expect(result.received).toBe(2); // full backlog delivered
    expect(idsOf(await readFile(file, "utf8"))).toEqual(["late", "root"]);
    const cursor = JSON.parse(await readFile(`${file}.sync.json`, "utf8")) as { seq: number };
    expect(Number.isInteger(cursor.seq)).toBe(true);
    expect(cursor.seq).toBe(2);
  });
});

describe("conflict sidecar durability (dee-inzc major)", () => {
  let server: LyncSyncServer | undefined;
  let lockedDir: string | undefined;

  afterEach(async () => {
    if (lockedDir) await (await import("node:fs/promises")).chmod(lockedDir, 0o755).catch(() => {});
    await server?.close();
    server = undefined;
  });

  it("tells clients loudly when the conflict variant could NOT be retained", async () => {
    const { chmod } = await import("node:fs/promises");
    const serverDir = await mkdtemp(path.join(os.tmpdir(), "lync-serve-"));
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "lync-client-"));
    server = await startLyncServe({ dir: serverDir, log: () => {} });
    const url = `ws://localhost:${server.port}`;

    const fileA = path.join(clientDir, "a.lync");
    const fileB = path.join(clientDir, "b.lync");
    await writeFile(fileA, `${eventLine("same", [], "first telling")}\n`);
    await writeFile(fileB, `${eventLine("same", [], "second telling")}\n`);

    // A's version lands and persists normally...
    await syncOnce({ file: fileA, url, root: "duel", out: quiet, err: quiet });
    // ...then the relay dir goes read-only, so the conflict sidecar CANNOT be written.
    lockedDir = serverDir;
    await chmod(serverDir, 0o555);

    const errs = collect();
    const result = await syncOnce({ file: fileB, url, root: "duel", out: quiet, err: errs.io });

    expect(result.conflicts).toBe(1); // the conflict itself is still surfaced
    // ...and so is the retention failure — the client must never believe the
    // sidecar promise was kept when it wasn't.
    expect(errs.text()).toContain("conflict-persist-failed");
    expect(existsSync(path.join(serverDir, "duel.conflicts"))).toBe(false);
  });
});
