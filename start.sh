#!/usr/bin/env bash
set -euo pipefail

cd backend

if [ ! -d node_modules ]; then
  npm install --omit=dev
fi

exec node index.js
