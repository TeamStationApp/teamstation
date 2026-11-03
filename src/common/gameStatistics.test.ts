import { expect } from 'chai'
import { describe, it } from 'mocha'

import { nativeStatistics } from '../test/gameStatisticsFixture'
import { finalGame, replayContext } from '../test/replayGameFixture'
import { TeamStationClient } from './api'
import {
  type GameStatistics,
  statisticsForAction,
  statisticsForCount,
  statisticsWindow
} from './gameStatistics'

const empty: GameStatistics = {
  version: '1',
  initial: null,
  boxes: [],
  source: { plays: [], currentPlay: null, generation: 0 },
  board: { version: '1', steps: [] },
  line: { version: '1', teams: { away: 'Visitors', home: 'Hosts' }, steps: [] }
}

describe('shared playback statistics client', () => {
  it('coalesces in-flight identical reads, then refreshes on the next read', async () => {
    const asked: string[] = []
    let release: () => void = () => {}
    let gate = new Promise<void>(resolve => {
      release = resolve
    })
    const client = new TeamStationClient({
      baseUrl: 'https://example.test',
      fetch: async input => {
        asked.push(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        )
        await gate
        return new Response(JSON.stringify(empty), {
          headers: { 'content-type': 'application/json' }
        })
      }
    })
    const first = client.gameStatistics('game/id', { fromMs: 0, toMs: 20 })
    const second = client.gameStatistics('game/id', { fromMs: 0, toMs: 20 })
    expect(asked).length(1)
    expect(asked[0]).contains(
      '/games/game%2Fid/box-score?view=playback&from=0&to=20'
    )
    release()
    expect(await first).deep.equals(await second)
    gate = Promise.resolve()
    await client.gameStatistics('game/id', { at: 0 })
    await client.gameStatistics('game/id', { at: 0 })
    expect(asked).length(3)
  })
  it('does not cache failures or share responses between authenticated identities', async () => {
    let failed = true
    let reads = 0
    const client = new TeamStationClient({
      baseUrl: 'https://example.test',
      fetch: async () => {
        reads++
        if (failed) throw new Error('offline')
        return new Response(JSON.stringify(empty))
      }
    })
    try {
      await client.gameStatistics('game')
    } catch (error) {
      expect(String(error)).contains('Cannot reach TeamStation')
    }
    failed = false
    await client.gameStatistics('game')
    expect(reads).equals(2)
  })
  it('does not coalesce pending requests across an identity change', async () => {
    const identities: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const client = new TeamStationClient({
      baseUrl: 'https://example.test',
      token: 'first',
      fetch: async (_input, init) => {
        identities.push(new Headers(init?.headers).get('authorization') ?? '')
        await gate
        return new Response(JSON.stringify(empty))
      }
    })
    const first = client.gameStatistics('game')
    client.token = 'second'
    const second = client.gameStatistics('game')
    expect(identities).deep.equals(['Bearer first', 'Bearer second'])
    release()
    await Promise.all([first, second])
  })
  it('selects applied actions rather than revealing all actions sharing a timestamp', async () => {
    const context = replayContext()
    const data = nativeStatistics(
      {
        id: context.gamePk,
        homeTeamId: context.teams.home.id,
        awayTeamId: context.teams.away.id,
        homeTeamName: 'Hosts',
        awayTeamName: 'Visitors'
      },
      await finalGame()
    )
    data.boxes.forEach(step => {
      step.at = 10
    })
    expect(statisticsWindow(data.boxes, {})).length(data.boxes.length)
    expect(statisticsWindow(data.boxes, { at: 10 })).deep.equals([
      data.boxes.at(-1)
    ])
    expect(statisticsWindow(data.boxes, { fromMs: 10 })).deep.equals([
      data.boxes.at(-1)
    ])
    expect(statisticsWindow(data.boxes, { at: 9 })).deep.equals([])
    expect(statisticsForCount(data, 0)).equals(data.initial)
    expect(statisticsForCount(data, 1)).equals(data.boxes[0].box)
    expect(statisticsForCount(data, 1)).not.deep.equals(data.boxes.at(-1)?.box)
    expect(statisticsForCount(empty, 1)).equals(null)
    expect(statisticsForAction(data, data.boxes[0].position)).equals(
      data.boxes[0].box
    )
    expect(
      statisticsForAction(data, {
        atBatIndex: Number.MAX_SAFE_INTEGER,
        actionIndex: 0
      })
    ).equals(data.boxes.at(-1)?.box)
    const mixed = {
      ...data,
      initial: null,
      boxes: [{ ...data.boxes[0], position: null }, ...data.boxes]
    }
    expect(statisticsForCount(mixed, 0)).equals(data.boxes[0].box)
    expect(statisticsForCount(mixed, 2)).equals(data.boxes[1].box)
  })
})
