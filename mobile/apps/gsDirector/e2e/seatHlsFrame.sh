#!/usr/bin/env bash
# SEAT_HLS_FRAME for a GameStation branch seat.
#
# Writes the last frame of the newest segment of the seat's newest live video to $1 (PNG, rgb24),
# then prints "<segment> <mtime in seconds>" for scoreboardDirector.e2e.ts to time the frame by.
#
#   SEAT_SSH     where the seat runs
#   SEAT_VIDEOS  the seat's live video folder
#   SEAT_FFMPEG  ffmpeg on the seat's host
#
# The live video is the one with the newest segment: a finished one can have a newer playlist.
#
# The ssh connection is shared between calls through a socket in /tmp named by ssh's %C hash, not
# under TMPDIR: a socket path must fit in 104 bytes, and a session's TMPDIR can take most of that.
# On the seat, the frame is cut in a temporary folder that a trap removes however the script ends.
set -uo pipefail
out="$1"
ssh_target="${SEAT_SSH:?Set SEAT_SSH}"
videos="${SEAT_VIDEOS:?Set SEAT_VIDEOS}"
ffmpeg="${SEAT_FFMPEG:?Set SEAT_FFMPEG}"
err=$(mktemp "${TMPDIR:-/tmp}/seatHlsFrame.XXXXXX")
trap 'rm -f "$err"' EXIT
ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath=/tmp/shf-%C -o ControlPersist=120 \
  "$ssh_target" "videos='$videos' ffmpeg='$ffmpeg' bash -s" > "$out" 2> "$err" <<'REMOTE'
set -e
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
cd "$videos"
p=$(ls -t vid_*/seg*.m4s | head -1); cd "$(dirname "$p")"; s=$(basename "$p")
echo "META $PWD/$s $(stat -c %.3Y "$s")" >&2
cat init.mp4 "$s" > "$t/seg.mp4"
n=$("${ffmpeg%ffmpeg}ffprobe" -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$t/seg.mp4" < /dev/null)
"$ffmpeg" -nostdin -v error -i "$t/seg.mp4" -vf "select=eq(n\,$((n - 1)))" -frames:v 1 -fps_mode passthrough -pix_fmt rgb24 -f image2 "$t/last.png"
cat "$t/last.png"
REMOTE
code=$?
meta=$(grep '^META ' "$err" | tail -1 | cut -c6-)
if [ $code -ne 0 ] || [ -z "$meta" ] || [ ! -s "$out" ]; then cat "$err" >&2; exit 1; fi
echo "$meta"
