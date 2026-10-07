import { test, expect } from "./support/fixtures.ts";
import type { Page } from "@playwright/test";
import { mockAPIs, SNAPSHOT, SNAPSHOT_TOTAL } from "./support/mocks.ts";
import profile from "../data/profile.json" with { type: "json" };
import projects from "../data/projects.json" with { type: "json" };

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
  test("each page builds itself from the JSON it comes with, without asking the API", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => r.headers().accept === "application/json" && asked.push(new URL(r.url()).pathname));
    for (const url of ["/", "/talks", "/resume"]) await page.goto(url);
    await expect(page.locator("main")).toContainText("General Commands Manual");
    expect(asked).toEqual([]);
  });

  for (const [url, title] of [
    ["/", "Erik Berlin"],
    ["/talks", "Talks, Erik Berlin"],
    ["/resume", "Résumé, Erik Berlin"],
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
    // Whatever the snapshot says today: a daily job refreshes it (scripts/snapshot.ts).
    const fmt = (n: number) => n.toLocaleString("en-US");
    const multi = projects.projects.filter((p) => ["multi_json", "multi_xml"].includes(p.name)).reduce((total, p) => total + p.downloads!, 0);
    await expect(page.locator("[data-live=downloads]")).toHaveText(`${(projects.totalDownloads / 1e9).toFixed(1)}B`);
    const link = page.locator("a", { has: page.locator("[data-live=downloads]") });
    await expect(link).toHaveAttribute("href", "https://rubygems.org/profiles/sferik");
    await expect(link).toHaveAttribute("title", `${fmt(projects.totalDownloads)} downloads across all ${projects.gemCount} gems`);
    await expect(page.locator("#whoami + .out")).toContainText(`which have ${fmt(multi)} combined downloads`);
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
    expect(await bg(page)).toBe("rgb(28, 27, 25)");
  });

  test("graph shades the prompt's green in each mode, amber phosphor included", async ({ page }) => {
    const shade = (page: Page, level: number) =>
      page.evaluate((l) => getComputedStyle(document.querySelector(`[data-graph] .c${l}`) || document.body).color, level);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await expect(page.locator("[data-graph] .c4").first()).toBeAttached();
    expect(await shade(page, 4)).toBe("rgb(42, 122, 46)"); // --ok, #2a7a2e
    expect(await shade(page, 2)).toMatch(/^oklab\(/); // half of it, mixed into the paper
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await shade(page, 4)).toBe("rgb(124, 196, 127)"); // #7cc47f
    await page.evaluate(() => (document.documentElement.dataset.theme = "phosphor"));
    expect(await shade(page, 4)).toBe("rgb(255, 176, 0)"); // #ffb000
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
      const other = scheme === "light" ? "rgb(28, 27, 25)" : "rgb(255, 255, 255)";
      const same = scheme === "light" ? "rgb(255, 255, 255)" : "rgb(28, 27, 25)";
      await page.keyboard.press("d");
      expect(await bg(page)).toBe(other);
      await page.keyboard.press("d");
      expect(await bg(page)).toBe(same);
    });
  }

  test("d from the phosphor theme goes to dark", async ({ page }) => {
    await page.goto("/");
    await run(page, "matrix");
    // Once matrix has run: d pressed any sooner would set the theme first, and matrix after it.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "phosphor");
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

  test("whoami prints the whoami section", async ({ page }) => {
    await run(page, "whoami");
    const out = log(page).locator(".repl-rich");
    await expect(out).toContainText("I'm the author of MultiJSON and MultiXML");
    expect(await out.locator("p").count()).toBe(await page.locator("#whoami + .out > p").count());
  });

  test("imgcat shows the comic, like the page's imgcat", async ({ page }) => {
    await run(page, "imgcat ~/dependency.webp");
    await expect(log(page).locator(".repl-rich figure.xkcd img")).toBeVisible();
    await expect(log(page).locator(".repl-rich figcaption")).toHaveText(await page.locator("#imgcat + .out figcaption").innerText());
  });

  test("the comic isn't a link, but its caption links to xkcd", async ({ page }) => {
    await page.goto("/");
    const figure = page.locator("#imgcat + .out figure.xkcd");
    await expect(figure.locator("a img")).toHaveCount(0);
    await expect(figure.locator("figcaption").getByRole("link", { name: "xkcd 2347" })).toHaveAttribute("href", "https://xkcd.com/2347/");
  });

  test("ls hides dotfiles; ls -a shows them", async ({ page }) => {
    await run(page, "ls");
    await expect(log(page).locator(":scope > div").last()).toHaveText(/^dependency\.webp\s+index\.html\s+robots\.txt\s+humans\.txt\s+resume\s+talks$/);
    await expect(log(page)).not.toContainText(".plan");
    await run(page, "ls -a");
    await expect(log(page).locator(":scope > div").last()).toContainText(".plan");
    await expect(log(page).locator(":scope > div").last()).toContainText(".signature");
    await expect(
      log(page)
        .locator(":scope > div")
        .last()
        .locator(".ls-dir", { hasText: /^talks$/ }),
    ).toHaveCount(1);
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
    await page.goto("/nope"); // a shell with no history yet
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
    // The cursor sits on the suggestion's first character, so there's no gap.
    await expect(page.locator(".echo .cursor.suggesting")).toHaveText("u");
    await expect(page.locator(".echo .hl-suggest")).toHaveText("mans.txt");
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
    await expect(page.locator(".repl-completions")).toHaveText(".plan   .signature");
    await tab(page, "cat .s");
    await expect(shell(page)).toHaveValue("cat .signature ");
  });

  test("completes sites for open", async ({ page }) => {
    await tab(page, "open gith");
    await expect(shell(page)).toHaveValue("open github ");
    await tab(page, "open git");
    await expect(page.locator(".repl-completions")).toHaveText("github   gitlab");
  });

  test("completes command names after help, man, and share", async ({ page }) => {
    await tab(page, "man ca");
    await expect(page.locator(".repl-completions")).toHaveText("caffeinate   cal   cat");
    await tab(page, "man uni");
    await expect(shell(page)).toHaveValue("man uniq ");
    await tab(page, "man sf");
    await expect(shell(page)).toHaveValue("man sferik ");
    await tab(page, "help ver");
    await expect(shell(page)).toHaveValue("help version ");
    await tab(page, "share fing");
    await expect(shell(page)).toHaveValue("share finger ");
  });

  test("completes flags from the command's usage", async ({ page }) => {
    await tab(page, "ls -");
    await expect(page.locator(".repl-completions")).toHaveText("-1   -A   -F   -S   -a   -h   -l   -r   -t");
    await tab(page, "tail -");
    await expect(page.locator(".repl-completions")).toHaveText("-c   -f   -n");
    await tab(page, "set -");
    await expect(page.locator(".repl-completions")).toHaveText("-e   -q   -x");
    await tab(page, "finger --v");
    await expect(shell(page)).toHaveValue("finger --vcard ");
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

  test("links are in the text's color, dotted, and solid under the pointer", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const ink = await page.locator("body").evaluate((el) => getComputedStyle(el).color);
    for (const link of await page.locator("figcaption a, .out p a").all()) {
      const style = () => link.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).textDecorationStyle]);
      expect(await style()).toEqual([ink, "dotted"]);
      await link.hover();
      expect(await style()).toEqual([ink, "solid"]);
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
    await expect(page.locator('.socials a[href*="npmjs.com"]')).toHaveCount(0);
    // Every profile in data/profile.json, in order, with its link and its icon
    await expect(links).toHaveCount(profile.profiles.length);
    for (const [index, { network, url, icon }] of profile.profiles.entries()) {
      await expect(links.nth(index)).toHaveAttribute("aria-label", network);
      await expect(links.nth(index)).toHaveAttribute("href", url);
      await expect(links.nth(index).locator("use")).toHaveAttribute("href", `/icons.svg#i-${icon}`);
    }
  });
});

// ---------------------------------------------------------------- resume

test.describe("resume", () => {
  test("the resume's lpr button opens the print dialog", async ({ page }) => {
    await page.addInitScript(() => {
      window.print = () => document.documentElement.setAttribute("data-printed", "");
    });
    await page.goto("/resume");
    await page.locator(".print-btn").click();
    await expect(page.locator("html")).toHaveAttribute("data-printed", "");
  });

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
    await expect(page.getByRole("link", { name: "sferik.net/talks", exact: true })).toHaveAttribute("href", "https://sferik.net/talks");
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

// ---------------------------------------------------------- offline

test.describe("offline", () => {
  test.use({ serviceWorkers: "allow" });

  test("after one visit, the pages and the shell work without a network", async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    // Installed: it has kept the pages, their JSON, and their files, though this page loaded without it.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator(".banner h1")).toHaveText("Erik Berlin");
    await expect(page.locator("#finger-cmd")).toHaveText("sferik@mbp ~> finger sferik");
    await run(page, "cat .plan");
    await expect(page.locator(".repl-log")).toContainText("Ship small, sharp tools.");
    await run(page, "figlet hi");
    await expect(page.locator(".repl-log")).toContainText("| |__ (_)");
    await page.goto("/talks");
    await expect(page.locator("h1")).toContainText("ls -lt ~/talks");
    await page.goto("/resume");
    await expect(page.locator("main")).toContainText("General Commands Manual");
    // A page it never fetched isn't there.
    await expect(page.goto("/nope-never-visited")).rejects.toThrow();
  });

  test("keeps what it fetches, for the next time there's no network", async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // now the service worker answers
    await run(page, "curl sferik.net/podcasts");
    await expect(page.locator(".repl-log")).toContainText("Ruby Rogues");
    await context.setOffline(true);
    await run(page, "clear");
    await run(page, "curl sferik.net/podcasts");
    await expect(page.locator(".repl-log")).toContainText("Ruby Rogues");
  });

  test("keeps one copy of a page, however it's asked for, and nothing a query string makes endless", async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/robots.txt"); // on the site, before its service worker is
    await page.evaluate(() => caches.open("sferik")); // left by an earlier version
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    const kept = () => page.evaluate(async () => (await (await caches.open("sferik-2")).keys()).map((r) => r.url.replace(location.origin, "")).sort());
    const before = await kept();
    expect(before).toContain("/?as=html");
    await run(page, "ping -c 2 sferik.net");
    await expect(page.locator(".repl-log")).toContainText("2 packets transmitted");
    await page.goto("/?run=whoami");
    expect(await kept()).toEqual(before);
    expect(await page.evaluate(() => caches.keys())).toEqual(["sferik-2"]);
    // A link that runs a command still opens without a network: it's the home page.
    await context.setOffline(true);
    await page.goto("/?run=whoami");
    await expect(page.locator(".repl-log")).toContainText("I've spent nearly two decades");
  });

  test("answers with what it kept when the network takes too long", async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // now the service worker answers
    await run(page, "curl sferik.net/podcasts");
    await expect(page.locator(".repl-log")).toContainText("Ruby Rogues");
    // A network that never answers, nor fails.
    let asked = 0;
    await context.route("**/podcasts", () => void asked++);
    await run(page, "clear");
    await run(page, "curl sferik.net/podcasts");
    await expect(page.locator(".repl-log")).toContainText("Ruby Rogues");
    expect(asked).toBe(1);
  });

  test("without the service worker, the site still works", async ({ page, context }) => {
    await context.route("**/sw.js", (route) => route.abort());
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page.waitForTimeout(300);
    expect(errors).toEqual([]);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  });
});

// ---------------------------------------------------------- links

test.describe("a link that runs a command", () => {
  test("runs it once the page is built, then takes it off the address", async ({ page }) => {
    await page.goto("/?run=echo%20from%20a%20link");
    await expect(page.locator(".repl-log")).toContainText("sferik@mbp ~> echo from a link");
    await expect(page.locator(".repl-log > *").last()).toHaveText("from a link");
    expect(new URL(page.url()).search).toBe("");
    // No playback: everything's already there, and so is the prompt.
    await expect(page.locator(".unplayed, .unrevealed")).toHaveCount(0);
    await expect(page.locator("[data-repl] input")).toBeFocused();
  });
});

test.describe("the 404 page", () => {
  for (const [path, meant] of [
    ["/talk", "/talks"],
    ["/resumes/", "/resume"],
    ["/TALKS", "/talks"],
  ]) {
    test(`${path} suggests ${meant}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("[data-suggest]")).toHaveText(`Did you mean ${meant}?`);
      await expect(page.locator("[data-suggest] a")).toHaveAttribute("href", meant);
    });
  }

  test("a path like no page suggests nothing", async ({ page }) => {
    await page.goto("/xyzzy");
    await expect(page.locator("[data-suggest]")).toBeHidden();
  });
});

// ---------------------------------------------------------- the redesign

test.describe("the login", () => {
  test("figlet sferik.net and cat .signature open the page, and fit a phone", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    await expect(page.locator("#figlet")).toHaveText("sferik@mbp ~> figlet sferik.net");
    const art = page.locator(".banner pre.figlet");
    await expect(art).toContainText("|___/_|  \\___|_|");
    await expect(page.locator("#signature")).toHaveText("sferik@mbp ~> cat .signature");
    await expect(page.locator("section:has(> #signature) .out")).toHaveText("I build libraries and tools software engineers depend on.");
    expect(await art.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await expect(page.locator(".banner h1")).toHaveText("Erik Berlin");
  });

  test("a first visit has no last login; the next shows the first", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-login]")).toHaveText("\u00a0");
    await page.reload();
    await expect(page.locator("[data-login]")).toHaveText(/^Last login: (Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d on ttys000$/);
  });

  test("a visit log that isn't JSON means no last login", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("visits", "nope"));
    await page.goto("/");
    await expect(page.locator("[data-login]")).toHaveText("\u00a0");
  });
});

test.describe("who's on", () => {
  test("each tab checks in when its page is built, and when it's back in view, keeping its token from page to page", async ({ page }) => {
    const seen: URLSearchParams[] = [];
    await page.route(/\/who\?/, (route) => {
      seen.push(new URL(route.request().url()).searchParams);
      return route.fulfill({ json: { you: "ttys000", users: [] } });
    });
    await page.goto("/talks");
    await expect.poll(() => seen.map((p) => p.get("page"))).toEqual(["/talks"]);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => seen.length).toBe(2);
    await page.goto("/resume");
    await expect.poll(() => seen.map((p) => p.get("page"))).toEqual(["/talks", "/talks", "/resume"]);
    expect(new Set(seen.map((p) => p.get("token"))).size).toBe(1);
    expect(seen[0].get("token")).toMatch(/^[\da-f-]{36}$/);
  });

  test("a failed check-in, or no session storage, leaves the page as it is", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw new Error("blocked");
      };
    });
    let tried = false;
    await page.route(/\/who\?/, (route) => {
      tried = true;
      return route.abort();
    });
    await page.goto("/resume");
    await expect(page.locator("main")).not.toHaveAttribute("aria-busy");
    await expect.poll(() => tried).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe("the resume", () => {
  test("is the output of man sferik, and ends with lpr, which isn't printed", async ({ page }) => {
    await page.goto("/resume");
    const host = page.locator(".tmux .host");
    await expect(page.locator("#man")).toHaveText("sferik@mbp ~> man sferik");
    await expect(host).toHaveText('"man sferik" ');
    await expect(page.locator(".man-cmd + .lpr")).toHaveCount(1);
    await page.locator("[data-scroller]").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(host).toHaveText('"lpr resume.html" ');
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".lpr")).toBeHidden();
    await expect(page.locator("#man")).toBeHidden();
    await expect(page.locator(".man-head")).toBeVisible();
  });
});

test.describe("the talks page", () => {
  test("links the former name to the name change, shown with git show in the home page's shell", async ({ page }) => {
    await page.goto("/talks");
    await expect(page.getByText("18 talks at 16 conferences in 13 countries")).toBeVisible();
    await page.getByRole("link", { name: "my former name, Erik Michaels-Ober" }).click();
    await expect(page.locator(".repl-log")).toContainText("commit 8c0d698bb6cb54346ac26a38f7056ee64dafd64d");
    await expect(page).toHaveURL("/");
  });
});

test.describe("the status line", () => {
  test("names the command whose output is in view, like tmux", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const host = page.locator(".tmux .host");
    await expect(host).toHaveText('"figlet sferik.net" ');
    // Its prompt just past the line a third of the way down, which is where the status bar looks.
    await page.locator("[data-scroller]").evaluate((el) => {
      const top = document.querySelector("#signature")!.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTop += top - el.clientHeight / 3 + 4;
    });
    await expect(host).toHaveText('"cat .signature" ');
    await page.locator("#graph").evaluate((e) => e.scrollIntoView());
    await expect(host).toHaveText('"git log --author=sfe…" '); // 20 characters and an ellipsis
    await page.locator("[data-scroller]").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(host).toHaveText('"fish" ');
  });

  test("names the host above the first command", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 360 }); // too short for figlet's prompt to reach a third of the way down
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator(".tmux .host")).toHaveText('"sferik.net" ');
  });
});

test.describe("moving between pages", () => {
  test("swaps them at once, keeping the status line, with view transitions", async ({ page }) => {
    await page.goto("/");
    const rules = await page.evaluate(() =>
      [...document.styleSheets].flatMap((s) => [...s.cssRules].map((r) => r.cssText)).filter((t) => t.startsWith("@view-transition")),
    );
    expect(rules.join()).toContain("navigation: auto");
    expect(await page.locator(".tmux").evaluate((e) => getComputedStyle(e).viewTransitionName)).toBe("tmux");
  });
});

test.describe("the resume's SEE ALSO", () => {
  test("refers to talks(7), finger(1), and sferik(3), as a man page does", async ({ page }) => {
    await page.goto("/resume");
    for (const [name, section, href] of [
      ["talks", "7", "/talks"],
      ["finger", "1", "/#finger"],
      ["sferik", "3", "https://github.com/sferik/sferik-ruby"],
    ]) {
      const link = page.getByRole("link", { name: `${name}(${section})` });
      await expect(link).toHaveAttribute("href", href);
      await expect(link.locator("b")).toHaveText(name);
    }
  });
});
