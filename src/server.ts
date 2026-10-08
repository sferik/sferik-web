/*
 * sferik.net server
 *
 * Every page and module is one URL with three representations, chosen by the
 * Accept header (or a .json / .txt suffix):
 *
 *   text/html         the page, which builds itself from the JSON below
 *   application/json  structured data (the resume follows jsonresume.org)
 *   text/plain        terminal output, so `curl sferik.net/whoami` just works
 *
 * The resume is also LaTeX and a PDF, and finger a contact card (text/vcard).
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
import { gzipSync } from "node:zlib";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { figletLines, parseFont, type Font } from "./client/figlet.ts";
import { vcard } from "./client/vcard.ts";
import type {
  Contributions,
  Day,
  Dependency,
  Finger,
  Home,
  ModuleId,
  Modules,
  NameChange,
  Page,
  Podcast,
  Podcasts,
  ProjectsFile,
  Push,
  Resume,
  Session,
  Src,
  Talks,
  Whoami,
  Who,
  Profile,
} from "./types.js";

const WIDTH = 80;
const PROMPT = "sferik@mbp ~> ";

// ------------------------------------------------------------- formatting

// One formatter, made once: toLocaleString makes one each time it's called.
const fmt = new Intl.NumberFormat("en-US").format;
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
          : n >= 1e3
            ? `${(n / 1e3).toFixed(1)}k`
            : String(n); // a gem just published
const stars = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);
const monthYear = (ym: string) => `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const bare = (url: string) => url.replace(/^https:\/\/(www\.)?/, ""); // fits in 80 columns; terminals still link it

// Each day's shade in the graph, 1 to 4 by quartile of the year's busy days
// (0 for none), the way GitHub used to. GitHub's own levels have fixed
// thresholds, so in a year with a commit nearly every day, nearly every
// square came out the lightest green.
export function shade(days: Day[]): Day[] {
  const counts = days
    .map((d) => d.count)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const quartiles = [0.25, 0.5, 0.75].map((q) => counts[Math.floor(q * (counts.length - 1))]);
  return days.map((d) => ({ ...d, level: d.count && 1 + quartiles.filter((t) => d.count > t).length }));
}

// A time to the second, in UTC, as GitHub gives a push's.
const seconds = (date: Date) => date.toISOString().replace(/\.\d+Z$/, "Z");

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
  // What GitHub is asked about: the projects' repositories, and whose commits are sferik's.
  about: () => Promise<{ repos: string[]; email: string }>;
}
interface Entry {
  at: number;
  loaded?: number; // when the value was
  value?: unknown;
  pending?: Promise<unknown> | null;
}
export type Live = ReturnType<typeof createLive>;

function createLive({ fetch, offline, now, timeout, token, store, refresh, about }: LiveOptions) {
  const cache = new Map<string, Entry>();
  const headers: Record<string, string> = { "user-agent": "sferik.net", accept: "application/json", ...(token && { authorization: `Bearer ${token}` }) };

  async function getJSON<T>(url: string, init: RequestInit = {}, wait = timeout): Promise<T> {
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), wait);
    try {
      const res = await fetch(url, { ...init, headers, signal: timer.signal });
      if (!res.ok) {
        // Read, though it's not wanted: on Workers only six requests may be on their way at a time, and one
        // whose response is left unread holds its place until the runtime gives up on it.
        await res.text();
        throw new Error(`${url}: ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }

  // GitHub's GraphQL API, which answers only with a token. An answer may
  // have errors and data both, whatever its status says: what it couldn't
  // answer is null in the data, and why is among the errors. One with no data
  // at all has failed.
  async function graphql<T>(query: string, wait: number): Promise<{ data: T; errors: string[] }> {
    const { data, errors = [] } = await getJSON<{ data?: T | null; errors?: { message: string }[] }>(
      "https://api.github.com/graphql",
      { method: "POST", body: JSON.stringify({ query }) },
      wait,
    );
    if (!data) throw new Error(`GitHub: ${errors[0]?.message ?? "no data"}`);
    return { data, errors: errors.map((error) => error.message) };
  }

  // Everything GitHub is asked for, in one request, with a token: a year of
  // contributions (the calendar on the profile page; shade() gives the days
  // their levels), each repository's stars, and the last push. That's the
  // latest commit of sferik's own on the default branch of the ten
  // repositories last pushed to, among those he can push to: a push of
  // someone else's, or a robot's, isn't his, and GitHub doesn't say who
  // pushed. So it's when the commit was made, which is when it was pushed, or
  // near enough.
  //
  // GitHub may answer some of it and not the rest: an organization can turn a
  // token away that the others take, and then its repositories are null in
  // the answer. What's there is used (a project without its stars keeps the
  // snapshot's), and what isn't is said, since nothing else would say it. With
  // no calendar, though, the answer has failed, and each is asked for the
  // other way.
  //
  // It's three requests' worth of answer, and takes about as long as the
  // three would one after another, so it's given three times as long. The
  // three are asked for at different times, each when it's due, so one that's
  // asked within a minute of another is told what that one was: on Workers,
  // where a refresh asks for them all at once, that's always.
  interface GitHub {
    days: Day[];
    stars: Record<string, number>;
    push?: Push;
  }
  type Repositories = ({
    nameWithOwner: string;
    defaultBranchRef: { target: { history: { nodes: { oid: string; committedDate: string }[] } } } | null;
  } | null)[];
  type Answered = {
    user: {
      contributionsCollection: { contributionCalendar: { weeks: { contributionDays: { date: string; contributionCount: number }[] }[] } } | null;
      repositories: { nodes: Repositories } | null;
    } | null;
  };
  const everything = (repos: string[], email: string) => {
    const stars = repos.map((repo, i) => {
      const [owner, name] = repo.split("/");
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { stargazerCount }`;
    });
    const calendar = "contributionsCollection { contributionCalendar { weeks { contributionDays { date contributionCount } } } }";
    const commit = `history(first: 1, author: {emails: [${JSON.stringify(email)}]}) { nodes { oid committedDate } }`;
    const pushed = `repositories(first: 10, orderBy: {field: PUSHED_AT, direction: DESC}, privacy: PUBLIC, ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) { nodes { nameWithOwner defaultBranchRef { target { ... on Commit { ${commit} } } } } }`;
    return `query { user(login: "sferik") { ${calendar} ${pushed} } ${stars.join(" ")} }`;
  };
  // The latest of sferik's commits among the repositories. (The times are all written the same way, so the later is the greater.)
  const latest = (repositories: Repositories): Push | undefined =>
    repositories
      .flatMap((r) => (r?.defaultBranchRef?.target.history.nodes ?? []).map((c): Push => ({ repo: r!.nameWithOwner, sha: c.oid, at: c.committedDate })))
      .reduce<Push | undefined>((last, push) => (last && last.at >= push.at ? last : push), undefined);
  let asked: { at: number; answer: Promise<GitHub> } | undefined;
  function github(): Promise<GitHub> {
    if (!asked || now() - asked.at >= 60e3) {
      const answer = about().then(async ({ repos, email }): Promise<GitHub> => {
        const { data, errors } = await graphql<Answered & Record<string, { stargazerCount: number } | null>>(everything(repos, email), 3 * timeout);
        const calendar = data.user?.contributionsCollection?.contributionCalendar;
        if (!calendar) throw new Error(`GitHub: ${errors[0] ?? "no calendar"}`);
        if (errors.length) console.error("GitHub, with the token, answered only in part:", ...new Set(errors));
        return {
          days: calendar.weeks.flatMap((week) => week.contributionDays.map((day) => ({ date: day.date, count: day.contributionCount, level: 0 }))),
          stars: Object.fromEntries(repos.flatMap((repo, i) => (data[`r${i}`] ? [[repo, data[`r${i}`]!.stargazerCount]] : []))),
          push: latest(data.user!.repositories?.nodes ?? []),
        };
      });
      // With a token, GitHub is asked this way first, and the other ways if it
      // fails: which get the numbers, so nothing else would say that it has.
      answer.catch((err: unknown) => console.error("GitHub, with the token:", err));
      asked = { at: now(), answer };
    }
    return asked.answer;
  }

  // The contributions, from a service that reads them off the profile page: someone
  // else's, which could go away, so it's for when there's no token, or GitHub fails.
  const scraped = async () => (await getJSON<{ contributions: Day[] }>("https://github-contributions-api.jogruber.de/v4/sferik?y=last")).contributions;

  // Each repository's stars, without a token: a request each, keeping the ones that answer. None at all is a failure.
  const counted = async (): Promise<Record<string, number>> => {
    const { repos } = await about();
    const counts = await Promise.allSettled(
      repos.map(async (repo) => [repo, (await getJSON<{ stargazers_count: number }>(`https://api.github.com/repos/${repo}`)).stargazers_count] as const),
    );
    const answered = counts.flatMap((count) => (count.status === "fulfilled" ? [count.value] : []));
    if (!answered.length) throw new Error("GitHub: no stars");
    return Object.fromEntries(answered);
  };

  function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T | undefined> {
    if (offline) return Promise.resolve(undefined);
    if (store) {
      if (!refresh) return store.get(key) as Promise<T | undefined>;
      // A failed load keeps what the store already has, and says so: nothing
      // else would, since requests go on reading the value that's there.
      return load().then(
        async (value) => {
          await store.put(key, value);
          await store.put(`at:${key}`, now());
          return value;
        },
        (err: unknown) => {
          console.error(`couldn't refresh ${key}:`, err);
          return store.get(key) as Promise<T | undefined>;
        },
      );
    }
    let entry = cache.get(key);
    if (!entry) cache.set(key, (entry = { at: -Infinity }));
    const e = entry;
    if (now() - e.at >= ttl && !e.pending) {
      e.pending = load()
        .then(
          (value) => {
            e.value = value;
            e.loaded = now();
          },
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
  // The last push, without a token: from the events GitHub lists.
  const pushed = async (): Promise<Push> => {
    type Event = { type: string; repo: { name: string }; payload?: { head?: string }; created_at: string };
    const events = await getJSON<Event[]>("https://api.github.com/users/sferik/events/public?per_page=100");
    // GitHub lists the latest events, but not the latest first: a push
    // from last night can come after one from yesterday morning. So the
    // latest push is the one that says so, not the first in the list.
    // (The times are all written the same way, so the later is the greater.)
    const ev = events
      .filter((e) => e.type === "PushEvent" && e.payload?.head)
      .reduce<Event | undefined>((last, e) => (last && last.created_at >= e.created_at ? last : e), undefined);
    // The latest hundred events may have no push among them (days of
    // reviews and issues), which doesn't undo the last one: that's a load
    // that failed, so the push already known is kept.
    if (!ev) throw new Error("GitHub: no push in the latest events");
    return { repo: ev.repo.name, sha: ev.payload!.head!, at: ev.created_at };
  };
  const loaded = async (key: "gems" | "contributions") => (store ? ((await store.get(`at:${key}`)) as number | undefined) : cache.get(key)?.loaded);
  return {
    // When a value was last loaded, if it has been: what it's in says so (asOf).
    async at(key: "gems" | "contributions"): Promise<string | undefined> {
      const at = await loaded(key);
      return at === undefined ? undefined : seconds(new Date(at));
    },
    // Whether a value is live: loaded, and within the last two hours. Each is
    // loaded again within one, so one that's older has failed to be, more than
    // once, and is the last that was known, not what's so now.
    async fresh(key: "gems" | "contributions"): Promise<boolean> {
      return now() - ((await loaded(key)) ?? -Infinity) < 2 * HOUR;
    },
    // Every gem @sferik owns: name → downloads.
    gems: () =>
      cached("gems", HOUR, async () => {
        const list = await getJSON<{ name: string; downloads: number }[]>("https://rubygems.org/api/v1/owners/sferik/gems.json");
        return Object.fromEntries(list.map((g) => [g.name, g.downloads])) as Record<string, number>;
      }),
    // With a token, each is its part of GitHub's one answer, or else what it is without one: when that request
    // fails, or (for the last push) has no commit of sferik's in it.
    stars: () => cached("stars", 6 * HOUR, () => (token ? github().then((all) => all.stars, counted) : counted())),
    contributions: () => cached("contributions", HOUR, () => (token ? github().then((all) => all.days, scraped) : scraped())),
    lastPush: () =>
      cached("push", 5 * 60e3, () =>
        token
          ? github()
              .then(
                (all) => all.push,
                () => undefined,
              )
              .then((push) => push ?? pushed())
          : pushed(),
      ),
  };
}

// --------------------------------------------------------------- modules
// Each module is a JSON document plus a plain-text rendering of it.

interface DataFiles {
  profile: Profile;
  whoami: { command: string; blocks: Whoami["blocks"] };
  dependency: Dependency;
  projects: ProjectsFile;
  contributions: { contributions: Day[] };
  name: NameChange;
  talks: Talks;
  resume: Resume;
}
type Read = <K extends keyof DataFiles>(name: K) => Promise<DataFiles[K]>;

function createModules({ live, read, art }: { live: Live; read: Read; art: () => Promise<string> }) {
  async function projectsData(): Promise<Src> {
    const data = await read("projects");
    const [gems, stars] = await Promise.all([live.gems(), live.stars()]);
    const projects = data.projects.map((p) => ({
      name: p.name,
      url: p.url,
      description: p.description,
      downloads: p.gem ? (gems?.[p.gem] ?? p.downloads) : null,
      stars: (p.repo ? stars?.[p.repo] : undefined) ?? p.stars,
    }));
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
      // Whether the downloads are: not the snapshot, nor what was last fetched hours ago.
      live: await live.fresh("gems"),
      // When the downloads were fetched, or the day of the snapshot.
      asOf: (await live.at("gems")) ?? `${data.snapshot}T00:00:00Z`,
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
        blocks: data.blocks.map((b) => ({ ...b, html: fill(b.html) })),
        multiDownloads: multi,
      };
    },
    async dependency() {
      return read("dependency");
    },
    async contributions(): Promise<Contributions> {
      const snapshot = (await read("contributions")).contributions;
      const [days, push] = await Promise.all([live.contributions(), live.lastPush()]);
      const contributions = shade(days ?? snapshot);
      return {
        command: "git log --author=sferik --since=1.year --graph",
        total: contributions.reduce((t, d) => t + d.count, 0),
        longestStreak: longestStreak(contributions),
        contributions,
        since: 2008,
        lastPush: push ?? null,
        // Whether the graph is: not the snapshot, nor what was last fetched hours ago.
        live: await live.fresh("contributions"),
        // When the graph was fetched, or the last day of the snapshot.
        asOf: (await live.at("contributions")) ?? `${snapshot.at(-1)!.date}T00:00:00Z`,
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
  const podcastLines = (podcasts: Podcast[]) => podcasts.flatMap((p) => [`${monthYear(p.date)}  ${p.title} (${p.show})`, `          ${bare(p.url)}`]);
  // The podcasts alone, which come with the talks too.
  const podcasts = async (): Promise<Podcasts> => ({ command: "ls -lt ~/podcasts", podcasts: (await read("talks")).podcasts });
  const podcastsText = async () => podcastLines((await podcasts()).podcasts).join("\n");
  const HOME: ModuleId[] = ["whoami", "dependency", "contributions", "src", "name", "talks", "finger"];

  const text: { [K in ModuleId]: (m: Modules[K], limit?: number) => string } = {
    whoami: (m) =>
      m.blocks
        .flatMap((b) => [...wrap(stripTags(b.html)), ""])
        .join("\n")
        .trimEnd(),
    // A terminal without inline images shows what the picture is, and where.
    dependency: ({ figure: f }) => [...wrap(`[${f.alt}]`), ...wrap(`${f.href}  ${stripTags(f.caption)}`)].join("\n"),
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
            ...(t.link ? [`          link:   ${bare(t.link)}`] : []),
          ]),
        // The few the home page shows end as they do there: with where the rest are.
        ...(limit === Infinity ? ["", "Podcasts:", ...podcastLines(m.podcasts)] : ["", `All talks at sferik.net/talks. Slides are on ${bare(m.speakerDeck)}.`]),
      ].join("\n"),
    finger: (m) => {
      const width = Math.max(...m.profiles.map((p) => p.network.length)) + 2;
      return [
        `Login: ${m.login}`.padEnd(40) + `Name: ${m.name}`,
        `Directory: ${m.directory}`.padEnd(40) + `Shell: ${m.shell}`,
        `Mail: ${m.mail}`,
        `Plan: ${m.plan}`,
        "",
        ...m.profiles.map((p) => `${(p.network + ":").padEnd(width)}${p.url}`),
      ].join("\n");
    },
  };

  async function home(): Promise<Home> {
    const profile = await read("profile");
    return {
      profile: { name: profile.name, location: profile.location, tagline: profile.tagline, handle: profile.handle, url: profile.url },
      modules: HOME.map((id) => ({ id, url: `/${id}` })),
      pages: { talks: "/talks", resume: "/resume" },
    };
  }

  // The home page as text. Given what a page has already built (each
  // resource's JSON, by URL), it's rendered from that, not built again.
  async function homeText(built: Record<string, unknown> = {}) {
    const data = (built["/"] as Home | undefined) ?? (await home());
    // It opens as the page does: with two commands that have run, figlet
    // sferik.net and cat .signature (the motto).
    const banner = [`${PROMPT}figlet sferik.net`, await art(), "", `${PROMPT}cat .signature`, ...wrap(data.profile.tagline)];
    const parts = await Promise.all(
      HOME.map(async (id) => {
        const m = (built[`/${id}`] as Modules[ModuleId] | undefined) ?? (await modules[id]());
        const command = id === "talks" ? "ls -t ~/talks | head -6" : m.command;
        return `${PROMPT}${command}\n${id === "talks" ? text.talks(m as Talks, 6) : (text[id] as (m: unknown) => string)(m)}`;
      }),
    );
    return [...banner, "", parts.join("\n\n"), "", `${PROMPT}curl sferik.net/resume`, ""].join("\n");
  }

  return { modules, text, home, homeText, podcasts, podcastsText, resume: () => read("resume") };
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
  return [MAN_HEAD, "", ...manSections(r).flatMap(([title, body]) => [title, ...body, ""]), manLine("sferik.net", edition(date), "SFERIK(1)"), ""].join("\n");
}

// The resume's sections as man-page text: [heading, lines].
// The man page's sections. On paper (the PDF), SEE ALSO skips the man-style
// references, which mean nothing there.
function manSections(r: Resume, paper = false): [string, string[]][] {
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
        wrap(`${b.email}, sferik.net`, WIDTH, "       "),
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
    [
      "SEE ALSO",
      [
        ...(paper ? [] : [...wrap("talks(7), finger(1), sferik(3)", WIDTH, "       "), ""]),
        ...wrap(["sferik.net", ...b.profiles.map((p) => p.url.replace(/^https:\/\/(www\.)?/, ""))].join(", "), WIDTH, "       "),
      ],
    ],
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
  /\b(?:https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]+|(?:sferik\.net|github\.com\/sferik|(?:www\.)?linkedin\.com\/in\/sferik|rubygems\.org\/profiles\/sferik)(?:\/\S*)?|US\d{11}A\d)/g;

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
  const lines = manSections(r, true).flatMap(([title, body]) => [
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
  add(`<< /Title ${pdfString(`${r.basics.name}, résumé`)} /Author ${pdfString(r.basics.name)} /Creator ${pdfString("sferik.net")} >>`);
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
    const foot = manLine("sferik.net", edition(date), `${n + 1} of ${pages.length}`);
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
    .replace(/\b([a-z][a-z0-9-]*\.(?:com|org|net|me)(?:\/[a-z0-9/-]+)?)/g, "\\href{https://$1}{\\mbox{$1}}");

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
    "% Erik Berlin's resume, generated by sferik.net from https://sferik.net/resume.json",
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

// ------------------------------------------------------- the feed

const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// The talks as an Atom feed, newest first. Talks are dated to the month.
export function talksFeed(m: Talks): string {
  const when = (date: string) => `${date}-01T00:00:00Z`;
  const entries = m.talks.map((t) => {
    const links = [
      t.video && `<link rel="alternate" type="text/html" title="Video" href="${xml(t.video)}"/>`,
      t.slides && `<link rel="related" type="text/html" title="Slides" href="${xml(t.slides)}"/>`,
      t.link && `<link rel="related" type="text/html" title="Link" href="${xml(t.link)}"/>`,
    ].filter(Boolean);
    return [
      "  <entry>",
      `    <id>tag:sferik.net,${t.date}:talks/${slug(t.title)}-${slug(t.event)}</id>`,
      `    <title>${xml(t.title)}</title>`,
      `    <updated>${when(t.date)}</updated>`,
      ...(links.length
        ? links.map((l) => `    ${l}`)
        : [`    <link rel="alternate" type="text/html" href="https://sferik.net/talks#y${t.date.slice(0, 4)}"/>`]),
      `    <summary>${xml(`${t.event}, ${t.location}`)}</summary>`,
      "  </entry>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "  <id>https://sferik.net/talks</id>",
    "  <title>Talks, Erik Berlin</title>",
    `  <updated>${when(m.talks[0].date)}</updated>`,
    "  <author><name>Erik Berlin</name><uri>https://sferik.net/</uri></author>",
    '  <link rel="self" type="application/atom+xml" href="https://sferik.net/talks.atom"/>',
    '  <link rel="alternate" type="text/html" href="https://sferik.net/talks"/>',
    ...entries,
    "</feed>",
    "",
  ].join("\n");
}

// The home page's banner, as an h-card (microformats2), in the HTML itself:
// the tools that read h-cards don't run JavaScript. The URL, handle, and
// email are there for them, not for the eye. What the eye gets is a login:
// the visitor's last login (site.ts fills it in, if there was one), then two
// commands that have already run, figlet sferik.net and cat .signature
// (the motto). The commands after them play out; these don't, so the
// page opens with something to see.
// What figlet sferik.net prints, which the home page opens with, as a page and as text.
export const figletArt = (font: Font): string =>
  figletLines(font, "sferik.net", WIDTH, "smush")[0]
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd(); // no blank descender row

export function banner(p: Profile, font: Font): string {
  const [locality, region] = p.location.split(", ");
  const art = figletArt(font);
  const ps1 = (id: string, command: string, arg: string) =>
    `<h2 class="ps1" id="${id}"><span class="prompt" aria-hidden="true"><span class="ps-user">sferik</span>@mbp <span class="ps-cwd">~</span>&gt; </span>${command} <span class="arg">${arg}</span></h2>`;
  return [
    '<header class="banner h-card" data-profile>',
    '  <p class="login" data-login aria-hidden="true">&nbsp;</p>',
    `  <h1 class="p-name sr-only">${xml(p.name)}</h1>`,
    '  <section class="cmd ran" aria-labelledby="figlet">',
    `    ${ps1("figlet", "figlet", "sferik.net")}`,
    `    <pre class="figlet" aria-hidden="true">${xml(art)}</pre>`,
    "  </section>",
    '  <section class="cmd ran" aria-labelledby="signature">',
    `    ${ps1("signature", "cat", ".signature")}`,
    `    <div class="out"><p class="p-note">${xml(p.tagline)}</p></div>`,
    "  </section>",
    `  <data class="u-url u-uid" value="${xml(p.url)}/"></data>`,
    `  <data class="p-nickname" value="${xml(p.handle)}"></data>`,
    `  <data class="p-locality" value="${xml(locality)}"></data>`,
    `  <data class="p-region" value="${xml(region)}"></data>`,
    `  <data class="u-email" value="mailto:${xml(p.email)}"></data>`,
    "</header>",
  ].join("\n");
}

// ~/.signature: the motto (the home page shows it, as cat .signature).
export const signature = (p: Profile) => `${p.tagline}\n`;

// The pages, for search engines (robots.txt points here).
const SITEMAP = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...["/", "/talks", "/resume"].map((page) => `  <url><loc>https://sferik.net${page}</loc></url>`),
  "</urlset>",
  "",
].join("\n");

// Who the site is about, as a schema.org Person (JSON-LD), in the home page's
// HTML, for search engines: the name and the one before it, the job, the
// honors, and every profile (sameAs), from the same data as the page and the
// resume, so a profile added to one is in the other.
export function personJsonLd(p: Profile, r: Resume): string {
  const person = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: p.name,
    alternateName: [r.basics.formerName, p.handle],
    url: `${p.url}/`,
    jobTitle: r.basics.label,
    address: { "@type": "PostalAddress", addressLocality: r.basics.location.city, addressRegion: r.basics.location.region },
    award: r.awards.map((a) => `${a.title} (${a.date.slice(0, 4)})`),
    alumniOf: r.education.map((e) => e.institution),
    sameAs: p.profiles.map((profile) => profile.url),
  };
  return `<script type="application/ld+json">${JSON.stringify(person).replace(/</g, "\\u003c")}</script>`;
}

// The talks as schema.org events (JSON-LD), in the talks page's HTML, so
// search engines know them for talks: when, where, at what, and the video,
// the slides, and the talk's page on the event's site. Talks before 2017 were given as Erik Michaels-Ober.
export function talksJsonLd(m: Talks): string {
  const speaker = { "@type": "Person", name: "Erik Berlin", alternateName: "Erik Michaels-Ober", url: "https://sferik.net/" };
  const list = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Talks, Erik Berlin",
    itemListElement: m.talks.map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Event",
        name: t.title,
        startDate: t.date,
        eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
        eventStatus: "https://schema.org/EventScheduled",
        location: { "@type": "Place", name: t.location, address: t.location },
        superEvent: { "@type": "Event", name: t.event },
        performer: speaker,
        ...(t.video && { recordedIn: { "@type": "CreativeWork", url: t.video } }),
        ...(t.slides && { subjectOf: { "@type": "PresentationDigitalDocument", url: t.slides } }),
        ...(t.link && { url: t.link }),
      },
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(list).replace(/</g, "\\u003c")}</script>`;
}

// ------------------------------------------------------ who's logged in

// Everyone reading the site is logged in to the same computer, each tab a
// terminal of its own, which who and w list. A tab checks in (POST /who)
// when it opens and every minute it's in view, and is logged in for three
// minutes after. Nothing about the reader is kept: a random token per tab,
// the page it's on, and when. The host also rations write's mail: one
// message a minute from any one address (remembered only in memory), and
// twenty a day in all. One it turns away is told how many seconds to wait.
// A message may come with a key (Idempotency-Key), which the host keeps for
// a day: the same key again is the same message, already sent, so a sender
// that never heard back can send it again without it arriving twice. Until
// the email has gone, though, the key is only being sent: the same message
// again is told to ask later, not that it was sent, since it may yet not be.
// And a key whose email didn't go through is kept for the minute its sender
// must wait: sent again by then (by one who never heard that it failed), it's
// told that it didn't go through, not that there's been one too many.
export interface Host {
  beat(token: string, page: Page): Promise<Who>;
  who(): Promise<Session[]>;
  mail(ip: string, key?: string): Promise<"ok" | "sent" | { why: "busy" | "full" | "sending" | "undelivered"; wait: number }>;
  delivered(key: string): Promise<void>; // a message with a key went through: the key is sent, for a day
  unsent(key?: string): Promise<void>; // a message didn't go through: give back its place in the day's ration, and its key didn't, for a minute
}
// Where the host keeps its state: a Map for the Node server, a Durable
// Object's storage on Workers.
export interface HostStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}
export const memoryStorage = (): HostStorage => {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key, value) => void map.set(key, value),
    delete: async (key) => map.delete(key),
    list: async <T>({ prefix }: { prefix: string }) => new Map([...map].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
  };
};

export const PAGES_ON: readonly string[] = ["/", "/talks", "/resume"];
const LOGGED_IN = 3 * 60e3;
const TTYS = 1000; // at most, so the names stay ttys000 to ttys999
const MAIL_EVERY = 60e3;
const MAIL_A_DAY = 20;
const KEEP_KEYS = 864e5;
// How long a message may be on its way. One that's been longer was never
// heard of again (delivered or unsent), so its key is free to be sent anew.
const SENDING = 60e3;
const ASK_AGAIN = 5; // seconds
const UNDELIVERED = "the message didn't go through; try again later";

// A ration by address that outlasts the host's memory: true if this one may
// go on. On Workers it's a rate limit counted at Cloudflare's edge, since a
// Durable Object forgets what's only in memory whenever it's been idle.
export type Limit = (address: string) => Promise<boolean>;

export function createHost(storage: HostStorage, now: () => number = Date.now, limit?: Limit): Host {
  interface Tty {
    n: number;
    page: Page;
    login: number;
    seen: number;
  }
  const sent = new Map<string, number>(); // address → when it last sent mail
  // The terminals are read from storage once, and after that are kept here
  // too: a check-in writes its own, where it used to read everyone's first. On
  // Workers the host forgets them whenever it's been idle, and reads them again.
  let kept: Promise<Map<string, Tty>> | undefined;
  const stored = () =>
    (kept ??= storage.list<Tty>({ prefix: "tty:" }).catch((err: unknown) => {
      kept = undefined; // to try again, the next time
      throw err;
    }));
  async function ttys() {
    const all = await stored();
    for (const [key, t] of all)
      if (now() - t.seen > LOGGED_IN) {
        all.delete(key);
        await storage.delete(key);
      }
    return all;
  }
  // When each key under a prefix was kept, but for the ones kept longer ago than they're kept for, which are forgotten.
  async function recent(prefix: string, keep: number) {
    const all = await storage.list<number>({ prefix });
    for (const [k, at] of all)
      if (now() - at >= keep) {
        all.delete(k);
        await storage.delete(k);
      }
    return all;
  }
  const name = (t: Tty) => `ttys${String(t.n).padStart(3, "0")}`;
  const sessions = (all: Map<string, Tty>): Session[] =>
    [...all.values()]
      .sort((a, b) => a.n - b.n)
      .map((t) => ({ tty: name(t), page: t.page, login: new Date(t.login).toISOString(), idle: Math.floor((now() - t.seen) / 1000) }));
  return {
    async beat(token, page) {
      const all = await ttys();
      const key = `tty:${token}`;
      let t = all.get(key);
      if (!t) {
        if (all.size >= TTYS) return { you: null, users: sessions(all) };
        const taken = new Set([...all.values()].map((x) => x.n));
        let n = 0;
        while (taken.has(n)) n++;
        t = { n, page, login: now(), seen: now() };
      }
      t = { ...t, page, seen: now() };
      all.set(key, t);
      await storage.put(key, t);
      return { you: name(t), users: sessions(all) };
    },
    who: async () => sessions(await ttys()),
    async mail(ip, key) {
      const keys = await recent("key:", KEEP_KEYS);
      if (key && keys.has(`key:${key}`)) return "sent";
      const sending = await recent("sending:", SENDING);
      if (key && sending.has(`sending:${key}`)) return { why: "sending", wait: ASK_AGAIN };
      const failed = await recent("failed:", MAIL_EVERY);
      const at = key && failed.get(`failed:${key}`);
      if (at) return { why: "undelivered", wait: Math.ceil((at + MAIL_EVERY - now()) / 1000) };
      for (const [address, at] of sent) if (now() - at >= MAIL_EVERY) sent.delete(address);
      const last = sent.get(ip);
      if (last !== undefined) return { why: "busy", wait: Math.ceil((last + MAIL_EVERY - now()) / 1000) };
      if (limit && !(await limit(ip))) return { why: "busy", wait: MAIL_EVERY / 1000 };
      const day = `mail:${new Date(now()).toISOString().slice(0, 10)}`;
      const count = (await storage.get<number>(day)) ?? 0;
      if (count >= MAIL_A_DAY) return { why: "full", wait: Math.ceil((864e5 - (now() % 864e5)) / 1000) }; // until the next day, in UTC
      sent.set(ip, now());
      await storage.put(day, count + 1);
      if (key) await storage.put(`sending:${key}`, now());
      return "ok";
    },
    async delivered(key) {
      await storage.delete(`sending:${key}`);
      await storage.put(`key:${key}`, now());
    },
    async unsent(key) {
      if (key) {
        await storage.delete(`sending:${key}`);
        await storage.put(`failed:${key}`, now());
      }
      const day = `mail:${new Date(now()).toISOString().slice(0, 10)}`;
      const count = await storage.get<number>(day);
      if (count) await storage.put(day, count - 1);
    },
  };
}

// who's output: user, terminal, and when they logged in (in UTC, the server's time).
export function whoText(users: Session[]): string {
  return users
    .map((u) => {
      const d = new Date(u.login);
      return `sferik   ${u.tty}  ${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${d.toISOString().slice(11, 16)}`;
    })
    .join("\n");
}

// --------------------------------------------------------------- write

// A message from write sferik, by email: plain text, base64 so any language
// gets through, with a Reply-To when the message includes an email address.
export interface Letter {
  text: string;
  tty: string | null;
  replyTo: string | null;
}
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
export function letter(l: Letter, { from, to, date, id }: { from: string; to: string; date: Date; id: string }): string {
  const body = `${l.text.replace(/\n*$/, "")}\n\n-- \nSent with write from ${l.tty ?? "a terminal"} on sferik.net\n`;
  return [
    `From: sferik.net <${from}>`,
    `To: ${to}`,
    ...(l.replyTo ? [`Reply-To: ${l.replyTo}`] : []),
    `Subject: Message from ${l.tty ?? "sferik.net"}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${id}@sferik.net>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body).toString("base64").replace(/.{76}/g, "$&\r\n"),
    "",
  ].join("\r\n");
}

// A request's body, or null if it's longer than the limit (in bytes). A body
// that's too long is still read to the end, but not kept, so the answer to it
// isn't cut off.
async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= limit) chunks.push(Buffer.from(chunk));
  }
  return size > limit ? null : Buffer.concat(chunks).toString("utf8");
}

// ------------------------------------------------------ .well-known

// WebFinger for @sferik@sferik.net (and the other domains), pointing to the
// Mastodon account, so the domain works as a fediverse handle.
const ACCOUNT = /^acct:sferik@sferik\.(?:net|com|org|me)$/i;
const WEBFINGER = {
  subject: "acct:sferik@mastodon.social",
  aliases: ["https://mastodon.social/@sferik", "https://mastodon.social/users/sferik"],
  links: [
    { rel: "http://webfinger.net/rel/profile-page", type: "text/html", href: "https://mastodon.social/@sferik" },
    { rel: "self", type: "application/activity+json", href: "https://mastodon.social/users/sferik" },
    { rel: "http://ostatus.org/schema/1.0/subscribe", template: "https://mastodon.social/authorize_interaction?uri={uri}" },
  ],
};

// ------------------------------------------------------- security

// Whether a request was made by another site's page. Browsers say, in
// Sec-Fetch-Site; ones too old for that say where a POST is from, in Origin.
// Anything else (curl, a script) says neither, and is no one's page.
function foreign(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.origin;
  return origin !== undefined && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`;
}

// The site loads only its own files. The shell's curl and gh fetch other
// sites' APIs, so connections can go anywhere over HTTPS.
const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "connect-src 'self' https:",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), midi=(), interest-cohort=()",
  "x-content-type-options": "nosniff",
  // A page another site opens, or one this site opens there, is no window to this one.
  "cross-origin-opener-policy": "same-origin",
};

// The API is for any origin's pages. One of them may read a response's ETag
// (to ask again with it, in If-None-Match), how long it's told to wait
// (Retry-After), and how long a response has been kept on its way already
// (Age, which Cloudflare's cache says, and which is that much off how long
// it's good for), which a browser otherwise keeps from a page on another origin.
//
// And each of the API's responses says where its description is (Link, with
// the relation RFC 8631 has for that), as the pages do in their HTML: a client
// that has only a response can find out what else there is to ask for. A
// page on another origin may read that too.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "ETag, Retry-After, Age, Link",
  link: '</openapi.json>; rel="service-desc"; type="application/openapi+json"',
};

// An entity tag for a response: FNV-1a over its bytes, and its length. Fast,
// the same on Node and Workers, and plenty to tell versions of a file apart.
export function etag(body: string | Uint8Array): string {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return `"${(hash >>> 0).toString(16)}-${bytes.length.toString(16)}"`;
}

// ------------------------------------------------------- negotiation

// Pick a representation from an Accept header, among the formats a resource
// has. A bare */* (curl's default) gets text; the rest must be asked for, as
// browsers and API clients do.
export type Format = "html" | "json" | "text" | "latex" | "pdf" | "vcard";
const MEDIA: Record<Format, string[]> = {
  html: ["text/html", "application/xhtml+xml", "text/*"],
  json: ["application/json", "application/*"],
  text: ["text/plain", "text/*", "*/*"],
  latex: ["application/x-latex", "application/x-tex", "text/x-tex"],
  pdf: ["application/pdf"],
  vcard: ["text/vcard", "text/x-vcard"],
};
const CONTENT_TYPE: Record<Format, string> = {
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
  text: "text/plain; charset=utf-8",
  latex: "application/x-latex; charset=utf-8",
  pdf: "application/pdf",
  vcard: "text/vcard; charset=utf-8",
};
// How much an Accept header wants each format: 0 for not at all, up to 1.
function wanted(accept: string | undefined): (format: Format) => number {
  const prefs = (accept || "*/*").split(",").map((part) => {
    const [type, ...params] = part.trim().toLowerCase().split(";");
    const q = params.find((p) => p.trim().startsWith("q="));
    const weight = q ? Number(q.trim().slice(2)) : 1;
    // A q that's no number (q=high) says nothing, so it's as if it weren't there.
    return { type: type.trim(), q: Number.isNaN(weight) ? 1 : weight };
  });
  return (format) => Math.max(0, ...prefs.filter((p) => MEDIA[format].includes(p.type)).map((p) => p.q));
}
export function negotiate(accept: string | undefined, formats: Format[] = ["html", "json", "text"]): Format | null {
  const q = wanted(accept);
  const scores = formats.map((f): [Format, number] => [f, q(f)]);
  const [best, score] = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
  return score > 0 ? best : null;
}
// All that an Accept header says, as far as the app can tell: how much it
// wants each format. Two that say the same here are answered the same, however
// they're written (every browser's is its own), so a cache can keep one
// answer for both.
export const asksFor = (accept: string | undefined): string => (Object.keys(MEDIA) as Format[]).map(wanted(accept)).join(",");

// Whether a client would rather be told in JSON than in plain text, which is
// how an error is told, and what the two POSTs say. Any JSON at all is JSON
// here: WebFinger's has a type of its own (application/jrd+json), and a client
// that asks for that wants to read what went wrong the same way.
const ANY_JSON = /\bapplication\/[\w.-]+\+json\b/gi;
const prefersJson = (req: IncomingMessage) => negotiate(req.headers.accept?.replace(ANY_JSON, "application/json"), ["text", "json"]) === "json";

// ------------------------------------------------------------ the app

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".flf": "text/plain; charset=utf-8",
  ".plan": "text/plain; charset=utf-8",
};
// Files anyone may fetch from public/ (including source maps: view source, it's
// meant to be read). Everything outside public/ stays private.
const PUBLIC = /^\/(?:[\w-]+\.(?:html|css|js|js\.map|svg|png|ico|webmanifest|txt)|\.plan|img\/[\w-]+\.(?:png|webp)|share\/[\w-]+\.flf)$/;
const PAGES: Record<string, string> = { "/": "index.html", "/talks": "talks.html", "/resume": "resume.html" };
// A script or a style under the commit that's deployed: /v/<commit>/site.js.
// A page asks for its own there (see versioned), and the scripts ask for each
// other beside themselves, so they're all one version's. What's at such a URL
// never changes, so it's kept for a year and never checked.
const VERSIONED = /^\/v\/(\w+)(\/[\w-]+\.(?:css|js|js\.map))$/;
const LINKED = /(?<=(?:href|src)=")(?=\/[\w-]+\.(?:css|js)")/g;

export interface AppOptions {
  fetch?: typeof globalThis.fetch;
  offline?: boolean;
  now?: () => number;
  timeout?: number;
  token?: string;
  files?: Files;
  store?: Store;
  refresh?: boolean;
  // The deployed commit and when it was deployed (the deploy sets them).
  version?: { commit?: string; deployed?: string };
  // Gzip text responses for clients that accept it, and the resume's PDF,
  // whose pages are plain text inside. The Node server does; on Workers,
  // Cloudflare does it in front of the app, or the Worker itself (compressed).
  compress?: boolean;
  // Who's logged in, and the ration of mail (a Durable Object on Workers).
  host?: Host;
  // A ration of check-ins (POST /who) by address; without it, there's none.
  limit?: Limit;
  // Delivers write's messages; without it, write is turned away.
  mail?: (letter: Letter) => Promise<void>;
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

// figlet's font, for the home page's banner. Read and parsed once, not once
// an app: on Workers an app answers one request, so each home page read it again.
let font: Font | undefined;

export function createApp({
  fetch = globalThis.fetch,
  offline = false,
  now = Date.now,
  timeout = 3000,
  token,
  files = nodeFiles(path.join(import.meta.dirname, "..")),
  store,
  refresh,
  version = {},
  compress = false,
  host = createHost(memoryStorage(), now),
  limit,
  mail,
}: AppOptions = {}) {
  const read = files.data as Read;
  const asset = async (name: string) => (await files.asset(name))!.body; // for files that always exist
  // What GitHub is asked about: the repositories of the projects that have one, and whose commits are sferik's.
  const about = async () => ({
    repos: (await read("projects")).projects.map((p) => p.repo).filter(Boolean) as string[],
    email: (await read("profile")).email,
  });
  const figletFont = async () => (font ??= parseFont(new TextDecoder().decode(await asset("share/standard.flf"))));
  const site = createModules({
    live: createLive({ fetch, offline, now, timeout, token, store, refresh, about }),
    read,
    art: async () => figletArt(await figletFont()),
  });
  // A page's scripts and style, at the deployed commit's URLs. With no commit
  // (bun start), they stay where they are, and are checked on every load.
  const prefix = version.commit ? `/v/${version.commit}` : "";
  const versioned = (page: string) => page.replace(LINKED, prefix);

  // Each resource's representations beyond html. Only the resume has LaTeX and
  // PDF, and only finger a contact card. A page that has built its resources'
  // JSON (see embedded) hands it to text, by URL, so it isn't built twice.
  type Built = Record<string, unknown>;
  interface Resource {
    json: () => Promise<unknown>;
    text: (built?: Built) => Promise<string>;
    latex?: () => Promise<string>;
    pdf?: () => Promise<Buffer>;
    vcard?: () => Promise<string>;
    cache?: string;
  }
  // How long a resource is good for. One with live numbers in it (and the
  // home page's text has every module's) is good for five minutes: on
  // Workers the numbers are refreshed every fifteen, so it's rarely behind
  // them, and never by more than five. The rest change only with a deploy,
  // so they're good for an hour, as the feed and the motto are. On Workers, Cloudflare's cache starts over with each
  // deploy, so what it answers with is never from before one; a browser, or
  // a client that keeps what it's told, may be an hour behind.
  const LIVE: ModuleId[] = ["whoami", "contributions", "src"];
  const LIVE_FOR = "public, max-age=300";
  const DEPLOYED = "public, max-age=3600";
  const resources: Record<string, Resource> = {
    "/": { json: site.home, text: site.homeText },
    "/resume": {
      cache: DEPLOYED,
      json: site.resume,
      text: async (built) => manPage((built?.["/resume"] as Resume | undefined) ?? (await site.resume()), new Date(now())),
      latex: async () => latexResume(await site.resume()),
      pdf: async () => pdfResume(await site.resume(), new Date(now())),
    },
  };
  for (const id of Object.keys(site.modules) as ModuleId[]) {
    const render = site.text[id] as (m: unknown) => string;
    resources[`/${id}`] = {
      json: site.modules[id],
      text: async (built) => render(built?.[`/${id}`] ?? (await site.modules[id]())),
      ...(!LIVE.includes(id) && { cache: DEPLOYED }),
    };
  }
  resources["/index"] = resources["/"];
  resources["/finger"].vcard = async () => vcard(await site.modules.finger());
  resources["/podcasts"] = { json: site.podcasts, text: site.podcastsText, cache: DEPLOYED };
  resources["/who"] = {
    json: async () => ({ users: await host.who() }),
    text: async () => whoText(await host.who()),
    // Good for a few seconds, which on Workers is how long Cloudflare's cache
    // answers for the host: looking is free, but not asking the host each time.
    cache: "public, max-age=5",
  };
  const formatsOf = (r: Resource): Format[] => ["html", "json", "text", ...(["latex", "pdf", "vcard"] as const).filter((f) => r[f])];
  const SUFFIX: Record<string, Format> = { json: "json", txt: "text", tex: "latex", pdf: "pdf", vcf: "vcard" };
  const FILENAME: Partial<Record<Format, string>> = { latex: "erik-berlin-resume.tex", pdf: "erik-berlin-resume.pdf", vcard: "erik-berlin.vcf" };

  // The JSON a page builds itself from, by URL, in the page itself: what it
  // would otherwise ask for as soon as it loaded (eight requests, for the home
  // page). site.ts's getJSON looks here first.
  async function build(file: string): Promise<Built> {
    const urls = file === "index.html" ? ["/", ...(await site.home()).modules.map((m) => m.url)] : [`/${file.replace(".html", "")}`];
    return Object.fromEntries(await Promise.all(urls.map(async (url) => [url, await resources[url].json()] as const)));
  }
  const embedded = (built: Built) => `<script type="application/json" id="data">${JSON.stringify(built).replace(/</g, "\\u003c")}</script>`;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // A successful response gets an ETag; asking again with it (If-None-Match)
    // gets 304 Not Modified, without the body. Proxies may weaken it (W/).
    const send = (status: number, type: string, body: string | Uint8Array, extra: Record<string, string> = {}) => {
      const gzip =
        compress &&
        body.length > 1024 &&
        /^(text\/|application\/[\w.+-]*(json|javascript|xml)|application\/(pdf|x-latex)|image\/svg)/.test(type) &&
        /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
      const tag = status === 200 ? etag(body).replace(/"$/, gzip ? '-gz"' : '"') : null;
      const fresh = tag !== null && (req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim().replace(/^W\//, "") === tag);
      const encoding = gzip ? { "content-encoding": "gzip", vary: [extra.vary, "Accept-Encoding"].filter(Boolean).join(", ") } : {};
      res.writeHead(fresh ? 304 : status, { "content-type": type, ...SECURITY_HEADERS, ...extra, ...encoding, ...(tag && { etag: tag }) });
      res.end(req.method === "HEAD" || fresh ? undefined : gzip ? gzipSync(body) : body);
    };
    const cors = CORS;
    // What the two POSTs say, and every error: plain text, or JSON for a client
    // that prefers it, where an error has a code a program can tell it from the
    // others by.
    const answer = (status: number, text: string, json: object, extra?: Record<string, string>) =>
      prefersJson(req) ? send(status, CONTENT_TYPE.json, JSON.stringify(json) + "\n", extra) : send(status, CONTENT_TYPE.text, text, extra);
    if (req.method === "OPTIONS") {
      return send(204, "text/plain", "", {
        ...cors,
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "accept, cache-control, if-none-match",
        // For a day, or as much of one as a browser allows: without this, it asks again every five seconds.
        "access-control-max-age": "86400",
      });
    }
    // A path that starts with two slashes is still a path. A URL that starts with them names a host next, so
    // //whoami was the home page on a host called whoami, and // alone was no URL at all.
    const url = new URL(req.url!.replace(/^\/\//, "http://localhost//"), "http://localhost");
    // A path that isn't properly percent-encoded (/%E0%A4%A) can't be decoded: that's the client's mistake.
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/";
    } catch {
      const error = "the path isn't properly percent-encoded";
      return answer(400, `Bad Request: ${error}\n`, { error, code: "bad_path" }, cors);
    }

    // The two POSTs are for the site's own pages (and for curl, which says
    // nothing of where it's from). Another site's page can't read the answer,
    // but without this it could still send one: a form needs no permission.
    if (req.method === "POST" && foreign(req))
      return answer(403, "Forbidden: that's for this site's own pages\n", { error: "that's for this site's own pages", code: "cross_origin" });
    // A tab checking in, for who and w: its token and the page it's on.
    if (req.method === "POST" && pathname === "/who") {
      const token = url.searchParams.get("token") ?? "";
      const page = url.searchParams.get("page") ?? "";
      const code = !/^[\w-]{16,64}$/.test(token) ? "bad_token" : !PAGES_ON.includes(page) ? "bad_page" : null;
      if (code) return answer(400, "Bad Request: token and page are required\n", { error: "token and page are required", code });
      // A tab checks in once a minute; an address that does it much more than its tabs would is filling the list.
      if (limit && !(await limit(String(req.socket.remoteAddress))))
        return answer(
          429,
          "Too Many Requests: a check-in a minute is plenty\n",
          { error: "a check-in a minute is plenty", code: "busy" },
          { "retry-after": "60" },
        );
      return send(200, "application/json; charset=utf-8", JSON.stringify(await host.beat(token, page as Page)) + "\n", { "cache-control": "no-store" });
    }
    // write sferik: the message is the body, sent on by email.
    if (req.method === "POST" && pathname === "/write") {
      const say = (status: number, message: string, code?: string, extra?: Record<string, string>) =>
        answer(status, `write: ${message}\n`, code ? { error: message, code } : { message }, extra);
      if (!mail) return say(503, "sferik isn't taking messages here", "unavailable");
      const text = await readBody(req, 5000);
      if (text === null) return say(413, "that's too long for write; try mail", "too_long");
      if (!text.trim()) return say(400, "nothing to send", "empty");
      const key = req.headers["idempotency-key"] as string | undefined;
      if (key !== undefined && !/^[\w-]{16,64}$/.test(key))
        return say(400, "that's no Idempotency-Key; try 16 to 64 letters, digits, hyphens, and underscores", "bad_key");
      const ration = await host.mail(String(req.socket.remoteAddress), key);
      if (ration === "sent") return say(202, "message sent to sferik"); // already, with this key
      if (ration !== "ok") {
        const message = {
          busy: "one message a minute, please",
          full: "sferik has had enough messages for today; try again tomorrow",
          sending: "that message is still being sent; ask again in a moment",
          undelivered: UNDELIVERED,
        }[ration.why];
        // Still being sent isn't too many: it's the same message, asked after too soon.
        // Nor is one that didn't go through: it's told so again, as it was the first time.
        const status = { busy: 429, full: 429, sending: 409, undelivered: 502 }[ration.why];
        return say(status, message, ration.why, { "retry-after": String(ration.wait) });
      }
      const tty = url.searchParams.get("tty");
      try {
        await mail({ text, tty: tty && /^ttys\d{3}$/.test(tty) ? tty : null, replyTo: EMAIL.exec(text)?.[0] ?? null });
      } catch (err) {
        console.error(err);
        await host.unsent(key);
        // In a minute, which is when the host takes another from this address.
        return say(502, UNDELIVERED, "undelivered", { "retry-after": String(MAIL_EVERY / 1000) });
      }
      if (key) await host.delivered(key);
      return say(202, "message sent to sferik");
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return answer(405, "Method Not Allowed\n", { error: "Method Not Allowed", code: "method_not_allowed" }, { allow: "GET, HEAD, OPTIONS" });
    // The API's description, for API tools (and cross-origin, like the API itself).
    if (pathname === "/openapi.json") {
      return send(200, "application/openapi+json; charset=utf-8", await asset("openapi.json"), {
        ...cors,
        "cache-control": "public, max-age=300",
      });
    }
    if (pathname === "/.well-known/webfinger") {
      const account = url.searchParams.get("resource");
      if (!account) {
        const error = "the resource parameter is required";
        return answer(400, `Bad Request: ${error}\n`, { error, code: "no_resource" }, cors);
      }
      if (!ACCOUNT.test(account)) return answer(404, `No such account: ${account}\n`, { error: `No such account: ${account}`, code: "no_account" }, cors);
      return send(200, "application/jrd+json; charset=utf-8", JSON.stringify(WEBFINGER, null, 2) + "\n", { ...cors, "cache-control": "public, max-age=3600" });
    }
    // Where to report a security problem with the site (RFC 9116), which is to
    // be read again before it's half a year old: so it's always that far off.
    if (pathname === "/.well-known/security.txt") {
      const profile = (await read("profile")) as Profile;
      const expires = new Date(Math.floor(now() / 864e5) * 864e5 + 180 * 864e5);
      const lines = [
        `Contact: mailto:${profile.email}`,
        `Expires: ${seconds(expires)}`,
        `Canonical: ${profile.url}/.well-known/security.txt`,
        "Preferred-Languages: en",
      ];
      return send(200, "text/plain; charset=utf-8", lines.join("\n") + "\n", { ...cors, "cache-control": "public, max-age=3600" });
    }
    if (pathname === "/version") {
      const { commit = null, deployed = null } = version;
      const body = { commit, deployed, url: commit && `https://github.com/sferik/sferik-web/commit/${commit}` };
      return send(200, "application/json; charset=utf-8", JSON.stringify(body, null, 2) + "\n", { ...cors, "cache-control": "no-cache" });
    }
    if (pathname === "/.signature")
      return send(200, "text/plain; charset=utf-8", signature((await read("profile")) as Profile), { ...cors, "cache-control": "public, max-age=3600" });
    if (pathname === "/sitemap.xml") return send(200, "application/xml; charset=utf-8", SITEMAP, { "cache-control": "public, max-age=3600" });
    if (pathname === "/talks.atom") {
      return send(200, "application/atom+xml; charset=utf-8", talksFeed((await site.modules.talks()) as Talks), {
        ...cors,
        "cache-control": "public, max-age=3600",
      });
    }
    let resource: Resource | undefined = resources[pathname];
    let format: Format | null;
    // /resume.pdf, /whoami.json, …: a suffix the resource supports picks the format.
    const suffix = pathname.match(/\.(json|txt|tex|pdf|vcf)$/);
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
        // The home page gets its h-card and who it's about, and the talks page its JSON-LD.
        let page = versioned(new TextDecoder().decode(await asset(file)));
        if (file === "index.html") {
          const profile = (await read("profile")) as Profile;
          const person = personJsonLd(profile, await site.resume());
          const card = banner(profile, await figletFont());
          page = page.replace("</head>", () => `  ${person}\n  </head>`).replace('<header class="banner" data-profile></header>', () => card);
        }
        if (file === "talks.html") page = page.replace("</head>", `  ${talksJsonLd((await site.modules.talks()) as Talks)}\n  </head>`);
        // Every page gets the JSON it builds itself from, so it needn't ask for it.
        const built = await build(file);
        const data = embedded(built);
        page = page.replace("</body>", () => `  ${data}\n  </body>`);
        // And, for a reader that doesn't run scripts (a crawler, a link preview,
        // a text browser), the page as text: what curl gets, from what was just built.
        const text = await resources[file === "index.html" ? "/" : `/${file.replace(".html", "")}`].text(built);
        page = page.replace(/<\/noscript\s*>/, () => `<pre>${xml(text.trimEnd())}</pre></noscript>`);
        return send(200, CONTENT_TYPE.html, page, { vary: "Accept", "cache-control": "no-cache" });
      }
      const headers = {
        ...vary,
        "cache-control": resource.cache ?? LIVE_FOR,
        ...(FILENAME[format] && { "content-disposition": `inline; filename="${FILENAME[format]}"` }),
      };
      const body =
        format === "json"
          ? JSON.stringify(await resource.json(), null, 2) + "\n"
          : format === "text"
            ? // One newline at the end, except after nothing: who prints none with nobody on.
              (await resource.text()).replace(/(?<=[^\n])\n*$/, "\n")
            : await resource[format]!();
      return send(200, CONTENT_TYPE[format], body, headers);
    }

    // /v/<commit>/site.js is site.js. Under another commit than the one
    // deployed (a page from before a deploy, asking after it), it's still the
    // file there is now, but then it's not that URL's for good.
    const [, commit, name = pathname] = VERSIONED.exec(pathname) ?? [];
    if (PUBLIC.test(name)) {
      const file = await files.asset(name.slice(1));
      if (file) {
        return send(200, TYPES[path.extname(name) || ".plan"], file.body, {
          ...(file.modified && { "last-modified": file.modified.toUTCString() }),
          // At their own URLs, scripts and styles are checked on every load,
          // like the pages, so a new version never runs with an old one.
          // Images and figlet's font rarely change: they're kept for a day,
          // and for a week after that can be shown while a newer one is fetched.
          "cache-control":
            commit && commit === version.commit
              ? "public, max-age=31536000, immutable"
              : /\.(?:js|css)$/.test(name)
                ? "no-cache"
                : /\.(?:svg|png|ico|webp|flf)$/.test(name)
                  ? "public, max-age=86400, stale-while-revalidate=604800"
                  : "public, max-age=300",
        });
      }
    }

    // Which 404 depends on what was asked for, so caches must keep them apart too.
    const missing = { vary: "Accept", ...cors };
    if (format === "json")
      return send(404, "application/json; charset=utf-8", JSON.stringify({ error: "Not Found", code: "not_found", path: pathname }) + "\n", missing);
    if (format === "html") return send(404, TYPES[".html"], versioned(new TextDecoder().decode(await asset("404.html"))), { vary: "Accept" });
    return send(404, "text/plain; charset=utf-8", `cd: The directory '${pathname}' does not exist\n`, missing);
  }

  // A failure in one request answers 500 instead of taking the server down,
  // with the headers everything else has: to any origin, so a page elsewhere
  // that asked the API can tell a failure from no answer at all.
  return (req: IncomingMessage, res: ServerResponse) =>
    handle(req, res).catch((err: unknown) => {
      console.error(err);
      const json = prefersJson(req);
      res.writeHead(500, { "content-type": json ? CONTENT_TYPE.json : CONTENT_TYPE.text, ...SECURITY_HEADERS, ...CORS });
      res.end(json ? JSON.stringify({ error: "Internal Server Error", code: "internal" }) + "\n" : "Internal Server Error\n");
    });
}

if (import.meta.main) {
  const { PORT = "3745", SFERIK_OFFLINE, GITHUB_TOKEN, COMMIT, DEPLOYED } = process.env;
  // write's messages, printed here rather than emailed.
  const mail = async (l: Letter) => console.log("write:", l);
  const app = createApp({ offline: Boolean(SFERIK_OFFLINE), token: GITHUB_TOKEN, version: { commit: COMMIT, deployed: DEPLOYED }, compress: true, mail });
  const server = http.createServer(app).listen(Number(PORT), () => {
    console.log(`sferik.net on http://localhost:${(server.address() as import("node:net").AddressInfo).port}`);
  });
  // Shut down cleanly, so in-flight requests finish (and coverage gets written).
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
