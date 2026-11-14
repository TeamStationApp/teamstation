import { expect } from 'chai'
import { describe, it } from 'mocha'

import { finalGame, replayContext } from '../../test/replayGameFixture'
import { game } from '../../test/scoringGames'
import { replayBoxScore } from './replayBoxScore'
import { gamePlayerNames, namesOf } from './replayNames'
import { replayTimelineOf } from './replayTimeline'

describe('a replay’s player names', function () {
  it('names every player of a game', function () {
    expect(namesOf(game()).get(1)).equals('Player 1')
  })

  it('draws a label in full whole, beside the labels it shortens', function () {
    const state = game()
    Object.assign(state.gameData.players[1], {
      fullName: 'Mookie Betts',
      nameFormat: 'full',
      compactName: 'Mookie B'
    })
    Object.assign(state.gameData.players[2], {
      fullName: 'Mookie Bristow',
      firstName: 'Mookie',
      lastName: 'Bristow'
    })
    const names = gamePlayerNames(Object.values(state.gameData.players))
    expect(names.get(1)).equals('Mookie Betts')
    expect(names.get(2)).equals('Mookie B')
  })

  it('are the names the box score gives', async function () {
    const end = replayTimelineOf(await finalGame(), replayContext()).end
    const names = namesOf(end)
    const box = replayBoxScore(end)
    const lines = [
      ...box.away.batting,
      ...box.home.batting,
      ...box.away.pitching,
      ...box.home.pitching
    ]
    expect(lines.length).greaterThan(18)
    for (const line of lines) expect(line.name).equals(names.get(line.id))
  })
})
