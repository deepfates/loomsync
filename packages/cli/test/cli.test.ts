import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runLyncCli } from "../src/index.js";

const vectorsRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "core",
  "test",
  "vectors",
  "lore-vectors-draft",
);

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
    kind: fields.kind ?? "notes/text",
    at: fields.at ?? "2026-07-08T00:00:00Z",
    author: fields.author ?? { actor: "alice" },
    parents: fields.parents ?? [],
    payload: fields.payload ?? {},
  });
}

function sink() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    text: () => text,
  };
}

function stdin(text: string) {
  return Readable.from([text]) as NodeJS.ReadStream;
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "lync-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("lync CLI", () => {
  it("initializes an empty valid file", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "empty.lync");
      const out = sink();
      const err = sink();

      expect(await runLyncCli(["init", file], { stdout: out.stream, stderr: err.stream })).toBe(0);
      expect(await readFile(file, "utf8")).toBe("");
      expect(await runLyncCli(["verify", file], { stdout: out.stream, stderr: err.stream })).toBe(0);
      expect(out.text()).toContain("total accepted=0 nonconforming=0 garbage=0 damaged=0 conflict-variant=0");
    });
  });

  it("verifies line classes and returns nonzero for invalid input", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "bad.lync");
      await writeFile(file, `${event({ id: "ok" })}\nnot json\n`);
      const out = sink();
      const err = sink();

      expect(await runLyncCli(["verify", file], { stdout: out.stream, stderr: err.stream })).toBe(1);
      expect(out.text()).toContain("accepted=1 nonconforming=0 garbage=1 damaged=0 conflict-variant=0");
      expect(out.text()).toContain("garbage:");
      expect(err.text()).toBe("");
    });
  });

  it("reports expected class counts for vendored vectors", async () => {
    const fixtureNames = (await readdir(vectorsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const fixture of fixtureNames) {
      const dir = join(vectorsRoot, fixture);
      const expected = JSON.parse(await readFile(join(dir, "expected.json"), "utf8")) as {
        inputs: string[];
        line_classifications: { class: string }[];
      };
      const out = sink();
      const code = await runLyncCli(
        ["verify", ...expected.inputs.map((input) => join(dir, input))],
        { stdout: out.stream, stderr: sink().stream },
      );
      const counts = Object.fromEntries(
        [...out.text().matchAll(/total ([^\n]+)/g)][0]![1]!
          .split(" ")
          .map((part) => {
            const [key, value] = part.split("=");
            return [key, Number(value)];
          }),
      );
      const expectedCounts = expected.line_classifications.reduce<Record<string, number>>((acc, line) => {
        acc[line.class] = (acc[line.class] ?? 0) + 1;
        return acc;
      }, {});

      expect(counts, fixture).toMatchObject(expectedCounts);
      expect(code, fixture).toBe(expected.line_classifications.every((line) => line.class === "accepted") ? 0 : 1);
    }
  });

  it("merges one representative per event and carries problem lines", async () => {
    await withDir(async (dir) => {
      const a = join(dir, "a.lync");
      const b = join(dir, "b.lync");
      const outFile = join(dir, "merged.lync");
      const root = event({ id: "root" });
      const child = event({ id: "child", parents: ["root"] });
      await writeFile(a, `${child}\nnot json\n`);
      await writeFile(b, `${root}\n${child}\n`);

      expect(await runLyncCli(["merge", a, b, "-o", outFile], { stdout: sink().stream, stderr: sink().stream })).toBe(0);
      const merged = await readFile(outFile, "utf8");
      expect(merged.match(/"id":"child"/g)).toHaveLength(1);
      expect(merged).toContain(root);
      expect(merged).toContain("not json");
      expect(await runLyncCli(["verify", outFile], { stdout: sink().stream, stderr: sink().stream })).toBe(1);
    });
  });

  it("prints transcript and tree views from core view functions", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "story.lync");
      await writeFile(file, `${event({ id: "root", payload: { text: "start" } })}\n${event({ id: "child", parents: ["root"], payload: { text: "next" } })}\n`);
      const transcriptOut = sink();
      const treeOut = sink();

      expect(await runLyncCli(["view", file], { stdout: transcriptOut.stream, stderr: sink().stream })).toBe(0);
      expect(JSON.parse(transcriptOut.text()).entries.map((entry: { id: string }) => entry.id)).toEqual(["root", "child"]);
      expect(await runLyncCli(["view", file, "--as", "tree"], { stdout: treeOut.stream, stderr: sink().stream })).toBe(0);
      expect(JSON.parse(treeOut.text()).leaves).toEqual(["child"]);
    });
  });

  it("appends stdin JSON after minting id and at", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "append.lync");
      const out = sink();
      const err = sink();

      expect(await runLyncCli(
        ["append", file],
        {
          stdin: stdin(JSON.stringify({ kind: "notes/text", author: { actor: "writer" }, payload: { text: "hello" } })),
          stdout: out.stream,
          stderr: err.stream,
          now: () => new Date("2026-07-08T12:00:00Z"),
          randomId: () => "minted",
        },
      )).toBe(0);

      expect(out.text()).toBe("minted\n");
      expect(err.text()).toBe("");
      expect(await readFile(file, "utf8")).toBe(`${event({ id: "minted", at: "2026-07-08T12:00:00.000Z", author: { actor: "writer" }, payload: { text: "hello" } })}\n`);
    });
  });

  it("teaches append users about namespaced kind and author.actor", async () => {
    const err = sink();
    expect(await runLyncCli(
      ["append", "unused.lync"],
      { stdin: stdin(JSON.stringify({ kind: "broken", author: {} })), stdout: sink().stream, stderr: err.stream },
    )).toBe(1);
    expect(err.text()).toContain("kind must include a namespace and name");
  });
});
