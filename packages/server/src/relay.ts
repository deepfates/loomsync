import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { decodeFrame, encodeFrame, extractLineId, type SyncFrame } from "lync-core/sync-protocol";

/**
 * The lync line-sync relay — a dumb event-union relay, mountable on any Node
 * HTTP server or run standalone.
 *
 * One append-only `<root>.lync` file per root. `seq` is the per-root count of
 * stored lines: a resume cursor, nothing more. The relay never parses a line
 * beyond extracting its id. Accepted events fan out to every subscriber of the
 * root, sender included — echoes are duplicate no-ops under union. Same-id,
 * different-body is never resolved: both sides keep their bytes, the variant
 * goes to a `<root>.conflicts` sidecar, and an err frame goes to everyone.
 * Presence is relayed, never stored. Nothing fails invisibly.
 */

export interface LyncRelayOptions {
  /** Directory of per-root append-only files. Created if absent. */
  dir: string;
  /** If set, upgrades require `Authorization: Bearer <token>`. */
  token?: string;
  /**
   * Per-upgrade authorization. Return false to reject. Runs after the token
   * check (if any). Use for cookie/session auth on an embedded relay.
   */
  authenticate?: (request: IncomingMessage) => boolean | Promise<boolean>;
  /** Called with each wired socket; for connection counting and keepalive. */
  onConnection?: (socket: WebSocket) => void;
  log?: (message: string) => void;
}

export interface LyncRelay {
  /** Handle an HTTP upgrade: authorize, upgrade, and wire the socket. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Wire a socket you upgraded yourself. */
  handleConnection(socket: WebSocket): void;
  /** Close all sockets and flush every pending append. */
  close(): Promise<void>;
}

interface Room {
  root: string;
  seq: number;
  lines: string[];
  byId: Map<string, string>;
  subscribers: Set<WebSocket>;
  writeChain: Promise<void>;
  recoveryNote?: string;
}

const ROOT_NAME = /^[A-Za-z0-9._-]+$/;

export function createLyncRelay(options: LyncRelayOptions): LyncRelay {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const dirReady = mkdir(options.dir, { recursive: true }).then(() => undefined);
  const rooms = new Map<string, Promise<Room>>();
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (options.token && request.headers.authorization !== `Bearer ${options.token}`) {
      reject(socket, "bad or missing token");
      return;
    }
    if (!options.authenticate) {
      wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws));
      return;
    }
    Promise.resolve(options.authenticate(request)).then(
      (ok) => {
        if (ok) wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws));
        else reject(socket, "authenticate() returned false");
      },
      (error) => reject(socket, `authenticate() threw: ${String(error)}`),
    );
  }

  function reject(socket: Duplex, why: string): void {
    log(`[lync relay] rejected upgrade: ${why}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  }

  function handleConnection(socket: WebSocket): void {
    sockets.add(socket);
    options.onConnection?.(socket);
    const subscribed = new Set<string>();
    // Frames from one socket are handled strictly in arrival order, so a
    // client that pushes then subscribes sees any errors before its backlog.
    let frameChain = Promise.resolve();
    socket.on("message", (raw) => {
      const frame = decodeFrame(raw.toString());
      frameChain = frameChain.then(() => handleFrame(socket, subscribed, frame));
    });
    socket.on("close", () => {
      sockets.delete(socket);
      void detach(socket, subscribed);
    });
    socket.on("error", (error) => log(`[lync relay] socket error: ${String(error)}`));
  }

  async function handleFrame(socket: WebSocket, subscribed: Set<string>, frame: SyncFrame): Promise<void> {
    try {
      switch (frame.t) {
        case "err":
          send(socket, frame.reason === "malformed-frame" || frame.reason === "unknown-frame-kind" ? frame : { t: "err", reason: "client-error-received", detail: frame.reason });
          return;
        case "sub": {
          const room = await openRoom(frame.root);
          room.subscribers.add(socket);
          subscribed.add(room.root);
          if (room.recoveryNote) {
            send(socket, { t: "err", root: room.root, reason: "recovered-damaged-tail", detail: room.recoveryNote });
          }
          for (let index = frame.since; index < room.lines.length; index += 1) {
            send(socket, { t: "ev", root: room.root, seq: index + 1, line: room.lines[index] });
          }
          send(socket, { t: "live", root: room.root, seq: room.seq });
          return;
        }
        case "ev": {
          const room = await openRoom(frame.root);
          const id = extractLineId(frame.line);
          if (id === undefined) {
            send(socket, { t: "err", root: room.root, reason: "line-without-id", detail: truncate(frame.line) });
            return;
          }
          const existing = room.byId.get(id);
          if (existing !== undefined) {
            if (existing === frame.line) return; // duplicate: a no-op by union
            await appendSerialized(room, join(options.dir, `${room.root}.conflicts`), frame.line);
            broadcast(room, { t: "err", root: room.root, reason: "same-id-conflict", detail: id }, socket);
            send(socket, { t: "err", root: room.root, reason: "same-id-conflict", detail: id });
            return;
          }
          room.byId.set(id, frame.line);
          room.lines.push(frame.line);
          room.seq += 1;
          const seq = room.seq;
          const persisted = await appendSerialized(room, join(options.dir, `${room.root}.lync`), frame.line);
          // Live delivery is the relay's primary job: fan out even if the disk
          // write failed. A durability failure is surfaced loudly, never hidden.
          broadcast(room, { t: "ev", root: room.root, seq, line: frame.line });
          if (!persisted.ok) {
            broadcast(room, { t: "err", root: room.root, reason: "persist-failed", detail: id });
          }
          return;
        }
        case "presence": {
          const room = await openRoom(frame.root);
          broadcast(room, frame, socket);
          return;
        }
        case "live":
          send(socket, { t: "err", root: frame.root, reason: "unexpected-live-from-client" });
          return;
      }
    } catch (error) {
      log(`[lync relay] frame handling failed: ${String(error)}`);
      send(socket, { t: "err", reason: "server-error", detail: String(error) });
    }
  }

  function openRoom(root: string): Promise<Room> {
    if (!ROOT_NAME.test(root)) {
      return Promise.reject(new Error(`invalid root name: ${truncate(root)}`));
    }
    let pending = rooms.get(root);
    if (!pending) {
      pending = dirReady.then(() => recoverRoom(root));
      rooms.set(root, pending);
    }
    return pending;
  }

  async function recoverRoom(root: string): Promise<Room> {
    const room: Room = { root, seq: 0, lines: [], byId: new Map(), subscribers: new Set(), writeChain: Promise.resolve() };
    const path = join(options.dir, `${root}.lync`);
    if (!existsSync(path)) return room;
    const text = await readFile(path, "utf8");
    const endsClean = text.length === 0 || text.endsWith("\n");
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (!endsClean && lines.length > 0) {
      const tail = lines.at(-1) ?? "";
      room.recoveryNote = `sealed truncated final line (${tail.length} bytes) as damaged`;
      log(`[lync relay] ${root}: ${room.recoveryNote}`);
      await appendFile(path, "\n");
    }
    for (const line of lines) {
      const id = extractLineId(line);
      // A damaged or sealed-truncated line stays on disk (never eaten) but is
      // not replayed to subscribers — it isn't a real event.
      if (id === undefined) continue;
      room.lines.push(line);
      room.seq += 1;
      if (!room.byId.has(id)) room.byId.set(id, line);
    }
    return room;
  }

  // Serialize appends per room. A write failure must never wedge the room or
  // vanish silently: clear any prior rejection so the next write still runs,
  // keep the chain resolved so the room recovers, and report ok/failure to the
  // caller so a persistence error can be surfaced loudly.
  function appendSerialized(room: Room, path: string, line: string): Promise<{ ok: boolean }> {
    const attempt = room.writeChain
      .catch(() => undefined)
      .then(() => appendFile(path, `${line}\n`))
      .then(
        () => ({ ok: true }),
        (error) => {
          log(`[lync relay] persist failed for ${path}: ${String(error)}`);
          return { ok: false };
        },
      );
    room.writeChain = attempt.then(() => undefined);
    return attempt;
  }

  function broadcast(room: Room, frame: SyncFrame, except?: WebSocket): void {
    const encoded = encodeFrame(frame);
    for (const subscriber of room.subscribers) {
      if (subscriber === except) continue;
      if (subscriber.readyState === subscriber.OPEN) subscriber.send(encoded);
    }
  }

  function send(socket: WebSocket, frame: SyncFrame): void {
    if (socket.readyState === socket.OPEN) socket.send(encodeFrame(frame));
  }

  async function detach(socket: WebSocket, subscribed: Set<string>): Promise<void> {
    for (const root of subscribed) {
      const room = await rooms.get(root);
      room?.subscribers.delete(socket);
    }
  }

  return {
    handleUpgrade,
    handleConnection,
    close: async () => {
      // Flush every pending append first — writeChains are kept resolved (never
      // rejected) by appendSerialized, so this settles promptly and no accepted
      // write is dropped. This honors the durability promise in the interface.
      for (const pending of rooms.values()) {
        try {
          const room = await pending;
          await room.writeChain;
        } catch {
          // A room that never recovered has no pending writes worth waiting on.
        }
      }
      // Then tear down sockets and the server under a hard cap: on some ws
      // builds (notably bun) socket teardown and wss.close() can block
      // indefinitely, so shutdown must never hang.
      for (const socket of sockets) {
        try {
          socket.terminate();
        } catch {
          // Already gone.
        }
      }
      await Promise.race([
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 300);
          wss.close(() => {
            clearTimeout(timer);
            resolve();
          });
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    },
  };
}

function truncate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
