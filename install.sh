#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/zakstam/codex-headless-cli.git"
INSTALL_DIR="${HOME}/.local/share/zz"

echo "Installing zz..."

# Clean up any previous install
rm -rf "$INSTALL_DIR"

# Clone and build
git clone --depth 1 "$REPO" "$INSTALL_DIR"
cd "$INSTALL_DIR"
npm install --ignore-scripts
npm run build
chmod +x dist/index.js

# Link globally (may need sudo)
npm link 2>/dev/null || sudo npm link

echo "Done! Run 'zz' to get started."
