import { loreDownset, type LoreEventBody, type LoreLineDiagnostic, type LoreObstacle, type LoreParseResult } from "./events.js";

export interface LoreViewEvent {
  id: string;
  event: LoreEventBody;
  line: LoreLineDiagnostic;
  payloadSuppressed: boolean;
}

export interface LoreBranchTreeNode extends LoreViewEvent {
  parents: string[];
  children: string[];
  missingParents: string[];
  conflictedParents: string[];
}

export interface LoreBranchTreeView {
  nodes: LoreBranchTreeNode[];
  roots: string[];
  leaves: string[];
  obstacles: LoreObstacle[];
  partial: boolean;
}

export interface LoreTranscriptEntry extends LoreViewEvent {
  depth: number;
}

export interface LoreTranscriptView {
  head: string;
  entries: LoreTranscriptEntry[];
  downsetIds: string[];
  obstacles: LoreObstacle[];
  partial: boolean;
}

export interface LoreMemoryView {
  events: LoreViewEvent[];
  frontierIds: string[];
  suppressedPayloadIds: string[];
  conflictIds: string[];
  obstacles: LoreObstacle[];
  partial: boolean;
}

export interface LoreScoreReference {
  annotationId: string;
  value: number;
  author: LoreEventBody["author"];
  at: string;
  basis?: unknown;
}

export interface LoreSelectionReference {
  annotationId: string;
  selected: boolean;
  author: LoreEventBody["author"];
  at: string;
  basis?: unknown;
}

export interface LoreLeaderboardEntry {
  targetId: string;
  event?: LoreViewEvent;
  scoreTotal: number;
  scoreCount: number;
  scoreMean: number | null;
  selectedCount: number;
  selectionCount: number;
  scores: LoreScoreReference[];
  selections: LoreSelectionReference[];
  rank: number;
}

export interface LoreLeaderboardView {
  entries: LoreLeaderboardEntry[];
  ignoredAnnotationIds: string[];
}

export interface LoreTranscriptOptions {
  chooseParent?: (event: LoreEventBody, candidates: string[]) => string | undefined;
}

export function loreBranchTreeView(result: LoreParseResult): LoreBranchTreeView {
  const index = eligibleEventIndex(result);
  const children = new Map<string, string[]>();
  const parentRefs = new Set<string>();
  const conflictIds = new Set(result.conflictIds);

  for (const id of index.ids) children.set(id, []);
  for (const viewEvent of index.events.values()) {
    for (const parent of viewEvent.event.parents) {
      parentRefs.add(parent);
      const siblings = children.get(parent);
      if (siblings) siblings.push(viewEvent.id);
    }
  }

  for (const siblings of children.values()) siblings.sort(compareIds);

  const nodes = index.ids.map((id) => {
    const viewEvent = index.events.get(id)!;
    return {
      ...viewEvent,
      parents: [...viewEvent.event.parents],
      children: children.get(id) ?? [],
      missingParents: viewEvent.event.parents.filter((parent) => !index.events.has(parent) && !conflictIds.has(parent)).sort(compareIds),
      conflictedParents: viewEvent.event.parents.filter((parent) => conflictIds.has(parent)).sort(compareIds),
    };
  });

  return {
    nodes,
    roots: index.ids.filter((id) => index.events.get(id)!.event.parents.length === 0).sort(compareIds),
    leaves: index.ids.filter((id) => (children.get(id)?.length ?? 0) === 0).sort(compareIds),
    obstacles: result.graphDiagnostics,
    partial: result.graphDiagnostics.length > 0 || [...parentRefs].some((id) => !index.events.has(id)),
  };
}

export function loreTranscriptView(
  result: LoreParseResult,
  head: string,
  options: LoreTranscriptOptions = {},
): LoreTranscriptView {
  const index = eligibleEventIndex(result);
  const downset = loreDownset(result, head);
  const path: LoreViewEvent[] = [];
  const seen = new Set<string>();
  let current: string | undefined = head;

  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const viewEvent = index.events.get(current);
    if (!viewEvent) break;
    path.push(viewEvent);
    const candidates = viewEvent.event.parents.filter((parent) => index.events.has(parent));
    current = options.chooseParent?.(viewEvent.event, candidates) ?? candidates[0];
  }

  const entries = path
    .reverse()
    .map((viewEvent, depth) => ({ ...viewEvent, depth }));

  return {
    head,
    entries,
    downsetIds: downset.ids,
    obstacles: downset.obstacles,
    partial: downset.partial || !index.events.has(head),
  };
}

export function loreMemoryView(result: LoreParseResult): LoreMemoryView {
  const tree = loreBranchTreeView(result);
  const index = eligibleEventIndex(result);

  return {
    events: index.ids.map((id) => index.events.get(id)!),
    frontierIds: tree.leaves,
    suppressedPayloadIds: [...result.suppression.suppressedPayloadIds],
    conflictIds: [...result.conflictIds],
    obstacles: tree.obstacles,
    partial: tree.partial,
  };
}

export function loreLeaderboardView(result: LoreParseResult): LoreLeaderboardView {
  const index = eligibleEventIndex(result);
  const entries = new Map<string, Omit<LoreLeaderboardEntry, "rank">>();
  const ignoredAnnotationIds: string[] = [];

  const ensure = (targetId: string) => {
    let entry = entries.get(targetId);
    if (!entry) {
      entry = {
        targetId,
        event: index.events.get(targetId),
        scoreTotal: 0,
        scoreCount: 0,
        scoreMean: null,
        selectedCount: 0,
        selectionCount: 0,
        scores: [],
        selections: [],
      };
      entries.set(targetId, entry);
    }
    return entry;
  };

  for (const viewEvent of index.events.values()) {
    const event = viewEvent.event;
    if (event.kind !== "lore/annotation" || viewEvent.payloadSuppressed) continue;
    const label = event.payload["label"];
    if (label === "score") {
      const value = numericScore(event.payload);
      if (value === undefined) {
        ignoredAnnotationIds.push(event.id);
        continue;
      }
      for (const targetId of event.parents) {
        const entry = ensure(targetId);
        entry.scoreTotal += value;
        entry.scoreCount += 1;
        entry.scoreMean = entry.scoreTotal / entry.scoreCount;
        entry.scores.push({ annotationId: event.id, value, author: event.author, at: event.at, basis: event.payload["basis"] });
      }
    } else if (label === "selection") {
      const chosen = stringSet(event.payload["chosen"]);
      const shown = stringSet(event.payload["shown"]);
      const targets = shown.size > 0 ? shown : new Set(event.parents);
      if (chosen.size === 0 || targets.size === 0) {
        ignoredAnnotationIds.push(event.id);
        continue;
      }
      for (const targetId of targets) {
        const selected = chosen.has(targetId);
        const entry = ensure(targetId);
        entry.selectionCount += 1;
        if (selected) entry.selectedCount += 1;
        entry.selections.push({ annotationId: event.id, selected, author: event.author, at: event.at, basis: event.payload["basis"] });
      }
    }
  }

  const ranked = [...entries.values()].sort(compareLeaderboardEntries);
  return {
    entries: ranked.map((entry, index) => ({ ...entry, rank: index + 1 })),
    ignoredAnnotationIds: ignoredAnnotationIds.sort(compareIds),
  };
}

function eligibleEventIndex(result: LoreParseResult) {
  const eligibleIds = new Set(result.viewEligibleIds);
  const suppressedPayloadIds = new Set(result.suppression.suppressedPayloadIds);
  const events = new Map<string, LoreViewEvent>();

  for (const line of result.lines) {
    if (!line.id || !line.event || !eligibleIds.has(line.id) || events.has(line.id)) continue;
    events.set(line.id, {
      id: line.id,
      event: line.event,
      line,
      payloadSuppressed: suppressedPayloadIds.has(line.id),
    });
  }

  return { events, ids: [...events.keys()].sort(compareIds) };
}

function numericScore(payload: Record<string, unknown>): number | undefined {
  for (const key of ["value", "score"]) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === "string"));
}

function compareLeaderboardEntries(
  a: Omit<LoreLeaderboardEntry, "rank">,
  b: Omit<LoreLeaderboardEntry, "rank">,
): number {
  return (
    b.selectedCount - a.selectedCount ||
    (b.scoreMean ?? Number.NEGATIVE_INFINITY) - (a.scoreMean ?? Number.NEGATIVE_INFINITY) ||
    b.scoreTotal - a.scoreTotal ||
    compareIds(a.targetId, b.targetId)
  );
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
