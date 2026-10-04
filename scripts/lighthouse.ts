// The Lighthouse budget: every page scores 100 for performance, accessibility,
// best practices, and SEO, on a phone and on a desktop. Starts the site, runs
// Lighthouse on each page (the best of three runs, since performance varies a
// little from run to run), and fails with what fell short. `bun run lighthouse`.
import lighthouse from "lighthouse";
import desktop from "lighthouse/core/config/desktop-config.js";
import * as chromeLauncher from "chrome-launcher";
import { spawn } from "node:child_process";
import path from "node:path";

const PORT = 3747;
const PAGES = ["/", "/talks", "/resume"];
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const RUNS = 3;

const server = spawn("node", [path.join(import.meta.dirname, "..", "src", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), SFERIK_OFFLINE: "1" },
  stdio: "ignore",
});
for (let i = 0; ; i++) {
  try {
    await fetch(`http://localhost:${PORT}/`);
    break;
  } catch {
    if (i > 50) throw new Error("The site didn't start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const chrome = await chromeLauncher.launch({ chromeFlags: ["--headless=new"] });
const failures: string[] = [];
try {
  for (const [device, config] of [
    ["phone", undefined],
    ["desktop", desktop],
  ] as const) {
    for (const page of PAGES) {
      const best: Record<string, number> = {};
      const misses = new Map<string, string>();
      for (let run = 0; run < RUNS; run++) {
        const result = await lighthouse(
          `http://localhost:${PORT}${page}`,
          { port: chrome.port, onlyCategories: CATEGORIES, output: "json", logLevel: "error" },
          config,
        );
        const lhr = result!.lhr;
        for (const id of CATEGORIES) {
          const category = lhr.categories[id];
          const score = Math.round((category.score ?? 0) * 100);
          if (score <= (best[id] ?? -1)) continue;
          best[id] = score;
          // What cost points, from the best run so far.
          const lost = category.auditRefs
            .filter((ref) => ref.weight > 0 && (lhr.audits[ref.id].score ?? 1) < 1)
            .map((ref) => `${ref.id} ${lhr.audits[ref.id].displayValue ?? ""}`.trim());
          // Which elements moved, when the layout shifted.
          const shifted = (lhr.audits["layout-shifts"]?.details as { items?: { node?: { snippet?: string } }[] } | undefined)?.items ?? [];
          if (id === "performance" && shifted.length) lost.push(`shifted: ${shifted.map((i) => i.node?.snippet ?? "?").join(" ")}`);
          misses.set(id, lost.join(", "));
        }
      }
      console.log(`${device.padEnd(7)} ${page.padEnd(7)} ${CATEGORIES.map((id) => `${id} ${best[id]}`).join("  ")}`);
      for (const id of CATEGORIES) if (best[id] < 100) failures.push(`${device} ${page}: ${id} ${best[id]} (${misses.get(id)})`);
    }
  }
} finally {
  await chrome.kill();
  server.kill();
}

if (failures.length) {
  console.error(`\nUnder budget:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nEvery page scores 100 in every category.");
