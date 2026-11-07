#!/bin/bash
# Runs inside the e2e image (uid 65532, read-only root filesystem, /tmp and $HOME on tmpfs).
# Installs the tenant-pinned Playwright, downloads its own Chromium headless shell, renders one page.
set -euo pipefail
work=/tmp/trial
mkdir -p "$work" && cp /trial/package.json /trial/trial.mjs "$work"/ && cd "$work"
npm install --no-audit --no-fund --loglevel=error
npx playwright install chromium-headless-shell 2>&1 | tail -2
node trial.mjs
