# sferik.com

Erik Berlin's personal website, and the API it's built from.

The site looks and works like a terminal: an 80-column fish shell, a tmux status line, and a prompt you can type into, with pipes, Ctrl-C, tab completion, and about
seventy commands. Every page builds itself from the site's own API, and every URL answers in three formats:

```sh
curl sferik.com/whoami                                    # text/plain: terminal output
curl -H 'Accept: application/json' sferik.com/resume      # application/json: a JSON Resume
open https://sferik.com/resume                            # text/html: the page
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
| `bun run build`        | Compile `src/client/*.ts` to `public/*.js` (with source maps)                                                                                                                                                                                           |
| `bun run typecheck`    | Type-check the server, the browser code, and the tests                                                                                                                                                                                                  |
| `bun run lint`         | ESLint (with typescript-eslint) and a Prettier formatting check                                                                                                                                                                                         |
| `bun run format`       | Format everything with Prettier and apply ESLint's automatic fixes                                                                                                                                                                                      |
| `bun run test`         | Run the server tests, then the browser tests                                                                                                                                                                                                            |
| `bun run test:server`  | Node's test runner against `src/server.ts` and `src/worker.ts`; fails below 100% line, branch, or function coverage. If [tectonic](https://tectonic-typesetting.github.io) is installed, it also compiles the LaTeX resume and fails on any TeX warning |
| `bun run test:browser` | Playwright against a real Chrome; fails below 100% coverage of the browser code                                                                                                                                                                         |
| `bun run coverage`     | Run the browser tests and open the coverage report                                                                                                                                                                                                      |

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
  │   /   /whoami   /contributions   /src   /name   /talks   /finger      │
  │   /resume                                                             │
  │                                                                       │
  │   data/*.json  ──► content, and the snapshots to fall back on         │
  │   live cache  ◄──► RubyGems and GitHub, refreshed in the background   │
  └───────────────────────────────────────────────────────────────────────┘
```

The browser first gets an HTML skeleton, then asks the same URLs for JSON and renders what comes back. The shell's `whoami`, `finger`, `man sferik`, and
`curl` use those URLs too. Everything else asks for whatever format it wants.

## The API

Each resource is one URL. The `Accept` header picks the representation, or add `.json`, `.txt`, `.tex`, or `.pdf` to the path.

| Accept                                  | You get                                                    |
| --------------------------------------- | ---------------------------------------------------------- |
| `text/html` (what browsers send)        | The page, which fetches the JSON below and renders it      |
| `application/json`                      | Structured data                                            |
| `text/plain`, or `*/*` (curl's default) | Terminal output, wrapped to 80 columns                     |
| `application/x-latex` (resume only)     | A LaTeX document; compile it with `pdflatex` or `tectonic` |
| `application/pdf` (resume only)         | A two-page PDF of the man page, with clickable links       |

The whole API is described in OpenAPI 3.1 at [`/openapi.json`](https://sferik.com/openapi.json) (`public/openapi.json`), so you can load it into
Swagger UI, Postman, or a client generator. The server tests fetch every path in every format the spec lists and check each JSON response against its
schema, so the spec can't drift from the API.

Anything else gets `406 Not Acceptable`, listing the formats that resource has. Responses send `Vary: Accept`, and everything but the pages allows cross-origin requests.

| Path             | What it is                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `/`              | The profile and the list of home-page modules, in order                                               |
| `/whoami`        | The bio, including the xkcd comic                                                                     |
| `/contributions` | A year of GitHub contributions, the longest streak, and the latest push                               |
| `/src`           | Projects with live RubyGems downloads and GitHub stars, plus totals                                   |
| `/name`          | The name change, as a git commit                                                                      |
| `/talks`         | Conference talks and podcasts (also a page)                                                           |
| `/finger`        | Contact details and profiles                                                                          |
| `/resume`        | The resume: [JSON Resume](https://jsonresume.org) as JSON, a man page as text, LaTeX, PDF, and a page |

```sh
curl localhost:3745/src                                   # the project table
curl localhost:3745/resume.json | jq .work[0]             # the current job
curl -o resume.pdf localhost:3745/resume.pdf              # the resume as a PDF
curl -H 'Accept: application/x-latex' localhost:3745/resume > resume.tex && tectonic resume.tex
curl -H 'Accept: application/json' localhost:3745/        # what the home page builds itself from
```

### Live data

The server fetches downloads from RubyGems and stars, contributions, and the latest push from GitHub, then caches them: an hour for most things, five minutes for
the latest push. A request never waits on a slow API once the cache is warm. Stale values are served while a refresh runs in the background, and if RubyGems or
GitHub is down, responses fall back to the snapshots in `data/`.

## Configuration

| Variable         | Default | Purpose                                                                                    |
| ---------------- | ------- | ------------------------------------------------------------------------------------------ |
| `PORT`           | `3745`  | Port to listen on (`0` picks a free one)                                                   |
| `GITHUB_TOKEN`   | none    | Raises GitHub's rate limit from 60 to 5,000 requests an hour                               |
| `SFERIK_OFFLINE` | unset   | Set to anything to skip live data and serve only the snapshots (the browser tests do this) |

## Project layout

```
src/
  server.ts          The HTTP server: routing, content negotiation, live data, and the text, LaTeX, and PDF renderers
  worker.ts          The same app on Cloudflare Workers: bundled data, static assets, and live data in KV
  types.d.ts         The shape of the API's JSON, shared by the server and the browser
  client/
    site.ts          Builds each page from the API and plays the home page as a session; shortcuts, themes, the clock
    shell.ts         The fish shell: parsing, pipes, job control, and every command
    dom.ts           Small DOM helpers
data/                Content and snapshots: profile, whoami, projects, talks, resume, contributions
public/              Everything the server serves as-is (HTML skeletons, CSS, images, fonts)
tests/
  server.test.ts     Server tests (node:test)
  worker.test.ts     Worker tests, with stand-ins for its bindings
  *.spec.ts          Browser tests (Playwright)
  support/           Fixtures, mocks, and coverage collection
```

To change what the site says, edit the JSON in `data/`; the pages, the API, and the text output all follow. `data/resume.json` follows the JSON Resume schema,
plus three small additions (`basics.formerName`, `patents`, and `speaking`).

## Deploying

The site runs on [Cloudflare Workers](https://workers.cloudflare.com), free at this traffic. `src/worker.ts` wraps the same app the Node server runs,
with three differences: `data/*.json` is bundled into the Worker, `public/` is served from Workers static assets, and the live numbers live in KV,
refreshed every 15 minutes by a cron trigger, so a request never waits on RubyGems or GitHub. Until the first refresh, pages show the snapshots.

One-time setup:

```sh
bunx wrangler login                     # opens a browser to authorize Wrangler with your Cloudflare account
bunx wrangler secret put GITHUB_TOKEN   # a fine-grained token with public, read-only access; Workers share IPs, so GitHub rate-limits anonymous requests
bun run deploy                          # builds, then deploys; the first deploy also creates the KV namespace
```

The site is then live at `https://sferik.<your-subdomain>.workers.dev`. To serve it from the real domains, add them to Cloudflare (free plan) and
point their nameservers at Cloudflare, then uncomment the `routes` in `wrangler.jsonc` and deploy again. After that, `bun run deploy` is all a
release takes. `bun run preview` runs the Worker locally in Cloudflare's runtime (`wrangler dev`) on port 8787. With `bun run preview --test-scheduled`,
requesting `/__scheduled?cron=*/15+*+*+*+*` runs a refresh.

The Node server still works anywhere Node 24.2+ runs, for local development or another host:

```sh
bun install --frozen-lockfile
bun run build
PORT=8080 GITHUB_TOKEN=… node src/server.ts
```

It shuts down cleanly on `SIGTERM`. Either way, the site treats sferik.com, sferik.org, sferik.net, and sferik.me as its own, so
`curl sferik.org/resume` inside the page's shell works too.

A GitHub Action (`.github/workflows/refresh-contributions.yml`) refreshes `data/contributions.json` daily, so the fallback snapshot stays recent. Another
(`.github/workflows/ci.yml`) lints, type-checks, and runs both test suites on every push and pull request, with the server tests on the oldest and newest
supported Node. Dependabot proposes package and action updates weekly, once a release is a week old.

## Credits

- The comic is adapted from [xkcd 2347](https://xkcd.com/2347/) by Randall Munroe, used under [CC BY-NC 2.5](https://creativecommons.org/licenses/by-nc/2.5/).
- `figlet` uses FIGlet's standard font, by Glenn Chappell and Ian Chai (`public/share/standard.flf`).
- The trains in `sl` are from sl(1) by Toyoda Masashi.
- Brand icons are from [Simple Icons](https://simpleicons.org) (CC0).
