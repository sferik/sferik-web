// The home page plays like a terminal session: each section types its
// command and prints its output, scrolling the page down as it goes, until
// you scroll it yourself. Then each section plays as it scrolls into view.
import { test, expect } from "./support/fixtures.ts";
import type { Page } from "@playwright/test";
import { mockAPIs } from "./support/mocks.ts";

const sections = (page: Page) => page.locator("section.cmd");
const played = (page: Page, id: string, timeout?: number) =>
  expect(page.locator(`section:has(> #${id}) .unrevealed, section:has(> #${id}).unplayed`)).toHaveCount(0, { timeout });

test.beforeEach(async ({ page }) => {
  await mockAPIs(page);
});

test("the page opens on an empty prompt, then types whoami and prints its output", async ({ page }) => {
  await page.goto("/");
  const whoami = page.locator("#whoami");
  await expect(whoami.locator(".cursor")).toBeVisible();
  expect(await whoami.locator(":scope > [aria-hidden]:not(.prompt)").textContent()).toBe("sferik@mbp ~> ");
  await expect(whoami).toHaveText("sferik@mbp ~> whoami");
  await expect(whoami.locator(".cursor")).toHaveCount(0);
  await played(page, "whoami");
  // Sections further down wait their turn.
  await expect(sections(page).last()).toHaveClass(/unplayed/);
  await expect(page.locator("#finger")).toHaveCSS("opacity", "0");
  await expect(page.locator("[data-repl]")).toHaveCSS("opacity", "0");
});

test("the shell's prompt shows only once finger has finished printing", async ({ page }) => {
  await page.goto("/");
  // Note how much of finger is still hidden at the moment the shell shows.
  await page.evaluate(() => {
    const repl = document.querySelector("[data-repl]")!;
    new MutationObserver((_, observer) => {
      if (repl.classList.contains("unplayed")) return;
      document.body.dataset.hiddenWhenShown = String(document.querySelectorAll("section:has(> #finger-cmd) .unrevealed").length);
      observer.disconnect();
    }).observe(repl, { attributes: true });
  });
  await page.locator("[data-scroller]").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.locator("body")).toHaveAttribute("data-hidden-when-shown", "0");
  await expect(page.locator("[data-repl]")).toHaveCSS("opacity", "1");
});

test("scrolling to the bottom prints finger at once and shows the prompt", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(500);
  const start = Date.now();
  await page.locator("[data-scroller]").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.locator(".unplayed, .unrevealed")).toHaveCount(0);
  await expect(page.locator("[data-repl]")).toHaveCSS("opacity", "1");
  await expect(page.locator("#finger-cmd")).toHaveText("sferik@mbp ~> finger sferik");
  expect(Date.now() - start).toBeLessThan(1500);
});

test("typing or clicking in the shell shows it right away", async ({ page }) => {
  await page.goto("/");
  const repl = page.locator("[data-repl]");
  // Without scrolling to it, which would show it anyway.
  await page.locator("[data-repl] input").evaluate((e: HTMLElement) => e.focus({ preventScroll: true }));
  await expect(repl).toHaveClass(/unplayed/);
  await page.keyboard.press("h");
  await expect(repl).not.toHaveClass(/unplayed/);
  await page.reload();
  await expect(repl).toHaveClass(/unplayed/);
  await repl.dispatchEvent("pointerdown");
  await expect(repl).not.toHaveClass(/unplayed/);
});

test("left alone, the page scrolls itself down as the sections play, ending at the prompt", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const scroller = page.locator("[data-scroller]");
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(page.locator("[data-repl]")).toHaveClass(/unplayed/);
  await expect(page.locator("[data-repl]")).not.toHaveClass(/unplayed/, { timeout: 45_000 });
  await expect(page.locator(".unplayed, .unrevealed")).toHaveCount(0);
  expect(await scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);
  await expect(page.locator("[data-repl] input")).toBeFocused();
});

test("the page keeps two lines of room below what's printing", async ({ page }) => {
  await page.goto("/");
  const scroller = page.locator("[data-scroller]");
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBeGreaterThan(0);
  // While words stream in, the lowest one sits at least two lines (2 × 22.5px) above the bottom of the page.
  const rooms = await page.evaluate(async () => {
    const scroller = document.querySelector("[data-scroller]")!;
    const rooms: number[] = [];
    for (let i = 0; i < 40; i++) {
      const words = [...document.querySelectorAll("section.cmd:not(.unplayed) .word:not(.unrevealed)")];
      if (words.length) rooms.push(scroller.getBoundingClientRect().bottom - Math.max(...words.map((w) => w.getBoundingClientRect().bottom)));
      await new Promise((r) => setTimeout(r, 50));
    }
    return rooms;
  });
  expect(rooms.length).toBeGreaterThan(0);
  expect(Math.min(...rooms)).toBeGreaterThanOrEqual(44);
});

test("scrolling the page yourself stops it scrolling itself", async ({ page }) => {
  await page.goto("/");
  const scroller = page.locator("[data-scroller]");
  const top = () => scroller.evaluate((el) => el.scrollTop);
  await expect.poll(top, { timeout: 10_000 }).toBeGreaterThan(100);
  const before = await top();
  await page.mouse.move(640, 360);
  await page.mouse.wheel(0, -400);
  await expect.poll(top).toBeLessThan(before);
  const reading = await top();
  await page.waitForTimeout(1500);
  expect(await top()).toBe(reading);
  await expect(sections(page).last()).toHaveClass(/unplayed/);
});

test("screen readers get each command whole, while it types for everyone else", async ({ page }) => {
  await page.goto("/");
  const graph = page.locator("#graph");
  // The prompt is hidden from screen readers anyway: they hear just the command.
  const command = "git log --author=sferik --since=1.year --graph";
  await expect(graph.locator(".cursor.typing")).toBeVisible({ timeout: 15_000 });
  await expect(graph.locator(":scope > [aria-hidden]:not(.prompt)")).not.toHaveText(`sferik@mbp ~> ${command}`);
  await expect(graph.locator(".sr-only")).toHaveText(command);
  await expect(graph).toHaveAccessibleName(command);
  // Once it's typed, it's just the text again.
  await expect(graph.locator(".cursor")).toHaveCount(0, { timeout: 10_000 });
  await expect(graph.locator(".sr-only, :scope > [aria-hidden]:not(.prompt)")).toHaveCount(0);
  await expect(graph).toHaveText(`sferik@mbp ~> ${command}`);
  await expect(graph).toHaveAccessibleName(command);
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

test("the graph prints like text: a row at a time, top to bottom, left to right", async ({ page }) => {
  await page.goto("/");
  // Partway through, everything printed comes before everything still hidden, reading row by row.
  const inOrder = () =>
    page.evaluate(() => {
      const cells = [...document.querySelectorAll<HTMLElement>(".cal > *")];
      const key = (c: HTMLElement) => Number(c.style.gridRow) * 1000 + Number(c.style.gridColumn);
      const shown = cells.filter((c) => !c.classList.contains("unrevealed")).map(key);
      const hidden = cells.filter((c) => c.classList.contains("unrevealed")).map(key);
      return shown.length > 0 && hidden.length > 0 && Math.max(...shown) < Math.min(...hidden);
    });
  await expect.poll(inOrder, { intervals: [10], timeout: 15_000 }).toBe(true);
  await played(page, "graph", 15_000); // 381 squares, one every 15ms
});

test("the comic comes in a band at a time, top to bottom, like a 9600 baud modem", async ({ page }) => {
  await page.goto("/");
  const img = page.locator("#imgcat + .out figure.xkcd img");
  // How much of the comic's bottom is still clipped, in percent.
  const toCome = () => img.evaluate((e) => Number(/inset\(0px 0px ([\d.]+)%/.exec(getComputedStyle(e).clipPath)?.[1] ?? 0));
  // Partway down: drawn from the top, with the bottom still to come.
  await expect.poll(toCome, { intervals: [50], timeout: 10_000 }).toBeLessThan(90);
  expect(await toCome()).toBeGreaterThan(5);
  await img.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
  expect(await toCome()).toBe(0);
});

test("scrolling past imgcat shows the comic at once", async ({ page }) => {
  await page.goto("/");
  const img = page.locator("#imgcat + .out figure.xkcd img");
  await expect(img).toHaveClass(/loaded/);
  await page.locator("#name").scrollIntoViewIfNeeded();
  await expect(page.locator("section:has(> #imgcat)")).toHaveClass(/instant/);
  await expect(img).toHaveCSS("clip-path", "none");
  await expect(img).toHaveCSS("opacity", "1");
});

test("with reduced motion, the comic shows at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("#imgcat + .out figure.xkcd img")).toHaveCSS("clip-path", "none");
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
  await expect(page.locator("[data-repl]")).toHaveCSS("opacity", "1");
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
