#!/bin/bash
# VIEWPORT=WxH (default 1920x1080 desktop). Examples:
#   npm run ai:play         # desktop 1920x1080, headed via WSLg
#   npm run ai:play:mobile  # mobile 800x450, headed via WSLg
#   HEADLESS=1 INSPECT_SECS=3 bash scripts/ai-play.sh  # CI, no window
VIEWPORT="${VIEWPORT:-1920x1080}"

mkdir -p "test-results/ai-play/$VIEWPORT" "test-results/ai-play-videos/$VIEWPORT"

echo "🤖 Starting AI-driven game test ($VIEWPORT)..."
echo ""

npx tsx tests/ai-play.ts
