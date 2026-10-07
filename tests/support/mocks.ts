// The site calls three public APIs from the browser. Tests replace them with
// fixtures so they're fast, deterministic, and work offline.
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "data", "contributions.json"), "utf8"));
const SNAPSHOT_TOTAL: number = SNAPSHOT.contributions.reduce((s: number, d: { count: number }) => s + d.count, 0);
// The live fixture differs from the snapshot so tests can tell them apart.
const LIVE = { ...SNAPSHOT, contributions: SNAPSHOT.contributions.map((d: { count: number }, i: number) => (i === 0 ? { ...d, count: d.count + 1000 } : d)) };
const LIVE_TOTAL = SNAPSHOT_TOTAL + 1000;

const LONG_TAIL = 894_331_782;
const PER_GEM = 100; // each of the ten live-fetched gems
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const CORS = { "access-control-allow-origin": "*" };

const pushEvent = (createdAt: string = hoursAgo(2)) => ({
  type: "PushEvent",
  repo: { name: "sferik/x-ruby" },
  payload: { head: "abc1234def5678" },
  created_at: createdAt,
});

interface MockOptions {
  gems?: number | "fail";
  github?: "fail" | object[];
  contributions?: "fail" | object;
  snapshot?: "fail";
}
async function mockAPIs(page: Page, { gems = PER_GEM, github, contributions = LIVE, snapshot }: MockOptions = {}) {
  // Anything not explicitly mocked and not local is blocked.
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
  await page.route("https://rubygems.org/api/v1/gems/*.json", (route) =>
    gems === "fail" ? route.fulfill({ status: 500 }) : route.fulfill({ json: { downloads: gems }, headers: CORS }),
  );
  await page.route("https://api.github.com/users/sferik/events/public*", (route) =>
    github === "fail"
      ? route.fulfill({ status: 403, body: "rate limited" })
      : route.fulfill({
          json: github || [{ type: "WatchEvent", repo: { name: "someone/else" }, created_at: hoursAgo(1) }, pushEvent()],
          headers: CORS,
        }),
  );
  await page.route("https://github-contributions-api.jogruber.de/**", (route) =>
    contributions === "fail" ? route.fulfill({ status: 502 }) : route.fulfill({ json: contributions, headers: CORS }),
  );
  if (snapshot === "fail") await page.route("**/data/contributions.json", (route) => route.abort());
}

// A page comes with the JSON it builds itself from, and asks only for what's
// missing. This takes it out on the way, so the page asks for it all, and a
// test can answer in the API's place.
async function unembed(page: Page) {
  await page.route(
    (url) => ["/", "/talks", "/resume"].includes(url.pathname),
    async (route) => {
      if (!route.request().isNavigationRequest()) return route.fallback();
      const response = await route.fetch();
      const body = (await response.text()).replace(/<script type="application\/json" id="data">.*?<\/script>/s, "");
      await route.fulfill({ response, body });
    },
  );
}

export { unembed, mockAPIs, pushEvent, hoursAgo, SNAPSHOT, SNAPSHOT_TOTAL, LIVE_TOTAL, LONG_TAIL, PER_GEM };
