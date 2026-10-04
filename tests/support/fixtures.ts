// A drop-in replacement for @playwright/test's `test` that records coverage
// and waits for pages to finish building themselves from the API.
import { test as base, expect, type Page } from "@playwright/test";
import { mcr } from "./coverage.ts";

export const built = (page: Page) => page.waitForFunction(() => !document.querySelector("main[aria-busy]"));

export const test = base.extend<{ autoCoverage: null }>({
  page: async ({ page }, use) => {
    for (const method of ["goto", "reload"] as const) {
      const original = page[method].bind(page) as (...args: unknown[]) => ReturnType<Page["goto"]>;
      (page as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        const response = await original(...args);
        await built(page);
        return response;
      };
    }
    await use(page);
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
