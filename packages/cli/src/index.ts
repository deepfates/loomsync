import { randomUUID } from "node:crypto";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import {
  parseLyncFiles,
  type LyncLineClass,
  type LyncLineDiagnostic,
} from "lync-core/events";
import { lyncBranchTreeView as coreTreeView, lyncTranscriptView as coreTranscriptView } from "lync-core/views";

export interface LyncCliIO {
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  stdin?: NodeJS.ReadStream;
  now?: () => Date;
  randomId?: () => string;
}

type ExitCode = 0 | 1 | 2;

const classes: LyncLineClass[] = ["accepted", "nonconforming", "garbage", "damaged", "conflict-variant"];
const textEncoder = new TextEncoder();

export async function runLyncCli(argv: string[], io: LyncCliIO = {}): Promise<ExitCode> {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const [verb, ...rest] = argv;

  try {
    if (!verb || verb === "-h" || verb === "--help") {
      out.write(helpText());
      return 0;
    }

    switch (verb) {
      case "verify":
        return await verify(rest, out, err);
      case "merge":
        return await merge(rest, out, err);
      case "view":
        return await view(rest, out, err);
      case "init":
        return await init(rest, err);
      case "append":
        return await append(rest, io, out, err);
      case "serve":
        return await serveVerb(rest, out, err);
      case "sync":
        return await syncVerb(rest, out, err);
      default:
        err.write(`Unknown command '${verb}'. Run 'lync --help'.\n`);
        return 2;
    }
  } catch (error) {
    err.write(`${messageOf(error)}\n`);
    return 2;
  }
}

function helpText(): string {
  return [
    "Usage: lync <command> [args]",
    "",
    "Commands:",
    "  verify <files>                 classify lync file lines and print counts",
    "  merge <files> -o <out>          write a deterministic carried union",
    "  view <file> [--as transcript|tree]",
    "  init [file]                     create an empty valid lync file",
    "  append <file>                   read JSON from stdin and append one event",
    "  serve [dir] [--port N] [--token T]   run the line-sync relay over a directory of roots",
    "  sync <file> <url> [--root R] [--follow]   converge a file with a relay; --follow stays live",
    "",
    "verify exits 0 only when every line is accepted. It exits 1 for nonconforming, garbage, damaged, conflict, pending, or graph issues, and 2 for usage or I/O errors.",
    "",
  ].join("\n");
}

async function verify(
  args: string[],
  out: Pick<NodeJS.WriteStream, "write">,
  err: Pick<NodeJS.WriteStream, "write">,
): Promise<ExitCode> {
  if (args.length === 0) {
    err.write("Usage: lync verify <files>\n");
    return 2;
  }

  const result = parseLyncFiles(await readInputs(args));
  const totals = zeroCounts();
  const byFile = new Map<string, Record<LyncLineClass, number>>();
  for (const line of result.lines) {
    const counts = byFile.get(line.file) ?? zeroCounts();
    counts[line.class]++;
    totals[line.class]++;
    byFile.set(line.file, counts);
  }

  for (const file of args) out.write(`${file} ${formatCounts(byFile.get(file) ?? zeroCounts())}\n`);
  out.write(`total ${formatCounts(totals)}\n`);

  for (const line of result.lines) {
    if (line.class === "accepted") continue;
    out.write(`${line.file}:${line.line} ${line.class}: ${line.reason}\n`);
  }
  for (const pending of result.pending) {
    out.write(`${pending.file}:${pending.line} pending: missing parent ${pending.missingParent}\n`);
  }
  for (const obstacle of result.graphDiagnostics) {
    out.write(`graph ${JSON.stringify(obstacle)}\n`);
  }

  return hasVerifyIssues(result.lines, result.pending.length, result.graphDiagnostics.length) ? 1 : 0;
}

async function merge(
  args: string[],
  _out: Pick<NodeJS.WriteStream, "write">,
  err: Pick<NodeJS.WriteStream, "write">,
): Promise<ExitCode> {
  const outIndex = args.indexOf("-o");
  if (outIndex < 0 || outIndex === args.length - 1) {
    err.write("Usage: lync merge <files> -o <out>\n");
    return 2;
  }
  const output = args[outIndex + 1]!;
  const files = args.filter((_, index) => index !== outIndex && index !== outIndex + 1);
  if (files.length === 0) {
    err.write("Usage: lync merge <files> -o <out>\n");
    return 2;
  }

  const result = parseLyncFiles(await readInputs(files));
  await writeFile(output, mergeBytes(result.lines, new Set(result.unionEventIds)));
  return 0;
}

async function view(
  args: string[],
  out: Pick<NodeJS.WriteStream, "write">,
  err: Pick<NodeJS.WriteStream, "write">,
): Promise<ExitCode> {
  const asIndex = args.indexOf("--as");
  const as = asIndex >= 0 ? args[asIndex + 1] : "transcript";
  const files = asIndex >= 0
    ? args.filter((_, index) => index !== asIndex && index !== asIndex + 1)
    : args;
  if (files.length !== 1 || (as !== "transcript" && as !== "tree")) {
    err.write("Usage: lync view <file> --as transcript|tree\n");
    return 2;
  }

  const result = parseLyncFiles(await readInputs(files));
  if (as === "tree") {
    out.write(`${JSON.stringify(printableTreeView(coreTreeView(result)), null, 2)}\n`);
    return result.graphDiagnostics.length || result.conflictIds.length ? 1 : 0;
  }

  const tree = coreTreeView(result);
  const head = tree.leaves[tree.leaves.length - 1] ?? "";
  const transcript = head
    ? coreTranscriptView(result, head)
    : { head: "", entries: [], downsetIds: [], obstacles: [], partial: false };
  out.write(`${JSON.stringify(printableTranscriptView(transcript), null, 2)}\n`);
  return transcript.partial || result.conflictIds.length ? 1 : 0;
}

async function init(args: string[], err: Pick<NodeJS.WriteStream, "write">): Promise<ExitCode> {
  if (args.length > 1) {
    err.write("Usage: lync init [file]\n");
    return 2;
  }
  if (args[0]) await writeFile(args[0], new Uint8Array());
  return 0;
}

async function append(
  args: string[],
  io: LyncCliIO,
  out: Pick<NodeJS.WriteStream, "write">,
  err: Pick<NodeJS.WriteStream, "write">,
): Promise<ExitCode> {
  if (args.length !== 1) {
    err.write("Usage: lync append <file>\n");
    return 2;
  }

  let value: unknown;
  try {
    value = JSON.parse(await readAllStdin(io.stdin ?? process.stdin));
  } catch {
    err.write("stdin must be a JSON object, for example: {\"kind\":\"note/text\",\"author\":{\"actor\":\"you\"},\"payload\":{\"text\":\"hello\"}}\n");
    return 1;
  }

  const built = buildAppendEvent(value, io);
  if (!built.ok) {
    err.write(`${built.reason}\n`);
    return 1;
  }

  const line = `${JSON.stringify(built.event)}\n`;
  const parsed = parseLyncFiles([{ file: args[0], bytes: line }]).lines[0];
  if (parsed?.class !== "accepted") {
    err.write(`That JSON is not a valid event: ${parsed?.reason ?? "unknown validation failure"}.\n`);
    return 1;
  }

  await appendLine(args[0]!, line);
  out.write(`${built.event.id}\n`);
  return 0;
}

function buildAppendEvent(value: unknown, io: LyncCliIO):
  | { ok: true; event: Record<string, unknown> }
  | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "stdin must be a JSON object." };
  if ("v" in value && value.v !== 1) return { ok: false, reason: "v must be 1 when provided." };
  if ("id" in value && typeof value.id !== "string") return { ok: false, reason: "id must be a string when provided." };
  if (typeof value.kind !== "string") return { ok: false, reason: "kind is required and must be a string like 'notes/text'." };
  if (!value.kind.includes("/") || value.kind.startsWith("/") || value.kind.endsWith("/")) {
    return { ok: false, reason: "kind must include a namespace and name, for example 'notes/text'." };
  }
  if (!isRecord(value.author)) return { ok: false, reason: "author is required and must be an object with actor." };
  if (typeof value.author.actor !== "string" || value.author.actor.length === 0) {
    return { ok: false, reason: "author.actor is required and must be a non-empty string." };
  }
  if ("parents" in value && (!Array.isArray(value.parents) || !value.parents.every((parent) => typeof parent === "string"))) {
    return { ok: false, reason: "parents must be an array of strings when provided." };
  }
  if ("payload" in value && !isRecord(value.payload)) {
    return { ok: false, reason: "payload must be an object when provided." };
  }

  const event: Record<string, unknown> = {
    v: 1,
    id: typeof value.id === "string" ? value.id : (io.randomId?.() ?? randomUUID()),
    kind: value.kind,
    at: typeof value.at === "string" ? value.at : (io.now?.() ?? new Date()).toISOString(),
    author: value.author,
    parents: Array.isArray(value.parents) ? value.parents : [],
    payload: isRecord(value.payload) ? value.payload : {},
  };
  if ("marked" in value) event.marked = value.marked;
  if ("critical" in value) event.critical = value.critical;
  return { ok: true, event };
}

function mergeBytes(lines: LyncLineDiagnostic[], unionIds: Set<string>): Uint8Array {
  const eventChoices = new Map<string, LyncLineDiagnostic>();
  const carried: LyncLineDiagnostic[] = [];
  for (const line of lines) {
    if (line.id && unionIds.has(line.id) && (line.class === "accepted" || line.class === "nonconforming")) {
      const existing = eventChoices.get(line.id);
      if (!existing || richness(line) > richness(existing)) eventChoices.set(line.id, line);
      continue;
    }
    carried.push(line);
  }

  const ordered = [
    ...[...eventChoices.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, line]) => line),
    ...carried,
  ];
  return joinLines(ordered);
}

function joinLines(lines: LyncLineDiagnostic[]): Uint8Array {
  const chunks = lines.flatMap((line) => line.terminator ? [line.bytes, textEncoder.encode(line.terminator)] : [line.bytes]);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readInputs(files: string[]) {
  return Promise.all(files.map(async (file) => ({ file, bytes: await readFile(file) })));
}

function zeroCounts(): Record<LyncLineClass, number> {
  return { accepted: 0, nonconforming: 0, garbage: 0, damaged: 0, "conflict-variant": 0 };
}

function formatCounts(counts: Record<LyncLineClass, number>): string {
  return classes.map((kind) => `${kind}=${counts[kind]}`).join(" ");
}

function hasVerifyIssues(lines: LyncLineDiagnostic[], pending: number, obstacles: number): boolean {
  return pending > 0 || obstacles > 0 || lines.some((line) => line.class !== "accepted");
}

function richness(line: LyncLineDiagnostic): number {
  return (line.sig ? 2 : 0) + (line.digest ? 1 : 0);
}

function printableTranscriptView(view: ReturnType<typeof coreTranscriptView>) {
  return {
    head: view.head,
    entries: view.entries.map((entry) => ({
      id: entry.id,
      depth: entry.depth,
      kind: entry.event.kind,
      at: entry.event.at,
      author: entry.event.author,
      parents: entry.event.parents,
      payload: entry.payloadSuppressed ? undefined : entry.event.payload,
      payloadSuppressed: entry.payloadSuppressed,
    })),
    downsetIds: view.downsetIds,
    obstacles: view.obstacles,
    partial: view.partial,
  };
}

function printableTreeView(view: ReturnType<typeof coreTreeView>) {
  return {
    nodes: view.nodes.map((node) => ({
      id: node.id,
      kind: node.event.kind,
      at: node.event.at,
      author: node.event.author,
      parents: node.parents,
      children: node.children,
      missingParents: node.missingParents,
      conflictedParents: node.conflictedParents,
      payload: node.payloadSuppressed ? undefined : node.event.payload,
      payloadSuppressed: node.payloadSuppressed,
    })),
    roots: view.roots,
    leaves: view.leaves,
    obstacles: view.obstacles,
    partial: view.partial,
  };
}

async function appendLine(file: string, line: string): Promise<void> {
  let prefix = "";
  try {
    const info = await stat(file);
    if (info.size > 0) {
      const bytes = await readFile(file);
      if (bytes[bytes.byteLength - 1] !== 0x0a) prefix = "\n";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await appendFile(file, `${prefix}${line}`);
}

function readAllStdin(stdin: NodeJS.ReadStream): Promise<string> {
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("error", reject);
    stdin.on("end", () => resolve(data));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function serveVerb(
  args: string[],
  out: Pick<NodeJS.WriteStream, "write">,
  err: Pick<NodeJS.WriteStream, "write">,
): Promise<ExitCode> {
  const { startLyncServe } = await import("lync-server");
  const positional: string[] = [];
  let port: number | undefined;
  let token: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      port = Number(args[++index]);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        err.write("lync serve: --port must be an integer between 0 and 65535\n");
        return 2;
      }
    } else if (arg === "--token") {
      token = args[++index];
      if (!token) {
        err.write("lync serve: --token requires a value\n");
        return 2;
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) {
    err.write("Usage: lync serve [dir] [--port N] [--token T]\n");
    return 2;
  }
  const server = await startLyncServe({
    dir: positional[0] ?? ".",
    port,
    token,
    log: (message) => err.write(`${message}\n`),
  });
  out.write(`lync serve: listening on ws://localhost:${server.port} over ${positional[0] ?? "."}\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
  out.write("lync serve: closed\n");
  return 0;
}

async function syncVerb(
  args: string[],
  out: Pick<NodeJS.WriteStream, "write">,
  err: Pick<NodeJS.WriteStream, "write">,
): Promise<ExitCode> {
  const { syncOnce } = await import("./sync.js");
  const positional: string[] = [];
  let root: string | undefined;
  let follow = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") {
      root = args[++index];
      if (!root) {
        err.write("lync sync: --root requires a value\n");
        return 2;
      }
    } else if (arg === "--follow") {
      follow = true;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    err.write("Usage: lync sync <file> <url> [--root R] [--follow]\n");
    return 2;
  }
  const stopper = new AbortController();
  if (follow) {
    process.once("SIGINT", () => stopper.abort());
    process.once("SIGTERM", () => stopper.abort());
  }
  const result = await syncOnce({
    file: positional[0],
    url: positional[1],
    root,
    follow,
    stopSignal: stopper.signal,
    out,
    err,
  });
  out.write(
    `lync sync: sent ${result.sent}, received ${result.received} new, ` +
      `${result.duplicates} duplicates, ${result.surfaced} surfaced, cursor at seq ${result.seq}\n`,
  );
  return result.conflicts > 0 ? 1 : 0;
}
