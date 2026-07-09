import { createServer, type Server } from "node:http";
import { createLyncRelay, type LyncRelayOptions } from "./relay.js";

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
    close: async () => {
      await relay.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
