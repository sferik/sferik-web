# sferik.net

Erik Berlin's personal website, and the API it's built from.

The site looks and works like a terminal: an 80-column fish shell, a tmux status line, and a prompt you can type into, with pipes, Ctrl-C, tab completion, and about
seventy commands. Every page builds itself from the site's own API, and every URL answers in three formats:

```sh
curl sferik.net/whoami                                    # text/plain: terminal output
curl -H 'Accept: application/json' sferik.net/resume      # application/json: a JSON Resume
open https://sferik.net/resume                            # text/html: the page
```

## Requirements

- Node.js 24.2 or newer (26 recommended). The server is TypeScript that Node runs directly, using its built-in type stripping.
- [Bun](https://bun.sh) 1.3 or newer, to install packages and run the scripts below

There are no runtime dependencies. The packages are for building, linting, and testing.

## Quick start

```sh
bun install
bun start
```

Then open <http://localhost:3745>. (3745 spells "erik" on a phone keypad.)

`bun start` compiles the browser code and starts the server. For development, `bun run dev` recompiles and restarts on every change.

## Scripts

| Command                | What it does                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun start`            | Build, then serve on port 3745                                                                                                                                                                                                                          |
| `bun run dev`          | Rebuild the browser code and restart the server whenever a file changes                                                                                                                                                                                 |
| `bun run preview`      | Build, then run the Cloudflare Worker locally on port 8787                                                                                                                                                                                              |
| `bun run deploy`       | Build, then deploy to Cloudflare Workers (see Deploying)                                                                                                                                                                                                |
| `bun run build`        | Compile and minify `src/client/*.ts` to `public/*.js` (with source maps, which have the source as it was written)                                                                                                                                       |
| `bun run typecheck`    | Type-check the server, the browser code, and the tests                                                                                                                                                                                                  |
| `bun run lint`         | ESLint (with typescript-eslint) and a Prettier formatting check                                                                                                                                                                                         |
| `bun run format`       | Format everything with Prettier and apply ESLint's automatic fixes                                                                                                                                                                                      |
| `bun run test`         | Run the server tests, then the browser tests                                                                                                                                                                                                            |
| `bun run test:server`  | Node's test runner against `src/server.ts` and `src/worker.ts`; fails below 100% line, branch, or function coverage. If [tectonic](https://tectonic-typesetting.github.io) is installed, it also compiles the LaTeX resume and fails on any TeX warning |
| `bun test`             | The server tests alone, quickly, with Bun's test runner (no coverage thresholds; it can't run the browser tests)                                                                                                                                        |
| `bun run test:browser` | Playwright against a real Chrome; fails below 100% coverage of the browser code                                                                                                                                                                         |
| `bun run coverage`     | Run the browser tests and open the coverage report                                                                                                                                                                                                      |
| `bun run snapshot`     | Refresh the downloads and stars in `data/projects.json` from RubyGems and GitHub                                                                                                                                                                        |
| `bun run og`           | Redraw the link-preview images in `public/` after the data changes (a weekly job does too)                                                                                                                                                              |

The first time you run the browser tests on a new machine, Playwright may need a browser: locally it uses your installed Chrome; elsewhere, run
`bunx playwright install chromium`.

## Architecture

```
  Browser                                     curl, scripts, API clients
  ┌──────────────────────────────────┐                    │
  │ public/index.html  (a skeleton)  │                    │ Accept: */*,
  │ site.js   builds the page        │                    │ application/json,
  │ shell.js  the fish shell         │                    │ x-latex, or pdf
  └───────┬────────────────┬─────────┘                    │
          │ text/html      │ application/json             │
          ▼                ▼                              ▼
  ┌───────────────────────────────────────────────────────────────────────┐
  │ src/server.ts                                                         │
  │                                                                       │
  │   negotiate(Accept) ──► html │ json │ text │ latex │ pdf              │
  │                                                                       │
  │   /   /whoami   /dependency   /contributions   /src   /name   /talks  │
  │   /finger   /resume   /who   /write                                   │
  │                                                                       │
  │   data/*.json  ──► content, and the snapshots to fall back on         │
  │   live cache  ◄──► RubyGems and GitHub, refreshed in the background   │
  └───────────────────────────────────────────────────────────────────────┘
```

The browser gets an HTML skeleton and renders the same JSON those URLs serve. The JSON a page needs comes inside it (a `<script type="application/json">`),
so building it takes no more requests; without that, the page asks the URLs. The shell's `whoami`, `finger`, `man sferik`, and `curl` ask them too.
Everything else asks for whatever format it wants.

## The API

Each resource is one URL. The `Accept` header picks the representation, or add `.json`, `.txt`, `.tex`, `.pdf`, or `.vcf` to the path.

| Accept                                  | You get                                                    |
| --------------------------------------- | ---------------------------------------------------------- |
| `text/html` (what browsers send)        | The page, which fetches the JSON below and renders it      |
| `application/json`                      | Structured data                                            |
| `text/plain`, or `*/*` (curl's default) | Terminal output, wrapped to 80 columns                     |
| `application/x-latex` (resume only)     | A LaTeX document; compile it with `pdflatex` or `tectonic` |
| `application/pdf` (resume only)         | A two-page PDF of the man page, with clickable links       |
| `text/vcard` (finger only)              | A contact card, to add to an address book                  |

The whole API is described in OpenAPI 3.1 at [`/openapi.json`](https://sferik.net/openapi.json) (`public/openapi.json`), so you can load it into
Swagger UI, Postman, or a client generator. The server tests fetch every path in every format the spec lists and check each JSON response against its
schema, so the spec can't drift from the API.

Anything else gets `406 Not Acceptable`, listing the formats that resource has. Responses send `Vary: Accept`, and everything but the pages allows cross-origin requests.

| Path             | What it is                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `/`              | The profile and the list of home-page modules, in order                                               |
| `/whoami`        | The bio                                                                                               |
| `/dependency`    | The xkcd comic, which the home page shows as `imgcat ~/dependency.webp`                               |
| `/contributions` | A year of GitHub contributions, the longest streak, and the latest push                               |
| `/src`           | Projects with live RubyGems downloads and GitHub stars, plus totals                                   |
| `/name`          | The name change, as a git commit                                                                      |
| `/talks`         | Conference talks and podcasts (also a page)                                                           |
| `/podcasts`      | Podcast appearances alone, which `/talks` has too                                                     |
| `/finger`        | Contact details and profiles (also a contact card)                                                    |
| `/resume`        | The resume: [JSON Resume](https://jsonresume.org) as JSON, a man page as text, LaTeX, PDF, and a page |
| `/who`           | Who's logged in: everyone reading the site, a terminal per tab (`POST` checks a tab in)               |
| `/write`         | `POST` only: the shell's `write sferik`, which emails the body to me                                  |

```sh
curl localhost:3745/src                                   # the project table
curl localhost:3745/resume.json | jq .work[0]             # the current job
curl -o resume.pdf localhost:3745/resume.pdf              # the resume as a PDF
curl -o erik.vcf localhost:3745/finger.vcf                # a contact card
curl -H 'Accept: application/x-latex' localhost:3745/resume > resume.tex && tectonic resume.tex
curl -H 'Accept: application/json' localhost:3745/        # what the home page builds itself from
```

### Live data

The server fetches downloads from RubyGems and stars, contributions, and the latest push from GitHub (the contributions from its GraphQL API, which
needs `GITHUB_TOKEN`; without one, from [a service](https://github.com/grubersjoe/github-contributions-api) that reads them off the profile page), then caches them: an hour for most things, five minutes for
the latest push. A request never waits on a slow API once the cache is warm. Stale values are served while a refresh runs in the background, and if RubyGems or
GitHub is down, responses fall back to the snapshots in `data/`. `/contributions` and `/src` say which in `live`, and when the numbers are from in `asOf`.

### Who's on, and write

Everyone reading the site is logged in to the same computer, each browser tab a terminal of its own. A tab checks in (`POST /who`, with a random token
and the page it's on) when its page is built and every minute it's in view, and stays logged in for three minutes after. The shell's `who`, `w`, and
`uptime` list them. Nothing about the reader is kept beyond the token, the page, and the times. An address that checks in more than sixty times a
minute gets a 429: on Workers, Cloudflare counts them, for that minute. Looking (`GET /who`) is free, and good for five seconds, so a cache can answer
for the host.

`write sferik` sends what you type (or pipe in) to `POST /write`, which emails it, with a Reply-To when the message includes an email address. One
message a minute from any one address, twenty a day in all, and 5,000 bytes each: one past that gets a 429, with the seconds to wait as its
`Retry-After`. A message sent with an `Idempotency-Key` header (random, one per message) can be sent again if no answer came: the same key within a
day is the same message, answered as sent and not emailed twice (or, asked after while it's still being sent, answered 409, with the seconds to wait). The shell's `write` sends one with each message, and sends a message that got no answer once more, three seconds later. Both `POST`s are for the site's own pages and for tools like curl: one from another site's page gets a 403. Both answer in plain text, or in JSON for a client that prefers it, where
an error has a `code` (`busy`, `full`, `too_long`, …) to tell it from the others by. The Node server prints messages instead of emailing them.

## Configuration

| Variable         | Default | Purpose                                                                                                    |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `PORT`           | `3745`  | Port to listen on (`0` picks a free one)                                                                   |
| `GITHUB_TOKEN`   | none    | Raises GitHub's rate limit from 60 to 5,000 requests an hour, and lets the server use GitHub's GraphQL API |
| `SFERIK_OFFLINE` | unset   | Set to anything to skip live data and serve only the snapshots (the browser tests do this)                 |

## Project layout

```
src/
  server.ts          The HTTP server: routing, content negotiation, live data, and the text, LaTeX, and PDF renderers
  worker.ts          The same app on Cloudflare Workers: bundled data, static assets, live data in KV, a Durable Object, and email
  types.d.ts         The shape of the API's JSON, shared by the server and the browser
  cloudflare.d.ts    The parts of the Workers runtime's modules that worker.ts uses
  client/
    site.ts          Builds each page from the API and plays the home page as a session; shortcuts, themes, the clock
    shell.ts         The fish shell: parsing, pipes, job control, and every command
    vcard.ts         The contact card, which the shell saves and the server serves
    dom.ts           Small DOM helpers
data/                Content and snapshots: profile, whoami, the comic, projects, talks, resume, contributions
scripts/             The Lighthouse budget, what draws the preview images, and what refreshes the snapshot of downloads and stars
public/              Everything the server serves as-is (HTML skeletons, CSS, images, fonts)
tests/
  server/            Server and Worker tests (node:test), which `bun test` also runs
  *.spec.ts          Browser tests (Playwright)
  support/           Fixtures, mocks, coverage collection, and stand-ins for the cloudflare: modules
```

To change what the site says, edit the JSON in `data/`; the pages, the API, and the text output all follow. `data/resume.json` follows the JSON Resume schema,
plus three small additions (`basics.formerName`, `patents`, and `speaking`).

## Deploying

The site runs on [Cloudflare Workers](https://workers.cloudflare.com), free at this traffic. `src/worker.ts` wraps the same app the Node server runs,
with these differences: `data/*.json` is bundled into the Worker, `public/` is served from Workers static assets (scripts, styles, and images
straight from them, without running the Worker, with the headers in `public/_headers`), and the live numbers live in KV,
refreshed every 15 minutes by a cron trigger, so a request never waits on RubyGems or GitHub. What the API answers is kept in Cloudflare's cache
for as long as each response says it's good for (a minute, for most), and so is each page, though browsers still check for a new one
on every load: a page older than a minute is sent as it is, at once, and a new one is built for the next reader, so on a quiet day nobody waits
for one. What isn't found is kept for a minute too. A page asks for its scripts and style under the commit that's deployed (`/v/<commit>/site.js`), where they never change, so a browser
keeps them until the next deploy without checking. Until the first refresh, pages show the snapshots.
Who's logged in lives in one Durable Object, `mbp`, so every tab sees the same list; and `write` sends email through Email Routing, which can only
deliver to an address it has verified (the one in `wrangler.jsonc`).

One-time setup:

```sh
bunx wrangler login                     # opens a browser to authorize Wrangler with your Cloudflare account
bunx wrangler secret put GITHUB_TOKEN   # a fine-grained token with public, read-only access; Workers share IPs, so GitHub rate-limits anonymous requests
bun run deploy                          # builds, then deploys; the first deploy also creates the KV namespace
```

sferik.com, sferik.org, and sferik.me (and `www.` on all four) redirect permanently to the same path on sferik.net, with a redirect rule in
each Cloudflare zone and a proxied placeholder record (`AAAA 100::`) so Cloudflare receives the requests. The rules run before the
Worker. Email Routing forwards mail sent to the domains, and sends `write`'s messages from sferik.net.

The Node server still works anywhere Node 24.2+ runs, for local development or another host:

```sh
bun install --frozen-lockfile
bun run build
PORT=8080 GITHUB_TOKEN=… node src/server.ts
```

It shuts down cleanly on `SIGTERM`. The page's shell treats sferik.net, sferik.com, sferik.org, and sferik.me as its own, so
`curl sferik.com/resume` inside it works too.

A GitHub Action (`.github/workflows/refresh-snapshots.yml`) refreshes `data/contributions.json` and the downloads and stars in `data/projects.json` daily
(`bun run snapshot` does the latter by hand), so the fallback snapshots stay recent. Another
(`.github/workflows/ci.yml`) lints, type-checks, and runs both test suites on every push and pull request, with the server tests on the oldest and newest
supported Node. A push to `main` that passes is deployed, and then the job asks sferik.net's `/version` whether it's serving that commit. A third (`.github/workflows/redraw-previews.yml`) redraws the link-preview
images weekly, since the home page's shows the contribution graph, and starts a deploy if they changed. Dependabot proposes package and action updates weekly, once a release is a week old.

## Credits

- The comic is adapted from [xkcd 2347](https://xkcd.com/2347/) by Randall Munroe, used under [CC BY-NC 2.5](https://creativecommons.org/licenses/by-nc/2.5/).
- `figlet` uses FIGlet's standard font, by Glenn Chappell and Ian Chai (`public/share/standard.flf`).
- The trains in `sl` are from sl(1) by Toyoda Masashi.
- Brand icons are from [Simple Icons](https://simpleicons.org) (CC0).
