// =============================================================================
// server.js — tiny authoritative LAN multiplayer server for the Paper.io game.
//
// Runs on the family Mac. It serves the game files AND runs the one true game
// (the SAME sim.js the browser uses), so every tablet just sends a heading and
// renders what the server broadcasts. Kids join over home WiFi at
// http://<this-mac-LAN-ip>:8080  (printed on startup).
//
//   npm install      (once)
//   npm start        → node server.js
//
// Internet later = deploy this same file to a host and set PORT; the client
// always connects back to whatever host served the page, so nothing else changes.
// =============================================================================
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");
const PaperSim = require("./sim.js");

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";   // 0.0.0.0 so other devices on the WiFi can reach us
const ROOT = __dirname;

// --- static file serving (allowlist only — never a generic file server) -----
const SERVE = { "/": "index.html", "/index.html": "index.html", "/sim.js": "sim.js" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const httpServer = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  const file = SERVE[url];
  if (!file) { res.writeHead(404); res.end("Not found"); return; }
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "text/plain" });
    res.end(data);
  });
});

// --- game config (the lobby will make these adjustable in a later milestone) -
const BOARD_DIMS = { small: [64, 40], medium: [84, 52], large: [108, 66] };
const MAX_PLAYERS = 8;
const CONFIG = {
  board: "medium",
  difficulty: "easy",   // gentle bots (small, slow grabs) — kid-friendly default; tune later with the lobby
  speedTick: 48,        // SPEED_TICK.normal — on-screen speed
  bots: 4,              // AI bots added alongside the humans (capped so humans + bots <= MAX_PLAYERS)
  winCond: "target",
  winThreshold: 0.6,    // a clear leader wins and the round restarts — no endless bot steamroll
  timedLimitMs: 120000,
  lives: 3,
  countdownMs: 1800,
};
const TICK_MS = 1000 / 30;        // authoritative 30 Hz tick
const now = () => performance.now();

// ===========================================================================
// Room — one default room for now. Holds the authoritative world + the tick loop.
// ===========================================================================
const room = {
  world: null,
  state: "lobby",      // lobby | countdown | playing | over
  conns: new Map(),    // ws -> { connId, name, actorId, joined }
  hostConnId: null,
  nextConnId: 1,
  humanCount: 0,
  timer: null,
  seq: 0,
  prevGrid: null,
  last: 0, acc: 0, playStart: 0, lastSpawn: 0, countdownEnd: 0, overUntil: 0,
};

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of room.conns.keys()) { if (ws.readyState === ws.OPEN) ws.send(msg); }
}
function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }

function joinedConns() { return [...room.conns.values()].filter((c) => c.joined); }
function pickHost() {
  // Host is the longest-present joined player; reassign if they left.
  if (room.hostConnId && joinedConns().some((c) => c.connId === room.hostConnId)) return;
  const first = joinedConns()[0];
  room.hostConnId = first ? first.connId : null;
}
function broadcastLobby() {
  pickHost();
  broadcast({ t: "lobby", state: room.state, hostConnId: room.hostConnId, players: joinedConns().map((c) => ({ connId: c.connId, name: c.name })) });
}

function packGrid(w) {
  const flat = new Array(w.COLS * w.ROWS);
  for (let y = 0; y < w.ROWS; y++) for (let x = 0; x < w.COLS; x++) flat[y * w.COLS + x] = w.grid[y][x];
  return flat;
}
function actorWire(a) {
  return { id: a.id, isBot: a.isBot, colorSeed: a.colorSeed, name: a.name, fx: a.isBot ? a.x + 0.5 : a.fx, fy: a.isBot ? a.y + 0.5 : a.fy, h: a.heading, alive: a.alive, dead: !!a.dead, trail: a.trail };
}
function snapshotFor(ws) {
  const w = room.world;
  send(ws, {
    t: "snapshot",
    cols: w.COLS, rows: w.ROWS, tickMs: CONFIG.speedTick, diffLabel: PaperSim.DIFFS[CONFIG.difficulty].label,
    winCond: w.winCond, winThreshold: w.winThreshold, timedLimitMs: w.timedLimitMs,
    state: room.state, countdownMs: Math.max(0, room.countdownEnd - now()),
    actors: w.actors.map(actorWire), grid: packGrid(w),
  });
}

// Build a fresh round for everyone in the lobby right now (+ bots to fill).
function buildRound() {
  const humans = joinedConns();
  if (humans.length === 0) return;
  const humanCount = humans.length;
  const [COLS, ROWS] = BOARD_DIMS[CONFIG.board];
  const numBots = Math.max(0, Math.min(CONFIG.bots, MAX_PLAYERS - humanCount));
  const w = PaperSim.createWorld(
    { COLS, ROWS, difficulty: CONFIG.difficulty, numBots, humanCount, winCond: CONFIG.winCond, winThreshold: CONFIG.winThreshold, timedLimitMs: CONFIG.timedLimitMs, lives: CONFIG.lives, mode: "online" },
    { now, rng: Math.random }
  );
  w.buildWorld();
  room.world = w;
  room.humanCount = humanCount;
  room.prevGrid = packGrid(w);
  // Participants (everyone in the lobby now) get a human actor; late joiners wait.
  for (const c of room.conns.values()) c.actorId = null;
  humans.forEach((c, i) => { const a = w.actors[i]; c.actorId = a.id; a.name = c.name || a.name; });
  room.state = "countdown";
  room.countdownEnd = now() + CONFIG.countdownMs;
  room.last = now(); room.acc = 0;
  // Identity + fresh world ONLY to participants; others stay in the lobby.
  for (const [ws, c] of room.conns) { if (c.actorId != null) { send(ws, { t: "joined", yourActorId: c.actorId, connId: c.connId }); snapshotFor(ws); } }
  broadcastLobby();   // late joiners now see "round in progress"
  ensureTicking();
}

function gridDeltasOrFull() {
  const w = room.world, g = w.grid, prev = room.prevGrid, COLS = w.COLS, ROWS = w.ROWS, N = COLS * ROWS;
  const deltas = []; let changed = 0;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) { const idx = y * COLS + x, v = g[y][x]; if (prev[idx] !== v) { deltas.push(idx, v); prev[idx] = v; changed++; } }
  if (changed > 0.4 * N) return { full: packGrid(w) };   // pathological: cheaper to resend
  return { deltas };
}

function tick() {
  const t = now();
  const w = room.world;
  if (!w) return;
  const dt = Math.min(0.05, (t - room.last) / 1000); room.last = t;

  if (room.state === "countdown" && t >= room.countdownEnd) {
    room.state = "playing"; room.playStart = t; room.lastSpawn = t; room.acc = 0;
    broadcast({ t: "state", state: "playing" });
  }

  if (room.state === "playing") {
    // humans move continuously from their last heading
    for (const c of room.conns.values()) { const a = w.actorById[c.actorId]; if (a && a.alive && !a.dead) w.moveContinuous(a, dt, CONFIG.speedTick); }
    // bots step on the game-speed accumulator
    room.acc += dt * 1000; if (room.acc > CONFIG.speedTick * 5) room.acc = CONFIG.speedTick * 5;
    while (!w.ended && room.acc >= CONFIG.speedTick) { w.stepBots(); room.acc -= CONFIG.speedTick; }
    // per-actor human death → respawn (or eliminate); never freezes the others
    for (const c of room.conns.values()) {
      const a = w.actorById[c.actorId];
      if (a && a.dead && t >= a.deadUntil) { if (a.lives > 0) w.respawn(a); else { a.dead = false; a.alive = false; } }
    }
    // keep bots topped up
    if (!w.ended && t - room.lastSpawn >= w.SPAWN_INTERVAL) {
      let ab = 0; for (const a of w.actors) if (a.isBot && a.alive) ab++;
      if (ab < Math.min(CONFIG.bots, MAX_PLAYERS - room.humanCount)) w.spawnBot();
      room.lastSpawn = t;
    }
    if (!w.ended && w.winCond === "timed" && t - room.playStart >= w.timedLimitMs) w.finishTimed();

    const events = w.drainEvents();
    const gd = gridDeltasOrFull();
    room.seq++;
    broadcast({ t: "tick", seq: room.seq, actors: w.actors.map(actorWire), gridDeltas: gd.deltas || null, grid: gd.full || null, events: events });

    if (w.ended) {
      room.state = "over"; room.overUntil = t + 5000;
      broadcast({ t: "state", state: "over", endResult: w.endResult });
    }
  } else if (room.state === "over") {
    if (t >= room.overUntil) { room.state = "lobby"; room.world = null; broadcastLobby(); }   // back to the lobby; host starts the next round
  }
}

function ensureTicking() {
  if (!room.timer) { room.last = now(); room.timer = setInterval(tick, TICK_MS); }
}
function maybeStopTicking() {
  if (room.conns.size === 0 && room.timer) { clearInterval(room.timer); room.timer = null; room.world = null; room.state = "lobby"; }
}

// ===========================================================================
// WebSocket connections
// ===========================================================================
const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (ws) => {
  const connId = room.nextConnId++;
  room.conns.set(ws, { connId, name: "Player " + connId, actorId: null, joined: false });
  send(ws, { t: "welcome", connId });
  ensureTicking();
  ws.on("message", (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    const c = room.conns.get(ws); if (!c) return;
    if (m.t === "join") {
      const nm = (typeof m.name === "string" ? m.name.slice(0, 16).trim() : "");
      c.name = nm || ("Player " + c.connId);
      c.joined = true;
      pickHost();
      broadcastLobby();
    } else if (m.t === "start") {
      if (c.connId === room.hostConnId && (room.state === "lobby" || room.state === "over")) buildRound();
    } else if (m.t === "steer") {
      if (room.state !== "playing" || !room.world) return;
      const a = room.world.actorById[c.actorId];
      if (a && a.alive && !a.dead && typeof m.h === "number" && isFinite(m.h)) room.world.steer(a, m.h);
    }
  });
  ws.on("close", () => { room.conns.delete(ws); pickHost(); broadcastLobby(); maybeStopTicking(); });
  ws.on("error", () => {});
});

// ===========================================================================
// Startup
// ===========================================================================
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name in ifs) for (const ni of ifs[name]) if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
  return out;
}
httpServer.listen(PORT, HOST, () => {
  const ips = lanIPs();
  console.log("");
  console.log("  🎮  Paper.io server is running!");
  console.log("");
  console.log("  On this Mac:     http://localhost:" + PORT);
  if (ips.length) for (const ip of ips) console.log("  On the tablets:  http://" + ip + ":" + PORT + "   ← type this on each tablet (same WiFi)");
  else console.log("  (No LAN address found — make sure WiFi is on.)");
  console.log("");
  console.log("  Press Ctrl-C to stop.");
  console.log("");
});
