import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportCarriedLoreBytes,
  loreDownset,
  parseLoreFiles,
  type LoreLineDiagnostic,
} from "../src/lore/events.js";

const vectorsRoot =
  "/Users/deepfates/Hacking/github/deepfates/portfolio-audit-20260701/lore-vectors-draft";

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
  const result = parseLoreFiles(
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

function simplifyLine(line: LoreLineDiagnostic): ExpectedLine {
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

function lineForExpected(line: LoreLineDiagnostic, expected: ExpectedLine): ExpectedLine {
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

describe("LORE-V0 line parser vectors", () => {
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
        const actual = loreDownset(result, id);
        expect(actual.ids).toEqual(view.ids);
        expect(actual.partial).toBe(view.partial);
        expect(actual.obstacles).toEqual(view.obstacles);
      }
    });
  }

  it("round-trips garbage and damaged lines through carried export", () => {
    const { dir, expected, result } = loadFixture("03-damaged-digest");
    const exported = exportCarriedLoreBytes(result);
    const original = Buffer.concat(expected.inputs.map((file) => readFileSync(join(dir, file))));
    expect(Buffer.from(exported).equals(original)).toBe(true);

    const garbage = loadFixture("04-garbage-classes");
    const garbageExported = exportCarriedLoreBytes(garbage.result);
    const garbageOriginal = Buffer.concat(
      garbage.expected.inputs.map((file) => readFileSync(join(garbage.dir, file))),
    );
    expect(Buffer.from(garbageExported).equals(garbageOriginal)).toBe(true);
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
      "a.lore",
      "a.lore",
      "a.lore",
      "b.lore",
      "b.lore",
      "b.lore",
    ]);
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
    const result = parseLoreFiles([{ file: "hostile.lore", bytes: input }]);

    expect(result.lines.map((line) => ({ class: line.class, id: line.id }))).toEqual([
      { class: "accepted", id: "target" },
      { class: "nonconforming", id: "crit-nonconforming" },
    ]);
    expect(result.suppression.suppressedPayloadIds).toEqual([]);
    expect(result.suppression.notSuppressedIds).toEqual(["crit-nonconforming", "target"]);
    expect(Buffer.from(exportCarriedLoreBytes(result)).toString("utf8")).toBe(input);
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
    const result = parseLoreFiles([{ file: "raw.lore", bytes }]);

    expect(result.lines[0]?.class).toBe("damaged");
    expect(result.lines[0]?.reason).toBe("sha256 mismatch");
    expect(result.lines[0]?.digest).toBe("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    expect(result.lines[0]?.bodyBytes && digestFor(result.lines[0].bodyBytes)).not.toBe(result.lines[0]?.digest);
    expect(Buffer.from(exportCarriedLoreBytes(result)).equals(bytes)).toBe(true);
  });

  it("preserves structurally valid signatures without verifying them", () => {
    const body = eventBody({ id: "signed-but-unverified" });
    const sig = "QUJDRA==";
    const input = `${body.slice(0, -1)},"digest":"${digestFor(Buffer.from(body))}","sig":"${sig}"}\n`;
    const result = parseLoreFiles([{ file: "signed.lore", bytes: input }]);

    expect(result.lines[0]?.class).toBe("accepted");
    expect(result.lines[0]?.hasDigest).toBe(true);
    expect(result.lines[0]?.hasSig).toBe(true);
    expect(result.lines[0]?.sig).toBe(sig);
    expect(Buffer.from(exportCarriedLoreBytes(result)).toString("utf8")).toBe(input);
  });

  it("treats invalid signature syntax as body instead of repairing the splice", () => {
    const body = eventBody({ id: "invalid-signature-syntax" });
    const digest = digestFor(Buffer.from(body));
    const base = body.slice(0, -1);
    const result = parseLoreFiles([
      { file: "url.lore", bytes: `${base},"digest":"${digest}","sig":"abc-_"}\n` },
      { file: "mod.lore", bytes: `${base},"digest":"${digest}","sig":"abc"}\n` },
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
