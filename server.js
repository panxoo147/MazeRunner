// server.js — lobby management + realtime relay for the maze race game.
//
// Design notes:
// - Movement/collision is computed on each CLIENT (against the maze data the
//   server sends once at race start). This keeps 40-50 players feeling smooth
//   with zero server-side physics cost.
// - The server just relays throttled position snapshots at a fixed tick rate
//   (10/sec) instead of forwarding every individual 'move' event 1:1 — that
//   keeps the message count flat instead of exploding with O(players^2).
// - Finish order is decided by the SERVER's receive order (not client
//   timestamps), so nobody can fake a faster finish by lying about time.

'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const {
  generateMaze,
  ITEM_POOL,
  MIN_MAP_SIZE_MULTIPLIER,
  MAX_MAP_SIZE_MULTIPLIER,
  DEFAULT_MAP_SIZE_MULTIPLIER,
} = require('./maze');

const PORT = process.env.PORT || 3000;
// Max players / finish-limit are now host-configurable per lobby (set at
// createLobby time). These stay as the default pre-filled value and the
// hard upper/lower bounds used to clamp whatever the host submits — never
// trust a raw client-supplied number without clamping it server-side.
const DEFAULT_MAX_PLAYERS = 50;
const MIN_MAX_PLAYERS = 2;
const HARD_MAX_PLAYERS = 100;
const DEFAULT_FINISH_LIMIT = 4;
const MIN_FINISH_LIMIT = 1;
const MAX_SPECTATORS_PER_LOBBY = 100; // spectators don't affect game balance, so give them a generous separate cap
const TICK_MS = 100; // 10Hz position broadcast
const COUNTDOWN_MS = 5000;
const RACE_TIMEOUT_MS = 10 * 60 * 1000; // auto-end race after 10 minutes (mazes got bigger/harder)
const LOBBY_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

// Power-up "game-changer" items — how long each effect lasts once used.
// Effect semantics live client-side (movement is client-authoritative); the
// server's job is just deciding pickup validity, holding at most 1 item per
// player, and — for the targeted ones — picking who gets hit.
// 'stun' is kept deliberately short: unlike the other debuffs it can hit
// MULTIPLE players at once (see STUN_RADIUS) with a total movement freeze,
// so a long duration would be far too punishing stacked with its AOE reach.
const ITEM_EFFECT_MS = { turbo: 4000, reveal: 5000, confuse: 3000, slow: 3000, stun: 1200 };
const ITEM_PICKUP_TOLERANCE = 20; // extra px slack on top of the pickup radius, for latency
const ITEM_RESPAWN_MS = 10 * 1000; // a collected item reappears after this long, so long races don't run dry
const STUN_RADIUS = 160; // px — roughly ~3.5 cells at CELL_SIZE=46, a tight "nearby" radius
const WALLBREAK_SEARCH_RADIUS_CELLS = 1; // search the user's own cell + its immediate 8 neighbors

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 8000,
});

/** @type {Map<string, Lobby>} */
const lobbies = new Map();

// Golden-angle hue stepping: any two consecutive join-indices land far apart
// on the color wheel, so 40-50 players joining in sequence stay visually
// distinguishable instead of cycling through a short adjacent-hue palette.
const GOLDEN_ANGLE = 137.508;
function colorForIndex(index) {
  const hue = (index * GOLDEN_ANGLE) % 360;
  return `hsl(${hue.toFixed(1)}, 72%, 58%)`;
}

// Same deterministic per-player scatter the client uses to draw each player
// around the spawn point (public/game.js has an identical copy). The server
// needs to match it exactly: player.x/y here is what gets broadcast in the
// very first 'tick' after the countdown ends, before any client has sent its
// own first 'move' — if this didn't match, every other player would visibly
// snap to the exact spawn center for a frame before jumping back out to
// their real (client-jittered) spot the moment real position updates arrive.
function idJitter(id, radius) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const angle = (hash % 360) * (Math.PI / 180);
  const frac = 0.25 + ((hash >> 5) % 100) / 150; // 0.25 - ~0.9 of radius
  return { dx: Math.cos(angle) * radius * frac, dy: Math.sin(angle) * radius * frac };
}

function randomCode() {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += LOBBY_CODE_CHARS[Math.floor(Math.random() * LOBBY_CODE_CHARS.length)];
  }
  return code;
}

function createLobbyCode() {
  let code;
  do {
    code = randomCode();
  } while (lobbies.has(code));
  return code;
}

function sanitizeName(raw) {
  const name = (raw || '').toString().trim().slice(0, 16);
  return name || 'Player';
}

// Same fixed list as public/game.js's EMOJI_OPTIONS — kept as a whitelist
// (not free text) so a client can't smuggle arbitrary strings/HTML into
// something broadcast straight to every other player's screen.
const EMOJI_OPTIONS = ['😀', '😁', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🤩', '😘', '😜', '🤪', '🤔', '🤨', '😏', '😴', '🥱', '🤯', '🥳', '😎', '🤠', '🥸', '🤓', '😈', '👿', '🤡', '👻', '💀', '🤖', '👽', '👾', '🎃', '🧟', '🧛', '🧙', '🧚', '🧞', '🦸', '🦹', '🐱', '🐶', '🦊', '🐼', '🐸', '🦁', '🐯', '🐨', '🐰', '🦄', '🐻', '🐮', '🐷', '🐵', '🐔', '🐧', '🦉', '🦅', '🦇', '🐺', '🐗', '🦝', '🦔', '🐢', '🦎', '🐍', '🐙', '🐳', '🐬', '🦈', '🐠', '🐡', '🦀', '🦑', '🐚', '🐌', '🐝', '🦋', '🐞', '🐜', '🍉', '🍕', '🍔', '🍟', '🌮', '🍩', '🍦', '🍪', '🍰', '🍫', '🍇', '🍓', '🍒', '🥑', '🌽', '🚀', '⭐', '🔥', '💎', '⚡'];
function sanitizeEmoji(raw) {
  return EMOJI_OPTIONS.includes(raw) ? raw : EMOJI_OPTIONS[0];
}

// Host-configurable room settings — always clamp raw client input, never
// trust it directly.
function sanitizeMaxPlayers(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_MAX_PLAYERS;
  return Math.min(HARD_MAX_PLAYERS, Math.max(MIN_MAX_PLAYERS, n));
}

function sanitizeFinishLimit(raw, maxPlayers) {
  const n = Math.round(Number(raw));
  const upperBound = Math.max(MIN_FINISH_LIMIT, maxPlayers);
  if (!Number.isFinite(n)) return Math.min(DEFAULT_FINISH_LIMIT, upperBound);
  return Math.min(upperBound, Math.max(MIN_FINISH_LIMIT, n));
}

// "Map Size" — a multiplier on top of the normal player-count-based maze
// sizing (see sizeForPlayers in maze.js). Unlike maxPlayers/finishLimit
// this isn't an integer count, so it's rounded to 1 decimal place rather
// than a whole number.
function sanitizeMapSizeMultiplier(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAP_SIZE_MULTIPLIER;
  const clamped = Math.min(MAX_MAP_SIZE_MULTIPLIER, Math.max(MIN_MAP_SIZE_MULTIPLIER, n));
  return Math.round(clamped * 10) / 10;
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    isHost: p.isHost,
    finished: p.finished,
    place: p.place,
    finishTime: p.finishTime,
    connected: p.connected,
    isSpectator: p.isSpectator,
    emoji: p.emoji,
  };
}

// Results-screen ordering: finishers by place, then anyone who didn't finish.
// Spectators never raced, so they don't belong on the results list at all.
function computeStandings(lobby) {
  return [...lobby.players.values()]
    .filter((p) => !p.isSpectator)
    .map(publicPlayer)
    .sort((a, b) => {
      if (a.finished && b.finished) return a.place - b.place;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return 0;
    });
}

function lobbySnapshot(lobby) {
  return {
    code: lobby.code,
    state: lobby.state,
    hostId: lobby.hostId,
    maxPlayers: lobby.maxPlayers,
    finishLimit: lobby.finishLimit,
    mapSizeMultiplier: lobby.mapSizeMultiplier,
    players: [...lobby.players.values()].map(publicPlayer),
    raceStartAt: lobby.raceStartAt,
  };
}

function broadcastLobby(lobby) {
  io.to(lobby.code).emit('lobbyUpdate', lobbySnapshot(lobby));
}

function getLobbyOfSocket(socket) {
  const code = socket.data.lobbyCode;
  if (!code) return null;
  return lobbies.get(code) || null;
}

function assignNewHost(lobby) {
  const remaining = [...lobby.players.values()].filter((p) => p.connected);
  if (remaining.length === 0) {
    lobby.hostId = null;
    return;
  }
  remaining.forEach((p) => (p.isHost = false));
  remaining[0].isHost = true;
  lobby.hostId = remaining[0].id;
}

function endRace(lobby, reason) {
  if (lobby.state !== 'racing') return; // avoid double-firing (immediate finish check + tick-loop safety net can both trigger)
  if (lobby.tickTimer) {
    clearInterval(lobby.tickTimer);
    lobby.tickTimer = null;
  }
  if (lobby.timeoutTimer) {
    clearTimeout(lobby.timeoutTimer);
    lobby.timeoutTimer = null;
  }
  lobby.state = 'results';
  const standings = computeStandings(lobby);
  io.to(lobby.code).emit('raceEnded', { reason, standings });
}

function startTicking(lobby) {
  lobby.tickTimer = setInterval(() => {
    if (lobby.state !== 'racing') return;
    const positions = [...lobby.players.values()]
      .filter((p) => p.connected && !p.finished && p.x != null)
      .map((p) => ({ id: p.id, x: p.x, y: p.y }));
    io.to(lobby.code).emit('tick', { t: Date.now(), positions });

    // Safety net alongside the immediate check in markPlayerFinished — spectators
    // never finish, so they're excluded or this would never fire.
    const totalRacers = [...lobby.players.values()].filter((p) => p.connected && !p.isSpectator).length;
    if (totalRacers > 0 && lobby.finishCount >= totalRacers) {
      endRace(lobby, 'all_finished');
    }
  }, TICK_MS);
}

function startRace(lobby) {
  const playerCount = [...lobby.players.values()].filter((p) => p.connected && !p.isSpectator).length;
  const seed = Math.floor(Math.random() * 2 ** 31);
  lobby.maze = generateMaze({ seed, playerCount, mapSizeMultiplier: lobby.mapSizeMultiplier });
  lobby.state = 'countdown';
  lobby.raceStartAt = Date.now() + COUNTDOWN_MS;
  lobby.itemsById = new Map(lobby.maze.items.map((it) => [it.id, { ...it, collected: false }]));

  for (const p of lobby.players.values()) {
    p.finished = false;
    p.place = null;
    p.finishTime = null;
    if (!p.isSpectator) {
      const jitter = idJitter(p.id, lobby.maze.spawn.radius);
      p.x = lobby.maze.spawn.x + jitter.dx;
      p.y = lobby.maze.spawn.y + jitter.dy;
      p.heldItem = null;
    }
  }
  lobby.finishCount = 0;

  io.to(lobby.code).emit('raceStarting', {
    maze: lobby.maze,
    raceStartAt: lobby.raceStartAt,
    players: [...lobby.players.values()].map(publicPlayer),
    // Lets each client correct for its own clock being off from the
    // server's (very common on real machines) when it measures the
    // countdown/timer against raceStartAt — see game.js's serverTimeOffset.
    now: Date.now(),
  });

  setTimeout(() => {
    if (!lobbies.has(lobby.code) || lobby.state !== 'countdown') return;
    lobby.state = 'racing';
    // Explicit "go" signal, separate from the raceStartAt timestamp clients use
    // for the cosmetic 5..4..3..2..1 numeral. Each client's own estimate of
    // "serverNow() >= raceStartAt" carries a one-way-latency bias (see game.js's
    // serverTimeOffset comment) that's invisible on localhost but real over the
    // internet — a client with worse latency to the server crosses its local
    // "zero" a bit LATE relative to when the server actually flips to racing.
    // During that lag, 'tick' broadcasts (emitted below) already start updating
    // everyone else's position, and the client keeps interpolating toward them
    // behind its still-visible countdown overlay. When the overlay finally
    // lifts (late), it reveals players who already moved — a visible "warp".
    // Gating the reveal on receipt of this event instead of on the local clock
    // estimate removes that bias: the reveal now only depends on this one
    // message's own (normal, small) network latency, not on accumulated offset
    // error.
    io.to(lobby.code).emit('raceStart', { now: Date.now() });
    startTicking(lobby);
    lobby.timeoutTimer = setTimeout(() => {
      if (lobby.state === 'racing') endRace(lobby, 'timeout');
    }, RACE_TIMEOUT_MS);
  }, COUNTDOWN_MS);
}

io.on('connection', (socket) => {
  socket.data.lobbyCode = null;

  socket.on('createLobby', ({ name, spectator, emoji, maxPlayers, finishLimit, mapSizeMultiplier } = {}, cb) => {
    const code = createLobbyCode();
    const isSpectator = !!spectator;
    const player = {
      id: socket.id,
      name: sanitizeName(name),
      emoji: sanitizeEmoji(emoji),
      color: isSpectator ? null : colorForIndex(0),
      isHost: true,
      connected: true,
      finished: false,
      place: null,
      finishTime: null,
      x: null,
      y: null,
      heldItem: null,
      isSpectator,
    };
    const cleanMaxPlayers = sanitizeMaxPlayers(maxPlayers);
    const cleanFinishLimit = sanitizeFinishLimit(finishLimit, cleanMaxPlayers);
    const cleanMapSizeMultiplier = sanitizeMapSizeMultiplier(mapSizeMultiplier);
    const lobby = {
      code,
      hostId: socket.id,
      state: 'waiting',
      players: new Map([[socket.id, player]]),
      maze: null,
      raceStartAt: null,
      finishCount: 0,
      tickTimer: null,
      timeoutTimer: null,
      createdAt: Date.now(),
      colorSeq: isSpectator ? 0 : 1, // next colorForIndex() slot to hand out
      maxPlayers: cleanMaxPlayers,
      finishLimit: cleanFinishLimit,
      mapSizeMultiplier: cleanMapSizeMultiplier,
    };
    lobbies.set(code, lobby);
    socket.join(code);
    socket.data.lobbyCode = code;
    cb && cb({ ok: true, lobby: lobbySnapshot(lobby), selfId: socket.id });
  });

  socket.on('joinLobby', ({ code, name, spectator, emoji } = {}, cb) => {
    const normalized = (code || '').toString().trim().toUpperCase();
    const lobby = lobbies.get(normalized);
    if (!lobby) return cb && cb({ ok: false, error: 'Room not found. Check the code and try again.' });
    const isSpectator = !!spectator;
    // Spectators can drop in any time (waiting/countdown/racing/results) since
    // they don't affect game balance; only actual racers need a fresh lobby.
    if (!isSpectator && lobby.state !== 'waiting') {
      return cb && cb({ ok: false, error: 'This room already started racing. Wait for the next round (or join as a spectator).' });
    }
    if (isSpectator) {
      const specCount = [...lobby.players.values()].filter((p) => p.connected && p.isSpectator).length;
      if (specCount >= MAX_SPECTATORS_PER_LOBBY) return cb && cb({ ok: false, error: 'Spectator slots are full' });
    } else {
      const connectedCount = [...lobby.players.values()].filter((p) => p.connected && !p.isSpectator).length;
      if (connectedCount >= lobby.maxPlayers) {
        return cb && cb({ ok: false, error: `Room is full (max ${lobby.maxPlayers} players)` });
      }
    }
    const player = {
      id: socket.id,
      name: sanitizeName(name),
      emoji: sanitizeEmoji(emoji),
      color: isSpectator ? null : colorForIndex(lobby.colorSeq++),
      isHost: false,
      connected: true,
      finished: false,
      place: null,
      finishTime: null,
      x: null,
      y: null,
      heldItem: null,
      isSpectator,
    };
    lobby.players.set(socket.id, player);
    socket.join(lobby.code);
    socket.data.lobbyCode = lobby.code;
    const payload = { ok: true, lobby: lobbySnapshot(lobby), selfId: socket.id };
    // A spectator joining mid-race needs the current maze/race state to
    // bootstrap their view immediately, since they missed 'raceStarting'.
    if (isSpectator && lobby.maze && (lobby.state === 'countdown' || lobby.state === 'racing')) {
      payload.maze = lobby.maze;
      payload.raceStartAt = lobby.raceStartAt;
      payload.now = Date.now(); // same clock-skew correction as the 'raceStarting' broadcast
      // Lets the client know it missed the 'raceStart' broadcast (it already
      // fired before this spectator joined) so it shouldn't sit waiting for it.
      payload.alreadyRacing = lobby.state === 'racing';
    } else if (isSpectator && lobby.state === 'results') {
      payload.standings = computeStandings(lobby);
    }
    cb && cb(payload);
    broadcastLobby(lobby);
  });

  // Toggle between racer/spectator while still in the waiting room. Blocked
  // once a race is live so nobody can dodge a bad position by "watching" —
  // spectators who want in have to wait for the next race.
  socket.on('setSpectator', ({ spectator } = {}) => {
    const lobby = getLobbyOfSocket(socket);
    if (!lobby || lobby.state !== 'waiting') return;
    const player = lobby.players.get(socket.id);
    if (!player) return;
    const isSpectator = !!spectator;
    if (player.isSpectator === isSpectator) return;
    if (!isSpectator) {
      const connectedCount = [...lobby.players.values()].filter((p) => p.connected && !p.isSpectator).length;
      if (connectedCount >= lobby.maxPlayers) return;
      player.color = colorForIndex(lobby.colorSeq++);
    } else {
      player.color = null;
    }
    player.isSpectator = isSpectator;
    broadcastLobby(lobby);
  });

  socket.on('startRace', () => {
    const lobby = getLobbyOfSocket(socket);
    if (!lobby) return;
    if (lobby.hostId !== socket.id) return;
    if (lobby.state !== 'waiting' && lobby.state !== 'results') return;
    const racerCount = [...lobby.players.values()].filter((p) => p.connected && !p.isSpectator).length;
    if (racerCount < 1) return;
    startRace(lobby);
  });

  // Host sends everyone from the results screen back to the waiting room
  // instead of jumping straight into another race. This also re-opens the
  // lobby to new joins (join is normally blocked once state !== 'waiting').
  socket.on('backToLobby', () => {
    const lobby = getLobbyOfSocket(socket);
    if (!lobby) return;
    if (lobby.hostId !== socket.id) return;
    if (lobby.state !== 'results') return;

    lobby.state = 'waiting';
    lobby.maze = null;
    lobby.raceStartAt = null;
    lobby.finishCount = 0;
    lobby.itemsById = null;
    for (const p of lobby.players.values()) {
      p.finished = false;
      p.place = null;
      p.finishTime = null;
      p.x = null;
      p.y = null;
      p.heldItem = null;
    }
    io.to(lobby.code).emit('returnedToLobby', lobbySnapshot(lobby));
  });

  // Marks a player finished and broadcasts it. Called both when the client
  // explicitly reports reaching the goal, and (as a safety net) whenever a
  // position update lands inside the exit zone — that way a race can never
  // "hang" just because a single 'finish' packet got delayed or dropped.
  function markPlayerFinished(lobby, player) {
    if (player.finished) return;
    lobby.finishCount += 1;
    player.finished = true;
    player.place = lobby.finishCount;
    player.finishTime = Date.now() - (lobby.raceStartAt || Date.now());
    io.to(lobby.code).emit('playerFinished', {
      id: player.id,
      name: player.name,
      emoji: player.emoji,
      place: player.place,
      finishTime: player.finishTime,
    });

    // End the race as soon as the top lobby.finishLimit racers are in (or
    // everyone is, if fewer than that are racing) — no need to wait for stragglers.
    const totalRacers = [...lobby.players.values()].filter((p) => p.connected && !p.isSpectator).length;
    if (totalRacers > 0 && lobby.finishCount >= Math.min(lobby.finishLimit, totalRacers)) {
      endRace(lobby, lobby.finishCount >= totalRacers ? 'all_finished' : 'top_finishers');
    }
  }

  function distanceToExit(m, x, y) {
    const dx = x - m.exitZone.x;
    const dy = y - m.exitZone.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  socket.on('move', ({ x, y } = {}) => {
    const lobby = getLobbyOfSocket(socket);
    if (!lobby || lobby.state !== 'racing') return;
    const player = lobby.players.get(socket.id);
    if (!player || player.finished) return;
    if (typeof x !== 'number' || typeof y !== 'number') return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // clamp inside maze bounds defensively
    const m = lobby.maze;
    player.x = Math.max(0, Math.min(m.width, x));
    player.y = Math.max(0, Math.min(m.height, y));

    if (distanceToExit(m, player.x, player.y) <= m.exitZone.radius) {
      markPlayerFinished(lobby, player);
    }
  });

  socket.on('finish', () => {
    const lobby = getLobbyOfSocket(socket);
    if (!lobby || lobby.state !== 'racing') return;
    const player = lobby.players.get(socket.id);
    if (!player || player.finished) return;
    const m = lobby.maze;
    if (player.x == null) return;
    // generous tolerance here since the client may be reporting a finish
    // slightly ahead of its last throttled 'move' packet
    if (distanceToExit(m, player.x, player.y) > m.exitZone.radius + 30) return;
    markPlayerFinished(lobby, player);
  });

  // Pick up a power-up: only if the player isn't already holding one, the
  // pickup hasn't been grabbed yet, and they're actually near it (server
  // re-checks distance rather than trusting the client's "I'm close" claim).
  socket.on('collectItem', ({ itemId } = {}) => {
    const lobby = getLobbyOfSocket(socket);
    if (!lobby || lobby.state !== 'racing' || !lobby.itemsById) return;
    const player = lobby.players.get(socket.id);
    if (!player || player.finished || player.heldItem) return;
    const item = lobby.itemsById.get(itemId);
    if (!item || item.collected) return;
    if (player.x == null) return;
    const dx = player.x - item.x, dy = player.y - item.y;
    if (Math.sqrt(dx * dx + dy * dy) > lobby.maze.itemPickupRadius + ITEM_PICKUP_TOLERANCE) return;

    item.collected = true;
    // The type is rolled fresh right here, at pickup time — not fixed to
    // this spot — so grabbing the same pickup point again later can hand
    // out something different. Rolled server-side so a client can't peek at
    // or influence what it's about to get.
    const awardedType = ITEM_POOL[Math.floor(Math.random() * ITEM_POOL.length)];
    player.heldItem = awardedType;
    // respawnInMs lets every client (not just the collector) draw a cooldown
    // ring on the ground where the item was, instead of it just vanishing.
    io.to(lobby.code).emit('itemCollected', {
      itemId, type: awardedType, byId: player.id, byName: player.name, respawnInMs: ITEM_RESPAWN_MS,
    });

    // Respawn after a delay so a long race doesn't run dry on power-ups.
    // Captures the itemsById Map instance itself (not just the lobby) so a
    // stray timer from a since-finished race can never touch the next one —
    // startRace() always swaps in a brand new Map.
    const itemsAtPickup = lobby.itemsById;
    setTimeout(() => {
      if (lobby.itemsById !== itemsAtPickup || !item.collected) return;
      item.collected = false;
      io.to(lobby.code).emit('itemRespawned', { itemId });
    }, ITEM_RESPAWN_MS);
  });

  // Find the single nearest breakable (non-boundary) wall segment to a
  // player, searched within their current cell + its 8 immediate neighbors
  // — deliberately small so a broken wall always appears right next to
  // where the item was used. Boundary walls (the outer edge of the maze)
  // are never candidates, so nobody can punch a hole out of the level.
  // Mutates lobby.maze in place and broadcasts 'wallBroken' so every
  // client's local collision grid + wall render + minimap stay in sync.
  function breakNearestWall(lobby, player) {
    if (player.x == null) return null;
    const m = lobby.maze;
    const cs = m.cellSize;
    const cx = Math.max(0, Math.min(m.cols - 1, Math.floor(player.x / cs)));
    const cy = Math.max(0, Math.min(m.rows - 1, Math.floor(player.y / cs)));

    let best = null; // { kind, x, y, dist }
    for (let gy = cy - WALLBREAK_SEARCH_RADIUS_CELLS; gy <= cy + WALLBREAK_SEARCH_RADIUS_CELLS; gy++) {
      if (gy < 0 || gy >= m.rows) continue;
      for (let gx = cx - WALLBREAK_SEARCH_RADIUS_CELLS; gx <= cx + WALLBREAK_SEARCH_RADIUS_CELLS; gx++) {
        if (gx < 0 || gx >= m.cols) continue;
        // horizontal walls above/below this cell (skip the outer boundary rows)
        if (gy > 0 && m.hWalls[gy][gx]) {
          const midY = gy * cs, midX = (gx + 0.5) * cs;
          const dist = Math.hypot(player.x - midX, player.y - midY);
          if (!best || dist < best.dist) best = { kind: 'h', x: gx, y: gy, dist };
        }
        if (gy + 1 < m.rows && m.hWalls[gy + 1][gx]) {
          const midY = (gy + 1) * cs, midX = (gx + 0.5) * cs;
          const dist = Math.hypot(player.x - midX, player.y - midY);
          if (!best || dist < best.dist) best = { kind: 'h', x: gx, y: gy + 1, dist };
        }
        // vertical walls left/right of this cell (skip the outer boundary columns)
        if (gx > 0 && m.vWalls[gy][gx]) {
          const midX = gx * cs, midY = (gy + 0.5) * cs;
          const dist = Math.hypot(player.x - midX, player.y - midY);
          if (!best || dist < best.dist) best = { kind: 'v', x: gx, y: gy, dist };
        }
        if (gx + 1 < m.cols && m.vWalls[gy][gx + 1]) {
          const midX = (gx + 1) * cs, midY = (gy + 0.5) * cs;
          const dist = Math.hypot(player.x - midX, player.y - midY);
          if (!best || dist < best.dist) best = { kind: 'v', x: gx + 1, y: gy, dist };
        }
      }
    }
    if (!best) return null;

    if (best.kind === 'h') m.hWalls[best.y][best.x] = false;
    else m.vWalls[best.y][best.x] = false;

    io.to(lobby.code).emit('wallBroken', { kind: best.kind, x: best.x, y: best.y });
    return best;
  }

  // Use whatever power-up is currently held.
  // - 'turbo' / 'reveal': self-only buffs.
  // - 'confuse' / 'slow': single-target debuffs — both target whichever
  //   *other* unfinished player is currently closest (straight-line) to the
  //   exit, i.e. a rough stand-in for "the leader" (the comeback mechanic).
  // - 'stun': an AOE debuff — hits every OTHER unfinished player within
  //   STUN_RADIUS of the user's own current position, since the ask was
  //   specifically "stun people around you", not a single target.
  // - 'wallbreak': no target — permanently opens the nearest wall next to
  //   the user, a whole-lobby-affecting shortcut (see breakNearestWall).
  socket.on('useItem', () => {
    const lobby = getLobbyOfSocket(socket);
    if (!lobby || lobby.state !== 'racing') return;
    const player = lobby.players.get(socket.id);
    if (!player || player.finished || !player.heldItem) return;
    const type = player.heldItem;
    player.heldItem = null;

    if (type === 'turbo' || type === 'reveal') {
      io.to(player.id).emit('itemEffect', { type, duration: ITEM_EFFECT_MS[type] });
      io.to(lobby.code).emit('itemUsed', { byId: player.id, byName: player.name, type });
      return;
    }

    if (type === 'confuse' || type === 'slow') {
      const m = lobby.maze;
      let target = null;
      let bestDist = Infinity;
      for (const p of lobby.players.values()) {
        if (p.id === player.id || p.finished || !p.connected || p.x == null) continue;
        const dx = p.x - m.exitZone.x, dy = p.y - m.exitZone.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestDist) { bestDist = d; target = p; }
      }
      if (target) {
        io.to(target.id).emit('itemEffect', { type, duration: ITEM_EFFECT_MS[type], byName: player.name });
        io.to(lobby.code).emit('itemUsed', { byId: player.id, byName: player.name, type, targetName: target.name });
      } else {
        io.to(lobby.code).emit('itemUsed', { byId: player.id, byName: player.name, type, targetName: null });
      }
      return;
    }

    if (type === 'stun') {
      if (player.x == null) {
        io.to(lobby.code).emit('itemUsed', { byId: player.id, byName: player.name, type, hitCount: 0 });
        return;
      }
      let hitCount = 0;
      for (const p of lobby.players.values()) {
        if (p.id === player.id || p.finished || !p.connected || p.x == null) continue;
        const dx = p.x - player.x, dy = p.y - player.y;
        if (Math.sqrt(dx * dx + dy * dy) > STUN_RADIUS) continue;
        io.to(p.id).emit('itemEffect', { type: 'stun', duration: ITEM_EFFECT_MS.stun, byName: player.name });
        hitCount++;
      }
      io.to(lobby.code).emit('itemUsed', { byId: player.id, byName: player.name, type, hitCount });
      return;
    }

    // wallbreak
    const broken = breakNearestWall(lobby, player);
    io.to(lobby.code).emit('itemUsed', { byId: player.id, byName: player.name, type, broke: !!broken });
  });

  socket.on('leaveLobby', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  function handleLeave(sock) {
    const lobby = getLobbyOfSocket(sock);
    sock.data.lobbyCode = null;
    if (!lobby) return;
    const player = lobby.players.get(sock.id);
    if (!player) return;

    if (lobby.state === 'waiting' || lobby.state === 'results') {
      lobby.players.delete(sock.id);
    } else {
      player.connected = false; // keep their result/slot during an active race
    }

    if (lobby.hostId === sock.id) assignNewHost(lobby);

    const stillConnected = [...lobby.players.values()].some((p) => p.connected);
    if (!stillConnected) {
      if (lobby.tickTimer) clearInterval(lobby.tickTimer);
      if (lobby.timeoutTimer) clearTimeout(lobby.timeoutTimer);
      lobbies.delete(lobby.code);
      return;
    }

    // If everyone left who was still actually racing (vs. finished/spectating),
    // don't leave the race hanging until the timeout — end it now.
    if (lobby.state === 'racing') {
      const activeRacers = [...lobby.players.values()].filter((p) => p.connected && !p.isSpectator && !p.finished);
      if (activeRacers.length === 0) endRace(lobby, 'all_finished');
    }

    broadcastLobby(lobby);
  }
});

// periodic sweep: drop lobbies that have been empty/stale for a long time
setInterval(() => {
  const now = Date.now();
  for (const [code, lobby] of lobbies) {
    const anyConnected = [...lobby.players.values()].some((p) => p.connected);
    if (!anyConnected && now - lobby.createdAt > 30 * 60 * 1000) {
      if (lobby.tickTimer) clearInterval(lobby.tickTimer);
      if (lobby.timeoutTimer) clearTimeout(lobby.timeoutTimer);
      lobbies.delete(code);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Maze race server listening on http://localhost:${PORT}`);
});
