import { expect } from 'chai'
import { describe, it } from 'mocha'

import { openableTeams } from './openableTeams'

const mine = [{ id: 'tem_trosky', name: 'Trosky Force 11U' }]
const inSeason = [
  { id: 'tem_trosky', name: 'Trosky (season copy)' },
  { id: 'tem_sanMarcos', name: 'San Marcos Impact 11U' }
]

describe('which sides of a game open a team', function () {
  it('opens a team this person is on', function () {
    const found = openableTeams([mine, []], ['tem_trosky', 'tem_other'])
    expect(found.get('tem_trosky')?.name).equals('Trosky Force 11U')
  })

  it('opens the opponent when it plays in the same season', function () {
    const found = openableTeams(
      [mine, inSeason],
      ['tem_trosky', 'tem_sanMarcos']
    )
    expect([...found.keys()]).deep.equals(['tem_trosky', 'tem_sanMarcos'])
  })

  it('leaves an opponent from outside the season alone', function () {
    // No roster, no page — so its name is a name and the press never happens.
    const found = openableTeams([mine, inSeason], ['tem_trosky', 'tem_guests'])
    expect(found.has('tem_guests')).equals(false)
  })

  it('prefers your own copy of a team to the season s', function () {
    const found = openableTeams([mine, inSeason], ['tem_trosky'])
    expect(found.get('tem_trosky')?.name).equals('Trosky Force 11U')
  })

  it('ignores every team that is not playing in this game', function () {
    const found = openableTeams([inSeason], ['tem_trosky'])
    expect(found.size).equals(1)
  })
})
