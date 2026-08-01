import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseLyncFiles } from "../src/events.js";
import { presentLyncEvent, resolveLyncPresentationProfiles } from "../src/presentation.js";
import {
  indexLyncSources,
  type IndexedLyncLine,
  type ReReadableLyncSource,
} from "../src/indexed-union.js";

const vectorsRoot = join(dirname(fileURLToPath(import.meta.url)), "vectors", "v0");
const vectorNames = [
  "01-valid-events",
  "02-splice-anchoring",
  "03-damaged-digest",
  "04-garbage-classes",
  "05-conflicts-and-duplicates",
  "06-graph-obstacles",
  "07-critical-suppression",
  "08-spelling-vs-value",
  "09-marked-at-semantics",
  "10-merge-union",
  "11-nonconforming-carried",
  "12-invalid-sig-splice",
  "13-sig-without-digest",
] as const;

interface ExpectedLine {
  file: string;
  line: number;
  class: string;
  id?: string;
  has_digest?: boolean;
  has_sig?: boolean;
  duplicate_sighting?: boolean;
  metadata_disagreement?: boolean;
}

interface ExpectedFixture {
  inputs: string[];
  line_classifications: ExpectedLine[];
  union_event_ids?: string[];
  view_eligible_ids?: string[];
  conflict_ids?: string[];
  graph_diagnostics?: unknown[];
  suppression?: {
    suppressed_payload_ids?: string[];
    not_suppressed_ids?: string[];
    dangling_target_no_effect_until_union?: string[];
  };
  views?: Record<string, { ids: string[]; partial: boolean; obstacles: unknown[] }>;
}

function byteSource(file: string, bytes: Uint8Array, chunkBytes = 17): ReReadableLyncSource {
  return {
    file,
    size: bytes.byteLength,
    async *stream() {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
        yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes));
      }
    },
    async read(start, end) {
      return bytes.slice(start, end);
    },
  };
}

function generatedSource(
  file: string,
  prefix: string,
  count: number,
  paddingBytes: number,
  chunkBytes = 64 * 1024,
): ReReadableLyncSource {
  const encoder = new TextEncoder();
  const descriptors = Array.from({ length: count }, (_, index) => {
    const id = `${prefix}-${String(index).padStart(6, "0")}`;
    const parent = index === 0 ? [] : [`${prefix}-${String(index - 1).padStart(6, "0")}`];
    const start = JSON.stringify({
      v: 1,
      id,
      kind: "notes/text",
      at: "2026-08-01T00:00:00Z",
      author: { actor: prefix },
      parents: parent,
      payload: { text: `turn ${String(index).padStart(6, "0")}`, privatePadding: "" },
    });
    const marker = '"privatePadding":""';
    const markerAt = start.indexOf(marker);
    const head = `${start.slice(0, markerAt)}"privatePadding":"`;
    const tail = `"${start.slice(markerAt + marker.length)}`;
    return { head, tail, byteLength: encoder.encode(head).byteLength + paddingBytes + encoder.encode(tail).byteLength };
  });
  const offsets: number[] = [];
  let size = 0;
  for (const descriptor of descriptors) {
    offsets.push(size);
    size += descriptor.byteLength + 1;
  }
  const line = (index: number) => {
    const descriptor = descriptors[index]!;
    return encoder.encode(`${descriptor.head}${"x".repeat(paddingBytes)}${descriptor.tail}`);
  };
  return {
    file,
    size,
    async *stream() {
      for (let index = 0; index < descriptors.length; index += 1) {
        const bytes = line(index);
        for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
          yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes));
        }
        yield Uint8Array.of(0x0a);
      }
    },
    async read(start, end) {
      const index = offsets.indexOf(start);
      if (index < 0) return new Uint8Array();
      const bytes = line(index);
      if (end === start + bytes.byteLength) return bytes;
      if (end !== start + bytes.byteLength + 1) return new Uint8Array();
      const exact = new Uint8Array(bytes.byteLength + 1);
      exact.set(bytes);
      exact[bytes.byteLength] = 0x0a;
      return exact;
    },
  };
}

function eventLine(input: {
  id: string;
  parents?: string[];
  kind?: string;
  payload?: Record<string, unknown>;
}) {
  return `${JSON.stringify({
    v: 1,
    id: input.id,
    kind: input.kind ?? "notes/text",
    at: "2026-08-01T00:00:00Z",
    author: { actor: "fixture" },
    parents: input.parents ?? [],
    payload: input.payload ?? { text: input.id },
  })}\n`;
}

function expectedShape(line: IndexedLyncLine, expected: ExpectedLine) {
  return {
    file: line.locator.file,
    line: line.locator.line,
    class: line.class,
    ...(expected.id ? { id: line.id } : {}),
    ...(expected.has_digest !== undefined ? { has_digest: line.hasDigest } : {}),
    ...(expected.has_sig !== undefined ? { has_sig: line.hasSig } : {}),
    ...(expected.duplicate_sighting ? { duplicate_sighting: line.duplicateSighting } : {}),
    ...(expected.metadata_disagreement ? { metadata_disagreement: line.metadataDisagreement } : {}),
  };
}

describe("indexed Lync union v0 vectors", () => {
  for (const name of vectorNames) {
    it(`matches ${name}`, async () => {
      const directory = join(vectorsRoot, name);
      const expected = JSON.parse(readFileSync(join(directory, "expected.json"), "utf8")) as ExpectedFixture;
      const inputs = expected.inputs.map((file) => readFileSync(join(directory, file)));
      const indexed = await indexLyncSources(
        expected.inputs.map((file, index) => byteSource(file, inputs[index]!, 13)),
        { maxChunkBytes: 13, maxLineBytes: 1024 * 1024 },
      );
      const eager = parseLyncFiles(expected.inputs.map((file, index) => ({ file, bytes: inputs[index]! })));

      expect(indexed.lines.map((line, index) => expectedShape(line, expected.line_classifications[index]!)))
        .toEqual(expected.line_classifications.map((line) => ({
          file: line.file,
          line: line.line,
          class: line.class,
          ...(line.id ? { id: line.id } : {}),
          ...(line.has_digest !== undefined ? { has_digest: line.has_digest } : {}),
          ...(line.has_sig !== undefined ? { has_sig: line.has_sig } : {}),
          ...(line.duplicate_sighting ? { duplicate_sighting: true } : {}),
          ...(line.metadata_disagreement ? { metadata_disagreement: true } : {}),
        })));
      if (expected.union_event_ids) expect(indexed.unionEventIds).toEqual(expected.union_event_ids);
      if (expected.view_eligible_ids) expect(indexed.viewEligibleIds).toEqual(expected.view_eligible_ids);
      if (expected.conflict_ids) expect(indexed.conflictIds).toEqual(expected.conflict_ids);
      expect(indexed.graphDiagnostics).toEqual(eager.graphDiagnostics);
      if (expected.suppression?.suppressed_payload_ids) {
        expect(indexed.suppression.suppressedPayloadIds).toEqual(expected.suppression.suppressed_payload_ids);
      }
      if (expected.suppression?.not_suppressed_ids) {
        expect(indexed.suppression.notSuppressedIds).toEqual(expected.suppression.not_suppressed_ids);
      }
      if (expected.suppression?.dangling_target_no_effect_until_union) {
        expect(indexed.suppression.danglingTargetNoEffectUntilUnion)
          .toEqual(expected.suppression.dangling_target_no_effect_until_union);
      }
      for (const [viewName, view] of Object.entries(expected.views ?? {})) {
        expect(indexed.downset(viewName.slice("downset:".length))).toEqual(view);
      }

      const carried: Uint8Array[] = [];
      for await (const item of indexed.carriedLines()) carried.push(item.bytes);
      expect(Buffer.concat(carried.map((bytes) => Buffer.from(bytes))))
        .toEqual(Buffer.concat(inputs.map((bytes) => Buffer.from(bytes))));
      expect(indexed.ownership).toMatchObject({
        sourceBytesScanned: inputs.reduce((sum, bytes) => sum + bytes.byteLength, 0),
        lineCount: expected.line_classifications.length,
        retainedRawBytes: 0,
        retainedPayloadObjects: 0,
        retainedLineLocators: expected.line_classifications.length,
        retainedSourceHandles: expected.inputs.length,
      });
      if (name === "06-graph-obstacles") {
        expect(indexed.pendingParents.map(({ id, missingParent }) => ({ id, missingParent }))).toEqual([{
          id: "018f0000-0000-7000-8000-000000000054",
          missingParent: "018f0000-0000-7000-8000-00000000ffff",
        }]);
      }
    });
  }

  it("matches eager union and presentation across reordered Behold sources and duplicates", async () => {
    const aster = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "presentation", "oxford-aster-human-semantic-v1.lync"));
    const cedar = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "presentation", "oxford-cedar-human-semantic-v2.lync"));
    const inputs = [
      { file: "aster.lync", bytes: aster },
      { file: "cedar.lync", bytes: cedar },
      { file: "aster-copy.lync", bytes: aster },
    ];
    const eager = parseLyncFiles(inputs);
    const expectedEvents = new Map(
      eager.lines.flatMap((line) => line.event && eager.viewEligibleIds.includes(line.event.id)
        ? [[line.event.id, line.event] as const]
        : []),
    );
    const eagerProfiles = resolveLyncPresentationProfiles(expectedEvents.values());

    for (const ordered of [inputs, [...inputs].reverse()]) {
      const indexed = await indexLyncSources(
        ordered.map((input) => byteSource(input.file, input.bytes, 31)),
        { maxChunkBytes: 31 },
      );
      expect(indexed.unionEventIds).toEqual(eager.unionEventIds);
      expect(indexed.conflictIds).toEqual(eager.conflictIds);
      expect(indexed.graphDiagnostics).toEqual(eager.graphDiagnostics);
      expect(indexed.suppression).toEqual(eager.suppression);

      const actualEvents = new Map<string, unknown>();
      const actualOrder: string[] = [];
      for await (const item of indexed.events()) {
        actualOrder.push(item.event.id);
        actualEvents.set(item.event.id, item.event);
        expect(indexed.presentationProfile(item.event.id)).toBe(eagerProfiles.get(item.event.id) ?? null);
        expect(presentLyncEvent(item.event, {
          loomProfile: indexed.presentationProfile(item.event.id) ?? undefined,
        })).toEqual(presentLyncEvent(expectedEvents.get(item.event.id)!, {
          loomProfile: eagerProfiles.get(item.event.id),
        }));
      }
      expect(actualEvents).toEqual(expectedEvents);
      expect(actualOrder).toEqual(eager.viewEligibleIds);
    }
  });

  it("matches eager diagnostics for every parent edge and presentation inheritance through ambiguity and cycles", async () => {
    const text = [
      eventLine({ id: "root-a", kind: "lync/loom", payload: { meta: { profile: "profile/a" } } }),
      eventLine({ id: "root-b", kind: "lync/loom", payload: { meta: { profile: "profile/b" } } }),
      eventLine({ id: "extra-parent-gap", parents: ["root-a", "missing-extra"] }),
      eventLine({ id: "ambiguous", parents: ["root-a", "root-b"] }),
      eventLine({ id: "cycle-a", parents: ["cycle-b"] }),
      eventLine({ id: "cycle-b", parents: ["cycle-a"] }),
    ].join("");
    const bytes = new TextEncoder().encode(text);
    const eager = parseLyncFiles([{ file: "topology.lync", bytes }]);
    const eagerEvents = eager.lines.flatMap((line) => line.event ? [line.event] : []);
    const eagerProfiles = resolveLyncPresentationProfiles(eagerEvents);
    const indexed = await indexLyncSources([byteSource("topology.lync", bytes, 7)], { maxChunkBytes: 7 });

    expect(indexed.unionEventIds).toEqual(eager.unionEventIds);
    expect(indexed.graphDiagnostics).toEqual(eager.graphDiagnostics);
    expect(indexed.graphDiagnostics).toContainEqual({ class: "dangling", missing: "missing-extra" });
    expect(indexed.pendingParents).toEqual([]);
    for (const id of eager.viewEligibleIds) {
      expect(indexed.presentationProfile(id)).toBe(eagerProfiles.get(id) ?? null);
    }
    expect(indexed.presentationProfile("extra-parent-gap")).toBe("profile/a");
    expect(indexed.presentationProfile("ambiguous")).toBeNull();
    expect(indexed.presentationProfile("cycle-a")).toBeNull();
    expect(indexed.presentationProfile("cycle-b")).toBeNull();
  });

  it("fails closed when a re-readable source truncates or changes after indexing", async () => {
    const original = new TextEncoder().encode(
      '{"v":1,"id":"root","kind":"notes/text","at":"2026-08-01T00:00:00Z","author":{"actor":"a"},"parents":[],"payload":{"text":"safe"}}\n',
    );
    let current = original;
    const mutable: ReReadableLyncSource = {
      file: "mutable.lync",
      size: original.byteLength,
      async *stream() {
        yield current;
      },
      async read(start, end) {
        return current.slice(start, end);
      },
    };
    const indexed = await indexLyncSources([mutable]);
    current = new TextEncoder().encode(new TextDecoder().decode(original).replace("safe", "evil"));
    await expect(indexed.readEvent("root")).rejects.toThrow(/changed or reordered/);

    const truncated: ReReadableLyncSource = {
      ...mutable,
      file: "truncated.lync",
      size: original.byteLength,
      async *stream() {
        yield original.subarray(0, original.byteLength - 2);
      },
    };
    await expect(indexLyncSources([truncated])).rejects.toThrow(/supplied .* expected/);

    const digestBound = byteSource("digest-bound.lync", original);
    digestBound.expectedSha256 = "0".repeat(64);
    await expect(indexLyncSources([digestBound])).rejects.toThrow(/does not match expected SHA-256/);
    digestBound.expectedSha256 = createHash("sha256").update(original).digest("hex");
    const authenticated = await indexLyncSources([digestBound]);
    expect(authenticated.sources[0]?.sha256).toBe(digestBound.expectedSha256);
  });

  it("retains compact metadata independent of payload byte size", async () => {
    const small = await indexLyncSources([generatedSource("small.lync", "small", 4, 8)]);
    const large = await indexLyncSources([generatedSource("large.lync", "large", 4, 512 * 1024)]);
    expect(large.ownership.sourceBytesScanned).toBeGreaterThan(small.ownership.sourceBytesScanned * 1_000);
    expect(large.ownership.retainedRawBytes).toBe(0);
    expect(large.ownership.retainedPayloadObjects).toBe(0);
    expect(large.ownership.retainedObjectCount).toBeGreaterThan(0);
    expect(JSON.stringify(large.lines).length).toBeLessThan(JSON.stringify(small.lines).length * 2);
    expect(JSON.stringify(large.lines)).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  });

  it("scans and presents a generated six-hour two-resident byte horizon with bounded raw ownership", async () => {
    const sixHourBytes = 6 * 78 * 1024 * 1024;
    const paddingBytes = 64 * 1024;
    const turnsPerResident = Math.ceil(sixHourBytes / 2 / paddingBytes);
    const sources = [
      generatedSource("OxfordAsh.lync", "OxfordAsh", turnsPerResident, paddingBytes),
      generatedSource("OxfordReed.lync", "OxfordReed", turnsPerResident, paddingBytes),
    ];
    const indexed = await indexLyncSources(sources, {
      maxChunkBytes: 64 * 1024,
      maxLineBytes: 128 * 1024,
    });
    let presented = 0;
    for await (const item of indexed.events()) {
      const result = presentLyncEvent(item.event);
      if (result.status === "presented") presented += 1;
    }
    expect(indexed.ownership.sourceBytesScanned).toBeGreaterThanOrEqual(sixHourBytes);
    expect(indexed.ownership.lineCount).toBe(turnsPerResident * 2);
    expect(presented).toBe(turnsPerResident * 2);
    expect(indexed.ownership.maxChunkBytesObserved).toBeLessThanOrEqual(64 * 1024);
    expect(indexed.ownership.maxLineBytesObserved).toBeLessThan(128 * 1024);
    expect(indexed.ownership.retainedRawBytes).toBe(0);
    expect(indexed.ownership.retainedPayloadObjects).toBe(0);
    expect(indexed.ownership.retainedLineLocators).toBe(turnsPerResident * 2);
    expect(indexed.ownership.retainedEnvelopes).toBe(turnsPerResident * 2);
  }, 120_000);
});
