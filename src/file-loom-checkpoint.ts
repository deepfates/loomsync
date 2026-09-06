import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  indexLyncSources,
  type IndexedLyncEvent,
  type IndexedLyncLocator,
  type ReReadableLyncSource,
} from "./indexed-union.js";
import { sha256Hex } from "./sha256.js";

const PROTOCOL = "lync/file-loom-checkpoint/v1" as const;
const LYNC_PREFIX = "lync:";
const STREAM_CHUNK_BYTES = 64 * 1024;

export interface FileLoomCheckpointSource {
  file: string;
  size: number;
  sha256: string;
}

export interface FileLoomCheckpointTip {
  id: string;
  parentId: string | null;
  depth: number;
  bodyDigest: string;
  chainDigest: string;
  locator: IndexedLyncLocator & { rawSha256: string };
}

export interface FileLoomCheckpoint {
  protocol: typeof PROTOCOL;
  loomId: string;
  sources: FileLoomCheckpointSource[];
  tip: FileLoomCheckpointTip;
}

export interface CaptureFileLoomCheckpointOptions {
  dir: string;
  loomId: string;
  tip: string;
  maxLineBytes?: number;
}

/**
 * Bind one explicitly selected Loom tip to exact prefixes of Lync's complete
 * canonical source set. Appends after capture do not change the checkpoint.
 */
export async function captureFileLoomCheckpoint(
  options: CaptureFileLoomCheckpointOptions,
): Promise<FileLoomCheckpoint> {
  validateSelection(options);
  const sourceSpecs = await captureCanonicalPrefixes(options.dir);
  const indexed = await indexLyncSources(
    sourceSpecs.map((source) => reReadablePrefix(options.dir, source)),
    options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes },
  );
  const tip = await selectedTip(indexed.readEvent, options.loomId, options.tip);
  return {
    protocol: PROTOCOL,
    loomId: options.loomId,
    sources: indexed.sources.map(({ file, size, sha256 }) => ({ file, size, sha256 })),
    tip,
  };
}

/** Re-authenticate a checkpoint and recompute its selected Loom truth. */
export async function verifyFileLoomCheckpoint(
  dir: string,
  checkpoint: FileLoomCheckpoint,
  options: { maxLineBytes?: number } = {},
): Promise<FileLoomCheckpointTip> {
  validateCheckpoint(checkpoint);
  const indexed = await indexLyncSources(
    checkpoint.sources.map((source) => reReadablePrefix(dir, source)),
    options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes },
  );
  const actual = await selectedTip(indexed.readEvent, checkpoint.loomId, checkpoint.tip.id);
  if (JSON.stringify(actual) !== JSON.stringify(checkpoint.tip)) {
    throw new Error("Lync file Loom checkpoint selected tip does not match canonical prefixes");
  }
  return actual;
}

async function selectedTip(
  readEvent: (id: string) => Promise<IndexedLyncEvent | null>,
  loomId: string,
  tipId: string,
): Promise<FileLoomCheckpointTip> {
  const rootId = loomRootId(loomId);
  const ancestry: IndexedLyncEvent[] = [];
  const seen = new Set<string>();
  let id = tipId;
  while (id !== rootId) {
    if (seen.has(id)) throw new Error(`Lync Loom selection contains a cycle at ${id}`);
    seen.add(id);
    const item = await readEvent(id);
    if (!item) throw new Error(`Unknown or conflicted Lync Loom turn: ${id}`);
    validateTurn(item);
    ancestry.push(item);
    id = item.event.parents[0]!;
  }
  const root = await readEvent(rootId);
  if (!root || root.event.kind !== "lync/loom" || root.event.parents.length !== 0) {
    throw new Error(`Unknown or conflicted Lync Loom: ${loomId}`);
  }
  let chainDigest = prefixDigest(null, requiredBodyDigest(root));
  for (const item of ancestry.reverse()) {
    chainDigest = prefixDigest(chainDigest, requiredBodyDigest(item));
  }
  const tip = ancestry.at(-1);
  if (!tip) throw new Error("A file Loom checkpoint tip must name a turn, not the Loom root");
  return {
    id: tip.event.id,
    parentId: tip.event.parents[0] === rootId ? null : tip.event.parents[0]!,
    depth: ancestry.length,
    bodyDigest: requiredBodyDigest(tip),
    chainDigest,
    locator: { ...tip.line.locator, rawSha256: tip.line.rawSha256 },
  };
}

function validateTurn(item: IndexedLyncEvent) {
  const event = item.event;
  if (
    event.kind !== "lync/turn" ||
    event.parents.length !== 1 ||
    !Number.isInteger(event.payload.ordinal) ||
    Number(event.payload.ordinal) < 0 ||
    !("payload" in event.payload)
  ) {
    throw new Error(`Invalid Lync Loom turn: ${event.id}`);
  }
}

function requiredBodyDigest(item: IndexedLyncEvent) {
  if (!item.line.bodyDigest) throw new Error(`Lync event lacks a body digest: ${item.event.id}`);
  return item.line.bodyDigest;
}

async function captureCanonicalPrefixes(dir: string) {
  const files = canonicalSourceFiles(await fsPromises.readdir(dir));
  if (files.length === 0) throw new Error("Lync file Loom checkpoint found no canonical sources");
  return Promise.all(files.map(async (file) => ({ file, size: (await fsPromises.stat(path.join(dir, file))).size })));
}

function reReadablePrefix(
  dir: string,
  source: { file: string; size: number; sha256?: string },
): ReReadableLyncSource {
  const filePath = path.join(dir, source.file);
  return {
    file: source.file,
    size: source.size,
    ...(source.sha256 === undefined ? {} : { expectedSha256: source.sha256 }),
    async *stream() {
      const handle = await fsPromises.open(filePath, "r");
      try {
        let offset = 0;
        while (offset < source.size) {
          const chunk = new Uint8Array(Math.min(STREAM_CHUNK_BYTES, source.size - offset));
          const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
          if (bytesRead === 0) throw new Error(`Lync source truncated: ${source.file}`);
          offset += bytesRead;
          yield chunk.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }
    },
    async read(start, end) {
      if (start < 0 || end < start || end > source.size) throw new Error(`Invalid Lync prefix read: ${source.file}`);
      const bytes = new Uint8Array(end - start);
      const handle = await fsPromises.open(filePath, "r");
      try {
        const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, start);
        if (bytesRead !== bytes.byteLength) throw new Error(`Lync source truncated: ${source.file}`);
        return bytes;
      } finally {
        await handle.close();
      }
    },
  };
}

function canonicalSourceFiles(files: string[]) {
  const ordinary = files.filter((file) => file.endsWith(".lync") || file.endsWith(".conflicts")).sort();
  if (files.includes("pending.events")) ordinary.push("pending.events");
  return ordinary;
}

function validateSelection(options: CaptureFileLoomCheckpointOptions) {
  if (!options || typeof options.dir !== "string" || options.dir.length === 0) throw new Error("Lync checkpoint requires a directory");
  loomRootId(options.loomId);
  if (typeof options.tip !== "string" || options.tip.length === 0) throw new Error("Lync checkpoint requires an explicit tip");
}

function validateCheckpoint(checkpoint: FileLoomCheckpoint) {
  if (!checkpoint || checkpoint.protocol !== PROTOCOL) throw new Error("Invalid Lync file Loom checkpoint protocol");
  loomRootId(checkpoint.loomId);
  if (!Array.isArray(checkpoint.sources) || checkpoint.sources.length === 0) throw new Error("Lync checkpoint requires canonical sources");
  const ordered = canonicalSourceFiles(checkpoint.sources.map((source) => source.file));
  if (ordered.length !== checkpoint.sources.length || ordered.some((file, index) => file !== checkpoint.sources[index]?.file)) {
    throw new Error("Lync checkpoint canonical source order is invalid");
  }
  if (new Set(ordered).size !== ordered.length) {
    throw new Error("Lync checkpoint canonical sources contain duplicates");
  }
  for (const source of checkpoint.sources) {
    if (path.basename(source.file) !== source.file) {
      throw new Error(`Invalid Lync checkpoint source path: ${source.file}`);
    }
    if (!Number.isSafeInteger(source.size) || source.size < 0 || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error(`Invalid Lync checkpoint source: ${source.file}`);
  }
  if (!checkpoint.tip || typeof checkpoint.tip.id !== "string") throw new Error("Lync checkpoint requires a selected tip");
}

function loomRootId(loomId: string) {
  if (!loomId.startsWith(LYNC_PREFIX) || loomId.length === LYNC_PREFIX.length) throw new Error(`Invalid Lync Loom id: ${loomId}`);
  return loomId.slice(LYNC_PREFIX.length);
}

function prefixDigest(parent: string | null, body: string) {
  return sha256Hex(new TextEncoder().encode(`lync-prefix-v1\0${parent ?? ""}\0${body}`));
}
