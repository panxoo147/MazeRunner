// loadtest.js — spins up many simulated players ("bots") against a running
// Maze Race server, so you can see how a full lobby behaves (join speed,
// item pickups, finish order, race-end timing) without needing 40-50 real
// people. Each bot walks the shortest path from spawn to the exit (with a
// little randomness so they don't all move in perfect lockstep), grabs
// items along the way and uses them, then the script prints a summary.
//
// Usage:
//   node loadtest.js                                   # 20 bots vs http://localhost:3000
//   node loadtest.js --players 45                       # 45 bots (full lobby)
//   node loadtest.js --url https://your-app.onrender.com --players 30
//   node loadtest.js --code ABCDE --players 10           # join an existing lobby instead
//                                                          of creating one (a real host
//                                                          still has to click "start")
//   node loadtest.js --help                              # show all options
//
// Requires the 'socket.io-client' package — run `npm install` first (it's
// listed in package.json's devDependencies).

'use strict';
const { io } = require('socket.io-client');

// ---------- args ----------
function parseArgs() {
  const args = { url: 'http://localhost:3000', players: 20, code: null, speed: 170 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i];
    else if (a === '--players') args.players = parseInt(argv[++i], 10);
    else if (a === '--code') args.code = (argv[++i] || '').toUpperCase();
    else if (a === '--speed') args.speed = parseFloat(argv[++i]);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  if (!Number.isFinite(args.players) || args.players < 1) args.players = 20;
  return args;
}

function printHelp() {
  console.log(`
Maze Race load tester — simulates many players racing in one lobby.

  --url <url>       server URL (default: http://localhost:3000)
  --players <n>      how many bots to simulate (default: 20)
  --code <code>       join an EXISTING lobby instead of creating a new one —
                       useful to fill out a lobby you're already testing in a
                       real browser. A real host still has to click "start".
  --speed <px/s>      base bot movement speed (default: 170, ±15% per bot)
  --help              show this help

Examples:
  node loadtest.js --players 45
  node loadtest.js --url https://your-app.onrender.com --players 30
`);
}

const args = parseArgs();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- shortest-path helper (same BFS the client uses for the 'reveal' item) ----------
function shortestCellPath(maze, sx, sy, ex, ey) {
  const { cols, rows, hWalls, vWalls } = maze;
  const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const prevX = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  const prevY = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  visited[sy][sx] = true;
  const queue = [[sx, sy]];
  while (queue.length) {
    const [x, y] = queue.shift();
    if (x === ex && y === ey) break;
    const nbrs = [];
    if (!hWalls[y][x]) nbrs.push([x, y - 1]);
    if (!hWalls[y + 1][x]) nbrs.push([x, y + 1]);
    if (!vWalls[y][x]) nbrs.push([x - 1, y]);
    if (!vWalls[y][x + 1]) nbrs.push([x + 1, y]);
    for (const [nx, ny] of nbrs) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || visited[ny][nx]) continue;
      visited[ny][nx] = true;
      prevX[ny][nx] = x; prevY[ny][nx] = y;
      queue.push([nx, ny]);
    }
  }
  if (!visited[ey][ex]) return [];
  const path = [];
  let cx = ex, cy = ey;
  while (!(cx === sx && cy === sy) && cx !== -1) {
    path.push({ x: (cx + 0.5) * maze.cellSize, y: (cy + 0.5) * maze.cellSize });
    const px = prevX[cy][cx], py = prevY[cy][cx];
    cx = px; cy = py;
  }
  path.push({ x: (sx + 0.5) * maze.cellSize, y: (sy + 0.5) * maze.cellSize });
  path.reverse();
  return path;
}

// ---------- bot ----------
class Bot {
  constructor(name, url) {
    this.name = name;
    this.socket = io(url, { transports: ['websocket'], reconnection: false });
    this.x = 0; this.y = 0;
    this.path = [];
    this.pathIndex = 0;
    this.speed = args.speed * (0.85 + Math.random() * 0.3); // ±15% so bots don't move in lockstep
    this.heldItem = null;
    this.holdSince = 0;
    this.finished = false;
    this.finishTime = null;
    this.place = null;
    this.itemsCollected = 0;
    this.itemsUsed = 0;
    this.lastMoveEmit = 0;
    this.errors = 0;
    this.maze = null;

    this.socket.on('connect_error', (e) => { this.errors++; });
    this.socket.on('itemCollected', ({ itemId, byId }) => {
      if (byId === this.socket.id) { this.itemsCollected++; this.heldItem = itemId; this.holdSince = Date.now(); }
    });
    this.socket.on('playerFinished', ({ id, place, finishTime }) => {
      if (id === this.socket.id) { this.finished = true; this.place = place; this.finishTime = finishTime; }
    });
  }

  connect() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timeout')), 8000);
      this.socket.once('connect', () => { clearTimeout(t); resolve(); });
      this.socket.once('connect_error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  setupRace(maze) {
    this.maze = maze;
    this.heldItem = null;
    this.finished = false;
    const cs = maze.cellSize;
    const sx = Math.max(0, Math.min(maze.cols - 1, Math.floor(maze.spawn.x / cs)));
    const sy = Math.max(0, Math.min(maze.rows - 1, Math.floor(maze.spawn.y / cs)));
    const ex = Math.max(0, Math.min(maze.cols - 1, Math.floor(maze.exitZone.x / cs)));
    const ey = Math.max(0, Math.min(maze.rows - 1, Math.floor(maze.exitZone.y / cs)));
    this.path = shortestCellPath(maze, sx, sy, ex, ey);
    this.pathIndex = 0;
    // small random offset from spawn center so bots don't spawn exactly stacked
    this.x = maze.spawn.x + (Math.random() - 0.5) * maze.spawn.radius;
    this.y = maze.spawn.y + (Math.random() - 0.5) * maze.spawn.radius;
  }

  // advance one simulation tick (dtMs milliseconds)
  tick(dtMs, nowMs) {
    if (this.finished || !this.maze || this.path.length === 0) return;
    const dt = dtMs / 1000;
    const wp = this.path[this.pathIndex];
    if (wp) {
      const dx = wp.x - this.x, dy = wp.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 6) {
        this.pathIndex++;
      } else {
        this.x += (dx / dist) * this.speed * dt;
        this.y += (dy / dist) * this.speed * dt;
      }
    }

    // use whatever we're holding after a short random delay, like a real
    // player would rather than hoarding it forever
    if (this.heldItem && nowMs - this.holdSince > 1200 + Math.random() * 1800) {
      this.socket.emit('useItem');
      this.heldItem = null;
      this.itemsUsed++;
    }

    if (nowMs - this.lastMoveEmit > 70) {
      this.lastMoveEmit = nowMs;
      this.socket.emit('move', { x: this.x, y: this.y });
    }

    if (this.pathIndex >= this.path.length - 1) {
      const ex = this.x - this.maze.exitZone.x, ey = this.y - this.maze.exitZone.y;
      if (Math.sqrt(ex * ex + ey * ey) <= this.maze.exitZone.radius) {
        this.socket.emit('finish');
      }
    }
  }

  tryCollectNearbyItems(items) {
    if (this.heldItem || !items || !this.maze) return; // maze isn't set until this bot's own 'raceStarting' has fired
    for (const it of items) {
      if (it.collected) continue;
      const dx = this.x - it.x, dy = this.y - it.y;
      if (Math.sqrt(dx * dx + dy * dy) <= (this.maze.itemPickupRadius || 20)) {
        this.socket.emit('collectItem', { itemId: it.id });
        break; // one request at a time — server confirms via 'itemCollected'
      }
    }
  }

  close() { this.socket.close(); }
}

// ---------- main ----------
async function main() {
  console.log(`Maze Race load test — ${args.players} bot(s) → ${args.url}${args.code ? ` (joining lobby ${args.code})` : ' (creating a new lobby)'}\n`);

  const bots = [];
  for (let i = 0; i < args.players; i++) bots.push(new Bot(`Bot${i + 1}`, args.url));

  const connectStart = Date.now();
  const connectResults = await Promise.allSettled(bots.map((b) => b.connect()));
  const connected = connectResults.filter((r) => r.status === 'fulfilled').length;
  console.log(`connected: ${connected}/${bots.length} in ${Date.now() - connectStart}ms`);
  if (connected === 0) {
    console.error('No bots could connect — is the server running at ' + args.url + ' ?');
    process.exit(1);
  }
  const liveBots = bots.filter((b, i) => connectResults[i].status === 'fulfilled');

  const usingExistingLobby = !!args.code;
  let code = args.code;
  const joinStart = Date.now();
  if (!usingExistingLobby) {
    const host = liveBots[0];
    const created = await new Promise((resolve) => host.socket.emit('createLobby', { name: host.name }, resolve));
    if (!created.ok) { console.error('createLobby failed:', created.error); process.exit(1); }
    code = created.lobby.code;
    console.log(`lobby created: ${code} (host: ${host.name})`);
  }

  // when we created the lobby, bot 0 is already in it as host — only the
  // rest need to join
  const joinTargets = usingExistingLobby ? liveBots : liveBots.slice(1);
  const joinResults = await Promise.allSettled(
    joinTargets.map((b) => new Promise((resolve, reject) => {
      b.socket.emit('joinLobby', { code, name: b.name }, (res) => (res.ok ? resolve(res) : reject(new Error(res.error))));
    }))
  );
  const joinFailures = joinResults
    .map((r, i) => (r.status === 'rejected' ? { bot: joinTargets[i], reason: r.reason.message } : null))
    .filter(Boolean);
  const joined = joinTargets.length - joinFailures.length + (usingExistingLobby ? 0 : 1);
  console.log(`joined lobby ${code}: ${joined}/${liveBots.length} in ${Date.now() - joinStart}ms`);
  if (joinFailures.length) {
    // e.g. lobby already full, or already racing and these weren't spectators
    // — drop them now so they don't sit around forever waiting for a
    // 'raceStarting' that will never come for a lobby they're not in
    const reasons = [...new Set(joinFailures.map((f) => f.reason))];
    console.log(`  ${joinFailures.length} bot(s) couldn't join and were dropped — reason(s): ${reasons.join('; ')}`);
    const failedBots = new Set(joinFailures.map((f) => f.bot));
    joinFailures.forEach((f) => f.bot.close());
    for (let i = liveBots.length - 1; i >= 0; i--) {
      if (failedBots.has(liveBots[i])) liveBots.splice(i, 1);
    }
  }
  if (liveBots.length === 0) {
    console.error('No bots ended up in the lobby — nothing to simulate.');
    process.exit(1);
  }

  if (args.code) {
    console.log(`\nWaiting for a real player to start the race from the browser (lobby ${code})...`);
  } else {
    console.log('\nstarting race...');
    await sleep(400); // let lobbyUpdate broadcasts settle before starting
    liveBots[0].socket.emit('startRace');
  }

  // ---------- wire up race lifecycle ----------
  let maze = null;
  let raceStartAt = null;
  let raceEnded = false;
  let raceEndPayload = null;
  let raceStartLogged = false;
  const items = new Map();

  liveBots.forEach((b) => {
    b.socket.on('raceStarting', (p) => {
      maze = p.maze;
      raceStartAt = p.raceStartAt;
      items.clear();
      for (const it of maze.items) items.set(it.id, { ...it, collected: false });
      b.setupRace(maze);
      if (!raceStartLogged) {
        raceStartLogged = true;
        console.log(`\nrace starting — maze ${maze.cols}x${maze.rows}, ${maze.items.length} items, countdown ends in ${Math.max(0, raceStartAt - Date.now())}ms`);
      }
    });
    b.socket.on('itemCollected', ({ itemId }) => { const it = items.get(itemId); if (it) it.collected = true; });
    b.socket.on('itemRespawned', ({ itemId }) => { const it = items.get(itemId); if (it) it.collected = false; });
    b.socket.on('raceEnded', (p) => { if (!raceEnded) { raceEnded = true; raceEndPayload = p; } });
  });

  // wait for raceStarting to fire (skip if joining an existing lobby that
  // hasn't started yet — poll until it does, or give up after 5 minutes)
  const waitStart = Date.now();
  while (!maze) {
    if (Date.now() - waitStart > 5 * 60 * 1000) { console.error('timed out waiting for the race to start'); liveBots.forEach((b) => b.close()); process.exit(1); }
    await sleep(200);
  }

  const raceWaitMs = Math.max(0, raceStartAt - Date.now() + 150);
  await sleep(raceWaitMs);
  console.log('go! simulating movement...\n');

  // ---------- simulation loop ----------
  const TICK_MS = 50;
  let lastTick = Date.now();
  let lastHeartbeat = Date.now();
  const simStart = Date.now();
  const MAX_RACE_MS = 8 * 60 * 1000; // safety cap in case something never finishes

  while (!raceEnded && Date.now() - simStart < MAX_RACE_MS) {
    const now = Date.now();
    const dt = now - lastTick;
    lastTick = now;
    for (const b of liveBots) {
      if (!b.finished && b.maze) { // b.maze can lag briefly right after the global 'maze' is first set
        b.tryCollectNearbyItems([...items.values()]);
        b.tick(dt, now);
      }
    }
    if (now - lastHeartbeat > 3000) {
      lastHeartbeat = now;
      const finishedCount = liveBots.filter((b) => b.finished).length;
      console.log(`  ...${finishedCount}/${liveBots.length} finished, ${Math.round((now - simStart) / 1000)}s elapsed`);
    }
    await sleep(TICK_MS);
  }

  await sleep(300); // let final events land

  // ---------- summary ----------
  console.log('\n=== SUMMARY ===');
  if (raceEndPayload) {
    console.log(`race ended: reason=${raceEndPayload.reason}`);
  } else {
    console.log('race did not end within the safety timeout — stopping anyway');
  }
  const finishers = liveBots.filter((b) => b.finished).sort((a, b2) => a.place - b2.place);
  const dnf = liveBots.filter((b) => !b.finished);
  console.log(`finishers: ${finishers.length}/${liveBots.length}  |  DNF: ${dnf.length}`);
  if (finishers.length) {
    const times = finishers.map((b) => b.finishTime);
    const avg = times.reduce((a, c) => a + c, 0) / times.length;
    console.log(`finish times — fastest: ${(Math.min(...times) / 1000).toFixed(1)}s, slowest: ${(Math.max(...times) / 1000).toFixed(1)}s, avg: ${(avg / 1000).toFixed(1)}s`);
    finishers.slice(0, 5).forEach((b) => console.log(`  #${b.place} ${b.name} — ${(b.finishTime / 1000).toFixed(1)}s`));
  }
  const totalItemsCollected = liveBots.reduce((a, b) => a + b.itemsCollected, 0);
  const totalItemsUsed = liveBots.reduce((a, b) => a + b.itemsUsed, 0);
  const totalErrors = liveBots.reduce((a, b) => a + b.errors, 0);
  console.log(`items collected: ${totalItemsCollected}  |  items used: ${totalItemsUsed}  |  connection errors: ${totalErrors}`);
  console.log(`total wall-clock for this run: ${((Date.now() - connectStart) / 1000).toFixed(1)}s`);

  liveBots.forEach((b) => b.close());
  process.exit(0);
}

main().catch((e) => { console.error('load test crashed:', e); process.exit(1); });
