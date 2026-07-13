import { createServer, type Server } from "node:http";
import { createLyncRelay, type LyncRelayOptions, type LyncRoomStatus } from "./relay.js";

/**
 * Run the relay standalone on its own HTTP server. For embedding in an
 * existing server, use `createLyncRelay` and call `handleUpgrade` from your
 * own `upgrade` listener.
 */

export interface LyncServeOptions extends LyncRelayOptions {
  /** Port to listen on. 0 (default) picks a free port. */
  port?: number;
}

export interface LyncSyncServer {
  port: number;
  /** Read-only snapshot of the relay's live rooms. See `LyncRelay.status`. */
  status: () => LyncRoomStatus[];
  close: () => Promise<void>;
}

export async function startLyncServe(options: LyncServeOptions): Promise<LyncSyncServer> {
  const relay = createLyncRelay(options);
  const httpServer: Server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  httpServer.on("upgrade", (request, socket, head) => relay.handleUpgrade(request, socket, head));

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
    status: () => relay.status(),
    close: async () => {
      await relay.close();
      // Drop any lingering connections and release the listen handle. The
      // close callback is unreliable under some runtimes (bun), so cap the
      // wait and unref the server so it can never keep the loop alive.
      (httpServer as { closeAllConnections?: () => void }).closeAllConnections?.();
      httpServer.unref();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        httpServer.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
