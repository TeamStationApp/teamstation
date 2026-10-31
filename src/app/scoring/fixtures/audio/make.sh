#!/bin/sh
# The clips the dictation scenarios play through a faked microphone, as 16 kHz
# mono 16-bit WAV with half a second of silence either side. A synthesised
# voice is what makes the scenarios repeatable; it is not a claim about how a
# real scorer sounds. Regenerate with: sh src/app/scoring/fixtures/audio/make.sh
# and make only some with their names: sh …/make.sh lineupJudgeFourth
set -e
cd "$(dirname "$0")"
only=" $* "
clip() {
  case "$only" in "  " | *" $1 "*) ;; *) return 0 ;; esac
  say -o "/tmp/$1.aiff" "$2"
  afconvert -f WAVE -d LEI16@16000 -c 1 "/tmp/$1.aiff" "/tmp/$1.raw.wav"
  node - "$1" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs')
const name = process.argv[2]
const raw = readFileSync(`/tmp/${name}.raw.wav`)
let format, frames
for (let at = 12; at + 8 <= raw.length; ) {
  const size = raw.readUInt32LE(at + 4)
  const chunk = raw.subarray(at + 8, at + 8 + size)
  const id = raw.toString('latin1', at, at + 4)
  if (id === 'fmt ') format = chunk.subarray(0, 16)
  if (id === 'data') frames = chunk
  at += 8 + size + (size % 2)
}
const pad = Buffer.alloc(16000)
const data = Buffer.concat([pad, frames, pad])
const header = Buffer.alloc(20)
header.write('RIFF', 0, 'latin1')
header.writeUInt32LE(36 + data.length, 4)
header.write('WAVEfmt ', 8, 'latin1')
header.writeUInt32LE(16, 16)
const size = Buffer.alloc(4)
size.writeUInt32LE(data.length)
writeFileSync(
  `${name}.wav`,
  Buffer.concat([header, format, Buffer.from('data'), size, data])
)
JS
  rm -f "/tmp/$1.aiff" "/tmp/$1.raw.wav"
}
# E1-E6
clip ball 'Ball.'
clip singleRunnerScored 'Single to left, fielded by the left fielder. The runner at second scored. The throw home was late.'
clip stealThird 'The runner at second steals third.'
clip whiffedK 'Whiffed. K.'
clip beaned 'He beaned him.'
clip droppedThirdStrike 'Dropped third strike, he runs to first.'
clip errorByJersey "Sky high pop fly into left field. And it's dropped by number six for an error. He's safe at first."
# E7: the half inning in src/common/scoring/fixtures/halfInning.actions.json
clip halfInning1 'Ball. Called strike. Single to center, fielded by the center fielder.'
clip halfInning2 'Called strike. Swing and a miss. Another swing and a miss, strike three.'
clip halfInning3 'Ground ball to the shortstop, thrown to first for the out. The runner on first went to second.'
clip halfInning4 'Fly ball, caught by the left fielder.'
# E9: a half inning in one sitting
clip fullPass1 'Ball. Ball. Called strike. Line drive single to right, fielded by the right fielder.'
clip fullPass2 'The runner at first steals second.'
clip fullPass3 'Foul ball. Swing and a miss. Called strike three.'
clip fullPass4 'Wild pitch, the runner at third scores.'
clip fullPass5 'Wild pitch, the runner at second goes to third.'
clip fullPass6 'Ground ball to the second baseman, thrown to first for the out. The runner at third scores.'
clip fullPass7 'Ball. Ball. Ball. Ball four.'
clip fullPass8 'Double to left, fielded by the left fielder. The runner at first goes to third.'
clip fullPass9 'Fly ball, caught by the center fielder.'
# E10-E13: how a dictated sentence is shown
clip singleToLeft 'Line drive single to left, fielded by the left fielder.'
clip tagUp 'Fly ball caught by the left fielder. The runner at third tags up and scores.'
clip groundOut 'Ground ball to the shortstop, thrown to first for the out.'
clip ballStrike 'Ball. Called strike.'
# E15-E16: a fielder's choice finishes itself, or asks
clip fieldersChoice "Ground ball to the shortstop, fielder's choice."
# E18: a steal names its runner by the base; a double steal goes lead first
clip heStealsThird 'And he steals third.'
clip doubleSteal "And it's a double steal."
clip heSteals 'And he steals.'
# E19: Undo by voice
clip undoLast 'Undo that last play.'
clip scratchStrike 'Scratch that, it was a called strike.'
# E20: where the ball went, fouls, and throws to a base
clip singleLeftCenter 'Single to left center.'
clip foulCaughtFirst 'Foul ball caught by the first baseman.'
clip foulTip 'Foul tip.'
clip foulCaught 'Foul ball caught.'
clip flyLeftCenter 'Fly out to left center.'
clip tagThrownHome 'Pop fly to center field. The man at third tags up but gets thrown out at home.'
# E21: a steal whose runner scored, and a caught foul with a runner tagging
clip stealScores 'He steals, and scores when the throw gets away.'
clip foulPopTagThird 'The runner on second tags up to third on the foul pop out.'
# R1-R5: the roster screen, against the lineup fixture's rosters
# (src/server/dev/lineupFixture.ts)
clip lineupJudgeFourth 'Put Judge fourth.'
clip defenseThree 'Soto at short, Harper at second, and Turner in center field.'
clip setThisLineup 'Set this lineup: Betts, Springer, Judge, Altuve, Bregman, Alvarez, Tucker, Semien, Pena.'
clip mixedLineupDefense 'Put Altuve leadoff and Betts at short.'
clip freemanAtFirst 'Freeman plays first base.'
# S1-S5: substitutions said on the scoring screen, against the same rosters.
# S1 names a player by a jersey both teams wear: the side in the field's #3
# (Alonso, from first base), found by the screen with no question.
clip subThirdBase 'Number 3 subs in at third base.'
clip sotoPitches 'Soto subs in for the pitcher.'
clip bettsPinchHits 'Betts pinch hits.'
clip freemanRunsSecond 'Freeman runs for the runner on second.'
clip ballAndPinchRunner 'Ball one, and Freeman pinch runs at first.'
