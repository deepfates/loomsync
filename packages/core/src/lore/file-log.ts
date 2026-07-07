import fs from "node:fs/promises";
import path from "node:path";
import { BaseEventStore, type GarbageRecord } from "./store.js";

const STORE_FILE = "events.json";

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
    await this.writeLoreFiles();
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.options.dir, { recursive: true });
    try {
      const raw = await fs.readFile(path.join(this.options.dir, STORE_FILE), "utf8");
      await this.loadRecords(JSON.parse(raw) as Parameters<BaseEventStore["loadRecords"]>[0]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.loadLoreFiles();
    }
  }

  private async loadLoreFiles(): Promise<void> {
    const files = await fs.readdir(this.options.dir);
    for (const file of files.filter((candidate) => candidate.endsWith(".lore"))) {
      const raw = await fs.readFile(path.join(this.options.dir, file), "utf8");
      for (const line of raw.split("\n")) {
        if (line.length) await super.union(line);
      }
    }
  }

  private async writeLoreFiles(): Promise<void> {
    const roots = new Set(this.dumpRecords().events.map((event) => event.root));
    for (const root of roots) {
      const bytes = await super.exportRootBytes(root);
      await fs.writeFile(path.join(this.options.dir, `${encodeURIComponent(root)}.lore`), bytes);
    }
    const garbage: GarbageRecord[] = this.dumpRecords().garbage;
    if (garbage.length) {
      await fs.writeFile(path.join(this.options.dir, "garbage.json"), JSON.stringify(garbage, null, 2));
    }
  }
}

export function createFileEventStore(dir: string): FileEventStore {
  return new FileEventStore({ dir });
}
