import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asGameDetail,
  type GameLineupsResponse,
  type TeamLineups,
  type TeamStationClient
} from '../../common/api'
import { freshGame } from '../../common/scoring/lineup'
import { lineupOf } from '../../common/scoring/lineupHistory'
import { lineupsOf } from '../../common/scoring/state'
import { nativeStatistics } from '../../test/gameStatisticsFixture'
import { finalGame, replayContext } from '../../test/replayGameFixture'
import {
  lineOf,
  readTvStatistics,
  startingBox,
  statisticsAt
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
  it('reads only the shared resource and preserves its initial and historical boxes', async () => {
    const stored = await finalGame()
    const data = nativeStatistics(game, stored)
    const calls: string[] = []
    const client = {
      gameStatistics: async (id: string) => {
        calls.push(id)
        return data
      }
    } as unknown as TeamStationClient
    const actual = await readTvStatistics(client, game.id)
    expect(calls).deep.equals([game.id])
    expect(statisticsAt(actual, 0).box).deep.equals(data.initial)
    expect(statisticsAt(actual, Infinity).box).deep.equals(
      data.boxes.at(-1)?.box
    )
    expect(statisticsAt(actual, 0).box).deep.equals(data.initial)
    expect(actual.teams).equals(data.line.teams)
    expect(actual.lines).equals(data.line.steps)
    expect(actual.board).equals(data.board)
    const box = data.initial!
    expect(lineOf(box).away.r).equals(box.away.runs)
    expect(lineOf(box).home.innings).deep.equals(box.home.innings)
  })
  it('keeps independent inning data when player statistics are incomplete', async () => {
    const data = nativeStatistics(game, empty)
    data.boxes = [
      {
        at: 100,
        position: null,
        box: null,
        message: 'Incomplete imported players'
      }
    ]
    const client = {
      gameStatistics: async () => data
    } as unknown as TeamStationClient
    const actual = await readTvStatistics(client, game.id)
    expect(statisticsAt(actual, 99)).deep.equals({
      box: undefined,
      message: 'Statistics begin with the first recorded play.'
    })
    expect(statisticsAt(actual, 100)).deep.equals({
      box: undefined,
      message: 'Incomplete imported players'
    })
    expect(actual.teams).equals(data.line.teams)
    expect(actual.lines).equals(data.line.steps)
    expect(
      statisticsAt({ boxes: [], message: 'Loading statistics…' }, null).message
    ).equals('Loading statistics…')
    expect(statisticsAt({ boxes: [], message: null }, null).message).equals(
      null
    )
  })
  it('distinguishes unavailable data from denied and failed requests', async () => {
    const client = {
      gameStatistics: async () => nativeStatistics(game, empty)
    } as unknown as TeamStationClient
    expect((await readTvStatistics(client, game.id)).message).contains(
      'not available'
    )
    for (const status of [401, 403]) {
      client.gameStatistics = async () => {
        throw Object.assign(new Error('Denied'), { status })
      }
      expect((await readTvStatistics(client, game.id)).message).contains(
        'do not have access'
      )
    }
    client.gameStatistics = async () => {
      throw new Error('Offline')
    }
    expect((await readTvStatistics(client, game.id)).message).contains(
      'could not load'
    )
    client.gameStatistics = async () =>
      nativeStatistics(game, await finalGame())
    expect((await readTvStatistics(client, game.id)).message).equals(null)
  })
  it('preserves zero-stat starting lineups without inventing past results', async () => {
    const box = startingBox(game, lineups)!
    expect(box.away.batting.map(row => row.id)).deep.equals(
      lineups.away.current!.batters.map(person => person.gumboId)
    )
    expect(box.away.runs).equals(0)
    expect(
      startingBox(game, {
        ...lineups,
        away: { ...lineups.away, current: null },
        home: { ...lineups.home, current: null }
      })
    ).equals(null)
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
