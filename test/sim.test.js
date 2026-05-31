"use strict";
// Unit tests for the pure simulation (sim.js). Run with: npm test  (node --test)
// These exercise the bug-prone core: flood-fill claiming, self/enemy collisions,
// connectivity pruning, win detection, and the 4-connected continuous trail.
const test = require("node:test");
const assert = require("node:assert");
const PaperSim = require("../sim.js");

// Deterministic world helper (fixed rng + clock).
function makeWorld(over) {
  const opts = Object.assign(
    { COLS: 24, ROWS: 24, difficulty: "normal", numBots: 0, humanCount: 1, winCond: "target", winThreshold: 1, timedLimitMs: 120000, lives: 3, mode: "solo" },
    over || {}
  );
  let t = 0;
  const w = PaperSim.createWorld(opts, { now: () => (t += 16), rng: () => 0.5 });
  w.buildWorld();
  return w;
}
function clearGrid(w) { for (let y = 0; y < w.ROWS; y++) for (let x = 0; x < w.COLS; x++) w.grid[y][x] = w.EMPTY; w.trailOwner.clear(); }
function fillRect(w, id, x0, y0, x1, y1) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) w.grid[y][x] = id; }
function countOf(w, id) { let n = 0; for (let y = 0; y < w.ROWS; y++) for (let x = 0; x < w.COLS; x++) if (w.grid[y][x] === id) n++; return n; }

test("claimFor encloses a rectangle: interior + trail captured, outside untouched", () => {
  const w = makeWorld({ winThreshold: 1 });   // threshold 1 so the claim itself won't end the game
  const p = w.player;
  clearGrid(w);
  // Home = a horizontal strip along row 12, cols 5..14.
  fillRect(w, p.id, 5, 12, 14, 12);
  p.x = 5; p.y = 12; p.trail = []; p.trailSet.clear(); p.recent = [];
  // Walk the 3 open sides of a rectangle, then step back onto home to close the loop.
  const path = [];
  for (let y = 11; y >= 7; y--) path.push([5, y]);     // up the left side
  for (let x = 6; x <= 14; x++) path.push([x, 7]);      // across the top
  for (let y = 8; y <= 11; y++) path.push([14, y]);     // down the right side
  path.push([14, 12]);                                  // re-enter home → triggers claim
  for (const [x, y] of path) { const alive = w.enterCell(p, x, y); assert.ok(alive, "should survive laying its own fresh trail at " + x + "," + y); }
  assert.equal(p.trail.length, 0, "trail consumed by the claim");
  assert.equal(w.grid[9][10], p.id, "interior cell captured by flood-fill");
  assert.equal(w.grid[7][5], p.id, "trail corner is owned");
  assert.equal(w.grid[12][9], p.id, "home strip still owned");
  assert.equal(w.grid[0][0], w.EMPTY, "far outside cell NOT captured (no leak)");
  assert.equal(w.grid[20][20], w.EMPTY, "other outside cell NOT captured");
});

test("crossing your OWN older trail kills you (and costs a life)", () => {
  const w = makeWorld();
  const p = w.player;
  clearGrid(w);
  fillRect(w, p.id, 2, 12, 4, 12);
  p.x = 4; p.y = 12; p.trail = []; p.trailSet.clear(); p.recent = [];
  const lives0 = p.lives;
  // Lay a straight trail well longer than SELF_GRACE.
  for (let x = 5; x <= 14; x++) assert.ok(w.enterCell(p, x, 12));
  // Step onto an OLD trail cell (col 6, far behind the head) → death.
  const survived = w.enterCell(p, 6, 12);
  assert.equal(survived, false, "entering old trail returns died=false");
  assert.equal(p.dead, true, "player marked dead");
  assert.equal(p.lives, lives0 - 1, "lost exactly one life");
});

test("SELF_GRACE: the cells right behind the head do NOT kill you", () => {
  const w = makeWorld();
  const p = w.player;
  clearGrid(w);
  fillRect(w, p.id, 2, 12, 4, 12);
  p.x = 4; p.y = 12; p.trail = []; p.trailSet.clear(); p.recent = [];
  for (let x = 5; x <= 10; x++) assert.ok(w.enterCell(p, x, 12));
  // Re-enter the most recent cell (still in the grace window) → no death.
  const lastCell = p.recent[p.recent.length - 1].split(",").map(Number);
  const survived = w.enterCell(p, lastCell[0], lastCell[1]);
  assert.equal(survived, true, "recent trail cell is safe");
  assert.equal(p.dead, false, "still alive");
});

test("cutting a bot's trail absorbs its whole territory to the killer", () => {
  const w = makeWorld({ numBots: 1, winThreshold: 1 });
  const p = w.player;
  const bot = w.actors.find((a) => a.isBot);
  clearGrid(w);
  // Bot owns a block; bot has an exposed trail leading out of it.
  fillRect(w, bot.id, 16, 4, 20, 8);
  const botTrail = [[15, 6], [14, 6], [13, 6]];
  for (const [x, y] of botTrail) { bot.trail.push({ x, y }); bot.trailSet.add(w.key(x, y)); w.trailOwner.set(w.key(x, y), bot.id); }
  // Player owns a block on the left and is about to step onto the bot's trail tip.
  fillRect(w, p.id, 2, 4, 6, 8);
  p.x = 12; p.y = 6; p.trail = []; p.trailSet.clear(); p.recent = [];
  const before = countOf(w, p.id);
  const survived = w.enterCell(p, 13, 6);   // step onto bot trail cell → cut it
  assert.ok(survived, "killer survives the cut");
  assert.equal(bot.alive, false, "bot eliminated");
  assert.equal(countOf(w, bot.id), 0, "bot has no territory left");
  assert.ok(countOf(w, p.id) > before, "killer gained territory from the absorb");
});

test("pruneTerritory keeps only the blob under the head", () => {
  const w = makeWorld();
  const p = w.player;
  clearGrid(w);
  fillRect(w, p.id, 1, 1, 4, 4);      // blob A (head will be here)
  fillRect(w, p.id, 18, 18, 21, 21);  // blob B (disconnected island)
  p.x = 2; p.y = 2;
  w.pruneTerritory(p);
  assert.equal(w.grid[2][2], p.id, "blob under head kept");
  assert.equal(w.grid[20][20], w.EMPTY, "disconnected island dropped");
});

test("reaching the target share ends the game with a winner", () => {
  const w = makeWorld({ COLS: 12, ROWS: 12, winThreshold: 0.3 });
  const p = w.player;
  clearGrid(w);
  // Pre-own most of the board, leave a thin trail loop that captures the rest.
  fillRect(w, p.id, 0, 0, 11, 8);
  p.x = 0; p.y = 8; p.trail = []; p.trailSet.clear(); p.recent = [];
  w.enterCell(p, 0, 9); // small excursion
  w.enterCell(p, 0, 8); // back into own land → claim → checkEndgame
  assert.equal(w.ended, true, "game ended");
  assert.equal(w.endResult.reason, "target", "ended by target threshold");
  assert.equal(w.endResult.winnerId, p.id, "player is the winner");
});

test("moveContinuous lays a 4-connected trail on a diagonal (no corner gaps)", () => {
  const w = makeWorld({ COLS: 40, ROWS: 40, winThreshold: 1 });
  const p = w.player;
  clearGrid(w);
  fillRect(w, p.id, 2, 2, 6, 6);      // small home in the corner
  p.x = 6; p.y = 6; p.fx = 6.5; p.fy = 6.5; p.trail = []; p.trailSet.clear(); p.recent = [];
  w.steer(p, Math.PI / 4);            // head down-right at 45°
  for (let f = 0; f < 30 && !p.dead && !w.ended; f++) w.moveContinuous(p, 1 / 30, 48);
  assert.ok(p.trail.length >= 3, "laid a diagonal trail");
  for (let i = 1; i < p.trail.length; i++) {
    const dx = Math.abs(p.trail[i].x - p.trail[i - 1].x), dy = Math.abs(p.trail[i].y - p.trail[i - 1].y);
    assert.equal(dx + dy, 1, "consecutive trail cells are 4-adjacent at index " + i + " (" + dx + "," + dy + ")");
  }
});
