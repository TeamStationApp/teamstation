#!/bin/bash

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <screenshot_name>"
  exit 1
fi

OUTPUT="images/$1"

# Stream screenshot directly from device — avoids sdcard write/pull/rm race conditions
adb exec-out screencap -p > "$OUTPUT"

# Validate that the output is a real PNG (first 8 bytes must be the PNG magic number)
PNG_MAGIC=$(xxd -p -l 8 "$OUTPUT" 2>/dev/null || echo "")
if [ "$PNG_MAGIC" != "89504e470d0a1a0a" ]; then
  echo "Invalid PNG output from screencap (magic: $PNG_MAGIC), deleting corrupt file" >&2
  rm -f "$OUTPUT"
  exit 1
fi
