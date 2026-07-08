import { createHash } from "node:crypto";

export type LoreLineClass =
  | "accepted"
  | "nonconforming"
  | "garbage"
  | "damaged"
  | "conflict-variant";

export interface LoreEventBody {
  v: number;
  id: string;
  kind: string;
  at: string;
  author: { actor: string; operator?: string; imported_by?: string; [key: string]: unknown };
  parents: string[];
  payload: Record<string, unknown>;
  marked?: string;
  critical?: boolean;
  [key: string]: unknown;
}

export interface LoreLineDiagnostic {
  file: string;
  line: number;
  class: LoreLineClass;
  reason: string;
  id?: string;
  hasDigest?: boolean;
  hasSig?: boolean;
  duplicateSighting?: boolean;
  metadataDisagreement?: boolean;
  event?: LoreEventBody;
  bytes: Uint8Array;
  terminator: "" | "\n";
  bodyBytes?: Uint8Array;
  bodyDigest?: string;
  digest?: string;
  sig?: string;
  nonconformingReasons?: string[];
}

export interface LoreConflictVariant {
  id: string;
  digest: string;
  file: string;
  line: number;
  bytes: Uint8Array;
  bodyBytes: Uint8Array;
  event: LoreEventBody;
}

export interface LorePendingDiagnostic {
  missingParent: string;
  digest: string;
  file: string;
  line: number;
  id: string;
  bytes: Uint8Array;
}

export interface LoreObstacle {
  class: "cycle" | "dangling" | "unavailable-due-to-conflict";
  ids?: string[];
  missing?: string;
  id?: string;
}

export interface LoreParseResult {
  lines: LoreLineDiagnostic[];
  unionEventIds: string[];
  viewEligibleIds: string[];
  conflictIds: string[];
  conflictVariants: LoreConflictVariant[];
  pending: LorePendingDiagnostic[];
  pendingOverflowCount: number;
  suppression: {
    suppressedPayloadIds: string[];
    notSuppressedIds: string[];
    danglingTargetNoEffectUntilUnion: string[];
  };
  graphDiagnostics: LoreObstacle[];
}

interface JsonParsed {
  value: unknown;
}

const topLevelFields = new Set([
  "v",
  "id",
  "kind",
  "at",
  "author",
  "parents",
  "payload",
  "marked",
  "critical",
]);

const authorFields = new Set(["actor", "operator", "via", "imported_by", "source"]);

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

export type LoreUnionStatus =
  | "added"
  | "duplicate"
  | "conflict"
  | "buffered"
  | "damaged"
  | "garbage";

export interface LoreUnionIngestResult {
  status: LoreUnionStatus;
  line: LoreLineDiagnostic;
  conflictVariants?: LoreConflictVariant[];
  missingParent?: string;
  drained?: LoreUnionIngestResult[];
}

export interface LoreUnionOptions {
  pendingLimit?: number;
}

export class LoreUnion {
  private readonly pendingLimit: number;
  private readonly lines: LoreLineDiagnostic[] = [];
  private readonly acceptedById = new Map<string, LoreLineDiagnostic>();
  private readonly conflictIds = new Set<string>();
  private readonly conflictVariants = new Map<string, LoreConflictVariant>();
  private readonly pendingByParent = new Map<string, LoreLineDiagnostic[]>();
  private pendingCount = 0;
  private pendingOverflowCount = 0;

  constructor(options: LoreUnionOptions = {}) {
    this.pendingLimit = options.pendingLimit ?? 1024;
  }

  union(input: { file: string; bytes: Uint8Array | string }): LoreUnionIngestResult[] {
    const results: LoreUnionIngestResult[] = [];
    for (const raw of parsePhysicalLines(input.file, input.bytes)) {
      const line = parseLine(raw);
      this.lines.push(line);
      results.push(this.ingestParsedLine(line));
    }
    return results;
  }

  result(): LoreParseResult {
    return buildResult(this.lines, this.acceptedById, this.conflictIds, [...this.conflictVariants.values()], this.pending(), this.pendingOverflowCount);
  }

  private ingestParsedLine(line: LoreLineDiagnostic): LoreUnionIngestResult {
    if (line.class === "damaged") return { status: "damaged", line };
    if (line.class === "garbage") return { status: "garbage", line };
    if (!isUnionCandidate(line)) return { status: "garbage", line };

    const missingParent = firstMissingParent(line, this.acceptedById, this.conflictIds);
    if (missingParent) {
      this.bufferPending(missingParent, line);
      return { status: "buffered", line, missingParent };
    }

    return this.acceptLine(line);
  }

  private acceptLine(line: LoreLineDiagnostic): LoreUnionIngestResult {
    const existing = this.acceptedById.get(line.id!);
    if (this.conflictIds.has(line.id!)) {
      return { status: "conflict", line, conflictVariants: [this.markConflictVariant(line)] };
    }

    if (!existing) {
      this.acceptedById.set(line.id!, line);
      const drained = this.drain(line.id!);
      return drained.length ? { status: "added", line, drained } : { status: "added", line };
    }

    if (sameBody(existing, line)) {
      line.duplicateSighting = true;
      if ((line.digest ?? "") !== (existing.digest ?? "") || (line.sig ?? "") !== (existing.sig ?? "")) {
        line.metadataDisagreement = true;
      }
      if (isRicherLine(line, existing)) this.acceptedById.set(line.id!, line);
      return { status: "duplicate", line };
    }

    this.acceptedById.delete(line.id!);
    this.conflictIds.add(line.id!);
    const variants = new Map<string, LoreConflictVariant>();
    for (const variantLine of this.lines.filter((variant) => variant.id === line.id! && isUnionCandidate(variant))) {
      const variant = this.markConflictVariant(variantLine);
      variants.set(`${variant.id}\0${variant.digest}`, variant);
    }
    const drained = this.drain(line.id!);
    const conflictVariants = [...variants.values()];
    return drained.length ? { status: "conflict", line, conflictVariants, drained } : { status: "conflict", line, conflictVariants };
  }

  private markConflictVariant(line: LoreLineDiagnostic): LoreConflictVariant {
    line.class = "conflict-variant";
    line.reason = "same id with different body bytes";
    const variant = conflictVariantFor(line);
    this.conflictVariants.set(`${variant.id}\0${variant.digest}`, variant);
    return variant;
  }

  private bufferPending(missingParent: string, line: LoreLineDiagnostic): void {
    const bucket = this.pendingByParent.get(missingParent) ?? [];
    bucket.push(line);
    this.pendingByParent.set(missingParent, bucket);
    this.pendingCount++;
    // In-memory union keeps pending diagnostics even past this limit; durable bounds belong to the storage layer.
    if (this.pendingCount > this.pendingLimit) this.pendingOverflowCount++;
  }

  private drain(parent: string): LoreUnionIngestResult[] {
    const bucket = this.pendingByParent.get(parent);
    if (!bucket) return [];
    this.pendingByParent.delete(parent);
    this.pendingCount -= bucket.length;
    const results: LoreUnionIngestResult[] = [];
    for (const line of bucket) results.push(this.ingestParsedLine(line));
    return results;
  }

  private pending(): LorePendingDiagnostic[] {
    return [...this.pendingByParent.entries()].flatMap(([missingParent, lines]) =>
      lines.map((line) => ({
        missingParent,
        digest: line.bodyDigest!,
        file: line.file,
        line: line.line,
        id: line.id!,
        bytes: line.bytes,
      })),
    );
  }
}

export function parseLoreFiles(
  inputs: { file: string; bytes: Uint8Array | string }[],
): LoreParseResult {
  const lines = inputs.flatMap((input) => parsePhysicalLines(input.file, input.bytes).map(parseLine));
  const { acceptedById, conflictIds, conflictVariants } = markConflicts(lines);
  return buildResult(lines, acceptedById, conflictIds, conflictVariants, [], 0);
}

export function exportCarriedLoreBytes(result: LoreParseResult): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (const line of result.lines) {
    chunks.push(line.bytes);
    size += line.bytes.byteLength;
    if (line.terminator) {
      const lf = textEncoder.encode(line.terminator);
      chunks.push(lf);
      size += lf.byteLength;
    }
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function loreDownset(result: LoreParseResult, id: string): {
  ids: string[];
  partial: boolean;
  obstacles: LoreObstacle[];
} {
  const events = new Map<string, LoreLineDiagnostic>();
  const conflicts = new Set(result.conflictIds);
  for (const line of result.lines) {
    if ((line.class === "accepted" || line.class === "nonconforming") && line.id) {
      events.set(line.id, line);
    }
  }
  const ids = new Set<string>();
  const obstacles: LoreObstacle[] = [];
  const stack: { id: string; path: string[] }[] = [{ id, path: [] }];
  const seen = new Set<string>();

  while (stack.length) {
    const current = stack.pop()!;
    if (conflicts.has(current.id)) {
      obstacles.push({ class: "unavailable-due-to-conflict", id: current.id });
      continue;
    }
    const line = events.get(current.id);
    if (!line?.event) {
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
    for (const parent of line.event.parents) {
      stack.push({ id: parent, path: [...current.path, current.id] });
    }
  }

  return { ids: [...ids].sort(), partial: obstacles.length > 0, obstacles: normalizeObstacles(obstacles) };
}

function parsePhysicalLines(file: string, bytesOrString: Uint8Array | string) {
  const bytes = typeof bytesOrString === "string" ? textEncoder.encode(bytesOrString) : bytesOrString;
  const lines: { file: string; line: number; bytes: Uint8Array; terminator: "" | "\n" }[] = [];
  let start = 0;
  let line = 1;
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === 0x0a) {
      lines.push({ file, line, bytes: bytes.slice(start, i), terminator: "\n" });
      start = i + 1;
      line++;
    }
  }
  if (start < bytes.byteLength) {
    lines.push({ file, line, bytes: bytes.slice(start), terminator: "" });
  }
  return lines;
}

function parseLine(raw: { file: string; line: number; bytes: Uint8Array; terminator: "" | "\n" }): LoreLineDiagnostic {
  const base = { file: raw.file, line: raw.line, bytes: raw.bytes, terminator: raw.terminator } as const;
  const spliced = splitSplice(raw.bytes);
  if (spliced.digest && sha256Hex(spliced.bodyBytes) !== spliced.digest.slice("sha256:".length)) {
    return { ...base, class: "damaged", reason: "sha256 mismatch", bodyBytes: spliced.bodyBytes, bodyDigest: sha256Hex(spliced.bodyBytes), digest: spliced.digest, sig: spliced.sig };
  }

  let parsed: JsonParsed;
  try {
    parsed = parseJsonNoDuplicateKeys(decodeUtf8(spliced.bodyBytes));
  } catch (error) {
    return { ...base, class: "garbage", reason: errorMessage(error), bodyBytes: spliced.bodyBytes, bodyDigest: sha256Hex(spliced.bodyBytes), digest: spliced.digest, sig: spliced.sig };
  }

  const checked = validateEnvelope(parsed.value);
  if (!checked.ok) {
    return { ...base, class: "garbage", reason: checked.reason, bodyBytes: spliced.bodyBytes, bodyDigest: sha256Hex(spliced.bodyBytes), digest: spliced.digest, sig: spliced.sig };
  }

  const nonconformingReasons = checked.nonconforming;
  if (!raw.terminator) nonconformingReasons.push("final line missing LF");
  return {
    ...base,
    class: nonconformingReasons.length ? "nonconforming" : "accepted",
    reason: nonconformingReasons.join("; ") || "accepted",
    id: checked.event.id,
    event: checked.event,
    bodyBytes: spliced.bodyBytes,
    bodyDigest: sha256Hex(spliced.bodyBytes),
    digest: spliced.digest,
    sig: spliced.sig,
    hasDigest: Boolean(spliced.digest),
    hasSig: Boolean(spliced.sig),
    nonconformingReasons,
  };
}

function splitSplice(bytes: Uint8Array): { bodyBytes: Uint8Array; digest?: string; sig?: string } {
  const text = latin1Decode(bytes);
  const match = text.match(/,"digest":"(sha256:[0-9a-f]{64})"(?:,"sig":"([A-Za-z0-9+/]+={0,2})")?}$/);
  if (!match) return { bodyBytes: bytes };
  const sig = match[2];
  if (sig !== undefined && (sig.length === 0 || sig.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig) || /=.+[^=]/.test(sig))) {
    return { bodyBytes: bytes };
  }
  const bodyBytes = new Uint8Array(match.index! + 1);
  bodyBytes.set(bytes.slice(0, match.index));
  bodyBytes[bodyBytes.byteLength - 1] = 0x7d;
  return { bodyBytes, digest: match[1], sig };
}

function latin1Decode(bytes: Uint8Array): string {
  let text = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return text;
}

function markConflicts(lines: LoreLineDiagnostic[]): {
  acceptedById: Map<string, LoreLineDiagnostic>;
  conflictIds: Set<string>;
  conflictVariants: LoreConflictVariant[];
} {
  const byId = new Map<string, LoreLineDiagnostic[]>();
  for (const line of lines) {
    if (isUnionCandidate(line)) {
      const bucket = byId.get(line.id) ?? [];
      bucket.push(line);
      byId.set(line.id, bucket);
    }
  }
  const acceptedById = new Map<string, LoreLineDiagnostic>();
  const conflictIds = new Set<string>();
  const conflictVariants = new Map<string, LoreConflictVariant>();
  for (const bucket of byId.values()) {
    const bodies = new Set(bucket.map((line) => line.bodyDigest));
    if (bodies.size > 1) {
      for (const line of bucket) {
        line.class = "conflict-variant";
        line.reason = "same id with different body bytes";
        conflictIds.add(line.id!);
        const variant = conflictVariantFor(line);
        conflictVariants.set(`${variant.id}\0${variant.digest}`, variant);
      }
      continue;
    }
    let kept = bucket[0]!;
    for (let i = 1; i < bucket.length; i++) {
      bucket[i].duplicateSighting = true;
      if ((bucket[i].digest ?? "") !== (kept.digest ?? "") || (bucket[i].sig ?? "") !== (kept.sig ?? "")) {
        bucket[i].metadataDisagreement = true;
      }
      if (isRicherLine(bucket[i], kept)) kept = bucket[i];
    }
    acceptedById.set(kept.id!, kept);
  }
  return { acceptedById, conflictIds, conflictVariants: [...conflictVariants.values()] };
}

function validateEnvelope(value: unknown):
  | { ok: true; event: LoreEventBody; nonconforming: string[] }
  | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "top-level JSON value is not an object" };
  if ("digest" in value || "sig" in value) return { ok: false, reason: "reserved top-level digest/sig body member" };
  if (value.v !== 1) return { ok: false, reason: "unimplemented v" };
  if (typeof value.id !== "string") return { ok: false, reason: "id must be string" };
  if (typeof value.kind !== "string") return { ok: false, reason: "kind must be string" };
  const slash = value.kind.indexOf("/");
  if (slash <= 0 || slash === value.kind.length - 1) return { ok: false, reason: "kind requires namespace/name slash" };
  if (typeof value.at !== "string" || !isRfc3339(value.at)) return { ok: false, reason: "at fails RFC3339 ABNF" };
  if ("marked" in value && (typeof value.marked !== "string" || !isRfc3339(value.marked))) {
    return { ok: false, reason: "marked fails RFC3339 ABNF" };
  }
  if (!isRecord(value.author)) return { ok: false, reason: "author must be object" };
  if (typeof value.author.actor !== "string" || value.author.actor.length === 0) {
    return { ok: false, reason: "author.actor must be non-empty string" };
  }
  for (const field of ["operator", "via", "imported_by", "source"]) {
    if (field in value.author && typeof value.author[field] !== "string") {
      return { ok: false, reason: `author.${field} must be string` };
    }
  }
  if (!Array.isArray(value.parents) || !value.parents.every((parent) => typeof parent === "string")) {
    return { ok: false, reason: "parents must be list of strings" };
  }
  if (!isRecord(value.payload)) return { ok: false, reason: "payload must be object" };
  if ("critical" in value && typeof value.critical !== "boolean") return { ok: false, reason: "critical must be bool" };

  const nonconforming: string[] = [];
  for (const key of Object.keys(value)) {
    if (!topLevelFields.has(key)) nonconforming.push(`unknown top-level field ${key}`);
  }
  for (const key of Object.keys(value.author)) {
    if (!authorFields.has(key)) nonconforming.push(`unknown author field ${key}`);
  }
  return { ok: true, event: value as LoreEventBody, nonconforming };
}

function buildResult(
  lines: LoreLineDiagnostic[],
  acceptedById: Map<string, LoreLineDiagnostic>,
  conflictIds: Set<string>,
  conflictVariants: LoreConflictVariant[],
  pending: LorePendingDiagnostic[],
  pendingOverflowCount: number,
): LoreParseResult {
  const viewEligibleIds = [...acceptedById.keys()].filter((id) => !conflictIds.has(id)).sort();
  const graphDiagnostics = graphObstacles(acceptedById, conflictIds);
  const suppression = computeSuppression(acceptedById, conflictIds);

  return {
    lines,
    unionEventIds: viewEligibleIds,
    viewEligibleIds,
    conflictIds: [...conflictIds].sort(),
    conflictVariants: conflictVariants.sort((a, b) => compareStrings(`${a.id}\0${a.digest}`, `${b.id}\0${b.digest}`)),
    pending: pending.sort((a, b) => compareStrings(`${a.missingParent}\0${a.digest}`, `${b.missingParent}\0${b.digest}`)),
    pendingOverflowCount,
    suppression,
    graphDiagnostics,
  };
}

function isUnionCandidate(line: LoreLineDiagnostic): line is LoreLineDiagnostic & {
  id: string;
  event: LoreEventBody;
  bodyBytes: Uint8Array;
  bodyDigest: string;
} {
  return (line.class === "accepted" || line.class === "nonconforming") && Boolean(line.id && line.event && line.bodyBytes && line.bodyDigest);
}

function sameBody(a: LoreLineDiagnostic, b: LoreLineDiagnostic): boolean {
  return a.bodyDigest === b.bodyDigest && bytesEqual(a.bodyBytes, b.bodyBytes);
}

function isRicherLine(candidate: LoreLineDiagnostic, current: LoreLineDiagnostic): boolean {
  if (Boolean(candidate.sig) !== Boolean(current.sig)) return Boolean(candidate.sig);
  if (Boolean(candidate.digest) !== Boolean(current.digest)) return Boolean(candidate.digest);
  return false;
}

function conflictVariantFor(line: LoreLineDiagnostic): LoreConflictVariant {
  if (!line.id || !line.event || !line.bodyBytes || !line.bodyDigest) {
    throw new Error("conflict variant missing parsed event body");
  }
  return {
    id: line.id,
    digest: line.bodyDigest,
    file: line.file,
    line: line.line,
    bytes: line.bytes,
    bodyBytes: line.bodyBytes,
    event: line.event,
  };
}

function firstMissingParent(
  line: LoreLineDiagnostic & { event: LoreEventBody },
  acceptedById: Map<string, LoreLineDiagnostic>,
  conflictIds: Set<string>,
): string | undefined {
  const parent = line.event.parents[0];
  if (!parent) return undefined;
  if (acceptedById.has(parent)) return undefined;
  if (conflictIds.has(parent)) return undefined;
  return parent;
}

function computeSuppression(acceptedById: Map<string, LoreLineDiagnostic>, conflictIds: Set<string>) {
  const suppressed = new Set<string>();
  const dangling = new Set<string>();
  const eventIds = new Set([...acceptedById.keys()].filter((id) => !conflictIds.has(id)));
  for (const line of acceptedById.values()) {
    const event = line.event;
    if (line.class !== "accepted" || !event || event.critical !== true || conflictIds.has(event.id)) continue;
    const authorNames = names(event);
    for (const parent of event.parents) {
      const target = acceptedById.get(parent)?.event;
      if (!target || conflictIds.has(parent)) {
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

function graphObstacles(acceptedById: Map<string, LoreLineDiagnostic>, conflictIds: Set<string>): LoreObstacle[] {
  const obstacles: LoreObstacle[] = [];
  for (const line of acceptedById.values()) {
    const event = line.event;
    if (!event || conflictIds.has(event.id)) continue;
    for (const parent of event.parents) {
      if (conflictIds.has(parent)) obstacles.push({ class: "unavailable-due-to-conflict", id: parent });
      else if (!acceptedById.has(parent)) obstacles.push({ class: "dangling", missing: parent });
    }
  }
  for (const id of acceptedById.keys()) {
    if (conflictIds.has(id)) continue;
    const cycle = findCycle(id, acceptedById, conflictIds);
    if (cycle.length) obstacles.push({ class: "cycle", ids: cycle });
  }
  return normalizeObstacles(obstacles);
}

function findCycle(id: string, acceptedById: Map<string, LoreLineDiagnostic>, conflictIds: Set<string>): string[] {
  const visit = (current: string, path: string[]): string[] => {
    if (path.includes(current)) return path.slice(path.indexOf(current));
    if (conflictIds.has(current)) return [];
    const event = acceptedById.get(current)?.event;
    if (!event) return [];
    for (const parent of event.parents) {
      const found = visit(parent, [...path, current]);
      if (found.length) return found;
    }
    return [];
  };
  return visit(id, []);
}

function normalizeObstacles(obstacles: LoreObstacle[]): LoreObstacle[] {
  const seen = new Set<string>();
  const out: LoreObstacle[] = [];
  for (const obstacle of obstacles) {
    const key = JSON.stringify(obstacle);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(obstacle);
  }
  return out;
}

function names(event: LoreEventBody): Set<string> {
  return new Set([event.author.actor, event.author.operator, event.author.imported_by].filter((v): v is string => typeof v === "string" && v.length > 0));
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) if (b.has(item)) return true;
  return false;
}

function isRfc3339(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/);
  if (!match) return false;
  const [, , monthText, dayText, hourText, minuteText, secondText, , zone, offHourText, offMinuteText] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 60) return false;
  if (zone !== "Z" && zone !== "z" && (Number(offHourText) > 23 || Number(offMinuteText) > 59)) return false;
  return true;
}

function parseJsonNoDuplicateKeys(text: string): JsonParsed {
  let pos = 0;
  const parseValue = (): unknown => {
    skipWs();
    const ch = text[pos];
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') return parseString();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber();
    if (text.startsWith("true", pos)) return advanceLiteral("true", true);
    if (text.startsWith("false", pos)) return advanceLiteral("false", false);
    if (text.startsWith("null", pos)) return advanceLiteral("null", null);
    throw new SyntaxError("invalid JSON");
  };
  const parseObject = () => {
    pos++;
    const obj: Record<string, unknown> = {};
    const keys = new Set<string>();
    skipWs();
    if (text[pos] === "}") {
      pos++;
      return obj;
    }
    while (true) {
      skipWs();
      if (text[pos] !== '"') throw new SyntaxError("object member name must be string");
      const key = parseString();
      if (keys.has(key)) throw new SyntaxError("duplicate member name");
      keys.add(key);
      skipWs();
      if (text[pos++] !== ":") throw new SyntaxError("expected colon");
      obj[key] = parseValue();
      skipWs();
      const ch = text[pos++];
      if (ch === "}") return obj;
      if (ch !== ",") throw new SyntaxError("expected comma");
    }
  };
  const parseArray = () => {
    pos++;
    const arr: unknown[] = [];
    skipWs();
    if (text[pos] === "]") {
      pos++;
      return arr;
    }
    while (true) {
      arr.push(parseValue());
      skipWs();
      const ch = text[pos++];
      if (ch === "]") return arr;
      if (ch !== ",") throw new SyntaxError("expected comma");
    }
  };
  const parseString = () => {
    const start = pos;
    pos++;
    while (pos < text.length) {
      const ch = text[pos++];
      if (ch === "\\") {
        pos++;
        continue;
      }
      if (ch === '"') return JSON.parse(text.slice(start, pos)) as string;
      if (ch < " ") throw new SyntaxError("unescaped control character in string");
    }
    throw new SyntaxError("unterminated string");
  };
  const parseNumber = () => {
    const start = pos;
    if (text[pos] === "-") pos++;
    if (text[pos] === "0") pos++;
    else if (text[pos] >= "1" && text[pos] <= "9") while (text[pos] >= "0" && text[pos] <= "9") pos++;
    else throw new SyntaxError("invalid number");
    if (text[pos] === ".") {
      pos++;
      if (!(text[pos] >= "0" && text[pos] <= "9")) throw new SyntaxError("invalid number");
      while (text[pos] >= "0" && text[pos] <= "9") pos++;
    }
    if (text[pos] === "e" || text[pos] === "E") {
      pos++;
      if (text[pos] === "+" || text[pos] === "-") pos++;
      if (!(text[pos] >= "0" && text[pos] <= "9")) throw new SyntaxError("invalid number");
      while (text[pos] >= "0" && text[pos] <= "9") pos++;
    }
    return Number(text.slice(start, pos));
  };
  const advanceLiteral = (literal: string, value: unknown) => {
    pos += literal.length;
    return value;
  };
  const skipWs = () => {
    while (text[pos] === " " || text[pos] === "\n" || text[pos] === "\r" || text[pos] === "\t") pos++;
  };

  if (text[0] !== "{") throw new SyntaxError("bytes outside object or top-level is not object");
  const value = parseValue();
  if (pos !== text.length) throw new SyntaxError("bytes outside object");
  return { value };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
