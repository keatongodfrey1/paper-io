#!/bin/bash
# Double-click this file to start the Paper.io multiplayer server.
# (macOS may ask the first time: right-click → Open → Open.)
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node isn't installed yet."
  echo "  Install it from https://nodejs.org (the big green LTS button),"
  echo "  then double-click this file again."
  echo ""
  read -p "  Press Enter to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First-time setup (installing the one dependency)…"
  npm install --omit=dev
fi

node server.js
read -p "  Server stopped. Press Enter to close."
