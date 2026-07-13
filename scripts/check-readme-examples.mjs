#!/usr/bin/env node
// Executes every fenced example in packages/*/README.md against the built
// packages. The package READMEs are the npm landing pages; their examples
// are contract, not illustration — this check fails `pnpm verify` (and CI)
// when one stops running.
//
// The contract lives in the READMEs themselves. A fenced ```ts or ```bash
// block runs as-written unless an HTML comment directly above it declares
// otherwise:
//
//   <!-- example: fragment — reason it cannot run alone -->
//   <!-- example: daemon — expect "line that proves startup" -->
//
// There is no other configuration: a new example is checked by default.
//
// ts blocks execute from inside their package directory — Node's package
// self-reference resolves the package's own name and its workspace deps
// exactly like an installed consumer — with cwd in a scratch dir so relative
// paths never touch the repo. bash blocks run with the `lync` command token
// rewritten to the workspace bin; `npm install` lines are skipped (noted),
// since installing is the reader's step, not the example's.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const packagesDir = join(root, "packages");

const BLOCK_RE = /(?:<!--\s*example:\s*([^>]*?)\s*-->\s*\n)?```(ts|bash)\n([\s\S]*?)```/g;

function parseDirective(text) {
  if (!text) return { mode: "run" };
  if (text.startsWith("fragment")) return { mode: "fragment", reason: text };
  if (text.startsWith("daemon")) {
    const expect = text.match(/expect "([^"]+)"/);
    if (!expect) throw new Error(`daemon directive without an expect string: ${text}`);
    return { mode: "daemon", expect: expect[1] };
  }
  throw new Error(`unknown example directive: ${text}`);
}

let failures = 0;
const scratchRoots = [];

function scratchDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `lync-readme-${label}-`));
  scratchRoots.push(dir);
  return dir;
}

function runTs(pkg, index, code, directive) {
  const scriptPath = join(packagesDir, pkg, `.readme-example-${index}.tmp.mjs`);
  writeFileSync(scriptPath, code);
  const cwd = scratchDir(pkg);
  try {
    if (directive.mode !== "daemon") {
      execFileSync(process.execPath, [scriptPath], { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
      console.log(`ok   ${pkg} ts example ${index}`);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [scriptPath], { cwd });
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        console.error(`FAIL ${pkg} ts example ${index}: never printed ${JSON.stringify(directive.expect)}\n${out}`);
        failures += 1;
        resolve();
      }, 15_000);
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
        if (out.includes(directive.expect)) {
          clearTimeout(timer);
          child.kill("SIGTERM");
          console.log(`ok   ${pkg} ts example ${index} (daemon: saw ${JSON.stringify(directive.expect)})`);
          resolve();
        }
      });
    }).finally(() => rmSync(scriptPath, { force: true }));
  } catch (error) {
    console.error(`FAIL ${pkg} ts example ${index}:\n${error.stderr ?? error.message}`);
    failures += 1;
    return Promise.resolve();
  } finally {
    if (directive.mode !== "daemon") rmSync(scriptPath, { force: true });
  }
}

function runBash(pkg, index, code) {
  const cwd = scratchDir(`${pkg}-bash`);
  const bin = join(packagesDir, "cli", "bin", "lync.js");
  const lines = code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  let ran = 0;
  for (const line of lines) {
    if (line.startsWith("npm install")) {
      console.log(`note ${pkg} bash example ${index}: install line left to the reader: ${line}`);
      continue;
    }
    const cmd = line.replace(/(^|\| )lync /g, `$1node ${bin} `);
    try {
      execFileSync("bash", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
      ran += 1;
    } catch (error) {
      console.error(`FAIL ${pkg} bash example ${index} line: ${line}\n${error.stderr}`);
      failures += 1;
      return;
    }
  }
  console.log(`ok   ${pkg} bash example ${index} (${ran} command${ran === 1 ? "" : "s"})`);
}

const packages = readdirSync(packagesDir).sort();
for (const pkg of packages) {
  let markdown;
  try {
    markdown = readFileSync(join(packagesDir, pkg, "README.md"), "utf8");
  } catch {
    console.error(`FAIL ${pkg}: no README.md — every published package needs a landing page`);
    failures += 1;
    continue;
  }
  let index = 0;
  let match;
  BLOCK_RE.lastIndex = 0;
  while ((match = BLOCK_RE.exec(markdown)) !== null) {
    const [, directiveText, lang, code] = match;
    const directive = parseDirective(directiveText);
    if (directive.mode === "fragment") {
      console.log(`skip ${pkg} ${lang} example ${index} (${directive.reason})`);
      index += 1;
      continue;
    }
    if (lang === "ts") await runTs(pkg, index, code, directive);
    else runBash(pkg, index, code);
    index += 1;
  }
  if (index === 0) {
    console.error(`FAIL ${pkg}: README has no fenced examples — a landing page shows the thing working`);
    failures += 1;
  }
}

for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`check-readme-examples: ${failures} failure(s)`);
  process.exit(1);
}
console.log("check-readme-examples passed");
