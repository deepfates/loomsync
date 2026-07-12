#!/usr/bin/env node
// Executes the ```ts examples in packages/*/README.md against the built
// packages, so the npm landing pages can never drift into lies.
//
// Each snippet runs as-written from inside its package directory: Node
// resolves the package's own name (and its workspace deps) through
// package.json self-reference, exactly like an installed consumer.
//
// Blocks marked fragment:true are illustrative partials (free variables like
// an existing `app` or `localStore`) and are skipped, listed loudly.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");

const PLAN = [
  { pkg: "core", blocks: [{ i: 0 }, { i: 1 }, { i: 2, fragment: "wraps an undefined localStore; needs a live relay" }] },
  { pkg: "cli", bash: true },
  { pkg: "server", blocks: [{ i: 0, daemon: "relay on" }, { i: 1, fragment: "embeds into an existing app server (free vars: app, checkSession)" }] },
  { pkg: "index", blocks: [{ i: 0 }] },
  { pkg: "client", blocks: [{ i: 0 }] },
];

function tsBlocks(markdown) {
  const blocks = [];
  const re = /```ts\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(markdown)) !== null) blocks.push(m[1]);
  return blocks;
}

function bashBlocks(markdown) {
  const blocks = [];
  const re = /```bash\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(markdown)) !== null) blocks.push(m[1]);
  return blocks;
}

let failures = 0;
const scratchRoots = [];

function runSnippet(pkg, index, code, daemonMatch) {
  const pkgDir = join(root, "packages", pkg);
  const scriptPath = join(pkgDir, `.readme-smoke-${index}.tmp.mjs`);
  const scratch = mkdtempSync(join(tmpdir(), "lync-readme-smoke-"));
  scratchRoots.push(scratch);
  // Run with cwd in a scratch dir so relative paths ("./rooms") never touch
  // the repo; module resolution follows the script's location, not cwd.
  writeFileSync(scriptPath, code);
  try {
    if (!daemonMatch) {
      execFileSync(process.execPath, [scriptPath], { cwd: scratch, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
      console.log(`ok   ${pkg} README block ${index}`);
      return Promise.resolve();
    }
    // Long-running example: pass = expected line appears, then we kill it.
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [scriptPath], { cwd: scratch });
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        console.error(`FAIL ${pkg} README block ${index}: never printed ${JSON.stringify(daemonMatch)}\n${out}`);
        failures += 1;
        resolve();
      }, 15_000);
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
        if (out.includes(daemonMatch)) {
          clearTimeout(timer);
          child.kill("SIGTERM");
          console.log(`ok   ${pkg} README block ${index} (daemon: saw ${JSON.stringify(daemonMatch)})`);
          resolve();
        }
      });
      child.on("exit", () => {
        rmSync(scriptPath, { force: true });
      });
    }).finally(() => rmSync(scriptPath, { force: true }));
  } catch (error) {
    console.error(`FAIL ${pkg} README block ${index}:\n${error.stderr ?? error.message}`);
    failures += 1;
    return Promise.resolve();
  } finally {
    if (!daemonMatch) rmSync(scriptPath, { force: true });
  }
}

function runCliBlock(pkg, index, code) {
  const scratch = mkdtempSync(join(tmpdir(), "lync-readme-smoke-cli-"));
  scratchRoots.push(scratch);
  const bin = join(root, "packages", "cli", "bin", "lync.js");
  const lines = code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("npm install"));
  for (const line of lines) {
    // serve/sync need a live relay pair; covered by the sync test suite.
    if (line.startsWith("lync serve") || line.startsWith("lync sync")) {
      console.log(`skip ${pkg} README block ${index} line (needs live relay): ${line}`);
      continue;
    }
    if (line.startsWith("lync merge")) {
      // The example merges with an `other.lync` the reader is presumed to
      // have; give it one so the command runs as written.
      execFileSync("node", [bin, "init", "other.lync"], { cwd: scratch });
    }
    // Only rewrite `lync` as a command token (line start or after a pipe),
    // never the substring inside filenames like story.lync.
    const cmd = line.replace(/(^|\| )lync /g, `$1node ${bin} `);
    try {
      execFileSync("bash", ["-c", cmd], { cwd: scratch, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    } catch (error) {
      console.error(`FAIL ${pkg} README block ${index} line: ${line}\n${error.stderr}`);
      failures += 1;
      return;
    }
  }
  console.log(`ok   ${pkg} README block ${index} (cli story)`);
}

for (const entry of PLAN) {
  const markdown = readFileSync(join(root, "packages", entry.pkg, "README.md"), "utf8");
  if (entry.bash) {
    bashBlocks(markdown).forEach((code, i) => runCliBlock(entry.pkg, i, code));
    continue;
  }
  const blocks = tsBlocks(markdown);
  const planned = entry.blocks ?? [];
  const extras = blocks.length - planned.length;
  if (extras !== 0) {
    console.error(`FAIL ${entry.pkg}: README has ${blocks.length} ts blocks but the plan covers ${planned.length} — update scripts/readme-examples-smoke.mjs`);
    failures += 1;
  }
  for (const spec of planned) {
    const code = blocks[spec.i];
    if (code === undefined) continue;
    if (spec.fragment) {
      console.log(`skip ${entry.pkg} README block ${spec.i} (fragment: ${spec.fragment})`);
      continue;
    }
    await runSnippet(entry.pkg, spec.i, code, spec.daemon);
  }
}

for (const scratch of scratchRoots) rmSync(scratch, { recursive: true, force: true });

if (failures > 0) {
  console.error(`readme-examples-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log("readme-examples-smoke passed");
