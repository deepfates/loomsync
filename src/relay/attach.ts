import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { createLyncRelay, type LyncRelayOptions, type LyncRelaySocket, type LyncRoomStatus } from "./relay.js";

/**
 * Mount the relay on an existing Node HTTP server. Adds an `upgrade` listener
 * that handles only `path` (default `/lync`) and passes the rest through, so a
 * web app can share one server between its routes and lync sync.
 */

export interface AttachLyncServerOptions extends Omit<LyncRelayOptions, "dir" | "onConnection"> {
  /** Directory of per-root append-only files. */
  storageDir: string;
  /** URL path to serve the relay on. Default `/lync`. */
  path?: string;
  /** Send a WebSocket ping on this interval (ms) to keep proxies from idling out. */
  keepAliveInterval?: number;
  /** Reject upgrades once this many sockets are connected. */
  maxConnections?: number;
}

export interface AttachedLyncServer {
  /** Read-only snapshot of the relay's live rooms. See `LyncRelay.status`. */
  status: () => LyncRoomStatus[];
  close: () => Promise<void>;
}

export function attachLyncServer(server: Server, options: AttachLyncServerOptions): AttachedLyncServer {
  const path = options.path ?? "/lync";
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const live = new Set<LyncRelaySocket>();

  const pingTimer =
    options.keepAliveInterval && options.keepAliveInterval > 0
      ? setInterval(() => {
          for (const ws of live) {
            if (ws.readyState === ws.OPEN) {
              try {
                ws.ping();
              } catch {
                live.delete(ws);
              }
            }
          }
        }, options.keepAliveInterval)
      : undefined;
  pingTimer?.unref?.();

  const relay = createLyncRelay({
    dir: options.storageDir,
    token: options.token,
    authenticate: options.authenticate,
    log,
    onConnection: (ws) => {
      live.add(ws);
      ws.on("close", () => live.delete(ws));
    },
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((request.url ?? "").split("?")[0] !== path) return;
    if (options.maxConnections !== undefined && live.size >= options.maxConnections) {
      log(`[lync relay] rejecting upgrade: at max connections (${options.maxConnections})`);
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    relay.handleUpgrade(request, socket, head);
  };

  server.on("upgrade", onUpgrade);

  return {
    status: () => relay.status(),
    close: async () => {
      server.off("upgrade", onUpgrade);
      if (pingTimer) clearInterval(pingTimer);
      live.clear();
      await relay.close();
    },
  };
}
