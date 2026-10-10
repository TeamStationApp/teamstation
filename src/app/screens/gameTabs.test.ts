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

const music = { available: true }
const onDjGame = (): void => undefined

function ids(pills: ReturnType<typeof gameTabs>): string[] {
  return pills.map(pill => pill.id)
}

describe('the pills across a game', function () {
  it('puts the separate Settings action last only when team administration and a destination are available', () => {
    const game = gameWith({ canScore: true, canDj: true })
    const onSettings = (): void => undefined
    const input = { game, music, onDjGame, onSettings, canManage: true }
    const pills = gameTabs(input)
    expect(ids(pills)).deep.equals([
      'boxScore',
      'watch',
      'score',
      'dj',
      'settings'
    ])
    expect(pills.at(-1)).deep.equals({
      id: 'settings',
      label: 'Settings',
      role: 'button'
    })
    expect(ids(gameTabs({ ...input, canManage: false }))).not.includes(
      'settings'
    )
    expect(ids(gameTabs({ ...input, onSettings: undefined }))).not.includes(
      'settings'
    )
  })
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
