// Less-traveled paths: failures, fallbacks, reduced motion, and every shell
// command. Together with site.spec.js these keep site.js at 100% coverage.
import { test, expect } from "./support/fixtures.ts";
import type { Page } from "@playwright/test";
import { mockAPIs } from "./support/mocks.ts";

const shell = (page: Page) => page.locator("[data-repl] input");
const log = (page: Page) => page.locator(".repl-log");
const lastOutput = (page: Page) => log(page).locator(":scope > div").last();

async function run(page: Page, command: string) {
  await shell(page).fill(command);
  await shell(page).press("Enter");
}

test.beforeEach(async ({ page }) => {
  await mockAPIs(page);
});

// --------------------------------------------------------------- startup

test.describe("startup", () => {
  test("still works when localStorage is unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      Storage.prototype.removeItem = () => {
        throw new DOMException("blocked", "SecurityError");
      };
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await expect(page.locator(".banner h1")).toHaveText("Erik Berlin");
    expect(errors).toEqual([]);
  });

  test("the content area takes keyboard focus so arrow keys scroll it", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-scroller]")).toBeFocused();
  });

  test("a link to an anchor keeps the browser's focus behavior", async ({ page }) => {
    await page.goto("/#finger");
    await expect(page.locator("[data-scroller]")).not.toBeFocused();
  });

  test("the 404 page keeps focus in its shell", async ({ page }) => {
    await page.goto("/missing");
    await expect(shell(page)).toBeFocused();
  });

  test("the status line clock ticks", async ({ page }) => {
    await page.clock.install({ time: new Date(2026, 9, 1, 9, 5) });
    await page.goto("/");
    const clock = page.locator("[data-clock]");
    await expect(clock).toHaveText("09:05 01-Oct-26");
    await page.clock.runFor(60_000);
    await expect(clock).toHaveText("09:06 01-Oct-26");
  });

  test("prints a note for people who open the console", async ({ page }) => {
    const messages: string[] = [];
    page.on("console", (m) => messages.push(m.text()));
    await page.goto("/talks");
    expect(messages.join("\n")).toContain("Hi. You opened the console.");
  });
});

// -------------------------------------------------------------- live data

// The page renders whatever the API returns; these tests feed it edge cases.
async function serveModule(page: Page, path: string, patch: Record<string, unknown>) {
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      await route.fulfill({ json: { ...json, ...patch } });
    },
  );
}

test.describe("rendering from the API", () => {
  for (const [label, ms, text] of [
    ["seconds", 5e3, "moments ago"],
    ["one minute", 61e3, "1 minute ago"],
    ["one day", 25 * 3600e3, "1 day ago"],
    ["months", 70 * 864e5, "2 months ago"],
    ["a year", 400 * 864e5, "1 year ago"],
  ] as [string, number, string][]) {
    test(`last push ${label} ago reads "${text}"`, async ({ page }) => {
      await serveModule(page, "/contributions", { lastPush: { repo: "sferik/x-ruby", sha: "abc1234def5678", at: new Date(Date.now() - ms).toISOString() } });
      await page.goto("/");
      const line = page.locator("[data-live=github]");
      await expect(line).toHaveText(`On GitHub since 2008 through ${text}.`);
      await expect(line.locator("a")).toHaveAttribute("href", "https://github.com/sferik/x-ruby/commit/abc1234def5678");
    });
  }

  test("last push time keeps counting while the page is open", async ({ page }) => {
    await page.clock.install();
    await serveModule(page, "/contributions", { lastPush: { repo: "sferik/x-ruby", sha: "abc1234", at: new Date(Date.now() - 5000).toISOString() } });
    await page.goto("/");
    const when = page.locator("[data-live=github] time");
    await expect(when).toHaveText("moments ago");
    await page.clock.runFor(120_000);
    await expect(when).toHaveText("2 minutes ago");
  });

  test("live data isn't marked as cached", async ({ page }) => {
    await serveModule(page, "/contributions", { live: true });
    await page.goto("/");
    await expect(page.locator("[data-graph-meta]")).not.toContainText("cached");
  });

  test("graph pads a year that starts mid-week, and labels single contributions", async ({ page }) => {
    // Start on a Wednesday, with a one-contribution day.
    const start = new Date("2025-10-01T00:00:00");
    const days = Array.from({ length: 365 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const count = i === 3 ? 1 : i % 9 === 0 ? 0 : 4;
      return { date: d.toISOString().slice(0, 10), count, level: count ? 2 : 0 };
    });
    await serveModule(page, "/contributions", { contributions: days });
    await page.goto("/");
    const cal = page.locator("[data-graph] .cal");
    await expect(cal).toContainText("Oct");
    await expect(cal.locator('[title="1 contribution on 2025-10-04"]')).toHaveCount(1);
    // The first square sits in the Wednesday row; Sunday through Tuesday are empty.
    await expect(cal.locator(".cal-cell").first()).toHaveCSS("grid-row-start", "5");
  });

  test("a project without stars leaves its stars cell empty", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/src",
      async (route) => {
        const json = (await (await route.fetch()).json()) as { projects: unknown[] };
        const lone = { name: "lone", url: "https://example.com/lone", description: "A gem without a repository.", downloads: 5, stars: null };
        await route.fulfill({ json: { ...json, projects: [...json.projects, lone] } });
      },
    );
    await page.goto("/");
    const row = page.locator(".ls tbody tr").filter({ hasText: "lone" });
    await expect(row.locator("td.n").last()).toHaveText("");
    await expect(row.locator("td.n").last()).not.toHaveAttribute("title");
  });

  test("a module that fails to load says so, and the rest still render", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/src",
      (route) => route.fulfill({ status: 500 }),
    );
    await page.goto("/");
    await expect(page.locator("main")).toContainText("curl: (7) Couldn't load /src");
    await expect(page.locator("#whoami")).toBeVisible();
  });

  test("a page whose API is down says so", async ({ page }) => {
    await page.route("**/talks", (route, request) => (request.headers().accept === "application/json" ? route.fulfill({ status: 503 }) : route.fallback()));
    await page.goto("/talks");
    await expect(page.locator("main")).toContainText("Couldn't reach the API");
  });
});

// ------------------------------------------------------- shell commands

test.describe("every shell command", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  const cases = [
    ["pwd", "/Users/sferik"],
    ["hostname", "mbp"],
    ["uname", "Darwin"],
    ["uname -a", "Darwin Kernel Version 27.0.0"],
    ["date", String(new Date().getFullYear())],
    ["uptime", "days, 2 users, load averages"],
    ["echo $USER in $HOME, $NOPE.", "sferik in /Users/sferik, ."],
    ["fish --version", "fish, version 4.1.2"],
    ["fish", "You're already in fish."],
    ["bash", "Nah. fish is nicer."],
    ["zsh", "Nah. fish is nicer."],
    ["less humans.txt", "Author: Erik Berlin"],
    ["more .plan", "Ship small, sharp tools."],
    ["cat .plan humans.txt", "Last update"],
    ["cat ~", "cat: ~: Is a directory"],
    ["exit", "[Process completed]"],
    ["sudo rm -rf /", "sferik is not in the sudoers file."],
    ["sudo make me a sandwich", "okay."],
    ["rm -rf /", "Operation not permitted"],
    ["rm -rf /*", "Operation not permitted"],
    ["make", "No targets specified"],
    ["make love", "No rule to make target `love'"],
    ["ping", "64 bytes from sferik.com"],
    ["git blame", "Every line: @sferik."],
    ["git push --force", "Not on main, please."],
    ["git", "usage: git [--version] [--help] <command> [<args>]"],
    ["ruby", "ruby 4.0.0"],
    ["irb", '=> "olleh"'],
    ["cargo", "Finished `release` profile"],
    ["go", "Go is a tool"],
    ["node", "Welcome to Node.js."],
    ["python", "Beautiful is better than ugly."],
    ["coffee", "I'm a teapot"],
    ["hello", "Type help for a list of commands."],
    ["hi", "Type help for a list of commands."],
    ["42", "The answer is in the source."],
    ["open", "Usage: open [-e] [-t] [-f]"],
    ["open nowhere", "The file /Users/sferik/nowhere does not exist."],
  ];
  for (const [command, expected] of cases) {
    test(command, async ({ page }) => {
      await run(page, command);
      await expect(lastOutput(page)).toContainText(expected);
    });
  }

  test("git show prints the name change as a real commit, in git's colors", async ({ page }) => {
    await run(page, "git show");
    const out = lastOutput(page);
    await expect(out).toContainText("commit 8c0d698bb6cb54346ac26a38f7056ee64dafd64d");
    await expect(out).toContainText("Date:   Sat Jun 24 12:00:00 2017 -0700");
    await expect(out.locator(".warn")).toHaveText("commit 8c0d698bb6cb54346ac26a38f7056ee64dafd64d");
    await expect(out.locator(".err")).toHaveText("-Erik Michaels-Ober");
    await expect(out.locator(".ok")).toHaveText("+Erik Berlin");
  });

  for (const ref of ["HEAD^", "HEAD~1", "33b9c3d"]) {
    test(`git show ${ref} prints the initial commit`, async ({ page }) => {
      await run(page, `git show ${ref}`);
      await expect(lastOutput(page)).toContainText("Initial commit");
      await expect(lastOutput(page).locator(".ok")).toHaveText("+Erik Michaels-Ober");
    });
  }

  test("git show rejects unknown refs", async ({ page }) => {
    await run(page, "git show abc");
    await expect(lastOutput(page)).toHaveText("fatal: ambiguous argument 'abc': unknown revision or path not in the working tree.");
  });

  test("git log lists both commits", async ({ page }) => {
    await run(page, "git log");
    await expect(lastOutput(page)).toContainText("Author: Erik Michaels-Ober <sferik@gmail.com>");
    await run(page, "git log --follow --oneline -- name");
    await expect(lastOutput(page)).toHaveText("8c0d698 Rename Erik Michaels-Ober to Erik Berlin\n33b9c3d Initial commit");
  });

  test("clicking the commit hash runs git show", async ({ page }) => {
    await page.locator("button.sha").click();
    await expect(lastOutput(page)).toContainText("+Erik Berlin");
    await expect(shell(page)).toBeFocused();
  });

  test("finger scrolls to the contact details", async ({ page }) => {
    await run(page, "finger");
    await expect(lastOutput(page)).toContainText("Plan: Ship small, sharp tools.");
    await expect(page.locator("#finger")).toBeInViewport();
  });

  test("cat reports files it can't read", async ({ page }) => {
    await page.route("**/humans.txt", (route) => route.abort());
    await run(page, "cat humans.txt");
    await expect(lastOutput(page)).toHaveText("cat: humans.txt: Input/output error");
  });

  test("an empty line just prints a new prompt", async ({ page }) => {
    await run(page, "");
    await expect(lastOutput(page).locator(".prompt")).toBeVisible();
    await expect(log(page).locator(":scope > div")).toHaveCount(2); // greeting + prompt
  });

  for (const arg of ["..", "../..", "../root"]) {
    test(`cd ${arg} is denied`, async ({ page }) => {
      await run(page, `cd ${arg}`);
      await expect(lastOutput(page)).toHaveText(`cd: Permission denied: '${arg}'`);
      await expect(page).toHaveURL("/");
    });
  }

  test("cd and open on the current page stay put", async ({ page }) => {
    await run(page, "cd");
    await run(page, "cd ~");
    await run(page, "open ~");
    await expect(page).toHaveURL("/");
    await expect(lastOutput(page)).toContainText("open ~");
  });

  test("open goes to pages and files", async ({ page }) => {
    await run(page, "open humans.txt");
    await expect(page).toHaveURL("/humans.txt");
  });

  test("open sponsors opens GitHub Sponsors", async ({ page }) => {
    const popup = page.waitForEvent("popup");
    await page.route("https://github.com/sponsors/sferik", (route) => route.fulfill({ body: "ok" }));
    await run(page, "open sponsors");
    expect((await popup).url()).toBe("https://github.com/sponsors/sferik");
  });

  test("open opens profiles in a new tab", async ({ page }) => {
    const popup = page.waitForEvent("popup");
    await page.route("https://github.com/sferik", (route) => route.fulfill({ body: "ok" }));
    await run(page, "open github");
    expect((await popup).url()).toBe("https://github.com/sferik");
  });
});

// ------------------------------------------------------------ navigation
// A page's coverage is lost when the browser leaves it, so these tests answer
// the navigation with 204 No Content, which makes the browser stay put.

async function expectNavigation(page: Page, path: string, action: () => Promise<unknown>) {
  await page.route(
    (url) => url.pathname === path,
    (route) => (route.request().isNavigationRequest() ? route.fulfill({ status: 204 }) : route.fallback()),
  );
  const request = page.waitForRequest((r) => r.isNavigationRequest() && new URL(r.url()).pathname === path);
  await action();
  await request;
}

test.describe("navigation", () => {
  for (const [command, path] of [
    ["cd talks", "/talks"],
    ["cd resume/", "/resume"],
    ["open talks", "/talks"],
    ["open .plan", "/.plan"],
  ]) {
    test(`${command} requests ${path}`, async ({ page }) => {
      await page.goto("/");
      await expectNavigation(page, path, () => run(page, command));
    });
  }

  for (const [keys, path, from] of [
    ["gt", "/talks", "/"],
    ["gr", "/resume", "/"],
    ["gh", "/", "/talks"],
  ]) {
    test(`${keys[0]} ${keys[1]} requests ${path}`, async ({ page }) => {
      await page.goto(from);
      await expectNavigation(page, path, async () => {
        await page.keyboard.press(keys[0]);
        await page.keyboard.press(keys[1]);
      });
    });
  }
});

// ---------------------------------------------------------- shell editing

test.describe("shell editing", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("clicking anywhere in the shell focuses it", async ({ page }) => {
    await page.locator(".repl-log").click();
    await expect(shell(page)).toBeFocused();
    await expect(page.locator(".repl")).toHaveClass(/focused/);
    await shell(page).press("Escape");
    await expect(shell(page)).not.toBeFocused();
    await expect(page.locator(".repl")).not.toHaveClass(/focused/);
  });

  test("selecting text to copy doesn't steal focus or run commands", async ({ page }) => {
    await run(page, "git log --oneline");
    await shell(page).blur();
    const selectAndClick = (selector: string) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel)!;
        getSelection()!.selectAllChildren(el);
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return getSelection()!.toString();
      }, selector);
    expect(await selectAndClick(".repl-log > div:last-child")).toContain("8c0d698");
    await expect(shell(page)).not.toBeFocused();
    const before = await log(page).locator(":scope > div").count();
    expect(await selectAndClick("button.sha")).toBe("8c0d698");
    await expect(log(page).locator(":scope > div")).toHaveCount(before);
  });

  test("redraws correctly with leading spaces and a mid-line cursor", async ({ page }) => {
    await shell(page).fill("  ls -a");
    for (let i = 0; i < 5; i++) await shell(page).press("ArrowLeft");
    const echo = page.locator(".echo");
    await expect(echo).toHaveText("  ls -a");
    await expect(echo.locator(".cursor")).toHaveText("l");
    await expect(echo.locator(".hl-cmd")).toHaveText("s");
    await shell(page).press("ArrowLeft");
    await shell(page).press("ArrowLeft");
    await expect(echo.locator(".cursor")).toHaveText(" ");
    await shell(page).click(); // clicking also redraws
    await expect(echo).toHaveText("  ls -a");
  });

  test("whitespace alone gets no suggestion", async ({ page }) => {
    await shell(page).fill("   ");
    await expect(page.locator(".echo .hl-suggest")).toHaveText("");
  });

  test("End and Ctrl-F also accept a suggestion; arrows without one do nothing", async ({ page }) => {
    await shell(page).fill("whoa");
    await shell(page).press("End");
    await expect(shell(page)).toHaveValue("whoami");
    await shell(page).fill("fin");
    await shell(page).press("Control+f");
    await expect(shell(page)).toHaveValue("finger");
    await shell(page).fill("zz");
    await shell(page).press("ArrowRight");
    await expect(shell(page)).toHaveValue("zz");
  });

  test("history arrows stop at both ends", async ({ page }) => {
    await shell(page).press("ArrowUp");
    await expect(shell(page)).toHaveValue("");
    await run(page, "pwd");
    await shell(page).press("ArrowDown");
    await shell(page).press("ArrowDown");
    await expect(shell(page)).toHaveValue("");
  });

  test("Ctrl-C abandons the line, but not while text is selected", async ({ page }) => {
    await shell(page).fill("half a comm");
    await shell(page).press("Control+c");
    await expect(shell(page)).toHaveValue("");
    await expect(lastOutput(page)).toHaveText("sferik@mbp ~> half a comm^C");
    await shell(page).fill("copy me");
    await shell(page).selectText();
    await shell(page).press("Control+c");
    await expect(shell(page)).toHaveValue("copy me");
  });

  test("Tab after a complete directory changes nothing", async ({ page }) => {
    await shell(page).fill("cd talks/");
    await shell(page).press("Tab");
    await expect(shell(page)).toHaveValue("cd talks/");
    await expect(page.locator(".repl-completions")).toBeEmpty();
  });

  test("Tab completes files and folders after any other command", async ({ page }) => {
    await shell(page).fill("vim h");
    await shell(page).press("Tab");
    await expect(shell(page)).toHaveValue("vim humans.txt ");
  });

  test("Tab completes in the middle of a line", async ({ page }) => {
    await shell(page).fill("cat h | wc");
    for (let i = 0; i < 5; i++) await shell(page).press("ArrowLeft");
    await shell(page).press("Tab");
    await expect(shell(page)).toHaveValue("cat humans.txt  | wc");
  });
});

// ---------------------------------------------------------- other pages

test.describe("shell on the 404 page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/nope");
  });

  test("whoami borrows the home page's text", async ({ page }) => {
    await run(page, "whoami");
    await expect(log(page).locator(".repl-rich")).toContainText("I'm the author of MultiJSON and MultiXML");
  });

  test("whoami falls back to the username when the home page can't load", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/whoami",
      (route) => route.abort(),
    );
    await run(page, "whoami");
    await expect(lastOutput(page)).toHaveText("sferik");
  });

  test("finger works without a contact section", async ({ page }) => {
    await run(page, "finger");
    await expect(lastOutput(page)).toContainText("Login: sferik");
  });

  test("cd with no argument goes home", async ({ page }) => {
    await run(page, "cd");
    await expect(page).toHaveURL("/");
  });

  test("? and Escape do nothing without a help overlay", async ({ page }) => {
    await shell(page).blur();
    await page.keyboard.press("?");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-help]")).toHaveCount(0);
  });
});

test.describe("pages without a shell", () => {
  test("/ and : do nothing on the talks page", async ({ page }) => {
    await page.goto("/talks");
    await page.keyboard.press("/");
    await page.keyboard.press(":");
    await expect(page).toHaveURL("/talks");
  });
});

// ------------------------------------------------------ keyboard edge cases

test.describe("keyboard edge cases", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test(": also focuses the shell", async ({ page }) => {
    await page.keyboard.press(":");
    await expect(shell(page)).toBeFocused();
  });

  for (const mod of ["Control", "Alt", "Meta"]) {
    test(`${mod} chords are left to the browser`, async ({ page }) => {
      await page.keyboard.press(`${mod}+j`);
      expect(await page.locator("[data-scroller]").evaluate((el) => el.scrollTop)).toBe(0);
    });
  }

  test("g followed by another key does nothing", async ({ page }) => {
    await page.keyboard.press("g");
    await page.keyboard.press("x");
    await page.keyboard.press("t");
    await expect(page).toHaveURL("/");
  });

  test("a lone g expires", async ({ page }) => {
    await page.keyboard.press("g");
    await page.waitForTimeout(900);
    await page.keyboard.press("t");
    await expect(page).toHaveURL("/");
  });

  test("with reduced motion, jumps happen instantly", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    const top = () => page.locator("[data-scroller]").evaluate((el) => el.scrollTop);
    await page.keyboard.press("G");
    expect(await top()).toBeGreaterThan(500);
    await page.keyboard.press("Escape"); // the bottom of the page focuses the prompt
    await page.keyboard.press("g");
    await page.keyboard.press("g");
    expect(await top()).toBe(0);
    await page.keyboard.press("/");
    await expect(shell(page)).toBeFocused();
    await run(page, "finger");
    await expect(page.locator("#finger")).toBeInViewport();
  });
});
