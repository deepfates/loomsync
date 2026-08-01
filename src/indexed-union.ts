import {
  parseLyncLine,
  type LyncEventBody,
  type LyncLineClass,
  type LyncLineDiagnostic,
  type LyncObstacle,
} from "./events.js";
import { Sha256, sha256Hex } from "./sha256.js";

export interface ReReadableLyncSource {
  /** Stable source identity shown in diagnostics. */
  file: string;
  /** Exact byte length expected from every scan. */
  size: number;
  /** Optional content binding authenticated during the indexing pass. */
  expectedSha256?: string;
  /** A fresh ordered stream beginning at byte zero. */
  stream(): AsyncIterable<Uint8Array>;
  /** A fresh half-open read from the same immutable source. */
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface IndexedLyncLocator {
  source: number;
  file: string;
  line: number;
  start: number;
  end: number;
  terminator: "" | "\n";
}

export interface IndexedLyncEnvelope {
  id: string;
  kind: string;
  at: string;
  author: {
    actor: string;
    operator?: string;
    imported_by?: string;
  };
  parents: readonly string[];
  marked?: string;
  critical?: boolean;
  /** Small declared Loom profile needed to present descendants lazily. */
  loomProfile?: string;
}

export interface IndexedLyncLine {
  locator: IndexedLyncLocator;
  class: LyncLineClass;
  /** Classification before union-wide conflict adjudication. */
  parsedClass: LyncLineClass;
  reason: string;
  id?: string;
  hasDigest?: boolean;
  hasSig?: boolean;
  duplicateSighting?: boolean;
  metadataDisagreement?: boolean;
  bodyDigest?: string;
  rawSha256: string;
  digest?: string;
  sig?: string;
  nonconformingReasons?: readonly string[];
  envelope?: IndexedLyncEnvelope;
}

export interface IndexedLyncConflictVariant {
  id: string;
  digest: string;
  locator: IndexedLyncLocator;
}

export interface IndexedLyncSuppression {
  suppressedPayloadIds: string[];
  notSuppressedIds: string[];
  danglingTargetNoEffectUntilUnion: string[];
}

export interface IndexedLyncOwnership {
  sourceBytesScanned: number;
  lineCount: number;
  maxChunkBytesObserved: number;
  maxLineBytesObserved: number;
  configuredChunkBytes: number;
  configuredLineBytes: number;
  /** The index stores locators and digests, never source line/body bytes. */
  retainedRawBytes: number;
  /** Parsed payload graphs exist only while one line is classified or yielded. */
  retainedPayloadObjects: number;
  retainedLineLocators: number;
  retainedEnvelopes: number;
  retainedObjectCount: number;
  retainedStringChars: number;
  /** Re-readable authority handles retained by the lazy reader; backing bytes remain source-owned. */
  retainedSourceHandles: number;
}

export interface IndexedLyncPendingParent {
  id: string;
  missingParent: string;
  locator: IndexedLyncLocator;
}

export interface IndexedLyncSourceIdentity {
  source: number;
  file: string;
  size: number;
  sha256: string;
}

export interface IndexedLyncUnionOptions {
  maxChunkBytes?: number;
  maxLineBytes?: number;
}

export interface IndexedLyncEvent {
  line: IndexedLyncLine;
  event: LyncEventBody;
}

export interface IndexedLyncUnion {
  lines: readonly IndexedLyncLine[];
  unionEventIds: readonly string[];
  viewEligibleIds: readonly string[];
  conflictIds: readonly string[];
  conflictVariants: readonly IndexedLyncConflictVariant[];
  /** Finalized first-parent gaps; they do not make physical lines disappear. */
  pendingParents: readonly IndexedLyncPendingParent[];
  suppression: IndexedLyncSuppression;
  graphDiagnostics: readonly LyncObstacle[];
  sources: readonly IndexedLyncSourceIdentity[];
  ownership: IndexedLyncOwnership;
  presentationProfile(id: string): string | null;
  downset(id: string): { ids: string[]; partial: boolean; obstacles: LyncObstacle[] };
  readExactLine(line: IndexedLyncLine): Promise<Uint8Array>;
  readEvent(id: string): Promise<IndexedLyncEvent | null>;
  events(): AsyncIterable<IndexedLyncEvent>;
  carriedLines(): AsyncIterable<{ line: IndexedLyncLine; bytes: Uint8Array }>;
}

const DEFAULT_MAX_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Build an order-independent union index over immutable, re-readable sources.
 * Source bytes and parsed payloads are discarded after each physical line.
 */
export async function indexLyncSources(
  sources: readonly ReReadableLyncSource[],
  options: IndexedLyncUnionOptions = {},
): Promise<IndexedLyncUnion> {
  if (sources.length === 0) throw new Error("indexed Lync union requires at least one source");
  const sourceList = [...sources];
  const maxChunkBytes = positiveInteger(options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES, "maxChunkBytes");
  const maxLineBytes = positiveInteger(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
  const lines: MutableIndexedLine[] = [];
  let sourceBytesScanned = 0;
  let maxChunkBytesObserved = 0;
  let maxLineBytesObserved = 0;
  const sourceIdentities: IndexedLyncSourceIdentity[] = [];

  for (let sourceIndex = 0; sourceIndex < sourceList.length; sourceIndex += 1) {
    const source = sourceList[sourceIndex]!;
    validateSource(source);
    const lineBuffer = new Uint8Array(maxLineBytes);
    let lineLength = 0;
    let lineNumber = 1;
    let lineStart = 0;
    let offset = 0;
    const sourceHash = new Sha256();

    const consumeLine = (terminator: "" | "\n") => {
      const bytes = lineBuffer.subarray(0, lineLength);
      maxLineBytesObserved = Math.max(maxLineBytesObserved, lineLength);
      const diagnostic = parseLyncLine({ file: source.file, line: lineNumber, bytes, terminator });
      lines.push(compactLine(diagnostic, {
        source: sourceIndex,
        file: source.file,
        line: lineNumber,
        start: lineStart,
        end: lineStart + lineLength,
        terminator,
      }));
      lineNumber += 1;
      lineLength = 0;
      lineStart = terminator ? offset + 1 : offset;
    };

    for await (const chunk of source.stream()) {
      if (!(chunk instanceof Uint8Array)) throw new Error(`Lync source ${source.file} yielded a non-byte chunk`);
      if (chunk.byteLength > maxChunkBytes) {
        throw new Error(`Lync source ${source.file} yielded ${chunk.byteLength} bytes, exceeding maxChunkBytes ${maxChunkBytes}`);
      }
      if (offset + chunk.byteLength > source.size) {
        throw new Error(`Lync source ${source.file} supplied bytes past its declared size ${source.size}`);
      }
      maxChunkBytesObserved = Math.max(maxChunkBytesObserved, chunk.byteLength);
      sourceHash.update(chunk);
      for (let index = 0; index < chunk.byteLength; index += 1) {
        const value = chunk[index]!;
        if (value === 0x0a) {
          consumeLine("\n");
        } else {
          if (lineLength >= maxLineBytes) {
            throw new Error(`Lync source ${source.file}:${lineNumber} exceeds maxLineBytes ${maxLineBytes}`);
          }
          lineBuffer[lineLength] = value;
          lineLength += 1;
        }
        offset += 1;
      }
    }
    if (offset !== source.size) {
      throw new Error(`Lync source ${source.file} supplied ${offset} bytes, expected ${source.size}`);
    }
    if (lineLength > 0) consumeLine("");
    const sourceSha256 = sourceHash.digestHex();
    if (source.expectedSha256 && source.expectedSha256 !== sourceSha256) {
      throw new Error(`Lync source ${source.file} does not match expected SHA-256 ${source.expectedSha256}`);
    }
    sourceIdentities.push(Object.freeze({ source: sourceIndex, file: source.file, size: source.size, sha256: sourceSha256 }));
    sourceBytesScanned += offset;
  }

  const adjudicated = await adjudicate(lines, sourceList);
  const acceptedById = adjudicated.acceptedById;
  const conflictIds = adjudicated.conflictIds;
  const viewEligibleIds = [...acceptedById.keys()].filter((id) => !conflictIds.has(id)).sort();
  const graphDiagnostics = graphObstacles(acceptedById, conflictIds);
  const suppression = computeSuppression(acceptedById, conflictIds);
  const presentationProfiles = resolvePresentationProfiles(acceptedById, conflictIds);
  const pendingParents = unresolvedFirstParents(acceptedById, conflictIds);
  const retained = inspectRetainedOwnership({
    lines,
    acceptedById,
    conflictVariants: adjudicated.conflictVariants,
    pendingParents,
    graphDiagnostics,
    suppression,
    presentationProfiles,
    sourceIdentities,
  });
  const ownership: IndexedLyncOwnership = Object.freeze({
    sourceBytesScanned,
    lineCount: lines.length,
    maxChunkBytesObserved,
    maxLineBytesObserved,
    configuredChunkBytes: maxChunkBytes,
    configuredLineBytes: maxLineBytes,
    retainedRawBytes: retained.rawBytes,
    retainedPayloadObjects: retained.payloadObjects,
    retainedLineLocators: lines.length,
    retainedEnvelopes: lines.filter((line) => line.envelope).length,
    retainedObjectCount: retained.objects,
    retainedStringChars: retained.stringChars,
    retainedSourceHandles: sourceList.length,
  });

  async function readExactLine(line: IndexedLyncLine): Promise<Uint8Array> {
    const source = sourceList[line.locator.source];
    if (!source || source.file !== line.locator.file) throw new Error("indexed Lync line names an unavailable source");
    const through = line.locator.end + (line.locator.terminator ? 1 : 0);
    const exact = await source.read(line.locator.start, through);
    const expected = through - line.locator.start;
    if (!(exact instanceof Uint8Array) || exact.byteLength !== expected) {
      throw new Error(`Lync source changed or truncated at ${line.locator.file}:${line.locator.line}`);
    }
    const body = line.locator.terminator ? exact.subarray(0, exact.byteLength - 1) : exact;
    if (sha256Hex(body) !== line.rawSha256) {
      throw new Error(`Lync source changed or reordered at ${line.locator.file}:${line.locator.line}`);
    }
    if (line.locator.terminator && exact[exact.byteLength - 1] !== 0x0a) {
      throw new Error(`Lync source line terminator changed at ${line.locator.file}:${line.locator.line}`);
    }
    return exact;
  }

  async function readEvent(id: string): Promise<IndexedLyncEvent | null> {
    const line = acceptedById.get(id);
    if (!line || conflictIds.has(id)) return null;
    const exact = await readExactLine(line);
    const body = line.locator.terminator ? exact.subarray(0, exact.byteLength - 1) : exact;
    const diagnostic = parseLyncLine({
      file: line.locator.file,
      line: line.locator.line,
      bytes: body,
      terminator: line.locator.terminator,
    });
    if (!diagnostic.event || diagnostic.id !== id || diagnostic.bodyDigest !== line.bodyDigest) {
      throw new Error(`Lync indexed event no longer matches ${line.locator.file}:${line.locator.line}`);
    }
    return { line, event: diagnostic.event };
  }

  return Object.freeze({
    lines,
    unionEventIds: viewEligibleIds,
    viewEligibleIds,
    conflictIds: [...conflictIds].sort(),
    conflictVariants: adjudicated.conflictVariants,
    pendingParents,
    suppression,
    graphDiagnostics,
    sources: sourceIdentities,
    ownership,
    presentationProfile(id: string) {
      return presentationProfiles.get(id) ?? null;
    },
    downset(id: string) {
      return indexedDownset(acceptedById, conflictIds, id);
    },
    readExactLine,
    readEvent,
    async *events() {
      for (const id of viewEligibleIds) yield (await readEvent(id))!;
    },
    async *carriedLines() {
      for (const line of lines) yield { line, bytes: await readExactLine(line) };
    },
  });
}

function inspectRetainedOwnership(value: unknown) {
  const seen = new Set<object>();
  let rawBytes = 0;
  let payloadObjects = 0;
  let objects = 0;
  let stringChars = 0;
  const visit = (item: unknown, key?: string) => {
    if (typeof item === "string") {
      stringChars += item.length;
      return;
    }
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    objects += 1;
    if (ArrayBuffer.isView(item)) {
      rawBytes += item.byteLength;
      return;
    }
    if (key === "payload") payloadObjects += 1;
    if (item instanceof Map) {
      for (const [mapKey, mapValue] of item) {
        visit(mapKey);
        visit(mapValue);
      }
      return;
    }
    if (item instanceof Set) {
      for (const setValue of item) visit(setValue);
      return;
    }
    if (Array.isArray(item)) {
      for (const arrayValue of item) visit(arrayValue);
      return;
    }
    for (const [childKey, child] of Object.entries(item)) visit(child, childKey);
  };
  visit(value);
  return { rawBytes, payloadObjects, objects, stringChars };
}

function unresolvedFirstParents(
  accepted: Map<string, MutableIndexedLine>,
  conflicts: Set<string>,
): IndexedLyncPendingParent[] {
  const result: IndexedLyncPendingParent[] = [];
  for (const line of accepted.values()) {
    const parent = line.envelope?.parents[0];
    if (!parent || accepted.has(parent) || conflicts.has(parent)) continue;
    result.push({ id: line.id!, missingParent: parent, locator: line.locator });
  }
  return result.sort((left, right) => compare(`${left.missingParent}\0${left.id}`, `${right.missingParent}\0${right.id}`));
}

function indexedDownset(
  accepted: Map<string, MutableIndexedLine>,
  conflicts: Set<string>,
  id: string,
) {
  const ids = new Set<string>();
  const obstacles: LyncObstacle[] = [];
  const stack: { id: string; path: string[] }[] = [{ id, path: [] }];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (conflicts.has(current.id)) {
      obstacles.push({ class: "unavailable-due-to-conflict", id: current.id });
      continue;
    }
    const line = accepted.get(current.id);
    if (!line?.envelope) {
      obstacles.push({ class: "dangling", missing: current.id });
      continue;
    }
    ids.add(current.id);
    if (current.path.includes(current.id)) {
      const start = current.path.indexOf(current.id);
      obstacles.push({ class: "cycle", ids: current.path.slice(start) });
      continue;
    }
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    for (const parent of line.envelope.parents) {
      stack.push({ id: parent, path: [...current.path, current.id] });
    }
  }
  const normalized = normalizeObstacles(obstacles);
  return { ids: [...ids].sort(), partial: normalized.length > 0, obstacles: normalized };
}

type MutableIndexedLine = IndexedLyncLine & {
  class: LyncLineClass;
  duplicateSighting?: boolean;
  metadataDisagreement?: boolean;
};

function compactLine(diagnostic: LyncLineDiagnostic, locator: IndexedLyncLocator): MutableIndexedLine {
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
    ...(diagnostic.nonconformingReasons ? { nonconformingReasons: [...diagnostic.nonconformingReasons] } : {}),
    ...(event ? { envelope: compactEnvelope(event) } : {}),
  };
}

function compactEnvelope(event: LyncEventBody): IndexedLyncEnvelope {
  const meta = event.kind === "lync/loom" && isRecord(event.payload.meta)
    ? event.payload.meta
    : null;
  return {
    id: event.id,
    kind: event.kind,
    at: event.at,
    author: {
      actor: event.author.actor,
      ...(typeof event.author.operator === "string" ? { operator: event.author.operator } : {}),
      ...(typeof event.author.imported_by === "string" ? { imported_by: event.author.imported_by } : {}),
    },
    parents: [...event.parents],
    ...(typeof event.marked === "string" ? { marked: event.marked } : {}),
    ...(typeof event.critical === "boolean" ? { critical: event.critical } : {}),
    ...(typeof meta?.profile === "string" ? { loomProfile: meta.profile } : {}),
  };
}

function resolvePresentationProfiles(
  accepted: Map<string, MutableIndexedLine>,
  conflicts: Set<string>,
) {
  const resolved = new Map<string, string | null>();
  const state = new Map<string, 1 | 2>();
  for (const start of accepted.keys()) {
    if (conflicts.has(start) || state.get(start) === 2) continue;
    const stack: { id: string; nextParent: number }[] = [{ id: start, nextParent: 0 }];
    state.set(start, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const envelope = accepted.get(frame.id)?.envelope;
      const parents = envelope?.parents ?? [];
      if (frame.nextParent < parents.length) {
        const parent = parents[frame.nextParent]!;
        frame.nextParent += 1;
        if (conflicts.has(parent) || !accepted.has(parent) || state.get(parent) === 2) continue;
        if (state.get(parent) !== 1) {
          state.set(parent, 1);
          stack.push({ id: parent, nextParent: 0 });
        }
        continue;
      }
      let profile = envelope?.loomProfile ?? null;
      if (!profile) {
        const inherited = new Set<string>();
        for (const parent of parents) {
          const parentProfile = resolved.get(parent);
          if (parentProfile) inherited.add(parentProfile);
        }
        if (inherited.size === 1) profile = [...inherited][0] ?? null;
      }
      resolved.set(frame.id, profile);
      state.set(frame.id, 2);
      stack.pop();
    }
  }
  return resolved;
}

async function adjudicate(lines: MutableIndexedLine[], sources: readonly ReReadableLyncSource[]) {
  const byId = new Map<string, MutableIndexedLine[]>();
  for (const line of lines) {
    if (!isCandidate(line)) continue;
    const bucket = byId.get(line.id) ?? [];
    bucket.push(line);
    byId.set(line.id, bucket);
  }
  const acceptedById = new Map<string, MutableIndexedLine>();
  const conflictIds = new Set<string>();
  const conflictVariants: IndexedLyncConflictVariant[] = [];

  for (const bucket of byId.values()) {
    const bodies = await exactBodyGroups(bucket, sources);
    if (bodies.length > 1) {
      conflictIds.add(bucket[0]!.id!);
      for (const line of bucket) {
        line.class = "conflict-variant";
        line.reason = "same id with different body bytes";
      }
      for (const group of bodies) {
        const line = group[0]!;
        conflictVariants.push({ id: line.id!, digest: line.bodyDigest!, locator: line.locator });
      }
      continue;
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
    acceptedById.set(kept.id!, kept);
  }
  conflictVariants.sort((left, right) => compare(`${left.id}\0${left.digest}`, `${right.id}\0${right.digest}`));
  return { acceptedById, conflictIds, conflictVariants };
}

async function exactBodyGroups(
  bucket: MutableIndexedLine[],
  sources: readonly ReReadableLyncSource[],
): Promise<MutableIndexedLine[][]> {
  const byDigest = new Map<string, MutableIndexedLine[]>();
  for (const line of bucket) {
    const group = byDigest.get(line.bodyDigest!) ?? [];
    group.push(line);
    byDigest.set(line.bodyDigest!, group);
  }
  if (byDigest.size > 1) return [...byDigest.values()];
  if (bucket.length < 2) return [bucket];

  // A digest match is not byte equality. Re-read only duplicate-id candidates,
  // keeping ordinary unique histories free of retained or repeated payload IO.
  const groups: Array<{ body: Uint8Array; lines: MutableIndexedLine[] }> = [];
  for (const line of bucket) {
    const body = await readBody(line, sources);
    const group = groups.find((item) => bytesEqual(item.body, body));
    if (group) group.lines.push(line);
    else groups.push({ body, lines: [line] });
  }
  return groups.map((group) => group.lines);
}

async function readBody(line: MutableIndexedLine, sources: readonly ReReadableLyncSource[]) {
  const source = sources[line.locator.source]!;
  const through = line.locator.end + (line.locator.terminator ? 1 : 0);
  const exact = await source.read(line.locator.start, through);
  if (!(exact instanceof Uint8Array)) {
    throw new Error(`Lync source returned non-bytes during duplicate adjudication at ${line.locator.file}:${line.locator.line}`);
  }
  const bytes = line.locator.terminator ? exact.subarray(0, exact.byteLength - 1) : exact;
  if (
    exact.byteLength !== through - line.locator.start
    || (line.locator.terminator && exact[exact.byteLength - 1] !== 0x0a)
    || sha256Hex(bytes) !== line.rawSha256
  ) {
    throw new Error(`Lync source changed during duplicate adjudication at ${line.locator.file}:${line.locator.line}`);
  }
  const diagnostic = parseLyncLine({
    file: line.locator.file,
    line: line.locator.line,
    bytes,
    terminator: line.locator.terminator,
  });
  if (!diagnostic.bodyBytes || diagnostic.bodyDigest !== line.bodyDigest) {
    throw new Error(`Lync source body changed during duplicate adjudication at ${line.locator.file}:${line.locator.line}`);
  }
  return diagnostic.bodyBytes;
}

function isCandidate(line: MutableIndexedLine): line is MutableIndexedLine & {
  id: string;
  bodyDigest: string;
  envelope: IndexedLyncEnvelope;
} {
  return (line.class === "accepted" || line.class === "nonconforming") && Boolean(line.id && line.bodyDigest && line.envelope);
}

function isRicher(candidate: IndexedLyncLine, current: IndexedLyncLine) {
  if (Boolean(candidate.sig) !== Boolean(current.sig)) return Boolean(candidate.sig);
  if (Boolean(candidate.digest) !== Boolean(current.digest)) return Boolean(candidate.digest);
  return false;
}

function computeSuppression(accepted: Map<string, MutableIndexedLine>, conflicts: Set<string>): IndexedLyncSuppression {
  const suppressed = new Set<string>();
  const dangling = new Set<string>();
  const eventIds = new Set([...accepted.keys()].filter((id) => !conflicts.has(id)));
  for (const line of accepted.values()) {
    const event = line.envelope;
    if (line.class !== "accepted" || !event || event.critical !== true || conflicts.has(event.id)) continue;
    const authorNames = names(event);
    for (const parent of event.parents) {
      const target = accepted.get(parent)?.envelope;
      if (!target || conflicts.has(parent)) {
        dangling.add(parent);
        continue;
      }
      if (intersects(authorNames, names(target))) suppressed.add(parent);
    }
  }
  return {
    suppressedPayloadIds: [...suppressed].sort(),
    notSuppressedIds: [...eventIds].filter((id) => !suppressed.has(id)).sort(),
    danglingTargetNoEffectUntilUnion: [...dangling].sort(),
  };
}

function graphObstacles(accepted: Map<string, MutableIndexedLine>, conflicts: Set<string>): LyncObstacle[] {
  const obstacles: LyncObstacle[] = [];
  for (const line of accepted.values()) {
    const event = line.envelope;
    if (!event || conflicts.has(event.id)) continue;
    for (const parent of event.parents) {
      if (conflicts.has(parent)) obstacles.push({ class: "unavailable-due-to-conflict", id: parent });
      else if (!accepted.has(parent)) obstacles.push({ class: "dangling", missing: parent });
    }
  }
  for (const cycle of findCycles(accepted, conflicts)) obstacles.push({ class: "cycle", ids: cycle });
  return normalizeObstacles(obstacles);
}

function findCycles(accepted: Map<string, MutableIndexedLine>, conflicts: Set<string>): string[][] {
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const cycles: string[][] = [];
  const seen = new Set<string>();
  for (const startId of accepted.keys()) {
    if (conflicts.has(startId) || color.get(startId) === BLACK) continue;
    const stack: { id: string; nextParent: number }[] = [{ id: startId, nextParent: 0 }];
    const path = [startId];
    const pathIndex = new Map<string, number>([[startId, 0]]);
    color.set(startId, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const parents = accepted.get(frame.id)?.envelope?.parents ?? [];
      if (frame.nextParent < parents.length) {
        const parent = parents[frame.nextParent]!;
        frame.nextParent += 1;
        if (conflicts.has(parent) || !accepted.has(parent)) continue;
        const parentColor = color.get(parent);
        if (parentColor === GRAY) {
          const cycle = path.slice(pathIndex.get(parent));
          const smallest = cycle.indexOf([...cycle].sort()[0]!);
          const canonical = [...cycle.slice(smallest), ...cycle.slice(0, smallest)];
          const key = canonical.join("\0");
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(canonical);
          }
        } else if (parentColor !== BLACK) {
          color.set(parent, GRAY);
          pathIndex.set(parent, path.length);
          path.push(parent);
          stack.push({ id: parent, nextParent: 0 });
        }
      } else {
        stack.pop();
        color.set(frame.id, BLACK);
        path.pop();
        pathIndex.delete(frame.id);
      }
    }
  }
  return cycles;
}

function normalizeObstacles(obstacles: LyncObstacle[]) {
  const seen = new Set<string>();
  const result: LyncObstacle[] = [];
  for (const obstacle of obstacles) {
    const key = JSON.stringify(obstacle);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(obstacle);
  }
  return result;
}

function names(event: IndexedLyncEnvelope) {
  return new Set([event.author.actor, event.author.operator, event.author.imported_by]
    .filter((value): value is string => typeof value === "string" && value.length > 0));
}

function intersects(left: Set<string>, right: Set<string>) {
  for (const item of left) if (right.has(item)) return true;
  return false;
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function validateSource(source: ReReadableLyncSource) {
  if (!source || typeof source.file !== "string" || source.file.length === 0) {
    throw new Error("indexed Lync source requires a file identity");
  }
  if (!Number.isSafeInteger(source.size) || source.size < 0) {
    throw new Error(`Lync source ${source.file} has an invalid size`);
  }
  if (source.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(source.expectedSha256)) {
    throw new Error(`Lync source ${source.file} has an invalid expected SHA-256`);
  }
  if (typeof source.stream !== "function" || typeof source.read !== "function") {
    throw new Error(`Lync source ${source.file} is not re-readable`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
