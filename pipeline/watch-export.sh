#!/usr/bin/env bash
# Re-export painted tiles every 20 min while the paint job runs (incremental, ~30 s per run).
cd "$(dirname "$0")/.."
while pgrep -f "tsx src/paint.ts" >/dev/null; do
  npm run export -- rothschild tlv-core 2>&1 | grep -E "map z8|world" | sed "s/^/$(date +%H:%M) /"
  sleep 1200
done
npm run export -- rothschild tlv-core 2>&1 | grep -E "map z8|world" | sed "s/^/$(date +%H:%M) final /"
