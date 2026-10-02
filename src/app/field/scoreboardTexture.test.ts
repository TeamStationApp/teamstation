import { expect } from 'chai'
import { createHash } from 'crypto'
import { describe, it } from 'mocha'

import { DEMO_SCOREBOARD, type ScoreboardState } from './scoreboardModel'
import { makeScoreboardPixels } from './scoreboardTexture'

const digest = (state: ScoreboardState): string =>
  createHash('sha256')
    .update(makeScoreboardPixels(state))
    .digest('hex')
    .slice(0, 16)

describe('the scoreboard pixels', function () {
  // Digests of the boards as drawn bulb by bulb, before the painted board and
  // each bulb's mixes were kept: keeping them must not move a pixel.
  const boards: Array<[string, ScoreboardState, string]> = [
    ['the demo board', DEMO_SCOREBOARD, '1e883a497ad5f3bb'],
    [
      'a full count in the bottom of the 12th',
      {
        ...DEMO_SCOREBOARD,
        balls: 3,
        strikes: 2,
        outs: 2,
        half: 'bottom',
        inning: 12,
        homeScore: 14,
        pitchCount: 107
      },
      'd1410a443a480a32'
    ],
    [
      'names too long for their line',
      {
        ...DEMO_SCOREBOARD,
        homeTeam: 'A VERY LONG TEAM NAME THAT GOES ON',
        batter: { firstName: 'Maximilian Alexander Longname', lastName: '' }
      },
      '03bdd4f2effa83e7'
    ],
    [
      'an inside-the-park home run',
      {
        ...DEMO_SCOREBOARD,
        celebration: { id: 'x', kind: 'in-park', paused: false }
      },
      'f1bc9fbaaa6a7463'
    ],
    [
      'a home run out of the park',
      {
        ...DEMO_SCOREBOARD,
        celebration: { id: 'x', kind: 'out-of-park', paused: false }
      },
      'dcf29dfbd9276dea'
    ],
    [
      'an instruction',
      {
        ...DEMO_SCOREBOARD,
        instruction:
          'Drag the batter to a base or hold to mark him out at first',
        detail: '45 LINE DRIVE'
      },
      '6bac6be1ec805a09'
    ],
    [
      'no count and no pitcher',
      {
        ...DEMO_SCOREBOARD,
        balls: 0,
        strikes: 0,
        outs: 0,
        pitcher: { firstName: '', lastName: '' },
        batter: { firstName: 'Trey H', lastName: '' }
      },
      '5d84c8a28b3af8fd'
    ]
  ]
  for (const [name, state, expected] of boards)
    it(`draws ${name} as it always has`, function () {
      expect(digest(state)).equals(expected)
      // Again, from what the first drawing kept.
      expect(digest(state)).equals(expected)
    })

  it('hands every board its own pixels', function () {
    const first = makeScoreboardPixels(DEMO_SCOREBOARD)
    first.fill(0)
    expect(digest(DEMO_SCOREBOARD)).equals('1e883a497ad5f3bb')
  })
})
