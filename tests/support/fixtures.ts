// A drop-in replacement for @playwright/test's `test` that records coverage
// and waits for pages to finish building themselves from the API.
import { test as base, expect, type Page } from "@playwright/test";
import { mcr } from "./coverage.ts";

// Built: the page has its content, and its shell (if it has one) has loaded.
export const built = (page: Page) => page.waitForFunction(() => !document.querySelector("main[aria-busy], [data-repl]:not([data-ready])"));

export const test = base.extend<{ autoCoverage: null; expectBlocked: RegExp | null }>({
  // A test that means to trip the Content-Security-Policy says what it expects blocked.
  expectBlocked: [null, { option: true }],
  page: async ({ page, expectBlocked }, use) => {
    for (const method of ["goto", "reload"] as const) {
      const original = page[method].bind(page) as (...args: unknown[]) => ReturnType<Page["goto"]>;
      (page as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        const response = await original(...args);
        await built(page);
        return response;
      };
    }
    // The site runs under a strict Content-Security-Policy: anything it
    // blocks fails the test.
    const blocked: string[] = [];
    page.on("console", (m) => {
      const text = m.text();
      if (m.type() === "error" && text.includes("Content Security Policy") && !expectBlocked?.test(text)) blocked.push(text);
    });
    await use(page);
    expect(blocked).toEqual([]);
  },
  autoCoverage: [
    async ({ page, browserName }, use) => {
      const collect = browserName === "chromium";
      if (collect) await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use(null);
      if (collect) await mcr().add(await page.coverage.stopJSCoverage());
    },
    { auto: true },
  ],
});

export { expect };
