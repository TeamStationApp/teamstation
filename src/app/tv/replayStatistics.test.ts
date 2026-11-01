import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asGameDetail,
  type GameLineupsResponse,
  type TeamLineups,
  type TeamStationClient
} from '../../common/api'
import { replayScore, replaySourceOf } from '../../common/replay/replaySource'
import { freshGame } from '../../common/scoring/lineup'
import { lineupOf } from '../../common/scoring/lineupHistory'
import { lineupsOf } from '../../common/scoring/state'
import { finalGame, replayContext } from '../../test/replayGameFixture'
import { boardAt } from '../player/scoreboardOverlay/boardAt'
import {
  canSupplement,
  lineOf,
  readTvStatistics,
  startingBox
} from './replayStatistics'

const context = replayContext()
const game = asGameDetail({
  id: context.gamePk,
  status: 'scheduled',
  awayTeamId: context.teams.away.id,
  homeTeamId: context.teams.home.id,
  awayTeamName: 'Visitors',
  homeTeamName: 'Hosts',
  awayLogoUrl: null,
  homeLogoUrl: null,
  nonMemberView: false,
  seasonId: null,
  startAt: null,
  venue: null,
  homeScore: null,
  awayScore: null,
  ingestStatus: 'none',
  ingestMessage: null,
  videos: []
})
const initial = freshGame(game.id, context.teams, context.setup)
const side = (which: 'away' | 'home'): TeamLineups => ({
  teamId: context.teams[which].id,
  teamName: game[which === 'away' ? 'awayTeamName' : 'homeTeamName'],
  start: null,
  current: lineupOf(lineupsOf(initial), which, initial.gameData.players),
  changes: []
})
const lineups: GameLineupsResponse = {
  away: side('away'),
  home: side('home'),
  digest: '',
  generation: 1
}
const empty = { plays: [], currentPlay: null, generation: 1 }

describe('TV replay statistics source', () => {
  it('reads the same documents and renders the initial replay state before a pitch', async () => {
    const stored = await finalGame()
    const calls: string[] = []
    const client = {
      game: async (id: string) => {
        calls.push(`game:${id}`)
        return game
      },
      gameEvents: async (id: string) => {
        calls.push(`events:${id}`)
        return stored
      },
      gameLineups: async () => {
        throw new Error('Historical games must not read current lineups')
      }
    } as unknown as TeamStationClient
    const actual = await readTvStatistics(client, game.id)
    const source = replaySourceOf(game, stored)!
    expect(actual.message).equals(null)
    expect(calls).deep.equals([`game:${game.id}`, `events:${game.id}`])
    const first = boardAt(actual.boxes, 0)!.box
    expect(first).deep.equals(
      replayScore(source.timeline.start, source.timeline)
    )
    expect(first.away.batting.length).greaterThan(0)
    expect(first.away.batting.every(row => row.ab === 0 && row.h === 0)).equals(
      true
    )
    const final = boardAt(actual.boxes, Infinity)!.box
    expect(final).deep.equals(replayScore(source.timeline.end, source.timeline))
    expect(lineOf(final).away.r).equals(final.away.runs)
    expect(lineOf(final).home.innings).deep.equals(final.home.innings)
    expect(boardAt(actual.boxes, 0)!.box).deep.equals(first)
  })

  it('supplements only genuinely unstarted games using the saved arrangement', async () => {
    const client = {
      game: async () => game,
      gameEvents: async () => empty,
      gameLineups: async () => lineups
    } as unknown as TeamStationClient
    const result = await readTvStatistics(client, game.id)
    const box = result.boxes[0].box
    expect(result.message).equals(null)
    expect(box.away.batting.map(row => row.id)).deep.equals(
      lineups.away.current!.batters.map(person => person.gumboId)
    )
    expect(box.home.pitching.map(row => row.id)).deep.equals([
      lineups.home.current!.defense.P!.gumboId
    ])
    expect(box.away.runs).equals(0)
    expect(canSupplement({ ...game, status: 'final' }, empty)).equals(false)
    expect(canSupplement(game, await finalGame())).equals(false)
    expect(
      startingBox(game, {
        ...lineups,
        away: { ...lineups.away, current: null },
        home: { ...lineups.home, current: null }
      })
    ).equals(null)
  })

  it('distinguishes unavailable lineups, changed generations and failed or denied reads', async () => {
    const client = {
      game: async () => game,
      gameEvents: async () => empty,
      gameLineups: async () => lineups
    } as unknown as TeamStationClient
    client.gameLineups = async () => ({ ...lineups, generation: 2 })
    expect((await readTvStatistics(client, game.id)).message).contains(
      'game changed'
    )
    client.gameLineups = async () => ({
      ...lineups,
      away: { ...lineups.away, current: null },
      home: { ...lineups.home, current: null }
    })
    expect((await readTvStatistics(client, game.id)).message).contains(
      'Starting lineups'
    )
    client.gameEvents = async () => {
      throw Object.assign(new Error('Denied'), { status: 403 })
    }
    expect((await readTvStatistics(client, game.id)).message).contains(
      'do not have access'
    )
    client.gameEvents = async () => {
      throw new Error('Offline')
    }
    expect((await readTvStatistics(client, game.id)).message).contains(
      'could not load'
    )
    client.gameEvents = async () => empty
    client.game = async () => ({ ...game, status: 'final' })
    expect((await readTvStatistics(client, game.id)).message).contains(
      'not available for this game'
    )
  })
  it('keeps explicitly named unregistered starters without inventing an account', () => {
    const lineup = structuredClone(lineups)
    const batter = lineup.away.current!.batters[0]
    batter.gumboId = null
    const pitcher = lineup.home.current!.defense.P!
    pitcher.gumboId = null
    const box = startingBox(game, lineup)!
    expect(box.away.batting[0]).includes({ name: batter.name, ab: 0, h: 0 })
    expect(box.away.batting[0].id).lessThan(0)
    expect(box.home.pitching[0]).includes({
      name: pitcher.name,
      pc: 0,
      ip: '0.0'
    })
    expect(lineup.away.current!.batters[0].gumboId).equals(null)
  })
})
