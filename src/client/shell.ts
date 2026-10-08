/*
 * sferik.net shell
 *
 * A small fish-flavored shell over the site's own files. It supports pipes,
 * `;`, `&&`, and `||`, quoting and $variables, exit statuses, streaming output
 * (so `yes | head -3` stops), Ctrl-C to interrupt, and Ctrl-D for end of input.
 * Commands that read input with nothing piped in read lines you type, like a
 * real terminal.
 */
import { $, $$, closest, el, fmt, MON, reduceMotion, span } from "./dom.js";
import { figletLines, parseFont, type Font } from "./figlet.js";
import { qr } from "./qr.js";
import { blocks, checkIn, getJSON, ready } from "./site.js";
import { vcard } from "./vcard.js";
import type { Dependency, Finger, Who, Whoami } from "../types.js";

// ------------------------------------------------------------------ types

/** What commands write: text, or DOM for colored output and the comic. */
type Chunk = string | Node;
/** A command's I/O: what's piped in (or null for the terminal), and where errors go. */
interface IO {
  stdin: AsyncIterable<Chunk> | null;
  signal: AbortSignal;
  isatty: boolean;
  tty: () => AsyncIterable<string>;
  err: (text: string | null) => void;
  trap: () => void;
  status: number;
}
/** A failed command: a message for stderr and an exit status. */
interface Failure {
  out: string | null;
  status: number;
}
type Output = Chunk | number | Failure | null | undefined;
type CommandResult = Output | Promise<Output> | AsyncGenerator<Chunk, number | Failure | undefined, undefined>;
type Command = (args: string[], io: IO) => CommandResult;
// Parsed command-line options are as dynamic as the command line: a flag is
// true, an option is its string (or strings, when repeated like grep -e).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Opts = Record<string, any>;
interface FSNode {
  url: string;
  type?: string;
  hidden?: boolean;
  children?: Record<string, FSNode>;
}
type Dir = FSNode & { children: Record<string, FSNode> };
interface Token {
  word: (string | { v: string })[];
  glob: boolean;
}
type Stream = AsyncGenerator<Chunk, void, undefined>;
interface Job {
  controller: AbortController;
  terminal: Terminal;
  trapped: boolean;
  reader: ((line: string | null) => void) | null;
  queue: (string | null)[];
}
type Terminal = ((chunk: Chunk) => void) & { reset: () => void };

const block = (...parts: (Node | string)[]) => {
  const el = document.createElement("div");
  el.append(...parts);
  return el;
};
// A table to look up what's typed in: only what's in it, and not what every
// object has besides (constructor, toString), which aren't commands, files,
// or variables.
const table = <T>(entries: Record<string, T>): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, entries);
const pad = (s: string | number, n: number) => String(s).padStart(n);
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LOGIN = new Date(); // this session started when the page loaded

const repl = $("[data-repl]")!;
const field = $<HTMLInputElement>("input", repl)!;
const echo = $(".echo", repl)!;
const log = $(".repl-log", repl)!;
const pager = $(".repl-completions", repl)!;
const promptEl = $(".ps1-static .prompt", repl)!;

// ------------------------------------------------------------- plumbing

class Interrupt extends Error {}
const onAbort = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Interrupt()); // Ctrl-C may already have happened
    signal.addEventListener("abort", () => reject(new Interrupt()), { once: true });
  });
const abortable = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => Promise.race<T>([promise, onAbort(signal)]);
const sleep = (ms: number, signal: AbortSignal) => abortable(new Promise<void>((r) => setTimeout(r, ms)), signal);

// Text of a chunk as the next command in a pipe sees it.
function toText(chunk: Chunk): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof DocumentFragment) return [...chunk.children].map((c) => c.textContent).join("\n\n") + "\n";
  return chunk.textContent + "\n";
}

// Split a stream of chunks into lines (without their newlines).
async function* linesOf(source: AsyncIterable<Chunk>): AsyncGenerator<string> {
  let buf = "";
  for await (const chunk of source) {
    buf += toText(chunk);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

async function readAll(source: AsyncIterable<Chunk>): Promise<string> {
  let out = "";
  for await (const chunk of source) out += toText(chunk);
  return out;
}

// Minimal getopt: combined flags (-in), values (-n 5, -n5), long options, and --.
function getopts(name: string, args: string[], flags: string, valued = "", long: Record<string, [string, boolean?]> = {}): { opts: Opts; rest: string[] } {
  const opts: Opts = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.length > 2) {
      const [key, value] = a.slice(2).split("=");
      if (!Object.hasOwn(long, key)) throw new UsageError(`${name}: unrecognized option '--${key}'`);
      const [opt, takes] = long[key];
      opts[opt] = takes ? (value ?? args[++i]) : true;
      continue;
    }
    if (a.length < 2 || a[0] !== "-") {
      rest.push(a);
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if (valued.includes(c)) {
        const value = a.slice(j + 1) || args[++i];
        if (value === undefined) throw new UsageError(`${name}: option requires an argument -- ${c}`);
        opts[c] = c in opts ? [opts[c], value].flat() : value;
        break;
      }
      if (!flags.includes(c)) throw new UsageError(`${name}: illegal option -- ${c}`);
      opts[c] = true;
    }
  }
  return { opts, rest };
}
class UsageError extends Error {}

// ------------------------------------------------------------ filesystem
// The site as a home directory. Pages are directories with an index.html.

const HTML = "HTML document text, Unicode text, UTF-8 text";
const FS: Dir = {
  url: "/",
  children: table<FSNode>({
    ".plan": { url: "/.plan", type: "ASCII text" },
    ".signature": { url: "/.signature", type: "ASCII text" },
    "dependency.webp": { url: "/img/dependency.webp", type: "RIFF (little-endian) data, Web/P image" },
    "humans.txt": { url: "/humans.txt", type: "ASCII text" },
    "index.html": { url: "/", type: HTML },
    resume: { url: "/resume", children: table<FSNode>({ "index.html": { url: "/resume", type: HTML } }) },
    "robots.txt": { url: "/robots.txt", type: "ASCII text" },
    talks: { url: "/talks", children: table<FSNode>({ "index.html": { url: "/talks", type: HTML } }) },
  }),
};
const isDir = (node: FSNode): node is Dir => "children" in node;
class Denied extends Error {}

// "talks", "talks/", "~/talks", "/talks", "./talks/index.html", "talks.html" → node.
// Returns null when missing; throws Denied for anything above ~.
function resolve(arg: string): FSNode | null {
  if (arg === "~" || arg === "/" || arg === "-") return FS;
  const parts = arg
    .replace(/^~\//, "")
    .split("/")
    .filter((p) => p && p !== ".");
  let node: FSNode = FS;
  for (const [i, part] of parts.entries()) {
    if (part === "..") throw new Denied(arg);
    const next = node.children?.[part] ?? (i === parts.length - 1 && node.children?.[part.replace(/\.html$/, "")]);
    if (!next) return null;
    node = next;
  }
  return node;
}

const cache = new Map<string, Promise<FileInfo>>();
// Read a file: its text, byte size, and modification time from the server.
interface FileInfo {
  text: string;
  size: number;
  modified: Date;
}
async function read(node: FSNode, signal: AbortSignal): Promise<FileInfo> {
  if (!cache.has(node.url)) {
    cache.set(
      node.url,
      fetch(node.url, { signal, headers: { accept: node.type === HTML ? "text/html" : "*/*" } }).then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const bytes = new Uint8Array(await res.arrayBuffer());
        const modified = new Date(res.headers.get("last-modified") || Date.now());
        return { text: new TextDecoder().decode(bytes), size: bytes.length, modified };
      }),
    );
  }
  try {
    return await cache.get(node.url)!;
  } catch (e) {
    cache.delete(node.url);
    throw e;
  }
}

async function info(node: FSNode, signal: AbortSignal): Promise<{ size: number; modified: Date }> {
  if (!isDir(node)) return read(node, signal);
  const kids = await Promise.all(Object.values(node.children).map((c) => info(c, signal)));
  return { size: 64 + 32 * kids.length, modified: new Date(Math.max(...kids.map((k) => k.modified.getTime()))) };
}

// Expand a glob like *.txt or talks/* against the tree. Only * is a wildcard:
// a ? stands for itself, as in fish.
function glob(pattern: string): string[] {
  const slash = pattern.lastIndexOf("/");
  const dirPart = slash >= 0 ? pattern.slice(0, slash) : "";
  const dir = dirPart ? resolve(dirPart) : FS;
  const re = new RegExp(
    "^" +
      pattern
        .slice(slash + 1)
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*") +
      "$",
  );
  if (!dir || !isDir(dir)) return [];
  return Object.keys(dir.children)
    .filter((n) => re.test(n) && (pattern.slice(slash + 1).startsWith(".") || !n.startsWith(".")))
    .sort()
    .map((n) => (dirPart ? `${dirPart}/${n}` : n));
}

// Yield the contents of files, or stdin, or lines typed at the terminal.
async function* input(io: IO, files: string[], name: string): AsyncGenerator<Chunk> {
  if (!files.length) {
    yield* io.stdin ?? io.tty();
    return;
  }
  for (const f of files) {
    if (f === "-") {
      yield* io.stdin ?? io.tty();
      continue;
    }
    const file = await openFile(io, f, name);
    if (!file) {
      io.status = 1;
      continue;
    }
    let text;
    try {
      text = (await read(file, io.signal)).text;
    } catch {
      io.err(`${name}: ${f}: Input/output error`);
      io.status = 1;
      continue;
    }
    yield text;
  }
}

// Look up a regular file, reporting errors the way BSD tools do.
async function openFile(io: IO, f: string, name: string): Promise<FSNode | null> {
  let node;
  try {
    node = resolve(f);
  } catch {
    io.err(`${name}: ${f}: Permission denied`);
    return null;
  }
  if (!node) io.err(`${name}: ${f}: No such file or directory`);
  else if (isDir(node)) io.err(`${name}: ${f}: Is a directory`);
  else return node;
  return null;
}

// ------------------------------------------------------------- git data
// The name change, as real git objects. Recreate them and you'll get the same hashes:
//   git init && echo "Erik Michaels-Ober" > name && git add name
//   GIT_AUTHOR_NAME="Erik Michaels-Ober" GIT_COMMITTER_NAME="Erik Michaels-Ober" \
//   GIT_AUTHOR_EMAIL=sferik@gmail.com GIT_COMMITTER_EMAIL=sferik@gmail.com \
//   GIT_AUTHOR_DATE=2008-05-14T20:36:12Z GIT_COMMITTER_DATE=2008-05-14T20:36:12Z \
//   git commit -m "Initial commit"
//   echo "Erik Berlin" > name
//   GIT_AUTHOR_NAME="Erik Berlin" GIT_COMMITTER_NAME="Erik Berlin" (same emails) \
//   GIT_AUTHOR_DATE=2017-06-24T12:00:00-07:00 GIT_COMMITTER_DATE=2017-06-24T12:00:00-07:00 \
//   git commit -a -F <message below>
const RENAME = "8c0d698bb6cb54346ac26a38f7056ee64dafd64d";
const INITIAL = "33b9c3d44e0f69f2df1bd2c805ffd9e5da227f3c";
interface GitObject {
  type: "commit" | "tree" | "blob";
  body: string;
  author?: string;
  date?: string;
  blame?: string;
  diff?: string[];
}
const OBJECTS: Record<string, GitObject> = {
  [RENAME]: {
    type: "commit",
    body:
      "tree bc3ab1c46d0172ec14dbc270c0f20214af1b98cd\n" +
      `parent ${INITIAL}\n` +
      "author Erik Berlin <sferik@gmail.com> 1498330800 -0700\n" +
      "committer Erik Berlin <sferik@gmail.com> 1498330800 -0700\n\n" +
      "Rename Erik Michaels-Ober to Erik Berlin\n\n" +
      "Diana and I got married and chose a new last name together.\n" +
      "https://dianaberlin.com/posts/becoming-berlins\n",
    author: "Erik Berlin <sferik@gmail.com>",
    date: "Sat Jun 24 12:00:00 2017 -0700",
    blame: "2017-06-24 12:00:00 -0700",
    diff: ["diff --git a/name b/name", "index 5116d79..7773ccb 100644", "--- a/name", "+++ b/name", "@@ -1 +1 @@", "-Erik Michaels-Ober", "+Erik Berlin"],
  },
  [INITIAL]: {
    type: "commit",
    body:
      "tree 3f315233d7abb143bd80dac45fa97390f8b7988d\n" +
      "author Erik Michaels-Ober <sferik@gmail.com> 1210797372 +0000\n" +
      "committer Erik Michaels-Ober <sferik@gmail.com> 1210797372 +0000\n\n" +
      "Initial commit\n",
    author: "Erik Michaels-Ober <sferik@gmail.com>",
    date: "Wed May 14 20:36:12 2008 +0000",
    diff: ["diff --git a/name b/name", "new file mode 100644", "index 0000000..5116d79", "--- /dev/null", "+++ b/name", "@@ -0,0 +1 @@", "+Erik Michaels-Ober"],
  },
  bc3ab1c46d0172ec14dbc270c0f20214af1b98cd: { type: "tree", body: "100644 blob 7773ccb2f816421e6fc3471201700290f7daef8d\tname\n" },
  "3f315233d7abb143bd80dac45fa97390f8b7988d": { type: "tree", body: "100644 blob 5116d79aff7ce5ae9dc842ff677548a23dc48f78\tname\n" },
  "7773ccb2f816421e6fc3471201700290f7daef8d": { type: "blob", body: "Erik Berlin\n" },
  "5116d79aff7ce5ae9dc842ff677548a23dc48f78": { type: "blob", body: "Erik Michaels-Ober\n" },
};
const LOG = [RENAME, INITIAL];
const message = (sha: string) => OBJECTS[sha].body.split("\n\n").slice(1).join("\n\n").replace(/\n$/, "").split("\n");

function findObject(ref = "HEAD"): string | undefined {
  const at = table({ HEAD: RENAME, "HEAD^": INITIAL, "HEAD~1": INITIAL, main: RENAME });
  if (ref in at) return at[ref];
  if (ref.endsWith("^{tree}")) {
    const sha = findObject(ref.slice(0, -7));
    return sha && OBJECTS[sha].body.slice(5, 45);
  }
  return Object.keys(OBJECTS).find((sha) => ref.length >= 4 && sha.startsWith(ref));
}
const commitHeader = (sha: string) => [
  `commit ${sha}`,
  `Author: ${OBJECTS[sha].author}`,
  `Date:   ${OBJECTS[sha].date}`,
  "",
  ...message(sha).map((l) => (l ? "    " + l : "")),
];
// git's colors: yellow hashes, red removals, green additions.
function gitColored(lines: string[]) {
  const out = block();
  lines.forEach((line, i) => {
    if (i) out.append("\n");
    const cls = /^commit [0-9a-f]{40}/.test(line) ? "warn" : /^-(?!--)/.test(line) ? "err" : /^\+(?!\+\+)/.test(line) ? "ok" : "";
    out.append(span(line, cls));
  });
  return out;
}

// ------------------------------------------------------------- the shell

// History is kept between visits, in this browser.
const SAVED = "history";
const history: string[] = [];
try {
  history.push(...(JSON.parse(localStorage.getItem(SAVED) ?? "[]") as string[]));
} catch {}
// The commands the page itself ran (whoami, git log, …, finger) come last,
// so ↑ at the prompt recalls them, newest first. They're not saved: every
// visit runs them again.
const ran = $$<HTMLElement>("main section.cmd").map((s) => {
  const ps1 = s.firstElementChild!;
  return (ps1.querySelector(".sr-only")?.textContent ?? ps1.textContent!.replace(ps1.querySelector(".prompt")!.textContent!, "")).trim();
});
let seededAt = history.length; // where the page's commands start in history
history.push(...ran);
let seeded = ran.length;
let hIndex = history.length;
// …and shared between tabs: a command run in one shows up in the others.
addEventListener("storage", (e) => {
  if (e.key !== SAVED) return;
  try {
    history.splice(0, history.length, ...(JSON.parse(e.newValue!) as string[]));
    seeded = 0;
  } catch {}
  hIndex = history.length;
});
let lastStatus: number[] = [0];
// Exported variables, which env lists, and the shell's own, which only set
// lists. `set` changes them for the rest of the visit. Lists like $PATH are
// space-separated, as fish prints them.
const exported = new Map(
  Object.entries({
    EDITOR: "vim",
    EMAIL: "sferik@gmail.com",
    HOME: "/Users/sferik",
    LANG: "en_US.UTF-8",
    PATH: "/opt/homebrew/bin /usr/bin /bin",
    PWD: "/Users/sferik",
    SHELL: "/opt/homebrew/bin/fish",
    TERM: "xterm-256color",
    TZ: "America/Los_Angeles",
    USER: "sferik",
    WEBSITE: "https://sferik.net",
  }),
);
const local = new Map<string, string>();
const readOnly = (): Record<string, string> =>
  table({
    status: String(lastStatus[lastStatus.length - 1]),
    pipestatus: lastStatus.join(" "),
    version: "4.1.2",
    hostname: "mbp",
    PWD: "/Users/sferik",
  });
const vars = (): Record<string, string> => table({ ...Object.fromEntries(local), ...Object.fromEntries(exported), ...readOnly() });
const listVars = (v: Record<string, string>, line: (name: string, value: string) => string) =>
  Object.keys(v)
    .sort()
    .map((name) => line(name, v[name]))
    .join("\n");

// Split a line into words and operators, handling quotes, escapes, and $vars.
// Words are lists of literal strings and { v: name } variable references,
// which are expanded when the command runs (so `false; echo $status` works).
function tokenize(line: string): ({ op: string } | Token)[] {
  const tokens = [];
  let word: Token["word"] | null = null;
  let globbed = false;
  const push = () => {
    if (word !== null) tokens.push({ word, glob: globbed });
    word = null;
    globbed = false;
  };
  const add = (s: string | { v: string }) => (word = [...(word ?? []), s]);
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new SyntaxError("Unexpected end of string, quotes are not balanced");
      add(line.slice(i + 1, end));
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "\\" && '"$\\'.includes(line[j + 1])) s += line[++j];
        else if (line[j] === "$" && /\w/.test(line[j + 1] ?? "")) {
          const name = /^\w+/.exec(line.slice(j + 1))![0];
          add(s);
          add({ v: name });
          s = "";
          j += name.length;
        } else s += line[j];
      }
      if (j >= line.length) throw new SyntaxError("Unexpected end of string, quotes are not balanced");
      add(s);
      i = j;
    } else if (c === "\\") {
      add(line[++i] ?? "");
    } else if (c === "$" && /\w/.test(line[i + 1] ?? "")) {
      const name = /^\w+/.exec(line.slice(i + 1))![0];
      add({ v: name });
      i += name.length;
    } else if (/\s/.test(c)) {
      push();
    } else if (c === "|" || c === ";" || (c === "&" && line[i + 1] === "&")) {
      push();
      const two = line.slice(i, i + 2);
      const op = two === "||" || two === "&&" ? two : c;
      tokens.push({ op });
      i += op.length - 1;
    } else {
      if (c === "*") globbed = true;
      add(c);
    }
  }
  push();
  return tokens;
}

// [{ conn: ";" | "&&" | "||", pipeline: [[words], ...] }]
function parse(line: string): { conn: string; pipeline: Token[][] }[] {
  const lists: { conn: string; pipeline: Token[][] }[] = [];
  let conn = ";";
  let pipeline: Token[][] = [[]];
  const finish = (next: string) => {
    if (pipeline.some((cmd) => !cmd.length)) {
      if (pipeline.length === 1 && next !== "|") {
        conn = next;
        return;
      }
      throw new SyntaxError(`Expected a command, but found '${next}'`);
    }
    lists.push({ conn, pipeline });
    conn = next;
    pipeline = [[]];
  };
  for (const t of tokenize(line)) {
    if ("op" in t && t.op === "|") {
      if (!pipeline[pipeline.length - 1].length) throw new SyntaxError("Expected a command, but found '|'");
      pipeline.push([]);
    } else if ("op" in t) finish(t.op);
    else pipeline[pipeline.length - 1].push(t);
  }
  if (pipeline.length > 1 && !pipeline[pipeline.length - 1].length) throw new SyntaxError("Expected a command, but found end of the input");
  finish(";");
  return lists;
}

// fish's blocks: `for NAME in VALUES; ...; end` and `function NAME; ...; end`
// group the statements between them.
type Statement = { conn: string; pipeline: Token[][] };
type Stmt = Statement | (Statement & { loop: string; values: Token[]; body: Stmt[] }) | (Statement & { fn: string; body: Stmt[] });
const literal = (t: Token | undefined) => (t && !t.glob && t.word.every((p) => typeof p === "string") ? t.word.join("") : null);
function grouped(lists: Statement[]): Stmt[] {
  let i = 0;
  const seq = (inside: "for loop" | "function definition" | null): Stmt[] => {
    const out: Stmt[] = [];
    while (i < lists.length) {
      const s = lists[i++];
      const [head, ...rest] = s.pipeline[0];
      const word = s.pipeline.length === 1 ? literal(head) : null;
      if (word === "end" && !rest.length) {
        if (!inside) throw new SyntaxError("'end' outside of a block");
        return out;
      }
      if (word === "for") {
        if (!literal(rest[0]) || literal(rest[1]) !== "in") throw new SyntaxError("for: Expected 'for VARIABLE in [VALUES...]'");
        out.push({ ...s, loop: literal(rest[0])!, values: rest.slice(2), body: seq("for loop") });
      } else if (word === "function") {
        if (rest.length !== 1 || !literal(rest[0])) throw new SyntaxError("function: Expected 'function NAME'");
        out.push({ ...s, fn: literal(rest[0])!, body: seq("function definition") });
      } else out.push(s);
    }
    if (inside) throw new SyntaxError(`Missing end to balance this ${inside}`);
    return out;
  };
  return seq(null);
}

// The functions you've defined, by name.
const functions = new Map<string, Stmt[]>();

// Run statements: && and || look at the last status; a for loop sets its
// variable for each value in turn; function only defines.
async function runAll(stmts: Stmt[], terminal: (chunk: Chunk) => void, signal: AbortSignal): Promise<void> {
  for (const s of stmts) {
    if ((s.conn === "&&" && lastStatus.at(-1) !== 0) || (s.conn === "||" && lastStatus.at(-1) === 0)) continue;
    if ("fn" in s) {
      functions.set(s.fn, s.body);
      lastStatus = [0];
    } else if ("loop" in s) {
      let values;
      try {
        values = s.values.flatMap(expand);
      } catch (e) {
        terminal((e as Error).message + "\n");
        lastStatus = [124];
        continue;
      }
      const before = local.get(s.loop);
      lastStatus = [0];
      try {
        for (const value of values) {
          local.set(s.loop, value);
          await runAll(s.body, terminal, signal);
        }
      } finally {
        if (before === undefined) local.delete(s.loop);
        else local.set(s.loop, before);
      }
    } else lastStatus = await runPipeline(s.pipeline, terminal, signal);
  }
}

// A function, as a command: its body runs with its arguments in $argv, and
// what it prints goes wherever the command's output goes.
const call =
  (body: Stmt[]): Command =>
  async (args, io) => {
    const out: string[] = [];
    const capture = (chunk: Chunk) => void out.push(toText(chunk));
    const before = local.get("argv");
    local.set("argv", args.join(" "));
    try {
      await runAll(body, capture, io.signal);
    } finally {
      if (before === undefined) local.delete("argv");
      else local.set("argv", before);
    }
    io.status = lastStatus.at(-1)!;
    return out.join("") || io.status;
  };

// ---------------------------------------------------------- job control

let job: Job | null = null; // the running command line: { controller, trapped, reader, queue }

// Lines typed while a command reads from the terminal. Ctrl-D ends input.
async function* ttyLines(signal: AbortSignal): AsyncGenerator<string> {
  for (;;) {
    const current = job!;
    const line = current.queue.length ? current.queue.shift()! : await abortable(new Promise<string | null>((resolve) => (current.reader = resolve)), signal);
    if (line === null) return;
    yield line + "\n";
  }
}

// Expand a word's variables, then its wildcard.
function expand(token: Token): string[] {
  const v = vars();
  const word = token.word.map((p) => (typeof p === "string" ? p : (v[p.v] ?? ""))).join("");
  if (!token.glob) return [word];
  const matches = glob(word);
  if (!matches.length) throw new GlobError(`fish: No matches for wildcard '${word}'. See \`help wildcards-globbing\`.`);
  return matches;
}
class GlobError extends Error {}

// Run one pipeline; resolves to the exit status of each command.
async function runPipeline(tokens: Token[][], terminal: (chunk: Chunk) => void, signal: AbortSignal): Promise<number[]> {
  let pipeline;
  try {
    pipeline = tokens.map((cmd) => cmd.flatMap(expand));
  } catch (e) {
    terminal((e as Error).message + "\n");
    return [124];
  }
  const statuses = pipeline.map(() => 0);
  let stdin: Stream | null = null;
  let last!: Stream;
  const streams: Stream[] = [];
  pipeline.forEach((words, i) => {
    const [name, ...args] = words;
    const io = {
      stdin,
      signal,
      isatty: i === pipeline.length - 1,
      tty: () => ttyLines(signal),
      err: (text: string | null) => terminal(text!.endsWith("\n") ? text! : text + "\n"),
      trap: () => (job!.trapped = true),
      status: 0,
    };
    const stream = spawn(name, args, io, (code) => (statuses[i] = code));
    streams.push(stream);
    stdin = stream;
    last = stream;
  });
  for await (const chunk of last) terminal(chunk);
  // Commands whose output nobody read still run (and then get SIGPIPE), so their status counts.
  for (const stream of streams.slice(0, -1)) {
    await stream.next();
    await stream.return();
  }
  return statuses;
}

// Start a command as a lazy stream of output chunks.
async function* spawn(name: string, args: string[], io: IO, done: (code: number) => void): Stream {
  if (io.stdin) {
    const upstream = io.stdin;
    io.stdin = (async function* () {
      for await (const chunk of upstream) yield toText(chunk);
    })();
  }
  const defined = functions.get(name);
  const command = COMMANDS[name] ?? (defined && call(defined));
  if (!command) {
    const near = closest(name, [...Object.keys(COMMANDS), ...functions.keys()]);
    io.err(`fish: Unknown command: ${name}${near ? `. Did you mean ${near}?` : ""}`);
    done(127);
    return;
  }
  try {
    const result = command(args, io);
    let output: Output;
    if (result && typeof result === "object" && Symbol.asyncIterator in result) {
      const gen = result as AsyncGenerator<Chunk, number | Failure | undefined>;
      let step;
      while (!(step = await gen.next()).done) yield step.value;
      output = step.value;
    } else output = await (result as Output | Promise<Output>);
    if (typeof output === "number") return done(output);
    if (output && typeof output === "object" && "status" in output) {
      io.err(output.out);
      return done(output.status);
    }
    if (output !== undefined && output !== null) yield typeof output === "string" && !output.endsWith("\n") ? output + "\n" : output;
    done(io.status);
  } catch (e) {
    if (e instanceof Interrupt) throw e;
    if (e instanceof UsageError) {
      io.err(e.message);
      done(1);
      return;
    }
    io.err(`${name}: ${(e as Error).message}`);
    done(1);
  }
}
const fail = (out: string | null, status = 1): Failure => ({ out, status });

// ------------------------------------------------------------- commands

const SITES = () => $$<HTMLAnchorElement>("[data-open]").map((a) => ({ keys: a.dataset.open!.split(" "), href: a.href }));

// Hand the browser a file to save.
function save(name: string, text: string, type: string) {
  el("a", { download: name, href: `data:${type};charset=utf-8,${encodeURIComponent(text)}` }).click();
}

// A QR code in text: two rows of modules per line, in half blocks, always
// dark on light (inverted codes don't scan everywhere).
function qrBlock(text: string, label: string): HTMLElement {
  const m = qr(text);
  const lines = [];
  for (let y = 0; y < m.length; y += 2) lines.push(m[y].map((top, x) => (top ? (m[y + 1]?.[x] ? "█" : "▀") : m[y + 1]?.[x] ? "▄" : " ")).join(""));
  return el("pre", { class: "qr", role: "img", "aria-label": label }, lines.join("\n"));
}

// The flags in a usage line: [-abc] clusters, -n count, and --long.
function flagsOf(usage: string): string[] {
  const flags = new Set<string>();
  for (const m of usage.matchAll(/\[-(\w+)\]/g)) for (const c of m[1]) flags.add(`-${c}`);
  for (const m of usage.matchAll(/(?:^|[\s[|])-(\w)(?= \w)/g)) flags.add(`-${m[1]}`);
  for (const m of usage.matchAll(/--[\w-]+/g)) flags.add(m[0]);
  return [...flags];
}

// What each command does, for help and man: [usage, description].
const HELP: Record<string, [string, string]> = table({
  "?": ["?", "List the keyboard shortcuts."],
  banner: ["banner [-w width] [text]", "Print text as a banner, sideways, like the old Unix banner."],
  caffeinate: ["caffeinate [-dimsu] [-t seconds] [command]", "Keep the screen awake, until Ctrl-C (or the command finishes)."],
  cal: ["cal [-3hy] [-m month] [[month] year]", "Show a calendar: this month, three months (-3), or a year (-y)."],
  cat: ["cat [-nb] [file ...]", "Print files, numbering every line (-n) or the non-blank ones (-b)."],
  cd: ["cd [directory]", "Change directory. talks/ and resume/ are pages on this site."],
  clear: ["clear", "Clear the screen. Ctrl-L does too."],
  coffee: ["coffee", "Make coffee."],
  cowsay: ["cowsay [text]", "A cow says something."],
  cowthink: ["cowthink [text]", "A cow thinks something."],
  curl: ["curl [-sSIiLv] [-X method] [-H header] [-o file] url", "Fetch a URL, like this site's API: curl sferik.net/resume."],
  cut: ["cut -f list [-s] [-d delim] [file ...] | cut -c list [file ...]", "Print fields (-f) split by tab or delim (-d), or characters (-c)."],
  date: ["date [-uR] [-r seconds]", "Print the date and time, in UTC (-u), or as in email (-R)."],
  echo: ["echo [-nse] [string ...]", "Print the strings: no newline (-n), no spaces (-s), escapes (-e)."],
  env: ["env", "List the exported environment variables."],
  exit: ["exit", "End the session. Ctrl-D on an empty line does too."],
  false: ["false", "Do nothing, unsuccessfully."],
  figlet: ["figlet [-clrk] [-w width] [text]", "Print text in big letters."],
  for: ["for NAME in VALUES; COMMANDS; end", "Run the commands once for each value, as $NAME."],
  file: ["file [-b] file ...", "Say what kind of file each one is."],
  finger: ["finger [--vcard]", "How to reach me, or (--vcard) a contact card to save."],
  fish: ["fish [--version]", "The shell you're in."],
  fortune: ["fortune [-sl]", "Print a quotation, short (-s) or long (-l)."],
  function: ["function NAME; COMMANDS; end", "Define a command. Its arguments are $argv."],
  functions: ["functions", "List the functions you've defined."],
  gem: ["gem list | gem info name", "List my Ruby gems, or show one."],
  gh: ["gh repo list | gh repo view name | gh api path", "GitHub, from the command line."],
  git: ["git log | show | diff | blame | status | ...", "Read the history of my name, which is a git repository."],
  grep: ["grep [-ivnclLwxoEFrRhHqs] [-e pattern] pattern [file ...]", "Print the lines of files that match a pattern."],
  halt: ["halt", "Stop the computer, if you're allowed to."],
  head: ["head [-n count | -c bytes] [file ...]", "Print the first lines (or bytes) of files."],
  hello: ["hello", "Say hello."],
  help: ["help [-a] [command]", "List the main commands, every command (-a), or what one does."],
  hi: ["hi", "Say hello."],
  history: ["history [search text | delete command | clear]", "List what you've typed, newest first, or forget some or all of it."],
  imgcat: ["imgcat file ...", "Show images, like iTerm and kitty do: imgcat dependency.webp."],
  hostname: ["hostname", "Print the computer's name."],
  printf: ["printf format [arguments ...]", "Print arguments in a format: %s, %d, \\n, \\t, and \\a, the bell."],
  version: ["version", "Print the deployed commit, when, and a link to it on GitHub."],
  jq: ["jq [-rc] [filter] [file]", "Print parts of JSON: ., .key, .[n], .[], |, keys, and length."],
  last: ["last [clear]", "List your recent visits, or forget them all."],
  less: ["less file ...", "Print files. There's no pager."],
  logout: ["logout", "End the session."],
  ls: ["ls [-aAlh1FrtS] [file ...]", "List files, long (-l), all (-a), by time (-t) or size (-S)."],
  make: ["make [target]", "Build something."],
  man: ["man page", "Show a manual page. man sferik is my resume."],
  mentions: ["mentions", "List the latest webmentions of this site: links from other sites."],
  matrix: ["matrix", "Turn the amber phosphor theme on or off."],
  more: ["more file ...", "Print files. There's no pager."],
  open: ["open site | file", "Open one of my profiles (github, x, mastodon, ...) or a page."],
  pbcopy: ["pbcopy", "Copy what's piped in (or typed) to the clipboard."],
  pbpaste: ["pbpaste", "Print the clipboard."],
  ping: ["ping [-q] [-c count] [host]", "Check a host is there, until Ctrl-C (or count pings)."],
  pwd: ["pwd", "Print the working directory."],
  qr: ["qr [text]", "Show a QR code of my contact card, or of the text."],
  random: ["random [start end] | random choice item ...", "Print a random number, or pick an item."],
  reboot: ["reboot", "Start over: reload the page."],
  say: ["say [-v voice] [-r rate] [text]", "Say it out loud."],
  set: ["set [-x] name [value ...] | set -e name | set -q name ...", "List variables, or set, export (-x), erase (-e), test (-q) them."],
  shutdown: ["shutdown", "Turn off the computer, if you're allowed to."],
  sl: ["sl [-el]", "For when you meant ls."],
  share: ["share [command]", "Copy a link that runs your last command (or this one), for anyone."],
  sort: ["sort [-rnuf] [file ...]", "Sort lines: reversed (-r), by number (-n), uniquely (-u)."],
  stat: ["stat [-x] file ...", "Show the details of files."],
  sudo: ["sudo command", "Run a command as the superuser, if you're allowed to."],
  tail: ["tail [-f] [-n count | -c bytes] [file ...]", "Print the last lines (or bytes) of files, or follow them (-f)."],
  tree: ["tree [-adF] [-L level] [-I pattern] [directory]", "List files as a tree."],
  true: ["true", "Do nothing, successfully."],
  uname: ["uname [-a]", "Print the operating system's name, or everything about it (-a)."],
  uniq: ["uniq [-cdu] [file]", "Drop repeated lines, or count (-c) or show only repeats (-d)."],
  uptime: ["uptime", "Say how long the computer has been up."],
  w: ["w", "List who's logged in, and what they're doing."],
  wc: ["wc [-lwcm] [file ...]", "Count lines, words, and bytes."],
  who: ["who [am i]", "List who's logged in: everyone on this site, a tab each."],
  write: ["write sferik", "Email me what you type, when you press Ctrl-D."],
  whoami: ["whoami", "Say who this is."],
  yes: ["yes [string]", "Print y (or the string) over and over, until Ctrl-C."],
});

const COMMANDS: Record<string, Command> = table<Command>({
  // Only the main commands. The fun ones are for finding.
  help: (args) => {
    const { opts, rest } = getopts("help", args, "a");
    if (rest.length) {
      const entry = HELP[rest[0]];
      return entry ? `usage: ${entry[0]}\n\n${entry[1]}` : fail(`help: no help for ${rest[0]}. help -a lists every command.`);
    }
    if (opts.a)
      return Object.keys(HELP)
        .sort()
        .map((name) => `  ${name.padEnd(12)}${HELP[name][1]}`)
        .join("\n");
    return [
      "Commands work like they do in a real shell: pipes, &&, ||, ;, quotes, $status.",
      "",
      "  whoami          who is this",
      "  ls, cd, cat     look around: talks/, resume/, humans.txt",
      "  man sferik      the resume, as a man page",
      "  finger          how to reach me",
      "  write sferik    send me a message",
      "  open <site>     github, x, bluesky, mastodon, linkedin, rubygems, mail, ...",
      "  curl <url>      this site's API, e.g. curl sferik.net/resume",
      "  clear           clear the screen",
    ].join("\n");
  },

  // The same /whoami module the page is built from.
  whoami: async () => {
    try {
      const m = await getJSON<Whoami>("/whoami");
      const frag = document.createDocumentFragment();
      frag.append(...blocks(m.blocks));
      return frag;
    } catch {
      return "sferik";
    }
  },

  env: (args) =>
    args.length
      ? fail(`env: ${args[0]}: No such file or directory`, 127)
      : listVars(Object.fromEntries(exported), (name, value) => `${name}=${name === "PATH" ? value.replaceAll(" ", ":") : value}`),

  set: (args) => {
    const { opts, rest } = getopts("set", args, "eqx");
    if (opts.q) return rest.filter((name) => !(name in vars())).length;
    if (!rest.length) return listVars(vars(), (name, value) => `${name} ${value}`);
    const [name, ...values] = rest;
    if (!/^\w+$/.test(name)) return fail(`set: Variable name '${name}' is not valid. See \`help identifiers\`.`);
    if (name in readOnly()) return fail(`set: Tried to modify the special variable '${name}'`);
    if (opts.e) {
      if (!(name in vars())) return 4;
      exported.delete(name);
      local.delete(name);
      return 0;
    }
    if (opts.x || exported.has(name)) {
      local.delete(name);
      exported.set(name, values.join(" "));
    } else local.set(name, values.join(" "));
    return 0;
  },

  true: () => 0,
  false: () => 1,
  pwd: () => "/Users/sferik",
  hostname: () => "mbp",
  version: async () => {
    const v = await getJSON<{ commit: string | null; deployed: string | null; url: string | null }>("/version");
    if (!v.commit) return "sferik.net, a local copy (not deployed)";
    const frag = document.createDocumentFragment();
    frag.append(el("div", {}, `sferik.net ${v.commit.slice(0, 7)}, deployed ${ago(new Date(v.deployed!))}`), el("div", {}, el("a", { href: v.url! }, v.url!)));
    return frag;
  },
  uname: (args) => (args.includes("-a") ? "Darwin mbp 27.0.0 Darwin Kernel Version 27.0.0: RELEASE_ARM64 arm64" : "Darwin"),
  uptime: async () => uptime((await online()).users.length),

  echo: async function* (args) {
    const { opts, rest } = getopts("echo", args, "nse");
    let out = rest.join(opts.s ? "" : " ");
    if (opts.e) out = out.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\a/g, "\x07");
    yield opts.n ? out : out + "\n";
    return 0;
  },

  // printf FORMAT [ARGUMENTS...]: %s and %d take the arguments in turn; \n,
  // \t, \\, and \a (the bell) are escapes. No newline unless asked for.
  printf: async function* (args) {
    if (!args.length) return fail("printf: Expected at least 1 args, got only 0", 2);
    const [format, ...values] = args;
    const out = format.replace(/%[sd%]|\\[ntab\\]/g, (spec) => {
      if (spec === "%%") return "%";
      if (spec === "%s") return values.shift() ?? "";
      if (spec === "%d") return String(Math.trunc(Number(values.shift() ?? 0)) || 0);
      return { "\\n": "\n", "\\t": "\t", "\\a": "\x07", "\\b": "\b", "\\\\": "\\" }[spec]!;
    });
    if (out) yield out; // as is: printf adds no newline
    return 0;
  },

  // history: what you've typed, newest first; history TEXT (or history search
  // TEXT) only what contains it; history delete COMMAND forgets every entry
  // that's exactly it, and history clear forgets everything. As in fish.
  history: (args) => {
    const [sub, ...rest] = args;
    if (sub === "clear") {
      history.splice(0);
      seededAt = seeded = hIndex = 0;
      saveHistory();
      return null;
    }
    if (sub === "delete") {
      const line = rest.join(" ");
      if (!line) return fail("history: delete needs a command, like history delete ls");
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i] !== line) continue;
        history.splice(i, 1);
        if (i < seededAt) seededAt--;
        else if (i < seededAt + seeded) seeded--;
      }
      hIndex = history.length;
      saveHistory();
      return null;
    }
    const text = (sub === "search" ? rest : args).join(" ");
    return (
      history
        .slice(0, -1)
        .reverse()
        .filter((h) => h.includes(text))
        .join("\n") || null
    );
  },
  clear: () => {
    log.replaceChildren();
    return null;
  },
  exit: () => {
    endSession();
    return null;
  },

  fish: (args) => (args[0] === "--version" ? "fish, version 4.1.2" : "You're already in fish."),

  finger: async (args, io) => {
    if (args[0] === "--vcard") {
      save("erik-berlin.vcf", vcard(await getJSON<Finger>("/finger")), "text/vcard");
      return "Saved erik-berlin.vcf";
    }
    $("#finger")?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    jumped = true;
    return (await fetchText("/finger", io.signal)).replace(/\n$/, "");
  },

  // ----------------------------------------------------------- files

  ls: async function* (args, io) {
    const { opts, rest } = getopts("ls", args, "aAlh1FrtS");
    const targets = (rest.length ? rest : ["."]).sort();
    const blocks = [];
    for (const t of targets) {
      let node;
      try {
        node = resolve(t);
      } catch {
        io.err(`ls: ${t}: Permission denied`);
        io.status = 1;
        continue;
      }
      if (!node) {
        io.err(`ls: ${t}: No such file or directory`);
        io.status = 1;
        continue;
      }
      const entries: [string, FSNode][] = isDir(node)
        ? [
            ...(opts.a
              ? ([
                  [".", node],
                  ["..", FS],
                ] as [string, FSNode][])
              : []),
            ...Object.entries(node.children).filter(([n]) => opts.a || opts.A || !n.startsWith(".")),
          ]
        : [[t, node]];
      blocks.push({ label: isDir(node) ? t : null, entries: await sortEntries(entries, opts, io.signal) });
    }
    blocks.sort((a, b) => Number(!a.label) - Number(!b.label));
    const out = block();
    blocks.forEach(({ label, entries }, i) => {
      if (blocks.length > 1 && label) out.append(`${i ? "\n" : ""}${label}:\n`);
      if (opts.l) return longListing(out, entries, opts, label);
      const names = entries.map(([n, node]): [string, FSNode] => [n + (opts.F && isDir(node) ? "/" : ""), node]);
      if (!io.isatty || opts[1]) names.forEach(([n, node]) => out.append(lsName(n, node), "\n"));
      else columns(out, names);
    });
    out.normalize();
    const tail = out.lastChild as Text | null;
    if (tail?.data?.endsWith("\n")) tail.data = tail.data.slice(0, -1);
    if (out.textContent) yield out;
    return io.status;
  },

  cat: async function* (args, io) {
    const { opts, rest } = getopts("cat", args, "nb");
    let n = 0;
    if (!opts.n && !opts.b) {
      for await (const chunk of input(io, rest, "cat")) yield chunk;
    } else {
      for await (const line of linesOf(input(io, rest, "cat"))) {
        yield opts.b && !line ? "\n" : `${pad(++n, 6)}\t${line}\n`;
      }
    }
    return io.status;
  },
  less: (args, io) => pagerCommand("less", args, io, 'Missing filename ("less --help" for help)'),
  more: (args, io) => pagerCommand("more", args, io, "usage: more [-dflpcsu] [+linenum | +/pattern] name1 name2 ..."),

  head: async function* (args, io) {
    const { count, bytes, files } = headTailArgs("head", args);
    const sources = files.length ? files : [null];
    for (const [i, f] of sources.entries()) {
      if (f !== null && !(await openFile(io, f, "head"))) {
        io.status = 1;
        continue;
      }
      if (sources.length > 1) yield `${i ? "\n" : ""}==> ${f} <==\n`;
      const src = input(io, f === null ? [] : [f], "head");
      if (bytes) {
        const text = (await readAll(src)).slice(0, count);
        if (text) yield text;
        continue;
      }
      if (count <= 0) continue;
      let n = 0;
      for await (const line of linesOf(src)) {
        yield line + "\n";
        if (++n >= count) break;
      }
    }
    return io.status;
  },

  tail: async function* (args, io) {
    const { count, bytes, files, from, follow } = headTailArgs("tail", args);
    const sources = files.length ? files : [null];
    for (const [i, f] of sources.entries()) {
      if (f !== null && !(await openFile(io, f, "tail"))) {
        io.status = 1;
        continue;
      }
      if (sources.length > 1) yield `${i ? "\n" : ""}==> ${f} <==\n`;
      const text = await readAll(input(io, f === null ? [] : [f], "tail"));
      if (bytes) {
        yield from ? text.slice(count - 1) : text.slice(-count || text.length);
        continue;
      }
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      const picked = from ? lines.slice(count - 1) : count ? lines.slice(-count) : [];
      if (picked.length) yield picked.join("\n") + "\n";
    }
    if (follow && files.length) await onAbort(io.signal);
    return io.status;
  },

  grep: async function* (args, io) {
    const { opts, rest } = getopts("grep", args, "ivnclLwxoEFrRhHqs", "em", {
      "ignore-case": ["i"],
      "invert-match": ["v"],
      "line-number": ["n"],
      count: ["c"],
      recursive: ["r"],
      color: ["color", true],
      colour: ["color", true],
    });
    const patterns = opts.e ? [opts.e].flat() : rest.splice(0, 1);
    if (!patterns.length)
      return fail(
        "usage: grep [-abcdDEFGHhIiJLlMmnOopqRSsUVvwXxZz] [-A num] [-B num] [-C[num]]\n\t[-e pattern] [-f file] [--binary-files=value] [--color=when]\n\t[--context[=num]] [--directories=action] [--label] [--line-buffered]\n\t[--null] [pattern] [file ...]",
        2,
      );
    let re;
    try {
      let src = patterns.map((p) => (opts.F ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : opts.E ? p : bre(p))).join("|");
      if (opts.w) src = `(?<![\\w])(?:${src})(?![\\w])`;
      if (opts.x) src = `^(?:${src})$`;
      re = new RegExp(src, opts.i ? "gi" : "g");
    } catch (e) {
      // Report it the way macOS grep does.
      const why = (e as Error).message.replace(/^.*: /, "");
      const bsd: Record<string, string> = {
        "Unterminated group": "parentheses not balanced",
        "Unmatched ')'": "parentheses not balanced",
        "Unterminated character class": "brackets ([ ]) not balanced",
      };
      return fail(`grep: ${bsd[why] ?? why.toLowerCase()}`, 2);
    }
    const recursive = opts.r || opts.R;
    let files = rest;
    if (recursive) files = (files.length ? files : ["."]).flatMap((f) => walk(f));
    const named = !opts.h && (opts.H || files.length > 1 || recursive);
    const color = opts.color === "always" || (opts.color !== "never" && io.isatty);
    let matched = false;
    let errors = false;
    for (const f of files.length ? files : [null]) {
      if (f !== null && !(await openFile(io, f, "grep"))) {
        errors = true;
        continue;
      }
      let count = 0;
      let n = 0;
      for await (const line of linesOf(input(io, f === null ? [] : [f], "grep"))) {
        n++;
        re.lastIndex = 0;
        const hit = re.test(line) !== !!opts.v;
        re.lastIndex = 0; // test() leaves it past the match; matchAll() would start there
        if (!hit) continue;
        matched = true;
        count++;
        if (opts.q) return 0;
        if (opts.l || opts.L || opts.c) {
          if (opts.m && count >= Number(opts.m)) break;
          continue;
        }
        const prefix = (named ? `${f ?? "(standard input)"}:` : "") + (opts.n ? `${n}:` : "");
        if (opts.o && !opts.v) {
          for (const m of line.matchAll(re)) if (m[0]) yield grepLine(prefix, [[m[0], true]], color);
        } else {
          yield grepLine(prefix, opts.v ? [[line, false]] : highlightMatches(line, re), color);
        }
        if (opts.m && count >= Number(opts.m)) break;
      }
      if (opts.c) yield `${named ? `${f}:` : ""}${count}\n`;
      if (opts.l && count) yield `${f ?? "(standard input)"}\n`;
      if (opts.L && !count) yield `${f ?? "(standard input)"}\n`;
    }
    return errors && !opts.s ? 2 : matched ? 0 : 1;
  },

  wc: async function* (args, io) {
    const { opts, rest } = getopts("wc", args, "lwcm");
    const pick = opts.l || opts.w || opts.c || opts.m ? opts : { l: true, w: true, c: true };
    const rows: [number[], string | null][] = [];
    const totals = [0, 0, 0, 0];
    for (const f of rest.length ? rest : [null]) {
      if (f !== null && !(await openFile(io, f, "wc"))) {
        io.status = 1;
        continue;
      }
      const text = await readAll(input(io, f === null ? [] : [f], "wc"));
      const counts = [(text.match(/\n/g) || []).length, (text.match(/\S+/g) || []).length, new TextEncoder().encode(text).length, [...text].length];
      counts.forEach((c, i) => (totals[i] += c));
      rows.push([counts, f]);
    }
    if (rest.length > 1) rows.push([totals, "total"]);
    const line = ([counts, name]: [number[], string | null]) =>
      [pick.l && counts[0], pick.w && counts[1], pick.c && counts[2], pick.m && counts[3]]
        .filter((c) => c !== false && c !== undefined)
        .map((c) => pad(c, 8))
        .join("") + (name ? ` ${name}` : "");
    if (rows.length) yield rows.map(line).join("\n") + "\n";
    return io.status;
  },

  share: async (args) => {
    const line = args.length ? args.join(" ") : history.slice(0, -1).findLast((h) => !/^share\b/.test(h));
    if (!line) return fail("share: there's nothing to share yet. Run a command first.");
    const url = `${location.origin}/?${new URLSearchParams({ run: line })}`;
    let copied = true;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      copied = false;
    }
    const frag = document.createDocumentFragment();
    frag.append(el("div", {}, `${copied ? "Copied a" : "A"} link that runs ${line}:`), el("div", {}, el("a", { href: url }, url)));
    return frag;
  },
  functions: () => [...functions.keys()].sort().join("\n") || null,

  // Webmentions (webmention.io collects them for this site): who linked to it, liked it, or replied.
  mentions: async (_, io) => {
    const targets = ["/", "/talks", "/resume"].map((p) => `target[]=${encodeURIComponent(`https://sferik.net${p}`)}`).join("&");
    let feed;
    try {
      const res = await fetch(`https://webmention.io/api/mentions.jf2?${targets}&per-page=20&sort-dir=down`, { signal: io.signal });
      feed = (await res.json()) as {
        children: { published?: string; "wm-received": string; author?: { name?: string }; "wm-property": string; url: string }[];
      };
    } catch {
      if (io.signal.aborted) throw new Interrupt();
      return fail("mentions: couldn't reach webmention.io");
    }
    if (!feed.children.length) return "No webmentions yet.";
    const what = table({ "like-of": "liked", "repost-of": "reposted", "in-reply-to": "replied to", "bookmark-of": "bookmarked" });
    return feed.children
      .map((m) => `${(m.published ?? m["wm-received"]).slice(0, 10)}  ${m.author?.name || "someone"} ${what[m["wm-property"]] ?? "mentioned"} it: ${m.url}`)
      .join("\n");
  },

  sort: async function* (args, io) {
    const { opts, rest } = getopts("sort", args, "rnuf");
    const lines = (await readAll(input(io, rest, "sort"))).split("\n");
    if (lines.at(-1) === "") lines.pop();
    const fold = (s: string) => (opts.f ? s.toLowerCase() : s);
    const text = (a: string, b: string) => (fold(a) < fold(b) ? -1 : fold(a) > fold(b) ? 1 : 0);
    const compare = opts.n ? (a: string, b: string) => (parseFloat(a) || 0) - (parseFloat(b) || 0) || text(a, b) : text;
    let sorted = lines.sort(compare);
    if (opts.r) sorted.reverse();
    if (opts.u) sorted = sorted.filter((line, i) => i === 0 || compare(line, sorted[i - 1]) !== 0);
    if (sorted.length) yield sorted.join("\n") + "\n";
    return io.status;
  },

  uniq: async function* (args, io) {
    const { opts, rest } = getopts("uniq", args, "cdu");
    const runs: [string, number][] = [];
    for await (const line of linesOf(input(io, rest.slice(0, 1), "uniq"))) {
      const last = runs.at(-1);
      if (last && last[0] === line) last[1]++;
      else runs.push([line, 1]);
    }
    const kept = runs.filter(([, n]) => (opts.d ? n > 1 : opts.u ? n === 1 : true));
    if (kept.length) yield kept.map(([line, n]) => (opts.c ? `${pad(n, 4)} ${line}` : line)).join("\n") + "\n";
    return io.status;
  },

  cut: async function* (args, io) {
    const { opts, rest } = getopts("cut", args, "s", "fcd");
    const list = opts.f ?? opts.c;
    if (!list) return fail("usage: cut -c list [file ...]\n       cut -f list [-s] [-d delim] [file ...]");
    // 1,3-5,7-: which fields (or characters), counting from 1.
    const ranges = String(list)
      .split(",")
      .map((part) => /^(\d*)-?(\d*)$/.exec(part))
      .map((m) => m && m[0] !== "" && m[0] !== "-" && [Number(m[1] || 1), m[0].includes("-") ? Number(m[2] || Infinity) : Number(m[1])]);
    if (ranges.some((r) => !r || !r[0])) return fail("cut: [-cf] list: illegal list value");
    const wanted = (i: number) => ranges.some((r) => r && i >= r[0] && i <= r[1]);
    const delim = opts.d ?? "\t";
    const out = [];
    for await (const line of linesOf(input(io, rest, "cut"))) {
      if (opts.c) out.push([...line].filter((_, i) => wanted(i + 1)).join(""));
      else if (!line.includes(delim)) {
        if (!opts.s) out.push(line);
      } else
        out.push(
          line
            .split(delim)
            .filter((_, i) => wanted(i + 1))
            .join(delim),
        );
    }
    if (out.length) yield out.join("\n") + "\n";
    return io.status;
  },

  jq: async function* (args, io) {
    const { opts, rest } = getopts("jq", args, "rc");
    const [filter = ".", ...files] = rest;
    let program;
    try {
      program = jqParse(filter);
    } catch (e) {
      return fail(`jq: error: ${(e as Error).message}\njq: 1 compile error`, 3);
    }
    let data;
    try {
      data = JSON.parse(await readAll(input(io, files.slice(0, 1), "jq")));
    } catch {
      return fail("jq: error (at <stdin>:0): Cannot parse the input as JSON", 2);
    }
    let results;
    try {
      results = jqRun(program, [data]);
    } catch (e) {
      return fail(`jq: error (at <stdin>:0): ${(e as Error).message}`, 5);
    }
    const show = (v: unknown) => (opts.r && typeof v === "string" ? v : JSON.stringify(v, null, opts.c ? undefined : 2));
    if (results.length) yield results.map(show).join("\n") + "\n";
    return 0;
  },

  tree: async (args) => {
    const { opts, rest } = getopts("tree", args, "adF", "LI");
    // tree's patterns: * is any run of characters, ? any one, and | sets one pattern off from the next.
    const skip = opts.I
      ? new RegExp(
          `^(?:${opts.I.replace(/[.+^${}()[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".")})$`,
        )
      : null;
    const root = rest[0] ?? ".";
    let node;
    try {
      node = resolve(root);
    } catch {
      return fail(`${root} [error opening dir]\n\n0 directories, 0 files`, 2);
    }
    if (!node || !isDir(node)) return fail(`${root} [error opening dir]\n\n0 directories, 0 files`, 2);
    const lines = [root];
    let dirs = 0;
    let files = 0;
    const depth = opts.L ? Number(opts.L) : Infinity;
    const visit = (dir: Dir, prefix: string, level: number) => {
      const kids = Object.entries(dir.children)
        .filter(([n, c]) => (opts.a || !n.startsWith(".")) && (!opts.d || isDir(c)) && !skip?.test(n))
        .sort(([a], [b]) => a.localeCompare(b));
      kids.forEach(([n, c], i) => {
        const lastKid = i === kids.length - 1;
        lines.push(`${prefix}${lastKid ? "└── " : "├── "}${n}${opts.F && isDir(c) ? "/" : ""}`);
        if (isDir(c)) {
          dirs++;
          if (level < depth) visit(c, prefix + (lastKid ? "    " : "│   "), level + 1);
        } else files++;
      });
    };
    visit(node, "", 1);
    lines.push("", `${dirs} ${dirs === 1 ? "directory" : "directories"}` + (opts.d ? "" : `, ${files} file${files === 1 ? "" : "s"}`));
    return lines.join("\n");
  },

  file: async (args) => {
    const { opts, rest } = getopts("file", args, "b");
    if (!rest.length)
      return fail(
        "Usage: file [-bcdDhiIkLnNprsvz] [--extension] [--mime-encoding] [--mime-type]\n            [-e testname] [-F separator] [-f namefile] [-m magicfiles] file ...",
      );
    const out = rest.map((f) => {
      let node = null;
      try {
        node = resolve(f);
      } catch {}
      const type = !node ? `cannot open \`${f}' (No such file or directory)` : isDir(node) ? "directory" : node.type;
      return opts.b ? type : `${f}: ${type}`;
    });
    return out.join("\n");
  },

  stat: async function* (args, io) {
    const { opts, rest } = getopts("stat", args, "x");
    if (!rest.length) return fail("usage: stat [-FLnq] [-f format | -l | -r | -s | -x] [-t timefmt] [file|handle ...]");
    const out = [];
    for (const f of rest) {
      let node;
      try {
        node = resolve(f);
      } catch {
        node = null;
      }
      if (!node) {
        io.err(`stat: ${f}: stat: No such file or directory`);
        io.status = 1;
        continue;
      }
      const { size, modified } = await info(node, io.signal);
      const dir = isDir(node);
      const mode = dir ? "drwxr-xr-x" : "-rw-r--r--";
      const links = isDir(node) ? 2 + Object.keys(node.children).length : 1;
      const inode = inodeOf(f);
      const when = stamp(modified);
      if (opts.x) {
        out.push(
          `  File: "${f}"`,
          `  Size: ${String(size).padEnd(12)} FileType: ${dir ? "Directory" : "Regular File"}`,
          `  Mode: (${dir ? "0755" : "0644"}/${mode})         Uid: (  501/  sferik)  Gid: (   20/   staff)`,
          `Device: 1,16   Inode: ${inode}    Links: ${links}`,
          ...["Access", "Modify", "Change", " Birth"].map((k) => `${k}: ${DAY[modified.getDay()]} ${when}`),
        );
      } else {
        const q = `"${when}"`;
        out.push(`16777232 ${inode} ${mode} ${links} sferik staff 0 ${size} ${q} ${q} ${q} ${q} 4096 ${Math.ceil(size / 4096) * 8} 0 ${f}`);
      }
    }
    if (out.length) yield out.join("\n") + "\n";
    return io.status;
  },

  cd: (args) => {
    const arg = args[0] ?? "~";
    let node;
    try {
      node = resolve(arg);
    } catch {
      return fail(`cd: Permission denied: '${arg}'`);
    }
    if (!node) return fail(`cd: The directory '${arg}' does not exist`);
    if (!isDir(node)) return fail(`cd: '${arg}' is not a directory`);
    go(node === FS ? "/" : node.url);
    return 0;
  },

  open: (args) => {
    const arg = args[0];
    if (!arg)
      return fail(
        "Usage: open [-e] [-t] [-f] [-W] [-R] [-n] [-g] [-h] [-s <partial SDK name>][-b <bundle identifier>] [-a <application>] [-u URL] [filenames] [--args arguments]",
      );
    let node = null;
    try {
      node = resolve(arg);
    } catch {}
    if (node) {
      go(node === FS ? "/" : node.url);
      return 0;
    }
    const key = arg.toLowerCase().replace(/^https?:\/\//, "");
    const site = SITES().find((s) => s.keys.includes(key));
    if (!site) return fail(`The file /Users/sferik/${arg} does not exist.`);
    window.open(site.href, "_blank", "noopener");
    return 0;
  },

  // The server renders the resume as a man page for text/plain requests.
  man: async (args, io) => {
    if (!args.length) return fail("What manual page do you want?\nFor example, try 'man man'.");
    if (args[0] === "sferik") return (await fetchText("/resume", io.signal)).replace(/\n$/, "");
    const entry = HELP[args[0]];
    if (!entry) return fail(`No manual entry for ${args[0]}`);
    const title = `${args[0].toUpperCase()}(1)`;
    const middle = "General Commands Manual";
    const left = Math.floor((80 - middle.length) / 2) - title.length;
    const summary = entry[1].replace(/\.$/, "");
    return [
      `${title}${" ".repeat(left)}${middle}${" ".repeat(80 - 2 * title.length - middle.length - left)}${title}`,
      "",
      "NAME",
      `     ${args[0]} – ${summary[0].toLowerCase()}${summary.slice(1)}`,
      "",
      "SYNOPSIS",
      `     ${entry[0]}`,
      "",
      "DESCRIPTION",
      `     ${entry[1]}`,
    ].join("\n");
  },

  // --------------------------------------------------------- network

  curl: async function* (args, io) {
    const { opts, rest } = getopts("curl", args, "sSIiLv", "XHAo", {
      output: ["o", true],
      silent: ["s"],
      head: ["I"],
      include: ["i"],
      location: ["L"],
      request: ["X", true],
      header: ["H", true],
      "user-agent": ["A", true],
    });
    if (!rest.length) return fail("curl: try 'curl --help' or 'curl --manual' for more information", 2);
    if (opts.o && opts.o !== "-")
      return fail(`Warning: Failed to open the file ${opts.o}: Read-only file system\ncurl: (23) Failure writing output to destination`, 23);
    const raw = rest[0];
    let url;
    try {
      if (/\s/.test(raw)) throw new TypeError(raw);
      // With no scheme, it's https, where curl's own guess is http: a page
      // that came by https can't ask for anything by http, so that never worked.
      url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return fail(`curl: (3) URL rejected: Malformed input to a URL function`, 3);
    }
    const own = /^(www\.)?sferik\.(com|org|net|me)$/.test(url.hostname) || url.host === location.host;
    const target = own ? url.pathname + url.search : url.href;
    const headers: Record<string, string> = {};
    for (const h of [opts.H ?? []].flat()) {
      const [k, ...v] = h.split(":");
      headers[k.trim()] = v.join(":").trim();
    }
    let res;
    try {
      res = await fetch(target, { method: opts.I ? "HEAD" : opts.X || "GET", headers, signal: io.signal });
    } catch {
      if (io.signal.aborted) throw new Interrupt();
      return fail(`curl: (7) Failed to connect to ${url.hostname} port ${url.port || (url.protocol === "https:" ? 443 : 80)}: Couldn't connect to server`, 7);
    }
    if (opts.I || opts.i) {
      const head = [`HTTP/1.1 ${res.status} ${REASONS[res.status] ?? res.statusText}`];
      res.headers.forEach((v, k) => head.push(`${k}: ${v}`));
      yield head.join("\n") + "\n\n";
    }
    if (opts.I) return 0;
    // Like curl: refuse to dump binary (say, the resume as a PDF) into the terminal.
    const binary = !/^(text\/|application\/(json|javascript|xml|x-latex|x-tex))/.test(res.headers.get("content-type") ?? "text/plain");
    if (binary && io.isatty && opts.o !== "-") {
      return fail(
        'Warning: Binary output can mess up your terminal. Use "--output -" to tell\nWarning: curl to output it to your terminal anyway, or consider "--output\nWarning: <FILE>" to save to a file.',
        23,
      );
    }
    yield await res.text();
    return 0;
  },

  gem: async (args, io) => {
    const [sub, ...rest] = args;
    if (sub === "--version" || sub === "-v") return "4.0.0";
    if (sub === "list") {
      let re;
      try {
        re = new RegExp(rest.find((a) => !a.startsWith("-")) ?? "", "i");
      } catch (e) {
        return fail(`ERROR:  While executing gem ... (RegexpError)\n    ${(e as Error).message}`);
      }
      const hits = GEMS.filter(([n]) => re.test(n)).map(([n, v]) => `${n} (${v})`);
      return ["", "*** LOCAL GEMS ***", "", ...hits].join("\n");
    }
    if (sub === "info" || sub === "specification") {
      const name = rest.find((a) => !a.startsWith("-"));
      if (!name) return fail("ERROR:  While executing gem ... (Gem::CommandLineError)\n    Please specify at least one gem name (e.g. gem build GEMNAME)");
      const res = await fetch(`https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`, { signal: io.signal });
      if (!res.ok) return fail(`ERROR:  Could not find a valid gem '${name}' (>= 0) in any repository`, 2);
      const g = await res.json();
      return [
        "",
        "*** REMOTE GEMS ***",
        "",
        `${g.name} (${g.version})`,
        `    Author${g.authors.includes(",") ? "s" : ""}: ${g.authors}`,
        `    Homepage: ${g.homepage_uri ?? g.project_uri}`,
        `    License${(g.licenses ?? []).length > 1 ? "s" : ""}: ${(g.licenses ?? []).join(", ") || "N/A"}`,
        `    Downloads: ${fmt(g.downloads)}`,
        "",
        ...wrap(g.info, 70).map((l) => "    " + l),
      ].join("\n");
    }
    if (!sub)
      return "RubyGems is a package manager for Ruby.\n\n  Usage:\n    gem -h/--help\n    gem -v/--version\n    gem list [PATTERN]\n    gem info GEMNAME";
    return fail(`ERROR:  While executing gem ... (Gem::UnknownCommandError)\n    Unknown command ${sub}`);
  },

  gh: async (args, io) => {
    const [sub, verb, ...rest] = args;
    const api = async <T>(path: string): Promise<T> => {
      const res = await fetch(`https://api.github.com/${path.replace(/^\//, "")}`, {
        headers: { accept: "application/vnd.github+json" },
        signal: io.signal,
      });
      if (!res.ok) {
        // Like gh: GitHub's own error message, e.g. "gh: Not Found (HTTP 404)".
        const body = await res.json().catch(() => ({}));
        throw new GhError(`gh: ${body.message ?? REASONS[res.status] ?? "Request failed"} (HTTP ${res.status})`);
      }
      return res.json() as Promise<T>;
    };
    interface GhRepo {
      full_name: string;
      description: string | null;
      fork: boolean;
      pushed_at: string;
      html_url: string;
    }
    try {
      if (sub === "api" && verb) return JSON.stringify(await api(verb), null, 2);
      if (sub === "repo" && verb === "list") {
        const { opts, rest: who } = getopts("gh", rest, "", "L", { limit: ["L", true] });
        const owner = who[0] ?? "sferik";
        const limit = Number(opts.L ?? 30);
        const [user, repos] = await Promise.all([
          api<{ public_repos: number }>(`users/${owner}`),
          api<GhRepo[]>(`users/${owner}/repos?sort=pushed&per_page=${limit}`),
        ]);
        if (!io.isatty) return repos.map((r) => [r.full_name, r.description ?? "", r.fork ? "public, fork" : "public", r.pushed_at].join("\t")).join("\n");
        const rows = repos.map((r) => [r.full_name, r.description ?? "", r.fork ? "public, fork" : "public", ago(new Date(r.pushed_at))]);
        const width = [40, 50, 12].map((cap, i) => Math.min(cap, Math.max(...rows.map((r) => r[i].length), 4)));
        const cut = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w));
        return [
          "",
          `Showing ${repos.length} of ${user.public_repos} repositories in @${owner}`,
          "",
          ...[["NAME", "DESCRIPTION", "INFO", "UPDATED"], ...rows].map(
            (r) => `${cut(r[0], width[0])}  ${cut(r[1], width[1])}  ${cut(r[2], width[2])}  ${r[3]}`,
          ),
        ].join("\n");
      }
      if (sub === "repo" && verb === "view") {
        const name = rest[0] ?? "sferik/sferik-web";
        const repo = await api<GhRepo>(`repos/${name.includes("/") ? name : `sferik/${name}`}`);
        return [repo.full_name, repo.description ?? "No description provided", "", `View this repository on GitHub: ${repo.html_url}`].join("\n");
      }
      if (sub === "auth" && verb === "status") return fail("You are not logged into any GitHub hosts. To log in, run: gh auth login");
      if (sub === "browse") {
        window.open("https://github.com/sferik", "_blank", "noopener");
        return 0;
      }
    } catch (e) {
      if (e instanceof GhError) return fail(e.message);
      throw e;
    }
    return fail(
      "Work seamlessly with GitHub from the command line.\n\nUSAGE\n  gh <command> <subcommand> [flags]\n\nCOMMANDS\n  api:         Make an authenticated GitHub API request\n  auth:        Authenticate gh and git with GitHub\n  browse:      Open repositories, issues, pull requests, and more in the browser\n  repo:        Manage repositories (list, view)",
    );
  },

  // ------------------------------------------------------------- git

  git: async (args, io) => {
    const [sub, ...rest] = args;
    const log1 = (sha: string, patch: boolean) => [...commitHeader(sha), ...(patch ? ["", ...OBJECTS[sha].diff!] : [])];
    switch (sub) {
      case "status":
        return "On branch main\nnothing to commit, working tree clean";
      case "diff":
        return 0;
      case "branch":
        return block(span("* "), span("main", "ok"));
      case "pull":
        return "Already up to date.";
      case "commit":
        return fail("On branch main\nnothing to commit, working tree clean");
      case "push":
        return rest.includes("--force") || rest.includes("-f") ? "Not on main, please." : "Everything up-to-date";
      case "ls-files":
        return "name";
      case "--version":
        return "git version 2.50.1 (Apple Git-155)";
      case "blame":
        if (!rest.length) return "Every line: @sferik.";
        if (rest[0] !== "name") return fail(`fatal: no such path '${rest[0]}' in HEAD`, 128);
        return `${RENAME.slice(0, 8)} (Erik Berlin ${OBJECTS[RENAME].blame} 1) Erik Berlin`;
      case "rev-parse": {
        const sha = findObject(rest[0]);
        return sha ?? fail(`${rest[0]}\nfatal: ambiguous argument '${rest[0]}': unknown revision or path not in the working tree.`, 128);
      }
      case "cat-file": {
        const { opts, rest: refs } = getopts("git cat-file", rest, "pts");
        const sha = findObject(refs[0]);
        if (!sha) return fail(`fatal: Not a valid object name ${refs[0]}`, 128);
        const obj = OBJECTS[sha];
        if (opts.t) return obj.type;
        if (opts.s) return String(new TextEncoder().encode(obj.body).length);
        return obj.body;
      }
      case "ls-tree": {
        const sha = findObject(`${rest[0] ?? "HEAD"}^{tree}`);
        return sha ? OBJECTS[sha].body : fail(`fatal: Not a valid object name ${rest[0]}`, 128);
      }
      case "hash-object": {
        const { opts, rest: files } = getopts("git hash-object", rest, "", "t", { stdin: ["stdin"] });
        const text = opts.stdin ? await readAll(io.stdin ?? io.tty()) : files.length ? await readAll(input(io, files, "git hash-object")) : null;
        if (text === null)
          return fail(
            "usage: git hash-object [-t <type>] [-w] [--path=<file> | --no-filters]\n                       [--stdin [--literally]] [--] <file>...",
            129,
          );
        return sha1(`${opts.t ?? "blob"} ${new TextEncoder().encode(text).length}\0${text}`);
      }
      case "log": {
        const n = rest.join(" ").match(/(?:^|\s)(?:-n\s*|--max-count=|-)(\d+)/);
        const limit = n ? Number(n[1]) : LOG.length;
        const patch = rest.includes("-p") || rest.includes("--patch");
        const shas = LOG.slice(0, limit);
        if (rest.includes("--oneline")) {
          return block(...shas.flatMap((sha, i) => [i ? "\n" : "", span(sha.slice(0, 7), "warn"), " " + message(sha)[0]]));
        }
        return gitColored(shas.flatMap((sha, i) => [...(i ? [""] : []), ...log1(sha, patch)]));
      }
      case "show": {
        const sha = findObject(rest.find((a) => !a.startsWith("-")));
        if (!sha) return fail(`fatal: ambiguous argument '${rest[0]}': unknown revision or path not in the working tree.`, 128);
        if (OBJECTS[sha].type !== "commit") return OBJECTS[sha].body;
        return gitColored(log1(sha, true));
      }
      default:
        return fail(sub ? `git: '${sub}' is not a git command. See 'git --help'.` : "usage: git [--version] [--help] <command> [<args>]");
    }
  },

  // ------------------------------------------------------ who's here
  // Everyone reading the site, live: a terminal per tab (checkIn, in site.ts).

  who: async (args) => {
    const { you, users } = await online();
    const line = (u: Who["users"][number]) => `sferik   ${u.tty.padEnd(13)}${whoDate(new Date(u.login))}`;
    return args.join(" ") === "am i" ? line(users.find((u) => u.tty === you)!) : users.map(line).join("\n");
  },
  w: async () => {
    const { you, users } = await online();
    return [
      uptime(users.length),
      "USER     TTY      FROM    LOGIN@  IDLE WHAT",
      ...users.map(
        (u) =>
          `sferik   ${u.tty.slice(3).padEnd(8)} -       ${clock(new Date(u.login)).padEnd(6)}  ${(u.idle < 60 ? "-" : String(Math.floor(u.idle / 60))).padStart(4)} ${u.tty === you ? "w" : DOING[u.page]}`,
      ),
    ].join("\n");
  },

  // write sferik: what you type (or pipe in) arrives in my email.
  write: async function* (args, io) {
    if (!args.length) return fail("usage: write user [tty]");
    if (args[0] !== "sferik") return fail(`write: ${args[0]} is not logged in`);
    if (!io.stdin && io.isatty) yield "Type your message, then Ctrl-D to send it, or Ctrl-C to cancel. Include your email address if you'd like a reply.\n";
    const text = await readAll(io.stdin ?? io.tty());
    if (!text.trim()) return fail("write: nothing to send");
    let res: Response;
    try {
      res = await fetch(`/write?tty=${(await online()).you}`, { method: "POST", body: text });
    } catch {
      return fail("write: sferik.net can't be reached, so nothing was sent");
    }
    const said = (await res.text()).trimEnd();
    if (!res.ok) return fail(said);
    yield said;
    return 0;
  },

  imgcat: async (args, io) => {
    if (!args.length) return fail("usage: imgcat file ...");
    const out = document.createDocumentFragment();
    for (const f of args) {
      const node = await openFile(io, f, "imgcat");
      if (!node) io.status = 1;
      else if (node.url !== FS.children["dependency.webp"].url) {
        io.err(`imgcat: ${f}: not an image`);
        io.status = 1;
      } else out.append(...blocks([(await getJSON<Dependency>("/dependency")).figure]));
    }
    return out.childNodes.length ? out : io.status;
  },
  last: (args) => {
    if (args[0] === "clear") {
      // Forget the visits, this one included: the next is a first visit again.
      forgetVisits = true;
      try {
        localStorage.removeItem("visits");
      } catch {}
      const login = $("[data-login]");
      if (login) login.textContent = "\u00a0";
      return null;
    }
    const visits = loadVisits();
    const lines = [`sferik    ttys000                   ${lastDate(LOGIN)}   still logged in`];
    for (const v of visits.slice(0, -1).reverse().slice(0, 20)) {
      const start = new Date(v.start);
      const end = new Date(v.end);
      const mins = Math.round((end.getTime() - start.getTime()) / 60000);
      const hhmm = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
      lines.push(`sferik    ttys000                   ${lastDate(start)} - ${clock(end)}  (${hhmm})`);
    }
    lines.push("", `wtmp begins ${lastDate(new Date(visits[0]?.start ?? LOGIN))}`);
    return lines.join("\n");
  },

  // ----------------------------------------------------------- macOS

  say: async (args, io) => {
    const { opts, rest } = getopts("say", args, "", "vro");
    const synth = window.speechSynthesis;
    if (!synth) return fail("say: speech synthesis isn't available in this browser");
    if (opts.v === "?") {
      return (
        synth
          .getVoices()
          .map((v) => `${v.name.padEnd(20)} ${v.lang.replace("-", "_").padEnd(8)}# Hello! My name is ${v.name}.`)
          .join("\n") || 0
      );
    }
    if (opts.o) return fail(`say: Could not open output file ${opts.o}: Read-only file system`);
    const text = rest.length ? rest.join(" ") : await readAll(io.stdin ?? io.tty());
    const utterance = new SpeechSynthesisUtterance(text);
    if (opts.r) utterance.rate = Math.min(10, Math.max(0.1, Number(opts.r) / 175));
    const voice = opts.v && synth.getVoices().find((v) => v.name.toLowerCase().startsWith(opts.v.toLowerCase()));
    if (opts.v && !voice) return fail(`Voice \`${opts.v}' not found.`);
    if (voice) utterance.voice = voice;
    const spoken = new Promise((resolve) => (utterance.onend = utterance.onerror = resolve));
    synth.speak(utterance);
    try {
      await abortable(spoken, io.signal);
    } finally {
      if (io.signal.aborted) synth.cancel();
    }
    return 0;
  },

  pbcopy: async (args, io) => {
    const text = await readAll(io.stdin ?? io.tty());
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return fail("pbcopy: the clipboard isn't available");
    }
    return 0;
  },
  pbpaste: async () => {
    try {
      return (await navigator.clipboard.readText()) || null;
    } catch {
      return fail("pbpaste: the clipboard isn't available");
    }
  },

  caffeinate: async function* (args, io) {
    const { opts, rest } = getopts("caffeinate", args, "dimsu", "tw");
    let lock = null;
    try {
      lock = await navigator.wakeLock?.request("screen");
    } catch {}
    try {
      if (rest.length) {
        yield* runSub(rest, io);
        return io.status;
      }
      await (opts.t ? sleep(Number(opts.t) * 1000, io.signal) : onAbort(io.signal));
    } finally {
      await lock?.release();
    }
    return 0;
  },

  shutdown: () => fail("shutdown: NOT super-user"),
  reboot: () => {
    location.reload();
    return null;
  },
  halt: () => fail("halt: Operation not permitted"),
  sudo: (args) => (args.join(" ") === "make me a sandwich" ? "okay." : fail("sferik is not in the sudoers file. This incident will be reported.")),

  // ------------------------------------------------------------- time

  date: (args) => {
    const { opts, rest } = getopts("date", args, "uR", "r");
    const when = opts.r ? new Date(Number(opts.r) * 1000) : new Date();
    if (Number.isNaN(when.getTime()))
      return fail(
        `date: illegal time format\nusage: date [-jnRu] [-I[date|hours|minutes|seconds]] [-f input_fmt]\n            [-r filename|seconds] [-v[+|-]val[y|m|w|d|H|M|S]]\n            [[[[mm]dd]HH]MM[[cc]yy][.SS] | new_date] [+output_fmt]`,
      );
    const format = rest.find((a) => a.startsWith("+"))?.slice(1) ?? (opts.R ? "%a, %d %b %Y %T %z" : "%a %b %e %T %Z %Y");
    return strftime(format, when, opts.u);
  },

  cal: (args) => {
    const { opts, rest } = getopts("cal", args, "3hy", "m");
    const now = new Date();
    const nums = rest.map(Number);
    if (nums.some((n) => !Number.isInteger(n)))
      return fail(`cal: ${rest.find((a) => !Number.isInteger(Number(a)))} is neither a month number (1..12) nor a name`);
    const month = opts.m ? Number(opts.m) - 1 : nums.length === 2 ? nums[0] - 1 : now.getMonth();
    const year = nums.length === 2 ? nums[1] : nums.length === 1 ? nums[0] : now.getFullYear();
    if (month < 0 || month > 11) return fail(`cal: ${month + 1} is neither a month number (1..12) nor a name`);
    const highlight = !opts.h;
    if (opts.y || (nums.length === 1 && !opts.m)) return calYear(year, now, highlight);
    if (opts[3]) {
      const months = [-1, 0, 1].map((d) => new Date(year, month + d, 1));
      return calSideBySide(months.map((m) => calLines(m.getFullYear(), m.getMonth(), now, highlight, true)));
    }
    return calMonth(year, month, now, highlight);
  },

  // ------------------------------------------------------------- toys

  cowsay: async (args, io) => cow(args, io, false),
  cowthink: async (args, io) => cow(args, io, true),

  fortune: (args) => {
    const { opts } = getopts("fortune", args, "slc");
    const pool = FORTUNES.filter(([q]) => (opts.s ? q.length <= 160 : opts.l ? q.length > 160 : true));
    const [quote, who] = pool[Math.floor(Math.random() * pool.length)];
    return (opts.c ? "(computers)\n%\n" : "") + wrap(quote, 72).join("\n") + `\n\t\t-- ${who}`;
  },

  sl: async function* (args, io) {
    const { opts } = getopts("sl", args, "el");
    if (!opts.e) io.trap();
    const art = opts.l ? LITTLE : D51;
    const width = 80;
    const frames = art.frames;
    const length = Math.max(...art.body.map((l) => l.length));
    const screen = document.createElement("pre");
    screen.className = "sl";
    yield screen;
    const draw = (x: number, frame: number) => {
      const rows = [...art.body, ...frames[frame]];
      screen.textContent = rows.map((row) => (" ".repeat(Math.max(0, x)) + row.slice(Math.max(0, -x))).slice(0, width)).join("\n");
    };
    if (reduceMotion) {
      draw(0, 0);
      return 0;
    }
    for (let x = width, f = 0; x > -length; x -= 2, f = (f + 1) % frames.length) {
      draw(x, f);
      await sleep(40, io.signal);
    }
    screen.remove();
    return 0;
  },

  yes: async function* (args, io) {
    const line = (args.length ? args.join(" ") : "y") + "\n";
    const batch = line.repeat(io.isatty ? 64 : 1);
    for (;;) {
      yield batch;
      if (io.isatty) await sleep(16, io.signal);
    }
  },

  figlet: async (args, io) => {
    const { opts, rest } = getopts("figlet", args, "clrkW", "fw");
    if (opts.f && opts.f !== "standard") return fail(`figlet: ${opts.f}: Unable to open font file`);
    const text = rest.length ? rest.join(" ") : (await readAll(io.stdin ?? io.tty())).replace(/\n$/, "");
    const font = await loadFont(io.signal);
    const width = Number(opts.w ?? 80);
    const mode = opts.W ? "full" : opts.k ? "kern" : "smush";
    const out = [];
    for (const para of text.split("\n")) {
      for (const lines of figletLines(font, para, width, mode)) {
        const w = Math.max(...lines.map((l) => l.length));
        out.push(
          ...lines.map((l) =>
            (opts.c ? " ".repeat(Math.max(0, Math.floor((width - w) / 2))) + l : opts.r ? " ".repeat(Math.max(0, width - w)) + l : l).replace(/\s+$/, ""),
          ),
        );
      }
    }
    return out.join("\n");
  },

  banner: async (args, io) => {
    const { opts, rest } = getopts("banner", args, "", "w");
    const text = rest.length ? rest.join(" ") : (await readAll(io.stdin ?? io.tty())).replace(/\n$/, "");
    return bannerText(text, Number(opts.w ?? 80));
  },

  // fish's random: an integer, a range with an optional step, a choice, or a seed.
  random: (args) => {
    if (args[0] === "choice") {
      if (args.length < 2) return fail("random: nothing to choose from");
      return args[1 + Math.floor(rand() * (args.length - 1))];
    }
    const bad = args.find((a) => !/^-?\d+$/.test(a));
    if (bad !== undefined) return fail(`random: ${bad}: invalid integer`);
    const n = args.map(Number);
    if (n.length === 1) {
      seed(n[0]);
      return 0;
    }
    if (n.length > 3) return fail("random: too many arguments");
    const [start, step, end] = n.length === 3 ? n : n.length === 2 ? [n[0], 1, n[1]] : [0, 1, 32767];
    if (step < 1) return fail("random: STEP must be a positive integer");
    if (end <= start) return fail("random: END must be greater than START");
    return String(start + step * Math.floor(rand() * (Math.floor((end - start) / step) + 1)));
  },

  // ------------------------------------------------------ miscellany

  make: (args) =>
    args.length ? fail(`make: *** No rule to make target \`${args[0]}'.  Stop.`, 2) : fail("make: *** No targets specified and no makefile found.  Stop.", 2),
  ping: async function* (args, io) {
    const { opts, rest } = getopts("ping", args, "q", "ci");
    const host = rest[0] ?? "sferik.net";
    const count = opts.c ? Number(opts.c) : Infinity;
    yield `PING ${host} (${host}): 56 data bytes\n`;
    const times: number[] = [];
    const summary = () =>
      `\n--- ${host} ping statistics ---\n${times.length} packets transmitted, ${times.length} packets received, 0.0% packet loss\n` +
      (times.length
        ? `round-trip min/avg/max/stddev = ${stats(times)
            .map((t) => t.toFixed(3))
            .join("/")} ms\n`
        : "");
    try {
      for (let seq = 0; seq < count; seq++) {
        if (seq) await sleep(Number(opts.i ?? 1) * 1000, io.signal);
        const start = performance.now();
        await abortable(
          fetch(`/robots.txt?ping=${seq}`, { cache: "no-store" }).catch(() => {}),
          io.signal,
        );
        times.push(performance.now() - start);
        if (!opts.q) yield `64 bytes from ${host}: icmp_seq=${seq} ttl=64 time=${times[seq].toFixed(3)} ms\n`;
      }
    } catch (e) {
      io.err(summary());
      throw e;
    }
    yield summary();
    return 0;
  },
  coffee: () => "Error 418: I'm a teapot.",
  hello: () => "Hello. Type help for a list of commands.",
  hi: () => "Hello. Type help for a list of commands.",
  "?": () =>
    [
      "Keyboard shortcuts (outside the prompt):",
      "  g h     home",
      "  g t     talks",
      "  g r     resume",
      "  j k     scroll down, up",
      "  g g     top",
      "  G       bottom",
      "  d       dark or light mode",
      "  /       jump to this prompt",
      "  ?       show these",
    ].join("\n"),
  qr: async (args, io) => {
    const text = args.length ? args.join(" ") : io.stdin ? (await readAll(io.stdin)).replace(/\n$/, "") : null;
    try {
      return text === null ? qrBlock(vcard(await getJSON<Finger>("/finger"), true), "A QR code of my contact card") : qrBlock(text, `A QR code of ${text}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  },
  matrix: () => {
    const root = document.documentElement;
    if (root.dataset.theme === "phosphor") delete root.dataset.theme;
    else root.dataset.theme = "phosphor";
    return "Wrong movie. Close enough.";
  },
});
COMMANDS.logout = COMMANDS.exit;

class GhError extends Error {}

// A seedable generator (mulberry32), so `random 42` makes what follows repeatable.
let state = Math.floor(Math.random() * 2 ** 32);
const seed = (n: number) => (state = n >>> 0);
function rand() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
}
const REASONS: Record<number, string> = {
  200: "OK",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  404: "Not Found",
  500: "Internal Server Error",
};

// ------------------------------------------------------------ helpers

const go = (url: string) => {
  if (location.pathname !== url) location.href = url;
};

async function* runSub(words: string[], io: IO): Stream {
  const statuses = [0];
  const [name, ...args] = words;
  yield* spawn(name, args, { ...io, isatty: io.isatty }, (code) => (statuses[0] = code));
  io.status = statuses[0];
}

// With no terminal to page, less and more just print, like they do into a pipe.
async function* pagerCommand(name: string, args: string[], io: IO, usage: string): AsyncGenerator<Chunk, number | Failure> {
  if (!args.length && !io.stdin) return fail(usage);
  yield* input(io, args, name);
  return io.status;
}

function headTailArgs(name: string, args: string[]) {
  const normalized = args.map((a) => (/^-\d+$/.test(a) ? `-n${a.slice(1)}` : a));
  const { opts, rest } = getopts(name, normalized, name === "tail" ? "qfF" : "q", "nc");
  const spec = String(opts.c ?? opts.n ?? 10);
  const count = Number(spec.replace(/^[+-]/, ""));
  if (!Number.isFinite(count)) throw new UsageError(`${name}: illegal ${opts.c ? "byte" : "line"} count -- ${spec}`);
  return { count, bytes: opts.c !== undefined, from: spec.startsWith("+"), follow: opts.f || opts.F, files: rest };
}

// Basic regular expressions: \( \) \| \+ \? \{ \} are special; bare ones are literal.
function bre(p: string) {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\" && "()|+?{}".includes(p[i + 1])) out += p[++i];
    else if ("()|+?{}".includes(c)) out += "\\" + c;
    else if (c === "\\") out += c + (p[++i] ?? "");
    else out += c;
  }
  return out;
}
function highlightMatches(line: string, re: RegExp): [string, boolean][] {
  const parts: [string, boolean][] = [];
  let at = 0;
  for (const m of line.matchAll(re)) {
    if (!m[0]) continue;
    parts.push([line.slice(at, m.index), false], [m[0], true]);
    at = m.index + m[0].length;
  }
  parts.push([line.slice(at), false]);
  return parts;
}
function grepLine(prefix: string, parts: [string, boolean][], color: boolean): Chunk {
  if (!color) return prefix + parts.map(([t]) => t).join("") + "\n";
  return block(prefix, ...parts.map(([t, hit]) => (hit ? span(t, "grep-match") : t)));
}
// Every regular file under a path, for grep -r.
function walk(path: string): string[] {
  let node = null;
  try {
    node = resolve(path);
  } catch {}
  if (!node || !isDir(node)) return [path];
  const base = path === "." ? "" : path.replace(/\/$/, "") + "/";
  return Object.entries(node.children)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([n, c]) => (isDir(c) ? walk(base + n) : [base + n]));
}

type Entry = [string, FSNode, { size: number; modified: Date } | null];
async function sortEntries(entries: [string, FSNode][], opts: Opts, signal: AbortSignal): Promise<Entry[]> {
  const withInfo = await Promise.all(entries.map(async ([n, node]): Promise<Entry> => [n, node, opts.l || opts.t || opts.S ? await info(node, signal) : null]));
  if (opts.t) withInfo.sort((a, b) => b[2]!.modified.getTime() - a[2]!.modified.getTime());
  else if (opts.S) withInfo.sort((a, b) => b[2]!.size - a[2]!.size);
  else withInfo.sort(([a], [b]) => Number(a > b) - Number(a < b));
  if (opts.r) withInfo.reverse();
  return withInfo;
}
const lsName = (n: string, node: FSNode) => (isDir(node) ? span(n, "ls-dir") : n);
function columns(out: HTMLElement, names: [string, FSNode][]) {
  const widest = Math.max(...names.map(([n]) => n.length));
  const col = (Math.floor(widest / 8) + 1) * 8;
  const perRow = Math.max(1, Math.floor(80 / col));
  const rows = Math.ceil(names.length / perRow);
  for (let r = 0; r < rows; r++) {
    if (r) out.append("\n");
    for (let c = 0; c < perRow; c++) {
      const item = names[c * rows + r];
      if (!item) break;
      const next = names[(c + 1) * rows + r];
      out.append(lsName(item[0], item[1]), next ? " ".repeat(col - item[0].length) : "");
    }
  }
  out.append("\n");
}
function longListing(out: HTMLElement, entries: Entry[], opts: Opts, label: string | null) {
  const rows = entries.map(([n, node, info]) => {
    const meta = info!;
    const dir = isDir(node);
    return {
      n: n + (opts.F && dir ? "/" : ""),
      node,
      mode: dir ? "drwxr-xr-x" : "-rw-r--r--",
      links: String(dir ? 2 + Object.keys(node.children).length : 1),
      size: opts.h ? human(meta.size) : String(meta.size),
      date: lsDate(meta.modified),
      blocks: dir ? 0 : Math.ceil(meta.size / 4096) * 8,
    };
  });
  const lw = Math.max(...rows.map((r) => r.links.length));
  const sw = Math.max(...rows.map((r) => r.size.length));
  if (label) out.append(`total ${rows.reduce((t, r) => t + r.blocks, 0)}\n`);
  for (const r of rows) out.append(`${r.mode}  ${pad(r.links, lw)} sferik  staff  ${pad(r.size, sw)} ${r.date} `, lsName(r.n, r.node), "\n");
}
const human = (n: number) => (n < 1024 ? `${n}B` : n < 10240 ? `${(n / 1024).toFixed(1)}K` : `${Math.round(n / 1024)}K`);
function lsDate(d: Date) {
  const recent = Math.abs(Date.now() - d.getTime()) < 182 * 864e5;
  return `${MON[d.getMonth()]} ${pad(d.getDate(), 2)} ${recent ? clock(d) : pad(d.getFullYear(), 5)}`;
}
const clock = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const stamp = (d: Date) => `${MON[d.getMonth()]} ${pad(d.getDate(), 2)} ${clock(d)}:${String(d.getSeconds()).padStart(2, "0")} ${d.getFullYear()}`;
const whoDate = (d: Date) => `${MON[d.getMonth()]} ${pad(d.getDate(), 2)} ${clock(d)}`;
// Who's logged in: everyone reading the site, or, when it can't be reached
// (or has no terminal free), just you.
async function online(): Promise<Who> {
  try {
    const who = await checkIn();
    if (who.you) return who;
  } catch {}
  return { you: "ttys000", users: [{ tty: "ttys000", page: "/", login: LOGIN.toISOString(), idle: 0 }] };
}
// What w says someone's doing: the command their page shows.
const DOING: Record<string, string> = { "/": "-fish", "/talks": "ls -lt ~/talks", "/resume": "man sferik" };
// The computer's been up since the first commit to the name's repository.
const uptime = (users: number) =>
  `${clock(new Date())}  up ${fmt(Math.floor((Date.now() - Date.parse("2008-05-14T20:36:12Z")) / 864e5))} days, ${users} user${users === 1 ? "" : "s"}, load averages: 1.12 0.98 0.87`;
const lastDate = (d: Date) => `${DAY[d.getDay()]} ${MON[d.getMonth()]} ${pad(d.getDate(), 2)} ${clock(d)}`;
function stats(xs: number[]) {
  const avg = xs.reduce((a, b) => a + b) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - avg) ** 2, 0) / xs.length);
  return [Math.min(...xs), avg, Math.max(...xs), sd];
}
function inodeOf(path: string) {
  let h = 2166136261;
  for (const c of path) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return 10000000 + ((h >>> 0) % 89999999);
}
function ago(date: Date) {
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  const units: [string, number][] = [
    ["year", 31536e3],
    ["month", 2592e3],
    ["day", 864e2],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [u, n] of units) if (s >= n) return `about ${Math.floor(s / n)} ${u}${Math.floor(s / n) > 1 ? "s" : ""} ago`;
  return "less than a minute ago";
}

// jq, the useful part: paths (., .key, .a.b, .[n], .["key"], .[]) joined by
// pipes, and keys and length. Values flow through as lists, like jq's streams.
type JqStep = { key: string } | { index: number } | { each: true } | { builtin: "keys" | "length" };
function jqParse(filter: string): JqStep[][] {
  return filter.split("|").map((part) => {
    const text = part.trim();
    if (text === "keys" || text === "length") return [{ builtin: text }];
    if (!text.startsWith(".")) throw new Error(`syntax error: ${text || "an empty filter"} isn't something this jq knows (., .key, .[n], .[], keys, length)`);
    const steps: JqStep[] = [];
    const token = /\.?(?:([A-Za-z_]\w*)|\[\]|\[(-?\d+)\]|\["([^"]*)"\])/y;
    for (let at = 1; at < text.length; at = token.lastIndex) {
      token.lastIndex = at;
      const m = token.exec(text);
      if (!m) throw new Error(`syntax error at "${text.slice(at)}"`);
      steps.push(m[1] !== undefined ? { key: m[1] } : m[2] !== undefined ? { index: Number(m[2]) } : m[3] !== undefined ? { key: m[3] } : { each: true });
    }
    return steps;
  });
}
function jqRun(program: JqStep[][], inputs: unknown[]): unknown[] {
  return program.reduce((values, steps) => values.flatMap((v) => steps.reduce<unknown[]>((vs, step) => vs.flatMap((x) => jqStep(step, x)), [v])), inputs);
}
function jqStep(step: JqStep, x: unknown): unknown[] {
  const kind = x === null ? "null" : Array.isArray(x) ? "array" : typeof x;
  const what = `${kind} (${JSON.stringify(x)})`;
  if ("builtin" in step && step.builtin === "length") {
    if (kind === "array" || kind === "string") return [(x as string | unknown[]).length];
    if (kind === "object") return [Object.keys(x as object).length];
    if (kind === "number") return [Math.abs(x as number)];
    if (kind === "null") return [0];
    throw new Error(`${what} has no length`);
  }
  if ("builtin" in step) {
    if (kind === "array") return [[...(x as unknown[]).keys()]];
    if (kind === "object") return [Object.keys(x as object).sort()];
    throw new Error(`${what} has no keys`);
  }
  if ("each" in step) {
    if (kind === "array") return x as unknown[];
    if (kind === "object") return Object.values(x as object);
    throw new Error(`Cannot iterate over ${kind === "null" ? "null" : what}`);
  }
  if (kind === "null") return [null];
  if ("key" in step) {
    if (kind === "object") return [Object.hasOwn(x as object, step.key) ? (x as Record<string, unknown>)[step.key] : null];
    throw new Error(`Cannot index ${kind} with "${step.key}"`);
  }
  if (kind === "array") return [(x as unknown[]).at(step.index) ?? null];
  throw new Error(`Cannot index ${kind} with number`);
}

// Word-wrap text to a width, keeping existing line breaks.
function wrap(text: string, width: number): string[] {
  return text.split("\n").flatMap((para) => {
    const lines = [];
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    return lines;
  });
}

async function sha1(text: string) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Visits to this site from this browser, for `last`.
interface Visit {
  start: number;
  end: number;
}
function loadVisits(): Visit[] {
  try {
    return JSON.parse(localStorage.getItem("visits") ?? "null") ?? [];
  } catch {
    return [];
  }
}
let forgetVisits = false; // last clear: this visit isn't recorded either
function recordVisit() {
  const visits = loadVisits();
  visits.push({ start: LOGIN.getTime(), end: LOGIN.getTime() });
  const save = () => {
    if (forgetVisits) return;
    visits[visits.length - 1].end = Date.now();
    try {
      localStorage.setItem("visits", JSON.stringify(visits.slice(-50)));
    } catch {}
  };
  save();
  addEventListener("pagehide", save);
}

async function fetchText(url: string, signal: AbortSignal) {
  const res = await fetch(url, { headers: { accept: "text/plain" }, signal });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

function strftime(format: string, d: Date, utc?: boolean): string {
  const get = (k: "FullYear" | "Month" | "Date" | "Day" | "Hours" | "Minutes" | "Seconds"): number => d[`get${utc ? "UTC" : ""}${k}` as `get${typeof k}`]();
  const z = (n: number, w = 2) => String(n).padStart(w, "0");
  const offset = utc ? 0 : -d.getTimezoneOffset();
  const zone = utc ? "UTC" : new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")!.value;
  const start = utc ? Date.UTC(get("FullYear"), 0, 1) : new Date(get("FullYear"), 0, 1).getTime();
  const map: Record<string, () => string> = {
    a: () => DAY[get("Day")],
    A: () => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][get("Day")],
    b: () => MON[get("Month")],
    h: () => MON[get("Month")],
    B: () => ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][get("Month")],
    c: () => strftime("%a %b %e %T %Y", d, utc),
    d: () => z(get("Date")),
    D: () => strftime("%m/%d/%y", d, utc),
    e: () => pad(get("Date"), 2),
    F: () => strftime("%Y-%m-%d", d, utc),
    H: () => z(get("Hours")),
    I: () => z(get("Hours") % 12 || 12),
    j: () => z(Math.floor((d.getTime() - start) / 864e5) + 1, 3),
    k: () => pad(get("Hours"), 2),
    l: () => pad(get("Hours") % 12 || 12, 2),
    m: () => z(get("Month") + 1),
    M: () => z(get("Minutes")),
    n: () => "\n",
    p: () => (get("Hours") < 12 ? "AM" : "PM"),
    r: () => strftime("%I:%M:%S %p", d, utc),
    R: () => strftime("%H:%M", d, utc),
    s: () => String(Math.floor(d.getTime() / 1000)),
    S: () => z(get("Seconds")),
    t: () => "\t",
    T: () => strftime("%H:%M:%S", d, utc),
    u: () => String(get("Day") || 7),
    w: () => String(get("Day")),
    y: () => z(get("FullYear") % 100),
    Y: () => String(get("FullYear")),
    z: () => (offset < 0 ? "-" : "+") + z(Math.floor(Math.abs(offset) / 60)) + z(Math.abs(offset) % 60),
    Z: () => zone,
    "%": () => "%",
  };
  return format.replace(/%(.)/g, (m, c) => (map[c] ? map[c]() : m));
}

// One month as lines of 20 columns, like BSD cal.
type CalLine = (string | Node)[];
function calLines(year: number, month: number, now: Date, highlight: boolean, padRows: boolean | "year"): CalLine[] {
  const title = `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month]}${padRows === "year" ? "" : ` ${year}`}`;
  const lines: CalLine[] = [[" ".repeat(Math.floor((20 - title.length) / 2)) + title]];
  lines.push(["Su Mo Tu We Th Fr Sa"]);
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  let row: CalLine = ["   ".repeat(first)];
  for (let d = 1; d <= days; d++) {
    const today = highlight && year === now.getFullYear() && month === now.getMonth() && d === now.getDate();
    const cell = pad(d, 2);
    row.push(today ? span(cell, "cal-today") : cell, (first + d) % 7 && d < days ? " " : "");
    if ((first + d) % 7 === 0 || d === days) {
      lines.push(row);
      row = [];
    }
  }
  while (padRows && lines.length < 8) lines.push([""]);
  return lines.map((parts) => {
    const len = parts.reduce((n: number, p) => n + (typeof p === "string" ? p.length : p.textContent!.length), 0);
    return [...parts, " ".repeat(Math.max(0, 20 - len))];
  });
}
function calMonth(year: number, month: number, now: Date, highlight: boolean): HTMLElement {
  const out = block();
  calLines(year, month, now, highlight, false).forEach((parts, i) => out.append(...(i ? ["\n"] : []), ...parts));
  const tail = out.lastChild as Text;
  tail.data = tail.data.replace(/\s+$/, "");
  return out;
}
function calSideBySide(months: CalLine[][]) {
  const out = block();
  for (let r = 0; r < months[0].length; r++) {
    if (r) out.append("\n");
    months.forEach((m, i) => out.append(...(i ? ["  "] : []), ...m[r]));
  }
  return out;
}
function calYear(year: number, now: Date, highlight: boolean) {
  const out = block(" ".repeat(29) + year + "\n\n");
  for (let q = 0; q < 4; q++) {
    const months = [0, 1, 2].map((i) => calLines(year, q * 3 + i, now, highlight, "year"));
    const part = calSideBySide(months);
    out.append(...part.childNodes, q < 3 ? "\n" : "");
  }
  return out;
}

async function cow(args: string[], io: IO, thinking: boolean) {
  const name = thinking ? "cowthink" : "cowsay";
  const { opts, rest } = getopts(name, args, "bdgnpstwy", "eTW");
  const text = rest.length ? rest.join(" ") : (await readAll(io.stdin ?? io.tty())).replace(/\n$/, "");
  const modes: Record<string, string> = { b: "==", d: "XX", g: "$$", p: "@@", s: "**", t: "--", w: "OO", y: ".." };
  const eyes = (
    opts.e ??
    Object.keys(modes)
      .map((k) => opts[k] && modes[k])
      .find(Boolean) ??
    "oo"
  )
    .slice(0, 2)
    .padEnd(2);
  const tongue = (opts.T ?? (opts.d || opts.s ? "U " : "  ")).slice(0, 2).padEnd(2);
  const lines = opts.n ? text.split("\n") : wrap(text, Number(opts.W ?? 40) - 1);
  const width = Math.max(...lines.map((l) => l.length));
  const edge = (i: number) => {
    if (thinking) return ["(", ")"];
    if (lines.length === 1) return ["<", ">"];
    return i === 0 ? ["/", "\\"] : i === lines.length - 1 ? ["\\", "/"] : ["|", "|"];
  };
  const trail = thinking ? "o" : "\\";
  return [
    " " + "_".repeat(width + 2),
    ...lines.map((l, i) => `${edge(i)[0]} ${l.padEnd(width)} ${edge(i)[1]}`),
    " " + "-".repeat(width + 2),
    `        ${trail}   ^__^`,
    `         ${trail}  (${eyes})\\_______`,
    `            (__)\\       )\\/\\`,
    `             ${tongue} ||----w |`,
    `                ||     ||`,
  ].join("\n");
}

// ---------------------------------------------------------- figlet
// The font, fetched once (figlet.ts draws with it).

let fontPromise: Promise<Font> | null = null;
function loadFont(signal: AbortSignal): Promise<Font> {
  fontPromise ??= fetch("/share/standard.flf", { signal })
    .then((r) => r.text())
    .then(parseFont)
    .catch((e) => {
      fontPromise = null;
      throw e;
    });
  return fontPromise;
}

// BSD banner: big letters printed sideways, drawn with a canvas.
function bannerText(text: string, width: number) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const size = width;
  ctx.font = `bold ${size}px ui-monospace, Menlo, monospace`;
  const advance = Math.ceil(ctx.measureText("M").width);
  canvas.width = size;
  canvas.height = advance * text.length;
  ctx.font = `bold ${size}px ui-monospace, Menlo, monospace`;
  ctx.fillStyle = "#000";
  ctx.textBaseline = "alphabetic";
  [...text].forEach((ch, i) => {
    ctx.save();
    ctx.translate(size * 0.2, i * advance);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rows = [];
  for (let y = 0; y < canvas.height; y += 2) {
    let row = "";
    for (let x = 0; x < canvas.width; x++) row += data[(y * canvas.width + x) * 4 + 3] > 96 ? "#" : " ";
    rows.push(row.replace(/\s+$/, ""));
  }
  return rows.join("\n");
}

const FORTUNES = [
  ["Premature optimization is the root of all evil.", "Donald Knuth"],
  ["Simplicity is prerequisite for reliability.", "Edsger W. Dijkstra"],
  ["There are only two hard things in Computer Science: cache invalidation and naming things.", "Phil Karlton"],
  ["Talk is cheap. Show me the code.", "Linus Torvalds"],
  ["Programs must be written for people to read, and only incidentally for machines to execute.", "Harold Abelson and Gerald Jay Sussman"],
  ["Make it work, make it right, make it fast.", "Kent Beck"],
  ["Optimism is an occupational hazard of programming: feedback is the treatment.", "Kent Beck"],
  ["Controlling complexity is the essence of computer programming.", "Brian W. Kernighan"],
  ["Those who don't understand Unix are condemned to reinvent it, poorly.", "Henry Spencer"],
  [
    "Debugging is twice as hard as writing the code in the first place. Therefore, if you write the code as cleverly as possible, you are, by definition, not smart enough to debug it.",
    "Brian W. Kernighan",
  ],
  [
    "I hope to see Ruby help every programmer in the world to be productive, and to enjoy programming, and to be happy. That is the primary purpose of Ruby language.",
    "Yukihiro Matsumoto",
  ],
];

// Gems by @sferik, with versions as of 2026-10-01.
const GEMS = [
  ["active_emoji", "0.0.2"],
  ["amountable", "0.6.0"],
  ["bluepill", "0.1.3"],
  ["buftok", "1.0.1"],
  ["cheat", "1.3.3"],
  ["congress", "0.3.0"],
  ["delayed_job", "4.2.0"],
  ["delayed_job_active_record", "4.1.11"],
  ["delayed_job_mongoid", "3.0.0"],
  ["direct_employers", "0.0.6"],
  ["equalizer", "1.0.0"],
  ["equitable", "1.0.0"],
  ["faraday_middleware", "1.2.1"],
  ["fcc_reboot", "0.2.3"],
  ["futures_pipeline", "0.2.1"],
  ["gemcutter", "0.7.1"],
  ["gems", "3.0.0"],
  ["geoip_server", "1.3.0"],
  ["http", "6.0.4"],
  ["http-form_data", "3.0.1"],
  ["httpauth", "0.2.1"],
  ["hyperimage", "0.0.1"],
  ["impressionist", "2.0.0"],
  ["itty", "10"],
  ["linkedin", "1.1.1"],
  ["memoizable", "0.5.1"],
  ["merb-admin", "0.8.8"],
  ["minitest-memory", "1.1.0"],
  ["minitest-strict", "1.0.1"],
  ["mlb", "0.11.0"],
  ["mtgox", "1.1.0"],
  ["multi_json", "1.21.2"],
  ["multi_xml", "0.9.1"],
  ["naught", "2.3.0"],
  ["nba", "0.2.0"],
  ["oa-basic", "0.3.2"],
  ["oa-core", "0.3.2"],
  ["oa-enterprise", "0.3.2"],
  ["oa-more", "0.3.2"],
  ["oa-oauth", "0.3.2"],
  ["oa-openid", "0.3.2"],
  ["oauth2", "2.0.25"],
  ["octokit", "10.0.0"],
  ["omniauth", "2.1.4"],
  ["omniauth-oauth", "1.2.1"],
  ["omniauth-oauth2", "1.9.0"],
  ["omniauth-soundcloud", "1.0.1"],
  ["open311", "0.3.1"],
  ["openai", "0.97.0"],
  ["pager", "1.0.1"],
  ["rails-admin", "0.0.0"],
  ["rails_admin", "3.3.0"],
  ["simple_oauth", "1.0.1"],
  ["simplecov", "1.3.2"],
  ["simplecov-html", "0.13.2"],
  ["t", "5.0.0"],
  ["tesla", "0.0.1"],
  ["travis-lint", "2.0.0"],
  ["tweetstream", "2.6.1"],
  ["twitter", "8.3.2"],
  ["twurl", "0.9.7"],
  ["unparser", "0.9.0"],
  ["validates_url_format_of", "0.4.2"],
  ["x", "0.19.0"],
  ["xml_mini", "0.1.0"],
];

// The trains from sl(1), by Toyoda Masashi.
const D51 = {
  body: [
    "      ====        ________                ___________ ",
    "  _D _|  |_______/        \\__I_I_____===__|_________| ",
    "   |(_)---  |   H\\________/ |   |        =|___ ___|   ",
    "   /     |  |   H  |  |     |   |         ||_| |_||   ",
    "  |      |  |   H  |__--------------------| [___] |   ",
    "  | ________|___H__/__|_____/[][]~\\_______|       |   ",
    "  |/ |   |-----------I_____I [][] []  D   |=======|__ ",
  ],
  frames: [
    [
      "__/ =| o |=-~~\\  /~~\\  /~~\\  /~~\\ ____Y___________|__ ",
      " |/-=|___|=    ||    ||    ||    |_____/~\\___/        ",
      "  \\_/      \\O=====O=====O=====O_/      \\_/            ",
    ],
    [
      "__/ =| o |=-~~\\  /~~\\  /~~\\  /~~\\ ____Y___________|__ ",
      " |/-=|___|=O=====O=====O=====O   |_____/~\\___/        ",
      "  \\_/      \\__/  \\__/  \\__/  \\__/      \\_/            ",
    ],
  ],
};
const LITTLE = {
  body: ["     ++      +------ ", "     ||      |+-+ |  ", "   /---------|| | |  ", "  + ========  +-+ |  "],
  frames: [
    [" _|--O========O~\\-+  ", "//// \\_/      \\_/    "],
    [" _|--/~\\------/~\\-+  ", "//// \\_O========O    "],
  ],
};

// ------------------------------------------------------------ terminal

const SUGGESTIONS = ["help", "whoami", "ls", "cd talks", "cd resume", "man sferik", "finger", "open github", "curl sferik.net/resume"];
const isCommand = (word: string) => word in COMMANDS || functions.has(word) || ["for", "function", "end"].includes(word);
const suggest = (v: string) => {
  if (!v.trim()) return "";
  const hit = [...history]
    .reverse()
    .concat(SUGGESTIONS)
    .find((h) => h.startsWith(v) && h !== v);
  return hit ? hit.slice(v.length) : "";
};

// fish-style highlighting: commands blue (red if unknown), quotes yellow, operators green.
function highlight(v: string): [string, string][] {
  const parts: [string, string][] = [];
  const re = /(\s+)|(\|\||&&|[|;])|('[^']*'?|"(?:\\.|[^"])*"?)|((?:\\.|[^\s|;'"&]|&(?!&))+)/g;
  let commandNext = true;
  let m;
  while ((m = re.exec(v))) {
    if (m[1]) parts.push([m[0], ""]);
    else if (m[2]) {
      parts.push([m[0], "hl-op"]);
      commandNext = true;
    } else if (m[3]) {
      parts.push([m[0], "hl-quote"]);
      commandNext = false;
    } else {
      parts.push([m[0], commandNext ? (isCommand(m[0]) ? "hl-cmd" : "hl-err") : ""]);
      commandNext = false;
    }
  }
  return parts;
}
// Spans for v[from, to), colored.
function render(v: string, from: number, to: number) {
  const out = [];
  let at = 0;
  for (const [text, cls] of highlight(v)) {
    const a = Math.max(from, at);
    const b = Math.min(to, at + text.length);
    if (a < b) out.push(span(v.slice(a, b), cls));
    at += text.length;
  }
  return out;
}

const cursor = span("", "cursor");
function paint() {
  const v = field.value;
  const pos = field.selectionStart!;
  const sug = pos === v.length && !job ? suggest(v) : "";
  // At the end of the line, the cursor sits on the suggestion's first
  // character, as in fish, so the suggestion follows right on from the text.
  cursor.textContent = v.slice(pos, pos + 1) || sug.slice(0, 1);
  cursor.classList.toggle("suggesting", sug !== "");
  echo.replaceChildren(
    ...(job ? [span(v.slice(0, pos))] : render(v, 0, pos)),
    cursor,
    ...(job ? [span(v.slice(pos + 1))] : render(v, pos + 1, v.length)),
    span(sug.slice(1), "hl-suggest"),
  );
}

// The visual bell: the screen flashes, as in a terminal set not to beep.
function bell() {
  const screen = $("[data-scroller]")!;
  screen.classList.remove("bell");
  void screen.offsetWidth; // restart the flash if it's already going
  screen.classList.add("bell");
  setTimeout(() => screen.classList.remove("bell"), 150);
}

function setPrompt() {
  const failed = lastStatus.some((s) => s !== 0);
  promptEl.replaceChildren(span("sferik", "ps-user"), "@mbp ", span("~", "ps-cwd"), ...(failed ? [" ", span(`[${lastStatus.join("|")}]`, "err")] : []), "> ");
}

// Where a command line's output goes: text accumulates in a pre-wrap block,
// DOM output (colored listings, the comic) is appended as-is.
function terminalFor(): Terminal {
  let textBlock: HTMLElement | null = null;
  let raw = "";
  const write = ((chunk: Chunk) => {
    if (chunk instanceof Node) {
      const node = chunk instanceof DocumentFragment ? block(chunk) : chunk;
      if (chunk instanceof DocumentFragment) (node as HTMLElement).className = "repl-rich";
      log.append(node);
      textBlock = null;
      return;
    }
    if (!textBlock) {
      textBlock = block();
      raw = "";
      log.append(textBlock);
    }
    if (chunk.includes("\x07")) {
      bell();
      chunk = chunk.replaceAll("\x07", "");
    }
    raw = (raw + chunk).slice(-65536);
    textBlock.textContent = raw.replace(/\n$/, "");
  }) as Terminal;
  write.reset = () => (textBlock = null);
  return write;
}

function echoLine(value: string, suffix = "") {
  const line = block();
  line.append(promptEl.cloneNode(true), ...render(value, 0, value.length), suffix);
  log.append(line);
}

// Set by a command that scrolls the page to a section, so the prompt doesn't
// scroll back into view and hide it when the command finishes.
let jumped = false;
// Whether the page follows output down as it prints, and where it last put
// the page (see the scroller, below).
let follow = false;
let pinned = 0;

async function submit(value: string) {
  cancelAnimationFrame(restore); // the output decides where the page goes now
  pager.replaceChildren();
  jumped = false;
  follow = true;
  pinned = 0;
  field.value = "";
  const line = value.trim();
  echoLine(value);
  if (!line) return paint();
  history.push(line);
  hIndex = history.length;
  saveHistory();
  let stmts;
  try {
    stmts = grouped(parse(line));
  } catch (e) {
    log.append(block(`fish: ${(e as Error).message}`));
    lastStatus = [127];
    setPrompt();
    return paint();
  }
  const controller = new AbortController();
  const terminal = terminalFor();
  job = { controller, terminal, trapped: false, reader: null, queue: [] };
  repl.classList.add("running");
  paint();
  try {
    await runAll(stmts, terminal, controller.signal);
  } catch {
    // Only interrupts get this far; spawn() reports every other error.
    lastStatus = [130];
  }
  job = null;
  repl.classList.remove("running");
  setPrompt();
  paint();
  if (ended || jumped) return;
  field.scrollIntoView({ block: "nearest" });
}

let ended = false;
function endSession() {
  ended = true;
  queueMicrotask(() => {
    log.append(block(span("\n[Process completed]", "dim")));
    repl.classList.add("ended");
  });
}
function restart() {
  ended = false;
  repl.classList.remove("ended");
  log.replaceChildren(block("Type ", span("help", "hl-cmd"), " for a list of commands"));
  lastStatus = [0];
  setPrompt();
  paint();
}

// Complete the word before the cursor. One match fills it in; several
// extend to their common prefix, then list them under the prompt.
function complete() {
  const v = field.value.slice(0, field.selectionStart!);
  const rest = field.value.slice(field.selectionStart!);
  const segment = v
    .split(/\|\||&&|[|;]/)
    .pop()!
    .replace(/^\s+/, "");
  const words = segment.split(/\s+/);
  const word = words[words.length - 1];
  const cmd = words.length > 1 ? words[0] : null;
  const ref = /\$(\w*)$/.exec(word);
  let candidates;
  if (ref) candidates = Object.keys(vars()).map((n) => word.slice(0, ref.index + 1) + n);
  else if (!cmd) candidates = Object.keys(COMMANDS).filter((k) => /^[a-z][\w-]*$/.test(k));
  else if (word.startsWith("-") && HELP[cmd]) candidates = flagsOf(HELP[cmd][0]);
  else if (words.length === 2 && cmd === "help") candidates = Object.keys(HELP);
  else if (words.length === 2 && cmd === "man") candidates = ["sferik", ...Object.keys(HELP)];
  else if (words.length === 2 && cmd === "share") candidates = Object.keys(COMMANDS).filter((k) => /^[a-z][\w-]*$/.test(k));
  else if (cmd === "git")
    candidates =
      words.length === 2
        ? ["blame", "branch", "cat-file", "diff", "hash-object", "log", "ls-files", "ls-tree", "pull", "push", "rev-parse", "show", "status"]
        : ["HEAD", "name", RENAME.slice(0, 7), INITIAL.slice(0, 7)];
  else if (cmd === "gem") candidates = words.length === 2 ? ["info", "list"] : GEMS.map(([n]) => n);
  else if (cmd === "gh") candidates = words.length === 2 ? ["api", "auth", "browse", "repo"] : ["list", "view", "status"];
  else {
    const slash = word.lastIndexOf("/");
    const dirPart = word.slice(0, slash + 1);
    let dir = null;
    try {
      dir = resolve(dirPart || ".");
    } catch {}
    const names = dir && isDir(dir) ? Object.entries(dir.children).filter(([n]) => !n.startsWith(".") || word.slice(slash + 1).startsWith(".")) : [];
    const paths = names.filter(([, c]) => cmd !== "cd" || isDir(c)).map(([n, c]) => dirPart + n + (isDir(c) ? "/" : ""));
    candidates = cmd === "open" ? [...paths, ...SITES().map((s) => s.keys[0])] : paths;
  }
  const hits = [...new Set(candidates)].filter((c) => c.startsWith(word)).sort();
  if (!hits.length) return bell();
  let fill = hits[0];
  for (const h of hits) while (!h.startsWith(fill)) fill = fill.slice(0, -1);
  if (hits.length === 1 && !fill.endsWith("/")) fill += " ";
  if (fill.length > word.length) {
    field.value = v.slice(0, v.length - word.length) + fill + rest;
    const at = field.value.length - rest.length;
    field.setSelectionRange(at, at);
    paint();
  } else {
    paint();
    pager.textContent = hits.join("   ");
  }
}

// ---------------------------------------------------------------- input

// Typing at the prompt doesn't scroll the page down to it (browsers bring
// the caret into view), so you can type while reading further up.
let restore = 0;
field.addEventListener("beforeinput", () => {
  const kept = scroller.scrollTop;
  restore = requestAnimationFrame(() => (scroller.scrollTop = kept));
});
field.addEventListener("input", () => {
  if (search) {
    search.skip = 0;
    showSearch();
  } else pager.replaceChildren();
  paint();
});

// Save history, but not the commands the page ran: every visit runs those again.
function saveHistory() {
  try {
    localStorage.setItem(SAVED, JSON.stringify(history.filter((_, i) => i < seededAt || i >= seededAt + seeded).slice(-500)));
  } catch {}
}

// Ctrl-R searches history, newest first, for lines with what's typed in them;
// Ctrl-R again finds the next older one. Enter (or → or Tab) takes the line,
// Escape (or Ctrl-G or Ctrl-C) puts back what was there.
let search: { original: string; skip: number } | null = null;
function searched(): string | undefined {
  const query = field.value.toLowerCase();
  return [...new Set(history.toReversed())].filter((h) => h.toLowerCase().includes(query))[search!.skip];
}
function showSearch() {
  const match = searched();
  pager.textContent = match === undefined ? `(failed reverse-i-search)'${field.value}'` : `(reverse-i-search)'${field.value}': ${match}`;
}
function endSearch(accept: boolean) {
  field.value = accept ? (searched() ?? field.value) : search!.original;
  search = null;
  pager.replaceChildren();
  paint();
}
field.addEventListener("keyup", paint);
field.addEventListener("click", paint);
field.addEventListener("focus", () => repl.classList.add("focused"));
field.addEventListener("blur", () => repl.classList.remove("focused"));
// Clicking the shell focuses the prompt, unless you're selecting text to copy.
const selecting = () => getSelection()!.toString() !== "";
repl.addEventListener("click", () => selecting() || field.focus({ preventScroll: true }));
// Like a terminal window, the page follows a command's output down as it
// prints. Scrolling up to read stops that; scrolling back to the bottom picks
// it up again.
const scroller = $("[data-scroller]")!;
// Output can arrive more often than the browser reports scrolling, so this
// checks where the page is each time output arrives: above where it was put
// means you scrolled up, and at the bottom of the output so far means you
// scrolled back down.
let height = 0;
new MutationObserver(() => {
  if (scroller.scrollTop + scroller.clientHeight >= height - 2) follow = true;
  else if (scroller.scrollTop < pinned - 1) follow = false;
  if (follow && !jumped && !selecting()) {
    scroller.scrollTop = scroller.scrollHeight;
    pinned = scroller.scrollTop;
  }
  height = scroller.scrollHeight;
}).observe(log, { childList: true, subtree: true, characterData: true });
// Scrolling to the bottom of the page puts the cursor at the prompt, unless
// you're typing somewhere else or selecting text.
scroller.addEventListener(
  "scroll",
  () => {
    const bottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (!bottom || document.activeElement!.matches("input, textarea") || selecting()) return;
    field.focus({ preventScroll: true });
  },
  { passive: true },
);

// Buttons like the commit hash type a command for you. The page renders them
// after the shell starts, so listen on the document.
document.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLElement>("[data-run]");
  if (!button || selecting() || job) return;
  field.focus();
  submit(button.dataset.run!);
});

field.addEventListener("keydown", (e) => {
  if (ended) {
    e.preventDefault();
    return restart();
  }
  const atEnd = field.selectionStart === field.value.length;
  const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
  if (job) {
    // A command is running: typed lines go to it; Ctrl-C interrupts; Ctrl-D ends its input.
    if (ctrl && e.key === "c") {
      e.preventDefault();
      job.terminal("^C\n");
      if (!job.trapped) job.controller.abort();
    } else if (ctrl && e.key === "d" && !field.value) {
      e.preventDefault();
      deliver(null);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const line = field.value;
      field.value = "";
      log.append(block(line));
      job.terminal.reset();
      deliver(line);
      paint();
    }
    return;
  }
  if (ctrl && e.key === "r") {
    e.preventDefault();
    if (!search) search = { original: field.value, skip: 0 };
    else if (searched() !== undefined) {
      search.skip++;
      if (searched() === undefined) search.skip--; // past the oldest match, stay on it
    }
    return showSearch();
  }
  if (search) {
    if (e.key === "Enter" || e.key === "ArrowRight" || e.key === "End" || e.key === "Tab") {
      e.preventDefault();
      return endSearch(true);
    }
    if (e.key === "Escape" || (ctrl && (e.key === "g" || e.key === "c"))) {
      e.preventDefault();
      return endSearch(false);
    }
  }
  // Emacs-style line editing, as in fish. (Alt+B on a Mac types ∫, so the keys go by code.)
  const at = field.selectionStart!;
  const v = field.value;
  const lineEdit = (value: string, cursor: number) => {
    e.preventDefault();
    field.value = value;
    field.setSelectionRange(cursor, cursor);
    paint();
  };
  const alt = e.altKey && !e.ctrlKey && !e.metaKey;
  const wordBack = () => v.slice(0, at).search(/\w*\W*$/);
  const wordForward = () => at + /^\W*\w*/.exec(v.slice(at))![0].length;
  if (ctrl && e.key === "a") return lineEdit(v, 0);
  if (ctrl && e.key === "e" && !(atEnd && suggest(v))) return lineEdit(v, v.length);
  if (ctrl && e.key === "u") return lineEdit(v.slice(at), 0);
  if (ctrl && e.key === "k") return lineEdit(v.slice(0, at), at);
  if (ctrl && e.key === "w") {
    const start = v.slice(0, at).search(/\S*\s*$/);
    return lineEdit(v.slice(0, start) + v.slice(at), start);
  }
  if (alt && e.code === "KeyB") return lineEdit(v, wordBack());
  if (alt && e.code === "KeyF") return lineEdit(v, wordForward());
  if (e.key === "Enter") {
    e.preventDefault();
    submit(field.value);
  } else if ((e.key === "ArrowRight" || e.key === "End" || (ctrl && (e.key === "f" || e.key === "e"))) && atEnd && suggest(field.value)) {
    e.preventDefault();
    field.value += suggest(field.value);
    paint();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (hIndex > 0) field.value = history[--hIndex];
    requestAnimationFrame(paint);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    hIndex = Math.min(history.length, hIndex + 1);
    field.value = history[hIndex] || "";
    requestAnimationFrame(paint);
  } else if (ctrl && e.key === "l") {
    e.preventDefault();
    log.replaceChildren();
  } else if (ctrl && e.key === "c" && field.selectionStart === field.selectionEnd) {
    // Ctrl-C abandons the line, as in a terminal, unless text is selected to copy.
    e.preventDefault();
    echoLine(field.value, "^C");
    field.value = "";
    paint();
  } else if (ctrl && e.key === "d") {
    // fish: delete the character under the cursor, or exit on an empty line.
    e.preventDefault();
    if (!field.value) {
      echoLine("");
      endSession();
    } else {
      const at = field.selectionStart!;
      field.value = field.value.slice(0, at) + field.value.slice(at + 1);
      field.setSelectionRange(at, at);
      paint();
    }
  } else if (e.key === "Tab") {
    e.preventDefault();
    complete();
  } else if (e.key === "Escape") {
    field.blur();
  }
});

function deliver(line: string | null) {
  const current = job!;
  const reader = current.reader;
  current.reader = null;
  if (reader) reader(line);
  else current.queue.push(line);
}

recordVisit();
setPrompt();
paint();
repl.dataset.ready = ""; // for the tests, and anything else that needs to know

// A link can run a command: sferik.net/?run=man+sferik. It runs once the page
// is built, and comes off the address, so reloading (or ?run=reboot) doesn't run it again.
const linked = new URLSearchParams(location.search).get("run");
if (linked) {
  window.history.replaceState(null, "", location.pathname + location.hash);
  void ready.then(() => {
    field.focus({ preventScroll: true });
    return submit(linked);
  });
}
