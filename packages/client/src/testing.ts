import { createMemoryEventStore } from "lync-core/memory-log";
import { createLyncLooms, type LyncAuthor } from "lync-core/looms";
import { createMemoryLoomIndexes } from "lync-index/memory";
import { createLoomClient } from "./create.js";
import type { LoomClient } from "./types.js";

/**
 * A fully in-memory loom client for tests and embedded experiments: looms and
 * an index over memory event stores, no network. Deterministic when you pass
 * `createId` and `now`.
 */
export interface TestLoomClientOptions {
  author?: LyncAuthor;
  createId?: () => string;
  now?: () => number;
}

export function createTestLoomClient<
  TPayload = unknown,
  TLoomMeta = unknown,
  TTurnMeta = unknown,
  TEntryMeta = unknown,
  TIndexMeta = unknown,
>(options: TestLoomClientOptions = {}): LoomClient<TPayload, TLoomMeta, TTurnMeta, TEntryMeta, TIndexMeta> {
  const store = createMemoryEventStore();
  const looms = createLyncLooms<TPayload, TLoomMeta, TTurnMeta>({
    store,
    author: options.author ?? { actor: "test" },
    createId: options.createId,
    now: options.now,
  });
  const indexes = createMemoryLoomIndexes<TEntryMeta, TIndexMeta>({
    createId: options.createId,
    now: options.now,
  });
  return createLoomClient<TPayload, TLoomMeta, TTurnMeta, TEntryMeta, TIndexMeta>({ looms, indexes });
}
