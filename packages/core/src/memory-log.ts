import { BaseEventStore } from "./store.js";

export class MemoryEventStore extends BaseEventStore {}

export function createMemoryEventStore(): MemoryEventStore {
  return new MemoryEventStore();
}
