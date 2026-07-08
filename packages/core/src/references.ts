import { invalidReference } from "./errors.js";
import type { IndexId, LoomId, LoomReference, TurnId } from "./types.js";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export interface ReferenceUrlOptions {
  param?: string;
}

export function loomRef(loomId: LoomId): LoomReference {
  return { v: 1, kind: "loom", loomId };
}

export function turnRef(loomId: LoomId, turnId: TurnId): LoomReference {
  return { v: 1, kind: "turn", loomId, turnId };
}

export function threadRef(loomId: LoomId, turnId: TurnId): LoomReference {
  return { v: 1, kind: "thread", loomId, turnId };
}

export function indexRef(indexId: IndexId): LoomReference {
  return { v: 1, kind: "index", indexId };
}

export function parseReference(value: unknown): LoomReference {
  if (!value || typeof value !== "object") {
    throw invalidReference("Reference must be an object");
  }
  const ref = value as Record<string, unknown>;
  if (ref.v !== 1) throw invalidReference("Unsupported reference version");
  if (ref.kind === "loom" && typeof ref.loomId === "string") {
    return loomRef(ref.loomId);
  }
  if (
    ref.kind === "turn" &&
    typeof ref.loomId === "string" &&
    typeof ref.turnId === "string"
  ) {
    return turnRef(ref.loomId, ref.turnId);
  }
  if (
    ref.kind === "thread" &&
    typeof ref.loomId === "string" &&
    typeof ref.turnId === "string"
  ) {
    return threadRef(ref.loomId, ref.turnId);
  }
  if (ref.kind === "index" && typeof ref.indexId === "string") {
    return indexRef(ref.indexId);
  }
  throw invalidReference("Invalid reference shape");
}

export function encodeReference(ref: LoomReference): string {
  return encodeBase64Url(JSON.stringify(parseReference(ref)));
}

export function decodeReference(encoded: string): LoomReference {
  try {
    return parseReference(JSON.parse(decodeBase64Url(encoded)));
  } catch (error) {
    if (error instanceof Error && error.name === "LoomError") throw error;
    throw invalidReference("Invalid encoded reference");
  }
}

export function referenceToUrl(
  ref: LoomReference,
  location: Location | URL,
  options: ReferenceUrlOptions = {},
): string {
  const param = options.param ?? "ref";
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set(param, encodeReference(ref));
  return url.toString();
}

export function referenceFromUrl(
  location: Location | URL,
  options: ReferenceUrlOptions = {},
): LoomReference | null {
  const param = options.param ?? "ref";
  const encoded = new URLSearchParams(location.search).get(param);
  return encoded ? decodeReference(encoded) : null;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const base64 = encodeBase64(bytes);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return new TextDecoder().decode(decodeBase64(padded));
}

function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64_ALPHABET[first >> 2];
    output += BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined
      ? "="
      : BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? "=" : BASE64_ALPHABET[third & 0x3f];
  }
  return output;
}

function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/=+$/g, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) throw new Error("Invalid base64 character");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}
