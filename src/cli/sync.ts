import { appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { basename } from "node:path";
import { decodeFrame, encodeFrame, extractLineId, isCursor } from "../sync-protocol.js";

// Sync rides Node's built-in WebSocket (global since Node 22, matching
// engines) — no dependency. It is an EventTarget, not an EventEmitter:
// listeners via addEventListener, payloads on MessageEvent.data, and no
// terminate(); the hard-abort timeout below settles the promise by rejection
// and then close() tears the socket down (aborting the handshake if still
// connecting).

/**
 * `lync sync <file> <url>` — one-shot convergence with a `lync serve` relay.
 *
 * The file itself is the offline queue: every local line is offered to the
 * server (duplicates are no-ops under union), and every server line we lack
 * is appended locally. The resume cursor lives in `<file>.sync.json`; it
 * advances only after a received line has reached a durable local state —
 * appended, recognized as a duplicate, or surfaced as unusable. A sync that
 * cannot reach `live` within the timeout fails loudly; nothing hangs.
 */

export interface LyncSyncOptions {
  file: string;
  url: string;
  root?: string;
  timeoutMs?: number;
  /**
   * Stay connected after `live`: keep appending incoming events and push
   * local appends as they land. Resolves when the socket closes or
   * `stopSignal` aborts.
   */
  follow?: boolean;
  stopSignal?: AbortSignal;
  out: Pick<NodeJS.WriteStream, "write">;
  err: Pick<NodeJS.WriteStream, "write">;
}

export interface LyncSyncResult {
  sent: number;
  received: number;
  duplicates: number;
  surfaced: number;
  conflicts: number;
  seq: number;
}

interface Cursor {
  url: string;
  root: string;
  seq: number;
}

export async function syncOnce(options: LyncSyncOptions): Promise<LyncSyncResult> {
  const root = options.root ?? defaultRoot(options.file);
  const cursorPath = `${options.file}.sync.json`;
  const cursor = await readCursor(cursorPath, options.url, root);

  let text = existsSync(options.file) ? await readFile(options.file, "utf8") : "";
  if (text.length > 0 && !text.endsWith("\n")) {
    options.err.write(`lync sync: ${options.file} has a truncated final line; sealing it as damaged\n`);
    await appendFile(options.file, "\n");
    text += "\n";
  }
  const localLines = text.split("\n").filter((line) => line.length > 0);
  const localIds = new Set<string>();
  for (const line of localLines) {
    const id = extractLineId(line);
    if (id !== undefined) localIds.add(id);
  }

  const socket = new WebSocket(options.url);
  // Never a Blob: a binary frame arrives as an ArrayBuffer we can decode
  // synchronously. Text frames (the relay's native tongue) arrive as strings.
  socket.binaryType = "arraybuffer";
  const result: LyncSyncResult = { sent: 0, received: 0, duplicates: 0, surfaced: 0, conflicts: 0, seq: cursor.seq };
  let appendChain = Promise.resolve();
  let following = false;
  // Byte offset of everything we've already offered the server, so follow
  // mode can push only newly appended complete lines.
  let localOffset = Buffer.byteLength(text, "utf8");
  let watcher: import("node:fs").FSWatcher | undefined;
  let pushChain = Promise.resolve();

  const persistCursor = () =>
    writeFile(cursorPath, `${JSON.stringify({ url: options.url, root, seq: result.seq } satisfies Cursor, null, 2)}\n`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      // The rejection is the hard abort — it settles the promise no matter
      // what the socket does next. close() then aborts the handshake (if
      // still connecting) or starts teardown; there is no terminate() here.
      reject(new Error(`lync sync: no 'live' from ${options.url} within ${options.timeoutMs ?? 15_000}ms`));
      socket.close();
    }, options.timeoutMs ?? 15_000);

    const stop = () => {
      watcher?.close();
      resolve();
    };
    options.stopSignal?.addEventListener("abort", stop, { once: true });

    function startFollowingLocalAppends(): void {
      watcher = watch(options.file, () => {
        pushChain = pushChain.then(async () => {
          const current = await readFile(options.file, "utf8");
          const fresh = current.slice(localOffset);
          const upto = fresh.lastIndexOf("\n");
          if (upto < 0) return; // no complete new line yet
          for (const line of fresh.slice(0, upto).split("\n")) {
            if (line.length === 0) continue;
            const id = extractLineId(line);
            if (id !== undefined && localIds.has(id)) continue; // our own echo, already appended
            if (id !== undefined) localIds.add(id);
            socket.send(encodeFrame({ t: "ev", root, line }));
            result.sent += 1;
          }
          localOffset += Buffer.byteLength(fresh.slice(0, upto + 1), "utf8");
        });
      });
    }

    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      watcher?.close();
      if (following) resolve();
    });

    socket.addEventListener("error", (event) => {
      clearTimeout(timeout);
      watcher?.close();
      const detail = (event as { message?: unknown }).message;
      reject(new Error(`lync sync: socket error from ${options.url}${typeof detail === "string" ? `: ${detail}` : ""}`));
    });

    socket.addEventListener("open", () => {
      // Push before subscribing: the server handles our frames in order, so
      // every conflict or rejection for our own lines arrives before the
      // backlog and `live`, and the backlog then covers our accepted lines
      // (duplicate no-ops that settle the resume cursor in one pass).
      for (const line of localLines) {
        socket.send(encodeFrame({ t: "ev", root, line }));
        result.sent += 1;
      }
      socket.send(encodeFrame({ t: "sub", root, since: cursor.seq }));
    });

    socket.addEventListener("message", (event) => {
      const raw = event.data;
      const frame = decodeFrame(typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer));
      switch (frame.t) {
        case "ev": {
          const id = extractLineId(frame.line);
          if (id === undefined) {
            options.err.write(`lync sync: server sent a line without an id; surfaced, not appended\n`);
            result.surfaced += 1;
          } else if (localIds.has(id)) {
            result.duplicates += 1;
          } else {
            localIds.add(id);
            result.received += 1;
            const line = frame.line;
            appendChain = appendChain.then(async () => {
              await appendFile(options.file, `${line}\n`);
              // Appends of our own making must not be re-pushed by the watcher.
              localOffset += Buffer.byteLength(`${line}\n`, "utf8");
            });
          }
          if (typeof frame.seq === "number") result.seq = Math.max(result.seq, frame.seq);
          if (following) appendChain = appendChain.then(() => persistCursor());
          return;
        }
        case "live": {
          clearTimeout(timeout);
          result.seq = Math.max(result.seq, frame.seq);
          if (!options.follow) {
            resolve();
            return;
          }
          if (!following) {
            following = true;
            options.out.write(`lync sync: live at seq ${result.seq}; following (Ctrl-C to stop)\n`);
            void persistCursor();
            startFollowingLocalAppends();
          }
          return;
        }
        case "err": {
          if (frame.reason === "same-id-conflict") {
            result.conflicts += 1;
            options.err.write(`lync sync: same-id conflict surfaced by server: ${frame.detail ?? "?"}\n`);
          } else if (frame.reason === "recovered-damaged-tail") {
            options.err.write(`lync sync: server note: ${frame.detail ?? frame.reason}\n`);
          } else {
            options.err.write(`lync sync: server error: ${frame.reason}${frame.detail ? ` (${frame.detail})` : ""}\n`);
          }
          return;
        }
        default:
          return;
      }
    });
  }).finally(() => {
    watcher?.close();
    socket.close();
  });

  await appendChain;
  await pushChain;
  await persistCursor();
  return result;
}

function defaultRoot(file: string): string {
  return basename(file).replace(/\.lync$/, "");
}

async function readCursor(path: string, url: string, root: string): Promise<Cursor> {
  if (!existsSync(path)) return { url, root, seq: 0 };
  try {
    const stored = JSON.parse(await readFile(path, "utf8")) as Cursor;
    // seq must be a nonnegative INTEGER: a fractional cursor (corrupt or
    // hand-edited file) would make the relay skip the whole backlog and then
    // get persisted as live — a permanent silent miss. Reset to 0 instead;
    // re-receiving the backlog is a harmless union no-op.
    if (stored.url === url && stored.root === root && isCursor(stored.seq)) {
      return stored;
    }
    // Different server/root, or an unusable cursor: start from 0.
    return { url, root, seq: 0 };
  } catch {
    return { url, root, seq: 0 };
  }
}
