import { createServer, type IncomingMessage, type Server } from "node:http";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { decodeFrame, encodeFrame, extractLineId, type SyncFrame } from "lync-core/sync-protocol";

/**
 * `lync serve` — the dumb event-union relay from the line-sync design.
 *
 * One append-only `<root>.lync` file per root. `seq` is the per-root count of
 * stored lines: a resume cursor, nothing more. The server never parses a line
 * beyond extracting its id. Accepted events fan out to every subscriber of
 * the root, sender included — echoes are duplicate no-ops under union.
 * Same-id-different-body is never resolved: both sides keep their bytes, the
 * variant line goes to a `<root>.conflicts` sidecar, and an err frame goes to
 * everyone. Presence frames are relayed and never stored. Nothing fails
 * invisibly: malformed input earns an err frame, damaged recovery is loud.
 */

export interface LyncServeOptions {
  dir: string;
  port?: number;
  token?: string;
  log?: (message: string) => void;
}

export interface LyncSyncServer {
  port: number;
  close: () => Promise<void>;
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

export async function startLyncServe(options: LyncServeOptions): Promise<LyncSyncServer> {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  await mkdir(options.dir, { recursive: true });
  const rooms = new Map<string, Promise<Room>>();

  const httpServer: Server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const socketServer = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  httpServer.on("upgrade", (request, socket, head) => {
    if (options.token && !authorized(request, options.token)) {
      log("[lync serve] rejected upgrade: bad or missing token");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    socketServer.handleUpgrade(request, socket, head, (websocket) => {
      socketServer.emit("connection", websocket, request);
    });
  });

  socketServer.on("connection", (socket: WebSocket) => {
    sockets.add(socket);
    const subscribed = new Set<string>();
    // Frames from one socket are handled strictly in arrival order, so a
    // client that pushes its lines and then subscribes is guaranteed to see
    // any resulting errors before its backlog and `live`.
    let frameChain = Promise.resolve();

    socket.on("message", (raw) => {
      const frame = decodeFrame(raw.toString());
      frameChain = frameChain.then(() => handleFrame(socket, subscribed, frame));
    });
    socket.on("close", () => {
      sockets.delete(socket);
      void detach(socket, subscribed);
    });
    socket.on("error", (error) => {
      log(`[lync serve] socket error: ${String(error)}`);
    });
  });

  async function handleFrame(socket: WebSocket, subscribed: Set<string>, frame: SyncFrame): Promise<void> {
    try {
      switch (frame.t) {
        case "err":
          // A decode failure or a client-reported error: answer loudly, never store.
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
          await appendSerialized(room, join(options.dir, `${room.root}.lync`), frame.line);
          broadcast(room, { t: "ev", root: room.root, seq, line: frame.line });
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
      log(`[lync serve] frame handling failed: ${String(error)}`);
      send(socket, { t: "err", reason: "server-error", detail: String(error) });
    }
  }

  function openRoom(root: string): Promise<Room> {
    if (!ROOT_NAME.test(root)) {
      return Promise.reject(new Error(`invalid root name: ${truncate(root)}`));
    }
    let pending = rooms.get(root);
    if (!pending) {
      pending = recoverRoom(root);
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
      // Kill-9 mid-append left a truncated tail. Seal it with a newline so
      // future appends start clean; readers classify it as damaged. Loud,
      // never eaten.
      const tail = lines.at(-1) ?? "";
      room.recoveryNote = `sealed truncated final line (${tail.length} bytes) as damaged`;
      log(`[lync serve] ${root}: ${room.recoveryNote}`);
      await appendFile(path, "\n");
    }
    for (const line of lines) {
      room.lines.push(line);
      room.seq += 1;
      const id = extractLineId(line);
      if (id !== undefined && !room.byId.has(id)) room.byId.set(id, line);
    }
    return room;
  }

  function appendSerialized(room: Room, path: string, line: string): Promise<void> {
    room.writeChain = room.writeChain.then(() => appendFile(path, `${line}\n`));
    return room.writeChain;
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

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, () => resolve());
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("lync serve: could not determine listening port");
  }

  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      // Let every in-flight append land before we report closed.
      for (const pending of rooms.values()) {
        const room = await pending;
        await room.writeChain;
      }
    },
  };
}

function authorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function truncate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
