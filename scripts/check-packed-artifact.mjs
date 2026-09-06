import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const temporary = mkdtempSync(join(tmpdir(), "lync-packed-artifact-"));
const packed = join(temporary, "packed");
const extracted = join(temporary, "extracted");
const suppliedArchive = process.argv[2];

try {
  mkdirSync(packed, { recursive: true });
  mkdirSync(extracted, { recursive: true });
  let archive;
  let archiveName;
  if (suppliedArchive) {
    archive = resolve(suppliedArchive);
    archiveName = basename(archive);
  } else {
    execFileSync("pnpm", ["pack", "--pack-destination", packed], {
      stdio: "pipe",
    });
    const archives = readdirSync(packed).filter((name) => name.endsWith(".tgz"));
    if (archives.length !== 1) {
      throw new Error(`expected one packed archive, found ${archives.length}`);
    }
    archiveName = archives[0];
    archive = join(packed, archiveName);
  }
  execFileSync("tar", ["-xzf", archive, "-C", extracted]);

  const packageRoot = join(extracted, "package");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const presentation = await import(
    `${pathToFileURL(join(packageRoot, "dist", "presentation.js")).href}?packed=1`
  );

  if (manifest.version !== "0.4.3") {
    throw new Error(`expected packed version 0.4.3, received ${manifest.version}`);
  }
  if (presentation.BEHOLD_INHABITANT_PROFILE_V2 !== "org.behold.inhabitant.v2") {
    throw new Error("packed presentation module does not export the Behold v2 profile");
  }

  const root = {
    v: 1,
    id: "019fbe00-0000-7000-8000-000000000099",
    kind: "lync/loom",
    at: "2026-08-01T00:00:00.000Z",
    author: { actor: "artifact-check", via: "lync-package-check" },
    parents: [],
    payload: {
      meta: {
        protocol: "behold.entity-loom.v1",
        profile: "org.behold.inhabitant.v2",
        entityId: "ArtifactResident",
        circleId: "artifact-circle",
      },
    },
  };
  const result = presentation.presentLyncEvent(root, {
    loomProfile: presentation.BEHOLD_INHABITANT_PROFILE_V2,
  });
  if (
    result.status !== "presented" ||
    result.presentation.contract !== "org.behold.presentation.inhabitant-turn.v2" ||
    !result.presentation.text.includes("Behold resident life: ArtifactResident")
  ) {
    throw new Error("packed Behold v2 presenter did not execute its exact contract");
  }

  const observation = (events) => ({
    protocol: "behold.minecraft-human-semantic-observation.v1",
    bodyContract: { profile: "minecraft-human-semantic-v1" },
    self: { condition: { health: 20, food: 20 }, inventory: [] },
    scene: { social: { playersOnline: [] }, entities: [], terrain: {} },
    events,
  });
  const turn = {
    v: 1,
    id: "019fbe00-0001-7000-8000-000000000099",
    kind: "lync/turn",
    at: "2026-08-01T00:00:01.000Z",
    author: { actor: "ArtifactResident", via: "lync-package-check" },
    parents: [root.id],
    payload: {
      meta: {
        protocol: "behold.entity-turn-link.v1",
        entityId: "ArtifactResident",
        sequence: 1,
      },
      payload: {
        protocol: "behold.entity-turn.v1",
        entityId: "ArtifactResident",
        sequence: 1,
        model: "artifact-check",
        profiles: {
          policy: "resident-v1",
          body: "minecraft-human-semantic-v1",
          actions: "minecraft-human-semantic-v1",
          safety: "vanilla-player-v1",
        },
        observation: observation([]),
        utterance: { assistant: { content: null } },
        action: {
          name: "dig_focused_block",
          input: {},
          source: "llm",
          kind: "exclusive",
        },
        outcome: {
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
                position: { x: 1977, y: -47, z: 1419 },
              },
            }],
          },
        },
        nextObservation: observation([{
          sequence: 2,
          type: "visible_block_changed",
          salience: "normal",
          source: "vision",
          isNew: true,
          data: { before: "mud_bricks", after: "air" },
        }]),
      },
    },
  };
  const material = presentation.presentLyncEvent(turn, {
    loomProfile: presentation.BEHOLD_INHABITANT_PROFILE_V2,
  });
  if (
    material.status !== "presented" ||
    !material.presentation.text.includes(
      "Change evidence: dig mud bricks → air; verified yes; observed yes; confirmation mineflayer:blockUpdate.",
    ) ||
    !material.presentation.text.includes("Visible block changed: mud bricks → air.") ||
    material.presentation.text.includes("1977")
  ) {
    throw new Error("packed Behold v2 material projection is missing or leaked coordinates");
  }

  console.log(`packed artifact ok ${archiveName} ${manifest.version}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
