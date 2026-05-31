// =============================================================================
// sim.js — shared Paper.io simulation (the game "brain")
//
// Runs in BOTH the browser (solo mode) and Node (the multiplayer server), with
// NO DOM, audio, canvas, or timers of its own. It owns the grid, the actors,
// movement, claiming/flood-fill, collisions, scoring and bots. It NEVER renders
// or plays sound: instead it EMITS events (claim/death/prune/spawn/endgame) that
// the caller turns into flashes/sound/shake. Time and randomness are INJECTED
// (deps.now / deps.rng) so the server controls them and unit tests are
// deterministic.
//
// Load (browser):  <script src="sim.js"></script>  → window.PaperSim
// Load (Node):     const PaperSim = require('./sim.js')
// =============================================================================
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.PaperSim = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // --- tuning constants shared by every environment --------------------------
  const EMPTY = 0;
  const START_BLOCK = 5;        // home territory is START_BLOCK x START_BLOCK
  const SELF_GRACE = 3;         // trail cells right behind the head that don't kill you on a sharp turn
  const TURN_RATE = 13;         // rad/sec a continuous head curves toward its target heading
  const DEATH_MS = 750;         // how long an actor stays "dead" before respawn/elimination
  const SPAWN_INTERVAL = 7000;  // ms between topping bots back up to the chosen count

  const DIFFS = {
    easy:    { label: "Easy",    legOut: [2, 5],  legSide: [2, 4], speed: 1 },
    normal:  { label: "Normal",  legOut: [4, 7],  legSide: [3, 6], speed: 2 },
    hard:    { label: "Hard",    legOut: [5, 9],  legSide: [3, 7], speed: 3 },
    extreme: { label: "Extreme", legOut: [6, 11], legSide: [4, 8], speed: 4 },
  };

  // Colors live here so solo + server agree; the client may also recompute from colorSeed.
  const PLAYER_COL = { land: "#ff4d6d", trail: "#ff8fa6", head: "#ffd1da" };
  function botColor(i) {
    const h = Math.round((i * 137.508 + 25) % 360);
    return { land: "hsl(" + h + ",66%,56%)", trail: "hsl(" + h + ",82%,72%)", head: "hsl(" + h + ",90%,86%)" };
  }
  // A small distinct palette for multiple HUMAN players (player 0 keeps the classic pink).
  function humanColor(i) {
    if (i === 0) return PLAYER_COL;
    const h = Math.round((i * 97 + 200) % 360);
    return { land: "hsl(" + h + ",70%,55%)", trail: "hsl(" + h + ",85%,72%)", head: "hsl(" + h + ",92%,86%)" };
  }

  // ===========================================================================
  // createWorld(opts, deps) → world
  //   opts: { COLS, ROWS, difficulty, numBots, humanCount=1, winCond, winThreshold,
  //           timedLimitMs, lives, mode='solo' }
  //   deps: { now: ()=>ms, rng: ()=>[0,1) }
  // ===========================================================================
  function createWorld(opts, deps) {
    const w = {};
    w.COLS = opts.COLS;
    w.ROWS = opts.ROWS;
    w.difficulty = opts.difficulty || "normal";
    w.numBots = opts.numBots | 0;
    w.humanCount = Math.max(1, opts.humanCount || 1);
    w.winCond = opts.winCond || "target";        // 'target' | 'timed'
    w.winThreshold = opts.winThreshold != null ? opts.winThreshold : 1;
    w.timedLimitMs = opts.timedLimitMs || 120000;
    w.lives = opts.lives != null ? opts.lives : 1;
    w.mode = opts.mode || "solo";                 // 'solo' | 'online'
    w.diff = DIFFS[w.difficulty];

    w.now = (deps && deps.now) ? deps.now : (() => Date.now());
    w.rng = (deps && deps.rng) ? deps.rng : Math.random;

    w.EMPTY = EMPTY;
    w.DEATH_MS = DEATH_MS;
    w.SPAWN_INTERVAL = SPAWN_INTERVAL;

    // state
    w.grid = null;
    w.trailOwner = new Map();
    w.actors = [];
    w.actorById = {};
    w.player = null;        // solo convenience: the (first) human actor
    w.comp = new Int16Array(w.COLS * w.ROWS);  // per-world scratch for pruneTerritory
    w._outside = null;      // per-world scratch for claimFor flood-fill
    w.nextId = 0;
    w.botSpawnCount = 0;
    w.ended = false;
    w.endResult = null;
    w._events = [];

    const key = (x, y) => x + "," + y;
    const inBounds = (x, y) => x >= 0 && x < w.COLS && y >= 0 && y < w.ROWS;
    w.key = key;
    w.inBounds = inBounds;

    w.emit = function (e) { w._events.push(e); };
    w.drainEvents = function () { const e = w._events; w._events = []; return e; };

    // -------------------------------------------------------------------------
    // WORLD SETUP (region-based starts so nobody clumps)
    // -------------------------------------------------------------------------
    w.regionHomes = function (n) {
      const pad = ((START_BLOCK / 2) | 0) + 2;
      const gx = Math.ceil(Math.sqrt(n)), gy = Math.ceil(n / gx);
      const regions = [];
      for (let ry = 0; ry < gy; ry++) for (let rx = 0; rx < gx; rx++) regions.push({ rx, ry });
      for (let i = regions.length - 1; i > 0; i--) { const j = (w.rng() * (i + 1)) | 0; const t = regions[i]; regions[i] = regions[j]; regions[j] = t; }
      const cellW = (w.COLS - 2 * pad) / gx, cellH = (w.ROWS - 2 * pad) / gy;
      const homes = [];
      for (let i = 0; i < n; i++) {
        const r = regions[i];
        const x = Math.round(pad + r.rx * cellW + cellW * (0.25 + 0.5 * w.rng()));
        const y = Math.round(pad + r.ry * cellH + cellH * (0.25 + 0.5 * w.rng()));
        homes.push({ x: Math.max(pad, Math.min(w.COLS - 1 - pad, x)), y: Math.max(pad, Math.min(w.ROWS - 1 - pad, y)) });
      }
      return homes;
    };

    function makeActor(id, isBot, colorSeed, hx, hy, speed) {
      return {
        id: id, isBot: isBot, colorSeed: colorSeed,
        color: isBot ? botColor(colorSeed) : humanColor(colorSeed),
        name: isBot ? ("Bot " + (colorSeed + 1)) : ("Player " + (colorSeed + 1)),
        alive: true, dead: false, deadUntil: 0, lives: isBot ? 1 : w.lives,
        speed: speed,
        x: hx, y: hy, homeCx: hx, homeCy: hy,
        dx: 0, dy: 0, movedX: 0, movedY: 0, prevX: hx, prevY: hy,
        fx: hx + 0.5, fy: hy + 0.5, heading: 0, targetHeading: 0, moving: false, recent: [],
        trail: [], trailSet: new Set(), ai: { mode: "rest" },
      };
    }

    w.buildWorld = function () {
      w.grid = [];
      for (let y = 0; y < w.ROWS; y++) { const row = new Array(w.COLS); for (let x = 0; x < w.COLS; x++) row[x] = EMPTY; w.grid.push(row); }
      w.trailOwner = new Map();
      w._events = [];
      w.actors = []; w.actorById = {};
      w.ended = false; w.endResult = null;
      const total = w.humanCount + w.numBots;
      const homes = w.regionHomes(total);
      const botSpeed = w.diff.speed;
      for (let i = 0; i < total; i++) {
        const isBot = i >= w.humanCount;
        const seed = isBot ? (i - w.humanCount) : i;
        const a = makeActor(i + 1, isBot, seed, homes[i].x, homes[i].y, isBot ? botSpeed : 1);
        w.actors.push(a); w.actorById[a.id] = a; w.stampHome(a);
      }
      w.player = w.actorById[1];           // solo: the human
      w.nextId = total + 1;
      w.botSpawnCount = w.numBots;
      return w;
    };

    w.stampHome = function (a) {
      const r = (START_BLOCK / 2) | 0;
      for (let y = a.homeCy - r; y <= a.homeCy + r; y++)
        for (let x = a.homeCx - r; x <= a.homeCx + r; x++)
          if (inBounds(x, y)) w.grid[y][x] = a.id;
    };

    // A fresh bot drops in on an open patch with a normal-sized home.
    w.spawnBot = function () {
      const r = (START_BLOCK / 2) | 0, pad = r + 1;
      let cx = -1, cy = -1;
      for (let t = 0; t < 60 && cx < 0; t++) {
        const x = pad + ((w.rng() * (w.COLS - 2 * pad)) | 0), y = pad + ((w.rng() * (w.ROWS - 2 * pad)) | 0);
        let ok = true;
        for (let yy = y - r; yy <= y + r && ok; yy++) for (let xx = x - r; xx <= x + r; xx++) if (!inBounds(xx, yy) || w.grid[yy][xx] !== EMPTY) { ok = false; break; }
        if (ok) { cx = x; cy = y; }
      }
      if (cx < 0) return null;   // board too full, skip this round
      const a = makeActor(w.nextId++, true, w.botSpawnCount++, cx, cy, w.diff.speed);
      w.actors.push(a); w.actorById[a.id] = a; w.stampHome(a);
      const cells = [];
      for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) if (inBounds(xx, yy)) cells.push({ x: xx, y: yy });
      w.emit({ type: "spawn", actorId: a.id, cells: cells });
      return a;
    };

    // Lost a life but lives remain: keep territory, drop back on a safe owned cell,
    // clear the spent trail, and resume. Works for any human actor.
    w.respawn = function (a) {
      a.trail = []; a.trailSet.clear(); a.recent = [];
      a.dx = 0; a.dy = 0; a.movedX = 0; a.movedY = 0;
      a.dead = false; a.deadUntil = 0; a.alive = true;
      if (inBounds(a.homeCx, a.homeCy) && w.grid[a.homeCy][a.homeCx] === a.id) {
        a.x = a.homeCx; a.y = a.homeCy;
      } else {
        const own = [];
        for (let y = 0; y < w.ROWS; y++) for (let x = 0; x < w.COLS; x++) if (w.grid[y][x] === a.id) own.push([x, y]);
        if (own.length) { const s = own[(w.rng() * own.length) | 0]; a.x = s[0]; a.y = s[1]; }
        else { const h = w.regionHomes(1)[0]; a.homeCx = h.x; a.homeCy = h.y; w.stampHome(a); a.x = h.x; a.y = h.y; }
      }
      a.fx = a.x + 0.5; a.fy = a.y + 0.5; a.heading = 0; a.targetHeading = 0; a.moving = false;
      a.prevX = a.x; a.prevY = a.y;
    };

    // -------------------------------------------------------------------------
    // MOVEMENT
    // -------------------------------------------------------------------------
    // Aim a continuous (human) actor toward a heading in radians.
    w.steer = function (a, angle) {
      a.targetHeading = angle;
      if (!a.moving) { a.moving = true; a.heading = angle; }   // first input snaps + starts moving
    };

    // Shared per-cell logic: actor `a` enters grid cell (cx,cy). Returns false if it
    // can't keep moving this step (it died, or the game ended).
    w.enterCell = function (a, cx, cy) {
      const k = key(cx, cy);
      const owner = w.trailOwner.get(k);
      if (owner !== undefined) {
        if (owner === a.id) {
          if (a.recent.indexOf(k) !== -1) return true;   // grace: just-laid trail right behind the head
          w.killActor(a, null); return false;            // crossed your own (older) trail
        }
        w.killActor(w.actorById[owner], a);               // cut someone else's trail
        if (w.ended) return false;
      }
      if (w.grid[cy][cx] === a.id) { if (a.trail.length > 0) w.claimFor(a); return !w.ended; }
      a.trail.push({ x: cx, y: cy }); a.trailSet.add(k); w.trailOwner.set(k, a.id);
      a.recent.push(k); if (a.recent.length > SELF_GRACE) a.recent.shift();
      return !w.ended;
    };

    // Bots: grid-step, one cell at a time.
    w.moveActor = function (a) {
      if (a.dx === 0 && a.dy === 0) return;
      const nx = a.x + a.dx, ny = a.y + a.dy;
      if (!inBounds(nx, ny)) { a.ai.mode = "home"; const h = w.homeStep(a); a.dx = h[0]; a.dy = h[1]; return; }
      a.x = nx; a.y = ny; a.movedX = a.dx; a.movedY = a.dy;
      w.enterCell(a, nx, ny);
    };

    // Continuous (human): heading curves toward target; the head paints its trail
    // onto the grid cell-by-cell as it travels. `tickMs` sets on-screen speed.
    w.moveContinuous = function (a, dt, tickMs) {
      if (!a.moving || a.dead) return;
      let dh = a.targetHeading - a.heading;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      const maxTurn = TURN_RATE * dt;
      a.heading += Math.max(-maxTurn, Math.min(maxTurn, dh));
      const sp = (1000 / tickMs) * dt;   // cells this frame; matches the grid speed setting
      const nx = Math.max(0.001, Math.min(w.COLS - 0.001, a.fx + Math.cos(a.heading) * sp));
      const ny = Math.max(0.001, Math.min(w.ROWS - 0.001, a.fy + Math.sin(a.heading) * sp));
      const segX = nx - a.fx, segY = ny - a.fy;
      const steps = Math.max(1, Math.ceil(Math.hypot(segX, segY) / 0.34));
      let curCx = Math.floor(a.fx), curCy = Math.floor(a.fy);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cx = Math.floor(a.fx + segX * t), cy = Math.floor(a.fy + segY * t);
        if (cx === curCx && cy === curCy) continue;
        if (cx !== curCx && cy !== curCy && inBounds(cx, curCy)) {   // 4-connect across a diagonal corner
          a.x = cx; a.y = curCy;
          if (!w.enterCell(a, cx, curCy)) return;
        }
        curCx = cx; curCy = cy;
        if (inBounds(cx, cy)) { a.x = cx; a.y = cy; if (!w.enterCell(a, cx, cy)) return; }
      }
      a.fx = nx; a.fy = ny; a.x = Math.floor(nx); a.y = Math.floor(ny);
    };

    // -------------------------------------------------------------------------
    // CLAIM + STEAL
    // -------------------------------------------------------------------------
    function fl(x, y, a, outside, stack) {
      if (!inBounds(x, y) || outside[y * w.COLS + x] || w.grid[y][x] === a.id) return;
      outside[y * w.COLS + x] = 1; stack.push(x); stack.push(y);
    }

    w.claimFor = function (a) {
      const COLS = w.COLS, ROWS = w.ROWS, grid = w.grid;
      for (const c of a.trail) { grid[c.y][c.x] = a.id; w.trailOwner.delete(key(c.x, c.y)); }
      if (!w._outside || w._outside.length !== COLS * ROWS) w._outside = new Uint8Array(COLS * ROWS);
      const outside = w._outside; outside.fill(0);
      const stack = [];
      for (let x = 0; x < COLS; x++) { fl(x, 0, a, outside, stack); fl(x, ROWS - 1, a, outside, stack); }
      for (let y = 0; y < ROWS; y++) { fl(0, y, a, outside, stack); fl(COLS - 1, y, a, outside, stack); }
      while (stack.length) {
        const y = stack.pop(), x = stack.pop();
        fl(x + 1, y, a, outside, stack); fl(x - 1, y, a, outside, stack);
        fl(x, y + 1, a, outside, stack); fl(x, y - 1, a, outside, stack);
      }
      const captured = a.trail.slice();
      const affected = new Set();
      for (let y = 0; y < ROWS; y++)
        for (let x = 0; x < COLS; x++)
          if (grid[y][x] !== a.id && !outside[y * COLS + x]) { const prev = grid[y][x]; if (prev !== EMPTY) affected.add(prev); grid[y][x] = a.id; captured.push({ x: x, y: y }); }
      w.emit({ type: "claim", actorId: a.id, isBot: a.isBot, headX: a.x, headY: a.y, cells: captured });
      if (a.isBot) { a.homeCx = a.x; a.homeCy = a.y; a.ai = { mode: "rest" }; }
      a.trail = []; a.trailSet.clear(); a.recent = [];
      for (const oid of affected) { const o = w.actorById[oid]; if (o && o.alive) w.pruneTerritory(o); }
      w.checkEndgame(a);
    };

    // Keep only ONE connected blob of an actor's land (under its head, or the largest).
    w.pruneTerritory = function (a) {
      const COLS = w.COLS, ROWS = w.ROWS, grid = w.grid, comp = w.comp, id = a.id;
      comp.fill(-1);
      const sizes = []; let nc = 0;
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        if (grid[y][x] !== id || comp[y * COLS + x] !== -1) continue;
        let sz = 0; const st = [x + y * COLS]; comp[y * COLS + x] = nc;
        while (st.length) {
          const idx = st.pop(); sz++;
          const cx = idx % COLS, cy = (idx / COLS) | 0;
          if (cx + 1 < COLS && grid[cy][cx + 1] === id && comp[idx + 1] === -1) { comp[idx + 1] = nc; st.push(idx + 1); }
          if (cx - 1 >= 0 && grid[cy][cx - 1] === id && comp[idx - 1] === -1) { comp[idx - 1] = nc; st.push(idx - 1); }
          if (cy + 1 < ROWS && grid[cy + 1][cx] === id && comp[idx + COLS] === -1) { comp[idx + COLS] = nc; st.push(idx + COLS); }
          if (cy - 1 >= 0 && grid[cy - 1][cx] === id && comp[idx - COLS] === -1) { comp[idx - COLS] = nc; st.push(idx - COLS); }
        }
        sizes.push(sz); nc++;
      }
      if (nc <= 1) return;
      let keep;
      if (grid[a.y][a.x] === id) keep = comp[a.y * COLS + a.x];
      else { keep = 0; for (let i = 1; i < nc; i++) if (sizes[i] > sizes[keep]) keep = i; }
      const cells = [];
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (grid[y][x] === id && comp[y * COLS + x] !== keep) { grid[y][x] = EMPTY; cells.push({ x: x, y: y }); }
      if (cells.length) w.emit({ type: "prune", actorId: id, cells: cells });
    };

    // -------------------------------------------------------------------------
    // DEATH / ABSORB
    // -------------------------------------------------------------------------
    w.killActor = function (victim, killer) {
      const COLS = w.COLS, ROWS = w.ROWS, grid = w.grid;
      // Human death = lose a life, KEEP territory, schedule respawn. Game/engine
      // decides what to do when deadUntil passes (respawn vs out-of-lives).
      if (!victim.isBot) {
        for (const c of victim.trail) w.trailOwner.delete(key(c.x, c.y));
        victim.trail = []; victim.trailSet.clear(); victim.recent = [];
        victim.lives--;
        victim.dead = true; victim.deadUntil = w.now() + DEATH_MS;
        w.emit({ type: "death", victimId: victim.id, killerId: killer ? killer.id : null, victimIsBot: false, cells: [] });
        return;
      }
      const taker = (killer && killer.alive && killer !== victim) ? killer : null;
      const takeId = taker ? taker.id : EMPTY;
      const cells = [];

      // The victim's whole trail SOLIDIFIES into the taker's land (freed on a self-cut).
      for (const c of victim.trail) { grid[c.y][c.x] = takeId; w.trailOwner.delete(key(c.x, c.y)); cells.push({ x: c.x, y: c.y }); }
      victim.trail = []; victim.trailSet.clear();
      // The taker's own trail solidifies too, finishing the bridge back to its land.
      if (taker) {
        for (const c of taker.trail) { grid[c.y][c.x] = taker.id; w.trailOwner.delete(key(c.x, c.y)); cells.push({ x: c.x, y: c.y }); }
        taker.trail = []; taker.trailSet.clear();
      }
      // Absorb (or free) the victim's territory.
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (grid[y][x] === victim.id) { grid[y][x] = takeId; cells.push({ x: x, y: y }); }
      victim.alive = false;
      w.emit({ type: "death", victimId: victim.id, killerId: taker ? taker.id : null, victimIsBot: true, cells: cells });
      if (taker) w.pruneTerritory(taker);
      w.checkEndgame(taker || victim);
    };

    // Permanently remove an actor and FREE all its land + trail, so it vanishes
    // like a knocked-out bot. Used when an online human runs out of lives.
    w.eliminate = function (a) {
      const COLS = w.COLS, ROWS = w.ROWS, grid = w.grid, cells = [];
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (grid[y][x] === a.id) { grid[y][x] = EMPTY; cells.push({ x: x, y: y }); }
      for (const c of a.trail) w.trailOwner.delete(key(c.x, c.y));
      a.trail = []; a.trailSet.clear(); a.recent = [];
      a.alive = false; a.dead = false;
      w.emit({ type: "eliminated", actorId: a.id, cells: cells });
    };

    // Online: once every human is out of the round, end it (don't let the bots
    // play on by themselves). Returns true if it ended the round.
    w.endIfAllHumansOut = function () {
      if (w.ended || w.mode === "solo") return false;
      const humans = w.actors.filter(function (a) { return !a.isBot; });
      if (humans.length === 0 || !humans.every(function (a) { return !a.alive; })) return false;
      w.ended = true; w.endResult = { reason: "allout", leaderId: w.leaderId() };
      w.emit({ type: "endgame", reason: "allout", leaderId: w.endResult.leaderId });
      return true;
    };

    // -------------------------------------------------------------------------
    // ENDGAME
    // -------------------------------------------------------------------------
    w.countTerritory = function () {
      const COLS = w.COLS, ROWS = w.ROWS, grid = w.grid, c = {};
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) { const o = grid[y][x]; if (o) c[o] = (c[o] || 0) + 1; }
      return c;
    };
    w.leaderId = function (counts) {
      counts = counts || w.countTerritory();
      let bid = 0, bc = -1;
      for (const a of w.actors) { const n = counts[a.id] || 0; if (n > bc) { bc = n; bid = a.id; } }
      return bid;
    };
    w.checkEndgame = function (claimer) {
      const counts = w.countTerritory(), total = w.COLS * w.ROWS;
      // Solo: the player losing all land = "wiped out" (whole game ends).
      if (w.mode === "solo" && w.player && (counts[w.player.id] || 0) === 0 && w.player.alive) {
        w.player.alive = false; w.ended = true;
        w.endResult = { reason: "wiped", leaderId: w.leaderId(counts) };
        w.emit({ type: "endgame", reason: "wiped", leaderId: w.endResult.leaderId });
        return;
      }
      // Any actor squeezed to zero land. Bots are out for good; an online human
      // loses a life and respawns with a fresh home if any lives remain (so a bot
      // eating your land isn't an instant, permanent knockout), else eliminated.
      for (const a of w.actors) {
        if (!a.alive || a.dead || (counts[a.id] || 0) !== 0) continue;
        if (w.mode === "solo" && !a.isBot) continue;   // solo player handled by the wiped-out branch above
        if (a.isBot) { a.alive = false; continue; }
        for (const c of a.trail) w.trailOwner.delete(w.key(c.x, c.y));
        a.trail = []; a.trailSet.clear(); a.recent = [];
        if (a.lives > 0) { a.lives--; a.dead = true; a.deadUntil = w.now() + DEATH_MS; w.emit({ type: "death", victimId: a.id, killerId: null, victimIsBot: false, cells: [] }); }
        else { w.eliminate(a); }
      }
      if (w.endIfAllHumansOut()) return;
      // Win by reaching the target share of the board.
      if (w.winCond === "target" && (counts[claimer.id] || 0) >= total * w.winThreshold) {
        w.ended = true; w.endResult = { reason: "target", winnerId: claimer.id };
        w.emit({ type: "endgame", reason: "target", winnerId: claimer.id });
      }
    };
    // Engine-driven timed finish (the clock lives in the engine/server loop).
    w.finishTimed = function () {
      const counts = w.countTerritory();
      w.ended = true; w.endResult = { reason: "timed", winnerId: w.leaderId(counts) };
      w.emit({ type: "endgame", reason: "timed", winnerId: w.endResult.winnerId });
    };

    // -------------------------------------------------------------------------
    // BOT AI
    // -------------------------------------------------------------------------
    w.botThink = function (a) {
      if (a.ai.mode === "home" && w.grid[a.y][a.x] === a.id) a.ai = { mode: "rest" };
      let ai = a.ai;
      if (ai.mode === "rest") { a.ai = w.planExcursion(a); ai = a.ai; }
      if (ai.mode === "out") {
        if (ai.stepsLeft > 0 && inBounds(a.x + ai.outDir[0], a.y + ai.outDir[1])) { a.dx = ai.outDir[0]; a.dy = ai.outDir[1]; ai.stepsLeft--; return; }
        ai.mode = "across"; ai.stepsLeft = ai.legSide;
      }
      if (ai.mode === "across") {
        if (ai.stepsLeft > 0 && inBounds(a.x + ai.sideDir[0], a.y + ai.sideDir[1])) { a.dx = ai.sideDir[0]; a.dy = ai.sideDir[1]; ai.stepsLeft--; return; }
        ai.mode = "home";
      }
      const h = w.homeStep(a); a.dx = h[0]; a.dy = h[1];
    };
    w.planExcursion = function (a) {
      const D = w.diff;
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let i = dirs.length - 1; i > 0; i--) { const j = (w.rng() * (i + 1)) | 0; const t = dirs[i]; dirs[i] = dirs[j]; dirs[j] = t; }
      let outDir = dirs[0];
      for (const d of dirs) if (w.roomAhead(a, d, 8) >= 4) { outDir = d; break; }
      const perps = outDir[0] !== 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
      const sideDir = perps[w.rng() < 0.5 ? 0 : 1];
      const rng = (lo, hi) => lo + ((w.rng() * (hi - lo + 1)) | 0);
      return { mode: "out", outDir: outDir, sideDir: sideDir, legSide: rng(D.legSide[0], D.legSide[1]), stepsLeft: rng(D.legOut[0], D.legOut[1]) };
    };
    w.roomAhead = function (a, d, max) { let n = 0, x = a.x, y = a.y; for (let i = 0; i < (max || 7); i++) { x += d[0]; y += d[1]; if (!inBounds(x, y)) break; n++; } return n; };
    w.homeStep = function (a) {
      const tx = a.homeCx, ty = a.homeCy, cand = [];
      if (Math.abs(tx - a.x) >= Math.abs(ty - a.y)) { if (tx !== a.x) cand.push([Math.sign(tx - a.x), 0]); if (ty !== a.y) cand.push([0, Math.sign(ty - a.y)]); }
      else { if (ty !== a.y) cand.push([0, Math.sign(ty - a.y)]); if (tx !== a.x) cand.push([Math.sign(tx - a.x), 0]); }
      cand.push([1, 0], [-1, 0], [0, 1], [0, -1]);
      for (const d of cand) { const nx = a.x + d[0], ny = a.y + d[1]; if (!inBounds(nx, ny) || a.trailSet.has(key(nx, ny))) continue; return d; }
      return [a.dx || 1, a.dy || 0];
    };

    // Advance all alive BOTS one tick (humans move via moveContinuous from the loop).
    w.stepBots = function () {
      if (w.ended) return;
      for (const a of w.actors) {
        if (!a.alive || !a.isBot) continue;
        a.prevX = a.x; a.prevY = a.y;
        for (let r = 0; r < a.speed && a.alive; r++) {
          w.botThink(a);
          w.moveActor(a);
          if (w.ended) return;
        }
      }
    };

    return w;
  }

  return {
    createWorld: createWorld,
    DIFFS: DIFFS,
    PLAYER_COL: PLAYER_COL,
    botColor: botColor,
    humanColor: humanColor,
    START_BLOCK: START_BLOCK,
    SELF_GRACE: SELF_GRACE,
    TURN_RATE: TURN_RATE,
    DEATH_MS: DEATH_MS,
    SPAWN_INTERVAL: SPAWN_INTERVAL,
    VERSION: 1,
  };
});
