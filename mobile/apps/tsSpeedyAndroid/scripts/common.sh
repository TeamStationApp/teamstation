# Shared settings for the TS Speedy Android scripts. Sourced, not run.
set -euo pipefail

SPEEDY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEEDY_PACKAGE="app.teamstation.speedy"
# Debug and release are signed with a debug keystore; Mason re-signs the release APK.
export TS_ANDROID_DEBUG_KEYSTORE="${TS_ANDROID_DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }
