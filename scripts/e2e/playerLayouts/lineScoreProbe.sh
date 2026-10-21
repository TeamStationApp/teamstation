#!/bin/sh
# The line score's resource, asked as the box-score scenarios ask it, each
# request on a `$` line with what came back.
#
#   sh scripts/e2e/playerLayouts/lineScoreProbe.sh [fixture.json]
#
# The fixture's administrator signs in (`scripts/e2e/playerLayouts/token.ts`,
# which prints only the token to this script); TS_PLAYER_APP is the origin.
# Every answer is cut to its first 1500 characters.
set -eu
FIXTURE=${1:-/private/tmp/teamstation-playerLayouts/fixture.json}
APP=${TS_PLAYER_APP:?Set TS_PLAYER_APP to the app origin, e.g. http://192.0.2.10:8091}
TOKEN=$(TS_PLAYER_FIXTURE=$FIXTURE TS_PLAYER_APP=$APP node -r sucrase/register scripts/e2e/playerLayouts/token.ts)
game() { node -e "console.log(JSON.parse(require('fs').readFileSync('$FIXTURE','utf8')).games.$1.id)"; }
FIRST=$(node -e "const f=JSON.parse(require('fs').readFileSync('$FIXTURE','utf8'));console.log(f.scored.firstPlayAt)")
LAST=$(node -e "const f=JSON.parse(require('fs').readFileSync('$FIXTURE','utf8'));console.log(f.scored.lastPlayAt)")
S=$(game S); L=$(game L); N0=$(game N0)
ask() {
  echo "\$ curl -s -H 'authorization: Bearer <token>' '$1'"
  curl -s -w '\nHTTP %{http_code}\n' -H "authorization: Bearer $TOKEN" "$1" | cut -c1-1500
  echo
}
# A moment a fifth of the way through S's scoring: inning two or three.
EARLY=$(( FIRST + (LAST - FIRST) / 5 ))
MIDDLE=$(( FIRST + (LAST - FIRST) / 2 ))
ask "$APP/api/v1/games/$S/line-score"
ask "$APP/api/v1/games/$S/line-score?at=$EARLY"
ask "$APP/api/v1/games/$S/line-score?at=$(( FIRST - 60000 ))"
ask "$APP/api/v1/games/$S/line-score?from=$EARLY&to=$MIDDLE"
ask "$APP/api/v1/games/$L/line-score"
ask "$APP/api/v1/games/$N0/line-score"
ask "$APP/api/v1/games/$S/line-score?at=nonsense"
echo "\$ curl -s '$APP/api/v1/games/$S/line-score'   # signed out"
curl -s -w '\nHTTP %{http_code}\n' "$APP/api/v1/games/$S/line-score" | cut -c1-300
