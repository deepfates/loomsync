import type {
  LoomIndex,
  LoomIndexEntry,
  LoomIndexEntryInput,
} from "./types.js";
import type { LoomRootId } from "@loomsync/core";

export async function upsertRoot<TEntryMeta, TIndexMeta>(
  index: LoomIndex<TEntryMeta, TIndexMeta>,
  rootId: LoomRootId,
  entry: LoomIndexEntryInput<TEntryMeta> = {},
): Promise<LoomIndexEntry<TEntryMeta>> {
  if (await index.has(rootId)) {
    return index.updateRoot(rootId, entry);
  }
  return index.addRoot(rootId, entry);
}
