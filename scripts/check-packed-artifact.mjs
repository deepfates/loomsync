import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const temporary = mkdtempSync(join(tmpdir(), "lync-packed-artifact-"));
const packed = join(temporary, "packed");
const extracted = join(temporary, "extracted");

try {
  mkdirSync(packed, { recursive: true });
  mkdirSync(extracted, { recursive: true });
  execFileSync("pnpm", ["pack", "--pack-destination", packed], {
    stdio: "pipe",
  });
  const archives = readdirSync(packed).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`expected one packed archive, found ${archives.length}`);
  }
  const archive = join(packed, archives[0]);
  execFileSync("tar", ["-xzf", archive, "-C", extracted]);

  const packageRoot = join(extracted, "package");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const presentation = await import(
    `${pathToFileURL(join(packageRoot, "dist", "presentation.js")).href}?packed=1`
  );

  if (manifest.version !== "0.4.1") {
    throw new Error(`expected packed version 0.4.1, received ${manifest.version}`);
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

  console.log(`packed artifact ok ${archives[0]} ${manifest.version}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
