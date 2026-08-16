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

  const PLAYER_RADIUS = 11;

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
  const homeError = document.getElementById('home-error');

  const savedName = sessionStorage.getItem('mazerace_name');
  if (savedName) inputName.value = savedName;

  function getName() {
    const v = inputName.value.trim();
    if (v) sessionStorage.setItem('mazerace_name', v);
    return v || 'Player';
  }

  // ---------- control mode (mouse-cursor vs WASD) ----------
  // A per-player local preference — movement is fully client-authoritative,
  // so each player can pick whichever scheme they like independently.
  let controlMode = sessionStorage.getItem('mazerace_control') || 'mouse';
  const controlToggle = document.getElementById('control-toggle');
  const hudControlBtn = document.getElementById('hud-control-toggle');
  const CONTROL_LABEL = { mouse: '🖱️ เมาส์', wasd: '⌨️ WASD' };

  function setControlMode(mode) {
    controlMode = mode === 'wasd' ? 'wasd' : 'mouse';
    sessionStorage.setItem('mazerace_control', controlMode);
    controlToggle.querySelectorAll('.control-opt').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === controlMode);
    });
    hudControlBtn.textContent = CONTROL_LABEL[controlMode];
    // reset held keys whenever we switch away from WASD mid-race so a key
    // that was down doesn't stay "stuck" after flipping back to mouse
    keys.w = keys.a = keys.s = keys.d = false;
  }

  controlToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.control-opt');
    if (btn) setControlMode(btn.dataset.mode);
  });
  hudControlBtn.addEventListener('click', () => setControlMode(controlMode === 'mouse' ? 'wasd' : 'mouse'));

  document.getElementById('btn-create').addEventListener('click', () => {
    homeError.textContent = '';
    socket.emit('createLobby', { name: getName() }, (res) => {
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
    socket.emit('joinLobby', { code, name: getName() }, (res) => {
      if (!res.ok) { homeError.textContent = res.error || 'เข้าห้องไม่สำเร็จ'; return; }
      selfId = res.selfId;
      applyLobby(res.lobby);
      showScreen('lobby');
    });
  }

  // ---------- LOBBY screen ----------
  const lobbyCodeEl = document.getElementById('lobby-code');
  const lobbyCountEl = document.getElementById('lobby-count');
  const lobbyMaxEl = document.getElementById('lobby-max');
  const playerListEl = document.getElementById('player-list');
  const btnStart = document.getElementById('btn-start');
  const lobbyWaitMsg = document.getElementById('lobby-wait-msg');

  function applyLobby(lobby) {
    currentLobby = lobby;
    lobbyCodeEl.textContent = lobby.code;
    lobbyMaxEl.textContent = lobby.maxPlayers;
    renderPlayerList(lobby);
  }

  function renderPlayerList(lobby) {
    lobbyCountEl.textContent = lobby.players.length;
    playerListEl.innerHTML = '';
    for (const p of lobby.players) {
      const chip = document.createElement('div');
      chip.className = 'player-chip';
      chip.innerHTML = `<span class="player-dot" style="background:${p.color}"></span><span>${escapeHtml(p.name)}</span>${p.isHost ? '<span class="host-badge">HOST</span>' : ''}`;
      playerListEl.appendChild(chip);
    }
    const isHost = lobby.hostId === selfId;
    btnStart.style.display = isHost ? 'block' : 'none';
    lobbyWaitMsg.style.display = isHost ? 'none' : 'block';
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  document.getElementById('btn-start').addEventListener('click', () => socket.emit('startRace'));
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
      if (screens.game.classList.contains('active')) setControlMode(controlMode === 'mouse' ? 'wasd' : 'mouse');
      return;
    }
    // only capture WASD/arrows while actually on the game screen, so typing
    // "w"/"a"/"s"/"d" into the name or lobby-code fields is unaffected
    if (!screens.game.classList.contains('active')) return;
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

  setControlMode(controlMode); // sync UI + hud label to the saved preference

  socket.on('raceStarting', ({ maze: m, raceStartAt: rsa, players }) => {
    maze = m;
    raceStartAt = rsa;
    raceActive = false;
    selfFinished = false;
    finishSent = false;
    keys.w = keys.a = keys.s = keys.d = false;
    otherPlayers.clear();
    liveLeaderboard = [];
    hudLeaderboard.innerHTML = '';

    for (const p of players) {
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
    hudStatus.textContent = 'เตรียมตัว...';
    requestAnimationFrame(loop);
  });

  socket.on('tick', ({ positions }) => {
    for (const p of positions) {
      if (p.id === selfId) continue;
      const o = otherPlayers.get(p.id);
      if (o) { o.targetX = p.x; o.targetY = p.y; }
    }
  });

  socket.on('playerFinished', ({ id, name, place, finishTime }) => {
    liveLeaderboard.push({ id, name, place, finishTime });
    if (otherPlayers.has(id)) otherPlayers.get(id).finished = true;
    if (id === selfId) {
      selfFinished = true;
      hudStatus.textContent = `เข้าเส้นชัยอันดับที่ ${place}! 🎉`;
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

  socket.on('raceEnded', ({ standings }) => {
    raceActive = false;
    showResults(standings);
  });

  function showResults(standings) {
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
    document.getElementById('results-wait-msg').style.display = isHost ? 'none' : 'block';
    showScreen('results');
  }

  document.getElementById('btn-play-again').addEventListener('click', () => socket.emit('startRace'));

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
    const targetW = 220;
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
    miniCtx.fillStyle = '#00d2a8';
    miniCtx.beginPath();
    miniCtx.arc(local.x * miniScale, local.y * miniScale, 3, 0, Math.PI * 2);
    miniCtx.fill();
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
      if (!raceActive) { raceActive = true; hudStatus.textContent = 'ไปเลย!'; setTimeout(() => { if (!selfFinished) hudStatus.textContent = 'กำลังวิ่ง...'; }, 900); }
      countdownOverlay.classList.add('hidden');
    }

    // Camera position for this frame — computed once and reused for both
    // the movement direction and the render translate below, so the
    // direction the character moves always matches where it's actually
    // drawn on screen relative to the cursor (near maze edges the camera
    // clamps and the player is NOT at the exact screen center anymore).
    const camX = maze ? clampCamera(local.x - cssW / 2, maze.width, cssW) : 0;
    const camY = maze ? clampCamera(local.y - cssH / 2, maze.height, cssH) : 0;

    // movement
    if (raceActive && !selfFinished && maze) {
      if (controlMode === 'wasd') {
        let ix = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
        let iy = (keys.s ? 1 : 0) - (keys.w ? 1 : 0);
        if (ix !== 0 || iy !== 0) {
          const len = Math.sqrt(ix * ix + iy * iy);
          local.x += (ix / len) * MAX_SPEED * dt;
          local.y += (iy / len) * MAX_SPEED * dt;
        }
      } else {
        const playerScreenX = local.x - camX;
        const playerScreenY = local.y - camY;
        const dx = mouse.x - playerScreenX, dy = mouse.y - playerScreenY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > DEADZONE) {
          const speedFactor = Math.min(1, (dist - DEADZONE) / (MAX_REACH - DEADZONE));
          const nx = dx / dist, ny = dy / dist;
          local.x += nx * MAX_SPEED * speedFactor * dt;
          local.y += ny * MAX_SPEED * speedFactor * dt;
        }
      }
      resolveCollisions(local, PLAYER_RADIUS);

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

    render(camX, camY);
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

  function render(camX, camY) {
    if (!maze) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#0a0c16';
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.save();
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

    // other players
    for (const o of otherPlayers.values()) {
      if (o.finished) continue;
      drawPlayer(o.x, o.y, o.color, o.name, false);
    }
    // local player on top
    drawPlayer(local.x, local.y, '#ffffff', null, true);

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

  function drawPlayer(x, y, color, name, isSelf) {
    ctx.beginPath();
    ctx.arc(x, y, PLAYER_RADIUS, 0, Math.PI * 2);
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
      ctx.fillText(name, x, y - PLAYER_RADIUS - 6);
    }
  }

  if (DEBUG) {
    window.__debug = {
      local, mouse,
      getMaze: () => maze,
      getRaceStartAt: () => raceStartAt,
    };
  }
})();
