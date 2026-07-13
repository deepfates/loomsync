import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  exportCarriedLyncBytes,
  LyncUnion,
  lyncDownset,
  parseLyncFiles,
  type LyncLineDiagnostic,
} from "../src/events.js";

const vectorsRoot = join(dirname(fileURLToPath(import.meta.url)), "vectors", "v0");

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
  fixture: string;
  inputs: string[];
  line_classifications: ExpectedLine[];
  union_event_ids?: string[];
  view_eligible_ids?: string[];
  conflict_ids?: string[];
  suppression?: {
    suppressed_payload_ids?: string[];
    not_suppressed_ids?: string[];
    dangling_target_no_effect_until_union?: string[];
  };
  views?: Record<
    string,
    {
      ids: string[];
      partial: boolean;
      obstacles: unknown[];
    }
  >;
}

function loadFixture(name: string) {
  const dir = join(vectorsRoot, name);
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as ExpectedFixture;
  const result = parseLyncFiles(
    expected.inputs.map((file) => ({
      file,
      bytes: readFileSync(join(dir, file)),
    })),
  );
  return { dir, expected, result };
}

function eventBody(fields: {
  id: string;
  kind?: string;
  at?: string;
  author?: Record<string, unknown>;
  parents?: string[];
  payload?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}) {
  return JSON.stringify({
    v: 1,
    id: fields.id,
    kind: fields.kind ?? "hostile/event",
    at: fields.at ?? "2026-07-07T00:00:00Z",
    author: fields.author ?? { actor: "alice" },
    parents: fields.parents ?? [],
    payload: fields.payload ?? {},
    ...fields.extra,
  });
}

function digestFor(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function simplifyLine(line: LyncLineDiagnostic): ExpectedLine {
  return {
    file: line.file,
    line: line.line,
    class: line.class,
    ...(line.id ? { id: line.id } : {}),
    ...(line.hasDigest !== undefined ? { has_digest: line.hasDigest } : {}),
    ...(line.hasSig !== undefined ? { has_sig: line.hasSig } : {}),
    ...(line.duplicateSighting ? { duplicate_sighting: true } : {}),
    ...(line.metadataDisagreement ? { metadata_disagreement: true } : {}),
  };
}

function lineForExpected(line: LyncLineDiagnostic, expected: ExpectedLine): ExpectedLine {
  const simplified = simplifyLine(line);
  return {
    file: simplified.file,
    line: simplified.line,
    class: simplified.class,
    ...(expected.id ? { id: simplified.id } : {}),
    ...(expected.has_digest !== undefined ? { has_digest: simplified.has_digest } : {}),
    ...(expected.has_sig !== undefined ? { has_sig: simplified.has_sig } : {}),
    ...(expected.duplicate_sighting ? { duplicate_sighting: simplified.duplicate_sighting } : {}),
    ...(expected.metadata_disagreement ? { metadata_disagreement: simplified.metadata_disagreement } : {}),
  };
}

describe("lync v0 line parser vectors", () => {
  for (const name of [
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
  ]) {
    it(`matches ${name}`, () => {
      const { expected, result } = loadFixture(name);
      expect(result.lines.map((line, index) => lineForExpected(line, expected.line_classifications[index]!))).toEqual(
        expected.line_classifications.map((line) => ({
          file: line.file,
          line: line.line,
          class: line.class,
          ...(line.id ? { id: line.id } : {}),
          ...(line.has_digest !== undefined ? { has_digest: line.has_digest } : {}),
          ...(line.has_sig !== undefined ? { has_sig: line.has_sig } : {}),
          ...(line.duplicate_sighting ? { duplicate_sighting: true } : {}),
          ...(line.metadata_disagreement ? { metadata_disagreement: true } : {}),
        })),
      );
      if (expected.union_event_ids) expect(result.unionEventIds).toEqual(expected.union_event_ids);
      if (expected.view_eligible_ids) expect(result.viewEligibleIds).toEqual(expected.view_eligible_ids);
      if (expected.conflict_ids) expect(result.conflictIds).toEqual(expected.conflict_ids);
      if (expected.suppression?.suppressed_payload_ids) {
        expect(result.suppression.suppressedPayloadIds).toEqual(expected.suppression.suppressed_payload_ids);
      }
      if (expected.suppression?.not_suppressed_ids) {
        expect(result.suppression.notSuppressedIds).toEqual(expected.suppression.not_suppressed_ids);
      }
      if (expected.suppression?.dangling_target_no_effect_until_union) {
        expect(result.suppression.danglingTargetNoEffectUntilUnion).toEqual(
          expected.suppression.dangling_target_no_effect_until_union,
        );
      }
      for (const [viewName, view] of Object.entries(expected.views ?? {})) {
        const id = viewName.slice("downset:".length);
        const actual = lyncDownset(result, id);
        expect(actual.ids).toEqual(view.ids);
        expect(actual.partial).toBe(view.partial);
        expect(actual.obstacles).toEqual(view.obstacles);
      }
    });
  }

  it("round-trips garbage and damaged lines through carried export", () => {
    const { dir, expected, result } = loadFixture("03-damaged-digest");
    const exported = exportCarriedLyncBytes(result);
    const original = Buffer.concat(expected.inputs.map((file) => readFileSync(join(dir, file))));
    expect(Buffer.from(exported).equals(original)).toBe(true);

    const garbage = loadFixture("04-garbage-classes");
    const garbageExported = exportCarriedLyncBytes(garbage.result);
    const garbageOriginal = Buffer.concat(
      garbage.expected.inputs.map((file) => readFileSync(join(garbage.dir, file))),
    );
    expect(Buffer.from(garbageExported).equals(garbageOriginal)).toBe(true);
  });

  it("parses digest splices without Buffer", () => {
    const originalBuffer = globalThis.Buffer;
    try {
      // @ts-expect-error exercises the browser bundle path under a Node test runner.
      delete globalThis.Buffer;
      const body = eventBody({ id: "browser-no-buffer", kind: "lync/artifact" });
      const line = `${body.slice(0, -1)},"digest":"${digestFor(new TextEncoder().encode(body))}"}\n`;
      const result = parseLyncFiles([{ file: "browser.lync", bytes: new TextEncoder().encode(line) }]);

      expect(result.lines[0]?.class).toBe("accepted");
      expect(result.lines[0]?.id).toBe("browser-no-buffer");
      expect(result.unionEventIds).toEqual(["browser-no-buffer"]);
    } finally {
      globalThis.Buffer = originalBuffer;
    }
  });

  it("surfaces and carries unknown fields without dropping them", () => {
    const { result } = loadFixture("11-nonconforming-carried");
    expect(result.lines.map((line) => line.class)).toEqual(["nonconforming", "nonconforming"]);
    expect(result.lines[0]?.event?.["mood"]).toBe("future");
    expect(result.lines[1]?.event?.author["role"]).toBe("extra");
    expect(result.unionEventIds).toEqual([
      "018f0000-0000-7000-8000-000000000101",
      "018f0000-0000-7000-8000-000000000102",
    ]);
  });

  it("classifies duplicate decoded member names as garbage and preserves the bytes", () => {
    const { result } = loadFixture("08-spelling-vs-value");
    const duplicate = result.lines.find((line) => line.line === 4);
    expect(duplicate?.class).toBe("garbage");
    expect(Buffer.from(duplicate?.bytes ?? new Uint8Array()).toString("utf8")).toContain('"\\u0061"');
  });

  it("keeps source filenames in diagnostics", () => {
    const { result } = loadFixture("10-merge-union");
    expect(result.lines.map((line) => basename(line.file))).toEqual([
      "a.lync",
      "a.lync",
      "a.lync",
      "b.lync",
      "b.lync",
      "b.lync",
    ]);
    expect(result.conflictVariants).toHaveLength(2);
    expect(result.conflictVariants.map((variant) => `${variant.id}:${variant.digest}`)).toEqual([
      "018f0000-0000-7000-8000-000000000094:803e3ebd8093762e392c7a3e89dd3c2213f14346945e7a1f7ffd649785a6b44c",
      "018f0000-0000-7000-8000-000000000094:af8ea1492ec51753fff3a07ef5c7ae79a9072bed3485292f9ac3e9b2c6c7ca21",
    ]);
  });

  it("surfaces same-id different body variants and excludes them from normal views", () => {
    const first = `${eventBody({ id: "same", payload: { text: "first" } })}\n`;
    const second = `${eventBody({ id: "same", payload: { text: "second" } })}\n`;
    const result = parseLyncFiles([
      { file: "a.lync", bytes: first },
      { file: "b.lync", bytes: second },
    ]);

    expect(result.lines.map((line) => line.class)).toEqual(["conflict-variant", "conflict-variant"]);
    expect(result.conflictIds).toEqual(["same"]);
    expect(result.unionEventIds).toEqual([]);
    expect(result.viewEligibleIds).toEqual([]);
    expect(result.conflictVariants.map((variant) => variant.digest)).toEqual([
      createHash("sha256").update(eventBody({ id: "same", payload: { text: "second" } })).digest("hex"),
      createHash("sha256").update(eventBody({ id: "same", payload: { text: "first" } })).digest("hex"),
    ]);
  });

  it("buffers missing first-parent arrivals and drains pending children in cascade", () => {
    const union = new LyncUnion({ pendingLimit: 1 });
    const grandchild = `${eventBody({ id: "grandchild", parents: ["child"] })}\n`;
    const child = `${eventBody({ id: "child", parents: ["root"] })}\n`;
    const root = `${eventBody({ id: "root" })}\n`;

    const first = union.union({ file: "grandchild.lync", bytes: grandchild });
    const second = union.union({ file: "child.lync", bytes: child });
    expect(first[0]?.status).toBe("buffered");
    expect(second[0]?.status).toBe("buffered");
    expect(union.result().pending.map((line) => line.id).sort()).toEqual(["child", "grandchild"]);
    expect(union.result().pendingOverflowCount).toBe(1);

    const third = union.union({ file: "root.lync", bytes: root });
    expect(third[0]?.status).toBe("added");
    expect(third[0]?.drained?.map((result) => result.status)).toEqual(["added"]);
    expect(third[0]?.drained?.[0]?.drained?.map((result) => result.status)).toEqual(["added"]);

    const result = union.result();
    expect(result.pending).toEqual([]);
    expect(result.unionEventIds).toEqual(["child", "grandchild", "root"]);
    expect(lyncDownset(result, "grandchild")).toEqual({
      ids: ["child", "grandchild", "root"],
      partial: false,
      obstacles: [],
    });
  });

  it("keeps streaming union result commutative when parents are only buffered", () => {
    const lines = {
      child: `${eventBody({ id: "child", parents: ["missing-root"] })}\n`,
      grandchild: `${eventBody({ id: "grandchild", parents: ["child"] })}\n`,
      independent: `${eventBody({ id: "independent" })}\n`,
      conflictFirst: `${eventBody({ id: "conflicted-parent", payload: { text: "first" } })}\n`,
      conflictSecond: `${eventBody({ id: "conflicted-parent", payload: { text: "second" } })}\n`,
      conflictChild: `${eventBody({ id: "conflict-child", parents: ["conflicted-parent"] })}\n`,
    };
    const orderings = [
      ["child", "grandchild", "independent"],
      ["grandchild", "child", "independent"],
      ["independent", "grandchild", "child"],
      ["independent", "conflictFirst", "conflictSecond", "conflictChild", "grandchild", "child"],
    ] as const;

    const snapshots = orderings.slice(0, 3).map((ordering) => {
      const union = new LyncUnion();
      for (const name of ordering) union.union({ file: `${name}.lync`, bytes: lines[name] });
      const result = union.result();
      return {
        unionEventIds: result.unionEventIds,
        pending: result.pending.map((line) => ({ id: line.id, missingParent: line.missingParent })),
        acceptedLineIds: result.lines
          .filter((line) => line.class === "accepted" || line.class === "nonconforming")
          .map((line) => line.id)
          .sort(),
      };
    });

    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
    expect(snapshots[0]).toEqual({
      unionEventIds: ["independent"],
      pending: [
        { id: "grandchild", missingParent: "child" },
        { id: "child", missingParent: "missing-root" },
      ],
      acceptedLineIds: ["child", "grandchild", "independent"],
    });

    const conflictThenChildUnion = new LyncUnion();
    for (const name of orderings[3]) conflictThenChildUnion.union({ file: `${name}.lync`, bytes: lines[name] });
    const conflictThenChild = conflictThenChildUnion.result();
    expect(conflictThenChild.conflictIds).toEqual(["conflicted-parent"]);
    expect(conflictThenChild.unionEventIds).toEqual(["conflict-child", "independent"]);
    expect(conflictThenChild.pending).toEqual([
      { id: "grandchild", missingParent: "child", digest: expect.any(String), file: "grandchild.lync", line: 1, bytes: expect.any(Uint8Array) },
      { id: "child", missingParent: "missing-root", digest: expect.any(String), file: "child.lync", line: 1, bytes: expect.any(Uint8Array) },
    ]);
    expect(conflictThenChild.graphDiagnostics).toEqual([
      { class: "unavailable-due-to-conflict", id: "conflicted-parent" },
    ]);
  });

  it("keeps children of newly conflicted parents view-eligible in streaming union", () => {
    const lines = {
      a1: `${eventBody({ id: "A", payload: { value: 1 } })}\n`,
      a2: `${eventBody({ id: "A", payload: { value: 2 } })}\n`,
      b: `${eventBody({ id: "B", parents: ["A"] })}\n`,
    };
    const batch = parseLyncFiles([
      { file: "a1.lync", bytes: lines.a1 },
      { file: "b.lync", bytes: lines.b },
      { file: "a2.lync", bytes: lines.a2 },
    ]);

    const snapshots = [
      ["a1", "b", "a2"],
      ["a1", "a2", "b"],
    ].map((ordering) => {
      const union = new LyncUnion();
      for (const name of ordering) union.union({ file: `${name}.lync`, bytes: lines[name as keyof typeof lines] });
      const result = union.result();
      return {
        unionEventIds: result.unionEventIds,
        conflictIds: result.conflictIds,
        conflictVariantCount: result.conflictVariants.length,
        pending: result.pending,
        graphDiagnostics: result.graphDiagnostics,
      };
    });

    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0]).toEqual({
      unionEventIds: ["B"],
      conflictIds: ["A"],
      conflictVariantCount: 2,
      pending: [],
      graphDiagnostics: [{ class: "unavailable-due-to-conflict", id: "A" }],
    });
    expect(snapshots[0]).toEqual({
      unionEventIds: batch.unionEventIds,
      conflictIds: batch.conflictIds,
      conflictVariantCount: batch.conflictVariants.length,
      pending: batch.pending,
      graphDiagnostics: batch.graphDiagnostics,
    });
  });

  it("records every streaming same-id different-body conflict variant after the first conflict", () => {
    const union = new LyncUnion();
    const first = `${eventBody({ id: "same", payload: { text: "first" } })}\n`;
    const second = `${eventBody({ id: "same", payload: { text: "second" } })}\n`;
    const third = `${eventBody({ id: "same", payload: { text: "third" } })}\n`;

    expect(union.union({ file: "a.lync", bytes: first })[0]?.status).toBe("added");
    expect(union.union({ file: "b.lync", bytes: second })[0]?.status).toBe("conflict");
    expect(union.union({ file: "c.lync", bytes: third })[0]?.status).toBe("conflict");

    const result = union.result();
    expect(result.lines.map((line) => line.class)).toEqual([
      "conflict-variant",
      "conflict-variant",
      "conflict-variant",
    ]);
    expect(result.conflictIds).toEqual(["same"]);
    expect(result.unionEventIds).toEqual([]);
    expect(result.viewEligibleIds).toEqual([]);
    expect(result.conflictVariants.map((variant) => variant.digest)).toEqual(
      [first, second, third].map((line) => createHash("sha256").update(line.trimEnd()).digest("hex")).sort(),
    );
  });

  it("classifies duplicate sightings of conflicted ids like batch parse in every streaming order", () => {
    const lines = {
      t1: `${eventBody({ id: "A", payload: { t: 1 } })}\n`,
      t1dup: `${eventBody({ id: "A", payload: { t: 1 } })}\n`,
      t3: `${eventBody({ id: "A", payload: { t: 3 } })}\n`,
    };
    const orders = [
      ["t1", "t1dup", "t3"],
      ["t1", "t3", "t1dup"],
      ["t3", "t1", "t1dup"],
    ] as const;
    const batch = parseLyncFiles([
      { file: "t1.lync", bytes: lines.t1 },
      { file: "t1dup.lync", bytes: lines.t1dup },
      { file: "t3.lync", bytes: lines.t3 },
    ]);
    const batchClasses = batch.lines.map((line) => line.class);

    expect(batchClasses).toEqual(["conflict-variant", "conflict-variant", "conflict-variant"]);

    for (const order of orders) {
      const union = new LyncUnion();
      for (const name of order) union.union({ file: `${name}.lync`, bytes: lines[name] });
      const result = union.result();

      expect(result.lines.map((line) => line.class)).toEqual(batchClasses);
      expect(result.conflictIds).toEqual(batch.conflictIds);
      expect(result.unionEventIds).toEqual(batch.unionEventIds);
      expect(result.viewEligibleIds).toEqual(batch.viewEligibleIds);
      expect(result.conflictVariants.map((variant) => variant.digest)).toEqual(
        batch.conflictVariants.map((variant) => variant.digest),
      );
    }
  });

  it("does not let nonconforming critical events suppress payloads", () => {
    const target = eventBody({ id: "target", author: { actor: "alice" } });
    const critical = eventBody({
      id: "crit-nonconforming",
      author: { actor: "alice" },
      parents: ["target"],
      extra: { critical: true, future: "unknown-top-level" },
    });
    const input = `${target}\n${critical}\n`;
    const result = parseLyncFiles([{ file: "hostile.lync", bytes: input }]);

    expect(result.lines.map((line) => ({ class: line.class, id: line.id }))).toEqual([
      { class: "accepted", id: "target" },
      { class: "nonconforming", id: "crit-nonconforming" },
    ]);
    expect(result.suppression.suppressedPayloadIds).toEqual([]);
    expect(result.suppression.notSuppressedIds).toEqual(["crit-nonconforming", "target"]);
    expect(Buffer.from(exportCarriedLyncBytes(result)).toString("utf8")).toBe(input);
  });

  it("detects digest splice before decoding invalid UTF-8", () => {
    const prefix = Buffer.from(
      '{"v":1,"id":"bad-utf8","kind":"hostile/event","at":"2026-07-07T00:00:00Z","author":{"actor":"alice"},"parents":[],"payload":{"x":"',
    );
    const invalid = Buffer.from([0xff]);
    const suffix = Buffer.from(
      '"},"digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}\n',
    );
    const bytes = Buffer.concat([prefix, invalid, suffix]);
    const result = parseLyncFiles([{ file: "raw.lync", bytes }]);

    expect(result.lines[0]?.class).toBe("damaged");
    expect(result.lines[0]?.reason).toBe("sha256 mismatch");
    expect(result.lines[0]?.digest).toBe("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    expect(result.lines[0]?.bodyBytes && digestFor(result.lines[0].bodyBytes)).not.toBe(result.lines[0]?.digest);
    expect(Buffer.from(exportCarriedLyncBytes(result)).equals(bytes)).toBe(true);
  });

  it("preserves structurally valid signatures without verifying them", () => {
    const body = eventBody({ id: "signed-but-unverified" });
    const sig = "QUJDRA==";
    const input = `${body.slice(0, -1)},"digest":"${digestFor(Buffer.from(body))}","sig":"${sig}"}\n`;
    const result = parseLyncFiles([{ file: "signed.lync", bytes: input }]);

    expect(result.lines[0]?.class).toBe("accepted");
    expect(result.lines[0]?.hasDigest).toBe(true);
    expect(result.lines[0]?.hasSig).toBe(true);
    expect(result.lines[0]?.sig).toBe(sig);
    expect(Buffer.from(exportCarriedLyncBytes(result)).toString("utf8")).toBe(input);
  });

  it("treats invalid signature syntax as body instead of repairing the splice", () => {
    const body = eventBody({ id: "invalid-signature-syntax" });
    const digest = digestFor(Buffer.from(body));
    const base = body.slice(0, -1);
    const result = parseLyncFiles([
      { file: "url.lync", bytes: `${base},"digest":"${digest}","sig":"abc-_"}\n` },
      { file: "mod.lync", bytes: `${base},"digest":"${digest}","sig":"abc"}\n` },
    ]);

    expect(result.lines.map((line) => ({ class: line.class, hasDigest: line.hasDigest, hasSig: line.hasSig }))).toEqual([
      { class: "garbage", hasDigest: undefined, hasSig: undefined },
      { class: "garbage", hasDigest: undefined, hasSig: undefined },
    ]);
    expect(result.lines.map((line) => line.reason)).toEqual([
      "reserved top-level digest/sig body member",
      "reserved top-level digest/sig body member",
    ]);
  });
});

describe("parent-cycle detection (dee-07pu gauntlet: linear-time, order-independent)", () => {
  it("reports each distinct cycle once, canonical rotation, regardless of file order", () => {
    const lines = [
      `${eventBody({ id: "b", parents: ["a"] })}\n`,
      `${eventBody({ id: "a", parents: ["b"] })}\n`,
      `${eventBody({ id: "c", parents: ["a"] })}\n`,
    ];
    const orderings = [lines, [lines[2], lines[0], lines[1]], [lines[1], lines[2], lines[0]]];
    for (const ordering of orderings) {
      const result = parseLyncFiles([
        { file: "cycle.lync", bytes: new TextEncoder().encode(ordering.join("")) },
      ]);
      expect(result.graphDiagnostics.filter((o) => o.class === "cycle")).toEqual([
        { class: "cycle", ids: ["a", "b"] },
      ]);
    }
  });

  it(
    "parses a 20k-deep parent chain in linear time (codex session shape)",
    () => {
      // Before the shared-DFS rewrite this shape was ~10x slower per doubling
      // (measured 152s at n=4000); a quadratic regression would blow far past
      // this bound, a linear pass stays well under it.
      const n = 20_000;
      const chain: string[] = [];
      for (let i = 0; i < n; i += 1) {
        chain.push(
          `${eventBody({ id: `e-${String(i).padStart(7, "0")}`, parents: i === 0 ? [] : [`e-${String(i - 1).padStart(7, "0")}`] })}\n`,
        );
      }
      const started = performance.now();
      const result = parseLyncFiles([
        { file: "chain.lync", bytes: new TextEncoder().encode(chain.join("")) },
      ]);
      const elapsed = performance.now() - started;
      expect(result.lines.filter((line) => line.class === "accepted")).toHaveLength(n);
      expect(result.graphDiagnostics).toEqual([]);
      expect(elapsed).toBeLessThan(10_000);
    },
    30_000,
  );
});
