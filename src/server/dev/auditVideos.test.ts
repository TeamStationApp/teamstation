import { expect } from 'chai'
import { describe, it } from 'mocha'

import { titleSaysLive } from './auditVideos'

describe('titleSaysLive', function () {
  it('reads a title that starts with live or livestream', function () {
    expect(titleSaysLive('Live 2026-04-12 10:02')).equals(true)
    expect(titleSaysLive('livestream 2026-04-12')).equals(true)
    expect(titleSaysLive('  LIVE 2026-04-12')).equals(true)
  })

  it('reads the same after any league acronym', function () {
    expect(titleSaysLive('ABC Live 2026-04-12')).equals(true)
    expect(titleSaysLive('XY10 livestream')).equals(true)
  })

  it('does not take a team name in ordinary case for a league', function () {
    expect(titleSaysLive('Hawks live at Cyclones')).equals(false)
  })

  it('does not read a word that only starts with live', function () {
    expect(titleSaysLive('Lively Hawks vs Cyclones')).equals(false)
    expect(titleSaysLive('2026-04-12 Hawks vs Cyclones')).equals(false)
  })
})
