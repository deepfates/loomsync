import { createMemoryLooms, type MemoryLoomsOptions } from "@lync/core/memory";
import { createMemoryLoomIndexes, type MemoryLoomIndexesOptions } from "@lync/index/memory";
import { createLoomClient } from "./create.js";
import type { LoomClient } from "./types.js";

export interface TestLoomClientOptions {
  createId?: () => string;
  now?: () => number;
  looms?: MemoryLoomsOptions;
  indexes?: MemoryLoomIndexesOptions;
}

export function createTestLoomClient<
  TPayload = unknown,
  TLoomMeta = unknown,
  TTurnMeta = unknown,
  TEntryMeta = unknown,
  TIndexMeta = unknown,
>(
  options: TestLoomClientOptions = {},
): LoomClient<TPayload, TLoomMeta, TTurnMeta, TEntryMeta, TIndexMeta> {
  const defaultOptions = {
    createId: options.createId,
    now: options.now,
  };
  const looms = createMemoryLooms<TPayload, TLoomMeta, TTurnMeta>({
    ...defaultOptions,
    ...options.looms,
  });
  const indexes = createMemoryLoomIndexes<TEntryMeta, TIndexMeta>({
    ...defaultOptions,
    ...options.indexes,
  });

  return createLoomClient({ looms, indexes });
}
