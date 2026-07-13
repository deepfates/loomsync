import { describe, expect, it } from "vitest";
import { createMemoryEventStore } from "@deepfates/lync/memory-log";
import { createLyncLooms } from "@deepfates/lync/looms";
import { createMemoryLoomIndexes } from "@deepfates/lync/indexes/memory";
import { upsertLoom } from "@deepfates/lync/indexes/entries";
import { createLoomClient } from "../../src/client/create.js";

function makeClient() {
  const store = createMemoryEventStore();
  const looms = createLyncLooms<{ text: string }, { title: string }, { role: string }>({
    store,
    author: { actor: "tester" },
  });
  const indexes = createMemoryLoomIndexes<{ note: string }, { app: string }>();
  return createLoomClient({ looms, indexes });
}

describe("createLoomClient", () => {
  it("composes looms and indexes and resolves a loom reference", async () => {
    const client = makeClient();
    const info = await client.looms.create({ title: "Story" });

    const opened = await client.openReference(client.references.loom(info.id));
    expect(opened.kind).toBe("loom");
    if (opened.kind === "loom") {
      const turn = await opened.loom.appendTurn(null, { text: "hi" }, { role: "prose" });
      expect(turn.payload.text).toBe("hi");
    }
    await client.close();
  });

  it("resolves an index reference and lists upserted looms", async () => {
    const client = makeClient();
    const index = await client.indexes.create({ app: "test" });
    const loom = await client.looms.create({ title: "In Index" });
    await upsertLoom(index, client.references.loom(loom.id), { note: "first" });

    const opened = await client.openReference(client.references.index(index.id));
    expect(opened.kind).toBe("index");
    if (opened.kind === "index") {
      const entries = await opened.index.entries();
      expect(entries).toHaveLength(1);
    }
    await client.close();
  });
});
