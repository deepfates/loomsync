/**
 * The lync line-sync protocol: a dumb event-union relay.
 *
 * Events are immutable and merge is union by id, so the protocol has no
 * merge logic at all — it moves canonical line bytes between peers and lets
 * union make redundancy harmless. Five frame kinds:
 *
 *   client → server   {"t":"sub",  "root": string, "since": number}
 *   server → client   {"t":"ev",   "root": string, "seq": number, "line": string}
 *   server → client   {"t":"live", "root": string, "seq": number}
 *   client → server   {"t":"ev",   "root": string, "line": string}
 *   either direction  {"t":"presence", "root": string, "data"?: unknown}
 *   either direction  {"t":"err",  "root"?: string, "reason": string, "detail"?: string}
 *
 * `seq` is the server's own per-root arrival counter — a resume cursor, not
 * event order. The server echoes accepted events to every subscriber of the
 * root, sender included; echoes are duplicate no-ops under union and still
 * advance the cursor. This module is pure: frame codecs and guards only.
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
}

export interface LiveFrame {
  t: "live";
  root: string;
  seq: number;
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
      return {
        t: "ev",
        root: frame.root,
        line: frame.line,
        ...(frame.seq !== undefined ? { seq: frame.seq as number } : {}),
      };
    case "live":
      if (typeof frame.root !== "string" || !isCursor(frame.seq)) {
        return { t: "err", reason: "malformed-live" };
      }
      return { t: "live", root: frame.root, seq: frame.seq as number };
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
