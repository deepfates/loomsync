import { describe, expect, it } from "vitest";
import { createMemoryLooms } from "../../core/src/index.js";
import {
  appendChain,
  flattenThread,
  snapshotFromNestedStory,
  threadToStoryTurns,
  type StoryNode,
  type TextPayload,
} from "../src/index.js";

describe("text helpers", () => {
  it("appends a text chain and flattens the resulting thread", async () => {
    const looms = createMemoryLooms<TextPayload>({
      createId: (() => {
        let id = 0;
        return () => `turn-${++id}`;
      })(),
      now: () => 1,
    });
    const info = await looms.create();
    const loom = await looms.open(info.id);

    const turns = await appendChain(loom, null, [
      { text: "Once" },
      { text: " upon" },
      { text: " a time" },
    ]);

    const thread = await loom.threadTo(turns.at(-1)!.id);
    expect(flattenThread(thread)).toBe("Once upon a time");
    expect(threadToStoryTurns(thread)).toEqual([
      { id: "turn-2", text: "Once" },
      { id: "turn-3", text: " upon" },
      { id: "turn-4", text: " a time" },
    ]);
  });

  it("converts a Loompad-style nested StoryNode tree into a flat snapshot without UI state", () => {
    const tree: { root: StoryNode } = {
      root: {
        id: "root",
        text: "",
        lastSelectedIndex: 1,
        continuations: [
          {
            id: "a",
            text: "A",
            lastSelectedIndex: 0,
            continuations: [{ id: "b", text: "B", continuations: [] }],
          },
          { id: "c", text: "C", continuations: [] },
        ],
      },
    };

    const snapshot = snapshotFromNestedStory(tree, {
      id: "snapshot:story",
      createdAt: 123,
      meta: { title: "Story" },
    });

    expect(snapshot.turns).toEqual([
      {
        id: "a",
        loomId: "snapshot:story",
        parentId: null,
        payload: { text: "A" },
        createdAt: 123,
      },
      {
        id: "b",
        loomId: "snapshot:story",
        parentId: "a",
        payload: { text: "B" },
        createdAt: 123,
      },
      {
        id: "c",
        loomId: "snapshot:story",
        parentId: null,
        payload: { text: "C" },
        createdAt: 123,
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("lastSelectedIndex");
  });
});
