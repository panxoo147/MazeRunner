// maze.js — procedural maze generation (recursive backtracker) + collision data
// The maze is generated on the server so every player in a lobby races the
// exact same layout. Wall data is sent to clients once; clients handle their
// own movement/collision locally (client-authoritative for smoothness) and
// only report finish events + throttled positions back to the server.

'use strict';

const CELL_SIZE = 46; // px per maze cell
const WALL_THICKNESS = 6;

// Power-up item types scattered through the maze — see server.js for how
// each one is actually applied (server decides effects/targets; this file
// only decides where items spawn).
const ITEM_TYPES = ['turbo', 'confuse', 'reveal'];
const ITEM_PICKUP_RADIUS = 20;

// Host-configurable "Map Size" room setting (see the create-room modal) —
// a multiplier applied on top of the normal player-count-based sizing
// below, so a host can deliberately run a smaller/cozier or bigger/longer
// maze than the default for their player count. 1 = unchanged. Clamped
// here as a last line of defense; server.js is expected to have already
// sanitized whatever a client sent before it ever reaches generateMaze().
const MIN_MAP_SIZE_MULTIPLIER = 0.5;
const MAX_MAP_SIZE_MULTIPLIER = 2;
const DEFAULT_MAP_SIZE_MULTIPLIER = 1;

function clampMapSizeMultiplier(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAP_SIZE_MULTIPLIER;
  return Math.min(MAX_MAP_SIZE_MULTIPLIER, Math.max(MIN_MAP_SIZE_MULTIPLIER, n));
}

/**
 * Pick a maze size that scales gently with the number of players so a
 * lobby has enough room to spread out and doesn't turn into a single-file
 * traffic jam. Growth is capped at the 30-player size — past 30, more
 * players should mean a more crowded, item-rich map (see itemCountFor),
 * not a map that just keeps getting bigger and emptier-feeling. The result
 * is then scaled by `multiplier` (see MIN/MAX_MAP_SIZE_MULTIPLIER above)
 * and floored/capped to a range that's always generable and playable no
 * matter how it's dialed.
 */
function sizeForPlayers(playerCount, multiplier) {
  const n = Math.min(30, Math.max(1, playerCount || 1));
  const base = 26;
  const extra = Math.min(24, Math.floor(n / 2));
  const mult = clampMapSizeMultiplier(multiplier);
  const cols = Math.round((base + extra) * mult); // up to 41 before the multiplier (the 30-player size)
  const rows = Math.round(cols * 0.72);
  // Floors keep the two 3x3 spawn/exit rooms from crowding each other (or
  // the maze) at the smallest multiplier; the cap keeps generation time and
  // item/wall counts sane at the largest.
  return {
    cols: Math.min(90, Math.max(16, cols)),
    rows: Math.min(65, Math.max(12, rows)),
  };
}

function makeRng(seed) {
  // simple mulberry32 PRNG so mazes are reproducible from a numeric seed
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateMaze({ cols, rows, seed, playerCount, mapSizeMultiplier }) {
  if (!cols || !rows) {
    const s = sizeForPlayers(playerCount, mapSizeMultiplier);
    cols = s.cols;
    rows = s.rows;
  }
  const rng = makeRng(seed >>> 0);

  // hWalls[y][x]: horizontal wall segment on top edge of cell (x,y); y ranges 0..rows
  // vWalls[y][x]: vertical wall segment on left edge of cell (x,y); x ranges 0..cols
  const hWalls = Array.from({ length: rows + 1 }, () => new Array(cols).fill(true));
  const vWalls = Array.from({ length: rows }, () => new Array(cols + 1).fill(true));
  const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));

  // iterative randomized DFS (recursive backtracker)
  const stack = [[0, 0]];
  visited[0][0] = true;
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const neighbors = [];
    if (cy > 0 && !visited[cy - 1][cx]) neighbors.push([cx, cy - 1, 'N']);
    if (cx < cols - 1 && !visited[cy][cx + 1]) neighbors.push([cx + 1, cy, 'E']);
    if (cy < rows - 1 && !visited[cy + 1][cx]) neighbors.push([cx, cy + 1, 'S']);
    if (cx > 0 && !visited[cy][cx - 1]) neighbors.push([cx - 1, cy, 'W']);

    if (neighbors.length === 0) {
      stack.pop();
      continue;
    }
    const [nx, ny, dir] = neighbors[Math.floor(rng() * neighbors.length)];
    if (dir === 'N') hWalls[cy][cx] = false;
    else if (dir === 'S') hWalls[cy + 1][cx] = false;
    else if (dir === 'E') vWalls[cy][cx + 1] = false;
    else if (dir === 'W') vWalls[cy][cx] = false;
    visited[ny][nx] = true;
    stack.push([nx, ny]);
  }

  // Braid the maze only lightly: knock down a small fraction of remaining
  // interior walls so there's *some* loop/alternate-route relief for 40-50
  // players funneling through the same corridors, without erasing what
  // makes a maze hard. Lower braidChance = fewer shortcuts = more dead ends
  // and longer, twistier paths to the exit (a fully unbraided/"perfect"
  // maze has the maximum possible number of dead ends for its size).
  const braidChance = 0.045;
  for (let y = 1; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (hWalls[y][x] && rng() < braidChance) hWalls[y][x] = false;
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 1; x < cols; x++) {
      if (vWalls[y][x] && rng() < braidChance) vWalls[y][x] = false;
    }
  }

  // Carve an open spawn room (top-left) and exit room (bottom-right) so
  // dozens of players don't spawn stacked in a single 1-wide cell.
  const roomSize = 3;
  function openRoom(x0, y0) {
    for (let y = y0; y < y0 + roomSize; y++) {
      for (let x = x0; x < x0 + roomSize; x++) {
        if (x < cols - 1 && x + 1 < x0 + roomSize) vWalls[y][x + 1] = false;
        if (y < rows - 1 && y + 1 < y0 + roomSize) hWalls[y + 1][x] = false;
      }
    }
  }
  openRoom(0, 0);
  openRoom(cols - roomSize, rows - roomSize);

  const items = generateItems({ cols, rows, roomSize, rng, playerCount });

  const wallSegments = [];
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (hWalls[y][x]) {
        wallSegments.push({ x1: x * CELL_SIZE, y1: y * CELL_SIZE, x2: (x + 1) * CELL_SIZE, y2: y * CELL_SIZE });
      }
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x <= cols; x++) {
      if (vWalls[y][x]) {
        wallSegments.push({ x1: x * CELL_SIZE, y1: y * CELL_SIZE, x2: x * CELL_SIZE, y2: (y + 1) * CELL_SIZE });
      }
    }
  }

  const spawn = {
    x: (roomSize * CELL_SIZE) / 2,
    y: (roomSize * CELL_SIZE) / 2,
    radius: (roomSize * CELL_SIZE) / 2 - CELL_SIZE * 0.3,
  };
  const exitZone = {
    x: cols * CELL_SIZE - (roomSize * CELL_SIZE) / 2,
    y: rows * CELL_SIZE - (roomSize * CELL_SIZE) / 2,
    radius: (roomSize * CELL_SIZE) / 2 - CELL_SIZE * 0.3,
  };

  return {
    cols,
    rows,
    cellSize: CELL_SIZE,
    wallThickness: WALL_THICKNESS,
    hWalls,
    vWalls,
    wallSegments,
    width: cols * CELL_SIZE,
    height: rows * CELL_SIZE,
    spawn,
    exitZone,
    items,
    itemPickupRadius: ITEM_PICKUP_RADIUS,
  };
}

/**
 * How many mystery-box pickups to scatter. Scales with whichever calls for
 * more: maze size (a bigger maze needs more items to keep the same density)
 * or player count (more racers competing means more power-ups needed to go
 * around). This used to be capped at a flat 45 no matter how big the maze
 * got, so a 50-player race — whose maze is much bigger than a small lobby's
 * — ended up with the exact same item count as a 10-player one and felt
 * noticeably emptier. The cap now scales with maze area instead of being a
 * fixed number, so a big/crowded race actually gets more items.
 */
function itemCountFor(candidateCount, playerCount) {
  const areaBased = Math.floor(candidateCount / 18);
  const playerBased = Math.round((playerCount || 10) * 1.3);
  const raw = Math.max(areaBased, playerBased);
  const areaCap = Math.floor(candidateCount / 10); // keep density sane even for huge lobbies
  return Math.max(10, Math.min(areaCap, raw));
}

/**
 * Scatter power-up pickups across the maze (skipping the open spawn/exit
 * rooms so nobody grabs one before the race even starts).
 */
function generateItems({ cols, rows, roomSize, rng, playerCount }) {
  const inRoom = (x, y) =>
    (x < roomSize && y < roomSize) ||
    (x >= cols - roomSize && y >= rows - roomSize);

  const candidates = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!inRoom(x, y)) candidates.push([x, y]);
    }
  }
  // Fisher-Yates shuffle (seeded) so item placement is reproducible per seed
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  // Pickups are now anonymous "mystery boxes" — the type is rolled by the
  // server at the moment a player actually collects one (see server.js's
  // 'collectItem' handler), not fixed to a location here. That's what makes
  // it "random": the same spot can hand out a different power-up every time
  // it's grabbed, instead of always being e.g. "the turbo spot".
  const count = itemCountFor(candidates.length, playerCount);
  const items = [];
  for (let i = 0; i < count && i < candidates.length; i++) {
    const [cx, cy] = candidates[i];
    items.push({
      id: `item_${i}`,
      x: (cx + 0.5) * CELL_SIZE,
      y: (cy + 0.5) * CELL_SIZE,
    });
  }
  return items;
}

module.exports = {
  generateMaze,
  sizeForPlayers,
  CELL_SIZE,
  WALL_THICKNESS,
  ITEM_TYPES,
  ITEM_PICKUP_RADIUS,
  MIN_MAP_SIZE_MULTIPLIER,
  MAX_MAP_SIZE_MULTIPLIER,
  DEFAULT_MAP_SIZE_MULTIPLIER,
};
