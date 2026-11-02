#!/usr/bin/env bash
# Phone testing over a Cloudflare quick tunnel (DEV only, never the build).
#   npm run tunnel            # starts the dev server if needed, then the tunnel
#   IP=172.18.0.5 npm run tunnel   # force the address
# The tunnel points at this machine's IPv4 LAN address (wlan* first, else the
# default-route interface; on WSL2 that's eth0, 172.x), not localhost.
# vite.config.ts allows every *.trycloudflare.com host, so a new tunnel URL
# needs no edit. Ctrl+C stops the tunnel (and the dev server it started).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=5174

pick_ip() {
  local ifs ip
  # 1) a wireless interface, 2) the default-route interface, 3) any 172.x, 4) any non-loopback.
  for i in $(ls /sys/class/net | grep -E '^(wlan|wlp|wl)'); do
    ip=$(ip -4 -o addr show "$i" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
    [ -n "$ip" ] && { echo "$ip"; return; }
  done
  ifs=$(ip -4 route show default 2>/dev/null | awk '{print $5}' | head -1)
  if [ -n "$ifs" ]; then
    ip=$(ip -4 -o addr show "$ifs" | awk '{print $4}' | cut -d/ -f1 | head -1)
    [ -n "$ip" ] && { echo "$ip"; return; }
  fi
  ip=$(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -E '^172\.' | head -1)
  [ -n "$ip" ] && { echo "$ip"; return; }
  ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -vE '^(127\.|10\.255\.)' | head -1
}

IP="${IP:-$(pick_ip)}"
[ -n "$IP" ] || { echo "tunnel: no IPv4 address found (set IP=...)" >&2; exit 1; }
command -v cloudflared >/dev/null || { echo "tunnel: cloudflared not on PATH (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)" >&2; exit 1; }

DEV_PID=""
cleanup() { [ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if ! curl -s -o /dev/null "http://$IP:$PORT/basic.html"; then
  echo "tunnel: starting the dev server on 0.0.0.0:$PORT"
  npm run dev >/tmp/gamey-dev.log 2>&1 &
  DEV_PID=$!
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://$IP:$PORT/basic.html" && break; sleep 0.5; done
  curl -s -o /dev/null "http://$IP:$PORT/basic.html" || { echo "tunnel: dev server did not come up (see /tmp/gamey-dev.log)" >&2; exit 1; }
fi

echo "tunnel: http://$IP:$PORT -> Cloudflare (the public URL prints below; open <url>/basic.html)"
cloudflared tunnel --no-autoupdate --url "http://$IP:$PORT" 2>&1 | while IFS= read -r line; do
  if [[ "$line" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
    echo
    echo "  PLAY ON YOUR PHONE: ${BASH_REMATCH[1]}/basic.html"
    echo
  fi
  case "$line" in *ERR*|*error*) echo "$line" ;; esac
done
