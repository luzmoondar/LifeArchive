const CACHE_NAME = 'life-archive-v4';
const ASSETS = [
    './',
    'index.html',
    'main.js',
    'style.css',
    'manifest.json'
];

// 설치 시 자산 캐싱
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

// 네트워크 우선 전략으로 변경 (업데이트가 즉시 반영되도록)
self.addEventListener('fetch', (e) => {
    e.respondWith(
        fetch(e.request).catch(() => {
            return caches.match(e.request);
        })
    );
});
