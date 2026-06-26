const CACHE = 'planinus-v3';
const ASSETS = [
  './',
  './index.html',
  './quote.html',
  './firebase-config.js',
  './firebase-api.js',
  './manifest.json'
];

// 설치: 핵심 파일 캐싱 + 즉시 활성화
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// 활성화: 오래된 캐시 정리
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 요청 처리
//  - Firebase/구글 통신: 항상 네트워크 (서비스워커가 건드리지 않음)
//  - 화면 파일(HTML/JS 등): 네트워크 우선 → 최신본을 받고 캐시도 갱신,
//    오프라인일 때만 캐시 사용 (배포 후 새로고침 없이 최신 화면이 보이도록)
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('firestore') || url.includes('googleapis') ||
      url.includes('firebaseio') || url.includes('gstatic')) {
    return; // 데이터/SDK 요청은 그대로 네트워크로
  }
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
