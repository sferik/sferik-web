// Accessibility: axe finds no violations on any page, in light or dark mode.
import { test, expect } from "./support/fixtures.ts";
import { AxeBuilder } from "@axe-core/playwright";
import { mockAPIs } from "./support/mocks.ts";

test.beforeEach(async ({ page }) => {
  await mockAPIs(page);
});

for (const scheme of ["light", "dark"] as const) {
  for (const url of ["/", "/talks", "/resume", "/nope"]) {
    test(`${url} in ${scheme} mode has no accessibility violations`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto(url);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`)).toEqual([]);
    });
  }
}
