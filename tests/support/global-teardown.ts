// Writes the merged coverage report and fails the run below 100%.
import { mcr, THRESHOLD } from "./coverage.ts";

export default async function globalTeardown() {
  const results = await mcr().generate();
  if (!results) return;
  const { summary } = results;
  const short = (["functions", "branches", "lines"] as const).filter((k) => (summary[k].pct as number) < THRESHOLD);
  if (short.length) {
    throw new Error(`Coverage below ${THRESHOLD}%: ` + short.map((k) => `${k} ${summary[k].pct}%`).join(", ") + ". See coverage/index.html.");
  }
}
