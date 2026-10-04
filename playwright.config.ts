import { defineConfig, devices } from "@playwright/test";

// One time zone everywhere, for the browser (timezoneId below) and for the tests that work out what it should show,
// so that dates read the same on every machine. It's behind UTC, unlike CI, so the shell's `date +%z` prints a
// negative offset as well as the +0000 of `date -u`.
const TIME_ZONE = "America/Los_Angeles";
process.env.TZ = TIME_ZONE;

const PORT = 3746; // one above `bun start` (3745, "erik" on a phone keypad), so both can run

export default defineConfig({
  testDir: "tests",
  testMatch: "*.spec.ts",
  globalSetup: "./tests/support/global-setup.ts",
  globalTeardown: "./tests/support/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    timezoneId: TIME_ZONE,
    // A service worker would answer requests before the tests' mocks see them.
    // The offline test turns it back on.
    serviceWorkers: "block",
    // Locally, use the installed Chrome so no browser download is needed.
    channel: process.env.CI ? undefined : "chrome",
  },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run build && node src/server.ts",
    env: { PORT: String(PORT), SFERIK_OFFLINE: "1" },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
  },
});
