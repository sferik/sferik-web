// Refreshes the snapshot in data/projects.json: each gem's downloads and each
// repository's stars, the totals, and the day they're from. The site shows
// these when RubyGems or GitHub can't be reached (and until the first
// refresh, on Workers), so they only need to be reasonably recent. A GitHub
// Action runs this daily (.github/workflows/refresh-snapshots.yml); to run
// it yourself: `bun run snapshot`.
import fs from "node:fs";
import path from "node:path";
import type { ProjectsFile } from "../src/types.js";

const file = path.join(import.meta.dirname, "..", "data", "projects.json");
const data = JSON.parse(fs.readFileSync(file, "utf8")) as ProjectsFile;

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
    const repo = await get<{ stargazers_count: number }>(`https://api.github.com/repos/${project.repo}`, process.env.GITHUB_TOKEN);
    if (!Number.isInteger(repo.stargazers_count)) throw new Error(`${project.repo} has no count of stars`);
    project.stars = repo.stargazers_count;
  }
}
data.totalDownloads = gems.reduce((total, g) => total + g.downloads, 0);
data.gemCount = gems.length;
data.snapshot = new Date().toISOString().slice(0, 10);

fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
console.log(`${data.gemCount} gems, ${data.totalDownloads.toLocaleString("en-US")} downloads, as of ${data.snapshot}`);
