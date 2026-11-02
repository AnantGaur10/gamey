#!/usr/bin/env bash
# Phone testing (DEV only, never the build): host the dev server on this
# machine's IPv4 LAN address (wlan* first, else the default-route interface;
# on WSL2 that's eth0, 172.x) so a Cloudflare tunnel run from Windows
# PowerShell can reach it. No cloudflared here: the tunnel is the user's,
# from PowerShell (user 2026-11-02).
#   npm run tunnel                 # dev server on <172.x>:5174 + the PowerShell line to run
#   IP=172.18.0.5 npm run tunnel   # force the address
# vite.config.ts allows every *.trycloudflare.com host, so a new tunnel URL
# needs no edit.
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

echo
echo "  Dev server: http://$IP:$PORT/basic.html"
echo "  In Windows PowerShell:  cloudflared tunnel --url http://$IP:$PORT"
echo "  Then open <the trycloudflare URL>/basic.html on the phone."
echo
if curl -s -o /dev/null "http://$IP:$PORT/basic.html"; then
  echo "  (a dev server already answers there: leaving it running)"
  exit 0
fi
exec npx vite --config vite.config.ts --host "$IP" --port "$PORT" --strictPort
