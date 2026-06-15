const CACHE = 'planinus-v1';
const ASSETS = [
  './',
  './index.html',
  './quote.html',
  './firebase-config.js',
  './firebase-api.js',
  './manifest.json'
];

// 설치: 핵심 파일 캐싱
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// 활성화: 오래된 캐시 정리
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 요청 처리: Firebase/구글 통신은 항상 네트워크, 나머지는 캐시 우선
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('firestore') || url.includes('googleapis') ||
      url.includes('firebaseio') || url.includes('gstatic')) {
    return; // 데이터/SDK 요청은 그대로 네트워크로
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
