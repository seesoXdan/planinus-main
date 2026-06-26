/* ─────────────────────────────────────────────────────────────
   firebase-api.js — 플래니어스 포털 Firebase 어댑터
   ---------------------------------------------------------------
   기존 화면 코드는 모두 fetch('/api/...') 로 백엔드를 호출한다.
   이 파일은 window.fetch 를 가로채서, '/api/*' 요청을
   Firebase Authentication + Cloud Firestore 동작으로 바꿔준다.
   → 그래서 index.html / quote.html 의 내용은 거의 그대로 둘 수 있다.

   필요 조건(아래 두 가지가 이 파일보다 먼저 로드되어 있어야 함):
     1) Firebase compat SDK (app / auth / firestore)
     2) window.__FIREBASE_CONFIG__  (firebase-config.js 에서 설정)

   파일 보관(자료실 실파일 / 견적 PDF)은 이번 단계에서는 보류하고
   (사무실 NAS 연결 단계에서 처리), 메타데이터만 Firestore에 저장한다.
   ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  if (!window.firebase || !window.firebase.initializeApp) {
    console.error('[firebase-api] Firebase SDK가 로드되지 않았습니다.');
    return;
  }
  if (!window.__FIREBASE_CONFIG__ || /붙여넣/.test(JSON.stringify(window.__FIREBASE_CONFIG__))) {
    console.error('[firebase-api] firebase-config.js 의 설정값을 먼저 채워주세요.');
    alert('Firebase 설정이 아직 비어 있습니다.\nfirebase-config.js 파일에 콘솔에서 복사한 설정값을 넣어주세요.');
    return;
  }

  firebase.initializeApp(window.__FIREBASE_CONFIG__);
  var auth = firebase.auth();
  var db = firebase.firestore();
  var storage = (firebase.storage ? firebase.storage() : null);

  // 브라우저에 로그인 상태 유지(새로고침해도 세션 유지)
  try { auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (e) {}

  /* ── 첫 인증 상태 확정 대기 (새로고침 시 세션 복원용) ── */
  var _authReadyResolve;
  var authReady = new Promise(function (r) { _authReadyResolve = r; });
  var _firstFired = false;
  auth.onAuthStateChanged(function (u) {
    if (u) localStorage.setItem('planinus_token', u.uid);
    else localStorage.removeItem('planinus_token');
    if (!_firstFired) { _firstFired = true; _authReadyResolve(u); }
  });

  /* ── 작은 유틸 ── */
  function pad(n) { return String(n).padStart(2, '0'); }
  function nowStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function todayStr() { return nowStr().slice(0, 10); }
  function humanSize(b) {
    if (b < 1024) return b + 'B';
    if (b < 1048576) return Math.round(b / 1024) + 'KB';
    return (b / 1048576).toFixed(1) + 'MB';
  }
  function typeFromName(n) {
    var e = (String(n).split('.').pop() || '').toLowerCase();
    if (e === 'pdf') return 'pdf';
    if (['doc', 'docx', 'hwp', 'hwpx', 'txt'].indexOf(e) >= 0) return 'doc';
    if (['xls', 'xlsx', 'csv'].indexOf(e) >= 0) return 'xls';
    if (['ppt', 'pptx', 'key'].indexOf(e) >= 0) return 'ppt';
    if (['zip', 'rar', '7z', 'tar', 'gz'].indexOf(e) >= 0) return 'zip';
    return 'doc';
  }
  // undefined 제거(Firestore는 undefined 저장 불가)
  function clean(obj) { return JSON.parse(JSON.stringify(obj == null ? {} : obj)); }

  /* ── 응답 빌더 ── */
  function J(data, status) {
    return new Response(JSON.stringify(data == null ? null : data),
      { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  }
  function ERR(msg, status) { return J({ error: msg }, status || 400); }

  /* ── 현재 사용자 프로필(Firestore users 문서) ── */
  async function profile(uid) {
    var s = await db.collection('users').doc(uid).get();
    if (!s.exists) return null;
    var d = s.data();
    return { id: uid, email: d.email, name: d.name, dept: d.dept || '', role: d.role || 'employee', status: d.status };
  }
  function HttpErr(msg, status) { var e = new Error(msg); e.status = status; return e; }
  async function requireUser() {
    var u = auth.currentUser;
    if (!u) throw HttpErr('로그인이 필요합니다.', 401);
    var p = await profile(u.uid);
    if (!p) throw HttpErr('계정 정보를 찾을 수 없습니다.', 401);
    return p;
  }
  async function requireAdmin() {
    var p = await requireUser();
    if (p.role !== 'admin') throw HttpErr('관리자만 가능한 작업입니다.', 403);
    return p;
  }

  /* ─────────────────────────────────────────────
     라우트 핸들러 — method + path(/api 제거 후) 로 분기
     반환값은 항상 Response 객체
     ───────────────────────────────────────────── */
  async function route(method, path, jsonBody, form) {
    await authReady; // 세션 복원이 끝난 뒤 처리

    /* ===== 인증 ===== */
    if (path === '/auth/login' && method === 'POST') {
      var b = jsonBody || {};
      if (!b.email || !b.password) return ERR('이메일과 비밀번호를 입력해 주세요.');
      var cred;
      try {
        cred = await auth.signInWithEmailAndPassword(String(b.email).trim().toLowerCase(), b.password);
      } catch (e) {
        return ERR('이메일 또는 비밀번호가 올바르지 않습니다.', 401);
      }
      var p = await profile(cred.user.uid);
      if (!p) { await auth.signOut(); return ERR('계정 정보를 찾을 수 없습니다.', 401); }
      if (p.status === 'pending') { await auth.signOut(); return ERR('관리자 승인 대기 중인 계정입니다. 승인 후 로그인할 수 있습니다.', 403); }
      if (p.status && p.status !== 'active') { await auth.signOut(); return ERR('이용할 수 없는 계정입니다. 관리자에게 문의해 주세요.', 403); }
      localStorage.setItem('planinus_token', cred.user.uid);
      return J({ token: cred.user.uid, user: { id: p.id, email: p.email, name: p.name, dept: p.dept, role: p.role } });
    }

    if (path === '/auth/register' && method === 'POST') {
      var r = jsonBody || {};
      if (!r.email || !r.password || !r.name) return ERR('이메일·비밀번호·이름은 필수입니다.');
      try {
        var nc = await auth.createUserWithEmailAndPassword(String(r.email).trim().toLowerCase(), r.password);
        await db.collection('users').doc(nc.user.uid).set({
          email: String(r.email).trim().toLowerCase(),
          name: String(r.name).trim(),
          dept: String(r.dept || '').trim(),
          role: 'employee', status: 'pending', created_at: nowStr()
        });
        await auth.signOut();
        return J({ ok: true, id: nc.user.uid, pending: true, message: '가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.' });
      } catch (e) {
        if (e.code === 'auth/email-already-in-use') return ERR('이미 등록된 이메일입니다.');
        if (e.code === 'auth/weak-password') return ERR('비밀번호는 6자 이상이어야 합니다.');
        if (e.code === 'auth/invalid-email') return ERR('이메일 형식이 올바르지 않습니다.');
        return ERR('가입 처리 중 오류가 발생했습니다.');
      }
    }

    if (path === '/me' && method === 'GET') {
      var me = await requireUser();
      return J({ user: { id: me.id, email: me.email, name: me.name, dept: me.dept, role: me.role } });
    }

    if (path === '/auth/change-password' && method === 'POST') {
      var u = auth.currentUser;
      if (!u) return ERR('로그인이 필요합니다.', 401);
      var cb = jsonBody || {};
      if (!cb.current || !cb.next) return ERR('현재 비밀번호와 새 비밀번호를 입력해 주세요.');
      if (String(cb.next).length < 6) return ERR('새 비밀번호는 6자 이상이어야 합니다.');
      try {
        var c = firebase.auth.EmailAuthProvider.credential(u.email, cb.current);
        await u.reauthenticateWithCredential(c);
        await u.updatePassword(cb.next);
        return J({ ok: true });
      } catch (e) {
        if (e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential')
          return ERR('현재 비밀번호가 올바르지 않습니다.');
        return ERR('비밀번호 변경 중 오류가 발생했습니다.');
      }
    }

    /* ===== 앱 설정(settings/integrations) =====
       Gemini API 키 등 외부 연동 키 보관.
       - 읽기: 로그인한 직원(브라우저에서 AI 호출에 사용)
       - 쓰기: 관리자만
       공개 저장소(GitHub Pages)에 키를 올리지 않기 위해 여기(Firestore)에 둔다. */
    if (path === '/settings' && method === 'GET') {
      await requireUser();
      var st = await db.collection('settings').doc('integrations').get();
      var sd = st.exists ? st.data() : {};
      return J({ geminiKey: sd.geminiKey || '' });
    }
    if (path === '/settings' && method === 'PUT') {
      await requireAdmin();
      var sb = jsonBody || {};
      var supd = {};
      if (sb.geminiKey != null) supd.geminiKey = String(sb.geminiKey).trim();
      await db.collection('settings').doc('integrations').set(supd, { merge: true });
      return J({ ok: true });
    }

    /* ===== 견적 품목 카탈로그(구분·세부항목) — 팀 공유 =====
       단일 문서 quote_catalog/default 에 {cats, items} 저장.
       읽기·쓰기: 승인된 직원이면 누구나 (협력업체 분야와 동일 정책). */
    if (path === '/catalog' && method === 'GET') {
      await requireUser();
      var cg = await db.collection('quote_catalog').doc('default').get();
      var cd = cg.exists ? cg.data() : {};
      return J({ cats: cd.cats || [], items: cd.items || [], updated_at: cd.updated_at || '', updated_by: cd.updated_by || '' });
    }
    if (path === '/catalog' && method === 'PUT') {
      var cm = await requireUser();
      var cb = jsonBody || {};
      var cats = Array.isArray(cb.cats) ? cb.cats : [];
      var its = Array.isArray(cb.items) ? cb.items : [];
      await db.collection('quote_catalog').doc('default').set({
        cats: cats, items: clean(its), updated_by: cm.id, updated_at: nowStr()
      }, { merge: true });
      return J({ ok: true });
    }

    /* ===== 직원 관리(관리자 전용) ===== */
    if (path === '/users' && method === 'GET') {
      await requireAdmin();
      var snap = await db.collection('users').get();
      var arr = snap.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; })
        .filter(function (x) { return x.status !== 'deleted'; });
      arr.sort(function (a, b) {
        var ap = a.status === 'pending' ? 0 : 1, bp = b.status === 'pending' ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
      });
      return J(arr.map(function (u) {
        return {
          id: u.id, email: u.email, name: u.name, dept: u.dept || '',
          role: u.role === 'admin' ? 'admin' : 'employee',
          status: u.status === 'pending' ? 'pending' : 'active',
          created_at: u.created_at
        };
      }));
    }
    var mUsr = path.match(/^\/users\/([^/]+)\/approve$/);
    if (mUsr && method === 'POST') {
      await requireAdmin();
      await db.collection('users').doc(mUsr[1]).update({ status: 'active' });
      return J({ ok: true });
    }
    mUsr = path.match(/^\/users\/([^/]+)\/role$/);
    if (mUsr && method === 'PUT') {
      var adm = await requireAdmin();
      if (mUsr[1] === adm.id) return ERR('본인 권한은 변경할 수 없습니다.');
      var role = (jsonBody && jsonBody.role === 'admin') ? 'admin' : 'employee';
      await db.collection('users').doc(mUsr[1]).update({ role: role });
      return J({ ok: true });
    }
    mUsr = path.match(/^\/users\/([^/]+)\/reset-password$/);
    if (mUsr && method === 'POST') {
      await requireAdmin();
      var ts = await db.collection('users').doc(mUsr[1]).get();
      if (!ts.exists) return ERR('해당 직원을 찾을 수 없습니다.', 404);
      var td = ts.data();
      try { await auth.sendPasswordResetEmail(td.email); }
      catch (e) { return ERR('재설정 메일 발송에 실패했습니다: ' + (e.message || ''), 400); }
      return J({ ok: true, resetEmail: true, email: td.email, name: td.name });
    }
    mUsr = path.match(/^\/users\/([^/]+)$/);
    if (mUsr && method === 'DELETE') {
      var adm2 = await requireAdmin();
      if (mUsr[1] === adm2.id) return ERR('본인 계정은 삭제할 수 없습니다.');
      // 클라이언트에서는 다른 사용자의 인증계정을 지울 수 없으므로 상태만 'deleted'로 표시(로그인 차단)
      await db.collection('users').doc(mUsr[1]).update({ status: 'deleted' });
      return J({ ok: true });
    }

    /* ===== 일정(events) ===== */
    if (path === '/events' && method === 'GET') {
      var es = await db.collection('events').get();
      var ea = es.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
      ea.sort(function (a, b) {
        return String(a.date).localeCompare(String(b.date)) || String(a.time || '').localeCompare(String(b.time || ''));
      });
      return J(ea);
    }
    if (path === '/events' && method === 'POST') {
      var em = await requireUser();
      var eb = jsonBody || {};
      if (!eb.date || !eb.title) return ERR('날짜와 제목은 필수입니다.');
      var edoc = { date: eb.date, endDate: eb.endDate || '', title: eb.title, category: eb.category || 'event', time: eb.time || '', created_by: em.id, created_at: nowStr() };
      var eref = await db.collection('events').add(edoc);
      edoc.id = eref.id;
      return J(edoc);
    }
    var mEv = path.match(/^\/events\/([^/]+)$/);
    if (mEv && method === 'PUT') {
      await requireUser();
      var pb = jsonBody || {};
      var up = { date: pb.date, endDate: pb.endDate || '', title: pb.title, category: pb.category, time: pb.time || '' };
      await db.collection('events').doc(mEv[1]).update(up);
      up.id = mEv[1];
      return J(up);
    }
    if (mEv && method === 'DELETE') {
      await requireUser();
      await db.collection('events').doc(mEv[1]).delete();
      return J({ ok: true });
    }

    /* ===== 행사 로드맵(roadmap) — 관리자 전용 =====
       저장 시 '리허설'·'행사 운영' 단계만 events 컬렉션에 동기화한다.
       (eventIds 에 연결된 event 문서 id 를 보관 → 수정/삭제 시 함께 반영) */
    var RM_SYNC = [
      { key: 'rehearsal', label: '리허설',   category: 'company' },
      { key: 'event',     label: '행사 운영', category: 'event' }
    ];
    function rmEventDoc(name, ph, phase, roadmapId, uid) {
      return {
        date: ph.s, endDate: ph.e || ph.s,
        title: name + ' · ' + phase.label,
        category: phase.category, time: '',
        roadmapId: roadmapId, phase: phase.key,
        created_by: uid, created_at: nowStr()
      };
    }
    async function rmSync(roadmapId, name, phases, eventIds, uid) {
      eventIds = eventIds || {};
      for (var i = 0; i < RM_SYNC.length; i++) {
        var ph = RM_SYNC[i];
        var val = phases && phases[ph.key];
        var has = val && val.s;
        var existing = eventIds[ph.key];
        if (has) {
          var doc = rmEventDoc(name, val, ph, roadmapId, uid);
          if (existing) {
            try {
              await db.collection('events').doc(existing).update({
                date: doc.date, endDate: doc.endDate, title: doc.title, category: doc.category
              });
            } catch (e) {
              /* 캘린더에서 직접 삭제된 경우 → 새로 생성 */
              var reref = await db.collection('events').add(doc);
              eventIds[ph.key] = reref.id;
            }
          } else {
            var ref = await db.collection('events').add(doc);
            eventIds[ph.key] = ref.id;
          }
        } else if (existing) {
          try { await db.collection('events').doc(existing).delete(); } catch (e) {}
          delete eventIds[ph.key];
        }
      }
      return eventIds;
    }
    if (path === '/roadmap' && method === 'GET') {
      await requireUser();
      var rs = await db.collection('roadmap').get();
      var ra = rs.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
      return J(ra);
    }
    if (path === '/roadmap' && method === 'POST') {
      var rm = await requireAdmin();
      var rb = jsonBody || {};
      if (!rb.name) return ERR('프로젝트명은 필수입니다.');
      var rdoc = {
        name: rb.name, owner: rb.owner || '', revenue: Number(rb.revenue) || 0,
        phases: rb.phases || {}, eventIds: {},
        created_by: rm.id, created_at: nowStr()
      };
      var rref = await db.collection('roadmap').add(rdoc);
      rdoc.eventIds = await rmSync(rref.id, rdoc.name, rdoc.phases, {}, rm.id);
      await db.collection('roadmap').doc(rref.id).update({ eventIds: rdoc.eventIds });
      rdoc.id = rref.id;
      return J(rdoc);
    }
    var mRm = path.match(/^\/roadmap\/([^/]+)$/);
    if (mRm && method === 'PUT') {
      var rmu = await requireAdmin();
      var rpb = jsonBody || {};
      var cur = await db.collection('roadmap').doc(mRm[1]).get();
      if (!cur.exists) return ERR('프로젝트를 찾을 수 없습니다.', 404);
      var curData = cur.data();
      var up = {
        name: rpb.name, owner: rpb.owner || '', revenue: Number(rpb.revenue) || 0,
        phases: rpb.phases || {}
      };
      up.eventIds = await rmSync(mRm[1], up.name, up.phases, curData.eventIds || {}, rmu.id);
      await db.collection('roadmap').doc(mRm[1]).update(up);
      up.id = mRm[1];
      return J(up);
    }
    if (mRm && method === 'DELETE') {
      await requireAdmin();
      var rdel = await db.collection('roadmap').doc(mRm[1]).get();
      if (rdel.exists) {
        var eids = rdel.data().eventIds || {};
        for (var ek in eids) {
          try { await db.collection('events').doc(eids[ek]).delete(); } catch (e) {}
        }
      }
      await db.collection('roadmap').doc(mRm[1]).delete();
      return J({ ok: true });
    }

    /* ===== 공지(notices) — 작성/수정/삭제는 관리자 ===== */
    if (path === '/notices' && method === 'GET') {
      var ns = await db.collection('notices').get();
      var na = ns.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
      na.sort(function (a, b) {
        var ap = a.pinned ? 0 : 1, bp = b.pinned ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
      });
      return J(na);
    }
    if (path === '/notices' && method === 'POST') {
      var nm = await requireAdmin();
      var nb = jsonBody || {};
      if (!nb.title) return ERR('제목은 필수입니다.');
      var ndoc = {
        title: nb.title, body: nb.body || '', category: nb.category || '안내',
        pinned: !!nb.pinned, author: nb.author || nm.dept || nm.name,
        created_by: nm.id, created_at: nowStr()
      };
      var nref = await db.collection('notices').add(ndoc);
      ndoc.id = nref.id;
      return J(ndoc);
    }
    var mNo = path.match(/^\/notices\/([^/]+)$/);
    if (mNo && method === 'PUT') {
      await requireAdmin();
      var nu = jsonBody || {};
      var nup = { title: nu.title, body: nu.body || '', category: nu.category || '안내', pinned: !!nu.pinned, author: nu.author || '' };
      await db.collection('notices').doc(mNo[1]).update(nup);
      nup.id = mNo[1];
      return J(nup);
    }
    if (mNo && method === 'DELETE') {
      await requireAdmin();
      await db.collection('notices').doc(mNo[1]).delete();
      return J({ ok: true });
    }

    /* ===== 자료실(files) — 메타데이터만 (실파일은 NAS 단계) ===== */
    if (path === '/files' && method === 'GET') {
      var fs = await db.collection('files').get();
      var fa = fs.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
      fa.sort(function (a, b) {
        return String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || '')) ||
          String(b.id).localeCompare(String(a.id));
      });
      return J(fa.map(function (f) {
        return {
          id: f.id, name: f.name, category: f.category, type: f.type, size: f.size,
          version: f.version, uploaded_at: f.uploaded_at, filename: f.filename || null,
          has_file: false  // 실제 파일 본문은 NAS 연결 후 제공
        };
      }));
    }
    if (path === '/files' && method === 'POST') {
      var fm = await requireAdmin();
      var file = form ? form.get('file') : null;
      if (!file || !file.name) return ERR('업로드할 파일을 선택해 주세요.');
      var origName = file.name;
      var fname = ((form.get('name') || '') + '').trim() || origName;
      var fdoc = {
        name: fname, category: form.get('category') || 'form',
        type: typeFromName(origName), size: humanSize(file.size || 0),
        version: ((form.get('version') || '') + '').trim() || 'v1',
        uploaded_at: todayStr(), filename: origName, created_by: fm.id
      };
      var fref = await db.collection('files').add(fdoc);
      return J({
        id: fref.id, name: fdoc.name, category: fdoc.category, type: fdoc.type,
        size: fdoc.size, version: fdoc.version, uploaded_at: fdoc.uploaded_at, filename: fdoc.filename
      });
    }
    var mFd = path.match(/^\/files\/([^/]+)\/download$/);
    if (mFd && method === 'GET') {
      return ERR('파일 본문은 사무실 NAS 연결 후 제공됩니다.', 404);
    }
    var mFi = path.match(/^\/files\/([^/]+)$/);
    if (mFi && method === 'DELETE') {
      await requireAdmin();
      await db.collection('files').doc(mFi[1]).delete();
      return J({ ok: true });
    }

    /* ===== 견적서(quotes) — 로그인 사용자 공유 ===== */
    if (path === '/quotes' && method === 'GET') {
      await requireUser();
      var qs = await db.collection('quotes').get();
      var qa = qs.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
      qa.sort(function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
      return J(qa.map(function (q) {
        return {
          id: q.id, quote_no: q.quote_no, title: q.title, client_name: q.client_name,
          event_name: q.event_name, total: q.total, updated_at: q.updated_at,
          author: q.author_name || '', has_pdf: false
        };
      }));
    }
    if (path === '/quotes' && method === 'POST') {
      var qm = await requireUser();
      var qb = jsonBody || {};
      var qdoc = {
        quote_no: qb.quote_no || '', title: qb.title || '무제 견적서',
        client_name: qb.client_name || '', event_name: qb.event_name || '',
        total: Math.round(qb.total || 0), data: clean(qb.data),
        created_by: qm.id, author_name: qm.name, created_at: nowStr(), updated_at: nowStr()
      };
      var qref = await db.collection('quotes').add(qdoc);
      return J({ id: qref.id });
    }
    var mQpdf = path.match(/^\/quotes\/([^/]+)\/pdf$/);
    if (mQpdf && method === 'POST') {
      // PDF 서버 보관은 NAS 단계에서. 지금은 조용히 성공 처리(저장 흐름 안 깨지게).
      return J({ ok: true, deferred: true });
    }
    if (mQpdf && method === 'GET') {
      return ERR('저장된 PDF가 없습니다. (NAS 연결 후 제공)', 404);
    }
    var mQ = path.match(/^\/quotes\/([^/]+)$/);
    if (mQ && method === 'GET') {
      await requireUser();
      var qg = await db.collection('quotes').doc(mQ[1]).get();
      if (!qg.exists) return ERR('견적서를 찾을 수 없습니다.', 404);
      var qd = qg.data();
      return J({
        id: mQ[1], quote_no: qd.quote_no, title: qd.title, client_name: qd.client_name,
        event_name: qd.event_name, total: qd.total, created_by: qd.created_by,
        created_at: qd.created_at, updated_at: qd.updated_at, has_pdf: false,
        data: qd.data || {}
      });
    }
    if (mQ && method === 'PUT') {
      await requireUser();
      var qu = jsonBody || {};
      await db.collection('quotes').doc(mQ[1]).update({
        quote_no: qu.quote_no || '', title: qu.title || '무제 견적서',
        client_name: qu.client_name || '', event_name: qu.event_name || '',
        total: Math.round(qu.total || 0), data: clean(qu.data), updated_at: nowStr()
      });
      return J({ ok: true, id: mQ[1] });
    }
    if (mQ && method === 'DELETE') {
      await requireUser();
      await db.collection('quotes').doc(mQ[1]).delete();
      return J({ ok: true });
    }

    /* ===== 협력업체 분야(partner_cats) — 승인 직원이면 누구나 ===== */
    if (path === '/partner-cats' && method === 'GET') {
      await requireUser();
      var pcs = await db.collection('partner_cats').get();
      var pca = pcs.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
      pca.sort(function (a, b) {
        return (Number(a.order) || 0) - (Number(b.order) || 0) ||
          String(a.created_at || '').localeCompare(String(b.created_at || ''));
      });
      return J(pca.map(function (c) { return { id: c.id, name: c.name, order: Number(c.order) || 0 }; }));
    }
    if (path === '/partner-cats' && method === 'POST') {
      await requireUser();
      var pcb = jsonBody || {};
      if (!pcb.name || !String(pcb.name).trim()) return ERR('분야 이름을 입력해 주세요.');
      var pcdoc = { name: String(pcb.name).trim(), order: Number(pcb.order) || 0, created_at: nowStr() };
      var pcref = await db.collection('partner_cats').add(pcdoc);
      pcdoc.id = pcref.id;
      return J(pcdoc);
    }
    var mPc = path.match(/^\/partner-cats\/([^/]+)$/);
    if (mPc && method === 'PUT') {
      await requireUser();
      var pcu = jsonBody || {};
      var pcup = {};
      if (pcu.name != null) pcup.name = String(pcu.name).trim();
      if (pcu.order != null) pcup.order = Number(pcu.order) || 0;
      await db.collection('partner_cats').doc(mPc[1]).update(pcup);
      pcup.id = mPc[1];
      return J(pcup);
    }
    if (mPc && method === 'DELETE') {
      await requireUser();
      await db.collection('partner_cats').doc(mPc[1]).delete();
      return J({ ok: true });
    }

    /* ===== 협력업체(partners) — 승인 직원이면 누구나 ===== */
    if (path === '/partners' && method === 'GET') {
      await requireUser();
      var ps = await db.collection('partners').get();
      var pa = ps.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
      pa.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ko'); });
      return J(pa.map(function (p) {
        return {
          id: p.id, name: p.name, catId: p.catId || '',
          role: p.role || '', manager: p.manager || '', phone: p.phone || '',
          email: p.email || '', homepage: p.homepage || '', bizno: p.bizno || '',
          addr: p.addr || '', tax: p.tax || '', account: p.account || '',
          memo: p.memo || '', files: p.files || {}
        };
      }));
    }
    if (path === '/partners' && method === 'POST') {
      var ptm = await requireUser();
      var ptb = jsonBody || {};
      if (!ptb.name || !String(ptb.name).trim()) return ERR('업체명을 입력해 주세요.');
      var ptdoc = clean({
        name: String(ptb.name).trim(), catId: ptb.catId || '',
        role: String(ptb.role || '').trim(), manager: String(ptb.manager || '').trim(),
        phone: String(ptb.phone || '').trim(), email: String(ptb.email || '').trim(),
        homepage: String(ptb.homepage || '').trim(), bizno: String(ptb.bizno || '').trim(),
        addr: String(ptb.addr || '').trim(), tax: String(ptb.tax || '').trim(),
        account: String(ptb.account || '').trim(), memo: String(ptb.memo || '').trim(),
        files: ptb.files || {}, created_by: ptm.id, created_at: nowStr()
      });
      var ptref = await db.collection('partners').add(ptdoc);
      ptdoc.id = ptref.id;
      return J(ptdoc);
    }
    var mPt = path.match(/^\/partners\/([^/]+)$/);
    if (mPt && method === 'PUT') {
      await requireUser();
      var ptu = jsonBody || {};
      var ptup = clean({
        name: String(ptu.name || '').trim(), catId: ptu.catId || '',
        role: String(ptu.role || '').trim(), manager: String(ptu.manager || '').trim(),
        phone: String(ptu.phone || '').trim(), email: String(ptu.email || '').trim(),
        homepage: String(ptu.homepage || '').trim(), bizno: String(ptu.bizno || '').trim(),
        addr: String(ptu.addr || '').trim(), tax: String(ptu.tax || '').trim(),
        account: String(ptu.account || '').trim(), memo: String(ptu.memo || '').trim(),
        files: ptu.files || {}
      });
      await db.collection('partners').doc(mPt[1]).update(ptup);
      ptup.id = mPt[1];
      return J(ptup);
    }
    if (mPt && method === 'DELETE') {
      await requireUser();
      await db.collection('partners').doc(mPt[1]).delete();
      return J({ ok: true });
    }

    return ERR('알 수 없는 요청입니다: ' + method + ' ' + path, 404);
  }

  /* ─────────────────────────────────────────────
     window.fetch 가로채기
     - 같은 출처의 '/api/*' 요청만 처리, 나머지는 원래 fetch로
     ───────────────────────────────────────────── */
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var apiPath = null;
    try {
      var u = new URL(url, location.origin);
      if (u.origin === location.origin && u.pathname.indexOf('/api/') === 0) {
        apiPath = u.pathname.slice(4); // '/api' 제거
      } else if (u.origin === location.origin && u.pathname === '/api') {
        apiPath = '/';
      }
    } catch (e) { /* 무시 */ }

    if (apiPath == null) {
      return origFetch ? origFetch(input, init) : Promise.reject(new Error('fetch unavailable'));
    }

    var method = (init.method || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
    var jsonBody = null, form = null;
    if (init.body instanceof FormData) {
      form = init.body;
    } else if (typeof init.body === 'string') {
      try { jsonBody = JSON.parse(init.body); } catch (e) { jsonBody = null; }
    }

    return route(method, apiPath, jsonBody, form).catch(function (err) {
      var status = err && err.status ? err.status : 500;
      return ERR((err && err.message) || '서버 오류가 발생했습니다.', status);
    });
  };

  // 디버깅용 핸들 노출 (storage = 협력업체 첨부파일 업로드에 사용)
  window.__planinusFirebase = { auth: auth, db: db, storage: storage, authReady: authReady };
})();
