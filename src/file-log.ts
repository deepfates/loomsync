import fs from "node:fs/promises";
import path from "node:path";
import type { Looms } from "./types.js";
import { createLyncLooms, type LyncLoomsOptions } from "./looms.js";
import { BaseEventStore, type GarbageRecord } from "./store.js";

const STORE_FILE = "events.json";
const EVENT_FILE_EXTENSIONS = [".lync"];

export interface FileEventStoreOptions {
  dir: string;
}

export class FileEventStore extends BaseEventStore {
  private ready: Promise<void>;

  constructor(private readonly options: FileEventStoreOptions) {
    super();
    this.ready = this.load();
  }

  override async append(ev: Parameters<BaseEventStore["append"]>[0]) {
    await this.ready;
    return super.append(ev);
  }

  override async appendMany(events: Parameters<BaseEventStore["appendMany"]>[0]) {
    await this.ready;
    return super.appendMany(events);
  }

  override async union(line: string) {
    await this.ready;
    return super.union(line);
  }

  override async byId(id: string) {
    await this.ready;
    return super.byId(id);
  }

  override async byRoot(rootId: string) {
    await this.ready;
    return super.byRoot(rootId);
  }

  override async roots(kind?: "lync/loom" | "lync/index") {
    await this.ready;
    return super.roots(kind);
  }

  override async diagnostics() {
    await this.ready;
    return super.diagnostics();
  }

  override async exportRootBytes(rootId: string) {
    await this.ready;
    return super.exportRootBytes(rootId);
  }

  protected override async persist(): Promise<void> {
    await fs.mkdir(this.options.dir, { recursive: true });
    await fs.writeFile(path.join(this.options.dir, STORE_FILE), JSON.stringify(this.dumpRecords(), null, 2));
    await this.writeLyncFiles();
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.options.dir, { recursive: true });
    try {
      const raw = await fs.readFile(path.join(this.options.dir, STORE_FILE), "utf8");
      await this.loadRecords(JSON.parse(raw) as Parameters<BaseEventStore["loadRecords"]>[0]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.loadLyncFiles();
    }
  }

  private async loadLyncFiles(): Promise<void> {
    const files = await fs.readdir(this.options.dir);
    for (const file of files.filter(isEventFile).sort()) {
      const raw = await fs.readFile(path.join(this.options.dir, file), "utf8");
      for (const line of raw.split("\n")) {
        if (line.length) await super.union(line);
      }
    }
  }

  private async writeLyncFiles(): Promise<void> {
    const records = this.dumpRecords();
    const roots = new Set(records.events.map((event) => event.root));
    for (const root of roots) {
      const events = records.events
        .filter((event) => event.root === root)
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      const bytes = events.map((event) => event.bytes).join("\n") + (events.length ? "\n" : "");
      await fs.writeFile(path.join(this.options.dir, `${encodeURIComponent(root)}.lync`), bytes);
    }
    const garbage: GarbageRecord[] = records.garbage;
    if (garbage.length) {
      await fs.writeFile(path.join(this.options.dir, "garbage.json"), JSON.stringify(garbage, null, 2));
    }
  }
}

export function createFileEventStore(dir: string): FileEventStore {
  return new FileEventStore({ dir });
}

// File-backed looms live here, not in looms.ts, so the browser-reachable
// modules never statically import this node:fs/node:path file.
export function createFileLyncLooms<
  TPayload = unknown,
  TLoomMeta = unknown,
  TTurnMeta = unknown,
>(dir: string, options: Omit<LyncLoomsOptions, "store">): Looms<TPayload, TLoomMeta, TTurnMeta> {
  return createLyncLooms({ ...options, store: createFileEventStore(dir) });
}

function isEventFile(file: string): boolean {
  return EVENT_FILE_EXTENSIONS.some((extension) => file.endsWith(extension));
}
