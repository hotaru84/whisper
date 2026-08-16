#!/bin/bash
# Installs the frontend dependencies so `npm run dev`, `npm run lint`, `npm test`
# and `npm run build` work in a Claude Code on the web session, where the repo is
# cloned fresh and `node_modules/` (gitignored) is therefore absent.
#
# Frontend only, on purpose: the Rust/Tauri half of this app needs the Windows
# MSVC toolchain, the Vulkan SDK and a ~574MB model file (see README.md), none of
# which exist here. What a web session can do is the browser-only frontend
# preview -- see `useMockBackend` in src/lib/env.ts.
set -euo pipefail

# Local machines already have their own setup (and their own node version) --
# nothing to do there.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# `install` rather than `ci`: the container image is cached after this hook
# completes, and install reuses whatever is already unpacked instead of wiping
# node_modules on every session.
npm install --no-audit --no-fund
