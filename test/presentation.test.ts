import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { LyncEventBody } from "../src/events.js";
import { parseLyncFiles } from "../src/events.js";
import {
  BEHOLD_INHABITANT_PROFILE,
  BEHOLD_INHABITANT_PROFILE_V2,
  htmlToPlainText,
  presentLyncEvent,
  resolveLyncPresentationProfiles,
} from "../src/presentation.js";

function event(
  kind: string,
  payload: Record<string, unknown>,
  overrides: Partial<LyncEventBody> = {},
): LyncEventBody {
  return {
    v: 1,
    id: "event-1",
    kind,
    at: "2026-07-25T00:00:00.000Z",
    author: { actor: "source", via: "fixture@1" },
    parents: [],
    payload,
    ...overrides,
  };
}

function presented(body: LyncEventBody, profile?: string) {
  const result = presentLyncEvent(body, { loomProfile: profile });
  expect(result.status).toBe("presented");
  if (result.status !== "presented") throw new Error("expected presentation");
  return result.presentation;
}

describe("Lync presentation contract", () => {
  it("projects only the declared generic message paths and retains source identity", () => {
    const body = event("claude/assistant", {
      message: {
        content: [
          { type: "text", text: "one " },
          { type: "tool_use", name: "secret-tool" },
          { type: "text", text: "two" },
        ],
      },
      reasoning: "must not appear",
    }, { id: "source-id", parents: ["parent-a", "parent-b"] });

    const projection = presented(body);

    expect(projection.text).toBe("one two");
    expect(projection.contract).toBe("lync/generic-message-blocks-v1");
    expect(projection.sections[0].sourcePaths).toEqual([
      "payload.message.content[0].text",
      "payload.message.content[2].text",
    ]);
    expect(projection.source).toEqual({
      id: "source-id",
      parents: ["parent-a", "parent-b"],
      author: { actor: "source", via: "fixture@1" },
      kind: "claude/assistant",
    });
    expect(projection.text).not.toContain("reasoning");
    expect(projection.text).not.toContain("secret-tool");
  });

  it.each([
    ["twitter/tweet", { full_text: "tweet text" }, "tweet text", "content"],
    ["twitter/like", { fullText: "liked text" }, "liked text", "content"],
    ["bluesky/post", { record: { text: "skeet text" } }, "skeet text", "content"],
    ["glowfic/post", { content: "<p>Hello &amp; <b>world</b></p><script>leak()</script>" }, "Hello & world", "content"],
    ["twitter/tweet-embed", { embed: { html: "<blockquote>embedded prose</blockquote>" } }, "embedded prose", "content"],
    ["ocr/page", { text: "page text" }, "page text", "content"],
    ["ocr/document", { text: "document text" }, "document text", "content"],
    ["glowfic/thread", { id: "5506", title: "A thread", authors: ["A", "B"] }, "Glowfic thread: A thread", "structure"],
    ["ocr/set", { locator: "portable-set", pages: 2, documents: ["all.md"] }, "OCR set: portable-set", "structure"],
  ] as const)("presents exact source kind %s", (kind, payload, text, presentationKind) => {
    const projection = presented(event(kind, payload));
    expect(projection.text).toContain(text);
    expect(projection.kind).toBe(presentationKind);
    expect(projection.sections.flatMap((section) => section.sourcePaths).length).toBeGreaterThan(0);
  });

  it("claims a known kind before generic fallback and exposes malformed input", () => {
    const result = presentLyncEvent(event("glowfic/post", { text: "shape bait" }));

    expect(result).toEqual({
      status: "unsupported",
      contract: "splice/glowfic-json",
      diagnostics: [{ code: "malformed_known_kind", sourcePath: "payload" }],
    });
  });

  it("does not recursively guess prose from unknown payloads", () => {
    const result = presentLyncEvent(event("unknown/envelope", {
      payload: { message: "nested bait" },
    }));

    expect(result).toEqual({ status: "unclaimed" });
  });

  it("presents named pointers structurally without changing their target", () => {
    const projection = presented(event("lync/pointer", {
      name: "current",
      target: "opaque-target-id",
    }));

    expect(projection.kind).toBe("structure");
    expect(projection.text).toContain("opaque-target-id");
    expect(projection.sections[0].sourcePaths).toEqual([
      "payload.name",
      "payload.target",
    ]);
  });

  it("inherits one exact loom profile through every causal parent without choosing conflicts", () => {
    const a = event("lync/loom", { meta: { profile: "profile/a" } }, { id: "a" });
    const b = event("lync/turn", { payload: {} }, { id: "b", parents: ["a"] });
    const c = event("lync/loom", { meta: { profile: "profile/c" } }, { id: "c" });
    const fanIn = event("lync/turn", { payload: {} }, { id: "fan-in", parents: ["b", "c"] });

    const profiles = resolveLyncPresentationProfiles([fanIn, b, c, a]);

    expect(profiles.get("a")).toBe("profile/a");
    expect(profiles.get("b")).toBe("profile/a");
    expect(profiles.get("c")).toBe("profile/c");
    expect(profiles.has("fan-in")).toBe(false);
    expect(fanIn.parents).toEqual(["b", "c"]);
  });

  it("presents the canonical Oxford resident fixture without exposing private source-only fields", async () => {
    const fixture = await readFile(
      fileURLToPath(new URL("./fixtures/presentation/oxford-aster-human-semantic-v1.lync", import.meta.url)),
    );
    const parsed = parseLyncFiles([{ file: "oxford.lync", bytes: fixture }]);
    const events = parsed.lines.flatMap((line) => line.event ? [line.event] : []);
    const profiles = resolveLyncPresentationProfiles(events);
    const projections = events.map((body) => presented(body, profiles.get(body.id)));

    expect(profiles.get(events[0].id)).toBe(BEHOLD_INHABITANT_PROFILE);
    expect(projections[0].text).toContain("Behold resident life: OxfordAster");
    expect(projections[1].text).toContain("Saw Birch");
    expect(projections[1].text).toContain("[script · exclusive]");
    expect(projections[1].text).toContain("looked left");
    expect(projections[1].text).toContain("Birch left the current view");
    expect(projections[1].text).not.toContain("materialRows");
    expect(projections[1].text).not.toContain("raw response");
    expect(projections[1].source.id).toBe(events[1].id);
    expect(projections[1].source.parents).toEqual(events[1].parents);
  });

  it("keeps the complete v1 Oxford projection byte-for-byte stable", async () => {
    const fixture = await readFile(
      fileURLToPath(new URL("./fixtures/presentation/oxford-aster-human-semantic-v1.lync", import.meta.url)),
    );
    const parsed = parseLyncFiles([{ file: "oxford-v1.lync", bytes: fixture }]);
    const events = parsed.lines.flatMap((line) => line.event ? [line.event] : []);
    const profiles = resolveLyncPresentationProfiles(events);
    const decisions = events.map((body) =>
      presentLyncEvent(body, { loomProfile: profiles.get(body.id) })
    );

    expect(
      createHash("sha256").update(JSON.stringify(decisions)).digest("hex"),
    ).toBe("46febbe7a89951e5ea57593366cb39134d64430bb09aaa8a1ff510a8e052f6c0");
  });

  it("presents Behold v2 sound, time, and whisper fields while diagnosing source-only data", async () => {
    const fixture = await readFile(
      fileURLToPath(new URL("./fixtures/presentation/oxford-cedar-human-semantic-v2.lync", import.meta.url)),
    );
    const parsed = parseLyncFiles([{ file: "oxford-v2.lync", bytes: fixture }]);
    const events = parsed.lines.flatMap((line) => line.event ? [line.event] : []);
    const profiles = resolveLyncPresentationProfiles(events);
    const projections = events.map((body) => presented(body, profiles.get(body.id)));
    const turn = projections[1];

    expect(profiles.get(events[0].id)).toBe(BEHOLD_INHABITANT_PROFILE_V2);
    expect(projections[0].contract).toBe("org.behold.presentation.inhabitant-turn.v2");
    expect(turn.contract).toBe("org.behold.presentation.inhabitant-turn.v2");
    expect(turn.text).toContain("Heard block.stone_pressure_plate.click_on (nearby, right).");
    expect(turn.text).toContain("OxfordCedar whispered to Birch: Hello quietly.");
    expect(turn.text).toContain("Minecraft confirmed the private whisper: Hello quietly.");
    expect(turn.text).toContain("Heard 2 sounds: 2 × block.stone_pressure_plate.click_on (nearby, right).");
    expect(turn.text).toContain("Time passed: 32016 ms.");
    expect(turn.text).not.toContain("must-not-appear");
    expect(turn.diagnostics).toEqual(expect.arrayContaining([
      {
        code: "source_only_observation_event_field",
        sourcePath: "payload.payload.observation.events[0].data.packetPosition",
      },
      {
        code: "source_only_action_input_field",
        sourcePath: "payload.payload.action.input.debug",
      },
      {
        code: "source_only_outcome_field",
        sourcePath: "payload.payload.outcome.result.serverCommand",
      },
      {
        code: "source_only_observation_event_field",
        sourcePath: "payload.payload.nextObservation.events[0].data.occurrences[0].data.hiddenCoordinate",
      },
      {
        code: "source_only_observation_event_field",
        sourcePath: "payload.payload.nextObservation.events[1].data.ticks",
      },
    ]));
    expect(turn.diagnostics.some((item) => item.code === "unsupported_observation_event")).toBe(false);
    expect(turn.diagnostics.some((item) => item.code === "unsupported_action_input")).toBe(false);
    expect(turn.diagnostics.some((item) => item.code === "unsupported_outcome_result")).toBe(false);
  });

  it("makes an exact claimed profile fail closed instead of using generic bait", () => {
    const result = presentLyncEvent(
      event("lync/turn", { message: "generic bait" }),
      { loomProfile: BEHOLD_INHABITANT_PROFILE },
    );

    expect(result.status).toBe("unsupported");
    expect(result).toMatchObject({
      contract: "org.behold.presentation.inhabitant-turn.v1",
    });
  });

  it("does not mutate the event while presenting", () => {
    const body = event("twitter/tweet", {
      full_text: "immutable",
      private_metadata: { path: "/private/workstation/path" },
    });
    const before = JSON.stringify(body);

    const projection = presented(body);

    expect(JSON.stringify(body)).toBe(before);
    expect(projection.text).toBe("immutable");
    expect(projection.text).not.toContain("/private/workstation/path");
  });

  it("normalizes inert HTML without executing or retaining script/style text", () => {
    expect(htmlToPlainText("<style>.x{}</style><p>A&nbsp;B</p><script>steal()</script>"))
      .toBe("A B");
  });
});
