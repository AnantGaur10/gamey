#!/bin/bash

VIEWPORT="${1:-1920x1080}"
SLOW_MO="${2:-500}"

IFS='x' read -r WIDTH HEIGHT <<< "$VIEWPORT"

echo "🎮 Custom interactive test session"
echo "   Viewport: ${WIDTH}x${HEIGHT}"
echo "   SlowMo: ${SLOW_MO}ms"
echo ""

PORT=5174

if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo "✓ Dev server already running on port $PORT"
else
    echo "🚀 Starting dev server on port $PORT..."
    npm run dev > /tmp/gamey-dev.log 2>&1 &
    DEV_PID=$!
    
    echo "⏳ Waiting for server..."
    for i in {1..40}; do
        if curl -s http://localhost:$PORT > /dev/null 2>&1; then
            echo "✓ Server ready!"
            break
        fi
        sleep 1
        if [ $i -eq 40 ]; then
            echo "❌ Server timeout"
            tail -20 /tmp/gamey-dev.log
            exit 1
        fi
    done
fi

echo ""
echo "🌐 Launching browser with custom settings..."

cat > /tmp/gamey-custom-test.mjs << EOF
import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    headless: false,
    slowMo: ${SLOW_MO},
  });

  const page = await browser.newPage({
    viewport: { width: ${WIDTH}, height: ${HEIGHT} },
  });

  console.log('Opening http://localhost:${PORT}...');
  await page.goto('http://localhost:${PORT}');
  await page.waitForLoadState('networkidle');
  
  console.log('\\n✅ Browser ready! Interact manually.');
  console.log('   Browser will stay open for 5 minutes.');
  console.log('   Press Ctrl+C in terminal to close early.\\n');
  
  await page.waitForTimeout(300000);
  await browser.close();
})();
EOF

npx tsx /tmp/gamey-custom-test.mjs

echo ""
echo "✅ Session ended."
