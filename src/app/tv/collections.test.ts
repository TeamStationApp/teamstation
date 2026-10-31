import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asTeamSummary,
  asVideoGame,
  type TeamStationClient,
  type TvHighlight
} from '../../common/api'
import { loadTvCollection, topClips } from './collections'

const game = (i: number): ReturnType<typeof asVideoGame> =>
  asVideoGame({
    id: `game-${i}`,
    homeTeamId: 'home',
    awayTeamId: 'away',
    homeTeamName: 'Hosts',
    awayTeamName: 'Visitors',
    homeTeamExternal: false,
    awayTeamExternal: false,
    seasonId: null,
    startAt: new Date(2026, 8, 30 - i).toISOString(),
    venue: null,
    status: 'final',
    homeScore: null,
    awayScore: null,
    ingestStatus: 'ok',
    videoCount: 2,
    latestVideoId: `video-${i}`,
    latestVideoAt: new Date(2026, 9, 30 - i).toISOString()
  })
const clip = (
  id: string,
  eventType: string | null,
  preferred = false,
  playOffsetSec = 10,
  isScoringPlay = false
): TvHighlight => ({
  eventId: id,
  eventType,
  preferred,
  playOffsetSec,
  isScoringPlay,
  atBatIndex: 0,
  title: 'Play',
  startOffsetSec: 0,
  stillUrl: '',
  description: null
})
const team = (id: string): ReturnType<typeof asTeamSummary> =>
  asTeamSummary({ id, name: id, shortName: null, logoPath: null })

describe('TV collection layout and ranking', () => {
  it('favors personal credits, then home runs, extra-base hits, RBI hits and other hits', () => {
    const clips = [
      clip('single', 'single'),
      clip('rbi', 'single', false, 10, true),
      clip('double', 'double'),
      clip('triple', 'triple', false, 20),
      clip('hr', 'home_run'),
      clip('mine', 'field_out', true)
    ]
    expect(topClips(game(0), clips).map(c => c.eventId)).deep.equals([
      'mine',
      'hr',
      'triple'
    ])
    expect(
      topClips(game(0), clips.slice(0, 3)).map(c => c.eventId)
    ).deep.equals(['double', 'rbi', 'single'])
  })
  it('deduplicates plays across angles, orders strikeouts and stable ties, and never fills missing clips', () => {
    const clips = [
      clip('z', 'unknown'),
      clip('a', null),
      clip('k', 'strikeout'),
      clip('k2', 'strikeout_double_play', false, 20),
      clip('k', 'strikeout')
    ]
    expect(topClips(game(0), clips).map(c => c.eventId)).deep.equals([
      'k2',
      'k',
      'a'
    ])
    expect(topClips(game(0), [])).deep.equals([])
    expect(topClips(game(0), [clips[0], clips[0]])).length(1)
  })
  it('builds ten recent games, twelve clips from four games, three followed rows and a distinct remaining grid', async () => {
    const games = Array.from({ length: 50 }, (_, i) => game(i))
    const teams = Array.from({ length: 101 }, (_, i) => team(`team-${i}`))
    const followed = teams
      .slice(0, 5)
      .map(t => ({ ...t, seasons: [], following: true }))
    const requests: object[] = []
    const client = {
      videoGames: async (options: Record<string, unknown> = {}) => {
        requests.push(options)
        if (options.sort === 'upload')
          return [
            game(
              options.team === undefined
                ? 20
                : Number((options.team as string).split('-')[1])
            )
          ]
        return games.slice(0, Number(options.limit))
      },
      videoTeams: async (options: { offset?: number } = {}) =>
        teams.slice(options.offset ?? 0, (options.offset ?? 0) + 100),
      myFollows: async () => followed,
      tvHighlights: async () =>
        Array.from({ length: 5 }, (_, i) => clip(`play-${i}`, 'single'))
    } as unknown as TeamStationClient
    const result = await loadTvCollection(client)
    expect(result.hero?.id).equals('game-20')
    expect(result.recent).length(10)
    expect(result.highlights).length(12)
    expect(new Set(result.highlights.map(c => c.game.id)).size).equals(4)
    expect(result.teamRows.map(row => row.team.id)).deep.equals([
      'team-0',
      'team-1',
      'team-2'
    ])
    expect(result.teamRows.every(row => row.games.length === 12)).equals(true)
    expect(result.teams).length(101)
    expect(result.remaining.map(g => g.id)).deep.equals(
      games.slice(10).map(g => g.id)
    )
    expect(result.nextOffset).equals(50)
    expect(requests.filter(r => (r as { limit: number }).limit === 12)).length(
      3
    )
  })
  it('filters every page to the player or team, omits follow rows, and handles empty and short collections', async () => {
    const requests: object[] = []
    let empty = true
    const client = {
      videoGames: async (options: object) => {
        requests.push(options)
        return empty ? [] : [game(0)]
      },
      videoTeams: async (options: object) => {
        requests.push(options)
        return []
      },
      myFollows: async () => {
        throw new Error('Filtered pages must not load follows')
      },
      tvHighlights: async () => []
    } as unknown as TeamStationClient
    const absent = await loadTvCollection(client, { participant: 'player' })
    expect(absent).deep.include({ hero: null, nextOffset: null })
    expect(absent.recent).deep.equals([])
    expect(
      requests.every(
        r => (r as { participant: string }).participant === 'player'
      )
    ).equals(true)
    empty = false
    const short = await loadTvCollection(client, { team: 'team' })
    expect(short.recent).length(1)
    expect(short.teamRows).deep.equals([])
    expect(short.remaining).deep.equals([])
    expect(short.nextOffset).equals(null)
  })
})
