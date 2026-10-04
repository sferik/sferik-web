// The home page plays like a terminal session: each section types its
// command and prints its output as it scrolls into view.
import { test, expect } from "./support/fixtures.ts";
import type { Page } from "@playwright/test";
import { mockAPIs } from "./support/mocks.ts";

const sections = (page: Page) => page.locator("section.cmd");
const played = (page: Page, id: string) => expect(page.locator(`section:has(> #${id}) .unrevealed, section:has(> #${id}).unplayed`)).toHaveCount(0);

test.beforeEach(async ({ page }) => {
  await mockAPIs(page);
});

test("the page opens on an empty prompt, then types whoami and prints its output", async ({ page }) => {
  await page.goto("/");
  const whoami = page.locator("#whoami");
  await expect(whoami.locator(".cursor")).toBeVisible();
  expect(await whoami.textContent()).toBe("sferik@mbp ~> ");
  await expect(whoami).toHaveText("sferik@mbp ~> whoami");
  await expect(whoami.locator(".cursor")).toHaveCount(0);
  await played(page, "whoami");
  // Sections further down wait until they're scrolled to.
  await expect(sections(page).last()).toHaveClass(/unplayed/);
  await expect(page.locator("#finger")).toHaveCSS("opacity", "0");
});

test("output streams in a few words at a time, then the text is put back as it was", async ({ page }) => {
  await page.goto("/");
  const out = page.locator("#whoami + .out");
  const original = await out.textContent();
  // Partway through, some words are showing and the rest are still hidden.
  await expect
    .poll(async () => [await out.locator(".word:not(.unrevealed)").count(), await out.locator(".word.unrevealed").count()].every(Boolean), { intervals: [20] })
    .toBe(true);
  await played(page, "whoami");
  await expect(out.locator(".word")).toHaveCount(0);
  expect(await out.textContent()).toBe(original);
  expect(
    await out
      .locator("p")
      .first()
      .evaluate((p) => [...p.childNodes].some((n, i, all) => n instanceof Text && all[i + 1] instanceof Text)),
  ).toBe(false);
});

test("the graph prints a week at a time", async ({ page }) => {
  await page.goto("/");
  await page.locator("#graph").scrollIntoViewIfNeeded();
  await expect(page.locator("#graph")).toHaveText("sferik@mbp ~> git log --author=sferik --since=1.year --graph");
  await played(page, "graph");
});

test("scrolling past sections finishes them at once and plays the one in view", async ({ page }) => {
  await page.goto("/");
  await page.locator("#talks").scrollIntoViewIfNeeded();
  await played(page, "talks");
  for (const id of ["whoami", "graph", "src", "name"]) await played(page, id);
  await expect(page.locator("section:has(> #src) tr").first()).toHaveCSS("opacity", "1");
});

test("a link to a section plays it", async ({ page }) => {
  await page.goto("/#finger");
  await played(page, "finger-cmd");
  await expect(page.locator(".unplayed, .unrevealed")).toHaveCount(0);
  await expect(page.locator("#finger-cmd")).toHaveText("sferik@mbp ~> finger sferik");
});

test("reaching the shell plays everything", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("/");
  await expect(page.locator(".unplayed, .unrevealed")).toHaveCount(0);
});

test("with reduced motion, everything shows at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".unplayed, .unrevealed, .cursor.typing")).toHaveCount(0);
  await expect(page.locator("#finger-cmd")).toHaveText("sferik@mbp ~> finger sferik");
});

test("scrolling to the bottom puts the cursor at the prompt", async ({ page }) => {
  await page.goto("/");
  const field = page.locator("[data-repl] input");
  await page.locator("[data-scroller]").evaluate((el) => el.scrollBy({ top: 400 }));
  await expect(field).not.toBeFocused();
  await page.locator("[data-scroller]").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(field).toBeFocused();
  await expect(page.locator("[data-repl]")).toHaveClass(/focused/);
});

test("scrolling to the bottom leaves a text selection alone", async ({ page }) => {
  await page.goto("/");
  await page.locator(".banner h1").selectText();
  await page.locator("[data-scroller]").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.waitForTimeout(200);
  await expect(page.locator("[data-repl] input")).not.toBeFocused();
  expect(await page.evaluate(() => getSelection()!.toString())).toBe("Erik Berlin");
});
