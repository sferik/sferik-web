// Collects V8 coverage for the site's own JavaScript (site.js and inline
// scripts) from every test, and merges it into one report in coverage/.
import MCR, { type CoverageReportOptions } from "monocart-coverage-reports";

export const options: CoverageReportOptions = {
  name: "sferik.com",
  outputDir: "./coverage",
  reports: ["console-details", "v8", "lcovonly"],
  entryFilter: (entry) => entry.url.startsWith("http://localhost:"),
  sourceFilter: (sourcePath) => !sourcePath.includes("node_modules"),
};

export const THRESHOLD = 100;
export const mcr = () => MCR(options);
