import { expect } from 'chai'
import { describe, it } from 'mocha'

import { gameStateLogLines, summarizeGameState } from './gameStateSummary'

const SCORING = `Top of the 3rd, 1 out, count 2-1.
Hawks batting, Owls in the field.
Batter: Alex Lee #4 (tag KT4). Pitcher: Sam Ng #1 (tag QV2).
On first: nobody. On second: Jo Kim #9 (tag AB1). On third: Pat Wu #7 (tag CD3).
Next batter: Ned Orr #15 (tag EF4).
Fielders: P Sam Ng #1 (tag QV2), C Bo Diaz #2 (tag GH5), 1B Lee, Jr. #3 (tag JK6), 2B Cam Fox #8 (tag LM7), SS Dee Hart #5 (tag NP8), 3B Ed Cole #6 (tag QR9), LF Fay Ott #10 (tag ST0), CF Guy Ash #11 (tag UV1), RF Hal Bey #12 (tag WX2).
ROSTERS
AWAY — Hawks
  Alex Lee #4 — bats 1st, plays DH
  Jo Kim #9 — bats 2nd
  Pat Wu #7 — bats 3rd, plays 3B
  Ned Orr #15 — bench
HOME — Owls
  Sam Ng #1 — bats 1st, plays P
  Bo Diaz #2 — bats 2nd, plays C
  Lee, Jr. #3 — bats 3rd, plays 1B
  Cam Fox #8 — bats 4th, plays 2B
  Dee Hart #5 — bats 5th, plays SS
  Ed Cole #6 — bats 6th, plays 3B
  Fay Ott #10 — bats 7th, plays LF
  Guy Ash #11 — bats 8th, plays CF
  Hal Bey #12 — bats 9th, plays RF
  Ben Low #20 — bench
  Rio Paz #18 — plays P`

const ROSTERS_ONLY = `The game has not begun.
ROSTERS
AWAY — Hawks
  Alex Lee #4 — bats 1st, plays SS
  Ned Orr #15 — bench
HOME — Owls
  Sam Ng #1 — bats 1st, plays P
  Ben Low #20 — bench`

const COACH = `The game has not begun.
ROSTERS
HOME — Owls
  Sam Ng #1 — bats 1st, plays P
  Ben Low #20 — bench`

describe('dictation game-state summary', function () {
  it('summarizes a scoring prompt: both lineups, the bench, the defense, the batter and the bases', function () {
    const summary = summarizeGameState('scoring', SCORING)
    expect(summary.screen).equals('scoring')
    expect(summary.live).equals(true)
    expect(summary.note).equals(null)
    expect(summary.battingTeam).equals('Hawks')
    expect(summary.fieldingTeam).equals('Owls')
    expect(summary.batter).equals('Alex Lee #4')
    expect(summary.pitcher).equals('Sam Ng #1')
    expect(summary.nextBatter).equals('Ned Orr #15')
    expect(summary.bases).deep.equals({
      first: 'nobody',
      second: 'Jo Kim #9',
      third: 'Pat Wu #7'
    })
    expect(summary.defense[0]).equals('P Sam Ng #1')
    expect(summary.defense[2]).equals('1B Lee, Jr. #3')
    expect(summary.defense).to.have.length(9)
    expect(summary.teams.map(team => team.side)).deep.equals(['AWAY', 'HOME'])
    expect(summary.teams[0].lineup.slice(0, 2)).deep.equals([
      '1. Alex Lee #4 (DH)',
      '2. Jo Kim #9'
    ])
    expect(summary.teams[0].bench).deep.equals(['Ned Orr #15'])
    expect(summary.teams[1].bench).deep.equals(['Ben Low #20'])
    expect(summary.teams[1].fieldNotBatting).deep.equals(['Rio Paz #18 (P)'])
    const lines = gameStateLogLines({
      id: 'utt-1',
      model: 'claude-haiku-5-5',
      scope: 'scoring',
      context: SCORING,
      said: 'He steals third.'
    })
    expect(lines[0]).equals(
      'dictation-state utt-1 model=claude-haiku-5-5 screen=scoring'
    )
    expect(lines.some(line => line.includes('On second: Jo Kim #9'))).equals(
      true
    )
    expect(lines.some(line => line.includes('Said: He steals third.'))).equals(
      true
    )
    expect(lines.join('\n')).not.includes('(tag')
    for (const line of lines) expect(line.length).to.be.below(48_000)
  })

  it('summarizes a set-roster prompt as both rosters and no live situation', function () {
    const summary = summarizeGameState('roster', ROSTERS_ONLY)
    expect(summary.screen).equals('set roster')
    expect(summary.live).equals(false)
    expect(summary.note).equals(null)
    expect(summary.batter).equals(null)
    expect(summary.bases).equals(null)
    expect(summary.teams).to.have.length(2)
    expect(summary.teams[0].lineup).deep.equals(['1. Alex Lee #4 (SS)'])
    expect(summary.teams[1].bench).deep.equals(['Ben Low #20'])
    const lines = gameStateLogLines({
      id: 'utt-2',
      model: 'grok-4.7',
      scope: 'roster',
      context: ROSTERS_ONLY,
      said: 'Put Alex fourth.'
    })
    expect(lines.some(line => line.includes('screen=set roster'))).equals(true)
    expect(lines.some(line => line.includes('The game has not begun.'))).equals(
      true
    )
    expect(lines.some(line => line.includes('On first'))).equals(false)
  })

  it('summarizes a coach prompt as that one team', function () {
    const summary = summarizeGameState('roster', COACH)
    expect(summary.screen).equals('coach')
    expect(summary.note).equals(null)
    expect(summary.teams).to.have.length(1)
    expect(summary.teams[0]).deep.include({
      side: 'HOME',
      name: 'Owls'
    })
    expect(summary.teams[0].lineup).deep.equals(['1. Sam Ng #1 (P)'])
    expect(summary.teams[0].bench).deep.equals(['Ben Low #20'])
    expect(
      gameStateLogLines({
        id: 'utt-3',
        model: 'claude-haiku-5-5',
        scope: 'roster',
        context: COACH,
        said: 'Bench number 1.'
      }).join('\n')
    ).not.includes('AWAY')
  })

  it('notes a coach or set-roster prompt that also carries the live situation', function () {
    const coach = summarizeGameState(
      'roster',
      `Top of the 1st, 0 outs, count 0-0.
Hawks batting, Owls in the field.
Batter: Alex Lee #4. Pitcher: Sam Ng #1.
On first: nobody. On second: nobody. On third: nobody.
Next batter: Jo Kim #9.
Fielders: P Sam Ng #1.
ROSTERS
HOME — Owls
  Sam Ng #1 — bats 1st, plays P
  Ben Low #20 — bench`
    )
    expect(coach.screen).equals('coach')
    expect(coach.note).includes('live situation')
    expect(coach.battingTeam).equals('Hawks')
    const roster = summarizeGameState(
      'roster',
      `Top of the 1st, 0 outs, count 0-0.
Hawks batting, Owls in the field.
${ROSTERS_ONLY.slice('The game has not begun.\n'.length)}`
    )
    expect(roster.screen).equals('set roster')
    expect(roster.live).equals(true)
    expect(roster.note).includes('live game situation')
    expect(roster.teams).to.have.length(2)
  })
})
