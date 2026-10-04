/*
 * sferik.com
 * No dependencies. The pages build themselves from the site's own API:
 * each URL also answers with JSON (Accept: application/json) or plain text.
 */
import { $, $$, el, fmt, MON, reduceMotion, span } from "./dom.js";
import type { Block, Contributions, Day, Finger, Home, ModuleId, Modules, NameChange, Resume, Src, Talk, Talks, Whoami } from "../types.js";

// ---------------------------------------------------------------- theme
// Light and dark follow the system setting via CSS. The only override is
// the phosphor easter egg, which lasts until the next page load.
const root = document.documentElement;
try {
  localStorage.removeItem("theme"); // left over from an earlier version
} catch {}
// d flips between light and dark, starting from whatever is showing.
const toggleDark = () => {
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
};
const togglePhosphor = () => {
  if (root.dataset.theme === "phosphor") delete root.dataset.theme;
  else root.dataset.theme = "phosphor";
};

// The page scrolls inside this element so the status line never covers text.
const scroller = $("[data-scroller]")!;
if (!location.hash && !$("[autofocus]")) {
  scroller.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- clock
const clock = $("[data-clock]");
if (clock) {
  const tick = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const mon = d.toLocaleString("en-US", { month: "short" });
    clock.textContent = `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}-${mon}-${String(d.getFullYear()).slice(2)}`;
  };
  tick();
  setInterval(tick, 10_000);
}

// ------------------------------------------------------------- the API
// Every page builds itself from the same URLs the API serves: ask for JSON,
// render it. (Ask for text/plain instead and you get terminal output.)
export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
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
const starCount = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);
const monthYear = (ym: string) => `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
// **bold**, *italic*, and web addresses (as links), the only markup in the
// data's plain strings.
const md = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/\b([a-z][a-z0-9-]*\.(?:com|org)(?:\/[a-z0-9/-]+)?)/g, '<a href="https://$1">$1</a>');

// "sferik@mbp ~> ls -lS ~/src", with the command bold and its arguments not.
function prompt(command: string, id: string | null, tag: "h1" | "h2" = "h2") {
  const [cmd, ...args] = command.split(" ");
  return el(
    tag,
    { class: "ps1", id },
    el("span", { class: "prompt", "aria-hidden": "true" }, span("sferik", "p-user"), "@mbp ", span("~", "p-cwd"), "> "),
    cmd,
    ...(args.length ? [" ", span(args.join(" "), "arg")] : []),
  );
}
const section = (id: string, command: string, ...body: Node[]) => el("section", { class: "cmd", "aria-labelledby": id }, prompt(command, id), ...body);

// whoami's paragraphs and comic, also used by the shell's whoami.
export function blocks(list: Block[]): HTMLElement[] {
  return list.map((b) =>
    b.type === "p"
      ? el("p", { html: b.html })
      : el(
          "figure",
          { class: "xkcd" },
          el("img", { src: b.src, srcset: b.srcset, width: b.width, height: b.height, loading: "lazy", alt: b.alt, title: b.title }),
          el("figcaption", { class: "dim", html: b.caption }),
        ),
  );
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
  for (const [u, n] of units) if (s >= n) return `${Math.floor(s / n)} ${u}${Math.floor(s / n) > 1 ? "s" : ""} ago`;
  return "moments ago";
}

// Contribution graph: month labels, day names, and one ■ per day.
const GLYPHS = ["■", "■", "■", "■", "■"];
function graph(days: Day[]) {
  const first = new Date(days[0].date + "T00:00:00");
  const cells: (Day | null)[] = [...Array<null>(first.getDay()).fill(null), ...days];
  const weeks = Math.ceil(cells.length / 7);
  // Month labels go on the first week of each month. Like GitHub, drop a
  // label that would crowd the next one (a partial month at the start).
  const labels: { w: number; m: number }[] = [];
  for (let w = 0, last = -1; w < weeks; w++) {
    const d = (cells[w * 7] || cells[w * 7 + 6])!; // the first column may start mid-week
    const m = new Date(d.date + "T00:00:00").getMonth();
    if (m !== last) labels.push({ w, m });
    last = m;
  }
  const months = labels.filter((l, i) => !labels[i + 1] || labels[i + 1].w - l.w >= 3);
  const grid = el("div", { class: "cal", "aria-hidden": "true" });
  grid.style.setProperty("--weeks", String(weeks));
  const place = (node: HTMLElement, row: number, col: number) => {
    node.style.gridRow = String(row);
    node.style.gridColumn = String(col);
    grid.append(node);
  };
  for (const { w, m } of months) place(span(MON[m], "cal-month"), 1, w + 2);
  ["Mon", "Wed", "Fri"].forEach((name, i) => place(span(name, "cal-day"), 3 + i * 2, 1));
  cells.forEach((c, i) => {
    if (!c) return;
    const s = span(GLYPHS[c.level], `cal-cell c${c.level}`);
    s.title = `${c.count} contribution${c.count === 1 ? "" : "s"} on ${c.date}`;
    place(s, (i % 7) + 2, Math.floor(i / 7) + 2);
  });
  return grid;
}

const RENDER: { [K in ModuleId]: (m: Modules[K]) => HTMLElement } = {
  whoami: (m: Whoami) => section("whoami", m.command, el("div", { class: "out" }, ...blocks(m.blocks))),

  contributions(m: Contributions) {
    const github = el("p", { class: "dim", "data-live": "github" }, `On GitHub since ${m.since}.`);
    if (m.lastPush) {
      const date = new Date(m.lastPush.at);
      const when = el("time", { datetime: m.lastPush.at }, ago(date));
      const link = el(
        "a",
        {
          href: `https://github.com/${m.lastPush.repo}/commit/${m.lastPush.sha}`,
          title: `${m.lastPush.repo}@${m.lastPush.sha.slice(0, 7)}, ${date.toLocaleString()}`,
        },
        when,
      );
      github.replaceChildren(`On GitHub since ${m.since} through `, link, ".");
      setInterval(() => (when.textContent = ago(date)), 60_000);
    }
    return section(
      "graph",
      m.command,
      el("div", { class: "out graph", "data-graph": true }, graph(m.contributions)),
      el(
        "p",
        { class: "graph-meta dim", "data-graph-meta": true },
        `${fmt(m.total)} contributions in the last year, longest streak ${m.longestStreak} days`,
        ...(m.live ? [] : [span(" (cached)", "dim")]),
      ),
      github,
      el("p", { class: "sr-only", "data-graph-sr": true }, `${fmt(m.total)} GitHub contributions in the last year.`),
    );
  },

  src(m: Src) {
    const n = (value: string | null, unit: string, title: string) =>
      el("td", { class: "n", title: value === null ? null : title }, value === null ? "" : value + unit);
    const rows = m.projects.map((p) =>
      el(
        "tr",
        {},
        el("td", { class: "name" }, el("a", { href: p.url }, p.name)),
        el("td", { class: "hide-sm" }, p.description),
        n(p.downloads === null ? null : short(p.downloads), "↓", "RubyGems downloads"),
        n(p.stars === null ? null : starCount(p.stars), "★", "GitHub stars"),
      ),
    );
    const total = el(
      "tr",
      {},
      el("td", { class: "name" }, "total"),
      el("td", { class: "hide-sm" }),
      el(
        "td",
        { class: "n" },
        el(
          "a",
          { href: "https://rubygems.org/profiles/sferik", title: `${fmt(m.total.downloads)} downloads across all ${m.total.gems} gems` },
          el("span", { "data-live": "downloads" }, short(m.total.downloads)),
          "↓",
        ),
      ),
      el("td", { class: "n", title: "GitHub stars for the repositories above" }, `${starCount(m.total.stars)}★`),
    );
    return section(
      "src",
      m.command,
      el("table", { class: "ls" }, el("tbody", {}, ...rows), el("tfoot", {}, total)),
      el("p", { class: "dim", style: "margin-top:.5lh" }, "More repositories at ", el("a", { href: m.more }, "github.com/sferik")),
    );
  },

  name: (m: NameChange) =>
    section(
      "name",
      m.command,
      el(
        "div",
        { class: "out gitlog" },
        el("p", {}, el("button", { type: "button", class: "sha", "data-run": `git show ${m.commit}` }, m.commit), ` ${m.subject} `, span(`(${m.year})`, "dim")),
        ...m.notes.map((html, i) => el("p", { class: "dim", style: i ? null : "margin-top:0", html })),
      ),
    ),

  talks: (m: Talks) =>
    section(
      "talks",
      "ls -t ~/talks | head -6",
      el("ol", { class: "out talks" }, ...m.talks.filter((t) => t.featured).map((t) => talk(t, monthYear(t.date)))),
      el(
        "p",
        { style: "margin-top:.5lh" },
        el("a", { href: "/talks" }, "All talks"),
        " ",
        el("span", { class: "dim" }, "Slides are on ", el("a", { href: m.speakerDeck }, "Speaker Deck"), "."),
      ),
    ),

  finger(m: Finger) {
    const rows: [string, string | Node][] = [
      ["Login", m.login],
      ["Name", m.name],
      ["Directory", m.directory],
      ["Shell", m.shell],
      ["Mail", el("a", { href: `mailto:${m.mail}`, "data-open": "mail email" }, m.mail)],
      ["Plan", m.plan],
    ];
    const s = section(
      "finger-cmd",
      m.command,
      el(
        "div",
        { class: "out" },
        el("dl", { class: "finger" }, ...rows.flatMap(([k, v]) => [el("dt", {}, `${k}:`), el("dd", {}, v)])),
        el(
          "ul",
          { class: "socials", style: "margin-top:1lh", "aria-label": "Elsewhere" },
          ...m.profiles.map((p) =>
            el(
              "li",
              {},
              el("a", {
                href: p.url,
                "data-open": p.aliases.join(" "),
                rel: "me",
                "aria-label": p.network,
                title: p.network,
                html: `<svg class="icon" aria-hidden="true"><use href="/icons.svg#i-${p.icon}"/></svg>`,
              }),
            ),
          ),
        ),
      ),
    );
    s.id = "finger";
    return s;
  },
};

function talk(t: Talk, when: string) {
  const media = [t.slides && el("a", { href: t.slides }, "slides"), t.video && el("a", { href: t.video }, "video")].filter((a): a is HTMLAnchorElement =>
    Boolean(a),
  );
  return el(
    "li",
    {},
    el("span", { class: "when" }, when),
    el(
      "div",
      {},
      el("h3", {}, t.title),
      el("p", {}, span(`${t.event}, ${t.location}`, "where"), ...(media.length ? [" ", el("span", { class: "media" }, ...media)] : [])),
    ),
  );
}

// ---------------------------------------------------------------- pages

async function buildHome(main: HTMLElement) {
  const home = await getJSON<Home>("/");
  $("[data-profile]", main)!.replaceChildren(
    el("h1", {}, home.profile.name),
    el("p", { class: "dim" }, home.profile.location),
    el("p", { style: "margin-top:1lh" }, home.profile.tagline),
  );
  const slots = home.modules.map(() => el("section", { class: "cmd", "aria-busy": "true" }));
  $("[data-modules]", main)!.replaceWith(...slots);
  await Promise.all(
    home.modules.map(async (m, i) => {
      try {
        const render = RENDER[m.id] as (data: unknown) => HTMLElement;
        slots[i].replaceWith(render(await getJSON(m.url)));
      } catch {
        slots[i].replaceWith(section(m.id, `curl -H 'Accept: application/json' ${m.url}`, el("p", { class: "err" }, `curl: (7) Couldn't load ${m.url}`)));
      }
    }),
  );
}

// ------------------------------------------------------------ the session
// With motion allowed, the home page plays like a terminal session: each
// section types its command, then prints its output, when it scrolls into
// view, one at a time and in order. Output streams in a few words at a time,
// the way a chat model's reply does. Scrolling past a section finishes it at
// once. The text stays in the DOM throughout, transparent until it's printed.
const BLOCKS = "div.out, table, tbody, tfoot, ol, ul, dl";
// One step of output: elements that appear together, then words that stream
// in. The graph shows a week at a time; everything else streams.
interface Step {
  show: Element[];
  words: Element[];
}
const steps = (node: Element): Step[] =>
  [...node.children].flatMap((c) =>
    c.matches(".cal") ? weeks(c).map((show) => ({ show, words: [] })) : c.matches(BLOCKS) ? steps(c) : [{ show: [c], words: words(c) }],
  );
function weeks(cal: Element) {
  const cols: Element[][] = [];
  for (const c of cal.children as HTMLCollectionOf<HTMLElement>) (cols[Number(c.style.gridColumn)] ??= []).push(c);
  return cols.filter(Boolean);
}
// Wrap each word (with the space after it, so a link's underline doesn't
// show early) in a span. Images and icons count as words.
function words(node: Node): Element[] {
  return [...node.childNodes].flatMap((child) => {
    if (child instanceof HTMLImageElement || child instanceof SVGSVGElement) return [child];
    if (!(child instanceof Text)) return words(child);
    const tokens = (child.data.match(/\s*\S+\s*/g) ?? []).map((w) => span(w, "word"));
    if (tokens.length) child.replaceWith(...tokens);
    return tokens;
  });
}

function session(main: HTMLElement) {
  const sections = $$<HTMLElement>("section.cmd", main);
  const output = sections.map((s) => steps(s).slice(1)); // everything after the prompt
  sections.forEach((s, i) => {
    s.classList.add("unplayed");
    for (const step of output[i]) for (const e of [...step.show, ...step.words]) e.classList.add("unrevealed");
  });
  let current = -1; // the section playing
  let target = -1; // the furthest section scrolled to; everything before it finishes at once
  let running = false;
  let wake = () => {};
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (current < target) return resolve();
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function type(s: HTMLElement, pause: number) {
    const ps1 = s.firstElementChild!;
    const walk = document.createTreeWalker(ps1, NodeFilter.SHOW_TEXT);
    const typed: [Text, string][] = [];
    while (walk.nextNode()) {
      const t = walk.currentNode as Text;
      if (!t.parentElement!.closest(".prompt")) typed.push([t, t.data]);
    }
    for (const [t] of typed) t.data = "";
    const cursor = span("", "cursor");
    ps1.append(cursor);
    s.classList.remove("unplayed");
    await wait(pause);
    cursor.classList.add("typing");
    for (const [t, text] of typed)
      for (const ch of text) {
        t.data += ch;
        await wait(ch === " " ? 80 : 20 + Math.random() * 40);
      }
    await wait(180);
    cursor.remove();
  }

  async function print({ show, words }: Step) {
    for (const e of show) e.classList.remove("unrevealed");
    for (let i = 0; i < words.length;) {
      for (const w of words.slice(i, (i += 1 + Math.floor(Math.random() * 3)))) w.classList.remove("unrevealed");
      await wait(16);
    }
    // Put the text back the way it was.
    for (const w of words) if (w.matches(".word")) w.replaceWith(w.textContent!);
    show[0].normalize();
    await wait(8);
  }

  async function run() {
    running = true;
    while (current < target) {
      current++;
      await type(sections[current], current ? 300 : 700);
      for (const step of output[current]) await print(step);
    }
    running = false;
  }

  // Reaching the shell at the bottom counts as reaching the last section.
  const index = new Map<Element, number>(sections.map((s, i) => [s, i]));
  index.set($("[data-repl]", main)!, sections.length - 1);
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) target = Math.max(target, index.get(e.target)!);
      if (current < target) wake();
      if (!running) void run();
    },
    { root: scroller, rootMargin: "0px 0px -10% 0px" },
  );
  return () => index.forEach((_, e) => seen.observe(e));
}

async function buildTalks(main: HTMLElement) {
  const m = await getJSON<Talks>("/talks");
  const conferences = new Set(m.talks.map((t) => t.event)).size;
  const years = [...new Set(m.talks.map((t) => t.date.slice(0, 4)))];
  main.append(
    el(
      "section",
      { class: "cmd", style: "margin-top:0" },
      prompt(m.command, null, "h1"),
      el(
        "div",
        { class: "out" },
        el(
          "p",
          {},
          `${m.talks.length} talks at ${conferences} conferences in 13 countries, ${years.at(-1)} to ${years[0]}. Talks from before 2017 are listed under my former name, Erik Michaels-Ober. Slides are also on `,
          el("a", { href: m.speakerDeck }, "Speaker Deck"),
          ".",
        ),
      ),
      ...years.flatMap((y) => [
        el("h2", { class: "year-head", id: `y${y}` }, y),
        el("ol", { class: "talks talks-by-year" }, ...m.talks.filter((t) => t.date.startsWith(y)).map((t) => talk(t, MON[Number(t.date.slice(5, 7)) - 1]))),
      ]),
    ),
    el(
      "section",
      { class: "cmd", "aria-labelledby": "pods" },
      prompt("ls -lt ~/podcasts", "pods"),
      el(
        "ol",
        { class: "talks" },
        ...m.podcasts.map((p) =>
          el(
            "li",
            {},
            el("span", { class: "when" }, monthYear(p.date)),
            el("div", {}, el("h3", {}, el("a", { href: p.url }, p.title)), el("p", { class: "where" }, p.show)),
          ),
        ),
      ),
    ),
  );
}

// The resume, formatted like a man page, from its JSON Resume document.
async function buildResume(main: HTMLElement) {
  const r = await getJSON<Resume>("/resume");
  const b = r.basics;
  const year = (d: string) => d.slice(0, 4);
  const range = (x: { startDate: string; endDate?: string }) => `${year(x.startDate)}–${x.endDate ? year(x.endDate) : ""}`.replace(/^(\d{4})–\1$/, "$1");
  const sec = (title: string, ...body: Node[]) => el("section", {}, el("h2", {}, title), el("div", { class: "body" }, ...body));
  const entries = (items: [string, string][]) =>
    el("ol", { class: "entries" }, ...items.map(([when, html]) => el("li", {}, span(when, "when"), el("span", { html }))));
  main.append(
    el("header", { class: "man-head", "aria-hidden": "true" }, span("SFERIK(1)"), span("General Commands Manual"), span("SFERIK(1)")),
    el("h1", { class: "sr-only" }, `${b.name}, résumé`),
    sec(
      "NAME",
      el("p", {}, el("b", {}, "sferik"), `, ${b.name} – ${b.label.toLowerCase()}, ${b.location.city}, ${b.location.region}`),
      el("p", { style: "margin-top:0" }, el("a", { href: `mailto:${b.email}` }, b.email), ", ", el("a", { href: b.url }, "sferik.com")),
    ),
    sec("DESCRIPTION", ...b.summary.split("\n\n").map((p) => el("p", { html: md(p) }))),
    sec(
      "EXPERIENCE",
      el(
        "ol",
        { class: "jobs" },
        ...r.work.map((w) =>
          el(
            "li",
            {},
            span(range(w), "when"),
            el("div", {}, span(w.position, "role"), `, ${w.name}`, ...(w.highlights ? [el("ul", {}, ...w.highlights.map((h) => el("li", {}, h)))] : [])),
          ),
        ),
      ),
    ),
    sec("OPEN SOURCE", el("ul", { class: "oss" }, ...r.projects.map((p) => el("li", { html: `<b>${p.name}</b>: ${p.description}` })))),
    sec("LANGUAGES", el("p", {}, `${r.skills[0].keywords.join(", ")}.`)),
    sec("HONORS", entries(r.awards.map((a) => [year(a.date), `${a.title}, ${a.summary.charAt(0).toLowerCase()}${a.summary.slice(1)}`]))),
    sec("PATENTS", entries(r.patents.map((p) => [year(p.date), `<a href="${p.url}">${p.title}</a>, ${p.number}`]))),
    sec("SPEAKING", el("p", { html: md(r.speaking.summary) })),
    sec("EDUCATION", entries(r.education.map((e) => [range(e), `${e.institution}, ${e.location}. ${e.highlights.join(". ")}.`]))),
    sec(
      "SERVICE",
      entries(
        r.volunteer.map((v) => [
          range(v),
          v.summary
            ? `${v.organization}, ${v.position}; ${v.summary.replace("pacificprimary.org", '<a href="https://pacificprimary.org">pacificprimary.org</a>')}`
            : `${v.position}: ${v.organization}.`,
        ]),
      ),
    ),
    sec("HISTORY", el("p", {}, `Known as ${b.formerName} until June 24, 2017.`)),
    sec(
      "SEE ALSO",
      el(
        "p",
        {},
        ...[b.url, ...b.profiles.map((p) => p.url)].flatMap((u, i) => [...(i ? [", "] : []), el("a", { href: u }, u.replace(/^https:\/\/(www\.)?/, ""))]),
      ),
    ),
    el(
      "footer",
      { class: "man-foot", "aria-hidden": "true" },
      span("sferik.com"),
      span(new Date().toLocaleString("en-US", { month: "long", year: "numeric" })),
      span("SFERIK(1)"),
    ),
  );
}

const main = $("main[data-page]");
const BUILD: Record<string, (main: HTMLElement) => Promise<unknown>> = { home: buildHome, talks: buildTalks, resume: buildResume };
export const ready: Promise<unknown> = main
  ? BUILD[main.dataset.page!](main)
      .catch(() => main.append(el("p", { class: "err" }, "curl: (7) Couldn't reach the API. Try reloading.")))
      .then(() => {
        const play = main.dataset.page === "home" && !reduceMotion ? session(main) : null;
        main.removeAttribute("aria-busy");
        if (location.hash) $(location.hash)?.scrollIntoView();
        play?.();
      })
  : Promise.resolve();

// The interactive shell lives in shell.js; the shortcuts below only need to find it.
const repl = $("[data-repl]");

// ------------------------------------------------- keyboard shortcuts
const help = $("[data-help]");
let pendingG = false;
let konami: string[] = [];
const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

document.addEventListener("keydown", (e) => {
  konami = konami.concat(e.key).slice(-KONAMI.length);
  if (konami.join() === KONAMI.join()) {
    togglePhosphor();
    konami = [];
  }

  const t = e.target as Element;
  if (t.matches("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;

  if (pendingG) {
    pendingG = false;
    const go = ({ h: "/", t: "/talks", r: "/resume" } as Record<string, string>)[e.key];
    if (go) location.href = go;
    if (e.key === "g") scroller.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    return;
  }
  switch (e.key) {
    case "g":
      pendingG = true;
      setTimeout(() => (pendingG = false), 800);
      break;
    case "G":
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
      break;
    case "j":
      scroller.scrollBy({ top: 60 });
      break;
    case "k":
      scroller.scrollBy({ top: -60 });
      break;
    case "/":
    case ":":
      if (repl) {
        e.preventDefault();
        $("input", repl)!.focus();
        $("input", repl)!.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
      }
      break;
    case "d":
      toggleDark();
      break;
    case "?":
      if (help) help.hidden = !help.hidden;
      break;
    case "Escape":
      if (help) help.hidden = true;
      break;
  }
});

// ------------------------------------------------- for people who read source
console.log(
  "%c\n  ┌─────────────────────────────────────────┐\n  │  Hi. You opened the console.            │\n  │  No frameworks, no trackers, no build.  │\n  │  View source; it's meant to be read.    │\n  │                        — @sferik        │\n  └─────────────────────────────────────────┘\n",
  "font-family: ui-monospace, Menlo, monospace; line-height: 1.3",
);
