import { expect } from 'chai'
import { describe, it } from 'mocha'

import { openableTeams } from './openableTeams'

const mine = [{ id: 'tem_titan', name: 'Titan Force 11U' }]
const inSeason = [
  { id: 'tem_titan', name: 'Titan (season copy)' },
  { id: 'tem_elmMeadow', name: 'Elm Meadow Impact 11U' }
]

describe('which sides of a game open a team', function () {
  it('opens a team this person is on', function () {
    const found = openableTeams([mine, []], ['tem_titan', 'tem_other'])
    expect(found.get('tem_titan')?.name).equals('Titan Force 11U')
  })

  it('opens the opponent when it plays in the same season', function () {
    const found = openableTeams(
      [mine, inSeason],
      ['tem_titan', 'tem_elmMeadow']
    )
    expect([...found.keys()]).deep.equals(['tem_titan', 'tem_elmMeadow'])
  })

  it('leaves an opponent from outside the season alone', function () {
    // No roster, no page — so its name is a name and the press never happens.
    const found = openableTeams([mine, inSeason], ['tem_titan', 'tem_guests'])
    expect(found.has('tem_guests')).equals(false)
  })

  it('prefers your own copy of a team to the season s', function () {
    const found = openableTeams([mine, inSeason], ['tem_titan'])
    expect(found.get('tem_titan')?.name).equals('Titan Force 11U')
  })

  it('ignores every team that is not playing in this game', function () {
    const found = openableTeams([inSeason], ['tem_titan'])
    expect(found.size).equals(1)
  })
})
