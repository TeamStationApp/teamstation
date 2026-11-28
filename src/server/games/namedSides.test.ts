import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import {
  hasNamedSides,
  OPEN_SIDE_UNSCORED,
  requireNamedSides
} from './namedSides'

describe('named sides', () => {
  const named = { id: 'g', home_team_id: 'a', away_team_id: 'b' }
  it('tells a game whose sides both name a team', () => {
    expect(hasNamedSides(named)).equals(true)
    expect(hasNamedSides({ home_team_id: null, away_team_id: 'b' })).equals(
      false
    )
    expect(hasNamedSides({ home_team_id: 'a', away_team_id: null })).equals(
      false
    )
  })

  it('answers a named game and refuses one with an open side (409)', () => {
    expect(requireNamedSides(named)).equals(named)
    let refused: unknown
    try {
      requireNamedSides({ home_team_id: 'a', away_team_id: null })
    } catch (error) {
      refused = error
    }
    expect(refused).instanceOf(HttpError)
    expect(refused).property('message').equals(OPEN_SIDE_UNSCORED)
    expect(refused).property('code').equals('conflict')
  })
})
