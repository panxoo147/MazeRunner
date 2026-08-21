// game.js — client: lobby UI + maze rendering + mouse-cursor movement/collision.
// Movement & wall collision run entirely on the client for smoothness; the
// server only relays throttled position snapshots and validates finishes.

(() => {
  'use strict';

  const socket = io();
  // Opt-in, read/write debug bridge for automated testing — only active
  // with ?debug=1 in the URL, never wired up for normal play.
  const DEBUG = new URLSearchParams(location.search).has('debug');

  // ---------- generic screen helpers ----------
  const screens = {
    home: document.getElementById('screen-home'),
    lobby: document.getElementById('screen-lobby'),
    game: document.getElementById('screen-game'),
    results: document.getElementById('screen-results'),
  };
  function showScreen(name) {
    Object.values(screens).forEach((el) => el.classList.remove('active'));
    screens[name].classList.add('active');
  }

  // ---------- state ----------
  let selfId = null;
  let currentLobby = null; // last lobbyUpdate payload
  let isSpectator = false; // derived from currentLobby's own entry — spectators watch only, no character
  let maze = null;
  let raceStartAt = null;
  let raceActive = false;
  let selfFinished = false;
  let finishSent = false;
  const otherPlayers = new Map(); // id -> {x,y,color,name,finished}
  const local = { x: 0, y: 0 };
  let wallPath = null;
  let miniCanvasCache = null; // offscreen canvas with pre-rendered maze
  let miniScale = 1;
  let liveLeaderboard = [];

  // ---------- power-up items ("พลิกเกม" game-changer mechanic) ----------
  const ITEM_INFO = {
    turbo: { icon: '⚡', label: 'เร่งความเร็ว', fx: 'fx-turbo', color: '0,210,168' },
    confuse: { icon: '🌀', label: 'กวนใจคู่แข่ง', fx: 'fx-confuse', color: '255,90,106' },
    reveal: { icon: '🧭', label: 'เข็มทิศ', fx: 'fx-reveal', color: '255,209,102' },
  };
  const itemsById = new Map(); // itemId -> {id,x,y,type,collected}
  const pendingCollect = new Set(); // itemIds we've asked the server about but haven't heard back on yet
  let heldItem = null; // type string or null
  const activeEffects = { turbo: 0, reveal: 0, confuse: 0 }; // type -> timestamp (ms) the effect ends
  let revealPath = null; // array of {x,y} pixel points from the moment 'reveal' activated
  let effectFxTimer = null;

  const PLAYER_RADIUS = 11; // local player's size — also drives wall-collision, so leave this alone
  const OTHER_PLAYER_RADIUS = 6; // smaller + drawn translucent, so a crowd of other players never hides the maze or your own dot

  function idJitter(id, radius) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    const angle = (hash % 360) * (Math.PI / 180);
    const frac = 0.25 + ((hash >> 5) % 100) / 150; // 0.25 - ~0.9 of radius
    return { dx: Math.cos(angle) * radius * frac, dy: Math.sin(angle) * radius * frac };
  }

  // ---------- HOME screen ----------
  const inputName = document.getElementById('input-name');
  const inputCode = document.getElementById('input-code');
  const inputSpectator = document.getElementById('input-spectator');
  const homeError = document.getElementById('home-error');

  const savedName = sessionStorage.getItem('mazerace_name');
  if (savedName) inputName.value = savedName;

  function getName() {
    const v = inputName.value.trim();
    if (v) sessionStorage.setItem('mazerace_name', v);
    return v || 'Player';
  }

  // ---------- control mode (mouse-cursor / WASD / touch joystick) ----------
  // A per-player local preference — movement is fully client-authoritative,
  // so each player can pick whichever scheme they like independently.
  const isTouchDevice = window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window;
  const CONTROL_MODES = ['mouse', 'wasd', 'touch'];
  let controlMode = sessionStorage.getItem('mazerace_control') || (isTouchDevice ? 'touch' : 'mouse');
  if (!CONTROL_MODES.includes(controlMode)) controlMode = 'mouse';
  const controlToggle = document.getElementById('control-toggle');
  const hudControlBtn = document.getElementById('hud-control-toggle');
  const CONTROL_LABEL = { mouse: '🖱️ เมาส์', wasd: '⌨️ WASD', touch: '📱 จอย' };

  function setControlMode(mode) {
    controlMode = CONTROL_MODES.includes(mode) ? mode : 'mouse';
    sessionStorage.setItem('mazerace_control', controlMode);
    controlToggle.querySelectorAll('.control-opt').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === controlMode);
    });
    hudControlBtn.textContent = CONTROL_LABEL[controlMode];
    // reset held keys / joystick whenever we switch modes mid-race so an
    // old input doesn't stay "stuck" after flipping to a different scheme
    keys.w = keys.a = keys.s = keys.d = false;
    joystickEnd();
  }

  controlToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.control-opt');
    if (btn) setControlMode(btn.dataset.mode);
  });
  hudControlBtn.addEventListener('click', () => {
    setControlMode(CONTROL_MODES[(CONTROL_MODES.indexOf(controlMode) + 1) % CONTROL_MODES.length]);
  });

  document.getElementById('btn-create').addEventListener('click', () => {
    homeError.textContent = '';
    socket.emit('createLobby', { name: getName(), spectator: inputSpectator.checked }, (res) => {
      if (!res.ok) { homeError.textContent = res.error || 'สร้างห้องไม่สำเร็จ'; return; }
      selfId = res.selfId;
      applyLobby(res.lobby);
      showScreen('lobby');
    });
  });

  document.getElementById('btn-join').addEventListener('click', joinLobby);
  inputCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinLobby(); });
  inputCode.addEventListener('input', () => { inputCode.value = inputCode.value.toUpperCase(); });

  function joinLobby() {
    homeError.textContent = '';
    const code = inputCode.value.trim().toUpperCase();
    if (!code) { homeError.textContent = 'กรอกโค้ดห้องก่อน'; return; }
    socket.emit('joinLobby', { code, name: getName(), spectator: inputSpectator.checked }, (res) => {
      if (!res.ok) { homeError.textContent = res.error || 'เข้าห้องไม่สำเร็จ'; return; }
      selfId = res.selfId;
      applyLobby(res.lobby);
      // A spectator can join a lobby that's already mid-race or showing
      // results — bootstrap straight into the right screen instead of the
      // (blocked-for-racers) waiting room.
      if (res.lobby.state === 'results' && res.standings) {
        showResults(res.standings);
      } else if ((res.lobby.state === 'countdown' || res.lobby.state === 'racing') && res.maze) {
        startRaceView(res.maze, res.raceStartAt, res.lobby.players);
      } else {
        showScreen('lobby');
      }
    });
  }

  // ---------- LOBBY screen ----------
  const lobbyCodeEl = document.getElementById('lobby-code');
  const lobbyCountEl = document.getElementById('lobby-count');
  const lobbyMaxEl = document.getElementById('lobby-max');
  const lobbySpectatorCountEl = document.getElementById('lobby-spectator-count');
  const playerListEl = document.getElementById('player-list');
  const btnStart = document.getElementById('btn-start');
  const lobbyWaitMsg = document.getElementById('lobby-wait-msg');
  const btnToggleSpectator = document.getElementById('btn-toggle-spectator');

  function applyLobby(lobby) {
    currentLobby = lobby;
    lobbyCodeEl.textContent = lobby.code;
    lobbyMaxEl.textContent = lobby.maxPlayers;
    renderPlayerList(lobby);
  }

  function renderPlayerList(lobby) {
    const racers = lobby.players.filter((p) => !p.isSpectator);
    const spectators = lobby.players.filter((p) => p.isSpectator);
    lobbyCountEl.textContent = racers.length;
    lobbySpectatorCountEl.textContent = spectators.length ? `(+ ${spectators.length} ผู้ชม)` : '';
    playerListEl.innerHTML = '';
    for (const p of lobby.players) {
      const chip = document.createElement('div');
      chip.className = 'player-chip' + (p.isSpectator ? ' is-spectator' : '');
      const dot = p.isSpectator ? '' : `<span class="player-dot" style="background:${p.color}"></span>`;
      const badge = p.isSpectator ? '<span class="spectator-badge">👁️</span>' : (p.isHost ? '<span class="host-badge">HOST</span>' : '');
      chip.innerHTML = `${dot}<span>${escapeHtml(p.name)}</span>${badge}`;
      playerListEl.appendChild(chip);
    }
    const me = lobby.players.find((p) => p.id === selfId);
    isSpectator = !!(me && me.isSpectator);
    const isHost = lobby.hostId === selfId;
    btnStart.style.display = isHost ? 'block' : 'none';
    lobbyWaitMsg.style.display = isHost ? 'none' : 'block';
    btnToggleSpectator.textContent = isSpectator ? '🎮 สลับกลับมาเล่น' : '👁️ สลับเป็นผู้ชม';
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  document.getElementById('btn-start').addEventListener('click', () => socket.emit('startRace'));
  btnToggleSpectator.addEventListener('click', () => socket.emit('setSpectator', { spectator: !isSpectator }));
  document.getElementById('btn-copy-code').addEventListener('click', () => {
    if (currentLobby) navigator.clipboard?.writeText(currentLobby.code).catch(() => {});
  });
  document.getElementById('btn-leave-lobby').addEventListener('click', leaveToHome);
  document.getElementById('btn-leave-results').addEventListener('click', leaveToHome);

  function leaveToHome() {
    socket.emit('leaveLobby');
    currentLobby = null;
    maze = null;
    raceActive = false;
    showScreen('home');
  }

  socket.on('lobbyUpdate', (lobby) => {
    if (!currentLobby || lobby.code !== currentLobby.code) currentLobby = lobby;
    else currentLobby = lobby;
    if (screens.lobby.classList.contains('active')) renderPlayerList(lobby);
    else if (!screens.game.classList.contains('active')) { applyLobby(lobby); }
  });

  // ---------- GAME screen ----------
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const miniCanvas = document.getElementById('minimap-canvas');
  const miniCtx = miniCanvas.getContext('2d');
  const countdownOverlay = document.getElementById('countdown-overlay');
  const countdownNumber = document.getElementById('countdown-number');
  const hudTimer = document.getElementById('hud-timer');
  const hudStatus = document.getElementById('hud-status');
  const hudLeaderboard = document.getElementById('hud-leaderboard');
  const itemToast = document.getElementById('item-toast');
  const hudItemPanel = document.getElementById('hud-item-panel');
  const hudItemIcon = document.getElementById('hud-item-icon');
  const hudItemName = document.getElementById('hud-item-name');
  const btnUseItem = document.getElementById('btn-use-item');

  let toastTimer = null;
  function showToast(text) {
    itemToast.textContent = text;
    itemToast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => itemToast.classList.remove('show'), 2600);
  }

  function setHeldItem(type) {
    heldItem = type;
    if (type) {
      const info = ITEM_INFO[type];
      hudItemIcon.textContent = info.icon;
      hudItemName.textContent = info.label;
      hudItemPanel.classList.remove('hidden');
    } else {
      hudItemPanel.classList.add('hidden');
    }
  }

  function useHeldItem() {
    if (!heldItem || !raceActive || selfFinished) return;
    socket.emit('useItem');
    setHeldItem(null); // optimistic — server already validated we held one
  }
  btnUseItem.addEventListener('click', useHeldItem);

  function applyEffectVisual(fxClass, duration) {
    screens.game.classList.remove('fx-turbo', 'fx-reveal', 'fx-confuse');
    // reflow so re-adding the same class restarts its CSS animation
    void screens.game.offsetWidth;
    screens.game.classList.add(fxClass);
    clearTimeout(effectFxTimer);
    effectFxTimer = setTimeout(() => screens.game.classList.remove(fxClass), duration);
  }

  function computeShortestPathToExit(startX, startY) {
    const cs = maze.cellSize;
    const sx = Math.max(0, Math.min(maze.cols - 1, Math.floor(startX / cs)));
    const sy = Math.max(0, Math.min(maze.rows - 1, Math.floor(startY / cs)));
    const ex = Math.max(0, Math.min(maze.cols - 1, Math.floor(maze.exitZone.x / cs)));
    const ey = Math.max(0, Math.min(maze.rows - 1, Math.floor(maze.exitZone.y / cs)));
    const visited = Array.from({ length: maze.rows }, () => new Array(maze.cols).fill(false));
    const prevX = Array.from({ length: maze.rows }, () => new Array(maze.cols).fill(-1));
    const prevY = Array.from({ length: maze.rows }, () => new Array(maze.cols).fill(-1));
    visited[sy][sx] = true;
    const queue = [[sx, sy]];
    while (queue.length) {
      const [x, y] = queue.shift();
      if (x === ex && y === ey) break;
      const nbrs = [];
      if (!maze.hWalls[y][x]) nbrs.push([x, y - 1]);
      if (!maze.hWalls[y + 1][x]) nbrs.push([x, y + 1]);
      if (!maze.vWalls[y][x]) nbrs.push([x - 1, y]);
      if (!maze.vWalls[y][x + 1]) nbrs.push([x + 1, y]);
      for (const [nx, ny] of nbrs) {
        if (nx < 0 || ny < 0 || nx >= maze.cols || ny >= maze.rows || visited[ny][nx]) continue;
        visited[ny][nx] = true;
        prevX[ny][nx] = x; prevY[ny][nx] = y;
        queue.push([nx, ny]);
      }
    }
    if (!visited[ey][ex]) return [];
    const path = [];
    let cx = ex, cy = ey;
    while (!(cx === sx && cy === sy) && cx !== -1) {
      path.push({ x: (cx + 0.5) * cs, y: (cy + 0.5) * cs });
      const px = prevX[cy][cx], py = prevY[cy][cx];
      cx = px; cy = py;
    }
    path.push({ x: (sx + 0.5) * cs, y: (sy + 0.5) * cs });
    path.reverse();
    return path;
  }

  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let cssW = window.innerWidth, cssH = window.innerHeight;
  function resizeCanvas() {
    cssW = window.innerWidth; cssH = window.innerHeight;
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  const mouse = { x: cssW / 2, y: cssH / 2 };
  // Track on window (not the canvas) so the pointer position keeps updating
  // even while the cursor is over an absolutely-positioned HUD panel
  // (timer, leaderboard, minimap) that visually sits on top of the canvas —
  // otherwise movement would "stick"/lag whenever the mouse crossed those
  // boxes, which read as the character not tracking the cursor properly.
  window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  window.addEventListener('touchmove', (e) => {
    if (e.touches[0]) { mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; }
    if (screens.game.classList.contains('active')) e.preventDefault();
  }, { passive: false });

  // ---------- WASD input ----------
  const keys = { w: false, a: false, s: false, d: false };
  const KEY_MAP = {
    w: 'w', ArrowUp: 'w',
    a: 'a', ArrowLeft: 'a',
    s: 's', ArrowDown: 's',
    d: 'd', ArrowRight: 'd',
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'm' || e.key === 'M') {
      if (screens.game.classList.contains('active')) {
        setControlMode(CONTROL_MODES[(CONTROL_MODES.indexOf(controlMode) + 1) % CONTROL_MODES.length]);
      }
      return;
    }
    // only capture WASD/arrows/space while actually on the game screen, so
    // typing "w"/"a"/"s"/"d" or hitting space in the name/code fields is unaffected
    if (!screens.game.classList.contains('active')) return;
    if (e.key === ' ' || e.code === 'Space') {
      useHeldItem();
      e.preventDefault();
      return;
    }
    const mapped = KEY_MAP[e.key];
    if (!mapped) return;
    keys[mapped] = true;
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    const mapped = KEY_MAP[e.key];
    if (!mapped) return;
    keys[mapped] = false;
  });
  // if the tab loses focus mid-race, drop any held keys so the character
  // doesn't keep "walking" forever into a wall
  window.addEventListener('blur', () => { keys.w = keys.a = keys.s = keys.d = false; });

  // ---------- touch joystick input ----------
  // A dynamic on-screen joystick: appears wherever the player first touches
  // the canvas, drag away from that point to set direction + speed. Bound
  // at the canvas level (not window) so a tap that starts on top of a HUD
  // panel (leaderboard/minimap/timer) never spawns a joystick there — and
  // because touch events stay associated with their original target for
  // the whole gesture, dragging the finger under a HUD box afterward still
  // keeps updating the joystick correctly (no "sticking" like mouse had).
  const joystickBase = document.getElementById('joystick-base');
  const joystickKnob = document.getElementById('joystick-knob');
  const JOY_MAX = 55; // px radius the knob can travel from its base
  const joystick = { active: false, touchId: null, baseX: 0, baseY: 0, dx: 0, dy: 0 };

  function joystickStart(x, y, touchId) {
    joystick.active = true;
    joystick.touchId = touchId;
    joystick.baseX = x;
    joystick.baseY = y;
    joystick.dx = 0;
    joystick.dy = 0;
    joystickBase.style.left = x + 'px';
    joystickBase.style.top = y + 'px';
    joystickBase.classList.remove('hidden');
    joystickKnob.style.left = '50%';
    joystickKnob.style.top = '50%';
  }
  function joystickUpdate(x, y) {
    if (!joystick.active) return;
    let dx = x - joystick.baseX, dy = y - joystick.baseY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > JOY_MAX) { dx = (dx / dist) * JOY_MAX; dy = (dy / dist) * JOY_MAX; }
    joystick.dx = dx; joystick.dy = dy;
    joystickKnob.style.left = 58 + dx + 'px';
    joystickKnob.style.top = 58 + dy + 'px';
  }
  function joystickEnd() {
    joystick.active = false;
    joystick.touchId = null;
    joystick.dx = 0; joystick.dy = 0;
    joystickBase.classList.add('hidden');
  }

  canvas.addEventListener('touchstart', (e) => {
    if (controlMode !== 'touch' || !raceActive || selfFinished || isSpectator) return;
    const t = e.changedTouches[0];
    if (!t) return;
    joystickStart(t.clientX, t.clientY, t.identifier);
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    if (!joystick.active) return;
    for (const t of e.changedTouches) {
      if (t.identifier === joystick.touchId) { joystickUpdate(t.clientX, t.clientY); break; }
    }
    e.preventDefault();
  }, { passive: false });
  function handleTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === joystick.touchId) { joystickEnd(); break; }
    }
  }
  canvas.addEventListener('touchend', handleTouchEnd);
  canvas.addEventListener('touchcancel', handleTouchEnd);

  setControlMode(controlMode); // sync UI + hud label to the saved preference

  function startRaceView(m, rsa, players) {
    maze = m;
    raceStartAt = rsa;
    raceActive = false;
    selfFinished = false;
    finishSent = false;
    keys.w = keys.a = keys.s = keys.d = false;
    joystickEnd();
    otherPlayers.clear();
    liveLeaderboard = [];
    hudLeaderboard.innerHTML = '';

    itemsById.clear();
    for (const it of maze.items) itemsById.set(it.id, { ...it, collected: false });
    pendingCollect.clear();
    setHeldItem(null);
    activeEffects.turbo = activeEffects.reveal = activeEffects.confuse = 0;
    revealPath = null;
    screens.game.classList.remove('fx-turbo', 'fx-reveal', 'fx-confuse');
    screens.game.classList.toggle('spectator-mode', isSpectator);

    for (const p of players) {
      if (p.isSpectator) continue; // spectators aren't racers — no dot, no spawn slot
      const jitter = idJitter(p.id, maze.spawn.radius);
      const x = maze.spawn.x + jitter.dx;
      const y = maze.spawn.y + jitter.dy;
      if (p.id === selfId) {
        local.x = x; local.y = y;
      } else {
        otherPlayers.set(p.id, { x, y, targetX: x, targetY: y, color: p.color, name: p.name, finished: false });
      }
    }

    wallPath = new Path2D();
    for (const s of maze.wallSegments) { wallPath.moveTo(s.x1, s.y1); wallPath.lineTo(s.x2, s.y2); }
    buildMinimapCache();

    showScreen('game');
    resizeCanvas();
    countdownOverlay.classList.remove('hidden');
    hudStatus.textContent = isSpectator ? '👁️ เตรียมชมการแข่งขัน...' : 'เตรียมตัว...';
    requestAnimationFrame(loop);
  }

  socket.on('raceStarting', ({ maze: m, raceStartAt: rsa, players }) => startRaceView(m, rsa, players));

  socket.on('tick', ({ positions }) => {
    for (const p of positions) {
      if (p.id === selfId) continue;
      const o = otherPlayers.get(p.id);
      if (o) { o.targetX = p.x; o.targetY = p.y; }
    }
  });

  socket.on('itemCollected', ({ itemId, type, byId, respawnInMs }) => {
    const item = itemsById.get(itemId);
    if (item) {
      item.collected = true;
      // Timestamps are stamped from the LOCAL clock the instant this event
      // arrives, using only the server-provided duration — avoids any
      // client/server clock-skew issues that an absolute server timestamp
      // would introduce for a purely cosmetic countdown ring.
      item.collectedAt = Date.now();
      item.cooldownMs = respawnInMs;
    }
    pendingCollect.delete(itemId);
    if (byId === selfId) setHeldItem(type);
  });

  // A collected item reappears after its respawn delay — just flip the local
  // flag back; render/pickup-detection already treat !collected as "there".
  socket.on('itemRespawned', ({ itemId }) => {
    const item = itemsById.get(itemId);
    if (item) { item.collected = false; item.collectedAt = null; item.cooldownMs = null; }
  });

  socket.on('itemEffect', ({ type, duration, byName }) => {
    activeEffects[type] = Date.now() + duration;
    applyEffectVisual(ITEM_INFO[type].fx, duration);
    if (type === 'reveal') {
      revealPath = computeShortestPathToExit(local.x, local.y);
      showToast(`🧭 เข็มทิศ! ทางไปทางออกปรากฏขึ้น`);
    } else if (type === 'turbo') {
      showToast(`⚡ เร่งความเร็ว!`);
    } else if (type === 'confuse') {
      showToast(`🌀 ${byName || 'ใครบางคน'} ทำให้คุณสับสน! ควบคุมกลับด้าน`);
    }
  });

  socket.on('itemUsed', ({ byId, byName, type, targetName }) => {
    const info = ITEM_INFO[type];
    if (type === 'confuse') {
      // shown to everyone, including the attacker — the target gets their
      // own more specific toast from the 'itemEffect' handler above
      showToast(targetName ? `${info.icon} ${byName} ทำให้ ${targetName} สับสน!` : `${info.icon} ${byName} ใช้ ${info.label} แต่ไม่มีเป้าหมาย`);
    } else if (byId !== selfId) {
      // self already saw their own toast via 'itemEffect' — this is just
      // ambient flavor for everyone else watching
      showToast(`${info.icon} ${byName} ใช้ ${info.label}`);
    }
  });

  socket.on('playerFinished', ({ id, name, place, finishTime }) => {
    liveLeaderboard.push({ id, name, place, finishTime });
    if (otherPlayers.has(id)) otherPlayers.get(id).finished = true;
    if (id === selfId) {
      selfFinished = true;
      hudStatus.textContent = `เข้าเส้นชัยอันดับที่ ${place}! 🎉`;
      joystickEnd();
    }
    renderLiveLeaderboard();
  });

  function renderLiveLeaderboard() {
    hudLeaderboard.innerHTML = '';
    const top = liveLeaderboard.slice(0, 8);
    for (const e of top) {
      const li = document.createElement('li');
      const secs = (e.finishTime / 1000).toFixed(1);
      li.textContent = `${e.name}${e.id === selfId ? ' (คุณ)' : ''} — ${secs}s`;
      hudLeaderboard.appendChild(li);
    }
  }

  const RACE_END_REASON = {
    all_finished: 'ผู้เล่นทุกคนเข้าเส้นชัยแล้ว',
    top_finishers: `ผู้เล่นอันดับ 1-${4} เข้าเส้นชัยแล้ว การแข่งขันจึงจบลง`,
    timeout: 'หมดเวลาการแข่งขัน',
  };

  socket.on('raceEnded', ({ standings, reason }) => {
    raceActive = false;
    showResults(standings, reason);
  });

  function showResults(standings, reason) {
    const reasonEl = document.getElementById('results-reason');
    reasonEl.textContent = RACE_END_REASON[reason] || '';
    const list = document.getElementById('results-list');
    list.innerHTML = '';
    const medals = ['🥇', '🥈', '🥉'];
    standings.forEach((p, idx) => {
      const li = document.createElement('li');
      const medal = p.finished && idx < 3 ? `<span class="medal">${medals[idx]}</span>` : '';
      const timeText = p.finished ? `${(p.finishTime / 1000).toFixed(1)}s` : 'ไม่จบการแข่งขัน';
      li.innerHTML = `${medal}<strong>${escapeHtml(p.name)}${p.id === selfId ? ' (คุณ)' : ''}</strong> — ${timeText}`;
      list.appendChild(li);
    });
    const isHost = currentLobby && currentLobby.hostId === selfId;
    document.getElementById('btn-play-again').style.display = isHost ? 'block' : 'none';
    document.getElementById('btn-back-to-lobby').style.display = isHost ? 'block' : 'none';
    document.getElementById('results-wait-msg').style.display = isHost ? 'none' : 'block';
    showScreen('results');
  }

  document.getElementById('btn-play-again').addEventListener('click', () => socket.emit('startRace'));
  document.getElementById('btn-back-to-lobby').addEventListener('click', () => socket.emit('backToLobby'));

  // Host sent everyone back to the waiting room — applies to every client
  // in the lobby (including the host), so screen transition happens here
  // rather than only in response to that one player's own click.
  socket.on('returnedToLobby', (lobby) => {
    maze = null;
    otherPlayers.clear();
    applyLobby(lobby);
    showScreen('lobby');
  });

  // ---------- collision ----------
  function closestPointOnSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { x: x1, y: y1 };
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return { x: x1 + t * dx, y: y1 + t * dy };
  }

  function resolveAgainstSegment(pos, radius, x1, y1, x2, y2) {
    const wallHalf = maze.wallThickness / 2;
    const cp = closestPointOnSegment(pos.x, pos.y, x1, y1, x2, y2);
    let dx = pos.x - cp.x, dy = pos.y - cp.y;
    let dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = radius + wallHalf;
    if (dist < minDist) {
      if (dist < 1e-4) { dx = 1; dy = 0; dist = 1e-4; }
      const push = minDist - dist;
      pos.x += (dx / dist) * push;
      pos.y += (dy / dist) * push;
    }
  }

  function resolveCollisions(pos, radius) {
    const cs = maze.cellSize;
    const cx = Math.max(0, Math.min(maze.cols - 1, Math.floor(pos.x / cs)));
    const cy = Math.max(0, Math.min(maze.rows - 1, Math.floor(pos.y / cs)));
    for (let iter = 0; iter < 3; iter++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        if (gy < 0 || gy >= maze.rows) continue;
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          if (gx < 0 || gx >= maze.cols) continue;
          if (maze.hWalls[gy][gx]) resolveAgainstSegment(pos, radius, gx * cs, gy * cs, (gx + 1) * cs, gy * cs);
          if (maze.hWalls[gy + 1][gx]) resolveAgainstSegment(pos, radius, gx * cs, (gy + 1) * cs, (gx + 1) * cs, (gy + 1) * cs);
          if (maze.vWalls[gy][gx]) resolveAgainstSegment(pos, radius, gx * cs, gy * cs, gx * cs, (gy + 1) * cs);
          if (maze.vWalls[gy][gx + 1]) resolveAgainstSegment(pos, radius, (gx + 1) * cs, gy * cs, (gx + 1) * cs, (gy + 1) * cs);
        }
      }
    }
    pos.x = Math.max(radius, Math.min(maze.width - radius, pos.x));
    pos.y = Math.max(radius, Math.min(maze.height - radius, pos.y));
  }

  // ---------- minimap ----------
  function buildMinimapCache() {
    // shrink the minimap on small/mobile viewports so it doesn't eat too
    // much of the screen or crowd the joystick corner
    const targetW = Math.max(120, Math.min(220, Math.round(cssW * 0.28)));
    miniScale = targetW / maze.width;
    const targetH = Math.round(maze.height * miniScale);
    miniCanvas.width = targetW; miniCanvas.height = targetH;
    miniCanvas.style.width = targetW + 'px';
    miniCanvas.style.height = targetH + 'px';

    miniCanvasCache = document.createElement('canvas');
    miniCanvasCache.width = targetW; miniCanvasCache.height = targetH;
    const mctx = miniCanvasCache.getContext('2d');
    mctx.fillStyle = '#0a0c16';
    mctx.fillRect(0, 0, targetW, targetH);
    mctx.strokeStyle = 'rgba(150,160,220,0.55)';
    mctx.lineWidth = 1;
    mctx.beginPath();
    for (const s of maze.wallSegments) {
      mctx.moveTo(s.x1 * miniScale, s.y1 * miniScale);
      mctx.lineTo(s.x2 * miniScale, s.y2 * miniScale);
    }
    mctx.stroke();
    // exit marker
    mctx.fillStyle = '#ffd166';
    mctx.beginPath();
    mctx.arc(maze.exitZone.x * miniScale, maze.exitZone.y * miniScale, 4, 0, Math.PI * 2);
    mctx.fill();
  }

  function drawMinimap() {
    if (!miniCanvasCache) return;
    miniCtx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);
    miniCtx.drawImage(miniCanvasCache, 0, 0);
    miniCtx.fillStyle = 'rgba(255,255,255,0.55)';
    for (const o of otherPlayers.values()) {
      if (o.finished) continue;
      miniCtx.beginPath();
      miniCtx.arc(o.x * miniScale, o.y * miniScale, 2, 0, Math.PI * 2);
      miniCtx.fill();
    }
    if (!isSpectator) {
      miniCtx.fillStyle = '#00d2a8';
      miniCtx.beginPath();
      miniCtx.arc(local.x * miniScale, local.y * miniScale, 3, 0, Math.PI * 2);
      miniCtx.fill();
    }
  }

  // ---------- main loop ----------
  let lastTime = performance.now();
  let lastSendTime = 0;
  const MAX_SPEED = 235; // px/s
  const DEADZONE = 6;
  const MAX_REACH = 140;

  function clampCamera(pos, mazeSize, viewSize) {
    if (mazeSize <= viewSize) return (mazeSize - viewSize) / 2;
    return Math.max(0, Math.min(mazeSize - viewSize, pos));
  }

  function loop(now) {
    if (!screens.game.classList.contains('active')) return; // stop loop when leaving game screen
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    const countdownRemaining = raceStartAt - Date.now();
    if (countdownRemaining > 0) {
      countdownOverlay.classList.remove('hidden');
      countdownNumber.textContent = Math.ceil(countdownRemaining / 1000);
      raceActive = false;
    } else {
      if (!raceActive) {
        raceActive = true;
        hudStatus.textContent = isSpectator ? '👁️ เริ่มแข่งแล้ว!' : 'ไปเลย!';
        setTimeout(() => {
          if (isSpectator) hudStatus.textContent = '👁️ กำลังชมการแข่งขัน';
          else if (!selfFinished) hudStatus.textContent = 'กำลังวิ่ง...';
        }, 900);
      }
      countdownOverlay.classList.add('hidden');
    }

    // Camera for this frame. Racers get a camera that follows their own
    // position (computed once and reused for both movement direction and
    // the render translate, so movement always matches what's on screen).
    // Spectators have no character to follow, so instead we zoom out to fit
    // the whole maze in view — offsetX/Y center it, viewScale shrinks it.
    let camX = 0, camY = 0, viewScale = 1, offsetX = 0, offsetY = 0;
    if (maze) {
      if (isSpectator) {
        viewScale = Math.min(cssW / maze.width, cssH / maze.height) * 0.94;
        offsetX = (cssW - maze.width * viewScale) / 2;
        offsetY = (cssH - maze.height * viewScale) / 2;
      } else {
        camX = clampCamera(local.x - cssW / 2, maze.width, cssW);
        camY = clampCamera(local.y - cssH / 2, maze.height, cssH);
      }
    }

    // movement — spectators never move a character
    if (raceActive && !selfFinished && maze && !isSpectator) {
      const nowMs = Date.now();
      const confused = activeEffects.confuse > nowMs;
      const turbo = activeEffects.turbo > nowMs;
      let dirX = 0, dirY = 0, speedFactor = 0;

      if (controlMode === 'wasd') {
        const ix = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
        const iy = (keys.s ? 1 : 0) - (keys.w ? 1 : 0);
        if (ix !== 0 || iy !== 0) {
          const len = Math.sqrt(ix * ix + iy * iy);
          dirX = ix / len; dirY = iy / len; speedFactor = 1;
        }
      } else if (controlMode === 'touch') {
        const dist = Math.sqrt(joystick.dx * joystick.dx + joystick.dy * joystick.dy);
        if (joystick.active && dist > 4) {
          dirX = joystick.dx / dist; dirY = joystick.dy / dist;
          speedFactor = Math.min(1, dist / JOY_MAX);
        }
      } else {
        const playerScreenX = local.x - camX;
        const playerScreenY = local.y - camY;
        const dx = mouse.x - playerScreenX, dy = mouse.y - playerScreenY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > DEADZONE) {
          dirX = dx / dist; dirY = dy / dist;
          speedFactor = Math.min(1, (dist - DEADZONE) / (MAX_REACH - DEADZONE));
        }
      }

      if (confused) { dirX = -dirX; dirY = -dirY; }
      const speed = MAX_SPEED * (turbo ? 1.6 : 1);
      local.x += dirX * speed * speedFactor * dt;
      local.y += dirY * speed * speedFactor * dt;

      resolveCollisions(local, PLAYER_RADIUS);

      // item pickups — same client-detects-then-server-confirms pattern as
      // the finish line, so 40-50 players don't need server-side physics
      if (!heldItem) {
        for (const item of itemsById.values()) {
          if (item.collected || pendingCollect.has(item.id)) continue;
          const idx = local.x - item.x, idy = local.y - item.y;
          if (Math.sqrt(idx * idx + idy * idy) <= maze.itemPickupRadius) {
            pendingCollect.add(item.id);
            // The server validates pickup proximity against the player's
            // last-known position from a throttled 'move' event. Force a
            // fresh sync BEFORE requesting the pickup so a fast-moving (or
            // just-teleported) player doesn't get rejected due to a stale
            // server-side position — order matters, socket.io preserves it.
            socket.emit('move', { x: local.x, y: local.y });
            lastSendTime = now;
            socket.emit('collectItem', { itemId: item.id });
          }
        }
      }

      // finish check
      if (!finishSent) {
        const ex = local.x - maze.exitZone.x, ey = local.y - maze.exitZone.y;
        if (Math.sqrt(ex * ex + ey * ey) <= maze.exitZone.radius) {
          finishSent = true;
          socket.emit('finish');
        }
      }

      if (now - lastSendTime > 60) {
        lastSendTime = now;
        socket.emit('move', { x: local.x, y: local.y });
      }

      hudTimer.textContent = formatTime(Date.now() - raceStartAt);
    } else if (raceStartAt) {
      hudTimer.textContent = countdownRemaining > 0 ? '00:00.0' : formatTime(Date.now() - raceStartAt);
    }

    // interpolate other players toward their latest known target
    for (const o of otherPlayers.values()) {
      o.x += (o.targetX - o.x) * Math.min(1, dt * 8);
      o.y += (o.targetY - o.y) * Math.min(1, dt * 8);
    }

    render(camX, camY, offsetX, offsetY, viewScale);
    drawMinimap();
    requestAnimationFrame(loop);
  }

  function formatTime(ms) {
    if (ms < 0) ms = 0;
    const totalSec = ms / 1000;
    const m = Math.floor(totalSec / 60);
    const s = totalSec - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
  }

  function render(camX, camY, offsetX, offsetY, viewScale) {
    if (!maze) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#0a0c16';
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(viewScale, viewScale);
    ctx.translate(-camX, -camY);

    // floor
    ctx.fillStyle = '#12162a';
    ctx.fillRect(0, 0, maze.width, maze.height);

    // spawn / exit zones
    drawZone(maze.spawn, 'rgba(0,210,168,0.15)', 'rgba(0,210,168,0.5)');
    drawZone(maze.exitZone, 'rgba(255,209,102,0.18)', 'rgba(255,209,102,0.75)');
    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('EXIT', maze.exitZone.x, maze.exitZone.y - maze.exitZone.radius - 10);

    // walls
    ctx.strokeStyle = '#5b6bd6';
    ctx.lineWidth = maze.wallThickness;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(wallPath);

    // reveal-path overlay (while the 'reveal' item effect is active)
    if (revealPath && activeEffects.reveal > Date.now() && revealPath.length > 1) {
      ctx.save();
      ctx.setLineDash([10, 8]);
      ctx.strokeStyle = 'rgba(255, 209, 102, 0.85)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(revealPath[0].x, revealPath[0].y);
      for (let i = 1; i < revealPath.length; i++) ctx.lineTo(revealPath[i].x, revealPath[i].y);
      ctx.stroke();
      ctx.restore();
    }

    // item pickups
    const nowMs = Date.now();
    for (const item of itemsById.values()) {
      const info = ITEM_INFO[item.type];
      if (item.collected) {
        // still on cooldown — show a filling ring + countdown where it was,
        // so everyone can see when a power-up is about to come back
        if (!item.cooldownMs) continue;
        const elapsed = nowMs - item.collectedAt;
        const remaining = Math.max(0, item.cooldownMs - elapsed);
        if (remaining <= 0) continue; // about to respawn server-side; avoid a 0s flash
        const progress = Math.min(1, elapsed / item.cooldownMs);
        ctx.beginPath();
        ctx.arc(item.x, item.y, 15, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(item.x, item.y, 15, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
        ctx.strokeStyle = `rgba(${info.color},0.85)`;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.65)';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.ceil(remaining / 1000)}s`, item.x, item.y + 3);
        continue;
      }
      // rich, saturated per-type color (+ a soft glow) so pickups read clearly
      // against the dark maze instead of the old plain washed-out white ring
      ctx.save();
      ctx.shadowColor = `rgba(${info.color},0.9)`;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(item.x, item.y, 15, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${info.color},0.32)`;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(${info.color},0.95)`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(info.icon, item.x, item.y + 1);
      ctx.textBaseline = 'alphabetic';
    }

    // other players — small + translucent so a crowd never hides the maze
    // or the local player's own dot underneath/behind them
    ctx.globalAlpha = 0.72;
    for (const o of otherPlayers.values()) {
      if (o.finished) continue;
      drawPlayer(o.x, o.y, o.color, o.name, false, OTHER_PLAYER_RADIUS);
    }
    ctx.globalAlpha = 1;
    // local player drawn last (on top, full size/opacity) — spectators have no character to draw
    if (!isSpectator) drawPlayer(local.x, local.y, '#ffffff', null, true, PLAYER_RADIUS);

    ctx.restore();
  }

  function drawZone(zone, fill, stroke) {
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawPlayer(x, y, color, name, isSelf, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    if (isSelf) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#6c5ce7';
      ctx.stroke();
    }
    if (name) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(name, x, y - radius - 6);
    }
  }

  if (DEBUG) {
    window.__debug = {
      local, mouse,
      getMaze: () => maze,
      getRaceStartAt: () => raceStartAt,
      getHeldItem: () => heldItem,
      getActiveEffects: () => ({ ...activeEffects }),
      getItems: () => [...itemsById.values()],
      getIsSpectator: () => isSpectator,
      useHeldItem,
    };
  }
})();
