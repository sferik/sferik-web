// Refreshes the snapshots in data/: in projects.json, each gem's downloads and
// each repository's stars, the totals, and the day they're from; and in
// contributions.json, the last year of the GitHub contribution graph. The
// site shows these when RubyGems or GitHub can't be reached (and until the
// first refresh, on Workers), so they only need to be reasonably recent. A
// GitHub Action runs this daily (.github/workflows/refresh-snapshots.yml).
// To run it yourself: `GITHUB_TOKEN=$(gh auth token) bun run snapshot`; the
// graph is from GitHub's GraphQL API, which answers only with a token.
import fs from "node:fs";
import path from "node:path";
import type { ProjectsFile } from "../src/types.js";

const DATA = path.join(import.meta.dirname, "..", "data");
const file = path.join(DATA, "projects.json");
const data = JSON.parse(fs.readFileSync(file, "utf8")) as ProjectsFile;
const token = process.env.GITHUB_TOKEN;

async function get<T>(url: string, token?: string): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": "sferik.net", accept: "application/json", ...(token && { authorization: `Bearer ${token}` }) } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

const gems = await get<{ name: string; downloads: number }[]>("https://rubygems.org/api/v1/owners/sferik/gems.json");
// Only accept a well-formed response: every gem there was, or nearly, each with its downloads.
if (gems.length < data.gemCount - 5 || !gems.every((g) => Number.isInteger(g.downloads)))
  throw new Error(`RubyGems listed ${gems.length} gems, not ${data.gemCount}`);
const downloads = new Map(gems.map((g) => [g.name, g.downloads]));

for (const project of data.projects) {
  // A gem someone else owns keeps the downloads it has.
  if (project.gem) project.downloads = downloads.get(project.gem) ?? project.downloads;
  if (project.repo) {
    const repo = await get<{ stargazers_count: number }>(`https://api.github.com/repos/${project.repo}`, token);
    if (!Number.isInteger(repo.stargazers_count)) throw new Error(`${project.repo} has no count of stars`);
    project.stars = repo.stargazers_count;
  }
}
data.totalDownloads = gems.reduce((total, g) => total + g.downloads, 0);
data.gemCount = gems.length;
data.snapshot = new Date().toISOString().slice(0, 10);

fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
console.log(`${data.gemCount} gems, ${data.totalDownloads.toLocaleString("en-US")} downloads, as of ${data.snapshot}`);

// The contribution graph, as GitHub's profile page shows it: a day's level is 0 for none, to 4.
if (token) {
  const LEVELS = ["NONE", "FIRST_QUARTILE", "SECOND_QUARTILE", "THIRD_QUARTILE", "FOURTH_QUARTILE"];
  type Calendar = { totalContributions: number; weeks: { contributionDays: { date: string; contributionCount: number; contributionLevel: string }[] }[] };
  const query = `query { user(login: "sferik") { contributionsCollection { contributionCalendar {
    totalContributions weeks { contributionDays { date contributionCount contributionLevel } } } } } }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { "user-agent": "sferik.net", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  });
  const answer = (await res.json()) as { data?: { user: { contributionsCollection: { contributionCalendar: Calendar } } }; errors?: { message: string }[] };
  if (!res.ok || !answer.data || answer.errors?.length) throw new Error(`GitHub's GraphQL API: ${res.status} ${answer.errors?.[0].message ?? ""}`);
  const calendar = answer.data.user.contributionsCollection.contributionCalendar;
  const contributions = calendar.weeks.flatMap((week) =>
    week.contributionDays.map((day) => ({ date: day.date, count: day.contributionCount, level: LEVELS.indexOf(day.contributionLevel) })),
  );
  // Only accept a full year of days, each with a level.
  if (contributions.length < 365 || contributions.some((day) => day.level < 0)) throw new Error(`GitHub listed ${contributions.length} days of contributions`);
  fs.writeFileSync(path.join(DATA, "contributions.json"), JSON.stringify({ total: { lastYear: calendar.totalContributions }, contributions }));
  console.log(`${calendar.totalContributions.toLocaleString("en-US")} contributions in ${contributions.length} days, through ${contributions.at(-1)!.date}`);
} else console.log("No GITHUB_TOKEN: left the contribution graph as it was");
