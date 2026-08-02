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

async function canonicalV2Turn(): Promise<LyncEventBody> {
  const fixture = await readFile(
    fileURLToPath(new URL("./fixtures/presentation/oxford-cedar-human-semantic-v2.lync", import.meta.url)),
  );
  const parsed = parseLyncFiles([{ file: "oxford-v2.lync", bytes: fixture }]);
  const turn = parsed.lines.flatMap((line) => line.event ? [line.event] : [])[1];
  if (!turn) throw new Error("expected canonical v2 fixture turn");
  return structuredClone(turn);
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
    expect(turn.text).toContain(
      "The private whisper input was submitted; recipient delivery was not independently confirmed here.",
    );
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

  it("distinguishes received private whispers from public chat in Behold v2", async () => {
    const body = await canonicalV2Turn();
    const payload = (body.payload as any).payload;
    payload.observation.events = [
      {
        sequence: 91,
        type: "chat_received",
        salience: "high",
        source: "event",
        isNew: true,
        data: {
          from: "OxfordSedge",
          text: "Meet me by the arch.",
          channel: "private",
          addressed: true,
        },
      },
    ];

    const turn = presented(body, BEHOLD_INHABITANT_PROFILE_V2);

    expect(turn.text).toContain("Private whisper from OxfordSedge: Meet me by the arch.");
    expect(turn.text).not.toContain("Public chat from OxfordSedge");
  });

  it("presents Behold null cognition without inventing an action consequence", async () => {
    const body = await canonicalV2Turn();
    const turn = (body.payload as any).payload;
    turn.protocol = "behold.entity-cognition-turn.v1";
    turn.id = "OxfordCedar:cognition:7";
    turn.utterance = {
      assistant: { role: "assistant", content: '{"action":null,"arguments":{}}' },
    };
    delete turn.action;
    delete turn.outcome;
    delete turn.nextObservation;

    const projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("OxfordCedar · cognition 7");
    expect(projection.text).toContain("OxfordCedar chose no bodily action.");
    expect(projection.text).not.toContain("Minecraft returned");
    expect(projection.text).not.toContain("unknown outcome");
    expect(projection.sections.map((section) => section.role)).toEqual([
      "perception",
      "action",
    ]);

    turn.outcome = { ok: true, eventType: "invented", result: {} };
    expect(
      presentLyncEvent(body, { loomProfile: BEHOLD_INHABITANT_PROFILE_V2 }).status,
    ).toBe("unsupported");
  });

  it("presents a focused attack failure and its observed action_failed event", async () => {
    const body = await canonicalV2Turn();
    const turn = (body.payload as any).payload;
    turn.action = {
      id: "llm-attack",
      name: "attack_focused_entity",
      input: {},
      kind: "exclusive",
      toolCallId: "mind-attack",
      source: "llm",
    };
    turn.outcome = {
      ok: false,
      eventType: "action_failed",
      result: { ok: false, error: "admitted_reachable_entity_focus_unavailable" },
      error: "admitted_reachable_entity_focus_unavailable",
    };
    turn.nextObservation.events = [{
      sequence: 27,
      type: "action_failed",
      salience: "high",
      source: "event",
      isNew: true,
      data: {
        intent: {
          source: "llm",
          tool: "attack_focused_entity",
          input: {},
          observationSequence: 20,
          enqueuedAt: 1785564840633,
        },
        authorization: { ok: true },
        result: { ok: false, error: "admitted_reachable_entity_focus_unavailable" },
        error: "admitted_reachable_entity_focus_unavailable",
      },
    }];

    const projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("attempted one attack at the focused entity");
    expect(projection.text).toContain("Body report: admitted reachable entity focus unavailable.");
    expect(projection.text).toContain("Action failed: attack focused entity (admitted reachable entity focus unavailable).");
    expect(projection.diagnostics.some((item) => item.code === "unsupported_action_input")).toBe(false);
    expect(projection.diagnostics.some((item) => item.code === "unsupported_outcome_result")).toBe(false);
    expect(projection.diagnostics.some((item) => item.code === "unsupported_observation_event")).toBe(false);

    turn.outcome = {
      ok: true,
      eventType: "action_completed",
      result: {
        ok: true,
        status: "attack_input_dispatched",
        target: { id: "private-target", position: { x: 1977, y: -47, z: 1419 } },
        confirmation: "mineflayer:single_attack_input",
      },
    };
    turn.nextObservation.events = [];
    const success = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(success.text).toContain(
      "Body confirmation: attack input dispatched (mineflayer:single_attack_input).",
    );
    expect(success.text).not.toContain("private-target");
    expect(success.text).not.toContain("1977");
    expect(success.diagnostics).toContainEqual({
      code: "source_only_outcome_field",
      sourcePath: "payload.payload.outcome.result.target",
    });
  });

  it("presents verified focused digging and visible material consequences without coordinates", async () => {
    const body = await canonicalV2Turn();
    const turn = (body.payload as any).payload;
    turn.action = {
      id: "llm-dig",
      name: "dig_focused_block",
      input: {},
      kind: "exclusive",
      toolCallId: "mind-dig",
      source: "llm",
    };
    turn.outcome = {
      ok: true,
      eventType: "action_completed",
      result: {
        ok: true,
        changes: [{
          verb: "dig",
          position: { x: 1977, y: -47, z: 1419 },
          before: "mud_bricks",
          after: "air",
          verified: true,
          observed: true,
          confirmation: {
            source: "mineflayer:blockUpdate",
            observedAt: 1785564959120,
            dimension: "overworld",
            position: { x: 1977, y: -47, z: 1419 },
            before: { name: "mud_bricks", stateId: 6775 },
            after: { name: "air", stateId: 0 },
            beforeStateId: 6775,
            afterStateId: 0,
          },
        }],
        navigation: null,
        adjacentBlocks: [{ name: "mud_bricks", position: { x: 1977, y: -46, z: 1419 } }],
        openedBodyPassages: [],
      },
    };
    turn.nextObservation.events = [{
      sequence: 5,
      type: "visible_block_changed",
      salience: "normal",
      source: "vision",
      isNew: true,
      data: { before: "mud_bricks", after: "air" },
    }];

    const projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("attempted to dig the focused block");
    expect(projection.text).toContain(
      "Change evidence: dig mud bricks → air; verified yes; observed yes; confirmation mineflayer:blockUpdate.",
    );
    expect(projection.text).toContain("Visible block changed: mud bricks → air.");
    expect(projection.text).not.toContain("1977");
    expect(projection.text).not.toContain("6775");
    expect(projection.diagnostics).toContainEqual({
      code: "source_only_outcome_field",
      sourcePath: "payload.payload.outcome.result.changes[0].position",
    });
    expect(projection.diagnostics.some((item) => item.code === "unsupported_outcome_result")).toBe(false);
    expect(projection.diagnostics.some((item) => item.code === "unsupported_observation_event")).toBe(false);
  });

  it("presents held-item placement against focus without claiming success", async () => {
    const body = await canonicalV2Turn();
    const turn = (body.payload as any).payload;
    turn.action = {
      id: "place-held-1",
      name: "place_held_against_focus",
      input: {},
      kind: "exclusive",
      toolCallId: "place-held-tool",
      source: "llm",
    };

    const projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain(
      "attempted to place the held item against the focused block",
    );
    expect(projection.text).not.toContain("successfully placed");
    expect(projection.diagnostics.some((item) => item.code === "unsupported_action_input")).toBe(false);
  });

  it("presents an interrupted dig attempt and public lifecycle events without controller internals", async () => {
    const body = await canonicalV2Turn();
    const turn = (body.payload as any).payload;
    turn.action = {
      id: "llm-dig-interrupted",
      name: "dig_focused_block",
      input: {},
      kind: "exclusive",
      toolCallId: "mind-dig-interrupted",
      source: "llm",
    };
    turn.outcome = {
      ok: false,
      eventType: "action_failed",
      result: {
        ok: false,
        error: "interrupted_by_human",
        cancellation: { acknowledged: true, adapter: "mineflayer-digging" },
        commandError: "Digging aborted",
        attemptedChanges: [{
          verb: "dig",
          position: { x: 1977, y: -47, z: 1419 },
          before: "mud_bricks",
          after: "mud_bricks",
          verified: false,
          observed: false,
          confirmation: null,
        }],
        sideEffectObserved: false,
        navigation: null,
      },
      error: "interrupted_by_human",
      cancellation: {
        requested: true,
        reason: "controller_stdin_closed",
        acknowledged: true,
        adapter: "mineflayer-digging",
      },
    };
    const intent = {
      source: "llm",
      tool: "dig_focused_block",
      input: {},
      observationSequence: 37,
      enqueuedAt: 1785564863939,
    };
    turn.nextObservation.events = [
      {
        sequence: 44,
        type: "controller_suspended",
        salience: "normal",
        source: "event",
        isNew: true,
        data: { reason: "controller_stdin_closed", activeIntent: intent },
      },
      {
        sequence: 45,
        type: "cancellation_requested",
        salience: "normal",
        source: "event",
        isNew: true,
        data: {
          intent,
          requestedBy: { source: "system", tool: "shutdown" },
          reason: "controller_stdin_closed",
        },
      },
    ];

    const projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("Body report: interrupted by human.");
    expect(projection.text).toContain(
      "Attempted change: dig mud bricks → mud bricks; verified no; observed no; confirmation none.",
    );
    expect(projection.text).toContain("Controller suspended (controller stdin closed) during dig focused block.");
    expect(projection.text).toContain(
      "Cancellation requested for dig focused block by system shutdown (controller stdin closed).",
    );
    expect(projection.text).not.toContain("Digging aborted");
    expect(projection.text).not.toContain("1785564863939");
    expect(projection.text).not.toContain("1977");
    expect(projection.diagnostics.some((item) => item.code === "unsupported_action_input")).toBe(false);
    expect(projection.diagnostics.some((item) => item.code === "unsupported_outcome_result")).toBe(false);
    expect(projection.diagnostics.some((item) => item.code === "unsupported_observation_event")).toBe(false);
  });

  it("presents bounded experience pressure and witnessed death without hidden references", async () => {
    const body = await canonicalV2Turn();
    const turn = (body.payload as any).payload;
    turn.observation.events = [{
      sequence: 51,
      type: "experience_pressure_sequence",
      salience: "urgent",
      source: "event",
      isNew: true,
      data: {
        compaction: "behold.experience-pressure-sequence.v1",
        fromSequence: 17,
        throughSequence: 51,
        eventCount: 6,
        eventTypeCounts: {
          sound_heard: 2,
          self_hurt: 1,
          condition_changed: 2,
          entity_left_view: 1,
        },
        sounds: {
          entries: [{
            sound: "entity.skeleton.shoot",
            distanceBand: "distant",
            relativeDirection: "behind",
            count: 2,
          }],
          distinctPatterns: 1,
          omittedDistinctPatterns: 0,
        },
        condition: {
          changes: 2,
          latest: { health: 17, food: 20, oxygen: null },
          minimumHealth: 15,
        },
        entities: {
          entries: [{
            id: "hidden-entity-id",
            name: "Arrow",
            kind: "projectile",
            becameVisible: 0,
            leftView: 1,
            hurt: 0,
            latestRelation: {
              proximity: "nearby",
              relativeDirection: "behind",
              lastSeenDistance: 11.5,
              observationPhase: "live_world",
              transition: "entity_left_view",
            },
          }],
          distinctEntities: 1,
          omittedDistinctEntities: 0,
        },
      },
    }];
    turn.nextObservation.events = [{
      sequence: 52,
      type: "visible_entity_died",
      salience: "high",
      source: "vision",
      isNew: true,
      data: { name: "Zombie", kind: "zombie", proximity: "nearby" },
    }];

    const projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("6 lived events across body sequences 17–51");
    expect(projection.text).toContain("2 × entity.skeleton.shoot (distant, behind)");
    expect(projection.text).toContain("minimum health 15");
    expect(projection.text).toContain("Zombie was seen die (zombie, nearby)");
    expect(projection.text).not.toContain("hidden-entity-id");
    expect(projection.text).not.toContain("11.5");
    expect(projection.diagnostics).toEqual(expect.arrayContaining([
      {
        code: "source_only_observation_event_field",
        sourcePath: "payload.payload.observation.events[0].data.entities.entries[0].id",
      },
      {
        code: "source_only_observation_event_field",
        sourcePath: "payload.payload.observation.events[0].data.entities.entries[0].latestRelation.lastSeenDistance",
      },
    ]));
    expect(projection.diagnostics.some((item) => item.code === "unsupported_observation_event")).toBe(false);
  });

  it("presents resident recall and body-life invalidation without locator or timing internals", async () => {
    const body = await canonicalV2Turn();
    const turn = (body.payload as any).payload;
    turn.action = {
      id: "recall-1",
      name: "read_private_life",
      input: { startSequence: 185, endSequence: 187 },
      kind: "exclusive",
      toolCallId: "recall-tool",
      source: "llm",
    };
    turn.outcome = {
      ok: true,
      eventType: "private_life_page_returned",
      result: {
        protocol: "behold.resident-private-life-page.v1",
        returned: { startSequence: 185, endSequence: 187 },
        messageCount: 9,
        complete: true,
        nextSequence: null,
        messagesSha256: "private-digest",
        selectedTip: { turnId: "private-tip" },
      },
    };

    let projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("consulted their own canonical life, requesting turns 185–187");
    expect(projection.text).toContain("private life returned turns 185–187 (9 messages; complete)");
    expect(projection.text).not.toContain("private-digest");
    expect(projection.text).not.toContain("private-tip");
    expect(projection.diagnostics.some((item) => item.code === "unsupported_action_input")).toBe(false);
    expect(projection.diagnostics.some((item) => item.code === "unsupported_outcome_result")).toBe(false);

    turn.action = {
      id: "move-1",
      name: "move_controls",
      input: { direction: "forward", durationMs: 1000 },
      kind: "exclusive",
      toolCallId: "move-tool",
      source: "llm",
    };
    turn.outcome = {
      ok: false,
      eventType: "intent_blocked",
      result: {
        ok: false,
        error: "decision_invalidated_by_world",
        reason: "body_life_boundary_changed",
        afterSequence: 48,
        observedThroughSequence: 55,
        missingBeforeOldest: 0,
        invalidatingEvents: [
          { sequence: 52, at: 1785655811052, type: "died" },
          { sequence: 54, at: 1785655811086, type: "spawned" },
        ],
      },
    };
    projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("death and respawn crossed a life boundary");
    expect(projection.text).not.toContain("1785655811052");
    expect(projection.diagnostics).toContainEqual({
      code: "source_only_outcome_field",
      sourcePath: "payload.payload.outcome.result.invalidatingEvents[0].at",
    });
    expect(projection.diagnostics.some((item) => item.code === "unsupported_outcome_result")).toBe(false);

    turn.outcome.result = {
      ok: false,
      error: "decision_invalidated_by_world",
      reason: "observation_gap_after_decision",
      afterSequence: 371,
      observedThroughSequence: 433,
      missingBeforeOldest: 22,
      invalidatingEvents: [],
    };
    projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("22 earlier body events became unavailable after the decision");
    expect(projection.diagnostics.some((item) => item.code === "unsupported_outcome_result")).toBe(false);
  });

  it("presents coordinate-free body transitions and fails closed on inconsistent receipts", async () => {
    const body = await canonicalV2Turn();
    const turn = (body.payload as any).payload;
    turn.action = {
      id: "move-transition",
      name: "move_controls",
      input: { direction: "forward", durationMs: 1000 },
      kind: "exclusive",
      toolCallId: "move-transition-tool",
      source: "llm",
    };
    turn.outcome = {
      ok: true,
      eventType: "action_completed",
      result: {
        ok: true,
        bodyMoved: true,
        bodyTransition: {
          protocol: "behold.body-transition.v1",
          observation: "motion_observed_during_control_interval_cause_unknown",
          frame: "egocentric_at_control_start",
          units: { distance: "blocks", angle: "radians" },
          requestedAxisProgress: 0.82,
          lateralDisplacement: 0.1,
          verticalDisplacement: 0,
          netDistance: 0.83,
          pathDistance: 0.91,
          maxExcursion: 0.84,
          yawDelta: 0.03,
          pitchDelta: 0,
          sampleCount: 8,
          startPosition: { x: 1977, y: -47, z: 1419 },
        },
      },
    };

    let projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("Motion was observed during the control interval; cause unknown");
    expect(projection.text).toContain("requested-axis +0.82 blocks, lateral +0.1, vertical +0");
    expect(projection.text).toContain("yaw Δ+0.03 rad, pitch Δ+0 rad; 8 samples");
    expect(projection.text).not.toContain("1977");
    expect(projection.diagnostics).toContainEqual({
      code: "source_only_outcome_field",
      sourcePath: "payload.payload.outcome.result.bodyTransition.startPosition",
    });
    expect(projection.diagnostics.some((item) => item.code === "unsupported_outcome_result")).toBe(false);

    turn.outcome.result.bodyTransition.netDistance = 0.08;
    projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).not.toContain("Motion was observed during the control interval");
    expect(projection.diagnostics).toContainEqual({
      code: "inconsistent_body_transition",
      sourcePath: "payload.payload.outcome.result",
    });
    expect(projection.diagnostics).toContainEqual({
      code: "unsupported_outcome_result",
      sourcePath: "payload.payload.outcome.result",
    });

    turn.outcome.result.bodyMoved = false;
    turn.outcome.result.bodyTransition.units.distance = "meters";
    projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).not.toContain("Motion was observed during the control interval");
    expect(projection.diagnostics).toContainEqual({
      code: "unsupported_body_transition",
      sourcePath: "payload.payload.outcome.result.bodyTransition",
    });

    delete turn.outcome.result.bodyTransition;
    turn.outcome.result.bodyMoved = true;
    projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("The body moved.");
  });

  it("presents focused use, container inspection, and stop without claiming world consequences", async () => {
    const body = await canonicalV2Turn();
    const turn = (body.payload as any).payload;
    turn.action = {
      id: "use-1",
      name: "use_focused_block",
      input: {},
      kind: "exclusive",
      toolCallId: "use-tool",
      source: "llm",
    };
    turn.outcome = {
      ok: true,
      eventType: "action_completed",
      result: {
        ok: true,
        status: "use_input_dispatched",
        target: { id: "private-target", name: "note_block", position: { x: 1, y: 2, z: 3 } },
        confirmation: "mineflayer:single_activate_block_input",
      },
    };
    let projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("attempted to use the focused block");
    expect(projection.text).toContain("no resulting world change is confirmed here");
    expect(projection.text).not.toContain("private-target");
    expect(projection.diagnostics.some((item) => item.code === "unsupported_outcome_result")).toBe(false);

    turn.action.name = "inspect_focused_container";
    turn.outcome = {
      ok: false,
      eventType: "action_failed",
      result: { ok: false, error: "focused_block_is_not_container" },
    };
    projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("attempted to inspect the focused container");
    expect(projection.text).toContain("bodily attempt failed: focused block is not container");

    turn.action.name = "stop";
    turn.outcome = { ok: true, eventType: "action_completed", result: { ok: true } };
    projection = presented(body, BEHOLD_INHABITANT_PROFILE_V2);
    expect(projection.text).toContain("released the body's movement controls");
    expect(projection.text).toContain("confirmed its movement controls were released");
    expect(projection.diagnostics.some((item) => item.code.startsWith("unsupported_"))).toBe(false);
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
