/* ─────────────────────────────────────────────────────────────
   firebase-config.js — Firebase 프로젝트 연결 설정
   프로젝트: plsninus-main
   ⚠️ 이 값들은 공개되어도 안전한 식별자입니다.
      실제 보안은 Firestore 보안 규칙(firestore.rules)이 담당합니다.
   ───────────────────────────────────────────────────────────── */
window.__FIREBASE_CONFIG__ = {
  apiKey: "AIzaSyAetfUZKnJt9uN9DAjj2JCqMpJs5_b7wRM",
  authDomain: "plsninus-main.firebaseapp.com",
  projectId: "plsninus-main",
  storageBucket: "plsninus-main.firebasestorage.app",
  messagingSenderId: "414360968564",
  appId: "1:414360968564:web:4af8957d4bd5b9512ca021",
  measurementId: "G-3D5S07VTHX"
};

/* ─────────────────────────────────────────────────────────────
   Gemini API 키 — 사업자등록증 AI 분석에 사용
   ⚠️ 보안상 키는 이 파일(공개 배포됨)에 넣지 않습니다.
      대신 관리자가 앱 안에서 [직원 관리 → AI 분석 키 설정]으로 등록하면
      로그인한 직원만 읽을 수 있는 Firebase(Firestore)에 안전하게 보관됩니다.
   (로컬 단독 테스트용으로만 아래 따옴표에 임시로 넣을 수 있지만, 배포 파일엔 비워두세요.)
   ───────────────────────────────────────────────────────────── */
window.__GEMINI_API_KEY__ = "";

