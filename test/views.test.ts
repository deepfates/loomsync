import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLyncFiles } from "../src/events.js";
import {
  lyncBranchTreeView,
  lyncLeaderboardView,
  lyncMemoryView,
  lyncTranscriptView,
} from "../src/views.js";

const vectorsRoot = join(dirname(fileURLToPath(import.meta.url)), "vectors", "v0");

interface ExpectedFixture {
  inputs: string[];
}

function loadFixture(name: string) {
  const dir = join(vectorsRoot, name);
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as ExpectedFixture;
  return parseLyncFiles(
    expected.inputs.map((file) => ({
      file,
      bytes: readFileSync(join(dir, file)),
    })),
  );
}

function event(fields: {
  id: string;
  kind?: string;
  at?: string;
  author?: Record<string, unknown>;
  parents?: string[];
  payload?: Record<string, unknown>;
}) {
  return JSON.stringify({
    v: 1,
    id: fields.id,
    kind: fields.kind ?? "lync/artifact",
    at: fields.at ?? "2026-07-06T04:10:00Z",
    author: fields.author ?? { actor: "deepfates" },
    parents: fields.parents ?? [],
    payload: fields.payload ?? {},
  });
}

describe("lync views", () => {
  it("computes a branch tree DAG from vector parent links", () => {
    const result = loadFixture("01-valid-events");
    const tree = lyncBranchTreeView(result);

    expect(tree.roots).toEqual([
      "018f0000-0000-7000-8000-000000000001",
      "018f0000-0000-7000-8000-000000000004",
    ]);
    expect(tree.leaves).toEqual([
      "018f0000-0000-7000-8000-000000000003",
      "018f0000-0000-7000-8000-000000000004",
    ]);
    expect(tree.nodes.map((node) => [node.id, node.children])).toEqual([
      ["018f0000-0000-7000-8000-000000000001", ["018f0000-0000-7000-8000-000000000002"]],
      ["018f0000-0000-7000-8000-000000000002", ["018f0000-0000-7000-8000-000000000003"]],
      ["018f0000-0000-7000-8000-000000000003", []],
      ["018f0000-0000-7000-8000-000000000004", []],
    ]);
    expect(tree.partial).toBe(false);
  });

  it("surfaces graph obstacles in branch and memory views from vector 06", () => {
    const result = loadFixture("06-graph-obstacles");
    const tree = lyncBranchTreeView(result);
    const memory = lyncMemoryView(result);

    expect(tree.partial).toBe(true);
    expect(tree.obstacles).toEqual(result.graphDiagnostics);
    expect(tree.nodes.find((node) => node.id === "018f0000-0000-7000-8000-000000000054")?.missingParents).toEqual([
      "018f0000-0000-7000-8000-00000000ffff",
    ]);
    expect(tree.nodes.find((node) => node.id === "018f0000-0000-7000-8000-000000000056")?.conflictedParents).toEqual([
      "018f0000-0000-7000-8000-000000000055",
    ]);
    expect(memory.partial).toBe(true);
    expect(memory.conflictIds).toEqual(["018f0000-0000-7000-8000-000000000055"]);
  });

  it("computes a linear transcript over the chosen head downset", () => {
    const result = loadFixture("10-merge-union");
    const transcript = lyncTranscriptView(result, "018f0000-0000-7000-8000-000000000093");

    expect(transcript.entries.map((entry) => entry.id)).toEqual([
      "018f0000-0000-7000-8000-000000000091",
      "018f0000-0000-7000-8000-000000000092",
      "018f0000-0000-7000-8000-000000000093",
    ]);
    expect(transcript.downsetIds).toEqual([
      "018f0000-0000-7000-8000-000000000091",
      "018f0000-0000-7000-8000-000000000092",
      "018f0000-0000-7000-8000-000000000093",
    ]);
    expect(transcript.partial).toBe(false);
  });

  it("computes memory as current eligible events plus leaf frontier", () => {
    const result = loadFixture("10-merge-union");
    const memory = lyncMemoryView(result);

    expect(memory.events.map((entry) => entry.id)).toEqual([
      "018f0000-0000-7000-8000-000000000091",
      "018f0000-0000-7000-8000-000000000092",
      "018f0000-0000-7000-8000-000000000093",
    ]);
    expect(memory.frontierIds).toEqual(["018f0000-0000-7000-8000-000000000093"]);
    expect(memory.conflictIds).toEqual(["018f0000-0000-7000-8000-000000000094"]);
  });

  it("ranks scored and selected drafts from lync annotation events", () => {
    const input = [
      event({ id: "A", payload: { text: "root" } }),
      event({ id: "B", parents: ["A"], payload: { text: "patient bear" } }),
      event({ id: "C", parents: ["A"], payload: { text: "younger bears" } }),
      event({
        id: "D",
        kind: "lync/annotation",
        author: { actor: "witness-panel-v3" },
        parents: ["B"],
        payload: { label: "score", value: 0.91, basis: "panel" },
      }),
      event({
        id: "E",
        kind: "lync/annotation",
        author: { actor: "deepfates" },
        parents: ["B", "C"],
        payload: { label: "selection", chosen: ["B"], shown: ["B", "C"], basis: "human pick" },
      }),
      event({
        id: "F",
        kind: "lync/annotation",
        author: { actor: "witness-panel-v3" },
        parents: ["C"],
        payload: { label: "score", value: 0.2 },
      }),
    ].join("\n") + "\n";
    const result = parseLyncFiles([{ file: "worked.lync", bytes: input }]);
    const leaderboard = lyncLeaderboardView(result);

    expect(leaderboard.ignoredAnnotationIds).toEqual([]);
    expect(leaderboard.entries.map((entry) => ({
      targetId: entry.targetId,
      rank: entry.rank,
      scoreMean: entry.scoreMean,
      selectedCount: entry.selectedCount,
      selectionCount: entry.selectionCount,
    }))).toEqual([
      { targetId: "B", rank: 1, scoreMean: 0.91, selectedCount: 1, selectionCount: 1 },
      { targetId: "C", rank: 2, scoreMean: 0.2, selectedCount: 0, selectionCount: 1 },
    ]);
    expect(leaderboard.entries.find((entry) => entry.targetId === "B")?.selections).toEqual([
      { annotationId: "E", selected: true, chosen: ["B"], shown: ["B", "C"], author: { actor: "deepfates" }, at: "2026-07-06T04:10:00Z", basis: "human pick" },
    ]);
  });

  it("computes bit-identical scoreMean regardless of file order", () => {
    const files = [
      { file: "a.lync", bytes: [event({ id: "A", payload: { text: "root" } }), event({
        id: "S1",
        kind: "lync/annotation",
        author: { actor: "witness-panel-v3" },
        parents: ["A"],
        payload: { label: "score", value: 0.1 },
      })].join("\n") + "\n" },
      { file: "b.lync", bytes: event({
        id: "S2",
        kind: "lync/annotation",
        author: { actor: "witness-panel-v3" },
        parents: ["A"],
        payload: { label: "score", value: 0.2 },
      }) + "\n" },
      { file: "c.lync", bytes: event({
        id: "S3",
        kind: "lync/annotation",
        author: { actor: "witness-panel-v3" },
        parents: ["A"],
        payload: { label: "score", value: 0.3 },
      }) + "\n" },
    ];
    const forward = lyncLeaderboardView(parseLyncFiles(files));
    const reversed = lyncLeaderboardView(parseLyncFiles([...files].reverse()));

    const meanForward = forward.entries.find((entry) => entry.targetId === "A")?.scoreMean;
    const meanReversed = reversed.entries.find((entry) => entry.targetId === "A")?.scoreMean;
    expect(meanForward).not.toBeNull();
    expect(meanForward).toBeDefined();
    expect(Object.is(meanForward, meanReversed)).toBe(true);
  });

  it("carries empty chosen/shown arrays when the selection payload omits shown", () => {
    const input = [
      event({ id: "A", payload: { text: "root" } }),
      event({ id: "B", parents: ["A"], payload: { text: "left" } }),
      event({ id: "C", parents: ["A"], payload: { text: "right" } }),
      event({
        id: "G",
        kind: "lync/annotation",
        author: { actor: "deepfates" },
        parents: ["B", "C"],
        payload: { label: "selection", chosen: ["B"] },
      }),
    ].join("\n") + "\n";
    const result = parseLyncFiles([{ file: "worked.lync", bytes: input }]);
    const leaderboard = lyncLeaderboardView(result);

    const selectionsFor = (targetId: string) =>
      leaderboard.entries.find((entry) => entry.targetId === targetId)?.selections;
    expect(selectionsFor("B")).toEqual([
      { annotationId: "G", selected: true, chosen: ["B"], shown: [], author: { actor: "deepfates" }, at: "2026-07-06T04:10:00Z", basis: undefined },
    ]);
    expect(selectionsFor("C")).toEqual([
      { annotationId: "G", selected: false, chosen: ["B"], shown: [], author: { actor: "deepfates" }, at: "2026-07-06T04:10:00Z", basis: undefined },
    ]);
  });
});
