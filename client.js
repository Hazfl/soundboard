// ===================== 세션 콘솔 클라이언트 (Firebase 버전) =====================
// 전체를 try/catch로 감싸서, 어디서든 에러가 나면 화면에 바로 보이게 한다.
// (콘솔에만 찍히면 사용자가 못 보고 "그냥 안 됨"으로만 남기 때문)
(function () {
try {
const el = (id) => document.getElementById(id);
// 요소가 없어도(누가 실수로 지워도) 스크립트 전체가 멈추지 않도록 방어하는 헬퍼.
// 이게 없으면 특정 UI 하나만 지워져도 그 아래 코드(버튼 클릭 등록 등)가 통째로 실행되지 않게 된다.
function on(id, evt, handler) {
  const node = el(id);
  if (!node) { console.warn('[세션 콘솔] 요소를 찾을 수 없어 이벤트를 건너뜁니다:', id); return; }
  node.addEventListener(evt, handler);
}
el('app').style.display = 'none'; // 로비가 뜬 상태로 시작 (캐싱된 CSS와 무관하게 확실히 숨김)

// =====================================================================
// 0. Firebase 초기화
// =====================================================================
let fb = null;
let dbRoot = null;
const CONFIG_LOOKS_EMPTY = !window.FIREBASE_CONFIG || window.FIREBASE_CONFIG.apiKey.includes('여기에');

if (!CONFIG_LOOKS_EMPTY) {
  fb = firebase.initializeApp(window.FIREBASE_CONFIG);
  dbRoot = firebase.database();
} else {
  el('firebaseHint').hidden = false;
}

// =====================================================================
// 1. 룸 상태
// =====================================================================
let roomCode = null;
let isHost = false;
let hostSecret = null;
let roomRef = null;
let sfxRef = null;
let sfxInitialLoadDone = false;
let lastBgmStartedAt = null; // 동일한 bgm 값 재수신 시 중복 재생 방지

let library = { bgm: [], sfx: [] };
let activeCategory = 'combat';
const CATEGORIES = [
  { id: 'combat', label: '전투' },
  { id: 'daily', label: '일상' },
  { id: 'horror', label: '공포' },
  { id: 'custom', label: '기타' },
];

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// =====================================================================
// 1b. 룸 테마 색상 (방마다 다른 포인트 컬러)
// =====================================================================
function hexToRgb(hex) {
  hex = (hex || '#3fae71').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const num = parseInt(hex, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}
function mixHex(hex, targetHex, amount) {
  const a = hexToRgb(hex), b = hexToRgb(targetHex);
  return rgbToHex(a.r + (b.r - a.r) * amount, a.g + (b.g - a.g) * amount, a.b + (b.b - a.b) * amount);
}
function applyThemeColor(hex) {
  if (!hex) return;
  const root = document.documentElement.style;
  root.setProperty('--green', hex);
  root.setProperty('--green-dark', mixHex(hex, '#000000', 0.24));
  root.setProperty('--green-soft', mixHex(hex, '#ffffff', 0.84));
}
function cmdSetThemeColor(hex) {
  if (!isHost || !roomRef) return;
  roomRef.child('themeColor').set(hex);
}

// =====================================================================
// 2. 로비 UI
// =====================================================================
document.querySelectorAll('.lobby-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.lobby-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    el('paneJoin').hidden = tab.dataset.tab !== 'join';
    el('paneCreate').hidden = tab.dataset.tab !== 'create';
    el('createdResult').hidden = true;
    hideLobbyError();
  });
});

function showLobbyError(msg) {
  const e = el('lobbyError');
  e.textContent = msg;
  e.hidden = false;
}
function hideLobbyError() { el('lobbyError').hidden = true; }

on('createBtn', 'click', async () => {
  if (!dbRoot) { showLobbyError('Firebase 설정이 필요합니다.'); return; }
  hideLobbyError();
  el('createBtn').disabled = true;
  el('createBtn').textContent = '만드는 중...';
  try {
    let code;
    // 코드 중복 방지 (아주 낮은 확률이지만 한 번 검사)
    for (let i = 0; i < 5; i++) {
      code = makeRoomCode();
      const snap = await dbRoot.ref('rooms/' + code).get();
      if (!snap.exists()) break;
    }
    const secret = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).slice(0, 12);
    const themeColor = (el('createColor') && el('createColor').value) || '#3fae71';
    await dbRoot.ref('rooms/' + code).set({
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      hostSecret: secret,
      themeColor,
      filters: { lowpass: false, reverb: false },
      library: { bgm: [], sfx: [] },
      bgm: null,
      bgmVolume: 1
    });
    localStorage.setItem('tsb_host_' + code, secret);
    roomCode = code; hostSecret = secret; isHost = true;
    el('crCode').textContent = code;
    el('crSecret').textContent = secret;

    // 폼/탭은 완전히 숨기고 결과 화면만 새로 띄운다 (아래에 덧붙는 느낌 방지)
    el('lobbyTabs').hidden = true;
    el('paneJoin').hidden = true;
    el('paneCreate').hidden = true;
    el('createdResult').hidden = false;
  } catch (e) {
    console.error(e);
    showLobbyError('룸 생성에 실패했습니다: ' + e.message);
  } finally {
    el('createBtn').disabled = false;
    el('createBtn').textContent = '새 룸 만들기';
  }
});

on('backToLobbyBtn', 'click', () => {
  el('createdResult').hidden = true;
  el('lobbyTabs').hidden = false;
  el('paneCreate').hidden = false;
  roomCode = null; isHost = false; hostSecret = null;
});

on('enterBoardBtn', 'click', () => {
  subscribeToRoom(roomCode);
  setupPresence(roomCode);
  enterBoard();
});

on('joinBtn', 'click', async () => {
  if (!dbRoot) { showLobbyError('Firebase 설정이 필요합니다.'); return; }
  hideLobbyError();
  const code = el('joinCode').value.trim().toUpperCase();
  if (code.length < 4) { showLobbyError('룸 코드를 입력해주세요.'); return; }
  try {
    const snap = await dbRoot.ref('rooms/' + code).get();
    if (!snap.exists()) { showLobbyError('존재하지 않는 룸 코드입니다.'); return; }
    roomCode = code;

    const savedSecret = localStorage.getItem('tsb_host_' + code);
    const typedSecret = el('hostSecretInput').value.trim();
    const realSecret = snap.val().hostSecret;
    if (savedSecret && savedSecret === realSecret) { isHost = true; hostSecret = savedSecret; }
    else if (typedSecret && typedSecret === realSecret) { isHost = true; hostSecret = typedSecret; localStorage.setItem('tsb_host_' + code, typedSecret); }
    else { isHost = false; }

    subscribeToRoom(code);
    setupPresence(code);
    enterBoard();
  } catch (e) {
    console.error(e);
    showLobbyError('접속에 실패했습니다: ' + e.message);
  }
});

on('reclaimBtn', 'click', () => { const b = el('joinBtn'); if (b) b.click(); });

function enterBoard() {
  const lobbyEl = el('lobby');
  const appEl = el('app');
  lobbyEl.hidden = true;
  lobbyEl.style.display = 'none';
  appEl.hidden = false;
  appEl.style.display = 'flex';
  el('roomCodeDisplay').textContent = 'ROOM ' + roomCode;
  if (isHost) {
    document.getElementById('roleBadge').textContent = '마스터';
    document.getElementById('roleBadge').classList.add('host');
    el('hostOnlyBlock').hidden = false;
    el('hostPlaybackBlock').hidden = false;
    el('hostThemeBlock').hidden = false;
  } else {
    document.body.classList.add('player-mode');
  }
  renderTabs();
  armSoundUnlock();
}

// =====================================================================
// 3. Firebase 구독 (WebSocket의 "브로드캐스트 수신"을 대체)
// =====================================================================
function subscribeToRoom(code) {
  roomRef = dbRoot.ref('rooms/' + code);
  sfxRef = roomRef.child('sfx');

  roomRef.child('library').on('value', (snap) => {
    library = snap.val() || { bgm: [], sfx: [] };
    renderGrid();
  });

  roomRef.child('filters').on('value', (snap) => {
    applyFilters(snap.val() || {});
  });

  roomRef.child('themeColor').on('value', (snap) => {
    const hex = snap.val();
    if (!hex) return;
    applyThemeColor(hex);
    const input = el('themeColorInput');
    if (input) input.value = hex;
  });

  roomRef.child('bgm').on('value', (snap) => {
    const bgm = snap.val();
    if (!bgm) { stopBgmLocal(1200); lastBgmStartedAt = null; return; }
    if (bgm.startedAt === lastBgmStartedAt) return; // 동일 트랙 재수신(볼륨 등 다른 필드 변화) 무시
    lastBgmStartedAt = bgm.startedAt;
    try {
      if (bgm.sourceType === 'youtube') playBgmYoutube(bgm);
      else playBgmFile(bgm, bgm.crossfadeMs ?? 1500);
    } catch (e) { console.error(e); showToast('BGM을 불러오지 못했습니다.'); }
  });

  roomRef.child('bgmVolume').on('value', (snap) => {
    const v = snap.val();
    if (v == null) return;
    bgmSlots.forEach((slot) => { if (slot) slot.gain.gain.setTargetAtTime(v, ctx.currentTime, 0.05); });
    if (ytPlayer && ytReady) ytPlayer.setVolume(Math.round(v * 100));
    el('liveBgmVolume').value = v;
    el('liveBgmVolumeVal').textContent = Math.round(v * 100) + '%';
  });

  // SFX: 처음 붙을 때 있던 과거 이벤트는 재생하지 않고, 이후 새로 추가되는 것만 재생
  sfxRef.limitToLast(1).once('value', () => { sfxInitialLoadDone = true; });
  sfxRef.limitToLast(20).on('child_added', (snap) => {
    if (!sfxInitialLoadDone) return;
    playSfx(snap.val());
  });
}

// =====================================================================
// 3b. 접속 인원 추적 + 아무도 없으면 방 자동 삭제
//     (별도 서버 없이, Firebase의 onDisconnect를 이용한 순수 클라이언트 방식)
//     동작 원리: 방에 남은 사람이 나 혼자면, "내가 나가는 순간 방 전체를 삭제"하도록
//     예약해둔다. 누가 더 들어오면 그 예약을 취소한다. 그래서 마지막 한 명이
//     나가는 순간(브라우저를 닫거나 인터넷이 끊기는 순간) 방이 사라진다.
// =====================================================================
const myClientId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

function setupPresence(code) {
  const presenceRef = dbRoot.ref('rooms/' + code + '/presence');
  const myPresenceRef = presenceRef.child(myClientId);
  const roomRootRef = dbRoot.ref('rooms/' + code);

  dbRoot.ref('.info/connected').on('value', (snap) => {
    if (snap.val() !== true) return;
    myPresenceRef.onDisconnect().remove();
    myPresenceRef.set(true);
  });

  presenceRef.on('value', (snap) => {
    const val = snap.val() || {};
    const keys = Object.keys(val);
    if (keys.length <= 1) {
      // 방에 나 혼자(또는 아무도 없음) -> 내가 나가면 방 전체 삭제 예약
      roomRootRef.onDisconnect().remove();
    } else {
      // 다른 사람이 있으면 방 삭제 예약 취소 (내 presence 제거만 유지)
      roomRootRef.onDisconnect().cancel();
      myPresenceRef.onDisconnect().remove();
    }
  });
}

// =====================================================================
// 4. 호스트 명령 전송 (WebSocket send를 대체)
// =====================================================================
function cmdStopBgm() {
  if (!isHost) return;
  roomRef.child('bgm').set(null);
}
function cmdSetBgmVolume(v) {
  if (!isHost) return;
  roomRef.child('bgmVolume').set(v);
}
function cmdPlayBgm(item) {
  if (!isHost) return;
  roomRef.child('bgm').set({
    id: item.id, title: item.title, sourceType: item.sourceType,
    url: item.url || null, videoId: item.videoId || null,
    volume: item.volume ?? 1, loop: true, crossfadeMs: 1500,
    startedAt: firebase.database.ServerValue.TIMESTAMP
  });
  roomRef.child('bgmVolume').set(item.volume ?? 1);
}
function cmdPlaySfx(item) {
  if (!isHost) return;
  sfxRef.push({ id: item.id, title: item.title, url: item.url, volume: item.volume ?? 1, duck: true, t: firebase.database.ServerValue.TIMESTAMP });
}
function cmdSetFilters(filters) {
  if (!isHost) return;
  roomRef.child('filters').set(filters);
}
function cmdLibraryUpdate(lib) {
  if (!isHost) return;
  roomRef.child('library').set(lib);
}

// =====================================================================
// 5. Web Audio 그래프
// =====================================================================
const ctx = new (window.AudioContext || window.webkitAudioContext)();

const bgmBus = ctx.createGain();
const sfxBus = ctx.createGain();
const filterNode = ctx.createBiquadFilter();
filterNode.type = 'lowpass';
filterNode.frequency.value = 20000;

const dryGain = ctx.createGain();
const wetGain = ctx.createGain();
wetGain.gain.value = 0;
const convolver = ctx.createConvolver();
convolver.buffer = createImpulseResponse(ctx, 2.2, 2.4);

const localVolume = ctx.createGain();
localVolume.gain.value = 1;

bgmBus.connect(filterNode);
sfxBus.connect(filterNode);
filterNode.connect(dryGain);
filterNode.connect(convolver);
convolver.connect(wetGain);
dryGain.connect(localVolume);
wetGain.connect(localVolume);
localVolume.connect(ctx.destination);

function createImpulseResponse(ac, duration, decay) {
  const rate = ac.sampleRate;
  const length = Math.floor(rate * duration);
  const impulse = ac.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
  }
  return impulse;
}

const soundUnlockEl = document.getElementById('soundUnlock');
function armSoundUnlock() {
  soundUnlockEl.hidden = false;
  const unlock = () => {
    if (ctx.state === 'suspended') ctx.resume();
    soundUnlockEl.hidden = true;
    document.removeEventListener('click', unlock);
    document.removeEventListener('keydown', unlock);
  };
  document.addEventListener('click', unlock);
  document.addEventListener('keydown', unlock);
}

function showToast(msg, ms = 5000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.hidden = true; }, ms);
}

// =====================================================================
// 6. 오디오 버퍼 캐시
// =====================================================================
const bufferCache = new Map();
async function loadBuffer(url) {
  if (bufferCache.has(url)) return bufferCache.get(url);
  const res = await fetch(url);
  const arr = await res.arrayBuffer();
  const buf = await ctx.decodeAudioData(arr);
  bufferCache.set(url, buf);
  return buf;
}

// =====================================================================
// 7. BGM 재생 (루프 + 크로스페이드)
// =====================================================================
let bgmSlots = [null, null];
let bgmSlotIndex = 0;
let currentBgmMeta = null;

async function playBgmFile(bgm, crossfadeMs) {
  const buf = await loadBuffer(bgm.url);
  const duration = buf.duration;
  const elapsedRaw = (Date.now() - bgm.startedAt) / 1000;
  const offset = bgm.loop ? (elapsedRaw % duration) : Math.min(Math.max(elapsedRaw, 0), duration - 0.05);

  const oldSlot = bgmSlots[bgmSlotIndex];
  bgmSlotIndex = 1 - bgmSlotIndex;

  const gainNode = ctx.createGain();
  gainNode.gain.setValueAtTime(0, ctx.currentTime);
  gainNode.connect(bgmBus);

  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.loop = !!bgm.loop;
  source.connect(gainNode);
  source.start(0, Math.max(offset, 0));

  const target = bgm.volume ?? 1;
  const fadeSec = Math.max(crossfadeMs, 0) / 1000;
  gainNode.gain.linearRampToValueAtTime(target, ctx.currentTime + fadeSec);

  bgmSlots[bgmSlotIndex] = { source, gain: gainNode };

  if (oldSlot) {
    oldSlot.gain.gain.setValueAtTime(oldSlot.gain.gain.value, ctx.currentTime);
    oldSlot.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeSec);
    const s = oldSlot.source;
    setTimeout(() => { try { s.stop(); } catch (e) {} }, fadeSec * 1000 + 100);
  }

  currentBgmMeta = { title: bgm.title, startedAt: bgm.startedAt, duration, loop: bgm.loop, sourceType: 'file' };
  updateNowPlaying();
}

function stopBgmLocal(fadeMs) {
  const fadeSec = Math.max(fadeMs, 0) / 1000;
  bgmSlots.forEach((slot) => {
    if (!slot) return;
    slot.gain.gain.setValueAtTime(slot.gain.gain.value, ctx.currentTime);
    slot.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeSec);
    const s = slot.source;
    setTimeout(() => { try { s.stop(); } catch (e) {} }, fadeSec * 1000 + 100);
  });
  bgmSlots = [null, null];
  currentBgmMeta = null;
  stopYoutube();
  updateNowPlaying();
}

// =====================================================================
// 7b. 유튜브 BGM (공식 IFrame Player API — 다운로드 아님)
// =====================================================================
let ytPlayer = null;
let ytReady = false;
let ytPendingCmd = null;

function ensureYoutubeApi() {
  if (ytPlayer) return;
  if (window.YT && window.YT.Player) { onYoutubeApiReady(); return; }
  if (document.getElementById('ytApiScript')) return;
  const tag = document.createElement('script');
  tag.id = 'ytApiScript';
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
  window.onYouTubeIframeAPIReady = onYoutubeApiReady;
}

const YT_ERROR_MESSAGES = {
  2: '유튜브 영상 ID가 올바르지 않습니다.',
  5: '이 브라우저에서 재생할 수 없는 영상입니다.',
  100: '영상을 찾을 수 없습니다(비공개/삭제됨).',
  101: '영상 제작자가 외부 사이트 임베드 재생을 막아둔 영상이라 여기서 재생할 수 없습니다. 다른 영상을 쓰거나 MP3 링크로 등록해주세요.',
  150: '영상 제작자가 외부 사이트 임베드 재생을 막아둔 영상이라 여기서 재생할 수 없습니다. 다른 영상을 쓰거나 MP3 링크로 등록해주세요.',
};

function onYoutubeApiReady() {
  if (ytPlayer) return;
  const holder = document.createElement('div');
  holder.id = 'ytHolder';
  holder.style.position = 'fixed';
  holder.style.bottom = '-1000px';
  holder.style.width = '1px'; holder.style.height = '1px';
  document.body.appendChild(holder);
  ytPlayer = new YT.Player('ytHolder', {
    height: '1', width: '1',
    playerVars: { autoplay: 0, controls: 0, disablekb: 1 },
    events: {
      onReady: () => { ytReady = true; if (ytPendingCmd) { playBgmYoutube(ytPendingCmd.bgm); ytPendingCmd = null; } },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED && currentBgmMeta && currentBgmMeta.loop) {
          ytPlayer.seekTo(0, true); ytPlayer.playVideo();
        }
      },
      onError: (e) => {
        const msg = YT_ERROR_MESSAGES[e.data] || `유튜브 재생 오류 (코드 ${e.data})`;
        console.error('[YouTube 오류]', e.data, msg);
        showToast(msg);
      }
    }
  });
}

function playBgmYoutube(bgm) {
  ensureYoutubeApi();
  if (!ytReady) { ytPendingCmd = { bgm }; return; }
  bgmSlots.forEach((slot) => { if (slot) { try { slot.source.stop(); } catch (e) {} } });
  bgmSlots = [null, null];

  const elapsedRaw = Math.max(0, (Date.now() - bgm.startedAt) / 1000);
  ytPlayer.loadVideoById({ videoId: bgm.videoId, startSeconds: elapsedRaw });
  ytPlayer.setVolume(Math.round((bgm.volume ?? 1) * 100));
  currentBgmMeta = { title: bgm.title, startedAt: bgm.startedAt, duration: null, loop: bgm.loop, sourceType: 'youtube' };
  updateNowPlaying();
}

function stopYoutube() { if (ytPlayer && ytReady) { try { ytPlayer.stopVideo(); } catch (e) {} } }

function extractYoutubeId(url) {
  const m = url.match(/(?:youtu\.be\/|v=|shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// =====================================================================
// 8. SFX (즉시 중첩) + 덕킹
// =====================================================================
async function playSfx(msg) {
  try {
    const buf = await loadBuffer(msg.url);
    const gainNode = ctx.createGain();
    gainNode.gain.value = msg.volume ?? 1;
    gainNode.connect(sfxBus);
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(gainNode);
    source.start(0);
    flashSoundButton(msg.id);
    if (msg.duck) duckBgm(Math.min(buf.duration, 2.5));
  } catch (e) { console.error('SFX 재생 실패', e); showToast('효과음을 불러오지 못했습니다: ' + msg.title); }
}

function duckBgm(durationSec) {
  const now = ctx.currentTime;
  bgmBus.gain.cancelScheduledValues(now);
  bgmBus.gain.setValueAtTime(bgmBus.gain.value, now);
  bgmBus.gain.linearRampToValueAtTime(0.2, now + 0.08);
  bgmBus.gain.setValueAtTime(0.2, now + 0.08 + durationSec);
  bgmBus.gain.linearRampToValueAtTime(1, now + 0.08 + durationSec + 0.35);
}

// =====================================================================
// 9. 필터
// =====================================================================
function applyFilters(filters) {
  filterNode.frequency.setTargetAtTime(filters.lowpass ? 700 : 20000, ctx.currentTime, 0.05);
  wetGain.gain.setTargetAtTime(filters.reverb ? 0.38 : 0, ctx.currentTime, 0.05);
  dryGain.gain.setTargetAtTime(filters.reverb ? 0.75 : 1, ctx.currentTime, 0.05);
  setSwitch('btnLowpass', !!filters.lowpass);
  setSwitch('btnReverb', !!filters.reverb);
}
function setSwitch(id, on) {
  const b = el(id);
  b.classList.toggle('on', on);
  b.setAttribute('aria-checked', String(on));
}

let localFilters = { lowpass: false, reverb: false };
on('btnLowpass', 'click', () => {
  if (!isHost) return;
  localFilters.lowpass = !localFilters.lowpass;
  cmdSetFilters(localFilters);
});
on('btnReverb', 'click', () => {
  if (!isHost) return;
  localFilters.reverb = !localFilters.reverb;
  cmdSetFilters(localFilters);
});

// =====================================================================
// 10. UI 렌더링
// =====================================================================
function renderTabs() {
  const tabsEl = el('tabs');
  tabsEl.innerHTML = '';
  CATEGORIES.forEach((cat) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (cat.id === activeCategory ? ' active' : '');
    btn.dataset.cat = cat.id;
    btn.textContent = cat.label;
    btn.addEventListener('click', () => { activeCategory = cat.id; renderTabs(); renderGrid(); });
    tabsEl.appendChild(btn);
  });
}

function renderGrid() {
  const gridEl = el('grid');
  const items = [...(library.bgm || []), ...(library.sfx || [])].filter((i) => (i.category || 'custom') === activeCategory);
  gridEl.innerHTML = '';
  if (items.length === 0) {
    gridEl.innerHTML = `<div class="empty-hint">이 카테고리에 등록된 사운드가 없어요.${isHost ? ' 오른쪽 "마스터 등록"에서 추가하세요.' : ''}</div>`;
    return;
  }
  items.forEach((item) => {
    const btn = document.createElement('button');
    btn.className = 'sound-btn';
    btn.dataset.category = item.category || 'custom';
    btn.dataset.id = item.id;
    btn.innerHTML = `
      <span class="sb-kind">${item.kind === 'bgm' ? 'BGM' : 'SFX'}${item.sourceType === 'youtube' ? ' · YT' : ''}</span>
      <span class="sb-title">${escapeHtml(item.title)}</span>
      <span class="sb-meta">
        <span class="sb-cat-dot"></span>
        <span class="sb-vol">${Math.round((item.volume ?? 1) * 100)}%</span>
        <span class="sb-key">${item.hotkey ? escapeHtml(item.hotkey) : ''}</span>
      </span>`;
    btn.addEventListener('click', () => triggerItem(item));
    gridEl.appendChild(btn);
  });
}

function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function flashSoundButton(id) {
  const btn = el('grid').querySelector(`[data-id="${id}"]`);
  if (!btn) return;
  btn.classList.add('playing');
  setTimeout(() => btn.classList.remove('playing'), 350);
}

function triggerItem(item) {
  if (!isHost) return;
  if (item.kind === 'bgm') cmdPlayBgm(item);
  else cmdPlaySfx(item);
}

// =====================================================================
// 11. Now Playing
// =====================================================================
function updateNowPlaying() {
  if (!currentBgmMeta) {
    el('npTitle').textContent = '— 무음 —';
    el('npWave').classList.remove('playing');
    el('npTime').textContent = '00:00';
    return;
  }
  el('npTitle').textContent = currentBgmMeta.title;
  el('npWave').classList.add('playing');
}
setInterval(() => {
  if (!currentBgmMeta) return;
  let sec;
  if (currentBgmMeta.sourceType === 'youtube' && ytPlayer && ytReady) sec = Math.floor(ytPlayer.getCurrentTime());
  else sec = Math.floor(((Date.now() - currentBgmMeta.startedAt) / 1000) % (currentBgmMeta.duration || 9999));
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  el('npTime').textContent = `${m}:${s}`;
}, 500);

// =====================================================================
// 12. 재생 제어 / 테마 색상
// =====================================================================
on('stopBgmBtn', 'click', cmdStopBgm);
on('liveBgmVolume', 'input', (e) => {
  const v = parseFloat(e.target.value);
  const label = el('liveBgmVolumeVal');
  if (label) label.textContent = Math.round(v * 100) + '%';
  cmdSetBgmVolume(v);
});
on('themeColorInput', 'input', (e) => {
  applyThemeColor(e.target.value);
  cmdSetThemeColor(e.target.value);
});

on('addVolume', 'input', (e) => {
  const label = el('addVolumeVal');
  if (label) label.textContent = Math.round(parseFloat(e.target.value) * 100) + '%';
});

// =====================================================================
// 13. 마스터 등록 폼
// =====================================================================
on('addForm', 'submit', (e) => {
  e.preventDefault();
  const kind = el('addKind').value;
  const title = el('addTitle').value.trim();
  const category = el('addCategory').value;
  const hotkey = el('addHotkey').value.trim();
  const urlInput = el('addUrl').value.trim();
  const volume = parseFloat(el('addVolume').value) || 1;
  if (!title || !urlInput) return;

  let sourceType = 'file', url = null, videoId = null;
  const yid = extractYoutubeId(urlInput);
  if (yid) { sourceType = 'youtube'; videoId = yid; }
  else { sourceType = 'file'; url = urlInput; }

  const item = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
    kind, title, category, hotkey, sourceType, url, videoId, volume
  };
  const nextLib = { bgm: [...(library.bgm || [])], sfx: [...(library.sfx || [])] };
  nextLib[kind].push(item);
  library = nextLib;
  renderGrid();
  cmdLibraryUpdate(nextLib);

  el('addForm').reset();
  el('addVolumeVal').textContent = '100%';
});

// =====================================================================
// 14. 단축키 (호스트 전용)
// =====================================================================
function normalizeCombo(str) {
  if (!str) return '';
  const parts = str.split('+').map((p) => p.trim()).filter(Boolean);
  const mods = parts.filter((p) => ['shift', 'ctrl', 'alt'].includes(p.toLowerCase())).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase());
  const rest = parts.filter((p) => !['shift', 'ctrl', 'alt'].includes(p.toLowerCase()));
  const key = rest.length ? rest[rest.length - 1].toUpperCase() : '';
  const order = ['Ctrl', 'Alt', 'Shift'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods, key].join('+');
}

document.addEventListener('keydown', (e) => {
  if (!isHost) return;
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  let parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(key);
  const combo = parts.join('+');

  const items = [...(library.bgm || []), ...(library.sfx || [])];
  const match = items.find((i) => i.hotkey && normalizeCombo(i.hotkey) === combo);
  if (match) { e.preventDefault(); triggerItem(match); }
});

} catch (err) {
  console.error('[세션 콘솔] 치명적 오류:', err);
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#e0574d;color:#fff;padding:14px 18px;font-family:monospace;font-size:13px;white-space:pre-wrap;';
  banner.textContent = '⚠️ 스크립트 오류가 발생했습니다. 이 문구를 그대로 복사해서 알려주세요:\n' + (err && err.stack ? err.stack : String(err));
  document.body.prepend(banner);
}
})();
