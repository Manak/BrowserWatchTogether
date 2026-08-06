#!/usr/bin/env bash
# Generates a local test video so you can exercise sync without a Drive file.
# Load it in the app with the direct-URL escape hatch:
#   http://localhost:5180/sample.mp4
set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required. On macOS: brew install ffmpeg" >&2
  exit 1
fi

mkdir -p public
ffmpeg -y \
  -f lavfi -i "testsrc=size=640x360:rate=25:duration=${1:-120}" \
  -f lavfi -i "sine=frequency=440:duration=${1:-120}" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a aac -shortest -movflags +faststart \
  public/sample.mp4

echo "Wrote public/sample.mp4 (burnt-in timecode makes drift visible by eye)."
