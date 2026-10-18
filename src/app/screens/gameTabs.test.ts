import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGameDetail, type GameDetail } from '../../common/api'
import { gameActions, gameTabs, heroCoachSides } from './gameTabs'

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
    assignedRoles: {
      away: ['coach'],
      home: ['coach', 'scorekeeper', 'songkeeper', 'videographer']
    },
    ...fields
  }
}

const onRecordGame = (): void => undefined

function ids(pills: Array<{ id: string }>): string[] {
  return pills.map(pill => pill.id)
}

describe('the pills across a game', function () {
  it('filters hero actions by assigned roles, never implied admin or coaching powers', () => {
    const callbacks = {
      onRecordGame,
      onCoachGame: () => undefined,
      onDjGame: () => undefined
    }
    const game = gameWith({
      canScore: true,
      canDj: true,
      coachSides: ['away', 'home']
    })
    for (const [roles, expected] of [
      [[], []],
      [['admin'], []],
      [['coach'], ['coach']],
      [['scorekeeper'], ['score']],
      [['songkeeper'], ['dj']],
      [['videographer'], ['record']],
      [
        ['admin', 'coach', 'scorekeeper'],
        ['score', 'coach']
      ]
    ] as Array<[GameDetail['assignedRoles']['home'], string[]]>) {
      for (const side of ['away', 'home'] as const) {
        const assignedRoles = { away: [], home: [], [side]: roles }
        expect(
          ids(gameActions({ ...callbacks, game: { ...game, assignedRoles } }))
        ).deep.equals(expected)
      }
    }
    expect(
      heroCoachSides({
        ...game,
        assignedRoles: { away: ['admin'], home: ['coach'] }
      })
    ).deep.equals(['home'])
    expect(
      gameActions({ ...callbacks, game: { ...game, eventKind: 'event' } })
    ).deep.equals([])
  })
  it('keeps Settings outside the content pills', () => {
    expect(
      ids(
        gameTabs({
          game: gameWith({ canScore: true, canDj: true }),
          onRecordGame
        })
      )
    ).deep.equals(['info', 'boxScore', 'watch'])
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
    expect(ids(gameTabs({ game, onRecordGame }))).deep.equals([
      'info',
      'boxScore',
      'watch'
    ])
  })

  it('offers Record with a camera recording controller', function () {
    const actions = gameActions({
      game: gameWith({ canDj: true }),
      onRecordGame
    })
    expect(ids(actions)).deep.equals(['record'])
    expect(actions[0].label).equals('Record')
  })

  it('puts Score before Record', function () {
    const actions = gameActions({
      game: gameWith({ canScore: true, canDj: true }),
      onRecordGame
    })
    expect(ids(actions)).deep.equals(['score', 'record'])
  })

  it('leaves Record out without a supported, authorized recording controller', function () {
    const game = gameWith({ canScore: true, canDj: true })
    expect(ids(gameActions({ game }))).deep.equals(['score'])
    expect(
      ids(gameActions({ game: gameWith({ canDj: false }), onRecordGame }))
    ).deep.equals(['record'])
  })
  it('keeps Info as the only titled-event content tab', () => {
    expect(
      ids(gameTabs({ game: gameWith({ eventKind: 'event' }) }))
    ).deep.equals(['info'])
  })

  const onCoachGame = (): void => undefined

  it('orders Score, Record, Coach, DJ by independent capabilities', function () {
    const input = {
      game: gameWith({ canScore: true, canDj: true, coachSides: ['home'] }),
      onRecordGame,
      onCoachGame,
      onDjGame: () => undefined
    }
    expect(ids(gameTabs(input))).deep.equals(['info', 'boxScore', 'watch'])
    expect(gameActions(input)).deep.equals([
      { id: 'score', label: 'Score' },
      { id: 'record', label: 'Record' },
      { id: 'coach', label: 'Coach' },
      { id: 'dj', label: 'DJ' }
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

  it('shares scoring availability with Coach and DJ without requiring scoring permission', () => {
    for (const fields of [
      { status: 'scheduled' as const },
      { status: 'inProgress' as const, scoringOwner: 'teamstation' as const },
      { status: 'final' as const, scoringOwner: 'teamstation' as const },
      {
        status: 'final' as const,
        scoreboard: { open: true, mayOverride: true }
      },
      { status: 'final' as const, homeScore: 3, awayScore: 2 },
      { status: 'cancelled' as const }
    ]) {
      const base = gameWith({ ...fields, canDj: true, coachSides: ['home'] })
      const score = ids(
        gameActions({ game: { ...base, canScore: true } })
      ).includes('score')
      const other = ids(
        gameActions({ game: base, onCoachGame, onDjGame: () => undefined })
      )
      expect(other.includes('coach')).equals(score)
      expect(other.includes('dj')).equals(score)
    }
    expect(
      ids(
        gameActions({
          game: gameWith({ canDj: false }),
          onDjGame: () => undefined
        })
      )
    ).not.includes('dj')
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
