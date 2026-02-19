const CACHE_NAME = 'life-archive-v1';
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

// 네트워크 요청 시 캐시 우선 전략
self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then((response) => {
            return response || fetch(e.request);
        })
    );
});
