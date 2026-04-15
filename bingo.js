// ════════════════════════════════════════
//  BINGO! — Client logic
// ════════════════════════════════════════

const API = 'https://web-bingo-sever.onrender.com';

// ── Persistent identity ──
let myId = localStorage.getItem('bingo_id');
if (!myId) {
  myId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem('bingo_id', myId);
}

// ── Session state ──
let myName       = localStorage.getItem('bingo_name') || '';
let myColor      = '#fff';
let currentRoom  = null;
let isHost       = false;
let myCard       = [];
let gs           = 5;
let autoMark     = false;
let pollInterval = null;

// ── Welcome screen state ──
let wGS        = 5;
let wPublic    = true;
let pendingJoin = null;   // {code, hasPassword} — set before opening pw modal

// ── Lobby host state ──
let hGS             = 5;
let hPublic         = true;
let hPwEnabled      = false;
let settingsDebounce = null;

// ── Setup state ──
let setupCard     = [];
let selPoolNum    = null;
let cardSubmitted = false;
let _submitting   = false;

// ── Game state ──
let selPickNum    = null;
let lastCalledLen = 0;
let lastChatLen   = 0;
let lastRankLen   = 0;
let myPrevLines   = 0;
let _room         = null;
let _marking      = false;
let _calling      = false;
let _creating     = false;
let _joining      = false;
let _starting     = false;

// Heartbeat — keeps player marked as online
let heartbeatInterval = null;


// ════════════════════════════════════════
//  Init
// ════════════════════════════════════════

window.addEventListener('load', () => {
  if (myName) document.getElementById('playerName').value = myName;
  updateWGS();
  loadRooms();

  document.getElementById('playerName').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const activeTab = document.querySelector('.tab-btn.active');
      if (activeTab && activeTab.textContent.includes('Create')) createRoom();
      else joinByCode();
    }
  });
  document.getElementById('joinCode').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinByCode();
  });
  document.getElementById('joinCode').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });
});


// ════════════════════════════════════════
//  API
// ════════════════════════════════════════

async function apiCall(path, method = 'GET', body = null) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API + path, opts);
    return await res.json();
  } catch {
    showToast('Server unreachable — is Flask running?');
    return null;
  }
}


// ════════════════════════════════════════
//  Password show / hide
// ════════════════════════════════════════

function togglePwVis(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  const showing = inp.type === 'text';
  inp.type = showing ? 'password' : 'text';
  btn.classList.toggle('visible', !showing);
  btn.title = showing ? 'Show password' : 'Hide password';
}


// ════════════════════════════════════════
//  Exit / Leave helpers
// ════════════════════════════════════════

function openExitModal(title, body, onConfirm) {
  document.getElementById('exitModalTitle').textContent   = title;
  document.getElementById('exitModalBody').textContent    = body;
  const btn = document.getElementById('exitModalConfirm');
  // Replace onclick so old handlers don't stack
  btn.onclick = () => { closeExitModal(); onConfirm(); };
  document.getElementById('exitModal').classList.add('show');
}

function closeExitModal() {
  document.getElementById('exitModal').classList.remove('show');
}

async function exitLobby() {
  const msg = isHost
    ? 'You are the host. Leaving will close the room for everyone.'
    : 'You will be removed from the lobby.';
  openExitModal('Exit to Main Menu?', msg, async () => {
    if (currentRoom) await apiCall(`/api/room/${currentRoom}/leave`, 'POST', { id: myId });
    stopHeartbeat();
    clearInterval(pollInterval); pollInterval = null;
    currentRoom = null; isHost = false;
    showScreen('welcomeScreen');
    loadRooms();
  });
}

async function exitGame() {
  const msg = isHost
    ? 'You are the host. Leaving will close the room and end the game for everyone.'
    : 'You will leave the game. The game will continue without you.';
  openExitModal('Exit to Main Menu?', msg, async () => {
    if (currentRoom) await apiCall(`/api/room/${currentRoom}/leave`, 'POST', { id: myId });
    stopHeartbeat();
    clearInterval(pollInterval); pollInterval = null;
    currentRoom = null; isHost = false; myCard = [];
    showScreen('welcomeScreen');
    loadRooms();
  });
}

async function winMainMenu() {
  document.getElementById('winOverlay').classList.remove('show');
  if (currentRoom) await apiCall(`/api/room/${currentRoom}/leave`, 'POST', { id: myId });
  stopHeartbeat();
  clearInterval(pollInterval); pollInterval = null;
  currentRoom = null; isHost = false; myCard = [];
  showScreen('welcomeScreen');
  loadRooms();
}


// ════════════════════════════════════════
//  Kick player (host only, lobby)
// ════════════════════════════════════════

async function kickPlayer(targetId) {
  const data = await apiCall(`/api/room/${currentRoom}/kick`, 'POST',
    { id: myId, targetId });
  if (!data || data.error) return showToast(data?.error || 'Could not kick player');
  // Sync local grid-size state in case it changed before the kick response arrived
  if (data.gridSize) { gs = data.gridSize; hGS = data.gridSize; syncHgsDisplay(); }
  renderLobbyPlayers(data);
}


// ════════════════════════════════════════
//  Heartbeat
// ════════════════════════════════════════

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(async () => {
    if (!currentRoom) return stopHeartbeat();
    await apiCall(`/api/room/${currentRoom}/heartbeat`, 'POST', { id: myId });
  }, 4000);
}

function stopHeartbeat() {
  clearInterval(heartbeatInterval);
  heartbeatInterval = null;
}




// ════════════════════════════════════════
//  Tab switching
// ════════════════════════════════════════

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'browse') loadRooms();
}


// ════════════════════════════════════════
//  Room browser
// ════════════════════════════════════════

async function loadRooms() {
  const label = document.getElementById('roomCountLabel');
  const list  = document.getElementById('roomList');
  label.textContent = 'Loading…';
  list.innerHTML    = '<div class="room-empty"><span class="spinner"></span></div>';

  const data = await apiCall('/api/rooms');
  if (!data || data.error) {
    label.textContent = 'Could not reach server';
    list.innerHTML    = '<div class="room-empty">Cannot connect to server</div>';
    return;
  }

  label.textContent = data.length
    ? `${data.length} room${data.length > 1 ? 's' : ''} available`
    : 'No open rooms';

  list.innerHTML = '';
  if (data.length === 0) {
    list.innerHTML = '<div class="room-empty">No public rooms open.<br>Create one or wait!</div>';
    return;
  }

  data.forEach(r => {
    const item = document.createElement('div');
    item.className = 'room-item';

    const info = document.createElement('div');
    info.className = 'room-info';

    const host = document.createElement('div');
    host.className   = 'room-host';
    host.textContent = r.hostName + "'s room";

    const meta = document.createElement('div');
    meta.className   = 'room-meta';
    meta.textContent = `${r.players}/${r.maxPlayers} players · ${r.gridSize}×${r.gridSize} grid`;

    info.appendChild(host);
    info.appendChild(meta);

    if (r.hasPassword) {
      const lock = document.createElement('span');
      lock.className   = 'lock-icon';
      lock.textContent = '🔒';
      item.appendChild(lock);
    }

    const joinBtn = document.createElement('button');
    joinBtn.className      = 'btn btn-secondary btn-sm';
    joinBtn.style.marginTop = '0';
    joinBtn.textContent    = 'Join';
    joinBtn.addEventListener('click', () => startJoin(r.code, r.hasPassword));

    item.appendChild(info);
    item.appendChild(joinBtn);
    list.appendChild(item);
  });
}

// Entry point for all join attempts
function startJoin(code, hasPassword) {
  const name = document.getElementById('playerName').value.trim();
  if (!name) return showToast('Enter your name first!');
  if (hasPassword) {
    pendingJoin = { code };
    document.getElementById('pwInput').value = '';
    document.getElementById('pwModal').classList.add('show');
    setTimeout(() => document.getElementById('pwInput').focus(), 50);
  } else {
    doJoin(code, '');
  }
}

function closePasswordModal() {
  document.getElementById('pwModal').classList.remove('show');
  pendingJoin = null;
}

function confirmPasswordJoin() {
  if (!pendingJoin) return;
  const code = pendingJoin.code;           // save BEFORE closePasswordModal nulls pendingJoin
  const pw   = document.getElementById('pwInput').value;
  closePasswordModal();
  doJoin(code, pw);
}

async function doJoin(code, password) {
  if (_joining) return;
  const name = document.getElementById('playerName').value.trim().slice(0, 18);
  if (!name) return showToast('Enter your name first!');
  localStorage.setItem('bingo_name', myName = name);

  _joining = true;
  const data = await apiCall(`/api/room/${code}/join`, 'POST',
    { id: myId, name, password });
  _joining = false;

  if (!data || data.error) return showToast(data?.error || 'Could not join room');

  gs          = data.room.gridSize;
  isHost      = false;
  currentRoom = code;
  const me    = data.room.players.find(p => p.id === myId);
  myColor     = me ? me.color : '#fff';
  showLobby(code, data.room);
}


// ════════════════════════════════════════
//  Join by code (browse tab)
// ════════════════════════════════════════

async function joinByCode() {
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  if (code.length !== 4) return showToast('Enter a 4-letter room code!');

  // Fetch room to check if it has a password first
  const room = await apiCall(`/api/room/${code}`);
  if (!room || room.error) return showToast('Room not found!');
  if (room.status !== 'lobby') return showToast('Game already started!');

  startJoin(code, room.hasPassword);
}


// ════════════════════════════════════════
//  Quick join
// ════════════════════════════════════════

async function quickJoin() {
  const name = document.getElementById('playerName').value.trim().slice(0, 18);
  if (!name) return showToast('Enter your name first!');
  localStorage.setItem('bingo_name', myName = name);

  showToast('Finding a room…');
  const res = await apiCall('/api/quickjoin', 'POST', { id: myId });
  if (!res || res.error) return showToast(res?.error || 'No rooms available');
  doJoin(res.code, '');
}


// ════════════════════════════════════════
//  Create room
// ════════════════════════════════════════

function togglePublic() {
  wPublic = !wPublic;
  document.getElementById('publicTog').classList.toggle('on', wPublic);
  document.getElementById('passwordRow').style.display = wPublic ? 'none' : 'block';
}

async function createRoom() {
  if (_creating) return;
  const name = document.getElementById('playerName').value.trim().slice(0, 18);
  if (!name) return showToast('Enter your name!');
  localStorage.setItem('bingo_name', myName = name);

  const pw = wPublic ? '' : (document.getElementById('createPw').value.trim());

  _creating = true;
  const data = await apiCall('/api/room', 'POST', {
    id: myId, name, gridSize: wGS, public: wPublic, password: pw
  });
  _creating = false;

  if (!data || data.error) return showToast(data?.error || 'Error creating room');

  // Clear password field so it doesn't linger for next create attempt
  document.getElementById('createPw').value = '';

  gs          = data.room.gridSize;
  isHost      = true;
  currentRoom = data.code;
  myColor     = data.room.players[0].color;
  hPublic     = data.room.public;
  hPwEnabled  = data.room.hasPassword;
  showLobby(data.code, data.room);
}

function changeGS(delta) {
  wGS = Math.max(5, Math.min(10, wGS + delta));
  document.getElementById('gsDisp').textContent = `${wGS}×${wGS}`;
  document.getElementById('gsMax').textContent  = wGS * wGS;
}
function updateWGS() {
  document.getElementById('gsDisp').textContent = `${wGS}×${wGS}`;
  document.getElementById('gsMax').textContent  = wGS * wGS;
}


// ════════════════════════════════════════
//  Lobby screen
// ════════════════════════════════════════

function showLobby(code, room) {
  showScreen('lobbyScreen');
  document.getElementById('lobbyCode').textContent = code;

  hGS        = room.gridSize;
  hPublic    = room.public;
  hPwEnabled = room.hasPassword;

  syncHgsDisplay();
  syncLobbyToggles();

  const meta = document.getElementById('lobbyMeta');
  meta.textContent = (room.public ? '🌐 Public' : '🔒 Private')
    + (room.hasPassword ? ' · Password protected' : '');

  document.getElementById('hostSettings').style.display = isHost ? 'block' : 'none';
  document.getElementById('hostStart').style.display     = isHost ? 'block' : 'none';
  document.getElementById('guestWait').style.display     = isHost ? 'none'  : 'block';

  renderLobbyPlayers(room);
  startPolling();
  startHeartbeat();
}

function renderLobbyPlayers(room) {
  const ul = document.getElementById('lobbyPlayers');
  ul.innerHTML = '';
  room.players.forEach(p => {
    const li = document.createElement('li');

    // Presence dot
    const dot = document.createElement('span');
    dot.className = 'presence-dot ' + (p.online !== false ? 'online' : 'offline');
    dot.title     = p.online !== false ? 'Online' : 'Offline';

    const av = document.createElement('div');
    av.className     = 'avatar';
    av.style.cssText = `background:${p.color}22;color:${p.color}`;
    av.textContent   = p.name.slice(0, 2).toUpperCase();

    const nm = document.createElement('span');
    nm.textContent = p.name;

    li.appendChild(dot);
    li.appendChild(av);
    li.appendChild(nm);

    if (p.id === room.host) {
      const b = document.createElement('span');
      b.className = 'badge badge-host'; b.textContent = '👑 Host';
      li.appendChild(b);
    } else if (p.id === myId) {
      const b = document.createElement('span');
      b.className = 'badge badge-you'; b.textContent = 'You';
      li.appendChild(b);
    } else if (isHost) {
      // Kick button — only host sees it, only on non-host players
      const kb = document.createElement('button');
      kb.className   = 'kick-btn';
      kb.textContent = '✕';
      kb.title       = `Remove ${p.name}`;
      kb.addEventListener('click', () => kickPlayer(p.id));
      li.appendChild(kb);
    }

    ul.appendChild(li);
  });
}

// ── Lobby host setting helpers ──

function syncHgsDisplay() {
  document.getElementById('hgsDisp').textContent = `${hGS}×${hGS}`;
  document.getElementById('hgsMax').textContent  = hGS * hGS;
}

function syncLobbyToggles() {
  document.getElementById('lobbyPublicTog').classList.toggle('on', hPublic);
  document.getElementById('lobbyPwTog').classList.toggle('on', hPwEnabled);
  document.getElementById('lobbyPwRow').style.display = hPwEnabled ? 'block' : 'none';
}

function pushSettings() {
  clearTimeout(settingsDebounce);
  settingsDebounce = setTimeout(async () => {
    const pw = hPwEnabled
      ? (document.getElementById('lobbyPwInput').value.trim())
      : '';
    const data = await apiCall(`/api/room/${currentRoom}/settings`, 'POST', {
      id: myId, gridSize: hGS, public: hPublic, password: pw
    });
    if (data && !data.error) {
      const meta = document.getElementById('lobbyMeta');
      meta.textContent = (data.public ? '🌐 Public' : '🔒 Private')
        + (data.hasPassword ? ' · Password protected' : '');
    }
  }, 400);
}

function changeHostGS(delta) {
  hGS = Math.max(5, Math.min(10, hGS + delta));
  syncHgsDisplay();
  pushSettings();
}

function toggleLobbyPublic() {
  hPublic = !hPublic;
  syncLobbyToggles();
  pushSettings();
}

function toggleLobbyPassword() {
  hPwEnabled = !hPwEnabled;
  syncLobbyToggles();
  if (hPwEnabled) setTimeout(() => document.getElementById('lobbyPwInput').focus(), 50);
  pushSettings();
}

function updateLobbyPassword() {
  // pushSettings already debounces at 400ms — no need to wrap it again
  pushSettings();
}

async function startGame() {
  if (_starting) return;
  _starting = true;
  const data = await apiCall(`/api/room/${currentRoom}/start`, 'POST', { id: myId });
  _starting = false;
  if (!data || data.error) showToast(data?.error || 'Error starting game');
}


// ════════════════════════════════════════
//  Setup screen
// ════════════════════════════════════════

function showSetup(room) {
  gs = room.gridSize;
  showScreen('setupScreen');
  document.getElementById('setupTitle').textContent = `Fill your ${gs}×${gs} grid`;
  document.getElementById('setupHint').textContent  = `Numbers 1–${gs * gs}`;
  setupCard = new Array(gs * gs).fill(0);
  cardSubmitted = false;
  selPoolNum    = null;
  _submitting   = false;
  // Reset DOM visibility — submitCard() hides readyBtn and shows setupWait;
  // those inline styles persist across rounds so we must explicitly undo them.
  document.getElementById('readyBtn').style.display  = 'block';
  document.getElementById('setupWait').style.display = 'none';
  renderSetupGrid(); renderNumPool(); checkReadyBtn();
}

function renderSetupGrid() {
  const grid = document.getElementById('setupGrid');
  const px   = Math.min(60, Math.floor(Math.min(window.innerWidth - 80, 380) / gs));
  grid.style.gridTemplateColumns = `repeat(${gs}, ${px}px)`;
  grid.innerHTML = '';
  for (let i = 0; i < gs * gs; i++) {
    const cell = document.createElement('div');
    cell.className    = 'setup-cell' + (setupCard[i] ? ' filled' : '');
    cell.style.cssText = `width:${px}px;height:${px}px;font-size:${Math.max(10, Math.floor(px * .36))}px`;
    cell.textContent  = setupCard[i] || '';
    cell.dataset.i    = i;
    cell.addEventListener('click', () => clickSetupCell(i));
    grid.appendChild(cell);
  }
}

function renderNumPool() {
  const pool   = document.getElementById('numPool');
  const total  = gs * gs;
  const usedSet = new Set(setupCard.filter(x => x > 0));
  pool.innerHTML = '';
  for (let num = 1; num <= total; num++) {
    const chip = document.createElement('div');
    chip.className   = 'nchip'
      + (usedSet.has(num)   ? ' used' : '')
      + (num === selPoolNum ? ' sel'  : '');
    chip.textContent = num;
    chip.addEventListener('click', () => pickPoolNum(num));
    pool.appendChild(chip);
  }
}

function pickPoolNum(num) {
  if (new Set(setupCard.filter(x => x > 0)).has(num)) return;
  selPoolNum = selPoolNum === num ? null : num;
  renderNumPool();
  document.querySelectorAll('.setup-cell:not(.filled)').forEach(c =>
    c.classList.toggle('drop-target', selPoolNum !== null)
  );
}

function clickSetupCell(idx) {
  if (cardSubmitted) return;
  if (selPoolNum !== null && !setupCard[idx]) {
    setupCard[idx] = selPoolNum; selPoolNum = null;
    renderSetupGrid(); renderNumPool(); checkReadyBtn();
  } else if (setupCard[idx]) {
    setupCard[idx] = 0;
    renderSetupGrid(); renderNumPool(); checkReadyBtn();
  }
}

function randomFill() {
  const total  = gs * gs;
  const usedSet = new Set(setupCard.filter(x => x > 0));
  const rem    = [];
  for (let i = 1; i <= total; i++) if (!usedSet.has(i)) rem.push(i);
  for (let i = rem.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rem[i], rem[j]] = [rem[j], rem[i]];
  }
  let ri = 0;
  for (let i = 0; i < setupCard.length; i++) if (!setupCard[i]) setupCard[i] = rem[ri++];
  selPoolNum = null;
  renderSetupGrid(); renderNumPool(); checkReadyBtn();
}

function clearAll() {
  setupCard = new Array(gs * gs).fill(0); selPoolNum = null;
  renderSetupGrid(); renderNumPool(); checkReadyBtn();
}

function checkReadyBtn() {
  const ok  = setupCard.every(x => x > 0);
  const btn = document.getElementById('readyBtn');
  btn.disabled      = !ok;
  btn.style.opacity = ok ? '1' : '.5';
}

async function submitCard() {
  if (cardSubmitted || _submitting) return;
  if (!setupCard.every(x => x > 0)) return showToast('Fill all cells!');
  _submitting = true; cardSubmitted = true; myCard = [...setupCard];
  document.getElementById('readyBtn').style.display  = 'none';
  document.getElementById('setupWait').style.display = 'block';

  const data = await apiCall(`/api/room/${currentRoom}/submit-card`, 'POST',
    { id: myId, card: myCard });
  _submitting = false;

  if (!data || data.error) {
    cardSubmitted = false;
    document.getElementById('readyBtn').style.display  = 'block';
    document.getElementById('setupWait').style.display = 'none';
    return showToast(data?.error || 'Error submitting');
  }
  if (data.status === 'playing') showGame(data);
}


// ════════════════════════════════════════
//  Game screen
// ════════════════════════════════════════

function showGame(room) {
  showScreen('gameScreen');
  gs = room.gridSize;
  document.getElementById('gRoomCode').textContent   = currentRoom;
  document.getElementById('gPlayerPill').textContent = '👤 ' + myName;
  lastCalledLen = 0; lastChatLen = 0; lastRankLen = 0;
  myPrevLines = 0; selPickNum = null; _marking = false;
  startHeartbeat();   // ensure heartbeat runs even when we arrive here via poll (not showLobby)
  buildHeader(); buildGrid(room); updateGame(room);
}

function cellPx() {
  // On desktop side-by-side, board max ~380px; on mobile full width
  const avail = window.innerWidth >= 900
    ? Math.min(380, window.innerWidth - 320)
    : window.innerWidth - 40;
  return Math.min(58, Math.floor(avail / gs));
}

function buildHeader() {
  const header = document.getElementById('gHeader');
  const labels = ['B','I','N','G','O'];
  const px     = cellPx();
  header.style.gridTemplateColumns = `repeat(${gs}, ${px}px)`;
  header.innerHTML = '';
  for (let c = 0; c < gs; c++) {
    const div = document.createElement('div');
    div.className    = 'h-' + labels[c % 5];
    div.textContent  = labels[c % 5];
    div.style.cssText = `width:${px}px;font-size:${Math.max(12, Math.floor(px * .48))}px`;
    header.appendChild(div);
  }
}

function buildGrid(room) {
  const grid   = document.getElementById('gGrid');
  const me     = room.players.find(p => p.id === myId);
  const marked = new Set(me ? me.markedNumbers : []);
  const called = new Set(room.calledNumbers);
  const px     = cellPx();
  grid.style.gridTemplateColumns = `repeat(${gs}, ${px}px)`;
  grid.innerHTML = '';
  for (let i = 0; i < gs * gs; i++) {
    const num  = myCard[i];
    const cell = document.createElement('div');
    cell.className    = 'gcell'
      + (marked.has(num) ? ' marked' : called.has(num) ? ' called' : '');
    cell.style.cssText = `width:${px}px;height:${px}px;font-size:${Math.max(9, Math.floor(px * .35))}px`;
    cell.textContent  = num;
    cell.dataset.i    = i;
    cell.addEventListener('click', () => clickCell(num));
    grid.appendChild(cell);
  }
}

function clickCell(num) {
  if (!_room || _room.status === 'ended') return;
  if (!_room.calledNumbers.includes(num)) return showToast(`${num} not called yet!`);
  doMark(num);
}

async function doMark(num) {
  if (_marking) return;
  _marking = true;
  const data = await apiCall(`/api/room/${currentRoom}/mark`, 'POST', { id: myId, number: num });
  _marking = false;
  if (data && !data.error) updateGame(data);
}

function updateGame(room) {
  _room = room;
  const me      = room.players.find(p => p.id === myId);
  if (!me) return;

  const called    = room.calledNumbers;
  const marked    = new Set(me.markedNumbers);
  const calledSet = new Set(called);
  const px        = cellPx();

  // ── Grid ──
  document.querySelectorAll('.gcell').forEach(cell => {
    const num = myCard[parseInt(cell.dataset.i)];
    cell.style.cssText = `width:${px}px;height:${px}px;font-size:${Math.max(9, Math.floor(px * .35))}px`;
    if      (marked.has(num))    cell.className = 'gcell marked';
    else if (calledSet.has(num)) cell.className = 'gcell called';
    else                         cell.className = 'gcell';
  });

  // ── Auto-mark ──
  if (autoMark && called.length > lastCalledLen) {
    const n = called.slice(lastCalledLen).find(
      v => myCard.includes(v) && !me.markedNumbers.includes(v)
    );
    if (n !== undefined) doMark(n);
  }
  lastCalledLen = called.length;

  // ── Turn ──
  const cp   = room.players[room.currentPlayerIdx];
  const mine = cp && cp.id === myId && room.status === 'playing' && me.rank === null;
  const tb   = document.getElementById('turnBox');
  tb.className = 'turn-box ' + (mine ? 'mine' : 'other');
  document.getElementById('turnName').textContent = mine ? '🎯 YOUR TURN!'
    : cp ? `⏳ ${cp.name}` : '—';
  document.getElementById('turnHint').textContent = mine ? 'Pick a number to call'
    : room.status === 'playing' ? 'choosing a number…' : '';

  // ── Picker ──
  document.getElementById('picker').className = 'picker' + (mine ? ' show' : '');
  if (mine) buildPicker(room);

  // ── Last called ──
  if (called.length > 0) {
    document.getElementById('lastBox').style.display = 'block';
    const last   = called[called.length - 1];
    const lastEl = document.getElementById('lastNum');
    if (lastEl.textContent !== String(last)) lastEl.textContent = last;
    document.getElementById('calledCnt').textContent =
      `${called.length} / ${gs * gs} called`;
  }

  // ── Chips ──
  const chips = document.getElementById('calledChips');
  chips.innerHTML = '';
  [...called].reverse().forEach((n, i) => {
    const c = document.createElement('div');
    c.className = 'chip' + (i === 0 ? ' new' : '');
    c.textContent = n;
    chips.appendChild(c);
  });

  // ── Progress ──
  const pl = document.getElementById('progressList');
  pl.innerHTML = '';
  room.players.forEach(p => {
    const row  = document.createElement('div'); row.className = 'prow';
    const nm   = document.createElement('div'); nm.className = 'pname';
    nm.style.color  = p.color;
    nm.textContent  = p.name + (p.id === myId ? ' ★' : '');
    const pips = document.createElement('div'); pips.className = 'pips';
    for (let i = 0; i < 5; i++) {
      const pip = document.createElement('div');
      pip.className = 'pip' + (i < p.bingoLines ? ' on' : '');
      pips.appendChild(pip);
    }
    const cnt = document.createElement('span');
    cnt.style.cssText = 'font-size:.68rem;color:var(--muted)';
    cnt.textContent   = `${Math.min(p.bingoLines,5)}/5`;
    row.appendChild(nm); row.appendChild(pips); row.appendChild(cnt);
    pl.appendChild(row);
  });

  // ── Rank popup for self ──
  if (me.bingoLines > myPrevLines) {
    showRankPop(me.rank ? `🏆 BINGO! You're #${me.rank}!` : `🎉 ${me.bingoLines}/5 lines!`);
    myPrevLines = me.bingoLines;
  }

  // ── Others ranked ──
  if (room.rankings.length > lastRankLen) {
    room.rankings.slice(lastRankLen).forEach(r => {
      if (r.id !== myId) showToast(`${r.name} got #${r.rank}!`);
    });
    lastRankLen = room.rankings.length;
  }

  // ── Rankings list ──
  if (room.rankings.length > 0) {
    document.getElementById('rankSec').style.display = 'block';
    const rl = document.getElementById('rankList'); rl.innerHTML = '';
    const medals = ['🥇','🥈','🥉'];
    room.rankings.forEach(r => {
      const row = document.createElement('div'); row.className = 'rrow';
      const m   = document.createElement('span'); m.textContent = medals[r.rank-1] || '#'+r.rank;
      const nm  = document.createElement('span'); nm.style.cssText=`color:${r.color};flex:1`; nm.textContent=r.name;
      const ln  = document.createElement('span'); ln.style.cssText='font-size:.68rem;color:var(--muted)'; ln.textContent=`${r.bingoLines} lines`;
      row.appendChild(m); row.appendChild(nm); row.appendChild(ln);
      rl.appendChild(row);
    });
  }

  // ── Players mini ──
  const pm = document.getElementById('playersMini'); pm.innerHTML = '';
  room.players.forEach(p => {
    const row = document.createElement('div');
    row.style.cssText='display:flex;align-items:center;gap:.38rem;font-size:.76rem;padding:.15rem 0;border-bottom:1px solid rgba(255,255,255,.04)';
    const dot = document.createElement('div');
    // Use green/grey presence colour (same logic as lobby list)
    const onlineColor = p.online !== false ? 'var(--a5)' : 'var(--muted)';
    dot.style.cssText=`width:7px;height:7px;border-radius:50%;background:${onlineColor};flex-shrink:0;opacity:${p.online !== false ? '1' : '0.45'}`;
    dot.title = p.online !== false ? 'Online' : 'Offline';
    const nm = document.createElement('span');
    nm.style.cssText=`color:${p.color};flex:1`; nm.textContent=p.name+(p.id===myId?' (you)':'');
    const sc = document.createElement('span');
    sc.style.color='var(--muted)'; sc.textContent=`${p.bingoLines}/5`;
    row.appendChild(dot); row.appendChild(nm); row.appendChild(sc);
    if (p.rank) {
      const rk=document.createElement('span'); rk.style.color='var(--a4)'; rk.textContent='🏆'+p.rank;
      row.appendChild(rk);
    }
    pm.appendChild(row);
  });

  // ── Chat ──
  if (room.chat.length > lastChatLen) {
    const msgs = document.getElementById('chatMsgs');
    room.chat.slice(lastChatLen).forEach(m => {
      const div = document.createElement('div'); div.className = 'cmsg';
      const cn  = document.createElement('span'); cn.className='cn'; cn.style.color=m.color;
      cn.textContent = m.name + ':';
      div.appendChild(cn);
      div.appendChild(document.createTextNode(' ' + m.message));
      msgs.appendChild(div);
    });
    msgs.scrollTop = msgs.scrollHeight;
    lastChatLen = room.chat.length;
  }

  // ── Game over ──
  if (room.status === 'ended'
      && !document.getElementById('winOverlay').classList.contains('show'))
    showWin(room);
}

function buildPicker(room) {
  const grid      = document.getElementById('pickerNums');
  const calledSet = new Set(room.calledNumbers);
  const total     = gs * gs;
  grid.innerHTML  = '';
  for (let i = 1; i <= total; i++) {
    const chip = document.createElement('div');
    chip.className   = 'pnum'
      + (calledSet.has(i) ? ' done'   : '')
      + (i === selPickNum ? ' picked' : '');
    chip.textContent = i;
    chip.addEventListener('click', () => {
      if (calledSet.has(i)) return;
      selPickNum = selPickNum === i ? null : i;
      document.getElementById('callLbl').textContent   = selPickNum || '?';
      document.getElementById('callBar').style.display = selPickNum ? 'block' : 'none';
      buildPicker(room);
    });
    grid.appendChild(chip);
  }
}

async function confirmCall() {
  if (!selPickNum || _calling) return;
  const num = selPickNum; selPickNum = null; _calling = true;
  document.getElementById('callBar').style.display = 'none';
  const data = await apiCall(`/api/room/${currentRoom}/call`, 'POST', { id: myId, number: num });
  _calling = false;
  if (!data || data.error) return showToast(data?.error || 'Error');
  updateGame(data);
}

function toggleAutoMark() {
  autoMark = !autoMark;
  document.getElementById('amTog').className = 'tog' + (autoMark ? ' on' : '');
  if (autoMark && _room) {
    const me = _room.players.find(p => p.id === myId);
    if (me) {
      const n = _room.calledNumbers.find(v => myCard.includes(v) && !me.markedNumbers.includes(v));
      if (n !== undefined) doMark(n);
    }
  }
}


// ════════════════════════════════════════
//  Chat
// ════════════════════════════════════════

async function sendChat() {
  const inp = document.getElementById('chatIn');
  const msg = inp.value.trim().slice(0, 200);
  if (!msg) return;
  inp.value = '';
  await apiCall(`/api/room/${currentRoom}/chat`, 'POST', { id: myId, message: msg });
}


// ════════════════════════════════════════
//  Win overlay
// ════════════════════════════════════════

function showWin(room) {
  clearInterval(pollInterval); pollInterval = null;
  document.getElementById('winOverlay').classList.add('show');
  const fl = document.getElementById('finalList'); fl.innerHTML = '';
  const medals = ['🥇','🥈','🥉'];
  room.rankings.forEach(r => {
    const item = document.createElement('div'); item.className = 'fitem';
    const med  = document.createElement('div'); med.className='fmed'; med.textContent=medals[r.rank-1]||'#'+r.rank;
    const nm   = document.createElement('div'); nm.style.cssText=`color:${r.color};flex:1;font-weight:700`;
    nm.textContent = r.name + (r.id===myId?' (you)':'');
    const ln   = document.createElement('div'); ln.style.cssText='font-size:.8rem;color:var(--muted)';
    ln.textContent = `${r.bingoLines} lines`;
    item.appendChild(med); item.appendChild(nm); item.appendChild(ln);
    fl.appendChild(item);
  });
  const me = room.rankings.find(r => r.id === myId);
  if (me && me.rank === 1) launchConfetti();
}

async function playAgain() {
  document.getElementById('winOverlay').classList.remove('show');

  if (isHost) {
    // Host resets the room and goes straight to lobby
    const data = await apiCall(`/api/room/${currentRoom}/reset`, 'POST', { id: myId });
    if (!data || data.error) return showToast(data?.error || 'Error resetting room');
    myCard=[]; lastCalledLen=0; lastChatLen=0; lastRankLen=0; myPrevLines=0;
    showLobby(currentRoom, data);
  } else {
    // Guest: reset counters and navigate to lobby screen to wait.
    // Staying on the game screen caused a loop:
    //   poll sees ended+inGame → updateGame → showWin → poll killed → stuck.
    // By moving to lobby, the poll does nothing until host resets
    // (status 'ended' + inLobby has no handler), then when status flips to
    // 'lobby' the poll renders the updated player list automatically.
    myCard=[]; lastCalledLen=0; lastChatLen=0; lastRankLen=0; myPrevLines=0;
    showLobby(currentRoom, _room);   // _room = last known room state
  }
}


// ════════════════════════════════════════
//  Polling
// ════════════════════════════════════════

function startPolling() {
  clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    if (!currentRoom) return;
    const room = await apiCall(`/api/room/${currentRoom}`);

    // Room deleted (host left, or 404) — kick everyone to main menu
    if (!room || room.error) {
      const inGame  = document.getElementById('gameScreen').classList.contains('active');
      const inLobby = document.getElementById('lobbyScreen').classList.contains('active');
      const inSetup = document.getElementById('setupScreen').classList.contains('active');
      const winOpen = document.getElementById('winOverlay').classList.contains('show');
      if (inGame || inLobby || inSetup || winOpen) {
        stopHeartbeat();
        clearInterval(pollInterval); pollInterval = null;
        document.getElementById('winOverlay').classList.remove('show');
        currentRoom = null; isHost = false; myCard = [];
        showScreen('welcomeScreen');
        loadRooms();
        showToast('Room closed — returning to main menu');
      }
      return;
    }

    const inLobby = document.getElementById('lobbyScreen').classList.contains('active');
    const inSetup = document.getElementById('setupScreen').classList.contains('active');
    const inGame  = document.getElementById('gameScreen').classList.contains('active');
    const winOpen = document.getElementById('winOverlay').classList.contains('show');

    // Detect if WE were kicked (player no longer in room)
    if (!room.players.find(p => p.id === myId)) {
      stopHeartbeat();
      clearInterval(pollInterval); pollInterval = null;
      document.getElementById('winOverlay').classList.remove('show');
      currentRoom = null; isHost = false; myCard = [];
      showScreen('welcomeScreen');
      loadRooms();
      showToast('You were removed from the room');
      return;
    }

    if (room.status === 'lobby') {
      if (inLobby) {
        renderLobbyPlayers(room); gs = room.gridSize;
      } else if (inSetup || inGame || winOpen) {
        // Host reset — everyone returns to lobby
        document.getElementById('winOverlay').classList.remove('show');
        myCard=[]; lastCalledLen=0; lastChatLen=0; lastRankLen=0; myPrevLines=0;
        gs = room.gridSize;
        showLobby(currentRoom, room);
      }
    } else if (room.status === 'setup') {
      if (inLobby) { gs = room.gridSize; showSetup(room); }
    } else if (room.status === 'playing') {
      if (inSetup && myCard.length > 0) showGame(room);
      else if (inGame)                  updateGame(room);
    } else if (room.status === 'ended') {
      if (inGame && !winOpen) updateGame(room);
      else if (inSetup)       showWin(room);
    }
  }, 1500);
}


// ════════════════════════════════════════
//  Utilities
// ════════════════════════════════════════

function showScreen(id) {
  document.querySelectorAll('div.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

function showRankPop(msg) {
  const p = document.getElementById('rankPop');
  p.textContent = msg; p.classList.add('show');
  setTimeout(() => p.classList.remove('show'), 3000);
}

function launchConfetti() {
  const c = document.getElementById('confC');
  c.innerHTML = '';
  const cols = ['#f72585','#4cc9f0','#06d6a0','#f8961e','#7209b7','#fff'];
  for (let i = 0; i < 100; i++) {
    const el = document.createElement('div');
    const col = cols[Math.floor(Math.random() * cols.length)];
    const sz  = Math.random() * 9 + 5;
    el.style.cssText = [
      'position:absolute',
      `left:${Math.random()*100}%`,
      'top:-18px',
      `width:${sz}px`, `height:${sz*.5}px`,
      `background:${col}`,
      'border-radius:2px',
      `transform:rotate(${Math.random()*360}deg)`,
      `animation:cfall ${Math.random()*2+2}s ${Math.random()*1.5}s ease-in forwards`,
    ].join(';');
    c.appendChild(el);
  }
  if (!document.getElementById('cstyle')) {
    const s = document.createElement('style'); s.id = 'cstyle';
    s.textContent = '@keyframes cfall{to{top:110%;transform:rotate(720deg) translateX(50px)}}';
    document.head.appendChild(s);
  }
}
