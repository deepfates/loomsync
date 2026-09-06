import type { LyncLineDiagnostic } from "./events.js";
import type {
  IndexedLyncEnvelope,
  IndexedLyncLine,
  IndexedLyncLocator,
} from "./indexed-union.js";
import { sha256Hex } from "./sha256.js";

/** Package-internal parser output shared by memory and disk-backed indexes. */
export type CompactIndexedLyncLine = IndexedLyncLine & {
  class: IndexedLyncLine["class"];
  duplicateSighting?: boolean;
  metadataDisagreement?: boolean;
};

/** Retain format/topology data while the caller remains byte authority. */
export function compactIndexedLyncLine(
  diagnostic: LyncLineDiagnostic,
  locator: IndexedLyncLocator,
): CompactIndexedLyncLine {
  const event = diagnostic.event;
  return {
    locator: Object.freeze({ ...locator }),
    class: diagnostic.class,
    parsedClass: diagnostic.class,
    reason: diagnostic.reason,
    ...(diagnostic.id ? { id: diagnostic.id } : {}),
    ...(diagnostic.hasDigest !== undefined ? { hasDigest: diagnostic.hasDigest } : {}),
    ...(diagnostic.hasSig !== undefined ? { hasSig: diagnostic.hasSig } : {}),
    ...(diagnostic.bodyDigest ? { bodyDigest: diagnostic.bodyDigest } : {}),
    rawSha256: sha256Hex(diagnostic.bytes),
    ...(diagnostic.digest ? { digest: diagnostic.digest } : {}),
    ...(diagnostic.sig ? { sig: diagnostic.sig } : {}),
    ...(diagnostic.nonconformingReasons
      ? { nonconformingReasons: [...diagnostic.nonconformingReasons] }
      : {}),
    ...(event ? { envelope: compactEnvelope(event) } : {}),
  };
}

/**
 * Adjudicate all sightings of one id. Storage implementations query one
 * physically ordered bucket at a time and therefore share exact richness and
 * conflict behavior without retaining the whole union in JavaScript.
 */
export async function adjudicateIndexedLyncBucket(
  bucket: CompactIndexedLyncLine[],
  readExactBody: (line: CompactIndexedLyncLine) => Promise<Uint8Array>,
): Promise<{
  accepted: CompactIndexedLyncLine | null;
  conflictGroups: CompactIndexedLyncLine[][];
}> {
  if (bucket.length === 0) return { accepted: null, conflictGroups: [] };
  const bodies = await exactBodyGroups(bucket, readExactBody);
  if (bodies.length > 1) {
    for (const line of bucket) {
      line.class = "conflict-variant";
      line.reason = "same id with different body bytes";
    }
    return { accepted: null, conflictGroups: bodies };
  }

  let kept = bucket[0]!;
  for (let index = 1; index < bucket.length; index += 1) {
    const line = bucket[index]!;
    line.duplicateSighting = true;
    if ((line.digest ?? "") !== (kept.digest ?? "") || (line.sig ?? "") !== (kept.sig ?? "")) {
      line.metadataDisagreement = true;
    }
    if (isRicher(line, kept)) kept = line;
  }
  return { accepted: kept, conflictGroups: [] };
}

export function isCompactUnionCandidate(line: CompactIndexedLyncLine): line is CompactIndexedLyncLine & {
  id: string;
  bodyDigest: string;
  envelope: IndexedLyncEnvelope;
} {
  return (
    (line.class === "accepted" || line.class === "nonconforming") &&
    Boolean(line.id && line.bodyDigest && line.envelope)
  );
}

async function exactBodyGroups(
  bucket: CompactIndexedLyncLine[],
  readExactBody: (line: CompactIndexedLyncLine) => Promise<Uint8Array>,
): Promise<CompactIndexedLyncLine[][]> {
  const byDigest = new Map<string, CompactIndexedLyncLine[]>();
  for (const line of bucket) {
    const group = byDigest.get(line.bodyDigest!) ?? [];
    group.push(line);
    byDigest.set(line.bodyDigest!, group);
  }
  if (byDigest.size > 1) return [...byDigest.values()];
  if (bucket.length < 2) return [bucket];

  // A digest match is not byte equality. Re-read only duplicate-id candidates.
  const groups: Array<{ body: Uint8Array; lines: CompactIndexedLyncLine[] }> = [];
  for (const line of bucket) {
    const body = await readExactBody(line);
    const group = groups.find((item) => bytesEqual(item.body, body));
    if (group) group.lines.push(line);
    else groups.push({ body, lines: [line] });
  }
  return groups.map((group) => group.lines);
}

function compactEnvelope(event: NonNullable<LyncLineDiagnostic["event"]>): IndexedLyncEnvelope {
  const meta = event.kind === "lync/loom" && isRecord(event.payload.meta) ? event.payload.meta : null;
  return {
    id: event.id,
    kind: event.kind,
    at: event.at,
    author: {
      actor: event.author.actor,
      ...(typeof event.author.operator === "string" ? { operator: event.author.operator } : {}),
      ...(typeof event.author.imported_by === "string"
        ? { imported_by: event.author.imported_by }
        : {}),
    },
    parents: [...event.parents],
    ...(typeof event.marked === "string" ? { marked: event.marked } : {}),
    ...(typeof event.critical === "boolean" ? { critical: event.critical } : {}),
    ...(typeof meta?.profile === "string" ? { loomProfile: meta.profile } : {}),
  };
}

function isRicher(candidate: IndexedLyncLine, current: IndexedLyncLine) {
  if (Boolean(candidate.sig) !== Boolean(current.sig)) return Boolean(candidate.sig);
  if (Boolean(candidate.digest) !== Boolean(current.digest)) return Boolean(candidate.digest);
  return false;
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
