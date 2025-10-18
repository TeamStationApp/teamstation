#!/bin/bash

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <screenshot_name>"
  exit 1
fi

adb shell screencap -p /sdcard/$1
adb pull /sdcard/$1 images/$1
adb shell rm /sdcard/$1
