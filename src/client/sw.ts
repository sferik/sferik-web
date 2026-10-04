// The service worker, so the site and its shell keep working offline. Every
// request goes to the network first, and what comes back is kept; when the
// network can't be reached, the kept copy is served instead. Installing it
// keeps the pages and their files, so even the first visit works offline later.
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

const CACHE = "sferik";
// The pages' files, and the shell's (cat .plan works offline too).
const FILES = [
  "/site.css",
  "/site.js",
  "/shell.js",
  "/dom.js",
  "/qr.js",
  "/icons.svg",
  "/favicon.svg",
  "/img/dependency.webp",
  "/img/dependency-2x.webp",
  "/.plan",
  "/humans.txt",
  "/robots.txt",
];

// The same URL is a page, JSON, or text, depending on what's asked for, so
// keep each kind separately.
const key = (request: Request) => {
  const accept = request.headers.get("accept") ?? "";
  const kind = request.mode === "navigate" || accept.includes("text/html") ? "html" : accept.includes("json") ? "json" : "other";
  return `${request.url.split("#")[0]}${request.url.includes("?") ? "&" : "?"}as=${kind}`;
};

sw.addEventListener("install", (e) => {
  const pages = ["/", "/talks", "/resume"].map((url) => new Request(url, { headers: { accept: "text/html" } }));
  e.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all([...pages, ...FILES.map((url) => new Request(url))].map(async (r) => cache.put(key(r), await fetch(r)))))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));

sw.addEventListener("fetch", (e) => {
  const request = e.request;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(request).then(
      (response) => {
        if (response.ok) {
          const copy = response.clone();
          e.waitUntil(caches.open(CACHE).then((cache) => cache.put(key(request), copy)));
        }
        return response;
      },
      async () => (await caches.match(key(request))) ?? Response.error(),
    ),
  );
});
