#!/bin/bash

echo "🧪 Running Playwright visual tests with headed browser..."
echo ""

PORT=5174

if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo "✓ Dev server already running on port $PORT"
else
    echo "🚀 Starting dev server on port $PORT..."
    npm run dev > /tmp/gamey-dev.log 2>&1 &
    DEV_PID=$!
    echo "   Server PID: $DEV_PID"
    
    echo "⏳ Waiting for server to be ready..."
    for i in {1..40}; do
        if curl -s http://localhost:$PORT > /dev/null 2>&1; then
            echo "✓ Server ready!"
            break
        fi
        sleep 1
        if [ $i -eq 40 ]; then
            echo "❌ Server failed to start after 40s"
            tail -20 /tmp/gamey-dev.log
            exit 1
        fi
    done
fi

echo ""
echo "📸 Running visual tests (headed mode)..."
echo ""

npx playwright test --headed --project=desktop-1920

echo ""
echo "✅ Tests complete! Check playwright-report/ for full results."
echo "   Run: npx playwright show-report"
