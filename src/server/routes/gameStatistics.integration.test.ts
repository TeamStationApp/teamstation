import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { readTvStatistics, statisticsAt } from '../../app/tv/replayStatistics'
import { TeamStationClient } from '../../common/api'
import { statisticsForCount } from '../../common/gameStatistics'
import { asPostEventsBody } from '../../common/gumboPlay'
import { replayBoxScore } from '../../common/replay/replayBoxScore'
import {
  readReplaySource,
  replaySourceOf
} from '../../common/replay/replaySource'
import { REPLAY_TEAMS } from '../../test/replayGameFixture'
import {
  addGame,
  addPerson,
  addScorableTeams,
  addTeam,
  type Person,
  scoreDirectly,
  scratchDatabase
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { seedReplay } from '../dev/replaySeed'
import { postGamePlays } from '../events/postPlays'
import type { MediaContext } from '../media/mediaContext'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import type { ScoreboardStore } from '../scoreboard/scoreboardStore'
import { scoreboardRoutes } from './scoreboard'
import { teamRoutes } from './teams'

describe('unified box-score HTTP resource', function () {
  this.timeout(60000)
  let db: Kysely<Database>, drop: () => Promise<void>, server: Server
  let owner: Person,
    stranger: Person,
    gameId: string,
    base: string,
    client: TeamStationClient
  const epoch = Date.parse('2026-01-01T12:00:00Z')
  before(async () => {
    ;({ db, drop } = await scratchDatabase('unified_statistics'))
    const home = await addTeam(db, 'Owls')
    const away = await addTeam(db, 'Herons')
    owner = await addPerson(db, 'owner', { owns: home })
    stranger = await addPerson(db, 'stranger')
    gameId = await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date(epoch)
    })
    await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        mode: 'replace',
        source: { system: 'external' },
        plays: [0, 1].map(index => ({
          about: {
            atBatIndex: index,
            inning: 1,
            halfInning: 'top',
            endTime: new Date(epoch + (index + 1) * 10000).toISOString()
          },
          result: { eventType: 'single', awayScore: index + 1, homeScore: 0 }
        }))
      })
    )
    const app = express()
    app.use(withActor(db))
    app.use('/api/v1', teamRoutes(db, Object.create(null) as MediaContext))
    app.use(
      '/api/v1',
      scoreboardRoutes(db, Object.create(null) as ScoreboardStore)
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
    client = new TeamStationClient({ baseUrl: base, token: owner.token })
  })
  after(async () => {
    server?.closeAllConnections()
    server?.close()
    await drop?.()
  })
  const get = async (
    path: string,
    token: string | undefined = owner.token
  ): Promise<Response> =>
    await fetch(base + path, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` }
    })
  it('serves imported inning scores even when player details are incomplete', async () => {
    const answer = await client.gameStatistics(gameId)
    expect(answer.line.steps.map(step => step.line.away.r)).deep.equals([1, 2])
    expect(answer.boxes.every(step => step.box === null)).equals(true)
    expect(answer.boxes[0].message).includes('incomplete')
    expect(answer.source.plays).length(2)
    expect(
      answer.source.plays.every(play => play.teamStation === undefined)
    ).equals(true)
    console.log('$ GET /games/<imported-game>/box-score?view=playback')
    console.log(
      JSON.stringify({
        lines: answer.line.steps.map(s => s.line.away.r),
        statistics: answer.boxes.map(s => s.message)
      })
    )
  })
  it('keeps aliases and canonical time windows equivalent without leaking future scores', async () => {
    const at = epoch + 15000
    const answer = await client.gameStatistics(gameId, { at: at + 0.75 })
    expect(answer.line.steps).length(1)
    expect(answer.line.steps[0].line.away.r).equals(1)
    const legacy = await (
      await get(`/games/${gameId}/line-score?at=${at}`)
    ).json()
    expect(answer.line).deep.equals(legacy)
    expect(await client.lineScore(gameId, { at: at + 0.75 })).deep.equals(
      legacy
    )
    expect(
      await client.scoreboardTimeline(gameId, { fromMs: at + 0.75 })
    ).deep.equals((await client.gameStatistics(gameId, { fromMs: at })).board)
    const board = await (
      await get(`/games/${gameId}/scoreboard-timeline`)
    ).json()
    expect((await client.gameStatistics(gameId)).board).deep.equals(board)
    expect(
      (await client.gameStatistics(gameId, { at: epoch })).line.steps
    ).deep.equals([])
    const latest = await client.gameStatistics(gameId, {
      fromMs: epoch + 15000.75,
      toMs: epoch + 19999.25
    })
    expect(latest.line.steps.map(s => s.line.away.r)).deep.equals([1, 2])
  })
  it('preserves the default totals contract and checks historical parameters', async () => {
    const totals = await client.boxScore(gameId)
    expect(totals).has.keys('batting', 'pitching', 'stats')
    for (const query of [
      'view=unknown',
      'at=1',
      'view=playback&at=-1',
      'view=playback&at=1&at=2',
      'view=playback&from=20&to=10'
    ])
      expect(
        (await get(`/games/${gameId}/box-score?${query}`)).status,
        query
      ).equals(400)
  })
  it('keeps all consumers on the same native revision and refreshes corrections and names', async () => {
    const context = await addScorableTeams(db, {
      away: 'Visitors',
      home: 'Hosts'
    })
    const actor = await addPerson(db, 'scorer', { owns: context.teams.home.id })
    const id = await addGame(db, {
      awayTeamId: context.teams.away.id,
      homeTeamId: context.teams.home.id,
      startAt: new Date(epoch)
    })
    const reader = new TeamStationClient({ baseUrl: base, token: actor.token })
    await scoreDirectly(db, id, context, [{ type: 'pitch', call: 'B' }])
    const first = await reader.gameStatistics(id)
    const [tv, replay] = await Promise.all([
      readTvStatistics(reader, id),
      readReplaySource(reader, id)
    ])
    expect(tv.lines).deep.equals(first.line.steps)
    expect(tv.board).deep.equals(first.board)
    expect(statisticsAt(tv, Infinity).box).deep.equals(first.boxes.at(-1)?.box)
    const source = replaySourceOf(replay.game, replay.stored)!
    expect(
      statisticsForCount(replay.statistics, first.boxes.length)
    ).deep.equals(replayBoxScore(source.timeline.end))
    expect(first.initial?.away.batting.every(row => row.ab === 0)).equals(true)
    await scoreDirectly(db, id, context, [{ type: 'pitch', call: 'C' }])
    const changed = await reader.gameStatistics(id)
    expect(changed.version).not.equals(first.version)
    expect(changed.boxes.length).greaterThan(first.boxes.length)
    expect(
      statisticsAt(await readTvStatistics(reader, id), first.boxes[0].at).box
    ).deep.equals(first.boxes[0].box)
    await db
      .updateTable('teams')
      .set({ name: 'Renamed Hosts' })
      .where('id', '=', context.teams.home.id)
      .execute()
    const renamed = await reader.gameStatistics(id)
    expect(renamed.version).not.equals(changed.version)
    expect(renamed.initial?.home.name).equals('Renamed Hosts')
    expect(renamed.line.teams.home).equals('Renamed Hosts')
    console.log(
      '$ native replay / TV / video: initial, playhead, refresh, team rename agree'
    )
  })
  it('keeps inning lines and replay boxes in sync across imported and native plays', async () => {
    const seed = await seedReplay(db, {
      password: randomBytes(20).toString('hex')
    })
    const member = await addPerson(db, 'viewer', { owns: REPLAY_TEAMS.home.id })
    const reader = new TeamStationClient({ baseUrl: base, token: member.token })
    const id = seed.games.importedThenScored
    const { boxes } = await reader.gameStatistics(id)
    const line = await reader.lineScore(id)
    for (const step of boxes) {
      if (step !== boxes.findLast(item => item.at === step.at)) continue
      const shown = line.steps.findLast(item => item.at <= step.at)?.line
      if (shown === undefined || step.box === null)
        throw new Error(`Missing mixed-game line or player box at ${step.at}`)
      for (const side of ['away', 'home'] as const) {
        const box = step.box[side]
        expect(shown[side]).deep.equals({
          innings: box.innings,
          r: box.runs,
          h: box.hits,
          e: box.errors
        })
      }
    }
    expect(line.steps.at(-1)?.line.home).deep.equals({
      innings: [1, 2, null],
      r: 3,
      h: 3,
      e: 1
    })
  })
  it('replaces obsolete imported history on a correction', async () => {
    const before = await client.gameStatistics(gameId)
    await db
      .updateTable('games')
      .set({ status: 'inProgress' })
      .where('id', '=', gameId)
      .execute()
    const play = structuredClone(before.source.plays[0])
    play.result.awayScore = 4
    await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        mode: 'replace',
        source: { system: 'external' },
        plays: [play]
      })
    )
    const after = await client.gameStatistics(gameId)
    expect(after.version).not.equals(before.version)
    expect(after.line.steps.map(step => step.line.away.r)).deep.equals([4])
    expect(after.boxes).length(1)
    expect(after.source.plays).length(1)
  })
  it('enforces membership for every projection', async () => {
    for (const view of ['playback', 'line', 'board'])
      expect(
        (await get(`/games/${gameId}/box-score?view=${view}`, stranger.token))
          .status
      ).equals(403)
    expect(
      (await fetch(`${base}/games/${gameId}/box-score?view=playback`)).status
    ).equals(401)
    expect(
      (await get('/games/gam_missing/box-score?view=playback')).status
    ).equals(404)
  })
})
