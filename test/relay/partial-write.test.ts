import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLyncRelay, type LyncRelay } from "../../src/relay/relay.js";
import { decodeFrame, encodeFrame, type SyncFrame } from "../../src/sync-protocol.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, appendFile: vi.fn(actual.appendFile) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

class Socket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly frames: SyncFrame[] = [];
  send(data: string): void { this.frames.push(decodeFrame(data)); }
  ping(): void {}
  terminate(): void { this.readyState = 3; this.emit("close"); }
  receive(frame: SyncFrame): void { this.emit("message", { toString: () => encodeFrame(frame) }); }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("relay did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const line = (text: string) => JSON.stringify({ v: 1, id: "event", kind: "notes/text", at: "2026-09-06T00:00:00Z", author: { actor: "test" }, parents: [], payload: { text } });
const root = "partial-write";
const relays: LyncRelay[] = [];
const dirs: string[] = [];
async function connect(dir: string) {
  const relay = createLyncRelay({ dir, log: () => {} });
  relays.push(relay);
  const socket = new Socket();
  relay.handleConnection(socket);
  socket.receive({ t: "sub", root, since: 0 });
  await waitFor(() => socket.frames.some((frame) => frame.t === "live"));
  return { relay, socket };
}
const events = (socket: Socket) => socket.frames.filter((frame): frame is Extract<SyncFrame, { t: "ev" }> => frame.t === "ev").map((frame) => frame.line);

afterEach(async () => {
  vi.mocked(appendFile).mockImplementation(actualFs.appendFile);
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

for (const sidecar of [false, true]) {
  for (const extent of ["prefix", "body", "complete"] as const) {
    it(`preserves and retries a ${sidecar ? "conflict" : "main-log"} ${extent} write rejected after writing bytes`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "lync-relay-partial-"));
      dirs.push(dir);
      const { relay, socket } = await connect(dir);
      const original = line("original");
      if (sidecar) {
        socket.receive({ t: "ev", root, line: original });
        await waitFor(() => events(socket).includes(original));
      }
      const attempted = line(sidecar ? "variant" : "original");
      const damaged = extent === "prefix" ? attempted.slice(0, 10) : extent === "body" ? attempted : `${attempted}\n`;
      const path = join(dir, `${root}.${sidecar ? "conflicts" : "lync"}`);
      vi.mocked(appendFile).mockImplementationOnce(async (file) => {
        await actualFs.appendFile(file, damaged);
        throw Object.assign(new Error("injected disk full after writing bytes"), { code: "ENOSPC" });
      });
      socket.receive({ t: "ev", root, line: attempted });
      const failure = sidecar ? "conflict-persist-failed" : "persist-failed";
      await waitFor(() => socket.frames.some((frame) => frame.t === "err" && frame.reason === failure));
      expect(await readFile(path, "utf8")).toBe(damaged);
      if (!sidecar) expect(relay.status()[0].pendingUnpersisted).toBe(1);

      socket.receive({ t: "ev", root, line: attempted });
      if (sidecar) await waitFor(() => events(socket).includes(attempted));
      else await waitFor(() => relay.status()[0].pendingUnpersisted === 0);
      const expectedPrefix = damaged.endsWith("\n") ? damaged : `${damaged}\n`;
      expect(await readFile(path, "utf8")).toBe(`${expectedPrefix}${attempted}\n`);
      await relay.close();

      const recovered = await connect(dir);
      expect(events(recovered.socket)).toContain(attempted);
      if (sidecar) expect(events(recovered.socket)).toContain(original);
      // A completed write reported as failed can produce a duplicate, but every
      // replayed event remains independently parseable; damaged bytes stay on disk.
      for (const event of events(recovered.socket)) expect(() => JSON.parse(event)).not.toThrow();
      expect(await readFile(path, "utf8")).toBe(`${expectedPrefix}${attempted}\n`);
    });
  }
}

it("does not clear pending durability when sealing the damaged tail also fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lync-relay-seal-failure-"));
  dirs.push(dir);
  const { relay, socket } = await connect(dir);
  const attempted = line("pending");
  vi.mocked(appendFile).mockImplementationOnce(async (file) => {
    await actualFs.appendFile(file, attempted.slice(0, 10));
    throw new Error("injected partial append");
  });
  socket.receive({ t: "ev", root, line: attempted });
  await waitFor(() => relay.status()[0].pendingUnpersisted === 1);
  vi.mocked(appendFile).mockImplementationOnce(async () => { throw new Error("injected seal failure"); });
  socket.receive({ t: "ev", root, line: attempted });
  await waitFor(() => socket.frames.filter((frame) => frame.t === "err" && frame.reason === "persist-failed").length === 2);
  expect(relay.status()[0].pendingUnpersisted).toBe(1);
  socket.receive({ t: "ev", root, line: attempted });
  await waitFor(() => relay.status()[0].pendingUnpersisted === 0);
  expect(await readFile(join(dir, `${root}.lync`), "utf8")).toBe(`${attempted.slice(0, 10)}\n${attempted}\n`);
});
