// Draws the cards link previews show (X, Slack, iMessage, ...), one per page:
// public/og.png (home: the last year of the contribution graph),
// public/og-talks.png, and public/og-resume.png, each in the site's terminal.
// Run `bun run og` to redraw them after the data changes.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { shade } from "../src/server.ts";

const root = path.join(import.meta.dirname, "..");
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, "data", `${name}.json`), "utf8"));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const profile = read("profile");
const talks = read("talks");
const resume = read("resume");

// The page's shades: the prompt's green mixed into the paper, by quartile.
const GREENS = ["color-mix(in oklab, #24221f 7%, #fff)", ...[25, 50, 75, 100].map((p) => `color-mix(in oklab, #2a7a2e ${p}%, #fff)`)];
const graph = shade(read("contributions").contributions)
  .slice(-52 * 7)
  .map((d) => `<i style="background:${GREENS[d.level]}"></i>`)
  .join("");

const years = [...new Set((talks.talks as { date: string }[]).map((t) => t.date.slice(0, 4)))];
const conferences = new Set((talks.talks as { event: string }[]).map((t) => t.event)).size;
const featured = (talks.talks as { title: string; date: string; featured: boolean }[]).filter((t) => t.featured).slice(0, 4);
const role = resume.work[0];

// The terminal around each card: a prompt, the content, and the tmux bar.
const card = (command: string, window: number, body: string) => `<!doctype html>
<meta charset="utf-8" />
<style>
  body { margin: 0; width: 1200px; height: 630px; display: flex; flex-direction: column; background: #fff; color: #24221f;
    font: 28px/1.5 ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace; }
  main { flex: 1; padding: 64px 80px 0; }
  .prompt { color: #6b665f; } .ok { color: #2a7a2e; } b { font-weight: 700; color: #24221f; }
  h1 { font-size: 72px; line-height: 1.2; margin: 28px 0 8px; }
  p { margin: 0; } .dim { color: #6b665f; }
  ol { list-style: none; margin: 28px 0 0; padding: 0; } li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .graph { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 14px); grid-auto-columns: 14px; gap: 4px; margin-top: 48px; }
  .graph i { width: 14px; height: 14px; border-radius: 3px; }
  footer { display: flex; justify-content: space-between; background: #24221f; color: #f4f1ec; padding: 6px 20px; font-size: 26px; white-space: pre; }
</style>
<main>
  <div class="prompt"><span class="ok">sferik</span>@mbp <span class="ok">~</span>&gt; <b>${esc(command)}</b></div>
  ${body}
</main>
<footer><span>[sferik] ${["home", "talks", "resume"].map((w, i) => (i === window ? `<b style="color:inherit">${i}:${w}*</b>` : `${i}:${w}`)).join("  ")}</span><span>"sferik.net"</span></footer>`;

const CARDS: Record<string, string> = {
  "og.png": card(
    "finger sferik",
    0,
    `<h1>${esc(profile.name)}</h1>
    <p>${esc(profile.tagline)}</p>
    <p class="dim">${esc(profile.location)}</p>
    <div class="graph">${graph}</div>`,
  ),
  "og-talks.png": card(
    "ls -lt ~/talks",
    1,
    `<h1>Talks</h1>
    <p class="dim">${talks.talks.length} talks at ${conferences} conferences in 13 countries, ${years.at(-1)} to ${years[0]}</p>
    <ol>${featured.map((t) => `<li><span class="dim">${t.date}</span>  ${esc(t.title)}</li>`).join("")}</ol>`,
  ),
  "og-resume.png": card(
    "man sferik",
    2,
    `<h1>${esc(profile.name)}</h1>
    <p>${esc(resume.basics.label)}. ${esc(role.position)}, ${esc(role.name)}.</p>
    <p class="dim" style="margin-top:28px">${esc(resume.basics.summary.split(". ")[0])}.</p>`,
  ),
};

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const [file, html] of Object.entries(CARDS)) {
  await page.setContent(html);
  await page.screenshot({ path: path.join(root, "public", file) });
  console.log(`Drew public/${file}`);
}
await browser.close();
