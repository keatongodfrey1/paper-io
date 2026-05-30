# Paper IO Clone

A Paper.io-style game — a family project to build together with the kids.

## Play it

Open `index.html` in any web browser (just double-click the file). No install, no setup.

- On the start screen, set up your game: **difficulty** (Easy/Normal/Hard/Extreme), **board size**, **game speed**, **win condition**, and **number of bots** (0-10). Then press Start
- A **3-2-1 countdown** opens each round, so no one gets a head start
- **Arrow keys** or **WASD** to move
- Loop back to your color to **claim** everything you enclose, including ground taken from other players
- **Cut a bot's trail and you take all its territory** (it's knocked out, and its trail solidifies into a bridge so the land connects to yours). Cross your own trail, or let a bot cut yours, and your round restarts
- Knocked-out bots are replaced by **fresh bots that drop in** over time, so the board stays busy
- The bar up top is the live **standings**. Win by hitting your chosen target: **100%**, **first to 50%**, or **most territory** when the timer runs out
- **Space** to pause, **R** to restart, **Esc** (or the **Menu** button) for the main menu
- Your territory is always one connected piece; if a rival slices it, the part you're not standing in is lost

**Phase 1 so far:** a settings screen (difficulty, board size, speed, win mode, 0-10 bots),
randomized starts, a countdown, territory stealing, kill-to-absorb, connected-territory
rules, live standings, pause, and three win modes (100%, first-to-50%, or timed). Still to
come: a little polish and the optional "ghost racing" bonus, then Phase 2 (couch multiplayer)
and Phase 3 (make-your-own sandbox). The full plan lives in the design doc under
`~/.gstack/projects/PaperIOClone/`.

## Make it yours

Most of the game is configurable right on the start screen. For finer tweaks, open
`index.html` in a text editor and find the **CONFIG** section at the top of the `<script>`:
adjust the colors, the per-difficulty bot behavior (`DIFFS`), the board/speed presets, or
the timed-round length (`TIMED_LIMIT`). To use a sound your kids record, follow the note
just above `playClaimSound()`.
