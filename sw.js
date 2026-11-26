/* 词芽 · Service Worker
 * 首屏秒开、断网可查：壳文件预缓存，词库缓存优先 + 后台更新。
 * 改了 app.js / app.css / tree3d.js 后，必须同时改这里和 index.html 里的 ?v=N。
 */
const VERSION = 'cy-v34';
const SHELL = VERSION + '-shell';
const DATA = VERSION + '-data';

const SHELL_FILES = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './tree3d.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

const DATA_FILES = [
  './data/core.json',
  './data/phrase.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    Promise.all([
      caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).catch(() => { }),
      /* 词库也在这里灌进缓存：首装完成后就一定断网可查，不依赖页面时序 */
      caches.open(DATA).then((c) => c.addAll(DATA_FILES)).catch(() => { })
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;

  const isData = url.pathname.endsWith('/data/dict.json') ||
                 url.pathname.endsWith('/data/core.json') ||
                 url.pathname.endsWith('/data/phrase.json');

  /* 词库：缓存优先，后台静默更新 */
  if (isData) {
    e.respondWith(
      caches.open(DATA).then((cache) =>
        cache.match(req, { ignoreSearch: true }).then((hit) => {
          const net = fetch(req).then((res) => {
            if (res && res.ok) {
              try {
                cache.put(req, res.clone()).catch(() => { });
              } catch (_) { }
            }
            return res;
          }).catch(() => null);
          return hit || net.then((r) => r || new Response('{}', {
            headers: { 'Content-Type': 'application/json' }
          }));
        }).catch(() => fetch(req))
      )
    );
    return;
  }

  /* 壳：缓存优先（忽略 ?v= 版本参数），回退网络 */
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => { });
        }
        return res;
      }).catch(() => {
        /* 只有打开页面时才回退到 index.html，别把 HTML 当 JS 返回 */
        if (req.mode === 'navigate') {
          return caches.match('./index.html').then((p) => p || Response.error());
        }
        return Response.error();
      });
    })
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});