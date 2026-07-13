/**
 * UUIDv7 minting for lync writers. FORMAT.md makes UUID ids a writer
 * obligation: generators mint UUIDv7 (time-ordered, unique per generation);
 * importers transcribing pre-existing events may instead derive deterministic
 * UUIDv8 from source identity. Zero dependencies; uses the Web Crypto global
 * available in browsers and Node.
 */

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  // 48-bit big-endian unix-ms timestamp.
  const ms = BigInt(now);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  // Version 7 in the high nibble of byte 6; RFC 4122 variant in byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
