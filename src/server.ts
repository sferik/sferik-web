/*
 * sferik.com server
 *
 * Every page and module is one URL with three representations, chosen by the
 * Accept header (or a .json / .txt suffix):
 *
 *   text/html         the page, which builds itself from the JSON below
 *   application/json  structured data (the resume follows jsonresume.org)
 *   text/plain        terminal output, so `curl sferik.com/whoami` just works
 *
 * Live numbers (downloads, stars, contributions, the latest push) are fetched
 * from RubyGems and GitHub on the server, cached, and fall back to the
 * snapshots in data/ when those services are slow or down.
 *
 * No dependencies: node src/server.ts (Node strips the types), then open
 * http://localhost:3745. The same app runs on Cloudflare Workers (src/worker.ts),
 * which supplies its files and a store for the live data.
 */
import { Buffer } from "node:buffer";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Contributions, Day, Finger, Home, ModuleId, Modules, NameChange, ProjectsFile, Push, Resume, Src, Talks, Whoami, Profile } from "./types.js";

const WIDTH = 80;
const PROMPT = "sferik@mbp ~> ";

// ------------------------------------------------------------- formatting

const fmt = (n: number) => n.toLocaleString("en-US");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
export const stripTags = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ENTITIES[e]);
const plain = (md: string) => md.replace(/\*\*?([^*]+)\*\*?/g, "$1"); // **bold** and *italic* → text

// Word-wrap to a width, keeping paragraph breaks.
export function wrap(text: string, width = WIDTH, indent = ""): string[] {
  return text
    .split("\n")
    .flatMap((para) => {
      const lines: string[] = [];
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        if (line && indent.length + line.length + 1 + word.length > width) {
          lines.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      lines.push(line);
      return lines;
    })
    .map((l) => (l ? indent + l : l));
}
const short = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e7
      ? `${Math.round(n / 1e6)}M`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(1)}M`
        : n >= 1e4
          ? `${Math.round(n / 1e3)}k`
          : `${(n / 1e3).toFixed(1)}k`;
const stars = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);
const monthYear = (ym: string) => `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const bare = (url: string) => url.replace(/^https:\/\/(www\.)?/, ""); // fits in 80 columns; terminals still link it

function longestStreak(days: Day[]) {
  let best = 0;
  let run = 0;
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

// ------------------------------------------------------------- live data

// A cache that serves stale values while it refreshes, so pages never wait on
// a slow API once warmed. Failed refreshes keep the old value until the next TTL.
//
// Or, given a store (Cloudflare KV, where memory doesn't outlive a request), a
// scheduled job loads every value into it (refresh mode) and requests only read
// it, so they never wait on RubyGems or GitHub.
export interface Store {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}
interface LiveOptions {
  fetch: typeof globalThis.fetch;
  offline: boolean;
  now: () => number;
  timeout: number;
  token?: string;
  store?: Store;
  refresh?: boolean;
}
interface Entry {
  at: number;
  value?: unknown;
  pending?: Promise<unknown> | null;
}
export type Live = ReturnType<typeof createLive>;

function createLive({ fetch, offline, now, timeout, token, store, refresh }: LiveOptions) {
  const cache = new Map<string, Entry>();
  const headers: Record<string, string> = { "user-agent": "sferik.com", accept: "application/json", ...(token && { authorization: `Bearer ${token}` }) };

  async function getJSON<T>(url: string): Promise<T> {
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), timeout);
    try {
      const res = await fetch(url, { headers, signal: timer.signal });
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }

  function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T | undefined> {
    if (offline) return Promise.resolve(undefined);
    if (store) {
      if (!refresh) return store.get(key) as Promise<T | undefined>;
      // A failed load keeps what the store already has.
      return load().then(
        async (value) => {
          await store.put(key, value);
          return value;
        },
        () => store.get(key) as Promise<T | undefined>,
      );
    }
    let entry = cache.get(key);
    if (!entry) cache.set(key, (entry = { at: -Infinity }));
    const e = entry;
    if (now() - e.at >= ttl && !e.pending) {
      e.pending = load()
        .then(
          (value) => (e.value = value),
          () => {},
        )
        .finally(() => {
          e.at = now();
          e.pending = null;
        });
    }
    // Wait only for a first load. Once one has settled, answer at once with the
    // last good value, or nothing (meaning: use the snapshot) if every load failed.
    return ("value" in e || !e.pending ? Promise.resolve(e.value) : e.pending.then(() => e.value)) as Promise<T | undefined>;
  }

  const HOUR = 3600e3;
  return {
    // Every gem @sferik owns: name → downloads.
    gems: () =>
      cached("gems", HOUR, async () => {
        const list = await getJSON<{ name: string; downloads: number }[]>("https://rubygems.org/api/v1/owners/sferik/gems.json");
        return Object.fromEntries(list.map((g) => [g.name, g.downloads])) as Record<string, number>;
      }),
    stars: (repo: string) =>
      cached(`stars:${repo}`, 6 * HOUR, async () => (await getJSON<{ stargazers_count: number }>(`https://api.github.com/repos/${repo}`)).stargazers_count),
    contributions: () =>
      cached(
        "contributions",
        HOUR,
        async () => (await getJSON<{ contributions: Day[] }>("https://github-contributions-api.jogruber.de/v4/sferik?y=last")).contributions,
      ),
    lastPush: () =>
      cached("push", 5 * 60e3, async (): Promise<Push | null> => {
        type Event = { type: string; repo: { name: string }; payload?: { head?: string }; created_at: string };
        const events = await getJSON<Event[]>("https://api.github.com/users/sferik/events/public?per_page=30");
        const ev = events.find((e) => e.type === "PushEvent" && e.payload?.head);
        return ev ? { repo: ev.repo.name, sha: ev.payload!.head!, at: ev.created_at } : null;
      }),
  };
}

// --------------------------------------------------------------- modules
// Each module is a JSON document plus a plain-text rendering of it.

interface DataFiles {
  profile: Profile;
  whoami: { command: string; blocks: Whoami["blocks"] };
  projects: ProjectsFile;
  contributions: { contributions: Day[] };
  name: NameChange;
  talks: Talks;
  resume: Resume;
}
type Read = <K extends keyof DataFiles>(name: K) => Promise<DataFiles[K]>;

function createModules({ live, read }: { live: Live; read: Read }) {
  async function projectsData(): Promise<Src> {
    const data = await read("projects");
    const gems = await live.gems();
    const projects = await Promise.all(
      data.projects.map(async (p) => {
        const liveStars = p.repo ? await live.stars(p.repo) : undefined;
        return {
          name: p.name,
          url: p.url,
          description: p.description,
          downloads: p.gem ? (gems?.[p.gem] ?? p.downloads) : null,
          stars: liveStars ?? p.stars,
        };
      }),
    );
    const isGem = (p: { downloads: number | null }) => Number(p.downloads !== null);
    projects.sort((a, b) => isGem(b) - isGem(a) || (isGem(a) ? b.downloads! - a.downloads! : b.stars! - a.stars!));
    // Related projects ("with") sit together, even out of order. A project
    // can follow one that follows another, so place the start of a chain first.
    const depth = (name: string): number => {
      const partner = data.projects.find((p) => p.name === name)!.with;
      return partner ? 1 + depth(partner) : 0;
    };
    for (const { name, with: partner } of data.projects.filter((p) => p.with).sort((a, b) => depth(a.name) - depth(b.name))) {
      const [moved] = projects.splice(
        projects.findIndex((p) => p.name === name),
        1,
      );
      projects.splice(projects.findIndex((p) => p.name === partner) + 1, 0, moved);
    }
    return {
      command: data.command,
      projects,
      total: {
        downloads: gems ? Object.values(gems).reduce((a, b) => a + b, 0) : data.totalDownloads,
        gems: gems ? Object.keys(gems).length : data.gemCount,
        stars: projects.reduce((t, p) => t + (p.stars ?? 0), 0),
      },
      more: data.more,
      live: Boolean(gems),
    };
  }

  const modules: { [K in ModuleId]: () => Promise<Modules[K]> } = {
    async whoami(): Promise<Whoami> {
      const [data, projects, gems] = await Promise.all([read("whoami"), read("projects"), live.gems()]);
      const snapshot = Object.fromEntries(projects.projects.map((p) => [p.gem, p.downloads]));
      const multi = ["multi_json", "multi_xml"].reduce((t, g) => t + (gems?.[g] ?? snapshot[g]!), 0);
      const fill = (s: string) => s.replaceAll("{{multiDownloads}}", fmt(multi));
      return {
        command: data.command,
        blocks: data.blocks.map((b) => (b.type === "p" ? { type: "p" as const, html: fill(b.html) } : b)),
        multiDownloads: multi,
      };
    },
    async contributions(): Promise<Contributions> {
      const snapshot = (await read("contributions")).contributions;
      const [days, push] = await Promise.all([live.contributions(), live.lastPush()]);
      const contributions = days ?? snapshot;
      return {
        command: "git log --author=sferik --since=1.year --graph",
        total: contributions.reduce((t, d) => t + d.count, 0),
        longestStreak: longestStreak(contributions),
        contributions,
        since: 2008,
        lastPush: push ?? null,
        live: Boolean(days),
      };
    },
    src: projectsData,
    async name() {
      return read("name");
    },
    async talks() {
      return read("talks");
    },
    async finger(): Promise<Finger> {
      const p = await read("profile");
      return { command: "finger sferik", ...p.finger, mail: p.email, profiles: p.profiles };
    },
  };
  const HOME: ModuleId[] = ["whoami", "contributions", "src", "name", "talks", "finger"];

  const text: { [K in ModuleId]: (m: Modules[K], limit?: number) => string } = {
    whoami: (m) =>
      m.blocks
        .flatMap((b) => (b.type === "p" ? [...wrap(stripTags(b.html)), ""] : [...wrap(`[${b.alt}]`), ...wrap(`${b.href}  ${stripTags(b.caption)}`), ""]))
        .join("\n")
        .trimEnd(),
    contributions(m) {
      const glyphs = ["·", "░", "▒", "▓", "█"];
      const lead = new Date(m.contributions[0].date + "T00:00:00Z").getUTCDay();
      const cells: (Day | null)[] = [...Array<null>(lead).fill(null), ...m.contributions];
      const weeks = Math.ceil(cells.length / 7);
      let months = "";
      for (let w = 0, last = -1; w < weeks; w++) {
        const d = cells.slice(w * 7, w * 7 + 7).find(Boolean)!;
        const month = Number(d.date.slice(5, 7)) - 1;
        if (month !== last && months.length < w) months = months.padEnd(w) + MON[month];
        last = month;
      }
      const rows = ["", "Mon", "", "Wed", "", "Fri", ""].map(
        (label, r) => label.padEnd(4) + Array.from({ length: weeks }, (_, w) => (cells[w * 7 + r] ? glyphs[cells[w * 7 + r]!.level] : " ")).join(""),
      );
      const push = m.lastPush ? ` through ${m.lastPush.at.slice(0, 10)} (${m.lastPush.repo}@${m.lastPush.sha.slice(0, 7)})` : "";
      return [
        `    ${months}`,
        ...rows,
        "",
        `${fmt(m.total)} contributions in the last year, longest streak ${m.longestStreak} days`,
        `On GitHub since ${m.since}${push}.`,
      ].join("\n");
    },
    src(m) {
      const row = (name: string, desc: string, dl: string, st: string) => `${name.padEnd(19)} ${desc.padEnd(46)} ${dl.padStart(6)} ${st.padStart(6)}`.trimEnd();
      return [
        ...m.projects.map((p) =>
          row(p.name, p.description, p.downloads === null ? "" : `${short(p.downloads)}↓`, p.stars === null ? "" : `${stars(p.stars)}★`),
        ),
        row("total", "", `${short(m.total.downloads)}↓`, `${stars(m.total.stars)}★`),
        "",
        `More repositories at ${m.more.replace(/^https:\/\//, "").replace(/\?.*/, "")}`,
      ].join("\n");
    },
    name: (m) => [`${m.commit} ${m.subject} (${m.year})`, ...m.notes.flatMap((n) => wrap(stripTags(n)))].join("\n"),
    talks: (m, limit = Infinity) =>
      [
        ...m.talks
          .filter((t) => limit === Infinity || t.featured)
          .flatMap((t) => [
            `${monthYear(t.date)}  ${t.title}`,
            `          ${t.event}, ${t.location}`,
            ...(t.slides ? [`          slides: ${bare(t.slides)}`] : []),
            ...(t.video ? [`          video:  ${bare(t.video)}`] : []),
          ]),
        ...(limit === Infinity
          ? ["", "Podcasts:", ...m.podcasts.flatMap((p) => [`${monthYear(p.date)}  ${p.title} (${p.show})`, `          ${bare(p.url)}`])]
          : []),
      ].join("\n"),
    finger: (m) =>
      [
        `Login: ${m.login}`.padEnd(40) + `Name: ${m.name}`,
        `Directory: ${m.directory}`.padEnd(40) + `Shell: ${m.shell}`,
        `Mail: ${m.mail}`,
        `Plan: ${m.plan}`,
        "",
        ...m.profiles.map((p) => `${(p.network + ":").padEnd(16)}${p.url}`),
      ].join("\n"),
  };

  async function home(): Promise<Home> {
    const profile = await read("profile");
    return {
      profile: { name: profile.name, location: profile.location, tagline: profile.tagline, handle: profile.handle, url: profile.url },
      modules: HOME.map((id) => ({ id, url: `/${id}` })),
      pages: { talks: "/talks", resume: "/resume" },
    };
  }

  async function homeText() {
    const data = await home();
    const inner = WIDTH - 4;
    const line = (s: string) => `│ ${s.padEnd(inner)} │`;
    const box = [
      `╭${"─".repeat(WIDTH - 2)}╮`,
      line(data.profile.name),
      line(data.profile.location),
      line(""),
      line(data.profile.tagline),
      `╰${"─".repeat(WIDTH - 2)}╯`,
    ];
    const parts = await Promise.all(
      HOME.map(async (id) => {
        const m = await modules[id]();
        const command = id === "talks" ? "ls -t ~/talks | head -6" : m.command;
        return `${PROMPT}${command}\n${id === "talks" ? text.talks(m as Talks, 6) : (text[id] as (m: unknown) => string)(m)}`;
      }),
    );
    return [...box, "", parts.join("\n\n"), "", `${PROMPT}curl sferik.com/resume`, ""].join("\n");
  }

  return { modules, text, home, homeText, resume: () => read("resume") };
}

// ------------------------------------------------------- the man page

// A man page's header and footer: left, centered, and right, in 80 columns.
const manLine = (l: string, c: string, rgt: string) => {
  const gap = WIDTH - l.length - c.length - rgt.length;
  return l + " ".repeat(Math.floor(gap / 2)) + c + " ".repeat(Math.ceil(gap / 2)) + rgt;
};
const MAN_HEAD = manLine("SFERIK(1)", "General Commands Manual", "SFERIK(1)");

// The month and year at the foot of the man page: today's, so it's always current.
const edition = (date: Date) => date.toLocaleString("en-US", { month: "long", year: "numeric" });

export function manPage(r: Resume, date: Date): string {
  return [MAN_HEAD, "", ...manSections(r).flatMap(([title, body]) => [title, ...body, ""]), manLine("sferik.com", edition(date), "SFERIK(1)"), ""].join("\n");
}

// The resume's sections as man-page text: [heading, lines].
function manSections(r: Resume): [string, string[]][] {
  const year = (d: string) => d.slice(0, 4);
  const span = (x: { startDate: string; endDate?: string }) => `${year(x.startDate)}–${x.endDate ? year(x.endDate) : ""}`.replace(/^(\d{4})–\1$/, "$1");
  const dated = (when: string, text: string, sub: string[] = []) => [
    ...wrap(text, WIDTH, " ".repeat(18)).map((l, i) => (i ? l : `       ${when.padEnd(11)}${l.trimStart()}`)),
    ...sub.flatMap((s) => wrap(`- ${s}`, WIDTH, " ".repeat(18))),
  ];
  const b = r.basics;
  return [
    [
      "NAME",
      wrap(`sferik, ${b.name} – ${b.label.toLowerCase()}, ${b.location.city}, ${b.location.region}`, WIDTH, "       ").concat(
        wrap(`${b.email}, sferik.com`, WIDTH, "       "),
      ),
    ],
    [
      "DESCRIPTION",
      plain(b.summary)
        .split("\n\n")
        .flatMap((p, i) => [...(i ? [""] : []), ...wrap(p, WIDTH, "       ")]),
    ],
    ["EXPERIENCE", r.work.flatMap((w) => dated(span(w), `${w.position}, ${w.name}`, w.highlights))],
    ["OPEN SOURCE", r.projects.flatMap((p) => wrap(`- ${p.name}: ${p.description}`, WIDTH, "         ").map((l, i) => (i ? l : `       ${l.trimStart()}`)))],
    ["LANGUAGES", wrap(`${r.skills[0].keywords.join(", ")}.`, WIDTH, "       ")],
    ["HONORS", r.awards.flatMap((a) => dated(year(a.date), `${a.title}. ${a.summary}`))],
    ["PATENTS", r.patents.flatMap((p) => dated(year(p.date), `${p.title}, ${p.number}.`))],
    ["SPEAKING", wrap(plain(r.speaking.summary), WIDTH, "       ")],
    ["EDUCATION", r.education.flatMap((e) => dated(span(e), `${e.institution}, ${e.location}. ${e.highlights.join(". ")}.`))],
    ["SERVICE", r.volunteer.flatMap((v) => dated(span(v), v.summary ? `${v.organization}, ${v.position}; ${v.summary}` : `${v.position}: ${v.organization}.`))],
    ["HISTORY", wrap(`Known as ${b.formerName} until June 24, 2017.`, WIDTH, "       ")],
    ["SEE ALSO", wrap(["sferik.com", ...b.profiles.map((p) => p.url.replace(/^https:\/\/(www\.)?/, ""))].join(", "), WIDTH, "       ")],
  ];
}

// ------------------------------------------------------------- the PDF
// The man page, typeset in Courier: one of the 14 fonts every PDF reader has
// built in, so nothing needs embedding. Headings are bold, and URLs, the
// email address, and patent numbers are links. No dependencies; just PDF 1.4 written by hand.

const PDF = { width: 612, height: 792, size: 9, leading: 11, top: 48, bottom: 48 }; // US Letter, in points
const CHAR = 0.6 * PDF.size; // Courier is 600/1000 em wide
const LEFT = (PDF.width - WIDTH * CHAR) / 2;
// Windows-1252 (the PDF's WinAnsiEncoding) for characters outside Latin-1.
const WIN_ANSI: Record<string, number> = { "–": 0x96, "—": 0x97, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "…": 0x85 };
const LINKS =
  /\b(?:https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]+|(?:sferik\.com|github\.com\/sferik|(?:www\.)?linkedin\.com\/in\/sferik|rubygems\.org\/profiles\/sferik)(?:\/\S*)?|US\d{11}A\d)/g;

const pdfString = (text: string) =>
  "(" +
  [...text]
    .map((c) => {
      const code = WIN_ANSI[c] ?? c.charCodeAt(0);
      const ch = code < 256 ? String.fromCharCode(code) : "?";
      return "()\\".includes(ch) ? "\\" + ch : ch;
    })
    .join("") +
  ")";

export function pdfResume(r: Resume, date: Date): Buffer {
  // Lay out the body: headings stay with the first line that follows them.
  const lines = manSections(r).flatMap(([title, body]) => [
    { text: title, bold: true },
    ...body.map((text) => ({ text, bold: false })),
    { text: "", bold: false },
  ]);
  const perPage = Math.floor((PDF.height - PDF.top - PDF.bottom) / PDF.leading) - 2; // minus the header and the gap below it
  const pages: (typeof lines)[] = [[]];
  for (const line of lines) {
    let page = pages[pages.length - 1];
    if (page.length >= perPage || (line.bold && page.length >= perPage - 1)) pages.push((page = []));
    if (page.length || line.text) page.push(line); // no blank line at the top of a page
  }

  // Objects 1–4 are fixed; each page adds a content stream, its links, and the page itself.
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // the page tree, filled in once the pages exist
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");
  add(`<< /Title ${pdfString(`${r.basics.name}, résumé`)} /Author ${pdfString(r.basics.name)} /Creator ${pdfString("sferik.com")} >>`);
  const kids: number[] = [];
  pages.forEach((page, n) => {
    const y = (row: number) => PDF.height - PDF.top - row * PDF.leading;
    const ops = [`BT /F2 ${PDF.size} Tf 1 0 0 1 ${LEFT} ${y(0)} Tm ${pdfString(MAN_HEAD)} Tj ET`];
    const annots: number[] = [];
    page.forEach((line, i) => {
      const row = i + 2;
      if (line.text) ops.push(`BT /F${line.bold ? 2 : 1} ${PDF.size} Tf 1 0 0 1 ${LEFT} ${y(row)} Tm ${pdfString(line.text)} Tj ET`);
      for (const m of line.text.matchAll(LINKS)) {
        const target = m[0].replace(/[.,;)]+$/, "");
        const uri = target.includes("@")
          ? `mailto:${target}`
          : target.startsWith("http")
            ? target
            : target.startsWith("US")
              ? `https://patents.google.com/patent/${target}`
              : `https://${target}`;
        const x = LEFT + m.index * CHAR;
        const rect = [x, y(row) - 2, x + target.length * CHAR, y(row) + PDF.size].map((v) => v.toFixed(2)).join(" ");
        annots.push(add(`<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(uri)} >> >>`));
      }
    });
    const foot = manLine("sferik.com", edition(date), `${n + 1} of ${pages.length}`);
    ops.push(`BT /F1 ${PDF.size} Tf 1 0 0 1 ${LEFT} ${PDF.bottom - PDF.leading} Tm ${pdfString(foot)} Tj ET`);
    const stream = ops.join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF.width} ${PDF.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(" ")}]` : ""} >>`,
      ),
    );
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  // Serialize, recording each object's byte offset for the cross-reference table.
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ---------------------------------------------------------- the LaTeX
// A conventional one-column resume from the JSON Resume document. It uses only
// packages in every TeX distribution; compile it with pdflatex.

const TEX_SPECIAL: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
  "–": "--",
  "—": "---",
  "“": "``",
  "”": "''",
  "‘": "`",
  "’": "'",
};
export const tex = (s: string) => s.replace(/[\\&%$#_{}~^–—“”‘’]/g, (c) => TEX_SPECIAL[c]);
// **bold**, *italic*, and web addresses (as links that LaTeX won't hyphenate).
const texMarkup = (s: string) =>
  tex(s)
    .replace(/\*\*([^*]+)\*\*/g, "\\textbf{$1}")
    .replace(/\*([^*]+)\*/g, "\\emph{$1}")
    .replace(/\b([a-z][a-z0-9-]*\.(?:com|org)(?:\/[a-z0-9/-]+)?)/g, "\\href{https://$1}{\\mbox{$1}}");

export function latexResume(r: Resume): string {
  const b = r.basics;
  const year = (d: string) => d.slice(0, 4);
  const range = (x: { startDate: string; endDate?: string }) => {
    const [from, to] = [year(x.startDate), x.endDate ? year(x.endDate) : "present"];
    return from === to ? from : `${from}--${to}`;
  };
  const items = (list: string[]) => (list.length ? ["\\begin{itemize}", ...list.map((i) => `  \\item ${i}`), "\\end{itemize}"] : []);
  const href = (url: string, text = url.replace(/^(https:\/\/(www\.)?|mailto:)/, "")) => `\\href{${url}}{${tex(text)}}`;
  // A bold title and its dates, then where (in italics) on the next line.
  const entry = (title: string, when: string, where?: string) => [`\\textbf{${title}} \\hfill ${tex(when)}${where ? `\\\\\n\\emph{${tex(where)}}` : ""}`];
  return [
    "% Erik Berlin's resume, generated by sferik.com from https://sferik.com/resume.json",
    "% Compile with: pdflatex resume.tex",
    "\\documentclass[10pt,letterpaper]{article}",
    "\\usepackage[margin=0.7in]{geometry}",
    "\\usepackage[T1]{fontenc}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage{lmodern}",
    "\\usepackage{enumitem}",
    "\\usepackage[hidelinks]{hyperref}",
    "\\setlist[itemize]{nosep,leftmargin=1.5em,topsep=2pt}",
    "\\setlength{\\parindent}{0pt}",
    "\\setlength{\\parskip}{4pt}",
    "\\pagestyle{empty}",
    "\\newcommand{\\heading}[1]{\\vspace{6pt}{\\large\\bfseries #1}\\par\\nointerlineskip\\vspace{2pt}\\hrule\\vspace{2pt}}",
    `\\hypersetup{pdftitle={${tex(b.name)}, R\\'esum\\'e}, pdfauthor={${tex(b.name)}}}`,
    "",
    "\\begin{document}",
    "",
    `{\\LARGE\\bfseries ${tex(b.name)}}\\\\[2pt]`,
    `${tex(b.label)}, ${tex(b.location.city)}, ${tex(b.location.region)}\\\\`,
    [href(`mailto:${b.email}`), href(b.url), ...b.profiles.map((p) => href(p.url))].join(" \\textbar{} "),
    "",
    "\\heading{Summary}",
    ...b.summary.split("\n\n").flatMap((p) => [texMarkup(p), ""]),
    "\\heading{Experience}",
    ...r.work.flatMap((w) => [...entry(`${tex(w.position)}, ${tex(w.name)}`, range(w)), ...items((w.highlights ?? []).map(tex)), ""]),
    "\\heading{Open Source}",
    ...items(r.projects.map((p) => `\\textbf{${tex(p.name)}}: ${tex(p.description)}`)),
    "",
    "\\heading{Languages}",
    `${r.skills[0].keywords.map(tex).join(", ")}.`,
    "",
    "\\heading{Honors}",
    ...items(r.awards.map((a) => `\\textbf{${tex(a.title)}} (${year(a.date)}). ${tex(a.summary)}`)),
    "",
    "\\heading{Patents}",
    ...items(r.patents.map((p) => `\\href{${p.url}}{${tex(p.title)}}, ${p.number} (${year(p.date)}).`)),
    "",
    "\\heading{Speaking}",
    texMarkup(r.speaking.summary),
    "",
    "\\heading{Education}",
    ...r.education.flatMap((e) => [...entry(tex(e.institution), range(e), e.location), ...items(e.highlights.map(tex)), ""]),
    "\\heading{Service}",
    ...r.volunteer.flatMap((v) => [
      ...entry(tex(v.position), range(v), v.organization),
      // Ragged right, so a web address at the end of a line moves down whole.
      ...(v.summary ? [`\\par{\\raggedright ${texMarkup(v.summary)}\\par}`] : []),
      "",
    ]),
    `\\vfill{\\small Known as ${tex(b.formerName)} until June 24, 2017.}`,
    "",
    "\\end{document}",
    "",
  ].join("\n");
}

// ------------------------------------------------------- negotiation

// Pick a representation from an Accept header, among the formats a resource
// has. A bare */* (curl's default) gets text; the rest must be asked for, as
// browsers and API clients do.
export type Format = "html" | "json" | "text" | "latex" | "pdf";
const MEDIA: Record<Format, string[]> = {
  html: ["text/html", "application/xhtml+xml", "text/*"],
  json: ["application/json", "application/*"],
  text: ["text/plain", "text/*", "*/*"],
  latex: ["application/x-latex", "application/x-tex", "text/x-tex"],
  pdf: ["application/pdf"],
};
const CONTENT_TYPE: Record<Format, string> = {
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
  text: "text/plain; charset=utf-8",
  latex: "application/x-latex; charset=utf-8",
  pdf: "application/pdf",
};
export function negotiate(accept: string | undefined, formats: Format[] = ["html", "json", "text"]): Format | null {
  const prefs = (accept || "*/*").split(",").map((part) => {
    const [type, ...params] = part.trim().toLowerCase().split(";");
    const q = params.find((p) => p.trim().startsWith("q="));
    return { type: type.trim(), q: q ? Number(q.trim().slice(2)) : 1 };
  });
  const q = (...types: string[]) => Math.max(0, ...prefs.filter((p) => types.includes(p.type)).map((p) => p.q));
  const scores = formats.map((f): [Format, number] => [f, q(...MEDIA[f])]);
  const [best, score] = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
  return score > 0 ? best : null;
}

// ------------------------------------------------------------ the app

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".flf": "text/plain; charset=utf-8",
  ".plan": "text/plain; charset=utf-8",
};
// Files anyone may fetch from public/ (including source maps: view source, it's
// meant to be read). Everything outside public/ stays private.
const PUBLIC = /^\/(?:[\w-]+\.(?:html|css|js|js\.map|svg|png|txt)|\.plan|img\/[\w-]+\.png|share\/[\w-]+\.flf)$/;
const PAGES: Record<string, string> = { "/": "index.html", "/talks": "talks.html", "/resume": "resume.html" };

export interface AppOptions {
  fetch?: typeof globalThis.fetch;
  offline?: boolean;
  now?: () => number;
  timeout?: number;
  token?: string;
  files?: Files;
  store?: Store;
  refresh?: boolean;
}

// Where the app reads data/*.json and the files in public/ from: the disk, or
// (on Cloudflare Workers) the bundle and the static assets.
export interface Files {
  data(name: string): Promise<unknown>;
  asset(name: string): Promise<{ body: Uint8Array; modified?: Date } | null>;
}
export const nodeFiles = (root: string): Files => ({
  data: async (name) => JSON.parse(await fs.readFile(path.join(root, "data", `${name}.json`), "utf8")),
  async asset(name) {
    const file = path.join(root, "public", name);
    try {
      const [body, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
      return { body, modified: stat.mtime };
    } catch {
      return null;
    }
  },
});

export function createApp({
  fetch = globalThis.fetch,
  offline = false,
  now = Date.now,
  timeout = 3000,
  token,
  files = nodeFiles(path.join(import.meta.dirname, "..")),
  store,
  refresh,
}: AppOptions = {}) {
  const read = files.data as Read;
  const asset = async (name: string) => (await files.asset(name))!.body; // for files that always exist
  const site = createModules({ live: createLive({ fetch, offline, now, timeout, token, store, refresh }), read });

  // Representations of each resource: [json, text].
  // Each resource's representations beyond html. Only the resume has LaTeX and PDF.
  interface Resource {
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    latex?: () => Promise<string>;
    pdf?: () => Promise<Buffer>;
  }
  const resources: Record<string, Resource> = {
    "/": { json: site.home, text: site.homeText },
    "/resume": {
      json: site.resume,
      text: async () => manPage(await site.resume(), new Date(now())),
      latex: async () => latexResume(await site.resume()),
      pdf: async () => pdfResume(await site.resume(), new Date(now())),
    },
  };
  for (const id of Object.keys(site.modules) as ModuleId[]) {
    const render = site.text[id] as (m: unknown) => string;
    resources[`/${id}`] = { json: site.modules[id], text: async () => render(await site.modules[id]()) };
  }
  resources["/index"] = resources["/"];
  const formatsOf = (r: Resource): Format[] => ["html", "json", "text", ...(r.latex ? ["latex" as const] : []), ...(r.pdf ? ["pdf" as const] : [])];
  const SUFFIX: Record<string, Format> = { json: "json", txt: "text", tex: "latex", pdf: "pdf" };
  const FILENAME: Partial<Record<Format, string>> = { latex: "erik-berlin-resume.tex", pdf: "erik-berlin-resume.pdf" };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, type: string, body: string | Uint8Array, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", ...extra });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const cors = { "access-control-allow-origin": "*" };
    if (req.method === "OPTIONS") {
      return send(204, "text/plain", "", { ...cors, "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "accept" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain; charset=utf-8", "Method Not Allowed\n", { allow: "GET, HEAD, OPTIONS" });

    const url = new URL(req.url!, "http://localhost");
    let pathname = decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/";
    // The API's description, for API tools (and cross-origin, like the API itself).
    if (pathname === "/openapi.json") {
      return send(200, "application/openapi+json; charset=utf-8", await asset("openapi.json"), {
        ...cors,
        "cache-control": "public, max-age=300",
      });
    }
    let resource: Resource | undefined = resources[pathname];
    let format: Format | null;
    // /resume.pdf, /whoami.json, …: a suffix the resource supports picks the format.
    const suffix = pathname.match(/\.(json|txt|tex|pdf)$/);
    const base = suffix ? resources[pathname.slice(0, -suffix[0].length) || "/"] : undefined;
    if (suffix && base && formatsOf(base).includes(SUFFIX[suffix[1]])) {
      resource = base;
      pathname = pathname.slice(0, -suffix[0].length) || "/";
      format = SUFFIX[suffix[1]];
    } else format = negotiate(req.headers.accept, resource ? formatsOf(resource) : undefined);

    if (resource) {
      const vary = { vary: "Accept", ...cors };
      if (!format) {
        const types = formatsOf(resource).map((f) => MEDIA[f][0]);
        return send(406, CONTENT_TYPE.text, `Not Acceptable. Try ${types.slice(0, -1).join(", ")}, or ${types.at(-1)}.\n`, vary);
      }
      if (format === "html") {
        const file = PAGES[pathname] ?? PAGES["/"];
        return send(200, CONTENT_TYPE.html, await asset(file), { vary: "Accept", "cache-control": "no-cache" });
      }
      const headers = {
        ...vary,
        "cache-control": "public, max-age=60",
        ...(FILENAME[format] && { "content-disposition": `inline; filename="${FILENAME[format]}"` }),
      };
      const body =
        format === "json"
          ? JSON.stringify(await resource.json(), null, 2) + "\n"
          : format === "text"
            ? (await resource.text()).replace(/\n*$/, "\n")
            : await resource[format]!();
      return send(200, CONTENT_TYPE[format], body, headers);
    }

    if (PUBLIC.test(pathname)) {
      const file = await files.asset(pathname.slice(1));
      if (file) {
        return send(200, TYPES[path.extname(pathname) || ".plan"], file.body, {
          ...(file.modified && { "last-modified": file.modified.toUTCString() }),
          "cache-control": "public, max-age=300",
        });
      }
    }

    if (format === "json") return send(404, "application/json; charset=utf-8", JSON.stringify({ error: "Not Found", path: pathname }) + "\n", cors);
    if (format === "html") return send(404, TYPES[".html"], await asset("404.html"));
    return send(404, "text/plain; charset=utf-8", `cd: The directory '${pathname}' does not exist\n`, cors);
  }

  // A failure in one request answers 500 instead of taking the server down.
  return (req: IncomingMessage, res: ServerResponse) =>
    handle(req, res).catch((err: unknown) => {
      console.error(err);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error\n");
    });
}

if (import.meta.main) {
  const { PORT = "3745", SFERIK_OFFLINE, GITHUB_TOKEN } = process.env;
  const app = createApp({ offline: Boolean(SFERIK_OFFLINE), token: GITHUB_TOKEN });
  const server = http.createServer(app).listen(Number(PORT), () => {
    console.log(`sferik.com on http://localhost:${(server.address() as import("node:net").AddressInfo).port}`);
  });
  // Shut down cleanly, so in-flight requests finish (and coverage gets written).
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
