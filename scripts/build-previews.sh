#!/usr/bin/env bash
# CrazyGames preview videos from the raw gameplay recordings in store/videos/
# (OBS .mkv, gitignored). Spec (specs/crazygames/game-covers.md): 15-20s,
# <=50MB, 1080p landscape 16:9 + 1080p portrait 2:3, no sound, no black
# screens / fades / bars / cursor / promo text, no fast-forward, first frame =
# the static cover. Real-speed hard cuts of gameplay only (no menus: the OS
# cursor shows there).   npm run build:previews
set -euo pipefail
cd "$(dirname "$0")/.."
A="store/videos/2026-11-02 17-42-04.mkv"   # full screen, Main Street + Telegraph Row
B="store/videos/2026-11-02 17-51-12.mkv"   # browser window: chrome rows 0-120, black below 1031
OUT=store/videos
COVER_S=0.8

# clip: source start duration (seconds)
CLIPS=(
  "A 11.4 2.2"    # Telegraph Row, noon: DRAW, both fire, you're hit
  "B 4.5 2.5"     # Saloon: DRAW -> headshot, ragdoll
  "B 59.6 2.4"    # The Falls: DRAW -> FOE DOWN
  "A 472.9 2.6"   # Main Street, noon: El Verde, headshot
  "A 66.4 1.8"    # Telegraph Row, night: muzzle flashes in the dark
  "B 86.4 2.6"    # The Falls, dusk: trading hits -> DOUBLE KO
  "B 93.3 1.3"    # Sudden death (red): first hit wins
  "A 515.9 2.6"   # The Pale Rider, townsfolk on the boardwalks: FOE DOWN
)

# Game area of B: rows 121..1030 (910 high), centred 16:9 crop.
norm() { [ "$1" = B ] && echo "crop=1618:910:151:121,scale=1920:1080:flags=lanczos," || echo ""; }

build() { # out_name width height crop_after_norm cover
  local name=$1 W=$2 H=$3 post=$4 cover=$5
  local inputs=() fc="" n=0
  inputs+=(-loop 1 -t "$COVER_S" -framerate 30 -i "$cover")
  fc+="[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,format=yuv420p[v0];"
  for c in "${CLIPS[@]}"; do
    read -r src ss dur <<<"$c"
    n=$((n+1))
    local f; [ "$src" = A ] && f=$A || f=$B
    inputs+=(-ss "$ss" -t "$dur" -i "$f")
    fc+="[${n}:v]$(norm "$src")${post}setsar=1,fps=30,format=yuv420p[v${n}];"
  done
  for i in $(seq 0 $n); do fc+="[v${i}]"; done
  fc+="concat=n=$((n+1)):v=1:a=0[out]"
  ffmpeg -hide_banner -v error -y "${inputs[@]}" -filter_complex "$fc" -map "[out]" -an \
    -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -profile:v high -movflags +faststart "$OUT/$name"
  echo "built $OUT/$name"
}

# Landscape 1920x1080.
build preview_1920x1080.mp4 1920 1080 "" store/covers/cover_1920x1080.png
# Portrait 1080x1620 (2:3): a 720x1080 window over the duel (player's shoulder
# + the foe + the cue line), scaled 1.5x.
build preview_1080x1620.mp4 1080 1620 "crop=720:1080:560:0,scale=1080:1620:flags=lanczos," store/covers/cover_800x1200.png

for f in "$OUT"/preview_*.mp4; do
  ffprobe -v error -show_entries format=duration,size:stream=codec_type,width,height -of compact "$f"
done
