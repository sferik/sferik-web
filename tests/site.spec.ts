import { test, expect } from "./support/fixtures.ts";
import type { Page } from "@playwright/test";
import { mockAPIs, SNAPSHOT, SNAPSHOT_TOTAL } from "./support/mocks.ts";

const shell = (page: Page) => page.locator("[data-repl] input");
const log = (page: Page) => page.locator(".repl-log");

async function run(page: Page, command: string) {
  await shell(page).fill(command);
  await shell(page).press("Enter");
}

test.beforeEach(async ({ page }) => {
  await mockAPIs(page);
});

// ------------------------------------------------------------------ pages

test.describe("pages", () => {
  for (const [url, title] of [
    ["/", "Erik Berlin"],
    ["/talks", "Talks, Erik Berlin"],
    ["/resume", "Erik Berlin, résumé"],
  ]) {
    test(`${url} loads without console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await page.goto(url);
      await expect(page).toHaveTitle(title);
      await page.waitForLoadState("networkidle");
      expect(errors).toEqual([]);
    });
  }

  test("unknown paths get the fish-style 404 page", async ({ page }) => {
    const res = await page.goto("/no/such/page");
    expect(res?.status()).toBe(404);
    await expect(page.getByText("cd: The directory '/no/such/page' does not exist")).toBeVisible();
  });

  test("tmux status line marks the current page", async ({ page }) => {
    await page.goto("/talks");
    await expect(page.locator('.tmux a[aria-current="page"]')).toHaveText("1:talks");
  });
});

// -------------------------------------------------------------- live data

test.describe("live data", () => {
  // The test server runs offline, so it serves the snapshots in data/.
  test("download total comes from the API and links to the profile", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-live=downloads]")).toHaveText("5.5B");
    const link = page.locator("a", { has: page.locator("[data-live=downloads]") });
    await expect(link).toHaveAttribute("href", "https://rubygems.org/profiles/sferik");
    await expect(link).toHaveAttribute("title", "5,460,234,129 downloads across all 65 gems");
    await expect(page.locator("#whoami + .out")).toContainText("which have 1,776,183,113 combined downloads");
  });

  test("without a recent push, the GitHub line is static", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-live=github]")).toHaveText("On GitHub since 2008.");
  });

  test("contribution graph renders the snapshot, marked as cached", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-graph-meta]")).toContainText(`${SNAPSHOT_TOTAL.toLocaleString("en-US")} contributions in the last year`);
    await expect(page.locator("[data-graph-meta]")).toContainText("(cached)");
    expect(await page.locator("[data-graph] .cal-cell").count()).toBe(SNAPSHOT.contributions.length);
  });
});

// ---------------------------------------------------------------- themes

test.describe("themes", () => {
  const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  test("follows the system light/dark setting", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    expect(await bg(page)).toBe("rgb(255, 255, 255)");
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await bg(page)).toBe("rgb(0, 0, 0)");
  });

  test("graph uses GitHub's palette in each mode", async ({ page }) => {
    const top = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector("[data-graph] .c4") || document.body).color);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await expect(page.locator("[data-graph] .c4").first()).toBeAttached();
    expect(await top(page)).toBe("rgb(33, 110, 57)"); // #216e39
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await top(page)).toBe("rgb(57, 211, 83)"); // #39d353
  });

  test("ignores a theme saved by an older version of the site", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    expect(await bg(page)).toBe("rgb(255, 255, 255)");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`d toggles dark and light, starting from the ${scheme} system setting`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      const other = scheme === "light" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)";
      const same = scheme === "light" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)";
      await page.keyboard.press("d");
      expect(await bg(page)).toBe(other);
      await page.keyboard.press("d");
      expect(await bg(page)).toBe(same);
    });
  }

  test("d from the phosphor theme goes to dark", async ({ page }) => {
    await page.goto("/");
    await run(page, "matrix");
    await shell(page).blur();
    await page.keyboard.press("d");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("Konami code toggles the phosphor theme", async ({ page }) => {
    await page.goto("/");
    const keys = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
    for (const k of keys) await page.keyboard.press(k);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "phosphor");
    for (const k of keys) await page.keyboard.press(k);
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  });
});

// ------------------------------------------------------ keyboard shortcuts

test.describe("keyboard shortcuts", () => {
  for (const [keys, url] of [
    ["t", "/talks"],
    ["r", "/resume"],
  ]) {
    test(`g ${keys} goes to ${url}`, async ({ page }) => {
      await page.goto("/");
      await page.keyboard.press("g");
      await page.keyboard.press(keys);
      await expect(page).toHaveURL(url);
    });
  }

  test("g h goes home", async ({ page }) => {
    await page.goto("/talks");
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await expect(page).toHaveURL("/");
  });

  test("j, k, G, and g g scroll the page", async ({ page }) => {
    await page.goto("/");
    const top = () => page.locator("[data-scroller]").evaluate((el) => el.scrollTop);
    await page.keyboard.press("j");
    await expect.poll(top).toBeGreaterThan(0);
    await page.keyboard.press("k");
    await expect.poll(top).toBe(0);
    await page.keyboard.press("G");
    await expect.poll(top).toBeGreaterThan(500);
    await page.keyboard.press("g");
    await page.keyboard.press("g");
    await expect.poll(top).toBe(0);
  });

  test("/ focuses the shell", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("/");
    await expect(shell(page)).toBeFocused();
  });

  test("? toggles the shortcuts overlay, Escape closes it", async ({ page }) => {
    await page.goto("/");
    const help = page.locator("[data-help]");
    await expect(help).toBeHidden();
    await page.keyboard.press("?");
    await expect(help).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
  });

  test("shortcuts don't fire while typing in the shell", async ({ page }) => {
    await page.goto("/");
    await shell(page).focus();
    await page.keyboard.type("gt");
    await expect(page).toHaveURL("/");
    await expect(shell(page)).toHaveValue("gt");
  });
});

// ------------------------------------------------------------------ shell

test.describe("shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("greets like fish and uses the fish prompt", async ({ page }) => {
    await expect(log(page)).toHaveText("Type help for a list of commands");
    await expect(page.locator(".repl-line .prompt")).toHaveText("sferik@mbp ~> ");
  });

  test("unknown commands get fish's error", async ({ page }) => {
    await run(page, "whois");
    await expect(log(page)).toContainText("fish: Unknown command: whois");
  });

  test("help lists commands", async ({ page }) => {
    await run(page, "help");
    await expect(log(page)).toContainText("man sferik      the resume, as a man page");
  });

  test("? lists keyboard shortcuts", async ({ page }) => {
    await run(page, "?");
    await expect(log(page)).toContainText("Keyboard shortcuts");
  });

  test("whoami prints the whoami section, comic included", async ({ page }) => {
    await run(page, "whoami");
    const out = log(page).locator(".repl-rich");
    await expect(out).toContainText("I'm the author of MultiJSON and MultiXML");
    await expect(out.locator("figure.xkcd img")).toBeVisible();
    expect(await out.locator("p").count()).toBe(await page.locator("#whoami + .out > p").count());
  });

  test("the comic isn't a link, but its caption links to xkcd", async ({ page }) => {
    await page.goto("/");
    const figure = page.locator("#whoami + .out figure.xkcd");
    await expect(figure.locator("a img")).toHaveCount(0);
    await expect(figure.locator("figcaption").getByRole("link", { name: "xkcd 2347" })).toHaveAttribute("href", "https://xkcd.com/2347/");
  });

  test("ls hides dotfiles; ls -a shows them", async ({ page }) => {
    await run(page, "ls");
    await expect(log(page).locator(":scope > div").last()).toHaveText(/^humans\.txt\s+index\.html\s+resume\s+robots\.txt\s+talks$/);
    await expect(log(page)).not.toContainText(".plan");
    await run(page, "ls -a");
    await expect(log(page).locator(":scope > div").last()).toContainText(".plan");
    await expect(log(page).locator(".ls-dir").last()).toHaveText("talks");
  });

  test("cat prints files and refuses directories", async ({ page }) => {
    await run(page, "cat .plan");
    await expect(log(page)).toContainText("Ship small, sharp tools.");
    await run(page, "cat humans.txt");
    await expect(log(page)).toContainText("Author: Erik Berlin");
    await run(page, "cat talks");
    await expect(log(page)).toContainText("cat: talks: Is a directory");
    await run(page, "cat nope");
    await expect(log(page)).toContainText("cat: nope: No such file or directory");
  });

  test("cd refuses files and unknown directories", async ({ page }) => {
    await run(page, "cd .plan");
    await expect(log(page)).toContainText("cd: '.plan' is not a directory");
    await run(page, "cd nowhere");
    await expect(log(page)).toContainText("cd: The directory 'nowhere' does not exist");
  });

  for (const arg of ["talks", "talks/", "~/talks", "/talks", "talks.html"]) {
    test(`cd ${arg} goes to the talks page`, async ({ page }) => {
      await run(page, `cd ${arg}`);
      await expect(page).toHaveURL("/talks");
    });
  }

  test("echo expands fish variables", async ({ page }) => {
    await run(page, "echo $SHELL");
    await expect(log(page)).toContainText("/opt/homebrew/bin/fish");
  });

  test("history lists earlier commands, newest first", async ({ page }) => {
    await run(page, "ls");
    await run(page, "pwd");
    await run(page, "history");
    await expect(log(page).locator("div").last()).toHaveText("pwd\nls");
  });

  test("clear empties the screen, and so does Ctrl-L", async ({ page }) => {
    await run(page, "ls");
    await run(page, "clear");
    await expect(log(page)).toBeEmpty();
    await run(page, "ls");
    await shell(page).press("Control+l");
    await expect(log(page)).toBeEmpty();
  });

  test("up and down arrows walk history", async ({ page }) => {
    await run(page, "ls");
    await run(page, "pwd");
    await shell(page).press("ArrowUp");
    await expect(shell(page)).toHaveValue("pwd");
    await shell(page).press("ArrowUp");
    await expect(shell(page)).toHaveValue("ls");
    await shell(page).press("ArrowDown");
    await expect(shell(page)).toHaveValue("pwd");
  });

  test("highlights known commands blue and unknown ones red", async ({ page }) => {
    await shell(page).fill("ls");
    await expect(page.locator(".echo .hl-cmd")).toHaveText("ls");
    await shell(page).fill("lsx");
    await expect(page.locator(".echo .hl-err")).toHaveText("lsx");
  });

  test("autosuggests from history; right arrow accepts", async ({ page }) => {
    await run(page, "cat humans.txt");
    await shell(page).fill("cat h");
    await expect(page.locator(".echo .hl-suggest")).toHaveText("umans.txt");
    await shell(page).press("ArrowRight");
    await expect(shell(page)).toHaveValue("cat humans.txt");
  });

  test("matrix toggles the phosphor theme", async ({ page }) => {
    await run(page, "matrix");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "phosphor");
  });
});

// -------------------------------------------------------- tab completion

test.describe("tab completion", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  async function tab(page: Page, value: string) {
    await shell(page).fill(value);
    await shell(page).press("Tab");
  }

  test("completes a unique command", async ({ page }) => {
    await tab(page, "whoa");
    await expect(shell(page)).toHaveValue("whoami ");
  });

  test("lists ambiguous commands without changing the line", async ({ page }) => {
    await tab(page, "c");
    await expect(shell(page)).toHaveValue("c");
    await expect(page.locator(".repl-completions")).toContainText("cat");
    await expect(page.locator(".repl-completions")).toContainText("cd");
    await expect(page.locator(".repl-completions")).toContainText("clear");
  });

  test("extends to the common prefix", async ({ page }) => {
    await tab(page, "ec");
    await expect(shell(page)).toHaveValue("echo ");
    await tab(page, "op");
    await expect(shell(page)).toHaveValue("open ");
  });

  test("completes directories for cd, with a trailing slash", async ({ page }) => {
    await tab(page, "cd t");
    await expect(shell(page)).toHaveValue("cd talks/");
    await tab(page, "cd ");
    await expect(page.locator(".repl-completions")).toHaveText("resume/   talks/");
  });

  test("completes files for cat, including dotfiles when asked", async ({ page }) => {
    await tab(page, "cat h");
    await expect(shell(page)).toHaveValue("cat humans.txt ");
    await tab(page, "cat .");
    await expect(shell(page)).toHaveValue("cat .plan ");
  });

  test("completes sites for open", async ({ page }) => {
    await tab(page, "open git");
    await expect(shell(page)).toHaveValue("open github ");
  });

  test("Tab never moves focus out of the shell", async ({ page }) => {
    await tab(page, "zzz");
    await expect(shell(page)).toBeFocused();
  });

  test("the completion list clears on the next keystroke", async ({ page }) => {
    await tab(page, "c");
    await expect(page.locator(".repl-completions")).not.toBeEmpty();
    await shell(page).press("d");
    await expect(page.locator(".repl-completions")).toBeEmpty();
  });
});

// ---------------------------------------------------------------- layout

test.describe("layout", () => {
  test("the status line never covers content", async ({ page }) => {
    await page.goto("/");
    const scroller = await page.locator("[data-scroller]").boundingBox();
    const bar = await page.locator(".tmux").boundingBox();
    expect(scroller && bar && scroller.y + scroller.height).toBeLessThanOrEqual(bar?.y ?? 0);
    // The document itself never scrolls; only the content area does.
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(page.viewportSize()?.height);
  });

  test("text column is about 80 characters wide and centered", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/");
    const box = await page.locator("main.screen").boundingBox();
    const ch = await page.evaluate(() => {
      const s = document.createElement("span");
      s.style.position = "absolute";
      s.textContent = "0".repeat(100);
      document.querySelector("main")!.append(s);
      const w = s.getBoundingClientRect().width / 100;
      s.remove();
      return w;
    });
    expect(box?.width).toBeCloseTo(84 * ch, -1);
    expect(Math.abs((box?.x ?? 0) * 2 + (box?.width ?? 0) - 1600)).toBeLessThan(2);
  });

  test("graph spans the full text column, with labels at the page's type size", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/");
    const cal = page.locator("[data-graph] .cal");
    await expect(cal).toBeVisible();
    const width = async () => {
      const banner = (await page.locator(".banner").boundingBox())?.width ?? 0;
      const last = await cal.locator(".cal-cell").last().boundingBox();
      const grid = (await cal.boundingBox()) ?? { x: 0 };
      return { banner, used: (last?.x ?? 0) + (last?.width ?? 0) - grid.x };
    };
    let { banner, used } = await width();
    expect(used).toBeGreaterThan(banner * 0.97);
    expect(used).toBeLessThanOrEqual(banner + 1);
    const size = (sel: string) =>
      cal
        .locator(sel)
        .first()
        .evaluate((el) => getComputedStyle(el).fontSize);
    const body = await page.evaluate(() => getComputedStyle(document.body).fontSize);
    expect(await size(".cal-month")).toBe(body);
    expect(await size(".cal-day")).toBe(body);
    // and keeps fitting when the window changes size
    await page.setViewportSize({ width: 700, height: 900 });
    ({ banner, used } = await width());
    expect(used).toBeGreaterThan(banner * 0.97);
  });

  test("phone width: no horizontal scrolling, graph fits", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const graph = page.locator("[data-graph]");
    await expect(graph.locator(".cal")).toBeVisible();
    const [scrollWidth, clientWidth] = await graph.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test("hovered links stay readable, including the comic's caption", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    for (const link of await page.locator("figcaption a, .out p a").all()) {
      await link.hover();
      const [color, background] = await link.evaluate((el) => {
        const s = getComputedStyle(el);
        return [s.color, s.backgroundColor];
      });
      expect(background).not.toBe("rgba(0, 0, 0, 0)");
      expect(color).not.toBe(background);
    }
  });

  test("social links are icon-only but labeled", async ({ page }) => {
    await page.goto("/");
    const links = page.locator(".socials a");
    expect(await links.count()).toBeGreaterThan(5);
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute("aria-label", /.+/);
      expect((await link.innerText()).trim()).toBe("");
    }
    await expect(page.locator('.socials a[href*="npmjs.com"], .socials a[href*="gitlab.com"]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------- resume

test.describe("resume", () => {
  test("prints to exactly two US Letter pages without site chrome", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "PDF output is Chromium-only");
    await page.goto("/resume");
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".tmux")).toBeHidden();
    await expect(page.locator(".toolbar")).toBeHidden();
    const pdf = await page.pdf({ preferCSSPageSize: true });
    const pages = pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || [];
    expect(pages.length).toBe(2);
  });

  test("includes contact details", async ({ page }) => {
    await page.goto("/resume");
    await expect(page.locator('a[href="mailto:sferik@gmail.com"]')).toBeVisible();
    for (const [text, href] of [
      ["PDF", "/resume.pdf"],
      ["LaTeX", "/resume.tex"],
      ["JSON", "/resume.json"],
      ["plain text", "/resume.txt"],
    ]) {
      await expect(page.getByRole("link", { name: text, exact: true })).toHaveAttribute("href", href);
    }
  });

  test("links web addresses in the text", async ({ page }) => {
    await page.goto("/resume");
    await expect(page.getByRole("link", { name: "sferik.com/talks", exact: true })).toHaveAttribute("href", "https://sferik.com/talks");
  });

  test("the footer shows the current month", async ({ page }) => {
    await page.clock.setFixedTime(new Date(2027, 0, 15));
    await page.goto("/resume");
    await expect(page.locator(".man-foot")).toContainText("January 2027");
  });

  test("links each patent", async ({ page }) => {
    await page.goto("/resume");
    await expect(page.getByRole("link", { name: "Method and system for dynamic advertising based on user actions" })).toHaveAttribute(
      "href",
      "https://patents.google.com/patent/US20110153414A1",
    );
  });
});
