// The service worker, so the site and its shell keep working offline. Every
// request goes to the network first, and what comes back is kept; when the
// network can't be reached, or takes too long, the kept copy is served instead. Installing it
// keeps the pages, the JSON they build themselves from, and their files, so
// even the first visit works offline later.
//
// A classic script, not a module: not every browser runs module service workers.

interface SwExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface SwFetchEvent extends SwExtendableEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}
interface SwScope {
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", listener: (e: SwExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (e: SwFetchEvent) => void): void;
}
const sw = self as unknown as SwScope;

const CACHE = "sferik-2"; // a new name leaves the last one behind, which activating deletes
// The pages' files, the shell's (cat .plan works offline too), and what the
// site is installed with: its manifest, and the icons that names.
const FILES = [
  "/site.css",
  "/site.js",
  "/shell.js",
  "/dom.js",
  "/figlet.js",
  "/qr.js",
  "/vcard.js",
  "/share/standard.flf",
  "/icons.svg",
  "/favicon.svg",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
  "/img/dependency.webp",
  "/img/dependency-2x.webp",
  "/.plan",
  "/humans.txt",
  "/robots.txt",
];
const PAGES = ["/", "/talks", "/resume"];
// What the pages build themselves from, and the shell's commands read: each resource, as JSON.
const DATA = ["/", "/whoami", "/dependency", "/contributions", "/src", "/name", "/talks", "/finger", "/resume"];

// The same URL is a page, JSON, or text, depending on what's asked for, so
// keep each kind separately: and the resume is a PDF and LaTeX too, and finger
// a contact card, which the shell's curl can ask for (-H 'Accept: application/pdf'),
// so anything asked for by name that isn't text is a kind of its own. A query
// string doesn't count: /?run=whoami is the same page as /.
const kindOf = (request: Request) => {
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  if (request.mode === "navigate" || accept.includes("text/html")) return "html";
  if (accept.includes("json")) return "json";
  const first = accept.split(/[,;]/)[0].trim();
  return ["", "*/*", "text/*", "text/plain"].includes(first) ? "other" : first;
};
// A script or a style is asked for under the commit that's deployed
// (/v/<commit>/site.js), and kept without it: there's one of each, the
// latest, which is the one the latest page kept asks for.
const key = (request: Request) => {
  const kind = kindOf(request);
  const url = new URL(request.url);
  return `${url.origin}${url.pathname.replace(/^\/v\/\w+(?=\/)/, "")}?as=${kind}`;
};
// Every response, or none: with a page missing, or an error in place of one, it's better to try again on the next visit.
const good = (response: Response) => {
  if (!response.ok) throw new Error(`${response.url}: ${response.status}`);
  return response;
};

// Where a page asks for its scripts and style: under the deployed commit
// (/v/<commit>), or nowhere but their own names, with none.
const SCRIPTS = /src="((?:\/v\/\w+)?)\/site\.js"/;

sw.addEventListener("install", (e) => {
  // A page's first requests come before this has taken over, so it asks again
  // for all of them: the scripts and style where the page did, which the
  // browser has kept, and needn't download again.
  const install = async () => {
    const cache = await caches.open(CACHE);
    const home = new Request("/", { headers: { accept: "text/html" } });
    const page = good(await fetch(home));
    const [, under] = SCRIPTS.exec(await page.clone().text())!;
    await cache.put(key(home), page);
    const requests = [
      ...PAGES.slice(1).map((url) => new Request(url, { headers: { accept: "text/html" } })),
      ...DATA.map((url) => new Request(url, { headers: { accept: "application/json" } })),
      ...FILES.map((url) => new Request(url.replace(/^(?=\/[\w-]+\.(?:css|js)$)/, under))),
    ];
    await Promise.all(requests.map(async (r) => cache.put(key(r), good(await fetch(r)))));
    await sw.skipWaiting();
  };
  e.waitUntil(install());
});

sw.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => sw.clients.claim()),
  ),
);

// How long to wait for the network before answering with the kept copy. A
// weak connection is worse than none: it doesn't fail, it just never answers.
const PATIENCE = 3000;

sw.addEventListener("fetch", (e) => {
  const request = e.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  const fresh = fetch(request).then((response) => {
    // Not what was asked for with a query string (ping's /robots.txt?ping=1, a link's /?run=whoami): there's
    // no end to those, so keeping each would fill the cache.
    if (response.ok && !url.search) {
      const copy = response.clone();
      e.waitUntil(caches.open(CACHE).then((cache) => cache.put(key(request), copy)));
    }
    return response;
  });
  // An answer that comes too late to show is still kept, for the next time.
  e.waitUntil(fresh.catch(() => {}));
  e.respondWith(
    caches.match(key(request)).then((kept) => {
      if (!kept) return fresh;
      const late = new Promise<Response>((resolve) => setTimeout(resolve, PATIENCE, kept));
      return Promise.race([fresh, late]).catch(() => kept);
    }),
  );
});
