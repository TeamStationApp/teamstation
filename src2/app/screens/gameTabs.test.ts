import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGameDetail, type GameDetail } from '../../common/api'
import { gameTabs } from './gameTabs'

function gameWith(fields: Partial<GameDetail>): GameDetail {
  return {
    ...asGameDetail({
      id: 'g1',
      awayTeamId: 'away',
      homeTeamId: 'home',
      awayTeamName: 'Bandits (Ruden)',
      homeTeamName: 'Allied Gardens',
      seasonId: null,
      startAt: null,
      venue: null,
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
      ingestStatus: 'pending',
      ingestMessage: null,
      videos: []
    }),
    ...fields
  }
}

const music = { available: true }
const onDjGame = (): void => undefined

function ids(pills: ReturnType<typeof gameTabs>): string[] {
  return pills.map(pill => pill.id)
}

describe('the pills across a game', function () {
  it('offers Score Game to a scorer of an unscored game', function () {
    const pills = gameTabs({ game: gameWith({ canScore: true }) })
    expect(ids(pills)).deep.equals(['boxScore', 'watch', 'score'])
    expect(pills[2].label).equals('Score Game')
  })

  it('offers it while only the scoreboard is open', function () {
    const game = gameWith({
      canScore: true,
      status: 'final',
      homeScore: 3,
      awayScore: 4,
      scoreboard: { open: true, mayOverride: true }
    })
    expect(ids(gameTabs({ game }))).includes('score')
  })

  it('offers it to take up a game GameStation is scoring', function () {
    const game = gameWith({
      canScore: true,
      status: 'final',
      homeScore: 3,
      awayScore: 4,
      scoringOwner: 'gamestation'
    })
    expect(ids(gameTabs({ game }))).includes('score')
  })

  it('leaves it out when there is nothing behind it', function () {
    const game = gameWith({
      canScore: true,
      status: 'final',
      homeScore: 3,
      awayScore: 4,
      scoreboard: { open: false, mayOverride: true }
    })
    expect(ids(gameTabs({ game }))).deep.equals(['boxScore', 'watch'])
  })

  it('leaves it out for somebody who may not score', function () {
    const game = gameWith({
      canScore: false,
      scoreboard: { open: true, mayOverride: false }
    })
    expect(ids(gameTabs({ game, music, onDjGame }))).deep.equals([
      'boxScore',
      'watch'
    ])
  })

  it('puts DJ Game last, for a songkeeper with music', function () {
    const pills = gameTabs({
      game: gameWith({ canDj: true }),
      music,
      onDjGame
    })
    expect(ids(pills)).deep.equals(['boxScore', 'watch', 'dj'])
    expect(pills[2].role).equals('button')
    expect(pills[2].label).equals('DJ Game')
  })

  it('puts Score Game immediately before DJ Game', function () {
    const pills = gameTabs({
      game: gameWith({ canScore: true, canDj: true }),
      music,
      onDjGame
    })
    expect(ids(pills)).deep.equals(['boxScore', 'watch', 'score', 'dj'])
  })

  it('leaves DJ Game out without music or a way to open it', function () {
    const game = gameWith({ canScore: true, canDj: true })
    expect(ids(gameTabs({ game, onDjGame }))).deep.equals([
      'boxScore',
      'watch',
      'score'
    ])
    expect(
      ids(gameTabs({ game, music: { available: false }, onDjGame }))
    ).not.includes('dj')
    expect(ids(gameTabs({ game, music }))).not.includes('dj')
  })
})
