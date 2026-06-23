// Minimal service worker for runtime avatar uploads.
//
// The renderer derives the avatar's inner-folder name by regex-matching
// `/<name>.zip` in the fetch URL, and fetches that URL over the network. A
// dropped File only gives us a `blob:` URL (no filename, fails the regex). So
// instead the page stashes the uploaded zip in Cache Storage under a real URL
// like `/__avatar__/<folder>.zip`, and this SW serves it back on fetch. That URL
// both matches the renderer's regex AND is fetchable, and it survives a reload
// (so "drop → reload → load from cache" works without re-uploading).

const CACHE = "avatars";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith("/__avatar__/")) return;
  event.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(event.request.url).then(
        (hit) =>
          hit ||
          new Response("avatar not in cache", { status: 404 }),
      ),
    ),
  );
});
