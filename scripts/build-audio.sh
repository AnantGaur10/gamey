#!/usr/bin/env bash
# Encode the user-supplied source audio (sounds/, not in git: ~270MB of wav,
# OpenGameArt; licences in public/licenses/AUDIO-CREDITS.txt) into the small
# mp3s that ship in public/assets/audio/. Deterministic per ffmpeg build.
#   npm run build:audio
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=sounds
OUT=public/assets/audio
mkdir -p "$OUT"
FF="ffmpeg -hide_banner -v error -y"

# Gunshot (Michel Baradari, CC-BY 3.0): mono, trailing silence trimmed, peak -1dB.
$FF -i "$SRC/gun/pistol.wav" -af "atrim=0:0.92,afade=t=out:st=0.84:d=0.08,pan=mono|c0=0.5*c0+0.5*c1,alimiter=limit=0.89:level=false" \
  -ar 44100 -c:a libmp3lame -b:a 128k "$OUT/gunshot.mp3"

# Saloon tune (Zane Little Music, CC0): the final decay below -60dB trimmed so the loop restarts promptly.
$FF -i "$SRC/maps/saloon/miniature_saloon.wav" -af "atrim=0:32.3,afade=t=out:st=32.1:d=0.2,loudnorm=I=-20:TP=-1.5:LRA=11" \
  -ar 44100 -c:a libmp3lame -b:a 112k "$OUT/saloon.mp3"

# Falls ambience (Thimras, CC0): seamless loops. A 3s crossfade of the cut's tail
# into its head: body[3..L] + xfade(body tail, head) = a loop with no seam.
loop() { # src start len xfade channels bitrate loudness out
  $FF -ss "$2" -t "$3" -i "$1" -filter_complex \
    "[0:a]asplit[a][b];[a]atrim=0:$4,asetpts=PTS-STARTPTS[head];[b]atrim=$4,asetpts=PTS-STARTPTS[body];[body][head]acrossfade=d=$4:c1=qsin:c2=qsin,loudnorm=I=$7:TP=-3:LRA=7[o]" \
    -map "[o]" -ac "$5" -ar 44100 -c:a libmp3lame -b:a "$6" "$8"
}
loop "$SRC/maps/the_falls/park_ambience_river.wav" 120 46 3 2 96k -24 "$OUT/falls-river.mp3"
loop "$SRC/maps/the_falls/park_ambience_birds.wav" 60 38 3 1 64k -28 "$OUT/falls-birds.mp3"

ls -la "$OUT"
