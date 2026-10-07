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
// The pages' files, and the shell's (cat .plan works offline too).
const FILES = [
  "/site.css",
  "/site.js",
  "/shell.js",
  "/dom.js",
  "/figlet.js",
  "/qr.js",
  "/share/standard.flf",
  "/icons.svg",
  "/favicon.svg",
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
// keep each kind separately. A query string doesn't count: /?run=whoami is
// the same page as /.
const key = (request: Request) => {
  const accept = request.headers.get("accept") ?? "";
  const kind = request.mode === "navigate" || accept.includes("text/html") ? "html" : accept.includes("json") ? "json" : "other";
  const url = new URL(request.url);
  return `${url.origin}${url.pathname}?as=${kind}`;
};
// Every response, or none: with a page missing, or an error in place of one, it's better to try again on the next visit.
const good = (response: Response) => {
  if (!response.ok) throw new Error(`${response.url}: ${response.status}`);
  return response;
};

sw.addEventListener("install", (e) => {
  // A page's first requests come before this has taken over, so it asks again for all of them.
  const requests = [
    ...PAGES.map((url) => new Request(url, { headers: { accept: "text/html" } })),
    ...DATA.map((url) => new Request(url, { headers: { accept: "application/json" } })),
    ...FILES.map((url) => new Request(url)),
  ];
  e.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(requests.map(async (r) => cache.put(key(r), good(await fetch(r))))))
      .then(() => sw.skipWaiting()),
  );
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
