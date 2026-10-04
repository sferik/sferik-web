/*
 * sferik.com shell
 *
 * A small fish-flavored shell over the site's own files. It supports pipes,
 * `;`, `&&`, and `||`, quoting and $variables, exit statuses, streaming output
 * (so `yes | head -3` stops), Ctrl-C to interrupt, and Ctrl-D for end of input.
 * Commands that read input with nothing piped in read lines you type, like a
 * real terminal.
 */
import { $, $$, fmt, MON, reduceMotion, span } from "./dom.js";
import { blocks, getJSON } from "./site.js";
import type { Whoami } from "../types.js";

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
      if (!(key in long)) throw new UsageError(`${name}: unrecognized option '--${key}'`);
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
  children: {
    ".plan": { url: "/.plan", type: "ASCII text" },
    "humans.txt": { url: "/humans.txt", type: "ASCII text" },
    "index.html": { url: "/", type: HTML },
    resume: { url: "/resume", children: { "index.html": { url: "/resume", type: HTML } } },
    "robots.txt": { url: "/robots.txt", type: "ASCII text" },
    talks: { url: "/talks", children: { "index.html": { url: "/talks", type: HTML } } },
  },
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
        const text = await res.text();
        const modified = new Date(res.headers.get("last-modified") || Date.now());
        return { text, size: new TextEncoder().encode(text).length, modified };
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

// Expand a glob like *.txt or talks/* against the tree.
function glob(pattern: string): string[] {
  const slash = pattern.lastIndexOf("/");
  const dirPart = slash >= 0 ? pattern.slice(0, slash) : "";
  const dir = dirPart ? resolve(dirPart) : FS;
  const re = new RegExp(
    "^" +
      pattern
        .slice(slash + 1)
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
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
  const at = { HEAD: RENAME, "HEAD^": INITIAL, "HEAD~1": INITIAL, main: RENAME };
  if (ref in at) return at[ref as keyof typeof at];
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

const history: string[] = [];
let hIndex = 0;
let lastStatus: number[] = [0];
const vars = (): Record<string, string> => ({
  status: String(lastStatus[lastStatus.length - 1]),
  pipestatus: lastStatus.join(" "),
  USER: "sferik",
  HOME: "/Users/sferik",
  PWD: "/Users/sferik",
  SHELL: "/opt/homebrew/bin/fish",
  TERM: "xterm-256color",
  version: "4.1.2",
  hostname: "mbp",
});

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
async function runPipeline(tokens: Token[][], terminal: Terminal, signal: AbortSignal): Promise<number[]> {
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
  const command = COMMANDS[name];
  if (!command) {
    io.err(`fish: Unknown command: ${name}`);
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

const COMMANDS: Record<string, Command> = {
  // Only the main commands. The fun ones are for finding.
  help: () =>
    [
      "Commands work like they do in a real shell: pipes, &&, ||, ;, quotes, $status.",
      "",
      "  whoami          who is this",
      "  ls, cd, cat     look around: talks/, resume/, humans.txt",
      "  man sferik      the resume, as a man page",
      "  finger          how to reach me",
      "  open <site>     github, x, bluesky, mastodon, linkedin, rubygems, mail, ...",
      "  curl <url>      this site's API, e.g. curl sferik.com/resume",
      "  clear           clear the screen",
      "",
      "Ctrl-C interrupts, Ctrl-D ends input, Tab completes, → accepts a suggestion.",
      "There are a few others. You'll know them when you find them.",
    ].join("\n"),

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

  true: () => 0,
  false: () => 1,
  pwd: () => "/Users/sferik",
  hostname: () => "mbp",
  uname: (args) => (args.includes("-a") ? "Darwin mbp 27.0.0 Darwin Kernel Version 27.0.0: RELEASE_ARM64 arm64" : "Darwin"),
  uptime: () => {
    const days = Math.floor((Date.now() - Date.parse("2008-05-14T20:36:12Z")) / 864e5);
    return `${clock(new Date())}  up ${fmt(days)} days, 2 users, load averages: 1.12 0.98 0.87`;
  },

  echo: async function* (args) {
    const { opts, rest } = getopts("echo", args, "nse");
    let out = rest.join(opts.s ? "" : " ");
    if (opts.e) out = out.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    yield opts.n ? out : out + "\n";
    return 0;
  },

  history: () => history.slice(0, -1).reverse().join("\n") || null,
  clear: () => {
    log.replaceChildren();
    return null;
  },
  exit: () => {
    endSession();
    return null;
  },

  fish: (args) => (args[0] === "--version" ? "fish, version 4.1.2" : "You're already in fish."),
  bash: () => "Nah. fish is nicer.",
  zsh: () => "Nah. fish is nicer.",

  finger: async (args, io) => {
    $("#finger")?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
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

  tree: async (args) => {
    const { opts, rest } = getopts("tree", args, "adF", "LI");
    const skip = opts.I ? new RegExp(`^(?:${opts.I.replace(/[.+^${}()[\]\\]/g, "\\$&").replace(/\*/g, ".*")})$`) : null;
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
    if (args[0] !== "sferik") return fail(`No manual entry for ${args[0]}`);
    return (await fetchText("/resume", io.signal)).replace(/\n$/, "");
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
      url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
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
        const name = rest[0] ?? "sferik/sferik.com";
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

  who: (args) => {
    if (args.join(" ") === "am i") return `sferik   ttys000      ${whoDate(LOGIN)}`;
    return `sferik   console      ${whoDate(LOGIN)}\nsferik   ttys000      ${whoDate(LOGIN)}`;
  },
  w: () => {
    const now = new Date();
    return [
      `${clock(now)}  up ${fmt(Math.floor((now.getTime() - Date.parse("2008-05-14T20:36:12Z")) / 864e5))} days, 2 users, load averages: 1.12 0.98 0.87`,
      "USER     TTY      FROM    LOGIN@  IDLE WHAT",
      `sferik   console  -       ${clock(LOGIN)}      - -`,
      `sferik   s000     -       ${clock(LOGIN)}      - w`,
    ].join("\n");
  },
  last: () => {
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
  reboot: () => fail("reboot: Operation not permitted"),
  halt: () => fail("halt: Operation not permitted"),
  sudo: (args) => (args.join(" ") === "make me a sandwich" ? "okay." : fail("sferik is not in the sudoers file. This incident will be reported.")),
  rm: (args) => {
    const files = args.filter((a) => !a.startsWith("-"));
    if (!files.length) return fail("usage: rm [-f | -i] [-dIPRrvWx] file ...\n       unlink [--] file", 64);
    return fail(files.map((f) => `rm: ${f}: Operation not permitted${f === "/" || f.startsWith("/") ? ". Nice try." : ""}`).join("\n"));
  },

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
    const host = rest[0] ?? "sferik.com";
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
  ruby: () => "ruby 4.0.0 (2025-12-25) +PRISM [arm64-darwin27]\nUse irb for an interactive session.",
  irb: () => 'irb(main):001> "hello".reverse\n=> "olleh"',
  cargo: () => "    Finished `release` profile [optimized] target(s) in 0.00s",
  go: () => "Go is a tool for managing Go source code.",
  node: () => 'Welcome to Node.js. Type ".help" for more information.',
  python: () => "Python 3.14.0\n>>> import this\nBeautiful is better than ugly.",
  coffee: () => "Error 418: I'm a teapot.",
  hello: () => "Hello. Type help for a list of commands.",
  hi: () => "Hello. Type help for a list of commands.",
  42: () => "The answer is in the source.",
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
  matrix: () => {
    const root = document.documentElement;
    if (root.dataset.theme === "phosphor") delete root.dataset.theme;
    else root.dataset.theme = "phosphor";
    return "Wrong movie. Close enough.";
  },
};
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
function recordVisit() {
  const visits = loadVisits();
  visits.push({ start: LOGIN.getTime(), end: LOGIN.getTime() });
  const save = () => {
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
// FIGlet's standard font, with its controlled smushing rules (1–4).

interface Font {
  hardblank: string;
  height: number;
  glyphs: Record<number, string[]>;
}
let fontPromise: Promise<Font> | null = null;
function loadFont(signal: AbortSignal): Promise<Font> {
  fontPromise ??= fetch("/share/standard.flf", { signal })
    .then((r) => r.text())
    .then((flf) => {
      const lines = flf.split("\n");
      const [header] = lines;
      const [, hardblank, height, , , , comments] = /^flf2a(.) (\d+) (\d+) (\d+) (-?\d+) (\d+)/.exec(header)!;
      const glyphs: Record<number, string[]> = {};
      let at = 1 + Number(comments);
      const h = Number(height);
      for (let code = 32; code < 127; code++) {
        const rows = lines.slice(at, at + h).map((row) => row.replace(/\s+$/, "").replace(/(.)\1?$/, ""));
        glyphs[code] = rows;
        at += h;
      }
      return { hardblank, height: h, glyphs };
    })
    .catch((e) => {
      fontPromise = null;
      throw e;
    });
  return fontPromise;
}
function smushChar(a: string, b: string, hardblank: string): string | null {
  if (a === " ") return b;
  if (b === " ") return a;
  if (a === hardblank || b === hardblank) return null;
  if (a === b) return a; // rule 1: equal characters
  const under = "|/\\[]{}()<>";
  if (a === "_" && under.includes(b)) return b; // rule 2: underscore
  if (b === "_" && under.includes(a)) return a;
  const classes = ["|", "/\\", "[]", "{}", "()", "<>"]; // rule 3: hierarchy
  const ca = classes.findIndex((c) => c.includes(a));
  const cb = classes.findIndex((c) => c.includes(b));
  if (ca >= 0 && cb >= 0 && ca !== cb) return ca > cb ? a : b;
  if ("[] ][ {} }{ () )(".split(" ").includes(a + b)) return "|"; // rule 4: opposite pair
  return null;
}
type Mode = "full" | "kern" | "smush";
function addGlyph(lines: string[], glyph: string[], mode: Mode, hardblank: string): string[] {
  if (!lines[0].length || mode === "full") return lines.map((l, i) => l + glyph[i]);
  let overlap = Infinity;
  lines.forEach((l, i) => {
    const trail = l.length - l.replace(/ +$/, "").length;
    const lead = glyph[i].length - glyph[i].replace(/^ +/, "").length;
    let o = trail + lead;
    const a = l[l.length - 1 - trail];
    const b = glyph[i][lead];
    if (mode === "smush" && a && b && smushChar(a, b, hardblank)) o++;
    overlap = Math.min(overlap, o, glyph[i].length);
  });
  return lines.map((l, i) => {
    const g = glyph[i];
    const keep = l.slice(0, Math.max(0, l.length - overlap));
    let merged = "";
    for (let k = 0; k < overlap; k++) {
      // The overlap was chosen so every overlapping pair smushes.
      merged += smushChar(l[l.length - overlap + k], g[k], hardblank);
    }
    return keep + merged + g.slice(overlap);
  });
}
function figletLines(font: Font, text: string, width: number, mode: Mode): string[][] {
  const blocks = [];
  let lines = Array(font.height).fill("");
  for (const ch of text) {
    const glyph = font.glyphs[ch.charCodeAt(0)] ?? font.glyphs[63];
    const next = addGlyph(lines, glyph, mode, font.hardblank);
    if (Math.max(...next.map((l) => l.length)) > width && lines[0].length) {
      blocks.push(lines);
      lines = addGlyph(Array(font.height).fill(""), glyph, mode, font.hardblank);
    } else lines = next;
  }
  blocks.push(lines);
  return blocks.map((b) => b.map((l) => l.split(font.hardblank).join(" ")));
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

const SUGGESTIONS = ["help", "whoami", "ls", "cd talks", "cd resume", "man sferik", "finger", "open github", "curl sferik.com/resume"];
const isCommand = (word: string) => word in COMMANDS;
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
  cursor.textContent = v.slice(pos, pos + 1);
  echo.replaceChildren(
    ...(job ? [span(v.slice(0, pos))] : render(v, 0, pos)),
    cursor,
    ...(job ? [span(v.slice(pos + 1))] : render(v, pos + 1, v.length)),
    span(sug, "hl-suggest"),
  );
}

function setPrompt() {
  const failed = lastStatus.some((s) => s !== 0);
  promptEl.replaceChildren(span("sferik", "p-user"), "@mbp ", span("~", "p-cwd"), ...(failed ? [" ", span(`[${lastStatus.join("|")}]`, "err")] : []), "> ");
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

async function submit(value: string) {
  pager.replaceChildren();
  field.value = "";
  const line = value.trim();
  echoLine(value);
  if (!line) return paint();
  history.push(line);
  hIndex = history.length;
  let lists;
  try {
    lists = parse(line);
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
  for (const { conn, pipeline } of lists) {
    if ((conn === "&&" && lastStatus.at(-1) !== 0) || (conn === "||" && lastStatus.at(-1) === 0)) continue;
    try {
      lastStatus = await runPipeline(pipeline, terminal, controller.signal);
    } catch {
      // Only interrupts get this far; spawn() reports every other error.
      lastStatus = [130];
      break;
    }
  }
  job = null;
  repl.classList.remove("running");
  setPrompt();
  paint();
  if (ended) return;
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
  let candidates;
  if (!cmd) candidates = Object.keys(COMMANDS).filter((k) => /^[a-z][\w-]*$/.test(k));
  else if (cmd === "man") candidates = ["sferik"];
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
  if (!hits.length) return;
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

field.addEventListener("input", () => {
  pager.replaceChildren();
  paint();
});
field.addEventListener("keyup", paint);
field.addEventListener("click", paint);
field.addEventListener("focus", () => repl.classList.add("focused"));
field.addEventListener("blur", () => repl.classList.remove("focused"));
// Clicking the shell focuses the prompt, unless you're selecting text to copy.
const selecting = () => getSelection()!.toString() !== "";
repl.addEventListener("click", () => selecting() || field.focus());
// Scrolling to the bottom of the page puts the cursor at the prompt, unless
// you're typing somewhere else or selecting text.
const scroller = $("[data-scroller]")!;
scroller.addEventListener(
  "scroll",
  () => {
    if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2) return;
    if (document.activeElement!.matches("input, textarea") || selecting()) return;
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
  if (e.key === "Enter") {
    e.preventDefault();
    submit(field.value);
  } else if ((e.key === "ArrowRight" || e.key === "End" || (ctrl && e.key === "f")) && atEnd && suggest(field.value)) {
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
