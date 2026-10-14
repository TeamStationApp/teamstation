import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGameDetail, type GameDetail } from '../../common/api'
import { gameTabs } from './gameTabs'

function gameWith(fields: Partial<GameDetail>): GameDetail {
  return {
    ...asGameDetail({
      nonMemberView: false,
      id: 'g1',
      awayTeamId: 'away',
      homeTeamId: 'home',
      awayTeamName: 'Badgers (Ripken)',
      homeTeamName: 'Amber Gardens',
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

const music = { djSupported: true }
const onDjGame = (): void => undefined

function ids(pills: ReturnType<typeof gameTabs>): string[] {
  return pills.map(pill => pill.id)
}

describe('the pills across a game', function () {
  it('leaves Settings out of navigation pills', () => {
    expect(
      ids(
        gameTabs({
          game: gameWith({ canScore: true, canDj: true }),
          music,
          onDjGame
        })
      )
    ).deep.equals(['info', 'boxScore', 'watch', 'score', 'dj'])
  })
  it('offers Score Game to a scorer of an unscored game', function () {
    const pills = gameTabs({ game: gameWith({ canScore: true }) })
    expect(ids(pills)).deep.equals(['info', 'boxScore', 'watch', 'score'])
    expect(pills[3].label).equals('Score Game')
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

  it('offers it to take up a game TeamStation is scoring', function () {
    const game = gameWith({
      canScore: true,
      status: 'final',
      homeScore: 3,
      awayScore: 4,
      scoringOwner: 'teamstation'
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
    expect(ids(gameTabs({ game }))).deep.equals(['boxScore', 'watch', 'info'])
  })

  it('leaves it out for somebody who may not score', function () {
    const game = gameWith({
      canScore: false,
      scoreboard: { open: true, mayOverride: false }
    })
    expect(ids(gameTabs({ game, music, onDjGame }))).deep.equals([
      'info',
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
    expect(ids(pills)).deep.equals(['info', 'boxScore', 'watch', 'dj'])
    expect(pills[3].role).equals('button')
    expect(pills[3].label).equals('DJ Game')
  })

  it('puts Score Game immediately before DJ Game', function () {
    const pills = gameTabs({
      game: gameWith({ canScore: true, canDj: true }),
      music,
      onDjGame
    })
    expect(ids(pills)).deep.equals(['info', 'boxScore', 'watch', 'score', 'dj'])
  })

  it('leaves DJ Game out without an iPhone’s music or a way to open it', function () {
    const game = gameWith({ canScore: true, canDj: true })
    expect(ids(gameTabs({ game, onDjGame }))).deep.equals([
      'info',
      'boxScore',
      'watch',
      'score'
    ])
    expect(
      ids(gameTabs({ game, music: { djSupported: false }, onDjGame }))
    ).not.includes('dj')
    expect(ids(gameTabs({ game, music }))).not.includes('dj')
  })
  it('keeps Info as the only titled-event content tab', () => {
    expect(
      ids(
        gameTabs({
          game: gameWith({ eventKind: 'event', canScore: true, canDj: true })
        })
      )
    ).deep.equals(['info'])
  })
})
