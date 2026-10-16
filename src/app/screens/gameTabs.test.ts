import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGameDetail, type GameDetail } from '../../common/api'
import { gameActions, gameTabs } from './gameTabs'

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

function ids(pills: Array<{ id: string }>): string[] {
  return pills.map(pill => pill.id)
}

describe('the pills across a game', function () {
  it('puts the separate Settings action last only when team administration and a destination are available', () => {
    const game = gameWith({ canScore: true, canDj: true })
    const onSettings = (): void => undefined
    const input = { game, music, onDjGame, onSettings, canManage: true }
    const pills = gameTabs(input)
    expect(ids(pills)).deep.equals(['info', 'boxScore', 'watch', 'settings'])
    expect(ids(gameActions(input))).deep.equals(['score', 'record'])
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
  it('offers Score to a scorer of an unscored game', function () {
    const game = gameWith({ canScore: true })
    expect(ids(gameTabs({ game }))).deep.equals(['info', 'boxScore', 'watch'])
    expect(gameActions({ game })).deep.equals([{ id: 'score', label: 'Score' }])
  })

  it('offers it while only the scoreboard is open', function () {
    const game = gameWith({
      canScore: true,
      status: 'final',
      homeScore: 3,
      awayScore: 4,
      scoreboard: { open: true, mayOverride: true }
    })
    expect(ids(gameActions({ game }))).includes('score')
  })

  it('offers it to take up a game TeamStation is scoring', function () {
    const game = gameWith({
      canScore: true,
      status: 'final',
      homeScore: 3,
      awayScore: 4,
      scoringOwner: 'teamstation'
    })
    expect(ids(gameActions({ game }))).includes('score')
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
    expect(gameActions({ game })).deep.equals([])
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

  it('offers Record to a songkeeper with music', function () {
    const actions = gameActions({
      game: gameWith({ canDj: true }),
      music,
      onDjGame
    })
    expect(ids(actions)).deep.equals(['record'])
    expect(actions[0].label).equals('Record')
  })

  it('puts Score before Record', function () {
    const actions = gameActions({
      game: gameWith({ canScore: true, canDj: true }),
      music,
      onDjGame
    })
    expect(ids(actions)).deep.equals(['score', 'record'])
  })

  it('leaves Record out without an iPhone’s music or a way to open it', function () {
    const game = gameWith({ canScore: true, canDj: true })
    expect(ids(gameActions({ game, onDjGame }))).deep.equals(['score'])
    expect(
      ids(gameActions({ game, music: { djSupported: false }, onDjGame }))
    ).not.includes('record')
    expect(ids(gameActions({ game, music }))).not.includes('record')
  })
  it('offers authorized titled-event Settings while keeping Info its only content tab', () => {
    const game = gameWith({ eventKind: 'event', canScore: true, canDj: true })
    expect(
      ids(gameTabs({ game, canManage: true, onSettings: () => undefined }))
    ).deep.equals(['info', 'settings'])
    expect(
      ids(gameTabs({ game, canManage: false, onSettings: () => undefined }))
    ).deep.equals(['info'])
    expect(ids(gameTabs({ game, canManage: true }))).deep.equals(['info'])
  })

  const onCoachGame = (): void => undefined

  it('puts Coach after Score and Record, for a head coach (U23)', function () {
    const input = {
      game: gameWith({ canScore: true, canDj: true, coachSides: ['home'] }),
      music,
      onDjGame,
      onCoachGame,
      onSettings: () => undefined,
      canManage: true
    }
    expect(ids(gameTabs(input))).deep.equals([
      'info',
      'boxScore',
      'watch',
      'settings'
    ])
    expect(gameActions(input)).deep.equals([
      { id: 'score', label: 'Score' },
      { id: 'record', label: 'Record' },
      { id: 'coach', label: 'Coach' }
    ])
  })

  it('offers Coach to a head coach who does not score (U23)', function () {
    const game = gameWith({ coachSides: ['away', 'home'] })
    expect(ids(gameTabs({ game, onCoachGame }))).deep.equals([
      'info',
      'boxScore',
      'watch'
    ])
    expect(ids(gameActions({ game, onCoachGame }))).deep.equals(['coach'])
  })

  it('leaves Coach Game out for an assistant, a scorekeeper, a member, a cancelled game, or no way to open it (U23)', function () {
    // An assistant, like a member, coaches no side.
    expect(
      ids(gameTabs({ game: gameWith({ coachSides: [] }), onCoachGame }))
    ).deep.equals(['info', 'boxScore', 'watch'])
    // A scorekeeper only scores.
    expect(
      ids(
        gameActions({
          game: gameWith({ canScore: true, coachSides: [] }),
          onCoachGame
        })
      )
    ).deep.equals(['score'])
    expect(
      ids(
        gameActions({
          game: gameWith({ coachSides: ['home'], status: 'cancelled' }),
          onCoachGame
        })
      )
    ).not.includes('coach')
    expect(
      ids(gameActions({ game: gameWith({ coachSides: ['home'] }) }))
    ).not.includes('coach')
  })

  const startAt = '2027-04-10T18:00:00.000Z'
  const before = Date.parse(startAt) - 1
  const atStart = Date.parse(startAt)
  const live = [{ status: 'live' }] as GameDetail['videos']

  it('puts Box score first once a standing play exists', function () {
    const game = gameWith({ hasScoringEvents: true, startAt })
    expect(ids(gameTabs({ game, now: before }))).deep.equals([
      'boxScore',
      'watch',
      'info'
    ])
  })

  it('puts Videos first when a standing play and a live video coincide, even before the start', function () {
    const game = gameWith({
      hasScoringEvents: true,
      startAt,
      videos: live
    })
    expect(ids(gameTabs({ game, now: before }))).deep.equals([
      'watch',
      'boxScore',
      'info'
    ])
  })

  it('leaves Videos off the front of a live video when nobody has pitched and the start has not arrived', function () {
    const game = gameWith({ startAt, videos: live })
    expect(ids(gameTabs({ game, now: before }))).deep.equals([
      'info',
      'boxScore',
      'watch'
    ])
  })

  it('puts Videos first at the start time when a video is live, with or without a play', function () {
    const game = gameWith({ startAt, videos: live })
    expect(ids(gameTabs({ game, now: atStart }))).deep.equals([
      'watch',
      'boxScore',
      'info'
    ])
  })
})
