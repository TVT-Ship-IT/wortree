/* 词芽 · Service Worker
 * 首屏秒开、断网可查。
 *
 * 缓存策略（改过好几次才定下来，别乱动）：
 *   - 打开页面（navigate）：网络优先。拿到新的 index.html 就更新缓存，
 *     断网时才回退到缓存的那份。不然版本号升级永远推不到手机上。
 *   - app.js / app.css / tree3d.js：按完整 URL（含 ?v=N）精确缓存。
 *     换了版本号就是新的键，自然拿新文件；老版本的键留着也不碍事。
 *   - 词库 data/*.json：缓存优先 + 后台静默更新。
 *
 * 改前端文件后，必须同时改 index.html 的 ?v=N（三处）和这里的 VERSION。
 */
const VERSION = 'cy-v41';
const SHELL = VERSION + '-shell';
const DATA = VERSION + '-data';

/* 只预缓存不会变的骨架。app.js / app.css / tree3d.js 故意不在这里：
   它们带 ?v=N，预缓存成不带参数的键就永远命中不了新版本。 */
const SHELL_FILES = [
  './',
  './index.html',
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

  const isData = url.pathname.endsWith('/data/core.json') ||
                 url.pathname.endsWith('/data/mid.json') ||
                 url.pathname.endsWith('/data/ext.json') ||
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

  /* 打开页面：网络优先，断网才用缓存 —— 这样版本更新才推得到 */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('./index.html', copy)).catch(() => { });
        }
        return res;
      }).catch(() => caches.match('./index.html').then((p) => p || Response.error()))
    );
    return;
  }

  /* 静态资源：按完整 URL 精确匹配，命中就用，不命中拿网络并存起来 */
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => { });
        }
        return res;
      }).catch(() => Response.error());
    })
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});