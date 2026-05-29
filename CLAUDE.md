# Paper IO Clone

A Paper.io-style game built as a family project.

## gstack

[gstack](https://github.com/garrytan/gstack) is installed as global skills in `~/.claude/skills` and auto-discovered each session, so the available skills stay current automatically.

- **Web browsing:** always use the gstack `/browse` skill for all web browsing and page interaction.
- **Never** use `mcp__claude-in-chrome__*` tools.

Skills aren't hand-listed here (the list drifts as gstack ships new ones). gstack auto-updates at session start (team mode is on), and `/gstack-upgrade` updates on demand. Canonical current list: `~/.claude/skills/gstack/gstack/llms.txt`.

## GBrain Configuration (configured by /setup-gbrain)
- Mode: local-stdio
- Engine: pglite
- Config: ~/.gbrain/config.json (mode 0600)
- Setup date: 2026-05-29
- MCP: registered at user scope in `~/.claude.json` (available in every project). Restart Claude Code and approve the gbrain server to get `mcp__gbrain__*` tools.
- Embeddings: OpenAI `text-embedding-3-large` — key in `~/.zshrc` and the gbrain MCP env (`~/.claude.json`). Meaning-based search active; new content auto-embeds.
- Artifacts sync: off (local only)
- Repo policy: unset (no git remote yet)
