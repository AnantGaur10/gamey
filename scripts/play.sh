#!/bin/bash

VIEWPORT="${VIEWPORT:-1920x1080}"
SLOW_MO="${SLOW_MO:-300}"
RECORD_VIDEO="${RECORD_VIDEO:-}"

PORT=5174

echo "🎮 Gamey - Manual Play Mode"
echo "   Viewport: $VIEWPORT"
echo "   SlowMo: ${SLOW_MO}ms"
if [ -n "$RECORD_VIDEO" ]; then
    echo "   Recording: enabled"
fi
echo ""

if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo "✓ Dev server already running on port $PORT"
else
    echo "🚀 Starting dev server..."
    npm run dev > /tmp/gamey-dev.log 2>&1 &
    DEV_PID=$!
    
    echo "⏳ Waiting for server (PID: $DEV_PID)..."
    for i in {1..40}; do
        if curl -s http://localhost:$PORT > /dev/null 2>&1; then
            echo "✓ Server ready!"
            break
        fi
        sleep 1
        if [ $i -eq 40 ]; then
            echo "❌ Server timeout after 40s"
            echo "Server log:"
            tail -20 /tmp/gamey-dev.log
            exit 1
        fi
    done
fi

echo ""

VIEWPORT=$VIEWPORT SLOW_MO=$SLOW_MO RECORD_VIDEO=$RECORD_VIDEO npx tsx tests/manual-play.ts
