// The shell in shell.js: parsing, pipes, job control, and every command.
import { test, expect } from "./support/fixtures.ts";
import type { Page } from "@playwright/test";
import { mockAPIs } from "./support/mocks.ts";

const field = (page: Page) => page.locator("[data-repl] input");
const log = (page: Page) => page.locator(".repl-log");
const out = (page: Page) => log(page).innerText();

// Type a command line and wait for it to finish.
async function sh(page: Page, line: string) {
  await field(page).fill(line);
  await field(page).press("Enter");
  await expect(page.locator(".repl.running")).toHaveCount(0);
}
// Start a command line without waiting (for commands that read input or run forever).
async function start(page: Page, line: string) {
  await field(page).fill(line);
  await field(page).press("Enter");
  await expect(page.locator(".repl.running")).toHaveCount(1);
}
async function type(page: Page, line: string) {
  await field(page).fill(line);
  await field(page).press("Enter");
}
const done = (page: Page) => expect(page.locator(".repl.running")).toHaveCount(0);
// Output since the last prompt line for `command`.
async function result(page: Page, line: string) {
  await sh(page, line);
  const text = await out(page);
  const marker = `> ${line}\n`;
  const at = text.lastIndexOf(marker);
  return at < 0 && text.endsWith(`> ${line}`) ? "" : text.slice(at + marker.length).replace(/\nsferik@mbp[\s\S]*$/, "");
}

test.beforeEach(async ({ page }) => {
  await mockAPIs(page);
  await page.goto("/");
});

// ------------------------------------------------------------- language

test.describe("shell language", () => {
  test("pipes stream, and stop early", async ({ page }) => {
    expect(await result(page, "yes | head -n 3")).toBe("y\ny\ny");
    expect(await result(page, "yes sferik | head -2 | tail -1")).toBe("sferik");
  });

  test("; && || and $status", async ({ page }) => {
    expect(await result(page, "false; echo $status")).toBe("1");
    expect(await result(page, "true && echo yes || echo no")).toBe("yes");
    expect(await result(page, "false && echo yes || echo no")).toBe("no");
    expect(await result(page, "echo a; echo b")).toBe("a\nb");
  });

  test("a failed command shows its status in the prompt, like fish", async ({ page }) => {
    await sh(page, "false");
    await expect(page.locator(".repl-line .prompt")).toHaveText("sferik@mbp ~ [1]> ");
    await sh(page, "false | true");
    await expect(page.locator(".repl-line .prompt")).toHaveText("sferik@mbp ~ [1|0]> ");
    await sh(page, "true");
    await expect(page.locator(".repl-line .prompt")).toHaveText("sferik@mbp ~> ");
  });

  test("quotes, escapes, and variables", async ({ page }) => {
    expect(await result(page, `echo 'single $USER' "double $USER" un\\ quoted`)).toBe("single $USER double sferik un quoted");
    expect(await result(page, `echo "say \\"hi\\" \\$5"`)).toBe('say "hi" $5');
    expect(await result(page, "echo $HOME $SHELL $NOPE end")).toBe("/Users/sferik /opt/homebrew/bin/fish  end");
    expect(await result(page, 'echo "$version" $pipestatus')).toBe("4.1.2 0");
  });

  test("env lists exported variables; set lists them all, and changes them", async ({ page }) => {
    expect(await result(page, "env | grep -e PATH -e EDITOR")).toBe("EDITOR=vim\nPATH=/opt/homebrew/bin:/usr/bin:/bin");
    expect(await result(page, "env | grep -c =")).toBe("11");
    expect(await result(page, "env nope; echo $status")).toBe("env: nope: No such file or directory\n127");
    expect(await result(page, "set | grep -e PATH -e version")).toBe("PATH /opt/homebrew/bin /usr/bin /bin\nversion 4.1.2");
    expect(await result(page, "echo $EMAIL $WEBSITE $TZ $LANG")).toBe("sferik@gmail.com https://sferik.net America/Los_Angeles en_US.UTF-8");
    expect(await result(page, "set FOO bar baz; echo $FOO; env | grep -c FOO")).toBe("bar baz\n0");
    expect(await result(page, "set -x FOO qux; env | grep FOO")).toBe("FOO=qux");
    expect(await result(page, "set EDITOR nano; env | grep EDITOR")).toBe("EDITOR=nano");
    expect(await result(page, "set -q HOME; echo $status; set -q FOO NOPE ALSO_NOPE; echo $status")).toBe("0\n2");
    expect(await result(page, "set BAR 1; set -e BAR FOO; set -q BAR; echo $status")).toBe("1");
    expect(await result(page, "set -e FOO; set -e FOO; echo $status")).toBe("4");
    expect(await result(page, "set status 3")).toBe("set: Tried to modify the special variable 'status'");
    expect(await result(page, "set -e PWD")).toBe("set: Tried to modify the special variable 'PWD'");
    expect(await result(page, "set a-b c")).toBe("set: Variable name 'a-b' is not valid. See `help identifiers`.");
  });

  test("wildcards expand against the files", async ({ page }) => {
    expect(await result(page, "echo *.txt")).toBe("humans.txt robots.txt");
    expect(await result(page, "echo .*")).toBe(".plan .signature");
    // The home page's cat .signature, for real.
    expect(await result(page, "cat .signature")).toBe("I build libraries and tools software engineers depend on.");
    expect(await result(page, "echo talks/*")).toBe("talks/index.html");
    expect(await result(page, "echo *.nope")).toContain("fish: No matches for wildcard '*.nope'");
    await expect(page.locator(".repl-line .prompt")).toContainText("[124]");
    expect(await result(page, "echo nope/*")).toContain("No matches for wildcard");
  });

  test("syntax errors", async ({ page }) => {
    expect(await result(page, "echo 'oops")).toContain("fish: Unexpected end of string, quotes are not balanced");
    expect(await result(page, 'echo "oops')).toContain("quotes are not balanced");
    expect(await result(page, "| grep x")).toContain("fish: Expected a command, but found '|'");
    expect(await result(page, "echo hi |")).toContain("Expected a command, but found end of the input");
    expect(await result(page, "echo hi | ; ls")).toContain("Expected a command, but found ';'");
    expect(await result(page, "; echo after")).toBe("after");
  });

  test("stderr goes to the terminal, not down the pipe", async ({ page }) => {
    expect(await result(page, "cat nope | wc -l")).toContain("cat: nope: No such file or directory");
    expect(await out(page)).toMatch(/No such file or directory\n\s+0/);
  });

  test("usage errors from options", async ({ page }) => {
    expect(await result(page, "ls -z")).toBe("ls: illegal option -- z");
    expect(await result(page, "grep --frobnicate x")).toBe("grep: unrecognized option '--frobnicate'");
    expect(await result(page, "head -n")).toBe("head: option requires an argument -- n");
    expect(await result(page, "head -n x humans.txt")).toBe("head: illegal line count -- x");
    expect(await result(page, "head -c x humans.txt")).toBe("head: illegal byte count -- x");
  });

  test("a command that throws reports its error", async ({ page }) => {
    await page.route("**/resume", (route) => route.abort());
    expect(await result(page, "man sferik")).toBe("man: Failed to fetch");
  });

  test("echo options", async ({ page }) => {
    expect(await result(page, "echo -n hi; echo there")).toBe("hithere");
    expect(await result(page, "echo -s a b c")).toBe("abc");
    expect(await result(page, "echo -e 'a\\tb\\nc'")).toBe("a\tb\nc");
    expect(await result(page, "echo -n")).toBe("");
  });
});

// ---------------------------------------------------------- job control

test.describe("history", () => {
  test("is shared between tabs", async ({ page, context }) => {
    const other = await context.newPage();
    await other.goto("/");
    await sh(other, "echo from the other tab");
    await field(page).press("ArrowUp");
    await expect(field(page)).toHaveValue("echo from the other tab");
    // Other storage, and history that isn't history, leave it be.
    await other.evaluate(() => localStorage.setItem("something-else", "x"));
    await other.evaluate(() => localStorage.setItem("history", "not json"));
    await field(page).fill("");
    await field(page).press("ArrowUp");
    await expect(field(page)).toHaveValue("echo from the other tab");
  });

  test("is kept between visits", async ({ page }) => {
    await sh(page, "echo one");
    await sh(page, "echo two");
    await page.goto("/nope"); // a page that runs nothing of its own
    await field(page).press("ArrowUp");
    await expect(field(page)).toHaveValue("echo two");
    await field(page).press("ArrowUp");
    await expect(field(page)).toHaveValue("echo one");
    // The commands the home page ran weren't saved with them.
    await field(page).press("ArrowUp");
    await expect(field(page)).toHaveValue("echo one");
  });

  test("history clear forgets everything, here and saved", async ({ page }) => {
    await page.goto("/nope");
    await sh(page, "echo one");
    await sh(page, "echo two");
    await sh(page, "history clear");
    expect(await result(page, "history")).toBe("");
    await field(page).press("ArrowUp");
    await field(page).press("ArrowUp");
    await expect(field(page)).toHaveValue("history"); // the only command since
    // Saved too, so the next visit starts empty (but for what was typed since).
    expect(await page.evaluate(() => localStorage.getItem("history"))).toBe('["history"]');
  });

  test("history delete forgets a command, wherever it is", async ({ page }) => {
    await page.addInitScript(() => localStorage.getItem("history") ?? localStorage.setItem("history", '["old", "echo a"]'));
    await page.goto("/");
    await sh(page, "echo a");
    await sh(page, "echo b");
    await sh(page, "history delete echo a");
    await sh(page, "history delete old"); // before the page's commands
    await sh(page, "history delete whoami"); // one of them
    expect(await result(page, "history | head -3")).toBe("history delete whoami\nhistory delete old\nhistory delete echo a");
    expect(await result(page, "history | grep -c -e '^echo a$' -e '^old$' -e '^whoami$'")).toBe("0");
    expect(await result(page, "history delete; echo $status")).toBe("history: delete needs a command, like history delete ls\n1");
    // What's saved is what's left, without the page's own commands.
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("history")))!)).toEqual([
      "echo b",
      "history delete echo a",
      "history delete old",
      "history delete whoami",
      "history | head -3",
      "history | grep -c -e '^echo a$' -e '^old$' -e '^whoami$'",
      "history delete; echo $status",
    ]);
  });

  test("history TEXT and history search TEXT list what contains it", async ({ page }) => {
    await page.goto("/nope");
    for (const line of ["echo apple", "echo banana", "echo apricot"]) await sh(page, line);
    expect(await result(page, "history ap")).toBe("echo apricot\necho apple");
    expect(await result(page, "history search ban")).toBe("echo banana");
    expect(await result(page, "history search zzz")).toBe("");
  });

  test("last clear forgets the visits, this one too", async ({ page }) => {
    await page.goto("/");
    await page.reload(); // a second visit, so there's a last login
    await expect(page.locator("[data-login]")).toHaveText(/^Last login:/);
    await sh(page, "last clear");
    await expect(page.locator("[data-login]")).toHaveText("\u00a0");
    expect(await page.evaluate(() => localStorage.getItem("visits"))).toBeNull();
    expect((await result(page, "last")).split("\n")).toHaveLength(3); // just this session, and where wtmp begins
    // Leaving doesn't record this visit, so the next is a first visit again.
    await page.evaluate(() => dispatchEvent(new Event("pagehide")));
    expect(await page.evaluate(() => localStorage.getItem("visits"))).toBeNull();
  });

  test("last clear works where there's no last login to blank, or storage to clear", async ({ page }) => {
    await page.addInitScript(() => {
      Storage.prototype.removeItem = () => {
        throw new DOMException("blocked", "SecurityError");
      };
    });
    await page.goto("/nope");
    expect(await result(page, "last clear; echo $status")).toBe("0");
  });

  test("starts with the commands the page ran, newest first", async ({ page }) => {
    await field(page).press("ArrowUp");
    await expect(field(page)).toHaveValue("finger sferik");
    await field(page).press("ArrowUp");
    await expect(field(page)).toHaveValue("ls -t ~/talks | head -6");
    expect((await result(page, "history")).split("\n")[0]).toBe("finger sferik");
  });

  test("Ctrl-R searches it, newest first, like fish", async ({ page }) => {
    await page.goto("/nope"); // a shell with no history yet
    const pager = page.locator(".repl-completions");
    for (const line of ["echo apple", "echo banana", "echo apricot", "echo apple"]) await sh(page, line);
    await field(page).press("Control+r");
    await expect(pager).toHaveText("(reverse-i-search)'': echo apple");
    await field(page).pressSequentially("ap");
    await expect(pager).toHaveText("(reverse-i-search)'ap': echo apple");
    // Ctrl-R again finds older lines, once each, and stays on the oldest.
    await field(page).press("Control+r");
    await expect(pager).toHaveText("(reverse-i-search)'ap': echo apricot");
    await field(page).press("Control+r");
    await expect(pager).toHaveText("(reverse-i-search)'ap': echo apricot");
    // Enter takes the line without running it.
    await field(page).press("Enter");
    await expect(field(page)).toHaveValue("echo apricot");
    await expect(pager).toBeEmpty();
    await expect(log(page)).not.toContainText("> echo apricot\napricot\nsferik@mbp ~> echo apricot");
    // No match: Ctrl-R stays put, and Escape puts back the line.
    await field(page).press("Control+r");
    await field(page).fill("zzz");
    await expect(pager).toHaveText("(failed reverse-i-search)'zzz'");
    await field(page).press("Control+r");
    await expect(pager).toHaveText("(failed reverse-i-search)'zzz'");
    await field(page).press("Enter");
    await expect(field(page)).toHaveValue("zzz");
    for (const cancel of ["Escape", "Control+g", "Control+c"]) {
      await field(page).fill("draft");
      await field(page).press("Control+r");
      await field(page).fill("ban");
      await field(page).press(cancel);
      await expect(field(page)).toHaveValue("draft");
      await expect(pager).toBeEmpty();
    }
    for (const accept of ["ArrowRight", "End", "Tab"]) {
      await field(page).fill("");
      await field(page).press("Control+r");
      await field(page).fill("ban");
      await field(page).press(accept);
      await expect(field(page)).toHaveValue("echo banana");
    }
  });
});

test.describe("for loops and functions", () => {
  test("for runs its body once for each value, as the variable", async ({ page }) => {
    expect(await result(page, "for x in a b c; echo $x; end")).toBe("a\nb\nc");
    expect(await result(page, "for f in *.txt; echo $f; end")).toBe("humans.txt\nrobots.txt");
    expect(await result(page, "for x in 1 2; for y in a b; echo $x$y; end; end")).toBe("1a\n1b\n2a\n2b");
    expect(await result(page, "set x keep; for x in 1 2; end; echo $x")).toBe("keep");
    expect(await result(page, "for x in; echo never; end; echo $status")).toBe("0");
    expect(await result(page, "false && for x in a; echo $x; end; echo done")).toBe("done");
    expect(await result(page, "for f in *.nope; echo $f; end; echo $status")).toBe(
      "fish: No matches for wildcard '*.nope'. See `help wildcards-globbing`.\n124",
    );
  });

  test("function defines a command, with its arguments in $argv", async ({ page }) => {
    expect(await result(page, "functions")).toBe("");
    expect(await result(page, "function greet; echo hi $argv; end; greet there you")).toBe("hi there you");
    expect(await result(page, "greet a b | wc -w")).toBe("       3");
    expect(await result(page, "functions")).toBe("greet");
    expect(await result(page, "function f; false; end; f; echo $status")).toBe("1");
    expect(await result(page, "function quiet; true; end; quiet; echo $status")).toBe("0");
    expect(await result(page, "set argv outer; function g; echo $argv; end; g inner; echo $argv")).toBe("inner\nouter");
    expect(await result(page, "function zebra; end; zebrr")).toBe("fish: Unknown command: zebrr. Did you mean zebra?");
    await field(page).fill("greet");
    await expect(page.locator(".echo .hl-cmd")).toHaveText("greet");
    await field(page).fill("for x in a; end");
    await expect(page.locator(".echo .hl-cmd").first()).toHaveText("for");
  });

  test("blocks that don't balance, like fish", async ({ page }) => {
    expect(await result(page, "for x in a; echo $x")).toBe("fish: Missing end to balance this for loop");
    expect(await result(page, "function f; echo")).toBe("fish: Missing end to balance this function definition");
    expect(await result(page, "end")).toBe("fish: 'end' outside of a block");
    expect(await result(page, "for x; echo; end")).toBe("fish: for: Expected 'for VARIABLE in [VALUES...]'");
    expect(await result(page, "for x on a; end")).toBe("fish: for: Expected 'for VARIABLE in [VALUES...]'");
    expect(await result(page, "function; end")).toBe("fish: function: Expected 'function NAME'");
    expect(await result(page, "function a b; end")).toBe("fish: function: Expected 'function NAME'");
  });

  test("an unknown command suggests the nearest one", async ({ page }) => {
    expect(await result(page, "lss; echo $status")).toBe("fish: Unknown command: lss. Did you mean ls?\n127");
    expect(await result(page, "fingr")).toBe("fish: Unknown command: fingr. Did you mean finger?");
    expect(await result(page, "xyzzyq")).toBe("fish: Unknown command: xyzzyq");
  });
});

test.describe("line editing", () => {
  test("Ctrl-A, Ctrl-E, Ctrl-U, Ctrl-K, Ctrl-W, Alt-B, and Alt-F, like fish", async ({ page }) => {
    const at = () => field(page).evaluate((e: HTMLInputElement) => e.selectionStart);
    await field(page).fill("echo hello there world");
    await field(page).press("Control+a");
    expect(await at()).toBe(0);
    await field(page).press("Alt+f");
    expect(await at()).toBe(4);
    await field(page).press("Alt+f");
    expect(await at()).toBe(10);
    await field(page).press("Alt+b");
    expect(await at()).toBe(5);
    await field(page).press("Control+k");
    await expect(field(page)).toHaveValue("echo ");
    await field(page).fill("echo hello there");
    await field(page).press("Control+e");
    expect(await at()).toBe(16);
    await field(page).press("Control+w");
    await expect(field(page)).toHaveValue("echo hello ");
    await field(page).press("Control+w");
    await expect(field(page)).toHaveValue("echo ");
    await field(page).fill("echo abc");
    for (let i = 0; i < 3; i++) await field(page).press("ArrowLeft");
    await field(page).press("Control+u");
    await expect(field(page)).toHaveValue("abc");
    expect(await at()).toBe(0);
  });

  test("Ctrl-E at the end accepts the suggestion, like →", async ({ page }) => {
    await sh(page, "echo suggested");
    await field(page).fill("echo sug");
    await field(page).press("Control+e");
    await expect(field(page)).toHaveValue("echo suggested");
  });
});

test.describe("the bell", () => {
  const flashes = (page: import("@playwright/test").Page) =>
    page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const screen = document.querySelector("[data-scroller]")!;
          if (screen.classList.contains("bell")) return resolve(true);
          new MutationObserver(() => screen.classList.contains("bell") && resolve(true)).observe(screen, { attributes: true });
          setTimeout(() => resolve(false), 1000);
        }),
    );

  test("printf '\\a' and echo -e '\\a' flash the screen, and print nothing for it", async ({ page }) => {
    const flash = flashes(page);
    expect(await result(page, "printf 'ding\\a'")).toBe("ding");
    expect(await flash).toBe(true);
    await expect(page.locator("[data-scroller]")).not.toHaveClass(/bell/);
    const again = flashes(page);
    await sh(page, "echo -e 'x\\a'");
    expect(await again).toBe(true);
  });

  test("Tab with nothing to complete flashes the screen", async ({ page }) => {
    const flash = flashes(page);
    await field(page).fill("zzzq");
    await field(page).press("Tab");
    expect(await flash).toBe(true);
  });
});

test.describe("job control", () => {
  test("Ctrl-C interrupts a running command", async ({ page }) => {
    await start(page, "yes");
    await page.waitForTimeout(100);
    await field(page).press("Control+c");
    await done(page);
    expect(await out(page)).toMatch(/y\n\^C$/);
    await expect(page.locator(".repl-line .prompt")).toHaveText("sferik@mbp ~ [130]> ");
  });

  test("the page follows output down as it prints, until you scroll up", async ({ page }) => {
    const scroller = page.locator("[data-scroller]");
    const fromBottom = () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    const top = () => scroller.evaluate((el) => el.scrollTop);
    const before = await scroller.evaluate((el) => el.scrollHeight);
    await start(page, "yes");
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight)).toBeGreaterThan(before + 2000);
    await expect.poll(fromBottom).toBeLessThan(3);
    // Scrolling up to read leaves you there while the output keeps coming.
    await scroller.evaluate((el) => el.scrollBy({ top: -500 }));
    const reading = await top();
    await page.waitForTimeout(300);
    expect(await top()).toBe(reading);
    expect(await fromBottom()).toBeGreaterThanOrEqual(500);
    // Scrolling back to the bottom follows it again.
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(300);
    await expect.poll(fromBottom).toBeLessThan(3);
    await field(page).press("Control+c");
    await done(page);
  });

  test("an interrupt stops the rest of the line", async ({ page }) => {
    await start(page, "caffeinate; echo never");
    await field(page).press("Control+c");
    await done(page);
    expect(await out(page)).not.toMatch(/\nnever/);
  });

  test("commands read typed lines when nothing is piped in; Ctrl-D ends input", async ({ page }) => {
    await start(page, "cat");
    await type(page, "hello");
    await type(page, "world");
    await field(page).press("Control+d");
    await done(page);
    expect(await out(page)).toContain("~> cat\nhello\nhello\nworld\nworld");
  });

  test("lines typed before a command asks for them are kept", async ({ page }) => {
    await start(page, "caffeinate -t 0.3; wc -l");
    await type(page, "early");
    await field(page).press("Control+d");
    await done(page);
    expect(await out(page)).toMatch(/early\n\s+1$/);
  });

  test("other keys while a command runs are left alone", async ({ page }) => {
    await start(page, "cat");
    await field(page).press("Control+d"); // with text typed, Ctrl-D does nothing special
    await field(page).fill("x");
    await field(page).press("Control+d");
    await field(page).press("Tab");
    await field(page).fill("");
    await field(page).press("Control+d");
    await done(page);
  });

  test("the prompt hides while a command runs", async ({ page }) => {
    await start(page, "caffeinate");
    await expect(page.locator(".repl-line .ps1-static")).toBeHidden();
    await field(page).press("Control+c");
    await done(page);
    await expect(page.locator(".repl-line .ps1-static")).toBeVisible();
  });

  test("exit and Ctrl-D end the session; any key starts a new one", async ({ page }) => {
    await sh(page, "exit");
    await expect(log(page)).toContainText("[Process completed]");
    await field(page).press("x");
    await expect(log(page)).toHaveText("Type help for a list of commands");
    await field(page).press("Control+d");
    await expect(log(page)).toContainText("[Process completed]");
    await field(page).press("Enter");
    await sh(page, "logout");
    await expect(log(page)).toContainText("[Process completed]");
  });

  test("Ctrl-D mid-line deletes the character under the cursor", async ({ page }) => {
    await field(page).fill("abc");
    await field(page).evaluate((el: HTMLInputElement) => el.setSelectionRange(0, 0));
    await field(page).press("Control+d");
    await expect(field(page)).toHaveValue("bc");
  });

  test("the commit button waits for a running command", async ({ page }) => {
    await start(page, "caffeinate");
    await page.locator("button.sha").click();
    await field(page).press("Control+c");
    await done(page);
    expect(await out(page)).not.toContain("+Erik Berlin");
  });
});

// ---------------------------------------------------------------- files

test.describe("files", () => {
  test("ls: columns, one per line into a pipe, -a, -A, -F, -1", async ({ page }) => {
    expect(await result(page, "ls")).toMatch(/^dependency\.webp\s+index\.html\s+robots\.txt\nhumans\.txt\s+resume\s+talks$/);
    expect(await result(page, "ls | cat")).toBe("dependency.webp\nhumans.txt\nindex.html\nresume\nrobots.txt\ntalks");
    expect(await result(page, "ls -1F")).toBe("dependency.webp\nhumans.txt\nindex.html\nresume/\nrobots.txt\ntalks/");
    expect(await result(page, "ls -A | head -1")).toBe(".plan");
    expect(await result(page, "ls -a | head -2")).toBe(".\n..");
    expect(await result(page, "ls talks")).toBe("index.html");
    expect(await result(page, "ls humans.txt")).toBe("humans.txt");
    expect(await result(page, "ls talks resume")).toBe("resume:\nindex.html\n\ntalks:\nindex.html");
  });

  test("ls -l, -lh, -t, -S, -r", async ({ page }) => {
    const long = await result(page, "ls -l");
    expect(long).toMatch(
      /^total \d+\n-rw-r--r-- {2}1 sferik {2}staff\s+7298 \w{3} [ \d]\d \d\d:\d\d dependency\.webp\n-rw-r--r-- {2}1 sferik {2}staff\s+\d+ \w{3} [ \d]\d \d\d:\d\d humans\.txt/,
    );
    expect(long).toMatch(/drwxr-xr-x {2}3 sferik {2}staff\s+96 .* resume/);
    expect(await result(page, "ls -lh humans.txt")).toMatch(/\d+B .* humans\.txt$/);
    expect(await result(page, "ls -lh index.html")).toMatch(/\d+K .* index\.html$/);
    expect(await result(page, "ls -S | head -1")).toBe("index.html");
    expect(await result(page, "ls -Sr | head -1")).toBe("robots.txt");
    expect(await result(page, "ls -t | wc -l")).toMatch(/^\s+6$/);
    expect(await result(page, "ls -la talks | head -3")).toMatch(/^total \d+\ndrwxr-xr-x .* \.\ndrwxr-xr-x .* \.\.$/);
  });

  test("ls errors", async ({ page }) => {
    expect(await result(page, "ls nope")).toBe("ls: nope: No such file or directory");
    expect(await result(page, "ls ..")).toBe("ls: ..: Permission denied");
    await expect(page.locator(".repl-line .prompt")).toContainText("[1]");
  });

  test("ls dates older than six months show the year", async ({ page }) => {
    await page.route("**/robots.txt", (route) => route.fulfill({ body: "x\n", headers: { "last-modified": "Wed, 14 May 2008 20:36:12 GMT" } }));
    expect(await result(page, "ls -l robots.txt")).toMatch(/May 14 {2}2008 robots\.txt$/);
  });

  test("cat, cat -n, cat -b, and cat -", async ({ page }) => {
    expect(await result(page, "cat .plan")).toContain("Ship small, sharp tools.");
    expect(await result(page, "cat -n .plan | head -2")).toBe(
      "     1\tLogin: sferik                           Name: Erik Berlin\n     2\tDirectory: /Users/sferik                Shell: /opt/homebrew/bin/fish",
    );
    expect(await result(page, "cat -b .plan | head -4 | tail -1")).toBe("");
    expect(await result(page, "echo piped | cat - .plan | head -1")).toBe("piped");
    expect(await result(page, "cat talks")).toBe("cat: talks: Is a directory");
    expect(await result(page, "cat ../x")).toBe("cat: ../x: Permission denied");
  });

  test("less and more print, since there's no pager", async ({ page }) => {
    expect(await result(page, "less robots.txt")).toBe("User-agent: *\nAllow: /\n\nSitemap: https://sferik.net/sitemap.xml");
    expect(await result(page, "echo hi | more")).toBe("hi");
    expect(await result(page, "less")).toBe('Missing filename ("less --help" for help)');
    expect(await result(page, "more")).toContain("usage: more");
  });

  test("head and tail: -n, -N, -c, +N, multiple files", async ({ page }) => {
    expect(await result(page, "head -1 robots.txt")).toBe("User-agent: *");
    expect(await result(page, "head -c 4 robots.txt")).toBe("User");
    expect(await result(page, "head -n 0 robots.txt")).toBe("");
    expect(await result(page, "head -c 0 robots.txt")).toBe("");
    expect(await result(page, "tail -1 robots.txt")).toBe("Sitemap: https://sferik.net/sitemap.xml");
    expect(await result(page, "tail -n +2 robots.txt")).toBe("Allow: /\n\nSitemap: https://sferik.net/sitemap.xml");
    expect(await result(page, "tail -c 3 robots.txt")).toBe("ml");
    expect(await result(page, "tail -c +20 robots.txt")).toBe(": /\n\nSitemap: https://sferik.net/sitemap.xml");
    expect(await result(page, "tail -n 0 robots.txt")).toBe("");
    expect(await result(page, "tail -c 0 robots.txt")).toBe("");
    expect(await result(page, "head -1 robots.txt .plan")).toBe(
      "==> robots.txt <==\nUser-agent: *\n\n==> .plan <==\nLogin: sferik                           Name: Erik Berlin",
    );
    expect(await result(page, "tail -1 robots.txt .plan")).toBe(
      "==> robots.txt <==\nSitemap: https://sferik.net/sitemap.xml\n\n==> .plan <==\n  - Ship small, sharp tools.",
    );
    expect(await result(page, "head nope")).toBe("head: nope: No such file or directory");
    expect(await result(page, "tail nope")).toBe("tail: nope: No such file or directory");
    expect(await result(page, "zzqq | tail")).toContain("fish: Unknown command: zzqq");
  });

  test("tail -f waits for more until Ctrl-C", async ({ page }) => {
    await start(page, "tail -f robots.txt");
    await expect(log(page)).toContainText("Allow: /");
    await field(page).press("Control+c");
    await done(page);
  });

  test("grep: patterns and options", async ({ page }) => {
    expect(await result(page, "grep Allow robots.txt")).toBe("Allow: /");
    await expect(log(page).locator(".grep-match").last()).toHaveText("Allow");
    expect(await result(page, "grep -i allow robots.txt")).toBe("Allow: /");
    expect(await result(page, "grep -v Allow robots.txt")).toBe("User-agent: *\nSitemap: https://sferik.net/sitemap.xml");
    // The blank line in between is there, a line high.
    expect(
      await log(page)
        .locator(":scope > div")
        .nth(-2)
        .evaluate((e) => [e.textContent, e.getBoundingClientRect().height > 10]),
    ).toEqual(["", true]);
    expect(await result(page, "grep -n Allow robots.txt")).toBe("2:Allow: /");
    expect(await result(page, "grep -c '[a-z]' robots.txt .plan")).toBe("robots.txt:3\n.plan:5");
    expect(await result(page, "grep -l Allow robots.txt .plan")).toBe("robots.txt");
    expect(await result(page, "grep -L Allow robots.txt .plan")).toBe(".plan");
    expect(await result(page, "grep -o 'A[a-z]*' robots.txt")).toBe("Allow");
    expect(await result(page, "grep -w low robots.txt")).toBe("");
    expect(await result(page, "grep -x 'Allow: /' robots.txt")).toBe("Allow: /");
    expect(await result(page, "grep -E 'User|Allow' robots.txt | wc -l")).toMatch(/^\s+2$/);
    expect(await result(page, "grep 'User\\|Allow' robots.txt | wc -l")).toMatch(/^\s+2$/);
    expect(await result(page, "grep -F '*' robots.txt")).toBe("User-agent: *");
    expect(await result(page, "grep -e User -e Allow robots.txt | wc -l")).toMatch(/^\s+2$/);
    expect(await result(page, "grep -h Allow robots.txt .plan")).toBe("Allow: /");
    expect(await result(page, "grep -H Allow robots.txt")).toBe("robots.txt:Allow: /");
    expect(await result(page, "grep -m 1 e .plan")).toBe("Login: sferik                           Name: Erik Berlin");
    expect(await result(page, "grep -c -m 1 e .plan")).toBe("1");
    expect(await result(page, "grep -q Allow robots.txt && echo found")).toBe("found");
    expect(await result(page, "grep --color=never Allow robots.txt")).toBe("Allow: /");
    expect(await result(page, "grep --color=always Allow robots.txt | cat")).toBe("Allow: /");
    expect(await result(page, "grep -l zzz robots.txt; echo $status")).toBe("1");
  });

  test("grep reads stdin, recurses, and reports errors", async ({ page }) => {
    expect(await result(page, "echo hello | grep -c l")).toBe("1");
    expect(await result(page, "echo hello | grep -H ell")).toBe("(standard input):hello");
    expect(await result(page, "echo hello | grep -l ell")).toBe("(standard input)");
    expect(await result(page, "echo hello | grep -L zzz")).toBe("(standard input)");
    expect(await result(page, "grep -r 'Allow' . | head -1")).toBe("robots.txt:Allow: /");
    expect(await result(page, "grep -rl talks talks")).toBe("talks/index.html");
    expect(await result(page, "grep -R Ship | head -1")).toBe(".plan:  - Ship small, sharp tools.");
    expect(await result(page, "grep x nope; echo $status")).toBe("grep: nope: No such file or directory\n2");
    expect(await result(page, "grep -s x nope; echo $status")).toBe("grep: nope: No such file or directory\n1");
    expect(await result(page, "grep '(' robots.txt")).toBe("");
    expect(await result(page, "grep -E '(' robots.txt; echo $status")).toBe("grep: parentheses not balanced\n2");
    expect(await result(page, "grep -E 'a)' robots.txt")).toBe("grep: parentheses not balanced");
    expect(await result(page, "grep '[a' robots.txt")).toBe("grep: brackets ([ ]) not balanced");
    expect(await result(page, "grep -E 'a{2,1}' robots.txt")).toBe("grep: numbers out of order in {} quantifier");
    expect(await result(page, "grep")).toContain("usage: grep");
    expect(await result(page, "grep -r x ../")).toBe("grep: ../: Permission denied");
    expect(await result(page, "grep -o '' robots.txt")).toBe("");
    expect(await result(page, "grep -v '' robots.txt; echo $status")).toBe("1");
  });

  test("wc", async ({ page }) => {
    expect(await result(page, "wc robots.txt")).toMatch(/^\s+4\s+6\s+64 robots\.txt$/);
    expect(await result(page, "wc -l robots.txt .plan")).toMatch(/^\s+4 robots\.txt\n\s+6 \.plan\n\s+10 total$/);
    expect(await result(page, "echo héllo | wc -cm")).toMatch(/^\s+7\s+6$/);
    expect(await result(page, "echo hi | wc -w")).toMatch(/^\s+1$/);
    expect(await result(page, "zzqq '' | wc")).toContain("Unknown command");
    expect(await result(page, "wc nope")).toBe("wc: nope: No such file or directory");
    expect(await result(page, "echo -n | wc -l")).toMatch(/^\s+0$/);
  });

  test("tree", async ({ page }) => {
    expect(await result(page, "tree")).toBe(
      ".\n├── dependency.webp\n├── humans.txt\n├── index.html\n├── resume\n│   └── index.html\n├── robots.txt\n└── talks\n    └── index.html\n\n2 directories, 6 files",
    );
    expect(await result(page, "tree -a | head -2")).toBe(".\n├── .plan");
    expect(await result(page, "tree -d")).toBe(".\n├── resume\n└── talks\n\n2 directories");
    expect(await result(page, "tree -L 1 -F | tail -3")).toBe("└── talks/\n\n2 directories, 4 files");
    expect(await result(page, "tree talks")).toBe("talks\n└── index.html\n\n0 directories, 1 file");
    expect(await result(page, "tree nope")).toBe("nope [error opening dir]\n\n0 directories, 0 files");
    expect(await result(page, "tree ..")).toBe(".. [error opening dir]\n\n0 directories, 0 files");
    expect(await result(page, "tree -d talks")).toBe("talks\n\n0 directories");
    expect(await result(page, "tree resume | tail -1")).toBe("0 directories, 1 file");
  });

  test("file", async ({ page }) => {
    expect(await result(page, "file humans.txt talks index.html")).toBe(
      "humans.txt: ASCII text\ntalks: directory\nindex.html: HTML document text, Unicode text, UTF-8 text",
    );
    expect(await result(page, "file -b .plan")).toBe("ASCII text");
    expect(await result(page, "file nope ..")).toBe("nope: cannot open `nope' (No such file or directory)\n..: cannot open `..' (No such file or directory)");
    expect(await result(page, "file")).toContain("Usage: file");
  });

  test("stat", async ({ page }) => {
    expect(await result(page, "stat robots.txt")).toMatch(
      /^16777232 \d+ -rw-r--r-- 1 sferik staff 0 64 "\w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}" .* 4096 8 0 robots\.txt$/,
    );
    const verbose = await result(page, "stat -x talks");
    expect(verbose).toContain('File: "talks"');
    expect(verbose).toContain("FileType: Directory");
    expect(verbose).toContain("Mode: (0755/drwxr-xr-x)");
    expect(verbose).toContain("Links: 3");
    expect(await result(page, "stat -x .plan")).toContain("FileType: Regular File");
    expect(await result(page, "stat nope ..")).toBe("stat: nope: stat: No such file or directory\nstat: ..: stat: No such file or directory");
    expect(await result(page, "stat")).toContain("usage: stat");
  });

  test("cd", async ({ page }) => {
    expect(await result(page, "cd humans.txt")).toBe("cd: 'humans.txt' is not a directory");
    expect(await result(page, "cd nope")).toBe("cd: The directory 'nope' does not exist");
    expect(await result(page, "cd -")).toBe("");
  });
});

// ----------------------------------------------------------------- man

test("man sferik formats the resume as a man page", async ({ page }) => {
  const page1 = await result(page, "man sferik");
  expect(page1).toMatch(/^SFERIK\(1\)\s+General Commands Manual\s+SFERIK\(1\)\n\nNAME\n {7}sferik, Erik Berlin/);
  expect(page1).toContain("EXPERIENCE\n       2023–      Founder, One Thing Incorporated\n");
  expect(page1).toMatch(/\n {18}- Joined through the acquisition of Breaker/);
  expect(page1).toContain("OPEN SOURCE\n       - RubyGems.org:");
  expect(page1).toMatch(new RegExp(`sferik\\.net\\s+${new Date().toLocaleString("en-US", { month: "long", year: "numeric" })}\\s+SFERIK\\(1\\)$`));
  for (const line of page1.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  expect(await result(page, "man nope")).toBe("No manual entry for nope");
  expect(await result(page, "man")).toBe("What manual page do you want?\nFor example, try 'man man'.");
});

// ------------------------------------------------------------- network

test.describe("text tools", () => {
  test("sort: -r, -n, -u, -f, files, and nothing", async ({ page }) => {
    expect(await result(page, "echo -e 'b\\na\\nc' | sort")).toBe("a\nb\nc");
    expect(await result(page, "echo -e 'b\\na\\nc' | sort -r")).toBe("c\nb\na");
    expect(await result(page, "echo -ne 'b\\na' | sort")).toBe("a\nb"); // no newline at the end
    expect(await result(page, "echo -e '10\\n9\\nx\\n2' | sort -n")).toBe("x\n2\n9\n10");
    expect(await result(page, "echo -e '1 b\\n1 a' | sort -n")).toBe("1 a\n1 b");
    expect(await result(page, "echo -e 'b\\na\\nb\\na' | sort -u")).toBe("a\nb");
    expect(await result(page, "echo -e 'B\\na\\nC' | sort")).toBe("B\nC\na");
    expect(await result(page, "echo -e 'B\\na\\nC' | sort -f")).toBe("a\nB\nC");
    expect(await result(page, "echo -n | sort; echo $status")).toBe("0");
    expect(await result(page, "sort robots.txt")).toBe("\nAllow: /\nSitemap: https://sferik.net/sitemap.xml\nUser-agent: *");
    expect(await result(page, "sort nope; echo $status")).toBe("sort: nope: No such file or directory\n1");
  });

  test("uniq: -c, -d, -u", async ({ page }) => {
    const lines = "echo -e 'a\\na\\nb\\nc\\nc\\nc'";
    expect(await result(page, `${lines} | uniq`)).toBe("a\nb\nc");
    expect(await result(page, `${lines} | uniq -c`)).toBe("   2 a\n   1 b\n   3 c");
    expect(await result(page, `${lines} | uniq -d`)).toBe("a\nc");
    expect(await result(page, `${lines} | uniq -u`)).toBe("b");
    expect(await result(page, "echo -n | uniq; echo $status")).toBe("0");
  });

  test("cut: fields, ranges, delimiters, characters, and bad lists", async ({ page }) => {
    const rows = "echo -e 'a:b:c\\nd:e:f\\nno'";
    expect(await result(page, `${rows} | cut -d : -f 2`)).toBe("b\ne\nno");
    expect(await result(page, `${rows} | cut -s -d : -f 2`)).toBe("b\ne");
    expect(await result(page, `${rows} | cut -d : -f 1,3`)).toBe("a:c\nd:f\nno");
    expect(await result(page, `${rows} | cut -d : -f 2-`)).toBe("b:c\ne:f\nno");
    expect(await result(page, `${rows} | cut -d : -f -2`)).toBe("a:b\nd:e\nno");
    expect(await result(page, "echo -e 'a\\tb' | cut -f 2")).toBe("b");
    expect(await result(page, "echo hello | cut -c 1-3")).toBe("hel");
    expect(await result(page, "echo -n | cut -c 1; echo $status")).toBe("0");
    expect(await result(page, "cut; echo $status")).toBe("usage: cut -c list [file ...]\n       cut -f list [-s] [-d delim] [file ...]\n1");
    for (const list of ["x", "0", "-"]) expect(await result(page, `echo a | cut -f ${list}`)).toBe("cut: [-cf] list: illegal list value");
  });

  test("jq: paths, iteration, pipes, keys, length, -r, -c", async ({ page }) => {
    const json = `echo '{"b":2,"a":[1,2,{"x":"y"}]}'`;
    expect(await result(page, `${json} | jq`)).toBe('{\n  "b": 2,\n  "a": [\n    1,\n    2,\n    {\n      "x": "y"\n    }\n  ]\n}');
    expect(await result(page, `${json} | jq -c .`)).toBe('{"b":2,"a":[1,2,{"x":"y"}]}');
    expect(await result(page, `${json} | jq '.a[2].x'`)).toBe('"y"');
    expect(await result(page, `${json} | jq -r '.a[-1].x'`)).toBe("y");
    expect(await result(page, `${json} | jq -c '.a[]'`)).toBe('1\n2\n{"x":"y"}');
    expect(await result(page, `${json} | jq '.["b"]'`)).toBe("2");
    expect(await result(page, `${json} | jq '.a | length'`)).toBe("3");
    expect(await result(page, `${json} | jq -c 'keys'`)).toBe('["a","b"]');
    expect(await result(page, `${json} | jq -c '.a | keys'`)).toBe("[0,1,2]");
    expect(await result(page, `${json} | jq 'length'`)).toBe("2");
    expect(await result(page, `${json} | jq '.a[2].x | length'`)).toBe("1");
    expect(await result(page, `echo '[-5]' | jq '.[0] | length'`)).toBe("5");
    expect(await result(page, `${json} | jq '.nope | length'`)).toBe("0");
    expect(await result(page, `${json} | jq '.a[9]'`)).toBe("null");
    expect(await result(page, `${json} | jq '.nope.deeper'`)).toBe("null");
    expect(await result(page, `${json} | jq '.nope[0]'`)).toBe("null");
    expect(await result(page, `echo '{"a":1,"b":2}' | jq '.[]'`)).toBe("1\n2");
    expect(await result(page, "echo '[]' | jq '.[]'; echo $status")).toBe("0"); // nothing to print
  });

  test("jq: errors, like jq's", async ({ page }) => {
    const json = `echo '{"b":2,"a":[1]}'`;
    expect(await result(page, `${json} | jq '.a.x'; echo $status`)).toBe('jq: error (at <stdin>:0): Cannot index array with "x"\n5');
    expect(await result(page, `${json} | jq '.b[0]'`)).toBe("jq: error (at <stdin>:0): Cannot index number with number");
    expect(await result(page, `${json} | jq '.b[]'`)).toBe("jq: error (at <stdin>:0): Cannot iterate over number (2)");
    expect(await result(page, `${json} | jq '.nope[]'`)).toBe("jq: error (at <stdin>:0): Cannot iterate over null");
    expect(await result(page, `${json} | jq '.b | keys'`)).toBe("jq: error (at <stdin>:0): number (2) has no keys");
    expect(await result(page, "echo true | jq length")).toBe("jq: error (at <stdin>:0): boolean (true) has no length");
    expect(await result(page, `${json} | jq nope; echo $status`)).toContain("jq: 1 compile error\n3");
    expect(await result(page, `${json} | jq '. |'`)).toContain("an empty filter");
    expect(await result(page, `${json} | jq '..'`)).toContain('syntax error at "."');
    expect(await result(page, "echo nope | jq .; echo $status")).toBe("jq: error (at <stdin>:0): Cannot parse the input as JSON\n2");
  });
});

test.describe("network", () => {
  test("curl fetches the site's own pages under any of its domains", async ({ page }) => {
    expect(await result(page, "curl sferik.net/robots.txt")).toBe("User-agent: *\nAllow: /\n\nSitemap: https://sferik.net/sitemap.xml");
    expect(await result(page, "curl www.sferik.com/robots.txt")).toBe("User-agent: *\nAllow: /\n\nSitemap: https://sferik.net/sitemap.xml"); // the domains that redirect here are its own too
    expect(await result(page, "curl -s https://www.sferik.org/robots.txt")).toBe("User-agent: *\nAllow: /\n\nSitemap: https://sferik.net/sitemap.xml");
    const head = await result(page, "curl -I sferik.me/robots.txt");
    expect(head).toMatch(/^HTTP\/1\.1 200 OK\n/);
    expect(head).toContain("content-type: text/plain");
    const both = await result(page, "curl -i -H 'X-Test: 1' -A curl/8 -X GET sferik.net/robots.txt");
    expect(both).toMatch(/^HTTP\/1\.1 200 OK[\s\S]*\n\nUser-agent: \*/);
    expect(await result(page, "curl -I sferik.net/nope")).toMatch(/^HTTP\/1\.1 404 Not Found/);
  });

  test.describe(() => {
    // Plain HTTP is blocked by the Content-Security-Policy, as it is (as mixed content) on the real, HTTPS site.
    test.use({ expectBlocked: /http:\/\/blocked\.example\.com/ });
    test("curl talks to APIs that allow it, and fails like curl otherwise", async ({ page }) => {
      await page.route("https://api.example.com/teapot", (route) =>
        route.fulfill({ status: 418, body: "short and stout", headers: { "access-control-allow-origin": "*" } }),
      );
      expect(await result(page, "curl -i https://api.example.com/teapot")).toMatch(/^HTTP\/1\.1 418 [^\n]*\n[\s\S]*short and stout$/);
      expect(await result(page, "curl https://blocked.example.com/")).toBe(
        "curl: (7) Failed to connect to blocked.example.com port 443: Couldn't connect to server",
      );
      expect(await result(page, "curl http://blocked.example.com:8080/")).toContain("port 8080");
      expect(await result(page, "curl http://blocked.example.com/")).toContain("port 80:");
      expect(await result(page, "curl 'http://exa mple.com'")).toBe("curl: (3) URL rejected: Malformed input to a URL function");
      expect(await result(page, "curl")).toBe("curl: try 'curl --help' or 'curl --manual' for more information");
    });
  });

  test("curl won't dump the PDF resume into the terminal, unless told to", async ({ page }) => {
    expect(await result(page, "curl sferik.net/resume.pdf; echo $status")).toBe(
      'Warning: Binary output can mess up your terminal. Use "--output -" to tell\nWarning: curl to output it to your terminal anyway, or consider "--output\nWarning: <FILE>" to save to a file.\n23',
    );
    expect(await result(page, "curl -o - sferik.net/resume.pdf | head -c 8")).toBe("%PDF-1.4");
    expect(await result(page, "curl sferik.net/resume.pdf | head -c 8")).toBe("%PDF-1.4"); // into a pipe is fine
    expect(await result(page, "curl --output resume.pdf sferik.net/resume.pdf")).toBe(
      "Warning: Failed to open the file resume.pdf: Read-only file system\ncurl: (23) Failure writing output to destination",
    );
    expect(await result(page, "curl -H 'Accept: application/x-latex' sferik.net/resume | head -1")).toBe(
      "% Erik Berlin's resume, generated by sferik.net from https://sferik.net/resume.json",
    );
    expect(await result(page, "curl -I sferik.net/robots.txt | grep -c ^content-type")).toBe("1");
  });

  test("curl can be interrupted", async ({ page }) => {
    await page.route("https://slow.example.com/", () => {}); // never answers
    await start(page, "curl https://slow.example.com/");
    await field(page).press("Control+c");
    await done(page);
    await expect(page.locator(".repl-line .prompt")).toContainText("[130]");
  });

  test("gem list, info, and errors", async ({ page }) => {
    const list = await result(page, "gem list");
    expect(list).toMatch(/^\n\*\*\* LOCAL GEMS \*\*\*\n\n/);
    expect(list).toContain("multi_json (1.21.2)");
    expect(await result(page, "gem list ^multi")).toBe("\n*** LOCAL GEMS ***\n\nmulti_json (1.21.2)\nmulti_xml (0.9.1)");
    expect(await result(page, "gem list '('")).toContain("ERROR:  While executing gem ... (RegexpError)");
    await page.route("https://rubygems.org/api/v1/gems/multi_json.json", (route) =>
      route.fulfill({
        json: {
          name: "multi_json",
          version: "1.21.2",
          authors: "Michael Bleigh, Erik Berlin",
          homepage_uri: "https://github.com/sferik/multi_json",
          licenses: ["MIT"],
          downloads: 1170000000,
          info: "A common interface to multiple JSON libraries.",
        },
        headers: { "access-control-allow-origin": "*" },
      }),
    );
    const info = await result(page, "gem info multi_json");
    expect(info).toContain(
      "multi_json (1.21.2)\n    Authors: Michael Bleigh, Erik Berlin\n    Homepage: https://github.com/sferik/multi_json\n    License: MIT\n    Downloads: 1,170,000,000",
    );
    await page.route("https://rubygems.org/api/v1/gems/x.json", (route) =>
      route.fulfill({
        json: {
          name: "x",
          version: "1",
          authors: "Erik Berlin",
          project_uri: "https://rubygems.org/gems/x",
          licenses: ["MIT", "Apache-2.0"],
          downloads: 1,
          info: "X.",
        },
        headers: { "access-control-allow-origin": "*" },
      }),
    );
    expect(await result(page, "gem info x")).toContain("    Author: Erik Berlin\n    Homepage: https://rubygems.org/gems/x\n    Licenses: MIT, Apache-2.0");
    await page.route("https://rubygems.org/api/v1/gems/y.json", (route) =>
      route.fulfill({
        json: { name: "y", version: "1", authors: "A", homepage_uri: "h", licenses: null, downloads: 1, info: "Y." },
        headers: { "access-control-allow-origin": "*" },
      }),
    );
    expect(await result(page, "gem specification y")).toContain("License: N/A");
    await page.route("https://rubygems.org/api/v1/gems/nope.json", (route) => route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" } }));
    expect(await result(page, "gem info nope")).toBe("ERROR:  Could not find a valid gem 'nope' (>= 0) in any repository");
    expect(await result(page, "gem info")).toContain("Please specify at least one gem name");
    expect(await result(page, "gem --version")).toBe("4.0.0");
    expect(await result(page, "gem -v")).toBe("4.0.0");
    expect(await result(page, "gem")).toContain("RubyGems is a package manager for Ruby.");
    expect(await result(page, "gem frob")).toContain("Unknown command frob");
  });

  test("gh repo list, view, api, auth, browse", async ({ page }) => {
    const cors = { "access-control-allow-origin": "*" };
    await page.route("https://api.github.com/users/sferik", (route) =>
      route.fulfill({ json: { login: "sferik", public_repos: 218, followers: 2657 }, headers: cors }),
    );
    const repos = [
      { full_name: "sferik/x-ruby", description: "A Ruby interface to the X API.", fork: false, pushed_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
      {
        full_name: "sferik/jruby",
        description: "JRuby, an implementation of Ruby on the JVM, with a much longer description than fits",
        fork: true,
        pushed_at: new Date(Date.now() - 10e3).toISOString(),
      },
      { full_name: "sferik/empty", description: null, fork: false, pushed_at: new Date(Date.now() - 400 * 864e5).toISOString() },
    ];
    await page.route("https://api.github.com/users/sferik/repos?*", (route) => route.fulfill({ json: repos, headers: cors }));
    const list = await result(page, "gh repo list --limit 3");
    expect(list).toContain("Showing 3 of 218 repositories in @sferik");
    expect(list).toMatch(/NAME\s+DESCRIPTION\s+INFO\s+UPDATED/);
    expect(list).toContain("about 3 hours ago");
    expect(list).toContain("less than a minute ago");
    expect(list).toContain("about 1 year ago");
    expect(list).toContain("public, fork");
    expect(list).toContain("…");
    expect(await result(page, "gh repo list | head -1")).toMatch(/^sferik\/x-ruby\tA Ruby interface to the X API\.\tpublic\t/);
    expect(await result(page, "gh repo list | tail -1")).toMatch(/^sferik\/empty\t\tpublic\t/);
    await page.route("https://api.github.com/repos/sferik/x-ruby", (route) =>
      route.fulfill({
        json: { full_name: "sferik/x-ruby", description: "A Ruby interface to the X API.", html_url: "https://github.com/sferik/x-ruby" },
        headers: cors,
      }),
    );
    expect(await result(page, "gh repo view x-ruby")).toBe(
      "sferik/x-ruby\nA Ruby interface to the X API.\n\nView this repository on GitHub: https://github.com/sferik/x-ruby",
    );
    await page.route("https://api.github.com/repos/sferik/sferik-web", (route) =>
      route.fulfill({ json: { full_name: "sferik/sferik-web", description: null, html_url: "https://github.com/sferik/sferik-web" }, headers: cors }),
    );
    expect(await result(page, "gh repo view")).toContain("No description provided");
    expect(await result(page, "gh api /users/sferik | grep followers")).toBe('  "followers": 2657');
    await page.route("https://api.github.com/nope", (route) => route.fulfill({ status: 404, headers: cors }));
    expect(await result(page, "gh api nope")).toBe("gh: Not Found (HTTP 404)");
    await page.route("https://api.github.com/teapot", (route) => route.fulfill({ status: 418, headers: cors }));
    expect(await result(page, "gh api teapot")).toBe("gh: Request failed (HTTP 418)");
    await page.route("https://api.github.com/down", (route) => route.abort());
    expect(await result(page, "gh api down")).toBe("gh: Failed to fetch");
    expect(await result(page, "gh auth status")).toBe("You are not logged into any GitHub hosts. To log in, run: gh auth login");
    expect(await result(page, "gh")).toContain("Work seamlessly with GitHub from the command line.");
    const popup = page.waitForEvent("popup");
    await page.route("https://github.com/sferik", (route) => route.fulfill({ body: "ok" }));
    await sh(page, "gh browse");
    expect((await popup).url()).toBe("https://github.com/sferik");
  });
});

// ----------------------------------------------------------------- git

test.describe("git", () => {
  test("status, diff, branch, pull, commit, push, ls-files, version", async ({ page }) => {
    expect(await result(page, "git status")).toBe("On branch main\nnothing to commit, working tree clean");
    expect(await result(page, "git diff")).toBe("");
    expect(await result(page, "git branch")).toBe("* main");
    expect(await result(page, "git pull")).toBe("Already up to date.");
    expect(await result(page, "git commit -am wip; echo $status")).toBe("On branch main\nnothing to commit, working tree clean\n1");
    expect(await result(page, "git push")).toBe("Everything up-to-date");
    expect(await result(page, "git push -f")).toBe("Not on main, please.");
    expect(await result(page, "git ls-files")).toBe("name");
    expect(await result(page, "git --version")).toBe("git version 2.50.1 (Apple Git-155)");
    expect(await result(page, "git frob")).toBe("git: 'frob' is not a git command. See 'git --help'.");
  });

  test("log, show, blame, rev-parse", async ({ page }) => {
    expect(await result(page, "git log -1 | head -1")).toBe("commit 8c0d698bb6cb54346ac26a38f7056ee64dafd64d");
    expect(await result(page, "git log -n 1 | wc -l")).toMatch(/^\s+8$/);
    expect(await result(page, "git log --max-count=1 --oneline")).toBe("8c0d698 Rename Erik Michaels-Ober to Erik Berlin");
    expect(await result(page, "git log -p | tail -1")).toBe("+Erik Michaels-Ober");
    expect(await result(page, "git show main | head -1")).toBe("commit 8c0d698bb6cb54346ac26a38f7056ee64dafd64d");
    expect(await result(page, "git show 7773ccb")).toBe("Erik Berlin");
    expect(await result(page, "git show nope")).toContain("fatal: ambiguous argument 'nope'");
    expect(await result(page, "git blame name")).toBe("8c0d698b (Erik Berlin 2017-06-24 12:00:00 -0700 1) Erik Berlin");
    expect(await result(page, "git blame other")).toBe("fatal: no such path 'other' in HEAD");
    expect(await result(page, "git rev-parse HEAD")).toBe("8c0d698bb6cb54346ac26a38f7056ee64dafd64d");
    expect(await result(page, "git rev-parse HEAD^{tree}")).toBe("bc3ab1c46d0172ec14dbc270c0f20214af1b98cd");
    expect(await result(page, "git rev-parse nope")).toContain("fatal: ambiguous argument 'nope'");
    expect(await result(page, "git rev-parse nope^{tree}")).toContain("fatal: ambiguous argument");
  });

  test("the objects behind the hashes", async ({ page }) => {
    expect(await result(page, "git cat-file -p HEAD | head -2")).toBe(
      "tree bc3ab1c46d0172ec14dbc270c0f20214af1b98cd\nparent 33b9c3d44e0f69f2df1bd2c805ffd9e5da227f3c",
    );
    expect(await result(page, "git cat-file -p bc3ab1c")).toBe("100644 blob 7773ccb2f816421e6fc3471201700290f7daef8d\tname");
    expect(await result(page, "git cat-file -t 7773ccb")).toBe("blob");
    expect(await result(page, "git cat-file -s 7773ccb")).toBe("12");
    expect(await result(page, "git cat-file -p nope")).toBe("fatal: Not a valid object name nope");
    expect(await result(page, "git ls-tree HEAD^")).toBe("100644 blob 5116d79aff7ce5ae9dc842ff677548a23dc48f78\tname");
    expect(await result(page, "git ls-tree")).toBe("100644 blob 7773ccb2f816421e6fc3471201700290f7daef8d\tname");
    expect(await result(page, "git ls-tree nope")).toBe("fatal: Not a valid object name nope");
  });

  test("hash-object computes real SHA-1s", async ({ page }) => {
    expect(await result(page, 'echo "Erik Berlin" | git hash-object --stdin')).toBe("7773ccb2f816421e6fc3471201700290f7daef8d");
    expect(await result(page, "git cat-file -p HEAD | git hash-object -t commit --stdin")).toBe("8c0d698bb6cb54346ac26a38f7056ee64dafd64d");
    expect(await result(page, "git hash-object robots.txt")).toMatch(/^[0-9a-f]{40}$/);
    expect(await result(page, "git hash-object")).toContain("usage: git hash-object");
  });
});

// ------------------------------------------------------- who's logged in

test.describe("write and imgcat", () => {
  test("write sferik sends what you type, after Ctrl-D, saying which terminal it's from", async ({ page }) => {
    let sent: { url: string; body: string | null } | undefined;
    await page.route("**/write?*", (route) => {
      sent = { url: route.request().url(), body: route.request().postData() };
      return route.fulfill({ status: 202, body: "write: message sent to sferik\n" });
    });
    await start(page, "write sferik");
    await expect(log(page)).toContainText("Type your message, then Ctrl-D to send it");
    await type(page, "Hello there.");
    await type(page, "me@example.com");
    await field(page).press("Control+d");
    await done(page);
    expect(await out(page)).toMatch(/\nwrite: message sent to sferik$/);
    expect(sent!.body).toBe("Hello there.\nme@example.com\n");
    expect(sent!.url).toMatch(/\/write\?tty=ttys\d{3}$/);
  });

  test("write takes a message piped in, and says what went wrong", async ({ page }) => {
    await page.route("**/write?*", (route) => route.fulfill({ status: 429, body: "write: one message a minute, please\n" }));
    expect(await result(page, "echo hi | write sferik; echo $status")).toBe("write: one message a minute, please\n1");
    expect(await result(page, "write")).toBe("usage: write user [tty]");
    expect(await result(page, "write root")).toBe("write: root is not logged in");
    expect(await result(page, "echo | write sferik")).toBe("write: nothing to send");
    await page.unroute("**/write?*");
    await page.route("**/write?*", (route) => route.abort());
    expect(await result(page, "echo hi | write sferik")).toBe("write: sferik.net can't be reached, so nothing was sent");
  });

  test("imgcat shows the comic, and says what isn't an image", async ({ page }) => {
    expect(await result(page, "imgcat")).toBe("usage: imgcat file ...");
    expect(await result(page, "imgcat humans.txt nope; echo $status")).toBe("imgcat: humans.txt: not an image\nimgcat: nope: No such file or directory\n1");
    await sh(page, "imgcat dependency.webp humans.txt");
    await expect(log(page).locator("figure.xkcd")).toHaveCount(1);
    expect(await result(page, "file dependency.webp")).toBe("dependency.webp: RIFF (little-endian) data, Web/P image");
  });
});

test.describe("who, w, last", () => {
  test("who and w list everyone reading the site, a terminal per tab", async ({ page, context }) => {
    // This tab, and another on the talks page.
    const other = await context.newPage();
    await other.goto("/talks");
    await expect.poll(async () => (await result(page, "who")).split("\n").length).toBeGreaterThan(1);
    const me = (await result(page, "who am i")).match(/^sferik {3}(ttys\d{3}) {6}\w{3} [ \d]\d \d\d:\d\d$/)![1];
    expect(await result(page, "who")).toMatch(new RegExp(`^sferik {3}${me} {6}`, "m"));
    const w = await result(page, "w");
    expect(w).toMatch(/^\d\d:\d\d {2}up [\d,]+ days, \d+ users, load averages:/);
    expect(w).toContain("USER     TTY      FROM    LOGIN@  IDLE WHAT");
    expect(w).toMatch(new RegExp(`^sferik {3}${me.slice(3)} {5}- {7}\\d\\d:\\d\\d {6}- w$`, "m"));
    expect(w).toMatch(/^sferik {3}s\d{3} {5}- {7}\d\d:\d\d {6}- ls -lt ~\/talks$/m);
  });

  test("who and w, from what the site says: idle terminals, and one user", async ({ page }) => {
    const login = new Date(Date.now() - 3600e3).toISOString();
    await page.route(/\/who\?/, (route) =>
      route.fulfill({
        json: {
          you: "ttys001",
          users: [
            { tty: "ttys000", page: "/resume", login, idle: 150 },
            { tty: "ttys001", page: "/", login, idle: 0 },
            { tty: "ttys002", page: "/", login, idle: 0 },
          ],
        },
      }),
    );
    const w = (await result(page, "w")).split("\n");
    expect(w[0]).toContain(" 3 users,");
    expect(w[2]).toMatch(/^sferik {3}s000 .* {4}2 man sferik$/);
    expect(w[4]).toMatch(/ -fish$/);
    await page.unroute(/\/who\?/);
    // With no terminal free (or the site out of reach), it's just you.
    await page.route(/\/who\?/, (route) => route.fulfill({ json: { you: null, users: [] } }));
    expect(await result(page, "uptime")).toMatch(/ 1 user, /);
    await page.unroute(/\/who\?/);
    await page.route(/\/who\?/, (route) => route.abort());
    expect(await result(page, "who")).toMatch(/^sferik {3}ttys000 {6}\w{3} [ \d]\d \d\d:\d\d$/);
  });

  test("last lists this browser's earlier visits", async ({ page }) => {
    const start = new Date(2026, 8, 30, 9, 15).getTime();
    await page.addInitScript((s) => localStorage.setItem("visits", JSON.stringify([{ start: s, end: s + 75 * 60e3 }])), start);
    await page.reload();
    const last = await result(page, "last");
    expect(last).toMatch(/^sferik {4}ttys000\s+\w{3} \w{3} [ \d]\d \d\d:\d\d {3}still logged in\n/);
    expect(last).toContain("Wed Sep 30 09:15 - 10:30  (01:15)");
    expect(last).toMatch(/wtmp begins Wed Sep 30 09:15$/);
  });

  test("last still works without storage", async ({ page }) => {
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw new DOMException("blocked", "SecurityError");
      };
      Storage.prototype.setItem = Storage.prototype.getItem;
    });
    await page.reload();
    expect(await result(page, "last")).toMatch(/still logged in\n\nwtmp begins/);
  });
});

// --------------------------------------------------------------- macOS

test.describe("macOS", () => {
  const stubSpeech = () => {
    window.spoken = [];
    const synth = {
      getVoices: () => [
        { name: "Samantha", lang: "en-US" },
        { name: "Daniel", lang: "en-GB" },
      ],
      speak: (u: SpeechSynthesisUtterance) => {
        window.spoken.push({ text: u.text, rate: u.rate, voice: u.voice?.name });
        if (!u.text.includes("forever")) setTimeout(() => u.onend!(new Event("end") as SpeechSynthesisEvent), 10);
      },
      cancel: () => window.spoken.push("cancel"),
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    window.SpeechSynthesisUtterance = function (this: { text: string; rate: number }, text: string) {
      this.text = text;
      this.rate = 1;
    } as unknown as typeof SpeechSynthesisUtterance;
  };

  test("say speaks, with voices and rates", async ({ page }) => {
    await page.addInitScript(stubSpeech);
    await page.reload();
    await sh(page, "say -v daniel -r 350 hello there");
    await sh(page, "echo from a pipe | say");
    expect(await page.evaluate(() => window.spoken)).toEqual([
      { text: "hello there", rate: 2, voice: "Daniel" },
      { text: "from a pipe\n", rate: 1 },
    ]);
    expect(await result(page, "say -v '?'")).toBe(
      "Samantha             en_US   # Hello! My name is Samantha.\nDaniel               en_GB   # Hello! My name is Daniel.",
    );
    expect(await result(page, "say -v Zarvox hi")).toBe("Voice `Zarvox' not found.");
    expect(await result(page, "say -o out.aiff hi")).toBe("say: Could not open output file out.aiff: Read-only file system");
    await start(page, "say forever");
    await field(page).press("Control+c");
    await done(page);
    expect(await page.evaluate(() => window.spoken.at(-1))).toBe("cancel");
  });

  test("say without speech synthesis", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true }));
    await page.reload();
    expect(await result(page, "say hi")).toBe("say: speech synthesis isn't available in this browser");
  });

  test("say -v ? with no voices", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(window, "speechSynthesis", { value: { getVoices: () => [] }, configurable: true }));
    await page.reload();
    expect(await result(page, "say -v '?'")).toBe("");
  });

  test("pbcopy and pbpaste use the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await sh(page, "echo sferik@gmail.com | pbcopy");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("sferik@gmail.com\n");
    expect(await result(page, "pbpaste")).toBe("sferik@gmail.com");
  });

  test("pbpaste with an empty clipboard prints nothing", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { readText: async () => "" } }));
    await page.reload();
    expect(await result(page, "pbpaste")).toBe("");
  });

  test("pbcopy and pbpaste without a clipboard", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new Error("no")), readText: () => Promise.reject(new Error("no")) },
      });
    });
    await page.reload();
    expect(await result(page, "echo x | pbcopy")).toBe("pbcopy: the clipboard isn't available");
    expect(await result(page, "pbpaste")).toBe("pbpaste: the clipboard isn't available");
  });

  test("caffeinate holds a wake lock until Ctrl-C, -t, or its command finishes", async ({ page }) => {
    await page.addInitScript(() => {
      window.locks = [];
      Object.defineProperty(navigator, "wakeLock", {
        value: { request: async (type: string) => (window.locks.push(type), { release: async () => window.locks.push("released") }) },
      });
    });
    await page.reload();
    await start(page, "caffeinate -d");
    await field(page).press("Control+c");
    await done(page);
    expect(await page.evaluate(() => window.locks)).toEqual(["screen", "released"]);
    await sh(page, "caffeinate -t 0.05");
    expect(await result(page, "caffeinate echo awake")).toBe("awake");
    expect(await result(page, "caffeinate false; echo $status")).toBe("1");
  });

  test("Ctrl-C while caffeinate is still waiting for its wake lock", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "wakeLock", {
        value: { request: () => new Promise((r) => setTimeout(() => r({ release: async () => {} }), 300)) },
      });
    });
    await page.reload();
    await start(page, "caffeinate");
    await field(page).press("Control+c");
    await done(page);
    await expect(page.locator(".repl-line .prompt")).toContainText("[130]");
  });

  test("caffeinate works without the wake lock API", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "wakeLock", { value: { request: () => Promise.reject(new Error("denied")) } });
    });
    await page.reload();
    await sh(page, "caffeinate -t 0.01");
    await expect(page.locator(".repl-line .prompt")).toHaveText("sferik@mbp ~> ");
  });

  test("shutdown, halt, sudo", async ({ page }) => {
    expect(await result(page, "shutdown -h now")).toBe("shutdown: NOT super-user");
    expect(await result(page, "halt")).toBe("halt: Operation not permitted");
    expect(await result(page, "sudo shutdown -h now")).toBe("sferik is not in the sudoers file. This incident will be reported.");
  });

  test("reboot reloads the page", async ({ page }) => {
    // Answer the reload with 204 No Content, which leaves the page as it is
    // (and its coverage with it).
    const reloads: string[] = [];
    await page.route(
      (url) => url.pathname === "/",
      (route) => {
        reloads.push(route.request().url());
        return route.fulfill({ status: 204 });
      },
    );
    await sh(page, "reboot");
    await expect.poll(() => reloads).toEqual([page.url()]);
  });
});

// ---------------------------------------------------------------- time

test.describe("date and cal", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 9, 1, 14, 5, 9));
    await page.reload();
  });

  test("date formats", async ({ page }) => {
    expect(await result(page, "date")).toMatch(/^Thu Oct {2}1 14:05:09 \S+ 2026$/);
    expect(await result(page, "date +%Y-%m-%d")).toBe("2026-10-01");
    expect(await result(page, "date '+%a %A %b %h %B %d %e %H %I %j %k %l %m %M %p %S %u %w %y %%'")).toBe(
      "Thu Thursday Oct Oct October 01  1 14 02 274 14  2 10 05 PM 09 4 4 26 %",
    );
    expect(await result(page, "date '+%D|%F|%R|%T|%r|%c'")).toBe("10/01/26|2026-10-01|14:05|14:05:09|02:05:09 PM|Thu Oct  1 14:05:09 2026");
    expect(await result(page, "date '+%n%t%q'")).toBe("\n\t%q");
    expect(await result(page, "date -u +%Z")).toBe("UTC");
    expect(await result(page, "date -u +%z")).toBe("+0000");
    expect(await result(page, "date +%z")).toMatch(/^[+-]\d{4}$/);
    expect(await result(page, "date -r 0 -u")).toBe("Thu Jan  1 00:00:00 UTC 1970");
    expect(await result(page, "date -r 0 -u +%s")).toBe("0");
    expect(await result(page, "date -R -u")).toMatch(/^Thu, 01 Oct 2026 \d\d:05:09 \+0000$/);
    expect(await result(page, "date -r nope")).toContain("date: illegal time format");
    // 1700000000 is Tue Nov 14 2023 22:13:20 UTC
    expect(await result(page, "date -r 1700000000 -u '+%u %I %p %l'")).toBe("2 10 PM 10");
    expect(await result(page, "date -r 1699920000 -u '+%u %I %p %l %k'")).toBe("2 12 AM 12  0");
    expect(await result(page, "date -r 1700352000 -u +%u")).toBe("7");
  });

  test("cal: this month, a given month, -3, -y, a year, -h", async ({ page }) => {
    const oct = await result(page, "cal");
    expect(oct).toMatch(/^ {4}October 2026\s*\nSu Mo Tu We Th Fr Sa\n {13}1 {2}2 {2}3\n 4 {2}5/);
    await expect(log(page).locator(".cal-today").last()).toHaveText(" 1");
    expect(await result(page, "cal 2 2024")).toContain("29");
    expect(await result(page, "cal -h")).toContain("October 2026");
    expect(await result(page, "cal -m 12")).toContain("December 2026");
    const three = await result(page, "cal -3");
    expect(three).toMatch(/September 2026\s+October 2026\s+November 2026/);
    const year = await result(page, "cal -y");
    expect(year).toMatch(/^ {29}2026\n\n\s+January\s+February\s+March/);
    expect(await result(page, "cal 2027 | head -1")).toBe(" ".repeat(29) + "2027");
    expect(await result(page, "cal 13 2026")).toBe("cal: 13 is neither a month number (1..12) nor a name");
    expect(await result(page, "cal june")).toBe("cal: june is neither a month number (1..12) nor a name");
  });
});

// ---------------------------------------------------------------- toys

test.describe("toys", () => {
  test("cowsay and cowthink", async ({ page }) => {
    expect(await result(page, "cowsay moo")).toBe(
      " _____\n< moo >\n -----\n        \\   ^__^\n         \\  (oo)\\_______\n            (__)\\       )\\/\\\n                ||----w |\n                ||     ||",
    );
    const long = await result(page, "cowsay -W 10 one two three four");
    expect(long).toContain("/ one two \\\n| three   |\n\\ four    /");
    expect(await result(page, "cowthink -e ^^ -T U hmm")).toContain("( hmm )\n -----\n        o   ^__^\n         o  (^^)\\_______");
    expect(await result(page, "cowsay -d dead")).toContain("(XX)");
    expect(await result(page, "cowsay -d dead")).toContain(" U  ||----w |");
    expect(await result(page, "echo -e 'a\\nb' | cowsay -n")).toContain("/ a \\\n\\ b /");
    expect(await result(page, "cowsay -g rich")).toContain("($$)");
  });

  test("fortune", async ({ page }) => {
    await page.addInitScript(() => (Math.random = () => 0));
    await page.reload();
    expect(await result(page, "fortune")).toBe("Premature optimization is the root of all evil.\n\t\t-- Donald Knuth");
    expect(await result(page, "fortune -l")).toContain("Debugging is twice as hard");
    expect(await result(page, "fortune -c -s")).toMatch(/^\(computers\)\n%\nPremature/);
  });

  test("figlet: smushing, kerning, full width, alignment, wrapping", async ({ page }) => {
    expect(await result(page, "figlet Erik")).toBe("  _____      _ _\n | ____|_ __(_) | __\n |  _| | '__| | |/ /\n | |___| |  | |   <\n |_____|_|  |_|_|\\_\\");
    expect(await result(page, "figlet -k Erik | head -1")).toBe("  _____        _  _");
    expect(await result(page, "figlet -W hi | head -1")).toBe("  _       _");
    expect(await result(page, "figlet -c -w 40 hi | head -1")).toMatch(/^ {15,}_/);
    expect(await result(page, "figlet -r -w 40 hi | head -1")).toMatch(/^ {30,}_/);
    expect((await result(page, "figlet -w 20 wrapping")).split("\n").length).toBeGreaterThan(6);
    expect(await result(page, "echo é | figlet | head -2")).toBe("  ___\n |__ \\");
    expect(await result(page, "figlet -f banner hi")).toBe("figlet: banner: Unable to open font file");
    expect(await result(page, "figlet -l '[]' | head -2")).toBe("  __ __\n | _|_ |");
  });

  test("figlet reports a missing font file", async ({ page }) => {
    await page.route("**/share/standard.flf", (route) => route.abort());
    expect(await result(page, "figlet hi")).toBe("figlet: Failed to fetch");
    await page.unroute("**/share/standard.flf");
    expect(await result(page, "figlet hi | wc -l")).toMatch(/^\s+5$/);
  });

  test("banner prints big letters sideways", async ({ page }) => {
    const big = await result(page, "banner -w 40 I");
    expect(big).toMatch(/#{10,}/);
    expect(await result(page, "echo hi | banner -w 20")).toContain("#");
  });

  test("sl drives a train across, and ignores Ctrl-C unless -e", async ({ page }) => {
    await page.clock.install();
    await page.reload();
    await start(page, "sl");
    await expect(page.locator("pre.sl")).toBeVisible();
    await field(page).press("Control+c"); // ignored, like the real thing
    await page.clock.runFor(1000);
    await expect(page.locator("pre.sl")).toContainText("___");
    await page.clock.runFor(5000);
    await done(page);
    await expect(page.locator("pre.sl")).toHaveCount(0);
    await start(page, "sl -e -l");
    await field(page).press("Control+c");
    await done(page);
  });

  test("sl with reduced motion shows the train standing still", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await sh(page, "sl");
    await expect(page.locator("pre.sl")).toContainText("____Y___________|__");
  });

  test("yes repeats its argument", async ({ page }) => {
    expect(await result(page, "yes no | head -2")).toBe("no\nno");
  });

  test("ping counts, waits, and summarizes on Ctrl-C", async ({ page }) => {
    const once = await result(page, "ping -c 1 -q");
    expect(once).toMatch(
      /^PING sferik\.net \(sferik\.net\): 56 data bytes\n\n--- sferik\.net ping statistics ---\n1 packets transmitted, 1 packets received, 0\.0% packet loss\nround-trip min\/avg\/max\/stddev = [\d.]+\/[\d.]+\/[\d.]+\/0\.000 ms$/,
    );
    expect(await result(page, "ping -c 2 -i 0.01 example.com")).toMatch(/icmp_seq=1 ttl=64/);
    await start(page, "ping -i 10");
    await expect(log(page)).toContainText("from sferik.net: icmp_seq=0"); // not the example.com run above
    await field(page).press("Control+c");
    await done(page);
    expect(await out(page)).toMatch(/\^C\n\n--- sferik\.net ping statistics ---\n1 packets transmitted/);
    await page.route("**/robots.txt?ping=*", () => {}); // never answers
    await start(page, "ping");
    await field(page).press("Control+c");
    await done(page);
    expect(await out(page)).toMatch(/0 packets transmitted, 0 packets received, 0\.0% packet loss$/);
  });
});

// ------------------------------------------------------------ the rest

test.describe("everything else", () => {
  test("help, history, clear, whoami, finger, uname, matrix", async ({ page }) => {
    await page.goto("/nope"); // a shell with no history yet
    expect(await result(page, "help")).toContain("man sferik      the resume, as a man page");
    expect(await result(page, "history")).toBe("help");
    expect(await result(page, "uname -a")).toContain("Darwin mbp 27.0.0");
    expect(await result(page, "whoami | head -1")).toContain("I've spent nearly two decades");
    await sh(page, "clear");
    expect(await result(page, "history | head -1")).toBe("clear");
  });

  test("help explains any command, -a lists them all, and man has a page for each", async ({ page }) => {
    expect((await result(page, "help")).split("\n").at(-1)).toBe("  clear           clear the screen");
    expect(await result(page, "help env")).toBe("usage: env\n\nList the exported environment variables.");
    expect(await result(page, "help nope; echo $status")).toBe("help: no help for nope. help -a lists every command.\n1");
    const all = await result(page, "help -a");
    for (const name of ["env", "set", "cal", "qr", "logout", "?"]) expect(all).toMatch(new RegExp(`^  ${name.replace("?", "\\?")} +\\S`, "m"));
    expect(all.split("\n")).toHaveLength(77);
    for (const line of all.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
    expect(await result(page, "man cal")).toBe(
      [
        "CAL(1)                      General Commands Manual                       CAL(1)",
        "",
        "NAME",
        "     cal – show a calendar: this month, three months (-3), or a year (-y)",
        "",
        "SYNOPSIS",
        "     cal [-3hy] [-m month] [[month] year]",
        "",
        "DESCRIPTION",
        "     Show a calendar: this month, three months (-3), or a year (-y).",
      ].join("\n"),
    );
    expect(await result(page, "man nope")).toBe("No manual entry for nope");
  });

  test("finger --vcard saves a contact card", async ({ page }) => {
    const download = page.waitForEvent("download");
    expect(await result(page, "finger --vcard")).toBe("Saved erik-berlin.vcf");
    const file = await download;
    expect(file.suggestedFilename()).toBe("erik-berlin.vcf");
    const card = (await (await file.createReadStream()).toArray()).join("");
    expect(card).toMatch(
      /^BEGIN:VCARD\r\nVERSION:3\.0\r\nN:Berlin;Erik;;;\r\nFN:Erik Berlin\r\nEMAIL;TYPE=INTERNET:sferik@gmail\.com\r\nTEL;TYPE=CELL:\+1 415-312-2382\r\nURL:https:\/\/sferik\.net\r\nNICKNAME:sferik\r\nBDAY:1983-11-24\r\n/,
    );
    expect(card).toContain("X-SOCIALPROFILE;TYPE=github:https://github.com/sferik\r\n");
    expect(card).toMatch(/END:VCARD\r\n$/);
    // Lines longer than 75 characters fold onto the next, after a space.
    expect(card.split("\r\n").every((line) => line.length <= 75)).toBe(true);
    expect(card).toContain("X-SOCIALPROFILE;TYPE=ycombinator:https://www.ycombinator.com/verify/qugse5l\r\n o7rvb3xe7");
  });

  test("qr shows a QR code of my contact card, or of any text", async ({ page }) => {
    await sh(page, "qr");
    const code = page.locator(".repl-log pre.qr").last();
    await expect(code).toHaveAttribute("aria-label", "A QR code of my contact card");
    // Version 9 (164 bytes): 53 modules square, two rows to a line.
    const rows = (await code.textContent())!.split("\n");
    expect(rows).toHaveLength(27);
    expect(rows.every((row) => row.length === 53)).toBe(true);
    expect(rows[0].startsWith("█▀▀▀▀▀█")).toBe(true);
    await sh(page, "qr hi");
    await expect(page.locator(".repl-log pre.qr").last()).toHaveAttribute("aria-label", "A QR code of hi");
    await sh(page, "echo piped | qr");
    await expect(page.locator(".repl-log pre.qr").last()).toHaveAttribute("aria-label", "A QR code of piped");
    expect(await result(page, `qr ${"x".repeat(181)}; echo $status`)).toBe("qr: 181 bytes is too long; the most is 180\n1");
  });

  test("qr's code is black on white, and white on black in dark mode", async ({ page }) => {
    await sh(page, "qr hi");
    await expect(page.locator("pre.qr")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("pre.qr")).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(page.locator("pre.qr")).toHaveCSS("color", "rgb(255, 255, 255)");
  });

  test("version prints the deployed commit and a link to it, or says it's a local copy", async ({ page }) => {
    expect(await result(page, "version")).toBe("sferik.net, a local copy (not deployed)");
    await page.route("**/version", (route) =>
      route.fulfill({
        json: {
          commit: "6cc43d0aa1b2c3d4",
          deployed: new Date(Date.now() - 2 * 3600e3).toISOString(),
          url: "https://github.com/sferik/sferik-web/commit/6cc43d0aa1b2c3d4",
        },
      }),
    );
    expect(await result(page, "version")).toBe("sferik.net 6cc43d0, deployed about 2 hours ago\nhttps://github.com/sferik/sferik-web/commit/6cc43d0aa1b2c3d4");
    await expect(page.locator('.repl-log a[href="https://github.com/sferik/sferik-web/commit/6cc43d0aa1b2c3d4"]')).toBeVisible();
  });

  test("share copies a link that runs the last command", async ({ page, context }) => {
    await page.goto("/nope"); // a shell with no history yet
    expect(await result(page, "share")).toBe("share: there's nothing to share yet. Run a command first.");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await sh(page, "man cal");
    const link = `${new URL(page.url()).origin}/?run=man+cal`;
    expect(await result(page, "share")).toBe(`Copied a link that runs man cal:\n${link}`);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    // Sharing again shares the same command, not share.
    expect(await result(page, "share")).toBe(`Copied a link that runs man cal:\n${link}`);
    await expect(page.locator(`.repl-log a[href="${link}"]`).last()).toBeVisible();
  });

  test("share without a clipboard still shows the link", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no")) } }));
    await page.reload();
    await sh(page, "whoami");
    expect(await result(page, "share")).toBe(`A link that runs whoami:\n${new URL(page.url()).origin}/?run=whoami`);
  });

  test("mentions lists the latest webmentions, or says there are none", async ({ page }) => {
    const mentions = (children: object[]) => (route: import("@playwright/test").Route) => route.fulfill({ json: { type: "feed", children } });
    await page.route(
      /webmention\.io\/api\/mentions\.jf2/,
      mentions([
        {
          published: "2026-10-04T12:00:00Z",
          "wm-received": "2026-10-04T12:01:00Z",
          author: { name: "Ada" },
          "wm-property": "like-of",
          url: "https://example.com/1",
        },
        { "wm-received": "2026-10-03T09:00:00Z", author: { name: "" }, "wm-property": "in-reply-to", url: "https://example.com/2" },
        { "wm-received": "2026-10-02T09:00:00Z", "wm-property": "mention-of", url: "https://example.com/3" },
      ]),
    );
    expect(await result(page, "mentions")).toBe(
      [
        "2026-10-04  Ada liked it: https://example.com/1",
        "2026-10-03  someone replied to it: https://example.com/2",
        "2026-10-02  someone mentioned it: https://example.com/3",
      ].join("\n"),
    );
    await page.unroute(/webmention\.io/);
    await page.route(/webmention\.io\/api\/mentions\.jf2/, mentions([]));
    expect(await result(page, "mentions")).toBe("No webmentions yet.");
    await page.unroute(/webmention\.io/);
    await page.route(/webmention\.io/, (route) => route.abort());
    expect(await result(page, "mentions; echo $status")).toBe("mentions: couldn't reach webmention.io\n1");
  });

  test("mentions stops on Ctrl-C", async ({ page }) => {
    await page.route(/webmention\.io/, () => {}); // never answers
    await start(page, "mentions");
    await field(page).press("Control+c");
    await done(page);
    await expect(page.locator(".repl-line .prompt")).toHaveText("sferik@mbp ~ [130]> ");
  });

  test("printf: formats, escapes, and no newline", async ({ page }) => {
    expect(await result(page, "printf '%s is %d%%\\n' disk 42.7")).toBe("disk is 42%");
    expect(await result(page, "printf 'a\\tb\\\\c %s|%d'")).toBe("a\tb\\c |0");
    expect(await result(page, "printf '%d' nope")).toBe("0");
    expect(await result(page, "printf 'x\\by'")).toBe("x\by");
    expect(await result(page, "printf ''; echo $status")).toBe("0");
    expect(await result(page, "printf; echo $status")).toBe("printf: Expected at least 1 args, got only 0\n2");
  });

  test("share shares a given command line", async ({ page }) => {
    expect(await result(page, "share man cal")).toMatch(new RegExp(`^(Copied a|A) link that runs man cal:\\n${new URL(page.url()).origin}/\\?run=man\\+cal$`));
  });

  test("history is empty at first", async ({ page }) => {
    await page.goto("/nope"); // the home page's commands are history; the 404 page runs none
    expect(await result(page, "history")).toBe("");
  });

  test("finger without a contact section", async ({ page }) => {
    await page.goto("/missing");
    expect(await result(page, "finger | head -1")).toMatch(/^Login: sferik\s+Name: Erik Berlin$/);
  });

  test("open goes to files and directories", async ({ page }) => {
    await page.route("**/robots.txt", (route) => (route.request().isNavigationRequest() ? route.fulfill({ status: 204 }) : route.fallback()));
    const nav = page.waitForRequest((r) => r.isNavigationRequest() && r.url().endsWith("/robots.txt"));
    await sh(page, "open robots.txt");
    await nav;
    expect(await result(page, "open ../x")).toBe("The file /Users/sferik/../x does not exist.");
  });
});

// ------------------------------------------------------------- editing

test.describe("editing", () => {
  test("highlighting: commands, unknown commands, quotes, operators", async ({ page }) => {
    await field(page).fill("cat 'a b' | nope \"c\" && ls ; echo");
    await expect(page.locator(".echo .hl-cmd")).toHaveText(["cat", "ls", "echo"]);
    await expect(page.locator(".echo .hl-err")).toHaveText("nope");
    await expect(page.locator(".echo .hl-quote")).toHaveText(["'a b'", '"c"']);
    await expect(page.locator(".echo .hl-op")).toHaveText(["|", "&&", ";"]);
  });

  test("tab completes paths, nested paths, and subcommands", async ({ page }) => {
    const tab = async (value: string) => {
      await field(page).fill(value);
      await field(page).press("Tab");
    };
    await tab("cat talks/i");
    await expect(field(page)).toHaveValue("cat talks/index.html ");
    await tab("ls ~/re");
    await expect(field(page)).toHaveValue("ls ~/resume/");
    await tab("echo hi | gre");
    await expect(field(page)).toHaveValue("echo hi | grep ");
    await tab("man sf");
    await expect(field(page)).toHaveValue("man sferik ");
    await tab("git ca");
    await expect(field(page)).toHaveValue("git cat-file ");
    await tab("git show 77");
    await tab("git show 8c");
    await expect(field(page)).toHaveValue("git show 8c0d698 ");
    await tab("gem in");
    await expect(field(page)).toHaveValue("gem info ");
    await tab("gem info multi_j");
    await expect(field(page)).toHaveValue("gem info multi_json ");
    await tab("gh re");
    await expect(field(page)).toHaveValue("gh repo ");
    await tab("gh repo vi");
    await expect(field(page)).toHaveValue("gh repo view ");
    await tab("cat ../");
    await expect(field(page)).toHaveValue("cat ../");
    await tab("cat robots.txt/");
    await expect(field(page)).toHaveValue("cat robots.txt/");
  });
});

// -------------------------------------------------------- the long tail

test.describe("less common paths", () => {
  test("input without a trailing newline, --, and odd escapes", async ({ page }) => {
    expect(await result(page, "echo -n abc | grep b")).toBe("abc");
    expect(await result(page, "echo -n abc | tail -1")).toBe("abc");
    expect(await result(page, "cat -- robots.txt | head -1")).toBe("User-agent: *");
    expect(await result(page, 'echo "cost $ 5" "end $"')).toBe("cost $ 5 end $");
    expect(await result(page, "echo $ x")).toBe("$ x");
    expect(await result(page, "echo $")).toBe("$");
    expect(await result(page, 'echo "open $')).toContain("quotes are not balanced");
    expect(await result(page, "echo trailing\\")).toBe("trailing");
    expect(await result(page, "grep 'z*' robots.txt | wc -l")).toMatch(/^\s+4$/);
    expect(await result(page, "grep '\\.' robots.txt")).toBe("Sitemap: https://sferik.net/sitemap.xml");
    expect(await result(page, "grep 'x\\' robots.txt")).toBe("grep: \\ at end of pattern");
  });

  test("a file the server can't serve", async ({ page }) => {
    await page.route("**/humans.txt", (route) => route.fulfill({ status: 404, body: "" }));
    expect(await result(page, "cat humans.txt")).toBe("cat: humans.txt: Input/output error");
  });

  test("commands that read the terminal when nothing is piped in", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(() => {
      window.spoken = [];
      Object.defineProperty(window, "speechSynthesis", {
        value: {
          getVoices: () => [],
          speak: (u: SpeechSynthesisUtterance) => (window.spoken.push(u.text), setTimeout(() => u.onend!(new Event("end") as SpeechSynthesisEvent), 0)),
          cancel() {},
        },
        configurable: true,
      });
      window.SpeechSynthesisUtterance = function (this: { text: string }, t: string) {
        this.text = t;
      } as unknown as typeof SpeechSynthesisUtterance;
    });
    await page.reload();
    for (const [command, line, expected] of [
      ["cat - robots.txt", "typed", "typed"],
      ["git hash-object --stdin", "Erik Berlin", "7773ccb2f816421e6fc3471201700290f7daef8d"],
      ["cowsay", "moo", "< moo >"],
      ["figlet", "x", "__  __"],
      ["banner -w 20", "x", "#"],
      ["pbcopy", "copied", ""],
      ["say", "spoken", ""],
    ]) {
      await start(page, command);
      await type(page, line);
      await field(page).press("Control+d");
      await done(page);
      if (expected) await expect(log(page)).toContainText(expected);
    }
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("copied\n");
    expect(await page.evaluate(() => window.spoken)).toEqual(["spoken\n"]);
  });

  test("ls -lF, ls -lh on mid-sized files, tree -I", async ({ page }) => {
    expect(await result(page, "ls -lF | tail -1")).toMatch(/ talks\/$/);
    expect(await result(page, "ls -lh dependency.webp")).toMatch(/\d\.\dK .* dependency\.webp$/);
    expect(await result(page, "tree -I talks | tail -1")).toBe("1 directory, 5 files");
    expect(await result(page, "tree -I '*.txt' | tail -1")).toBe("2 directories, 4 files");
  });

  test("banner at its default width", async ({ page }) => {
    expect(await result(page, "banner I | grep -c '#'")).toMatch(/^[1-9]\d*$/);
  });

  test("matrix toggles back", async ({ page }) => {
    await sh(page, "matrix");
    await sh(page, "matrix");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  });

  test("figlet smushing edge cases: hardblanks and opposite pairs", async ({ page }) => {
    expect((await result(page, "figlet 'a b'")).split("\n").length).toBe(5);
    expect((await result(page, "figlet '!!'")).split("\n").length).toBe(5);
  });

  test("gh reports errors without a status text", async ({ page }) => {
    const cors = { "access-control-allow-origin": "*" };
    await page.route("https://api.github.com/weird", (route) => route.fulfill({ status: 599, headers: cors }));
    expect(await result(page, "gh api weird")).toBe("gh: Request failed (HTTP 599)");
    await page.route("https://api.github.com/limited", (route) => route.fulfill({ status: 403, json: { message: "API rate limit exceeded" }, headers: cors }));
    expect(await result(page, "gh api limited")).toBe("gh: API rate limit exceeded (HTTP 403)");
  });

  test("ping when the server doesn't answer", async ({ page }) => {
    await page.route("**/robots.txt?ping=*", (route) => route.abort());
    expect(await result(page, "ping -c 1")).toContain("1 packets transmitted");
  });
});

test("random: integers, ranges, steps, choices, and seeds", async ({ page }) => {
  const n = Number(await result(page, "random"));
  expect(Number.isInteger(n) && n >= 0 && n <= 32767).toBe(true);
  for (let i = 0; i < 5; i++) {
    const r = Number(await result(page, "random 1 6"));
    expect(r >= 1 && r <= 6).toBe(true);
  }
  expect(Number(await result(page, "random 1 2 9")) % 2).toBe(1);
  expect(["a", "b", "c"]).toContain(await result(page, "random choice a b c"));
  const first = await result(page, "random 42; random 1 1000000; random choice x y z");
  expect(await result(page, "random 42; random 1 1000000; random choice x y z")).toBe(first);
  expect(await result(page, "random 5 1")).toBe("random: END must be greater than START");
  expect(await result(page, "random 1 0 5")).toBe("random: STEP must be a positive integer");
  expect(await result(page, "random 1 2 3 4")).toBe("random: too many arguments");
  expect(await result(page, "random one")).toBe("random: one: invalid integer");
  expect(await result(page, "random choice")).toBe("random: nothing to choose from");
  expect(await result(page, "random -3 -1")).toMatch(/^-[123]$/);
});

test("ls -lh rounds big files to whole kilobytes", async ({ page }) => {
  await page.route("**/robots.txt", (route) => route.fulfill({ body: "x".repeat(20480) }));
  expect(await result(page, "ls -lh robots.txt")).toMatch(/ 20K .* robots\.txt$/);
});

test("finger reports an API error", async ({ page }) => {
  await page.route(
    (url) => url.pathname === "/finger",
    (route) => route.fulfill({ status: 500 }),
  );
  expect(await result(page, "finger")).toBe("finger: /finger: 500");
});
