/* Service Worker — アプリシェル
   ネットワーク優先: オンライン時は常に最新を取得し、オフライン時のみキャッシュを使う。
   （キャッシュ優先だと更新が反映されない問題を回避） */
const CACHE = 'ggai-reporting-v4';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 同一オリジンの GET のみ扱う。API/地図タイル等は素通り。
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // ネットワーク優先 → 失敗時にキャッシュ
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
