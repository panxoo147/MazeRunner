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
const { generateMaze } = require('./maze');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_LOBBY = 50;
const TICK_MS = 100; // 10Hz position broadcast
const COUNTDOWN_MS = 5000;
const RACE_TIMEOUT_MS = 10 * 60 * 1000; // auto-end race after 10 minutes (mazes got bigger/harder)
const LOBBY_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

// Power-up "game-changer" items — how long each effect lasts once used.
// Effect semantics live client-side (movement is client-authoritative); the
// server's job is just deciding pickup validity, holding at most 1 item per
// player, and — for 'confuse' — picking who gets hit.
const ITEM_EFFECT_MS = { turbo: 4000, reveal: 5000, confuse: 3000 };
const ITEM_PICKUP_TOLERANCE = 20; // extra px slack on top of the pickup radius, for latency

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
  };
}

function lobbySnapshot(lobby) {
  return {
    code: lobby.code,
    state: lobby.state,
    hostId: lobby.hostId,
    maxPlayers: MAX_PLAYERS_PER_LOBBY,
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
  if (lobby.tickTimer) {
    clearInterval(lobby.tickTimer);
    lobby.tickTimer = null;
  }
  if (lobby.timeoutTimer) {
    clearTimeout(lobby.timeoutTimer);
    lobby.timeoutTimer = null;
  }
  lobby.state = 'results';
  const standings = [...lobby.players.values()]
    .map(publicPlayer)
    .sort((a, b) => {
      if (a.finished && b.finished) return a.place - b.place;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return 0;
    });
  io.to(lobby.code).emit('raceEnded', { reason, standings });
}

function startTicking(lobby) {
  lobby.tickTimer = setInterval(() => {
    if (lobby.state !== 'racing') return;
    const positions = [...lobby.players.values()]
      .filter((p) => p.connected && !p.finished && p.x != null)
      .map((p) => ({ id: p.id, x: p.x, y: p.y }));
    io.to(lobby.code).emit('tick', { t: Date.now(), positions });

    const allFinished = [...lobby.players.values()]
      .filter((p) => p.connected)
      .every((p) => p.finished);
    if (allFinished && lobby.players.size > 0) {
      endRace(lobby, 'all_finished');
    }
  }, TICK_MS);
}

function startRace(lobby) {
  const playerCount = [...lobby.players.values()].filter((p) => p.connected).length;
  const seed = Math.floor(Math.random() * 2 ** 31);
  lobby.maze = generateMaze({ seed, playerCount });
  lobby.state = 'countdown';
  lobby.raceStartAt = Date.now() + COUNTDOWN_MS;
  lobby.itemsById = new Map(lobby.maze.items.map((it) => [it.id, { ...it, collected: false }]));

  for (const p of lobby.players.values()) {
    p.finished = false;
    p.place = null;
    p.finishTime = null;
    p.x = lobby.maze.spawn.x;
    p.y = lobby.maze.spawn.y;
    p.heldItem = null;
  }
  lobby.finishCount = 0;

  io.to(lobby.code).emit('raceStarting', {
    maze: lobby.maze,
    raceStartAt: lobby.raceStartAt,
    players: [...lobby.players.values()].map(publicPlayer),
  });

  setTimeout(() => {
    if (!lobbies.has(lobby.code) || lobby.state !== 'countdown') return;
    lobby.state = 'racing';
    startTicking(lobby);
    lobby.timeoutTimer = setTimeout(() => {
      if (lobby.state === 'racing') endRace(lobby, 'timeout');
    }, RACE_TIMEOUT_MS);
  }, COUNTDOWN_MS);
}

io.on('connection', (socket) => {
  socket.data.lobbyCode = null;

  socket.on('createLobby', ({ name } = {}, cb) => {
    const code = createLobbyCode();
    const player = {
      id: socket.id,
      name: sanitizeName(name),
      color: colorForIndex(0),
      isHost: true,
      connected: true,
      finished: false,
      place: null,
      finishTime: null,
      x: null,
      y: null,
      heldItem: null,
    };
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
    };
    lobbies.set(code, lobby);
    socket.join(code);
    socket.data.lobbyCode = code;
    cb && cb({ ok: true, lobby: lobbySnapshot(lobby), selfId: socket.id });
  });

  socket.on('joinLobby', ({ code, name } = {}, cb) => {
    const normalized = (code || '').toString().trim().toUpperCase();
    const lobby = lobbies.get(normalized);
    if (!lobby) return cb && cb({ ok: false, error: 'ไม่พบห้องนี้ ตรวจสอบโค้ดอีกครั้ง' });
    if (lobby.state !== 'waiting') return cb && cb({ ok: false, error: 'ห้องนี้เริ่มแข่งไปแล้ว รอรอบถัดไป' });
    const connectedCount = [...lobby.players.values()].filter((p) => p.connected).length;
    if (connectedCount >= MAX_PLAYERS_PER_LOBBY) {
      return cb && cb({ ok: false, error: `ห้องเต็มแล้ว (สูงสุด ${MAX_PLAYERS_PER_LOBBY} คน)` });
    }
    const color = colorForIndex(connectedCount);
    const player = {
      id: socket.id,
      name: sanitizeName(name),
      color,
      isHost: false,
      connected: true,
      finished: false,
      place: null,
      finishTime: null,
      x: null,
      y: null,
      heldItem: null,
    };
    lobby.players.set(socket.id, player);
    socket.join(lobby.code);
    socket.data.lobbyCode = lobby.code;
    cb && cb({ ok: true, lobby: lobbySnapshot(lobby), selfId: socket.id });
    broadcastLobby(lobby);
  });

  socket.on('startRace', () => {
    const lobby = getLobbyOfSocket(socket);
    if (!lobby) return;
    if (lobby.hostId !== socket.id) return;
    if (lobby.state !== 'waiting' && lobby.state !== 'results') return;
    if (lobby.players.size < 1) return;
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
      place: player.place,
      finishTime: player.finishTime,
    });
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
    player.heldItem = item.type;
    io.to(lobby.code).emit('itemCollected', { itemId, type: item.type, byId: player.id, byName: player.name });
  });

  // Use whatever power-up is currently held. 'turbo' and 'reveal' only
  // affect the user themselves; 'confuse' is the comeback/attack item — it
  // targets whichever *other* unfinished player is currently closest
  // (straight-line) to the exit, i.e. a rough stand-in for "the leader".
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

    // confuse
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
      io.to(target.id).emit('itemEffect', { type: 'confuse', duration: ITEM_EFFECT_MS.confuse, byName: player.name });
      io.to(lobby.code).emit('itemUsed', { byId: player.id, byName: player.name, type, targetName: target.name });
    } else {
      io.to(lobby.code).emit('itemUsed', { byId: player.id, byName: player.name, type, targetName: null });
    }
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
