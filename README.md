# Paper IO Clone

A Paper.io-style game — a family project built together with the kids. Play **solo against
bots** by just opening a file, or **together on separate tablets** over your home WiFi.

## Play solo (nothing to install)

Open `index.html` in any web browser (double-click it), or use the live link if it's deployed.
On the start screen set up your game — **difficulty** (Easy/Normal/Hard/Extreme), **board size**,
**speed**, **win condition** (adjustable target % or a timer), **bots** (0–30), and **lives** —
then press **Start**. A 3-2-1 countdown opens each round.

## Play together on separate tablets (same WiFi)

The kids can play head-to-head, each on their own tablet, all on your home WiFi. One computer
(your Mac) runs the game; the tablets just join it.

1. **Start the server on the Mac:** double-click **`start.command`** in this folder.
   (First time: it installs the helpers, and macOS may ask you to right-click → Open → Open.
   If it says Node isn't installed, get it from [nodejs.org](https://nodejs.org) and try again.)
2. The window prints a join address like `http://192.168.1.42:8080`.
3. On **each tablet** (same WiFi), open the browser to that address and tap **Play Online**, or
   just **scan the QR code** shown on the Mac's screen.
4. Everyone types a name and lands in the **lobby**. The first player is the **host**; when
   everyone's in, the host taps **Start**. Empty slots fill with bots.
5. If a tablet's WiFi blips, it **rejoins the same spot** automatically. When a round ends,
   you're back in the lobby for the host to start the next one.

To stop the server, press **Ctrl-C** in its window (or just close it).

## Controls

- **Arrow keys / WASD**, or **drag anywhere** (touch) to steer — your head glides at any angle
- Loop back to your own color to **claim** everything you enclosed, including ground taken from others
- **Cut someone's trail** to take all their land (their trail solidifies into a bridge to yours);
  cross your own trail, or get cut, and you lose a life
- The bar up top is the live **standings**; win by an adjustable **target %** or the **most land**
  when a timer runs out
- **Space** pause · **R** restart · **Esc** (or the **Menu** button) for the menu (solo)
- Your territory is always one connected piece; if a rival slices it, the part you're not standing in is lost

## How it's built

- **`index.html`** — the game you see: rendering, input, menus, the lobby, sound. Runs solo on its
  own, or connects to the server for online play.
- **`sim.js`** — the shared "game brain": the grid, movement, the territory flood-fill, collisions,
  bots, and scoring. The **same file** runs in your browser (solo) and on the server (online), so the
  rules are always identical. Pure logic with no screen or sound of its own.
- **`server.js`** — the tiny multiplayer server (Node + one WebSocket library). It runs the one true
  game and tells every tablet what to draw, and also serves the game files so tablets just open its
  address.
- **`test/`** — automated checks for the tricky parts (flood-fill, collisions, scoring). Run `npm test`.

The design doc (phases and decisions) lives under `~/.gstack/projects/PaperIOClone/`. Note: the
original plan imagined "couch multiplayer" (several kids on one keyboard) as Phase 2 — that's been
replaced by this networked version, so each kid plays on their own screen.

## Make it yours

- **Solo:** most options are on the start screen. For finer tweaks, open `index.html` in a text
  editor and find the **CONFIG** section near the top of the engine script (colors, presets, etc.).
- **Game rules / bots:** edit the constants at the top of **`sim.js`** (`DIFFS`, `START_BLOCK`,
  `TURN_RATE`, …) — they apply to both solo and online.
- **Online defaults** (board size, bot count, difficulty, lives, win condition): edit the `CONFIG`
  block near the top of **`server.js`**, then restart the server.

## Later (not built yet)

- Internet play (kids in different houses) — the server is structured to deploy online without a
  rewrite; it just needs hosting.
- A fuller "make-your-own" sandbox (skins, arena themes).
