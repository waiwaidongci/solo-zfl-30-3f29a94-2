/* 极简离线外壳：首次访问后缓存全部静态资源，之后断网仍可打开。
   业务数据始终在 localStorage，不经过网络。 */
const CACHE = "dive-ops-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/store.js",
  "./js/app.js",
  "./manifest.webmanifest",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(hit =>
      hit || fetch(event.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(event.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("./index.html"))
    )
  );
});
