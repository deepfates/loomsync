import type { LyncEventBody } from "../events.js";
import type {
  LyncPresentation,
  LyncPresentationDiagnostic,
  LyncPresentationSection,
} from "../presentation.js";

export const BEHOLD_INHABITANT_PROFILE = "org.behold.inhabitant.v1";
export const BEHOLD_INHABITANT_PROFILE_V2 = "org.behold.inhabitant.v2";

const V1 = {
  profile: BEHOLD_INHABITANT_PROFILE,
  contract: "org.behold.presentation.inhabitant-turn.v1",
  version: 1,
} as const;
const V2 = {
  profile: BEHOLD_INHABITANT_PROFILE_V2,
  contract: "org.behold.presentation.inhabitant-turn.v2",
  version: 2,
} as const;
type BeholdPresentationProfile = typeof V1 | typeof V2;
const HUMAN_PROFILE = "minecraft-human-semantic-v1";
const OBSERVATION_PROTOCOL = "behold.minecraft-human-semantic-observation.v1";

/**
 * Behold owns the meaning of this exact profile. Lync projects only the
 * allowlisted paths in Behold's v1 presentation pact; it never searches an
 * opaque payload for plausible prose.
 */
export function presentBeholdInhabitantEvent(
  event: LyncEventBody,
): LyncPresentation | null {
  return presentBeholdEvent(event, V1);
}

export function presentBeholdInhabitantEventV2(
  event: LyncEventBody,
): LyncPresentation | null {
  return presentBeholdEvent(event, V2);
}

function presentBeholdEvent(
  event: LyncEventBody,
  profile: BeholdPresentationProfile,
): LyncPresentation | null {
  if (event.kind === "lync/loom") return presentResidentLoom(event, profile);
  if (event.kind === "lync/turn") return presentResidentTurn(event, profile);
  return null;
}

function presentResidentLoom(
  event: LyncEventBody,
  profile: BeholdPresentationProfile,
): LyncPresentation | null {
  const meta = recordField(event.payload, "meta");
  if (
    stringField(meta, "protocol") !== "behold.entity-loom.v1" ||
    stringField(meta, "profile") !== profile.profile
  ) {
    return null;
  }
  const entityId = stringField(meta, "entityId");
  const circleId = stringField(meta, "circleId");
  if (!entityId) return null;
  const lines = [
    `Behold resident life: ${entityId}`,
    circleId ? `World circle: ${circleId}` : null,
    `Profile: ${profile.profile}`,
  ].filter((line): line is string => line !== null);
  const section: LyncPresentationSection = {
    role: "structure",
    text: lines.join("\n"),
    sourcePaths: ["payload.meta"],
  };
  return {
    text: section.text,
    kind: "structure",
    contract: profile.contract,
    source: presentationSource(event),
    sections: [section],
    diagnostics: [],
  };
}

function presentResidentTurn(
  event: LyncEventBody,
  profile: BeholdPresentationProfile,
): LyncPresentation | null {
  const link = recordField(event.payload, "meta");
  const turn = recordField(event.payload, "payload");
  if (
    !link ||
    !turn ||
    stringField(link, "protocol") !== "behold.entity-turn-link.v1" ||
    stringField(turn, "protocol") !== "behold.entity-turn.v1"
  ) {
    return null;
  }
  const profiles = recordField(turn, "profiles");
  if (
    stringField(profiles, "body") !== HUMAN_PROFILE ||
    stringField(profiles, "actions") !== HUMAN_PROFILE
  ) {
    return null;
  }

  const entityId = stringField(turn, "entityId");
  const sequence = integerField(turn, "sequence");
  const model = stringField(turn, "model");
  if (!entityId || sequence === null || !model) return null;

  const diagnostics: LyncPresentationDiagnostic[] = [];
  const sections: LyncPresentationSection[] = [];
  const observation = presentObservation(
    turn.observation,
    entityId,
    "payload.payload.observation",
    diagnostics,
    profile,
  );
  if (observation) sections.push(observation);

  const utterance = presentUtterance(turn.utterance);
  if (utterance) sections.push(utterance);

  sections.push(presentAction(turn.action, entityId, diagnostics, profile));
  sections.push(presentOutcome(turn.action, turn.outcome, diagnostics, profile));

  const nextObservation = presentObservation(
    turn.nextObservation,
    entityId,
    "payload.payload.nextObservation",
    diagnostics,
    profile,
  );
  if (nextObservation) sections.push(nextObservation);

  const release = recordField(turn, "experimentRelease");
  const releaseId = stringField(release, "releaseId");
  const observedOrder = integerField(release, "residentObservedOrder");
  const structure = [
    `${entityId} · turn ${sequence}`,
    `Model: ${model}`,
    `Profiles: ${stringField(profiles, "policy") ?? "unknown"} · ${HUMAN_PROFILE} · ${stringField(profiles, "safety") ?? "unknown"}`,
    releaseId ? `Release: ${releaseId}` : null,
    observedOrder === null ? null : `Resident-observed order: ${observedOrder}`,
  ].filter((line): line is string => line !== null);

  return {
    text: [structure.join("\n"), ...sections.map(sectionText)].join("\n\n"),
    kind: "content",
    contract: profile.contract,
    source: presentationSource(event),
    sections,
    diagnostics,
  };
}

function presentationSource(event: LyncEventBody) {
  return {
    id: event.id,
    parents: [...event.parents],
    author: {
      actor: event.author.actor,
      ...(typeof event.author.via === "string"
        ? { via: event.author.via }
        : {}),
    },
    kind: event.kind,
  };
}

function presentObservation(
  value: unknown,
  entityId: string,
  sourcePath: string,
  diagnostics: LyncPresentationDiagnostic[],
  profile: BeholdPresentationProfile,
): LyncPresentationSection | null {
  const observation = recordValue(value);
  if (!observation || stringField(observation, "protocol") !== OBSERVATION_PROTOCOL) {
    diagnostics.push({ code: "unsupported_observation_protocol", sourcePath });
    return null;
  }
  const bodyContract = recordField(observation, "bodyContract");
  if (stringField(bodyContract, "profile") !== HUMAN_PROFILE) {
    diagnostics.push({
      code: "unsupported_observation_body_profile",
      sourcePath,
    });
    return null;
  }

  const lines: string[] = [];
  const self = recordField(observation, "self");
  const condition = recordField(self, "condition");
  const conditionParts = [
    numberField(condition, "health") === null
      ? null
      : `health ${numberField(condition, "health")}`,
    numberField(condition, "food") === null
      ? null
      : `food ${numberField(condition, "food")}`,
    numberField(condition, "breathBubbles") === null
      ? null
      : `breath ${numberField(condition, "breathBubbles")}`,
    typeof condition?.sleeping === "boolean"
      ? condition.sleeping
        ? "sleeping"
        : "awake"
      : null,
    stringField(condition, "dimension"),
    stringField(condition, "daylight"),
  ].filter((part): part is string => part !== null);
  if (conditionParts.length)
    lines.push(`${entityId}'s condition: ${conditionParts.join(" · ")}.`);

  const inventory = arrayField(self, "inventory").flatMap(presentInventoryItem);
  if (inventory.length) lines.push(`Inventory: ${inventory.join(", ")}.`);
  else if (Array.isArray(self?.inventory)) lines.push("Inventory: empty.");
  const heldItem = presentInventoryItem(self?.heldItem);
  if (heldItem.length) lines.push(`Held item: ${heldItem.join(", ")}.`);

  if (observation.eventWindow !== undefined) {
    diagnostics.push({
      code: "source_only_event_window",
      sourcePath: `${sourcePath}.eventWindow`,
    });
  }
  if (self?.pose !== undefined) {
    diagnostics.push({
      code: "source_only_pose",
      sourcePath: `${sourcePath}.self.pose`,
    });
  }

  const scene = recordField(observation, "scene");
  const social = recordField(scene, "social");
  const players = stringArray(social?.playersOnline);
  if (players.length) lines.push(`Players online: ${players.join(", ")}.`);

  const entities = arrayField(scene, "entities").flatMap((item, index) => {
    const entity = recordValue(item);
    const name = stringField(entity, "name");
    const kind = stringField(entity, "kind");
    if (!name && !kind) return [];
    if (entity?.reference !== undefined) {
      diagnostics.push({
        code: "withheld_observation_local_reference",
        sourcePath: `${sourcePath}.scene.entities[${index}].reference`,
      });
    }
    const details = [
      kind,
      stringField(entity, "proximity"),
      stringField(entity, "relativeDirection"),
      stringField(entity, "visibility"),
    ].filter((detail): detail is string => detail !== null);
    return [
      `Saw ${name ?? kind}${details.length ? ` (${details.join(", ")})` : ""}.`,
    ];
  });
  lines.push(...entities);

  const focus = recordField(scene, "focus");
  if (focus) {
    const focusParts = [
      stringField(focus, "name"),
      stringField(focus, "kind"),
      stringField(focus, "material"),
      stringField(focus, "proximity"),
      stringField(focus, "relativeDirection"),
      stringField(focus, "visibility"),
    ].filter((part): part is string => part !== null);
    if (focusParts.length) lines.push(`Focus: ${focusParts.join(" · ")}.`);
    if (focus.reference !== undefined) {
      diagnostics.push({
        code: "withheld_observation_local_reference",
        sourcePath: `${sourcePath}.scene.focus.reference`,
      });
    }
  }

  const terrain = recordField(scene, "terrain");
  const visualField = recordField(terrain, "visualField");
  if (
    stringField(visualField, "protocol") === "behold.visual-field.v1" &&
    visualField?.available === true
  ) {
    const materials = arrayField(visualField, "materialLegend").flatMap(
      (item) => {
        const name = stringField(recordValue(item), "name");
        return name ? [humanize(name)] : [];
      },
    );
    const depths = arrayField(visualField, "depthLegend").flatMap((item) => {
      const label = stringField(recordValue(item), "label");
      return label ? [label] : [];
    });
    if (materials.length)
      lines.push(`Visible terrain: ${unique(materials).join(", ")}.`);
    if (depths.length)
      lines.push(`Visual depth bands: ${unique(depths).join(", ")}.`);
    if (
      visualField.materialRows !== undefined ||
      visualField.depthRows !== undefined
    ) {
      diagnostics.push({
        code: "source_only_visual_field_encoding",
        sourcePath: `${sourcePath}.scene.terrain.visualField`,
      });
    }
  }

  const eventLines = arrayField(observation, "events").flatMap(
    (item, index) => {
      const event = recordValue(item);
      const type = stringField(event, "type");
      const data = recordField(event, "data");
      if (type === "spawned") return ["Spawned into the world."];
      if (type === "condition_changed") return ["HUD condition changed."];
      if (type === "entity_became_visible") {
        const name =
          stringField(data, "name") ?? stringField(data, "kind") ?? "An entity";
        const proximity = stringField(data, "proximity");
        return [`${name} became visible${proximity ? ` ${proximity}` : ""}.`];
      }
      if (type === "entity_left_view") {
        const name =
          stringField(data, "name") ?? stringField(data, "kind") ?? "An entity";
        if (data?.lastSeenDistance !== undefined) {
          diagnostics.push({
            code: "withheld_incidental_numeric_estimate",
            sourcePath: `${sourcePath}.events[${index}].data.lastSeenDistance`,
          });
        }
        return [`${name} left the current view.`];
      }
      if (type === "chat_received") {
        const from = stringField(data, "from");
        const text = stringField(data, "text");
        if (!text) return [];
        const channel = profile.version === 2 ? stringField(data, "channel") : null;
        if (profile.version === 2 && channel === "private") {
          return [`Private whisper${from ? ` from ${from}` : ""}: ${text}`];
        }
        if (profile.version === 2 && channel !== null && channel !== "public") {
          return unsupportedObservationEvent(`${sourcePath}.events[${index}]`, diagnostics);
        }
        return [`Public chat${from ? ` from ${from}` : ""}: ${text}`];
      }
      if (profile.version === 2 && type === "sound_heard") {
        diagnoseObservationEventEnvelope(event, `${sourcePath}.events[${index}]`, diagnostics);
        return presentSoundHeard(data, `${sourcePath}.events[${index}]`, diagnostics);
      }
      if (profile.version === 2 && type === "sound_sequence_heard") {
        diagnoseObservationEventEnvelope(event, `${sourcePath}.events[${index}]`, diagnostics);
        return presentSoundSequence(data, `${sourcePath}.events[${index}]`, diagnostics);
      }
      if (profile.version === 2 && type === "time_passed") {
        diagnoseObservationEventEnvelope(event, `${sourcePath}.events[${index}]`, diagnostics);
        diagnoseSourceOnlyFields(
          data,
          new Set(["elapsedMs"]),
          `${sourcePath}.events[${index}].data`,
          diagnostics,
        );
        const elapsedMs = integerField(data, "elapsedMs");
        return elapsedMs !== null && elapsedMs >= 0
          ? [`Time passed: ${elapsedMs} ms.`]
          : unsupportedObservationEvent(`${sourcePath}.events[${index}]`, diagnostics);
      }
      if (
        profile.version === 2 &&
        [
          "day_phase_changed",
          "self_hurt",
          "visible_entity_hurt",
          "visible_entity_died",
          "died",
          "action_failed",
          "controller_suspended",
          "cancellation_requested",
          "visible_block_changed",
        ].includes(type ?? "")
      ) {
        return presentResidentLifecycleEvent(
          type ?? "",
          event,
          data,
          `${sourcePath}.events[${index}]`,
          diagnostics,
        );
      }
      if (profile.version === 2 && type === "experience_pressure_sequence") {
        diagnoseObservationEventEnvelope(
          event,
          `${sourcePath}.events[${index}]`,
          diagnostics,
        );
        return presentExperiencePressureSequence(
          data,
          `${sourcePath}.events[${index}]`,
          diagnostics,
        );
      }
      diagnostics.push({
        code: "unsupported_observation_event",
        sourcePath: `${sourcePath}.events[${index}]`,
      });
      return [];
    },
  );
  lines.push(...eventLines);

  if (lines.length === 0) {
    diagnostics.push({ code: "empty_safe_observation_projection", sourcePath });
    return null;
  }
  return {
    role: "perception",
    text: lines.join(" "),
    sourcePaths: [sourcePath],
  };
}

function presentUtterance(value: unknown): LyncPresentationSection | null {
  const assistant = recordField(recordValue(value), "assistant");
  const content = stringField(assistant, "content")?.trim();
  if (!content) return null;
  return {
    role: "utterance",
    text: content,
    sourcePaths: ["payload.payload.utterance.assistant.content"],
  };
}

function presentAction(
  value: unknown,
  entityId: string,
  diagnostics: LyncPresentationDiagnostic[],
  profile: BeholdPresentationProfile,
): LyncPresentationSection {
  const action = recordValue(value);
  const name = stringField(action, "name") ?? "unknown action";
  const source = stringField(action, "source") ?? "unknown source";
  const kind = stringField(action, "kind") ?? "unknown kind";
  const input = recordField(action, "input");
  let description: string | null = null;
  const paths = [
    "payload.payload.action.name",
    "payload.payload.action.source",
    "payload.payload.action.kind",
  ];
  if (action?.id !== undefined) {
    diagnostics.push({
      code: "source_only_action_identity",
      sourcePath: "payload.payload.action.id",
    });
  }
  if (action?.toolCallId !== undefined) {
    diagnostics.push({
      code: "source_only_tool_call_identity",
      sourcePath: "payload.payload.action.toolCallId",
    });
  }
  if (name === "look_direction") {
    const horizontal = stringField(input, "horizontal");
    const vertical = stringField(input, "vertical");
    if (horizontal) {
      description = `${entityId} looked ${horizontal}${vertical ? `, ${vertical}` : ""}.`;
      paths.push("payload.payload.action.input.horizontal");
      if (vertical) paths.push("payload.payload.action.input.vertical");
    }
  } else if (name === "move_controls") {
    const direction = stringField(input, "direction");
    const durationMs = integerField(input, "durationMs");
    if (direction) {
      description = `${entityId} held ${direction}${durationMs === null ? "" : ` for ${durationMs} ms`}.`;
      paths.push("payload.payload.action.input.direction");
      if (durationMs !== null)
        paths.push("payload.payload.action.input.durationMs");
    }
  } else if (name === "chat") {
    const text = stringField(input, "text");
    if (text) {
      description = `${entityId} sent public chat: ${text}`;
      paths.push("payload.payload.action.input.text");
    }
  } else if (name === "wait_for_event") {
    const reason = stringField(input, "reason");
    description = `${entityId} waited for another event${reason ? `: ${reason}` : "."}`;
    if (reason) paths.push("payload.payload.action.input.reason");
  } else if (
    profile.version === 2 &&
    ["attack_focused_entity", "dig_focused_block", "use_focused_block"].includes(name)
  ) {
    diagnoseSourceOnlyFields(
      action,
      new Set(["id", "name", "input", "kind", "toolCallId", "source"]),
      "payload.payload.action",
      diagnostics,
      new Set(),
      "source_only_action_field",
    );
    diagnoseSourceOnlyFields(
      input,
      new Set(),
      "payload.payload.action.input",
      diagnostics,
      new Set(),
      "source_only_action_input_field",
    );
    if (input) {
      description =
        name === "attack_focused_entity"
          ? `${entityId} attempted one attack at the focused entity.`
          : name === "dig_focused_block"
            ? `${entityId} attempted to dig the focused block.`
            : `${entityId} attempted to use the focused block.`;
    }
  } else if (profile.version === 2 && name === "inspect_focused_container") {
    diagnoseSourceOnlyFields(
      input,
      new Set(),
      "payload.payload.action.input",
      diagnostics,
      new Set(),
      "source_only_action_input_field",
    );
    if (input) description = `${entityId} attempted to inspect the focused container.`;
  } else if (profile.version === 2 && name === "stop") {
    diagnoseSourceOnlyFields(
      input,
      new Set(),
      "payload.payload.action.input",
      diagnostics,
      new Set(),
      "source_only_action_input_field",
    );
    if (input) description = `${entityId} released the body's movement controls.`;
  } else if (profile.version === 2 && name === "read_private_life") {
    diagnoseSourceOnlyFields(
      input,
      new Set(["startSequence", "endSequence"]),
      "payload.payload.action.input",
      diagnostics,
      new Set(),
      "source_only_action_input_field",
    );
    const start = integerField(input, "startSequence");
    const end = integerField(input, "endSequence");
    if (start !== null && start >= 1 && end !== null && end >= start) {
      description = `${entityId} consulted their own canonical life, requesting turns ${start}–${end}.`;
      paths.push(
        "payload.payload.action.input.startSequence",
        "payload.payload.action.input.endSequence",
      );
    }
  } else if (profile.version === 2 && name === "whisper") {
    diagnoseSourceOnlyFields(
      action,
      new Set(["id", "name", "input", "kind", "toolCallId", "source"]),
      "payload.payload.action",
      diagnostics,
      new Set(),
      "source_only_action_field",
    );
    diagnoseSourceOnlyFields(
      input,
      new Set(["username", "text"]),
      "payload.payload.action.input",
      diagnostics,
      new Set(),
      "source_only_action_input_field",
    );
    const username = stringField(input, "username")?.trim();
    const text = stringField(input, "text")?.trim();
    if (username && text) {
      description = `${entityId} whispered to ${username}: ${text}`;
      paths.push(
        "payload.payload.action.input.username",
        "payload.payload.action.input.text",
      );
    }
  }
  if (!description) {
    description = `${entityId} recorded ${name}; its input has no safe v${profile.version} Textile presenter.`;
    diagnostics.push({
      code: "unsupported_action_input",
      sourcePath: "payload.payload.action.input",
    });
  }
  return {
    role: "action",
    text: `[${source} · ${kind}] ${description}`,
    sourcePaths: paths,
  };
}

function presentOutcome(
  actionValue: unknown,
  outcomeValue: unknown,
  diagnostics: LyncPresentationDiagnostic[],
  profile: BeholdPresentationProfile,
): LyncPresentationSection {
  const action = recordValue(actionValue);
  const outcome = recordValue(outcomeValue);
  const actionName = stringField(action, "name") ?? "action";
  const eventType = stringField(outcome, "eventType") ?? "unknown outcome";
  const ok = typeof outcome?.ok === "boolean" ? outcome.ok : null;
  const result = recordField(outcome, "result");
  const paths = [
    "payload.payload.outcome.ok",
    "payload.payload.outcome.eventType",
  ];
  let detail: string | null = null;
  let v2ShownResultKeys: Set<string> | null = null;
  if (profile.version === 2 && eventType === "intent_blocked" && result) {
    const invalidated = presentLifeBoundaryInvalidation(result, paths, diagnostics);
    detail = invalidated.detail;
    v2ShownResultKeys = invalidated.shownResultKeys;
  } else if (actionName === "look_direction") {
    const orientation = recordField(result, "orientation");
    const facing = stringField(orientation, "facing");
    const vertical = stringField(orientation, "vertical");
    if (facing) {
      detail = ` The body confirmed facing ${facing}${vertical ? ` and ${vertical}` : ""}.`;
      paths.push("payload.payload.outcome.result.orientation.facing");
      if (vertical)
        paths.push("payload.payload.outcome.result.orientation.vertical");
    }
  } else if (actionName === "move_controls" && typeof result?.bodyMoved === "boolean") {
    if (profile.version === 2 && result.bodyTransition !== undefined) {
      const transition = presentBodyTransition(result, paths, diagnostics);
      detail = transition.detail;
      v2ShownResultKeys = transition.shownResultKeys;
    } else {
      detail = result.bodyMoved ? " The body moved." : " The body did not move.";
      paths.push("payload.payload.outcome.result.bodyMoved");
    }
  } else if (actionName === "chat") {
    if (profile.version === 2 && result) {
      const resultOk = typeof result.ok === "boolean" ? result.ok : null;
      const status = stringField(result, "status")?.trim();
      const error = stringField(result, "error")?.trim();
      if (resultOk === true && (!status || status === "chat_input_dispatched")) {
        detail = " The public chat input was submitted; recipient delivery was not independently confirmed here.";
        v2ShownResultKeys = new Set(["ok", "status", "message"]);
        paths.push("payload.payload.outcome.result.ok");
        if (status) paths.push("payload.payload.outcome.result.status");
      } else if (resultOk === false && error) {
        detail = ` The public chat input was rejected: ${humanize(error)}.`;
        v2ShownResultKeys = new Set([
          "ok",
          "error",
          "maximumCharacters",
          "providedCharacters",
        ]);
        paths.push(
          "payload.payload.outcome.result.ok",
          "payload.payload.outcome.result.error",
        );
      }
    } else {
      detail = ok === true ? " Minecraft confirmed the public chat action." : null;
    }
  } else if (
    actionName === "wait_for_event" &&
    typeof result?.sawPeerChat === "boolean"
  ) {
    detail = result.sawPeerChat
      ? " The resident observed peer chat."
      : " No peer chat was observed.";
    paths.push("payload.payload.outcome.result.sawPeerChat");
  } else if (
    profile.version === 2 &&
    actionName === "wait_for_event" &&
    result?.ok === true &&
    result?.status === "waiting_for_world_event"
  ) {
    detail = " The resident is waiting for a world event.";
    v2ShownResultKeys = new Set(["ok", "status"]);
    paths.push(
      "payload.payload.outcome.result.ok",
      "payload.payload.outcome.result.status",
    );
  } else if (profile.version === 2 && actionName === "whisper" && result) {
    diagnoseSourceOnlyFields(
      outcome,
      new Set(["ok", "eventType", "result"]),
      "payload.payload.outcome",
      diagnostics,
      new Set(),
      "source_only_outcome_field",
    );
    const resultOk = typeof result.ok === "boolean" ? result.ok : null;
    const status = stringField(result, "status")?.trim();
    const message = stringField(result, "message")?.trim();
    const error = stringField(result, "error")?.trim();
    if (resultOk === true && (!status || status === "whisper_input_dispatched")) {
      detail = " The private whisper input was submitted; recipient delivery was not independently confirmed here.";
      v2ShownResultKeys = new Set(["ok", "status", "message"]);
      paths.push("payload.payload.outcome.result.ok");
      if (status) paths.push("payload.payload.outcome.result.status");
      if (!status && message) paths.push("payload.payload.outcome.result.message");
    } else if (resultOk === false && error) {
      detail = ` Minecraft rejected the private whisper: ${humanize(error)}.`;
      v2ShownResultKeys = new Set([
        "ok",
        "error",
        "maximumCharacters",
        "providedCharacters",
      ]);
      paths.push(
        "payload.payload.outcome.result.ok",
        "payload.payload.outcome.result.error",
      );
    }
  } else if (profile.version === 2 && actionName === "read_private_life" && result) {
    const returned = recordField(result, "returned");
    const start = integerField(returned, "startSequence");
    const end = integerField(returned, "endSequence");
    const messageCount = integerField(result, "messageCount");
    const complete = typeof result.complete === "boolean" ? result.complete : null;
    if (
      stringField(result, "protocol") === "behold.resident-private-life-page.v1" &&
      start !== null && start >= 1 && end !== null && end >= start &&
      messageCount !== null && messageCount >= 0 && complete !== null
    ) {
      detail = ` The resident's private life returned turns ${start}–${end} (${messageCount} messages; ${complete ? "complete" : "more available"}).`;
      v2ShownResultKeys = new Set([
        "protocol",
        "returned",
        "messageCount",
        "complete",
        "nextSequence",
      ]);
      paths.push(
        "payload.payload.outcome.result.protocol",
        "payload.payload.outcome.result.returned.startSequence",
        "payload.payload.outcome.result.returned.endSequence",
        "payload.payload.outcome.result.messageCount",
        "payload.payload.outcome.result.complete",
      );
      if (result.nextSequence !== undefined) {
        paths.push("payload.payload.outcome.result.nextSequence");
      }
    }
  } else if (
    profile.version === 2 &&
    actionName === "use_focused_block" &&
    result?.ok === true &&
    result?.status === "use_input_dispatched"
  ) {
    const target = recordField(result, "target");
    const targetName = stringField(target, "name")?.trim();
    if (targetName) {
      detail = ` Use input was dispatched to the focused ${humanize(targetName)}; no resulting world change is confirmed here.`;
      v2ShownResultKeys = new Set(["ok", "status"]);
      paths.push(
        "payload.payload.outcome.result.ok",
        "payload.payload.outcome.result.status",
        "payload.payload.outcome.result.target.name",
      );
    }
  } else if (
    profile.version === 2 &&
    actionName === "stop" &&
    result?.ok === true &&
    Object.keys(result).every((key) => key === "ok")
  ) {
    detail = " The body confirmed its movement controls were released.";
    v2ShownResultKeys = new Set(["ok"]);
    paths.push("payload.payload.outcome.result.ok");
  } else if (
    profile.version === 2 &&
    result &&
    ["attack_focused_entity", "dig_focused_block"].includes(actionName)
  ) {
    diagnoseSourceOnlyFields(
      outcome,
      new Set(["ok", "eventType", "result", "error", "cancellation"]),
      "payload.payload.outcome",
      diagnostics,
      new Set(["error", "cancellation"]),
      "source_only_outcome_field",
    );
    const focused = presentFocusedActionResult(
      actionName,
      result,
      paths,
      diagnostics,
    );
    detail = focused.detail;
    v2ShownResultKeys = focused.shownResultKeys;
  }
  if (
    profile.version === 2 &&
    result &&
    detail === null &&
    eventType === "action_failed" &&
    result.ok === false
  ) {
    const error = stringField(result, "error")?.trim();
    if (error) {
      detail = ` The bodily attempt failed: ${humanize(error)}.`;
      v2ShownResultKeys = new Set(["ok", "error"]);
      paths.push(
        "payload.payload.outcome.result.ok",
        "payload.payload.outcome.result.error",
      );
    }
  }
  if (result && detail === null) {
    diagnostics.push({
      code: "unsupported_outcome_result",
      sourcePath: "payload.payload.outcome.result",
    });
  }
  if (result) {
    const shownResultKeys =
      v2ShownResultKeys ?? (actionName === "look_direction"
        ? new Set(["orientation"])
        : actionName === "move_controls"
          ? new Set(["bodyMoved"])
          : actionName === "wait_for_event"
            ? new Set(["sawPeerChat"])
            : new Set<string>());
    for (const key of Object.keys(result)) {
      if (!shownResultKeys.has(key)) {
        diagnostics.push({
          code: "source_only_outcome_field",
          sourcePath: `payload.payload.outcome.result.${key}`,
        });
      }
    }
  }
  const terminal = outcomeTerminal(ok, eventType);
  return {
    role: "outcome",
    text: `${actionName} ${terminal} (${eventType}).${detail ?? ""}`,
    sourcePaths: paths,
  };
}

function presentBodyTransition(
  result: Record<string, unknown>,
  paths: string[],
  diagnostics: LyncPresentationDiagnostic[],
): { detail: string | null; shownResultKeys: Set<string> } {
  const shownResultKeys = new Set(["bodyMoved", "bodyTransition"]);
  const sourcePath = "payload.payload.outcome.result.bodyTransition";
  const transition = recordField(result, "bodyTransition");
  diagnoseSourceOnlyFields(
    transition,
    new Set([
      "protocol",
      "observation",
      "frame",
      "units",
      "requestedAxisProgress",
      "lateralDisplacement",
      "verticalDisplacement",
      "netDistance",
      "pathDistance",
      "maxExcursion",
      "yawDelta",
      "pitchDelta",
      "sampleCount",
    ]),
    sourcePath,
    diagnostics,
    new Set(),
    "source_only_outcome_field",
  );
  const units = recordField(transition, "units");
  diagnoseSourceOnlyFields(
    units,
    new Set(["distance", "angle"]),
    `${sourcePath}.units`,
    diagnostics,
    new Set(),
    "source_only_outcome_field",
  );
  const requested = numberField(transition, "requestedAxisProgress");
  const lateral = numberField(transition, "lateralDisplacement");
  const vertical = numberField(transition, "verticalDisplacement");
  const net = numberField(transition, "netDistance");
  const path = numberField(transition, "pathDistance");
  const excursion = numberField(transition, "maxExcursion");
  const yaw = numberField(transition, "yawDelta");
  const pitch = numberField(transition, "pitchDelta");
  const samples = integerField(transition, "sampleCount");
  const exactContract =
    stringField(transition, "protocol") === "behold.body-transition.v1" &&
    stringField(transition, "observation") ===
      "motion_observed_during_control_interval_cause_unknown" &&
    stringField(transition, "frame") === "egocentric_at_control_start" &&
    stringField(units, "distance") === "blocks" &&
    stringField(units, "angle") === "radians";
  if (
    !exactContract ||
    requested === null || lateral === null || vertical === null ||
    net === null || net < 0 ||
    path === null || path < 0 ||
    excursion === null || excursion < 0 ||
    yaw === null || pitch === null ||
    samples === null || samples < 1
  ) {
    diagnostics.push({ code: "unsupported_body_transition", sourcePath });
    return { detail: null, shownResultKeys };
  }
  if (result.bodyMoved !== (net >= 0.1)) {
    diagnostics.push({
      code: "inconsistent_body_transition",
      sourcePath: "payload.payload.outcome.result",
    });
    return { detail: null, shownResultKeys };
  }
  paths.push(
    "payload.payload.outcome.result.bodyMoved",
    `${sourcePath}.protocol`,
    `${sourcePath}.observation`,
    `${sourcePath}.frame`,
    `${sourcePath}.units.distance`,
    `${sourcePath}.units.angle`,
    `${sourcePath}.requestedAxisProgress`,
    `${sourcePath}.lateralDisplacement`,
    `${sourcePath}.verticalDisplacement`,
    `${sourcePath}.netDistance`,
    `${sourcePath}.pathDistance`,
    `${sourcePath}.maxExcursion`,
    `${sourcePath}.yawDelta`,
    `${sourcePath}.pitchDelta`,
    `${sourcePath}.sampleCount`,
  );
  return {
    detail:
      ` Motion was observed during the control interval; cause unknown.` +
      ` In the control-start egocentric frame: requested-axis ${measure(requested)} blocks,` +
      ` lateral ${measure(lateral)}, vertical ${measure(vertical)};` +
      ` net ${measure(net)}, path ${measure(path)}, maximum excursion ${measure(excursion)};` +
      ` yaw Δ${measure(yaw)} rad, pitch Δ${measure(pitch)} rad; ${samples} samples.`,
    shownResultKeys,
  };
}

function presentLifeBoundaryInvalidation(
  result: Record<string, unknown>,
  paths: string[],
  diagnostics: LyncPresentationDiagnostic[],
): { detail: string | null; shownResultKeys: Set<string> } {
  const shownResultKeys = new Set(["ok", "error", "reason", "invalidatingEvents"]);
  const reason = stringField(result, "reason");
  const missing = integerField(result, "missingBeforeOldest");
  if (reason === "observation_gap_after_decision" && missing !== null && missing > 0) {
    shownResultKeys.add("missingBeforeOldest");
    paths.push(
      "payload.payload.outcome.result.reason",
      "payload.payload.outcome.result.missingBeforeOldest",
    );
    return {
      detail: ` The choice was invalidated before bodily action because ${missing} earlier body events became unavailable after the decision.`,
      shownResultKeys,
    };
  }
  if (reason !== "body_life_boundary_changed") {
    return { detail: null, shownResultKeys };
  }
  const events = arrayField(result, "invalidatingEvents");
  const types: string[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const item = recordValue(events[index]);
    diagnoseSourceOnlyFields(
      item,
      new Set(["sequence", "at", "type"]),
      `payload.payload.outcome.result.invalidatingEvents[${index}]`,
      diagnostics,
      new Set(["sequence", "at"]),
      "source_only_outcome_field",
    );
    const type = stringField(item, "type")?.trim();
    if (!type) return { detail: null, shownResultKeys };
    types.push(type);
    paths.push(`payload.payload.outcome.result.invalidatingEvents[${index}].type`);
  }
  if (!types.includes("died") || !types.includes("spawned")) {
    return { detail: null, shownResultKeys };
  }
  paths.push("payload.payload.outcome.result.reason");
  if (missing !== null && missing > 0) {
    shownResultKeys.add("missingBeforeOldest");
    paths.push("payload.payload.outcome.result.missingBeforeOldest");
  }
  return {
    detail:
      " The choice was invalidated before bodily action because death and respawn crossed a life boundary." +
      (missing !== null && missing > 0
        ? ` ${missing} earlier body events were unavailable.`
        : ""),
    shownResultKeys,
  };
}

function presentResidentLifecycleEvent(
  type: string,
  event: Record<string, unknown> | null,
  data: Record<string, unknown> | null,
  eventPath: string,
  diagnostics: LyncPresentationDiagnostic[],
): string[] {
  diagnoseObservationEventEnvelope(event, eventPath, diagnostics);
  if (type === "day_phase_changed") {
    diagnoseSourceOnlyFields(
      data,
      new Set(["previous", "current"]),
      `${eventPath}.data`,
      diagnostics,
    );
    const previous = stringField(data, "previous")?.trim();
    const current = stringField(data, "current")?.trim();
    return previous && current
      ? [`Day phase changed: ${humanize(previous)} → ${humanize(current)}.`]
      : unsupportedObservationEvent(eventPath, diagnostics);
  }

  if (["self_hurt", "visible_entity_hurt", "visible_entity_died"].includes(type)) {
    diagnoseSourceOnlyFields(
      data,
      new Set(["name", "kind", "proximity"]),
      `${eventPath}.data`,
      diagnostics,
    );
    const name = stringField(data, "name")?.trim();
    const kind = stringField(data, "kind")?.trim();
    const proximity = stringField(data, "proximity")?.trim();
    if (!name && !kind) return unsupportedObservationEvent(eventPath, diagnostics);
    const subject = name ?? humanize(kind ?? "entity");
    const details = [kind, proximity].filter((item): item is string => Boolean(item));
    const verb =
      type === "self_hurt"
        ? "was hurt"
        : type === "visible_entity_hurt"
          ? "was seen taking damage"
          : "was seen die";
    return [`${subject} ${verb}${details.length ? ` (${details.join(", ")})` : ""}.`];
  }

  if (type === "died") {
    diagnoseSourceOnlyFields(data, new Set(), `${eventPath}.data`, diagnostics);
    return ["The resident died."];
  }
  if (type === "visible_block_changed") {
    diagnoseSourceOnlyFields(
      data,
      new Set(["before", "after"]),
      `${eventPath}.data`,
      diagnostics,
    );
    const before = stringField(data, "before")?.trim();
    const after = stringField(data, "after")?.trim();
    return before && after
      ? [`Visible block changed: ${humanize(before)} → ${humanize(after)}.`]
      : unsupportedObservationEvent(eventPath, diagnostics);
  }

  if (type === "action_failed") {
    diagnoseSourceOnlyFields(
      data,
      new Set([
        "intent",
        "authorization",
        "result",
        "error",
        "cancellation",
        "failureKind",
      ]),
      `${eventPath}.data`,
      diagnostics,
      new Set(["authorization", "result", "cancellation", "failureKind"]),
    );
    const intent = recordField(data, "intent");
    diagnoseIntentFields(intent, `${eventPath}.data.intent`, diagnostics);
    const tool = stringField(intent, "tool")?.trim();
    const error = stringField(data, "error")?.trim();
    if (!error) return unsupportedObservationEvent(eventPath, diagnostics);
    return [
      `Action failed${tool ? `: ${humanize(tool)}` : ""} (${humanize(error)}).`,
    ];
  }

  if (type === "controller_suspended") {
    diagnoseSourceOnlyFields(
      data,
      new Set(["reason", "activeIntent"]),
      `${eventPath}.data`,
      diagnostics,
    );
    const activeIntent = recordField(data, "activeIntent");
    diagnoseIntentFields(activeIntent, `${eventPath}.data.activeIntent`, diagnostics);
    const reason = stringField(data, "reason")?.trim();
    const tool = stringField(activeIntent, "tool")?.trim();
    if (!reason) return unsupportedObservationEvent(eventPath, diagnostics);
    return [
      `Controller suspended (${humanize(reason)})${tool ? ` during ${humanize(tool)}` : ""}.`,
    ];
  }

  if (type === "cancellation_requested") {
    diagnoseSourceOnlyFields(
      data,
      new Set(["intent", "requestedBy", "reason"]),
      `${eventPath}.data`,
      diagnostics,
    );
    const intent = recordField(data, "intent");
    diagnoseIntentFields(intent, `${eventPath}.data.intent`, diagnostics);
    const requestedBy = recordField(data, "requestedBy");
    diagnoseSourceOnlyFields(
      requestedBy,
      new Set(["source", "tool"]),
      `${eventPath}.data.requestedBy`,
      diagnostics,
    );
    const tool = stringField(intent, "tool")?.trim();
    const requesterSource = stringField(requestedBy, "source")?.trim();
    const requesterTool = stringField(requestedBy, "tool")?.trim();
    const reason = stringField(data, "reason")?.trim();
    if (!reason) return unsupportedObservationEvent(eventPath, diagnostics);
    const requester = [requesterSource, requesterTool]
      .filter((item): item is string => Boolean(item))
      .map(humanize)
      .join(" ");
    return [
      `Cancellation requested${tool ? ` for ${humanize(tool)}` : ""}${requester ? ` by ${requester}` : ""} (${humanize(reason)}).`,
    ];
  }

  return unsupportedObservationEvent(eventPath, diagnostics);
}

function diagnoseIntentFields(
  intent: Record<string, unknown> | null,
  sourcePath: string,
  diagnostics: LyncPresentationDiagnostic[],
): void {
  diagnoseSourceOnlyFields(
    intent,
    new Set(["source", "tool", "input", "observationSequence", "enqueuedAt"]),
    sourcePath,
    diagnostics,
    new Set(["source", "input", "observationSequence", "enqueuedAt"]),
  );
}

function presentFocusedActionResult(
  actionName: string,
  result: Record<string, unknown>,
  paths: string[],
  diagnostics: LyncPresentationDiagnostic[],
): { detail: string | null; shownResultKeys: Set<string> } {
  const shownResultKeys = new Set<string>();
  const details: string[] = [];
  const resultOk = typeof result.ok === "boolean" ? result.ok : null;
  if (resultOk !== null) {
    shownResultKeys.add("ok");
    paths.push("payload.payload.outcome.result.ok");
  }

  const error = stringField(result, "error")?.trim();
  if (error) {
    shownResultKeys.add("error");
    paths.push("payload.payload.outcome.result.error");
    details.push(`Body report: ${humanize(error)}.`);
  }

  if (actionName === "attack_focused_entity") {
    const status = stringField(result, "status")?.trim();
    const confirmation = stringField(result, "confirmation")?.trim();
    if (resultOk === true && status && confirmation) {
      shownResultKeys.add("status");
      shownResultKeys.add("confirmation");
      paths.push(
        "payload.payload.outcome.result.status",
        "payload.payload.outcome.result.confirmation",
      );
      details.push(
        `Body confirmation: ${humanize(status)} (${confirmation}).`,
      );
    }
  } else {
    const changes = presentMaterialChanges(
      result,
      "changes",
      "Change evidence",
      paths,
      diagnostics,
    );
    const attempted = presentMaterialChanges(
      result,
      "attemptedChanges",
      "Attempted change",
      paths,
      diagnostics,
    );
    if (changes.length) shownResultKeys.add("changes");
    if (attempted.length) shownResultKeys.add("attemptedChanges");
    details.push(...changes, ...attempted);
  }

  return {
    detail: details.length ? ` ${details.join(" ")}` : null,
    shownResultKeys,
  };
}

function presentMaterialChanges(
  result: Record<string, unknown>,
  field: "changes" | "attemptedChanges",
  label: string,
  paths: string[],
  diagnostics: LyncPresentationDiagnostic[],
): string[] {
  const raw = result[field];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    diagnostics.push({
      code: "unsupported_outcome_change",
      sourcePath: `payload.payload.outcome.result.${field}`,
    });
    return [];
  }
  return raw.flatMap((item, index) => {
    const change = recordValue(item);
    const changePath = `payload.payload.outcome.result.${field}[${index}]`;
    diagnoseSourceOnlyFields(
      change,
      new Set([
        "verb",
        "position",
        "before",
        "after",
        "verified",
        "observed",
        "confirmation",
        "context",
      ]),
      changePath,
      diagnostics,
      new Set(["position", "context"]),
      "source_only_outcome_field",
    );
    const confirmation = recordField(change, "confirmation");
    diagnoseSourceOnlyFields(
      confirmation,
      new Set([
        "source",
        "observedAt",
        "dimension",
        "position",
        "before",
        "after",
        "beforeStateId",
        "afterStateId",
      ]),
      `${changePath}.confirmation`,
      diagnostics,
      new Set([
        "observedAt",
        "dimension",
        "position",
        "before",
        "after",
        "beforeStateId",
        "afterStateId",
      ]),
      "source_only_outcome_field",
    );
    const verb = stringField(change, "verb")?.trim();
    const before = stringField(change, "before")?.trim();
    const after = stringField(change, "after")?.trim();
    const verified = typeof change?.verified === "boolean" ? change.verified : null;
    const observed = typeof change?.observed === "boolean" ? change.observed : null;
    const confirmationSource = stringField(confirmation, "source")?.trim();
    if (!verb || !before || !after || verified === null || observed === null) {
      diagnostics.push({ code: "unsupported_outcome_change", sourcePath: changePath });
      return [];
    }
    paths.push(
      `${changePath}.verb`,
      `${changePath}.before`,
      `${changePath}.after`,
      `${changePath}.verified`,
      `${changePath}.observed`,
    );
    if (confirmationSource) paths.push(`${changePath}.confirmation.source`);
    return [
      `${label}: ${humanize(verb)} ${humanize(before)} → ${humanize(after)}; verified ${verified ? "yes" : "no"}; observed ${observed ? "yes" : "no"}; confirmation ${confirmationSource ?? "none"}.`,
    ];
  });
}

function presentExperiencePressureSequence(
  data: Record<string, unknown> | null,
  eventPath: string,
  diagnostics: LyncPresentationDiagnostic[],
): string[] {
  diagnoseSourceOnlyFields(
    data,
    new Set([
      "compaction",
      "fromSequence",
      "throughSequence",
      "eventCount",
      "eventTypeCounts",
      "sounds",
      "condition",
      "entities",
    ]),
    `${eventPath}.data`,
    diagnostics,
  );
  const from = integerField(data, "fromSequence");
  const through = integerField(data, "throughSequence");
  const eventCount = integerField(data, "eventCount");
  if (
    stringField(data, "compaction") !== "behold.experience-pressure-sequence.v1" ||
    from === null || from < 0 || through === null || through < from ||
    eventCount === null || eventCount < 1
  ) {
    return unsupportedObservationEvent(eventPath, diagnostics);
  }

  const eventTypeCounts = recordField(data, "eventTypeCounts");
  const safeTypes = new Set([
    "condition_changed",
    "entity_became_visible",
    "entity_left_view",
    "self_hurt",
    "sound_heard",
    "visible_entity_hurt",
  ]);
  if (!eventTypeCounts || Object.keys(eventTypeCounts).length === 0) {
    return unsupportedObservationEvent(eventPath, diagnostics);
  }
  const typeDescriptions: string[] = [];
  let counted = 0;
  for (const [type, value] of Object.entries(eventTypeCounts)) {
    if (!safeTypes.has(type) || !Number.isSafeInteger(value) || Number(value) < 1) {
      return unsupportedObservationEvent(eventPath, diagnostics);
    }
    counted += Number(value);
    typeDescriptions.push(`${value} ${humanize(type)}`);
  }
  if (counted !== eventCount) return unsupportedObservationEvent(eventPath, diagnostics);

  const lines = [
    `Experience pressure summary: ${eventCount} lived events across body sequences ${from}–${through} (${typeDescriptions.join(", ")}).`,
  ];
  const sounds = recordField(data, "sounds");
  if (sounds) {
    diagnoseSourceOnlyFields(
      sounds,
      new Set(["entries", "distinctPatterns", "omittedDistinctPatterns"]),
      `${eventPath}.data.sounds`,
      diagnostics,
    );
    const entries = arrayField(sounds, "entries");
    const described: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = recordValue(entries[index]);
      const entryPath = `${eventPath}.data.sounds.entries[${index}]`;
      diagnoseSourceOnlyFields(
        entry,
        new Set(["sound", "distanceBand", "relativeDirection", "count"]),
        entryPath,
        diagnostics,
      );
      const sound = stringField(entry, "sound")?.trim();
      const distance = stringField(entry, "distanceBand")?.trim();
      const direction = stringField(entry, "relativeDirection")?.trim();
      const count = integerField(entry, "count");
      if (!sound || !distance || !direction || count === null || count < 1) {
        return unsupportedObservationEvent(eventPath, diagnostics);
      }
      described.push(`${count} × ${sound} (${distance}, ${direction})`);
    }
    const distinct = integerField(sounds, "distinctPatterns");
    const omitted = integerField(sounds, "omittedDistinctPatterns");
    if (
      entries.length === 0 || distinct === null || distinct < entries.length ||
      omitted === null || omitted < 0 || distinct !== entries.length + omitted
    ) {
      return unsupportedObservationEvent(eventPath, diagnostics);
    }
    lines.push(
      `Sound patterns (${distinct} distinct): ${described.join("; ")}${omitted ? `; ${omitted} additional patterns omitted` : ""}.`,
    );
  }

  const condition = recordField(data, "condition");
  if (condition) {
    diagnoseSourceOnlyFields(
      condition,
      new Set(["changes", "latest", "minimumHealth"]),
      `${eventPath}.data.condition`,
      diagnostics,
    );
    const latest = recordField(condition, "latest");
    diagnoseSourceOnlyFields(
      latest,
      new Set(["health", "food", "oxygen"]),
      `${eventPath}.data.condition.latest`,
      diagnostics,
    );
    const changes = integerField(condition, "changes");
    const health = numberField(latest, "health");
    const food = numberField(latest, "food");
    const minimumHealth = numberField(condition, "minimumHealth");
    if (changes === null || changes < 1 || health === null || food === null || minimumHealth === null) {
      return unsupportedObservationEvent(eventPath, diagnostics);
    }
    const oxygen = latest?.oxygen;
    if (oxygen !== null && !(typeof oxygen === "number" && Number.isFinite(oxygen))) {
      return unsupportedObservationEvent(eventPath, diagnostics);
    }
    lines.push(
      `Condition changed ${changes} times; latest health ${health}, food ${food}${oxygen === null ? "" : `, oxygen ${oxygen}`}; minimum health ${minimumHealth}.`,
    );
  }

  const entities = recordField(data, "entities");
  if (entities) {
    diagnoseSourceOnlyFields(
      entities,
      new Set(["entries", "distinctEntities", "omittedDistinctEntities"]),
      `${eventPath}.data.entities`,
      diagnostics,
    );
    const entries = arrayField(entities, "entries");
    const described: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = recordValue(entries[index]);
      const entryPath = `${eventPath}.data.entities.entries[${index}]`;
      diagnoseSourceOnlyFields(
        entry,
        new Set([
          "id",
          "name",
          "kind",
          "becameVisible",
          "leftView",
          "hurt",
          "latestRelation",
        ]),
        entryPath,
        diagnostics,
        new Set(["id"]),
      );
      const relation = recordField(entry, "latestRelation");
      diagnoseSourceOnlyFields(
        relation,
        new Set([
          "proximity",
          "relativeDirection",
          "lastSeenDistance",
          "observationPhase",
          "transition",
        ]),
        `${entryPath}.latestRelation`,
        diagnostics,
        new Set(["lastSeenDistance", "observationPhase"]),
      );
      const name = stringField(entry, "name")?.trim();
      const kind = stringField(entry, "kind")?.trim();
      const becameVisible = integerField(entry, "becameVisible");
      const leftView = integerField(entry, "leftView");
      const hurt = integerField(entry, "hurt");
      const transition = stringField(relation, "transition")?.trim();
      if (
        (!name && !kind) || becameVisible === null || becameVisible < 0 ||
        leftView === null || leftView < 0 || hurt === null || hurt < 0 || !transition
      ) {
        return unsupportedObservationEvent(eventPath, diagnostics);
      }
      const relationParts = [
        stringField(relation, "proximity")?.trim(),
        stringField(relation, "relativeDirection")?.trim(),
        humanize(transition),
      ].filter((item): item is string => Boolean(item));
      described.push(
        `${name ?? humanize(kind ?? "entity")} (${kind ?? "entity"}; visible +${becameVisible}/-${leftView}; hurt ${hurt}; latest ${relationParts.join(", ")})`,
      );
    }
    const distinct = integerField(entities, "distinctEntities");
    const omitted = integerField(entities, "omittedDistinctEntities");
    if (
      entries.length === 0 || distinct === null || distinct < entries.length ||
      omitted === null || omitted < 0 || distinct !== entries.length + omitted
    ) {
      return unsupportedObservationEvent(eventPath, diagnostics);
    }
    lines.push(
      `Entity changes (${distinct} distinct): ${described.join("; ")}${omitted ? `; ${omitted} additional entities omitted` : ""}.`,
    );
  }
  return lines;
}

function presentSoundHeard(
  data: Record<string, unknown> | null,
  eventPath: string,
  diagnostics: LyncPresentationDiagnostic[],
): string[] {
  diagnoseSourceOnlyFields(
    data,
    new Set(["sound", "distanceBand", "relativeDirection", "volume", "pitch"]),
    `${eventPath}.data`,
    diagnostics,
    new Set(["volume", "pitch"]),
  );
  const sound = stringField(data, "sound")?.trim();
  const distanceBand = stringField(data, "distanceBand")?.trim();
  const relativeDirection = stringField(data, "relativeDirection")?.trim();
  if (!sound || !distanceBand || !relativeDirection) {
    return unsupportedObservationEvent(eventPath, diagnostics);
  }
  return [
    `Heard ${sound} (${distanceBand}, ${relativeDirection}).`,
  ];
}

function diagnoseObservationEventEnvelope(
  event: Record<string, unknown> | null,
  eventPath: string,
  diagnostics: LyncPresentationDiagnostic[],
): void {
  diagnoseSourceOnlyFields(
    event,
    new Set(["sequence", "type", "salience", "source", "isNew", "data"]),
    eventPath,
    diagnostics,
  );
}

function presentSoundSequence(
  data: Record<string, unknown> | null,
  eventPath: string,
  diagnostics: LyncPresentationDiagnostic[],
): string[] {
  diagnoseSourceOnlyFields(
    data,
    new Set([
      "compaction",
      "fromSequence",
      "throughSequence",
      "omittedIndividualEvents",
      "occurrences",
    ]),
    `${eventPath}.data`,
    diagnostics,
  );
  if (stringField(data, "compaction") !== "behold.sound-sequence.v1") {
    return unsupportedObservationEvent(eventPath, diagnostics);
  }
  const occurrences = arrayField(data, "occurrences");
  if (occurrences.length === 0) {
    return unsupportedObservationEvent(eventPath, diagnostics);
  }

  let total = 0;
  const descriptions: string[] = [];
  for (let index = 0; index < occurrences.length; index += 1) {
    const occurrence = recordValue(occurrences[index]);
    const occurrencePath = `${eventPath}.data.occurrences[${index}]`;
    diagnoseSourceOnlyFields(
      occurrence,
      new Set([
        "fromSequence",
        "throughSequence",
        "count",
        "firstAt",
        "lastAt",
        "salience",
        "data",
      ]),
      occurrencePath,
      diagnostics,
    );
    const count = integerField(occurrence, "count");
    const sound = recordField(occurrence, "data");
    diagnoseSourceOnlyFields(
      sound,
      new Set(["sound", "distanceBand", "relativeDirection", "volume", "pitch"]),
      `${occurrencePath}.data`,
      diagnostics,
      new Set(["volume", "pitch"]),
    );
    const name = stringField(sound, "sound")?.trim();
    const distanceBand = stringField(sound, "distanceBand")?.trim();
    const relativeDirection = stringField(sound, "relativeDirection")?.trim();
    if (
      count === null ||
      count < 1 ||
      !name ||
      !distanceBand ||
      !relativeDirection
    ) {
      return unsupportedObservationEvent(eventPath, diagnostics);
    }
    total += count;
    descriptions.push(
      `${count} × ${name} (${distanceBand}, ${relativeDirection})`,
    );
  }
  return [`Heard ${total} sounds: ${descriptions.join("; ")}.`];
}

function unsupportedObservationEvent(
  eventPath: string,
  diagnostics: LyncPresentationDiagnostic[],
): string[] {
  diagnostics.push({
    code: "unsupported_observation_event",
    sourcePath: eventPath,
  });
  return [];
}

function diagnoseSourceOnlyFields(
  value: Record<string, unknown> | null,
  allowed: Set<string>,
  sourcePath: string,
  diagnostics: LyncPresentationDiagnostic[],
  explicitlySourceOnly: Set<string> = new Set(),
  code = "source_only_observation_event_field",
): void {
  if (!value) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) || explicitlySourceOnly.has(key)) {
      diagnostics.push({
        code,
        sourcePath: `${sourcePath}.${key}`,
      });
    }
  }
}

function outcomeTerminal(ok: boolean | null, eventType: string): string {
  if (ok === true) return "succeeded";
  if (/reject/i.test(eventType)) return "was rejected";
  if (/cancel/i.test(eventType)) return "was cancelled";
  if (/provider.*fail|fail.*provider/i.test(eventType)) {
    return "ended with a provider failure";
  }
  return ok === false ? "failed" : "ended";
}

function sectionText(section: LyncPresentationSection): string {
  const label =
    section.role === "perception" ? "PERCEPTION" : section.role.toUpperCase();
  return `${label}\n${section.text}`;
}

function presentInventoryItem(value: unknown): string[] {
  if (typeof value === "string") return [humanize(value)];
  const item = recordValue(value);
  const name = stringField(item, "name") ?? stringField(item, "kind");
  if (!name) return [];
  const count = integerField(item, "count");
  return [`${humanize(name)}${count === null ? "" : ` ×${count}`}`];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function measure(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return `${rounded >= 0 ? "+" : ""}${rounded}`;
}

function recordField(
  value: Record<string, unknown> | null,
  field: string,
): Record<string, unknown> | null {
  return recordValue(value?.[field]);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  value: Record<string, unknown> | null,
  field: string,
): string | null {
  return typeof value?.[field] === "string" ? (value[field] as string) : null;
}

function integerField(
  value: Record<string, unknown> | null,
  field: string,
): number | null {
  const item = value?.[field];
  return Number.isSafeInteger(item) ? (item as number) : null;
}

function numberField(
  value: Record<string, unknown> | null,
  field: string,
): number | null {
  const item = value?.[field];
  return typeof item === "number" && Number.isFinite(item) ? item : null;
}

function arrayField(
  value: Record<string, unknown> | null,
  field: string,
): unknown[] {
  const item = value?.[field];
  return Array.isArray(item) ? item : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
