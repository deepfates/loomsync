/**
 * The lync line-sync protocol: a dumb event-union relay.
 *
 * Events are immutable and merge is union by id, so the protocol has no
 * merge logic at all — it moves canonical line bytes between peers and lets
 * union make redundancy harmless. Five frame kinds:
 *
 *   client → server   {"t":"sub",  "root": string, "since": number}
 *   server → client   {"t":"ev",   "root": string, "seq": number, "line": string, "gen"?: string}
 *   server → client   {"t":"live", "root": string, "seq": number, "gen"?: string}
 *   client → server   {"t":"ev",   "root": string, "line": string}
 *   either direction  {"t":"presence", "root": string, "data"?: unknown}
 *   either direction  {"t":"err",  "root"?: string, "reason": string, "detail"?: string}
 *
 * `seq` is the server's own per-root arrival counter — a resume cursor, not
 * event order. The server echoes accepted events to every subscriber of the
 * root, sender included; echoes are duplicate no-ops under union and still
 * advance the cursor. This module is pure: frame codecs and guards only.
 *
 * `gen` is the server's log GENERATION: a random id minted every time a room
 * is recovered from disk (so every server restart is a new generation). A
 * cursor is only meaningful inside the generation that issued it — a broadcast
 * whose disk write failed still consumes a seq, so after a restart the
 * recovered log can sit BEHIND a client's saved cursor and the client would
 * silently skip the next persisted event forever. A client that sees `gen`
 * change from what its cursor was saved under must reset to 0 and resync from
 * scratch; union makes the re-download a harmless set of duplicate no-ops.
 * The field is additive: frames without it (old servers) decode fine, and old
 * clients ignore it.
 */

export interface SubFrame {
  t: "sub";
  root: string;
  since: number;
}

export interface EvFrame {
  t: "ev";
  root: string;
  line: string;
  seq?: number;
  /** Server log generation (see module doc). Absent from old servers and client→server frames. */
  gen?: string;
}

export interface LiveFrame {
  t: "live";
  root: string;
  seq: number;
  /** Server log generation (see module doc). Absent from old servers. */
  gen?: string;
}

export interface PresenceFrame {
  t: "presence";
  root: string;
  data?: unknown;
}

export interface ErrFrame {
  t: "err";
  root?: string;
  reason: string;
  detail?: string;
}

export type SyncFrame = SubFrame | EvFrame | LiveFrame | PresenceFrame | ErrFrame;

const FRAME_KINDS = new Set(["sub", "ev", "live", "presence", "err"]);

/**
 * A resume cursor / sequence number: a nonnegative integer. Fractional or
 * non-finite values must never pass — they index into backlogs downstream.
 */
export function isCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function encodeFrame(frame: SyncFrame): string {
  return JSON.stringify(frame);
}

/**
 * Decode one frame. Returns an ErrFrame (never throws) on anything
 * malformed, so transport code stays loud without try/catch pyramids.
 */
export function decodeFrame(raw: string | Uint8Array): SyncFrame {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { t: "err", reason: "malformed-frame", detail: String(error) };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { t: "err", reason: "malformed-frame", detail: "frame is not an object" };
  }
  const frame = value as Record<string, unknown>;
  if (typeof frame.t !== "string" || !FRAME_KINDS.has(frame.t)) {
    return { t: "err", reason: "unknown-frame-kind", detail: String(frame.t) };
  }
  switch (frame.t) {
    case "sub":
      // Cursors are array indices and resume positions: a fractional or
      // non-finite `since` silently skips the backlog downstream (lines[0.5]
      // is undefined), so anything but a nonnegative integer is malformed.
      if (typeof frame.root !== "string" || !isCursor(frame.since)) {
        return { t: "err", reason: "malformed-sub" };
      }
      return { t: "sub", root: frame.root, since: frame.since as number };
    case "ev":
      if (typeof frame.root !== "string" || typeof frame.line !== "string") {
        return { t: "err", reason: "malformed-ev" };
      }
      if (frame.seq !== undefined && !isCursor(frame.seq)) {
        return { t: "err", reason: "malformed-ev", detail: "seq must be a nonnegative integer" };
      }
      // gen is additive: absence is fine (old peers). Present-but-not-a-string
      // is malformed — a client resetting its cursor over garbage would be
      // acting on noise.
      if (frame.gen !== undefined && typeof frame.gen !== "string") {
        return { t: "err", reason: "malformed-ev", detail: "gen must be a string" };
      }
      return {
        t: "ev",
        root: frame.root,
        line: frame.line,
        ...(frame.seq !== undefined ? { seq: frame.seq as number } : {}),
        ...(frame.gen !== undefined ? { gen: frame.gen as string } : {}),
      };
    case "live":
      if (typeof frame.root !== "string" || !isCursor(frame.seq)) {
        return { t: "err", reason: "malformed-live" };
      }
      if (frame.gen !== undefined && typeof frame.gen !== "string") {
        return { t: "err", reason: "malformed-live", detail: "gen must be a string" };
      }
      return {
        t: "live",
        root: frame.root,
        seq: frame.seq as number,
        ...(frame.gen !== undefined ? { gen: frame.gen as string } : {}),
      };
    case "presence":
      if (typeof frame.root !== "string") {
        return { t: "err", reason: "malformed-presence" };
      }
      return { t: "presence", root: frame.root, data: frame.data };
    default:
      return {
        t: "err",
        reason: typeof frame.reason === "string" ? frame.reason : "unspecified",
        ...(typeof frame.root === "string" ? { root: frame.root } : {}),
        ...(typeof frame.detail === "string" ? { detail: frame.detail } : {}),
      };
  }
}

/**
 * Extract the event id from a canonical line without trusting anything else
 * in it. The relay never parses beyond this. Returns undefined when no id
 * can be extracted — callers surface that loudly, never drop it silently.
 */
export function extractLineId(line: string): string | undefined {
  try {
    const value = JSON.parse(line);
    if (typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string") {
      return (value as { id: string }).id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
