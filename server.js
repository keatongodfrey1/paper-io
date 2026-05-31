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
const QRCode = require("qrcode");
const PaperSim = require("./sim.js");

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";   // 0.0.0.0 so other devices on the WiFi can reach us
const ROOT = __dirname;
let lanUrl = "", qrSvg = "";                   // the join URL + its QR image (set on startup)

// --- static file serving (allowlist only — never a generic file server) -----
const SERVE = { "/": "index.html", "/index.html": "index.html", "/sim.js": "sim.js" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const httpServer = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/lan-url") { res.writeHead(200, { "content-type": "text/plain" }); res.end(lanUrl); return; }
  if (url === "/qr") { res.writeHead(200, { "content-type": "image/svg+xml" }); res.end(qrSvg); return; }
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
const SPEED_TICK = { slow: 72, normal: 48, fast: 33 };   // ms per game-speed step
const CONFIG = {                // defaults; the host can change these in the lobby
  board: "medium",
  difficulty: "normal",         // matches solo's default
  speed: "normal",              // slow | normal | fast (on-screen speed)
  bots: 3,                      // AI bots added alongside the humans (capped so humans + bots <= MAX_PLAYERS)
  win: "target",                // 'target' | 'timed'
  winPct: 60,                   // target % to win
  winSecs: 120,                 // timed-mode seconds
  lives: 3,
  countdownMs: 2800,            // matches solo's 3·2·1·Go! (3*COUNT_STEP + GO_MS)
};
const speedTick = () => SPEED_TICK[CONFIG.speed] || 48;
const SPAWN_CAP_SHARE = 0.8;    // stop dropping in new bots once anyone holds this share
const TICK_MS = 1000 / 30;        // authoritative 30 Hz tick
const now = () => performance.now();

// ===========================================================================
// Room — one default room for now. Holds the authoritative world + the tick loop.
// ===========================================================================
const room = {
  world: null,
  state: "lobby",      // lobby | countdown | playing | over
  conns: new Map(),    // ws -> seat (currently-connected sockets)
  seats: new Map(),    // token -> seat (incl. recently-dropped, held for reconnect)
  hostConnId: null,
  nextConnId: 1,
  humanCount: 0,
  timer: null,
  seq: 0,
  prevGrid: null,
  last: 0, acc: 0, playStart: 0, lastSpawn: 0, countdownEnd: 0, overUntil: 0,
};
const GRACE_MS = 30000;   // hold a dropped player's spot this long for reconnect
const randomToken = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

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
function lobbySettings() {
  return { difficulty: CONFIG.difficulty, board: CONFIG.board, speed: CONFIG.speed, bots: CONFIG.bots, win: CONFIG.win, winPct: CONFIG.winPct, winSecs: CONFIG.winSecs, lives: CONFIG.lives };
}
function broadcastLobby() {
  pickHost();
  const humans = joinedConns();
  const allReady = humans.length >= 1 && humans.every((c) => c.ready);
  broadcast({ t: "lobby", state: room.state, hostConnId: room.hostConnId, settings: lobbySettings(), allReady, players: humans.map((c) => ({ connId: c.connId, name: c.name, ready: !!c.ready })) });
}

function packGrid(w) {
  const flat = new Array(w.COLS * w.ROWS);
  for (let y = 0; y < w.ROWS; y++) for (let x = 0; x < w.COLS; x++) flat[y * w.COLS + x] = w.grid[y][x];
  return flat;
}
function actorWire(a) {
  return { id: a.id, isBot: a.isBot, colorSeed: a.colorSeed, name: a.name, fx: a.isBot ? a.x + 0.5 : a.fx, fy: a.isBot ? a.y + 0.5 : a.fy, h: a.heading, alive: a.alive, dead: !!a.dead, lives: a.lives, trail: a.trail };
}
function snapshotFor(ws) {
  const w = room.world;
  send(ws, {
    t: "snapshot",
    cols: w.COLS, rows: w.ROWS, tickMs: speedTick(), diffLabel: PaperSim.DIFFS[CONFIG.difficulty].label,
    winCond: w.winCond, winThreshold: w.winThreshold, timedLimitMs: w.timedLimitMs,
    state: room.state, countdownMs: Math.max(0, room.countdownEnd - now()),
    actors: w.actors.map(actorWire), grid: packGrid(w),
  });
}

// Build a fresh round for everyone in the lobby right now (+ bots to fill).
function buildRound() {
  const humans = joinedConns();
  if (humans.length === 0) return;
  for (const c of room.conns.values()) c.ready = false;   // ready is consumed; everyone re-readies for the next round
  const humanCount = humans.length;
  const [COLS, ROWS] = BOARD_DIMS[CONFIG.board];
  const numBots = Math.max(0, Math.min(CONFIG.bots, MAX_PLAYERS - humanCount));
  const w = PaperSim.createWorld(
    { COLS, ROWS, difficulty: CONFIG.difficulty, numBots, humanCount, winCond: CONFIG.win, winThreshold: CONFIG.winPct / 100, timedLimitMs: CONFIG.winSecs * 1000, lives: CONFIG.lives, mode: "online" },
    { now, rng: Math.random }
  );
  w.buildWorld();
  room.world = w;
  room.humanCount = humanCount;
  room.prevGrid = packGrid(w);
  // Participants (everyone in the lobby now) get a human actor; late joiners wait.
  for (const s of room.seats.values()) s.actorId = null;
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
  // expire reconnect grace: drop seats that dropped and never came back in time
  for (const [tk, s] of room.seats) if (!s.ws && t - s.disconnectedAt > GRACE_MS) room.seats.delete(tk);
  const w = room.world;
  if (!w) return;
  const dt = Math.min(0.05, (t - room.last) / 1000); room.last = t;

  if (room.state === "countdown" && t >= room.countdownEnd) {
    room.state = "playing"; room.playStart = t; room.lastSpawn = t; room.acc = 0;
    broadcast({ t: "state", state: "playing" });
  }

  if (room.state === "playing") {
    // humans move continuously from their last heading
    for (const c of room.conns.values()) { const a = w.actorById[c.actorId]; if (a && a.alive && !a.dead) w.moveContinuous(a, dt, speedTick()); }
    // bots step on the game-speed accumulator
    room.acc += dt * 1000; if (room.acc > speedTick() * 5) room.acc = speedTick() * 5;
    while (!w.ended && room.acc >= speedTick()) { w.stepBots(); room.acc -= speedTick(); }
    // per-actor human death → respawn (or eliminate); never freezes the others
    for (const c of room.conns.values()) {
      const a = w.actorById[c.actorId];
      if (a && a.dead && t >= a.deadUntil) { if (a.lives > 0) w.respawn(a); else w.eliminate(a); }
    }
    if (!w.ended) w.endIfAllHumansOut();
    // keep bots topped up
    if (!w.ended && t - room.lastSpawn >= w.SPAWN_INTERVAL) {
      let ab = 0; for (const a of w.actors) if (a.isBot && a.alive) ab++;
      if (ab < Math.min(CONFIG.bots, MAX_PLAYERS - room.humanCount) && w.topShare() < SPAWN_CAP_SHARE) w.spawnBot();
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
  if (room.conns.size === 0 && room.timer) { clearInterval(room.timer); room.timer = null; room.world = null; room.state = "lobby"; room.seats.clear(); room.hostConnId = null; }
}

// ===========================================================================
// WebSocket connections
// ===========================================================================
const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (ws) => {
  ensureTicking();   // the seat is created on "join" (which may carry a reconnect token)
  ws.on("message", (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    if (m.t === "join") {
      const nm = (typeof m.name === "string" ? m.name.slice(0, 16).trim() : "");
      let seat = (m.token && room.seats.get(m.token)) || null;
      if (seat) {
        // Reconnect: reclaim the existing seat (and its actor, if a round is live).
        if (seat.ws && seat.ws !== ws) { room.conns.delete(seat.ws); try { seat.ws.close(); } catch (_) {} }
        seat.ws = ws; seat.disconnectedAt = 0; seat.joined = true; if (nm) seat.name = nm;
        room.conns.set(ws, seat);
        send(ws, { t: "welcome", connId: seat.connId, token: seat.token });
        if (room.world && (room.state === "countdown" || room.state === "playing" || room.state === "over") && seat.actorId != null) {
          send(ws, { t: "joined", yourActorId: seat.actorId, connId: seat.connId });
          snapshotFor(ws);   // resync the live round mid-game
        }
      } else {
        // New player: fresh seat + a reconnect token to remember it by.
        const connId = room.nextConnId++, token = randomToken();
        seat = { connId, token, name: nm || ("Player " + connId), ws, joined: true, actorId: null, disconnectedAt: 0, ready: false };
        room.seats.set(token, seat); room.conns.set(ws, seat);
        send(ws, { t: "welcome", connId, token });
      }
      pickHost(); broadcastLobby();
    } else if (m.t === "start") {
      const c = room.conns.get(ws); if (!c || !c.joined) return;
      const humans = joinedConns();
      const allReady = humans.length >= 1 && humans.every((h) => h.ready);
      if (allReady && (room.state === "lobby" || room.state === "over")) buildRound();
    } else if (m.t === "ready") {
      const c = room.conns.get(ws); if (!c || !c.joined) return;
      c.ready = !!m.ready;
      broadcastLobby();
    } else if (m.t === "setSettings") {
      const c = room.conns.get(ws); if (!c || !c.joined || room.state !== "lobby") return;
      const s = m.settings || {};
      if (["easy", "normal", "hard", "extreme"].includes(s.difficulty)) CONFIG.difficulty = s.difficulty;
      if (["small", "medium", "large"].includes(s.board)) CONFIG.board = s.board;
      if (["slow", "normal", "fast"].includes(s.speed)) CONFIG.speed = s.speed;
      if (Number.isFinite(s.bots)) CONFIG.bots = Math.max(0, Math.min(MAX_PLAYERS, s.bots | 0));
      if (s.win === "target" || s.win === "timed") CONFIG.win = s.win;
      if (Number.isFinite(s.winPct)) CONFIG.winPct = Math.max(10, Math.min(100, Math.round(s.winPct / 5) * 5));
      if (Number.isFinite(s.winSecs)) CONFIG.winSecs = Math.max(30, Math.min(600, Math.round(s.winSecs / 30) * 30));
      if (Number.isFinite(s.lives)) CONFIG.lives = Math.max(1, Math.min(10, s.lives | 0));
      broadcastLobby();
    } else if (m.t === "steer") {
      const c = room.conns.get(ws); if (!c || room.state !== "playing" || !room.world) return;
      const a = room.world.actorById[c.actorId];
      if (a && a.alive && !a.dead && typeof m.h === "number" && isFinite(m.h)) room.world.steer(a, m.h);
    }
  });
  ws.on("close", () => {
    const seat = room.conns.get(ws); if (!seat) { maybeStopTicking(); return; }
    room.conns.delete(ws); seat.ws = null; seat.disconnectedAt = now();
    // Hold the seat for reconnect only if it owns an actor in a live round; else drop it now.
    const inLiveRound = room.world && (room.state === "playing" || room.state === "countdown") && seat.actorId != null;
    if (!inLiveRound) room.seats.delete(seat.token);
    pickHost(); broadcastLobby(); maybeStopTicking();
  });
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
  lanUrl = "http://" + (ips[0] || "localhost") + ":" + PORT;
  QRCode.toString(lanUrl, { type: "svg", margin: 1, width: 240, color: { dark: "#10131a", light: "#ffffff" } }, (err, svg) => { if (svg) qrSvg = svg; });
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
