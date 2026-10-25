import { expect } from 'chai'
import { describe, it } from 'mocha'

import { atBatOf, postedAtBat, PREGAME_ABOUT } from './atBatInProgress'

describe('the at-bat in progress', function () {
  const pregame = { version: 3, actions: [] }
  const shell = { about: PREGAME_ABOUT, teamStation: pregame }
  const atBat = { about: { atBatIndex: 4 } }

  it('is the stored at-bat, else the pregame lineups until a play is stored', function () {
    expect(atBatOf({ currentPlay: atBat, pregame }, true)).equals(atBat)
    expect(atBatOf({ currentPlay: null, pregame }, false)).deep.equals(shell)
    expect(atBatOf({ currentPlay: null, pregame }, true)).equals(null)
    expect(atBatOf({ currentPlay: null, pregame: null }, false)).equals(null)
  })

  it('is, for a post, the at-bat it sends, else the one its plays leave', function () {
    const game = { currentPlay: null, pregame }
    expect(postedAtBat(game, [], undefined)).deep.equals(shell)
    // The first plays stored, and no at-bat sent: the pregame is none.
    expect(postedAtBat(game, [{}], undefined)).equals(null)
    expect(postedAtBat(game, [{}], atBat)).equals(atBat)
    expect(postedAtBat(game, [], null)).equals(null)
  })
})
