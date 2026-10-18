import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { defaultRadarSettings } from '../../common/nodeSettings'
import { NO_OVERRIDES } from '../../common/scoreboard'
import type { ScoringAction } from '../../common/scoring/actions'
import { type EventStore, ScoringSession } from '../../common/scoring/session'
import {
  addGame,
  addScorableTeams,
  scratchDatabase,
  until
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { computeBoardTimeline } from '../scoreboard/boardTimeline'
import { logScoreboard } from '../scoreboard/scoreboardLog'
import { postGamePlays, readPlays } from './postPlays'
import {
  radarReadings,
  refreshRadarSpeeds,
  scheduleRadarRefresh
} from './radarSpeeds'

describe('persisted radar speeds', function () {
  this.timeout(60000)
  let db: Kysely<Database>, drop: () => Promise<void>
  before(async () => {
    ;({ db, drop } = await scratchDatabase('radar_speeds'))
  })
  after(async () => {
    await drop?.()
  })
  async function fixture(): Promise<{
    id: string
    session: ScoringSession
    load: () => ReturnType<EventStore['load']>
    tick: (ms: number) => void
    score: (...actions: ScoringAction[]) => Promise<void>
    packet: (radar: any, offset?: number) => Promise<'inserted' | 'skipped'>
  }> {
    const context = await addScorableTeams(db, {
      home: 'Copper Comets',
      away: 'Silver Rockets'
    })
    const id = await addGame(db, {
      homeTeamId: context.teams.home.id,
      awayTeamId: context.teams.away.id,
      startAt: new Date()
    })
    let time = Date.parse('2026-01-01T12:00:00Z')
    let version = 0
    const load: EventStore['load'] = async () => ({
      plays: (await readPlays(db, id)).map(r => r.gumbo as GumboPlay),
      currentPlay: (
        await db
          .selectFrom('games')
          .select('currentPlay')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).currentPlay as CurrentPlay
    })
    const save: EventStore['save'] = async (_, changes) => {
      await postGamePlays(
        db,
        id,
        asPostEventsBody({
          ...changes,
          mode: 'live',
          source: { system: 'teamstation' }
        })
      )
      return await load(id)
    }
    const session = await ScoringSession.open(
      { load, save },
      id,
      { gamePk: id, ...context },
      {
        now: () => new Date(time),
        setTimer: () => null,
        clearTimer: () => undefined
      }
    )
    return {
      id,
      session,
      load: async () => await load(id),
      tick: (ms: number) => {
        time += ms
      },
      score: async (...actions: ScoringAction[]) => {
        for (const action of actions)
          expect(session.apply(action).problems).deep.equals([])
        await session.flush()
      },
      packet: async (radar: any, offset = 0) =>
        await logScoreboard(db, {
          gameId: id,
          version: ++version,
          at: time + offset,
          cause: 'publisher',
          actorId: null,
          publisher: { state: radar, receivedAt: time + offset },
          overrides: NO_OVERRIDES,
          radar
        })
    }
  }
  const pitches = (p: any): any[] =>
    (p?.playEvents ?? []).filter((e: any) => e.isPitch)
  it('retains an unchanged pitch when an earlier correction merges its at-bat', async () => {
    const f = await fixture()
    const actions: ScoringAction[] = [
      { type: 'pitch', call: 'B' },
      { type: 'result', eventType: 'single' },
      { type: 'pitch', call: 'C' }
    ]
    for (const [i, action] of actions.entries()) {
      await f.packet({ pitchSpeed: 80 + i })
      await f.score(action)
      f.tick(20000)
    }
    const before: any = (await f.load()).currentPlay
    expect(pitches(before)[0].pitchData.startSpeed).equals(82)
    await db.deleteFrom('scoreboard_log').where('game_id', '=', f.id).execute()
    f.tick(600000)
    expect(
      f.session.sync([actions[0], { type: 'pitch', call: 'B' }, actions[2]])
    ).deep.equals([])
    await f.session.flush()
    const changed: any = (await f.load()).currentPlay
    expect(changed.about.atBatIndex).not.equals(before.about.atBatIndex)
    expect(pitches(changed)[2].pitchData.startSpeed).equals(82)
    await refreshRadarSpeeds(db, f.id)
    expect(
      pitches((await f.load()).currentPlay)[2].pitchData.startSpeed
    ).equals(82)
  })

  for (const eventType of ['single', 'strikeout'] as const)
    it(`retains equal-time batched pitches after ${eventType} across partial reposts and manual edits`, async () => {
      const f = await fixture()
      await f.packet({ pitchSpeed: 88 })
      const prefix: ScoringAction[] =
        eventType === 'strikeout'
          ? Array.from({ length: 3 }, () => ({ type: 'pitch', call: 'C' }))
          : [{ type: 'result', eventType }]
      const actions: ScoringAction[] = [
        ...prefix,
        { type: 'pitch', call: 'B', speed: 80 },
        { type: 'pitch', call: 'C', speed: 84 }
      ]
      expect(f.session.sync(actions)).deep.equals([])
      await f.session.flush()
      const speeds = async (): Promise<number[]> =>
        pitches((await f.load()).currentPlay).map(p => p.pitchData.startSpeed)
      expect(await speeds()).deep.equals([88, 88])
      await db
        .deleteFrom('scoreboard_log')
        .where('game_id', '=', f.id)
        .execute()
      // Only the current play is posted; its preceding at-bat stays in storage.
      const currentPlay: any = (await f.load()).currentPlay
      await postGamePlays(
        db,
        f.id,
        asPostEventsBody({
          plays: [],
          currentPlay,
          mode: 'live',
          source: { system: 'teamstation' }
        })
      )
      expect(await speeds()).deep.equals([88, 88])
      f.tick(600000)
      expect(
        f.session.sync([
          ...prefix,
          { type: 'pitch', call: 'B', speed: 84 },
          actions.at(-1)!
        ])
      ).deep.equals([])
      await f.session.flush()
      expect(await speeds()).deep.equals([84, 88])
      await refreshRadarSpeeds(db, f.id)
      expect(await speeds()).deep.equals([84, 88])
    })

  it('retains a pitch speed when an earlier pickoff is removed and reinserted after log expiry', async () => {
    const f = await fixture()
    await f.score(
      ...Array.from({ length: 4 }, (): ScoringAction => ({
        type: 'pitch',
        call: 'B'
      }))
    )
    await f.score({ type: 'gameFlow', kind: 'closePlay' })
    const runner = f.session.state.liveData.linescore.offense.first!.id
    const pickoff: ScoringAction = {
      type: 'runnerMovement',
      runner,
      to: '1B',
      reason: 'Safe from Pickoff'
    }
    f.tick(10000)
    await f.score(pickoff)
    f.tick(10000)
    await f.packet({ pitchSpeed: 82 })
    await f.score({ type: 'pitch', call: 'B' })
    const original: any = (await f.load()).currentPlay
    expect(pitches(original)[0].pitchData.startSpeed).equals(82)
    const actions = [...f.session.actions]
    await db.deleteFrom('scoreboard_log').where('game_id', '=', f.id).execute()
    expect(
      f.session.sync(actions.filter(action => action.type !== 'runnerMovement'))
    ).deep.equals([])
    await f.session.flush()
    const removed: any = (await f.load()).currentPlay
    expect(pitches(removed)[0].index).not.equals(pitches(original)[0].index)
    expect(pitches(removed)[0].pitchData.startSpeed).equals(82)
    expect(f.session.sync(actions)).deep.equals([])
    await f.session.flush()
    const reinserted: any = (await f.load()).currentPlay
    expect(pitches(reinserted)[0].index).equals(pitches(original)[0].index)
    expect(pitches(reinserted)[0].pitchData.startSpeed).equals(82)
    await refreshRadarSpeeds(db, f.id)
    expect(
      pitches((await f.load()).currentPlay)[0].pitchData.startSpeed
    ).equals(82)
  })

  it('keeps playback times when an earlier pitch changes radar category', async () => {
    const f = await fixture()
    const actions: ScoringAction[] = ['B', 'C', 'F'].map(call => ({
      type: 'pitch',
      call: call as 'B' | 'C' | 'F'
    }))
    for (const action of actions) {
      await f.score(action)
      f.tick(20000)
    }
    const original = (await computeBoardTimeline(db, f.id))!.steps.map(
      s => s.at
    )
    f.tick(600000)
    const corrected: ScoringAction[] = [
      { type: 'pitch', call: 'F' },
      ...actions.slice(1)
    ]
    expect(f.session.sync(corrected)).deep.equals([])
    await f.session.flush()
    const current = (await f.load()).currentPlay as any
    expect(Date.parse(current.teamStation.actionTimes[0])).equals(
      original[0] + 660000
    )
    expect(current.teamStation.playbackTimes.map(Date.parse)).deep.equals(
      original
    )
    const timeline = (await computeBoardTimeline(db, f.id))!.steps
    expect(timeline[0].at).equals(original[0])
    expect(timeline.every(s => s.at <= original[2])).equals(true)
    expect(timeline.find(s => s.at === original[1])?.state.strikes).equals(2)
    await refreshRadarSpeeds(db, f.id)
    expect((await computeBoardTimeline(db, f.id))!.steps).deep.equals(timeline)
  })

  it('clears measurements outside narrowed settings on refresh and repost', async () => {
    const setWindows = async (pitch: number, inPlay: number): Promise<void> => {
      for (const [key, value] of [
        ['radar.pitchWindowSec', pitch],
        ['radar.inPlayWindowSec', inPlay]
      ] as const)
        await db
          .insertInto('system_settings')
          .values({ key, value })
          .onConflict(c => c.column('key').doUpdateSet({ value }))
          .execute()
    }
    try {
      for (const hit of [false, true]) {
        await setWindows(3, 15)
        const f = await fixture()
        await f.packet(
          { pitchSpeed: 82, exitVelocity: 94 },
          hit ? -14000 : 2500
        )
        await f.score(
          hit
            ? { type: 'ballInPlay', contact: 'swing' }
            : { type: 'pitch', call: 'B' }
        )
        const prior = (await f.load()).currentPlay!
        expect(pitches(prior)[0].pitchData.startSpeed).equals(82)
        await setWindows(1, 10)
        await refreshRadarSpeeds(db, f.id)
        expect(
          pitches((await f.load()).currentPlay)[0].pitchData?.startSpeed
        ).equals(undefined)
        expect(
          pitches((await f.load()).currentPlay)[0].hitData?.launchSpeed
        ).equals(undefined)
        await postGamePlays(
          db,
          f.id,
          asPostEventsBody({
            mode: 'live',
            plays: [],
            currentPlay: prior,
            source: { system: 'teamstation' }
          })
        )
        expect(
          pitches((await f.load()).currentPlay)[0].pitchData?.startSpeed
        ).equals(undefined)
        expect(
          pitches((await f.load()).currentPlay)[0].hitData?.launchSpeed
        ).equals(undefined)
      }
    } finally {
      await db
        .deleteFrom('system_settings')
        .where('key', 'in', ['radar.pitchWindowSec', 'radar.inPlayWindowSec'])
        .execute()
    }
  })
  it('keeps all three speeds through dropped-third-strike current and completed reposts', async () => {
    const f = await fixture()
    for (const speed of [80, 81]) {
      await f.packet({ pitchSpeed: speed })
      await f.score({ type: 'pitch', call: 'C' })
      f.tick(10000)
    }
    await f.packet({ pitchSpeed: 82, exitVelocity: 95 })
    await f.score({ type: 'result', eventType: 'strikeout' })
    const current = (await f.load()).currentPlay!
    expect(pitches(current).map(p => p.pitchData?.startSpeed)).deep.equals([
      80, 81, 82
    ])
    expect(pitches(current).map(p => p.hitData?.launchSpeed)).deep.equals([
      undefined,
      undefined,
      undefined
    ])
    // Retention can remove packets. A client repost without server fields
    // must still retain the measurements for these same timed pitches.
    await db.deleteFrom('scoreboard_log').where('game_id', '=', f.id).execute()
    const withoutSpeeds = <T>(play: T): T => {
      const copy = structuredClone(play)
      for (const p of pitches(copy)) delete p.pitchData.startSpeed
      return copy
    }
    await postGamePlays(
      db,
      f.id,
      asPostEventsBody({
        mode: 'live',
        plays: [],
        currentPlay: withoutSpeeds(current),
        source: { system: 'teamstation' }
      })
    )
    expect(
      pitches((await f.load()).currentPlay).map(p => p.pitchData?.startSpeed)
    ).deep.equals([80, 81, 82])
    await f.score(
      {
        type: 'runnerMovement',
        runner: f.session.state.liveData.plays.currentPlay!.matchup.batter.id,
        to: '1B'
      },
      { type: 'gameFlow', kind: 'closePlay' }
    )
    const completed = (await f.load()).plays[0]
    await postGamePlays(
      db,
      f.id,
      asPostEventsBody({
        plays: [withoutSpeeds(completed)],
        source: { system: 'teamstation' }
      })
    )
    expect(
      pitches((await f.load()).plays[0]).map(p => p.pitchData?.startSpeed)
    ).deep.equals([80, 81, 82])
  })
  it('enriches current and completed plays, survives live/replacement reposts, and keeps final status', async () => {
    const f = await fixture()
    await f.packet({ pitchSpeed: 81 })
    await f.score({ type: 'pitch', call: 'B' })
    expect(
      pitches((await f.load()).currentPlay)[0].pitchData.startSpeed
    ).equals(81)
    f.tick(20000)
    await f.packet({ pitchSpeed: 83, exitVelocity: 96 }, -1000)
    await f.score(
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'ballInPlay', contact: 'swing', launchAngle: 20 },
      { type: 'result', eventType: 'single' },
      { type: 'gameFlow', kind: 'closePlay' }
    )
    const stored = await f.load()
    expect(
      pitches(stored.plays[0]).map(p => [
        p.pitchData.startSpeed,
        p.hitData?.launchSpeed
      ])
    ).deep.equals([
      [81, undefined],
      [83, 96]
    ])
    await postGamePlays(
      db,
      f.id,
      asPostEventsBody({
        plays: stored.plays,
        source: { system: 'teamstation' }
      })
    )
    expect(pitches((await f.load()).plays[0])).deep.equals(
      pitches(stored.plays[0])
    )
    await db
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', f.id)
      .execute()
    await f.packet({ exitVelocity: 97 }, -500)
    await refreshRadarSpeeds(db, f.id)
    expect(pitches((await f.load()).plays[0])[1].hitData.launchSpeed).equals(97)
    expect(
      (
        await db
          .selectFrom('games')
          .select('status')
          .where('id', '=', f.id)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('final')
  })
  it('refreshes delayed packets after posting and never resurrects an undone pitch', async () => {
    const f = await fixture()
    await f.score({ type: 'pitch', call: 'C' })
    await f.packet({ pitchSpeed: 84 }, 2500)
    scheduleRadarRefresh(db, f.id, 10000)
    scheduleRadarRefresh(db, f.id, 10)
    await until(
      'delayed radar',
      async () =>
        pitches((await f.load()).currentPlay)[0]?.pitchData?.startSpeed === 84
    )
    expect(f.session.undo().problems).deep.equals([])
    await Promise.all([
      f.session.flush(),
      refreshRadarSpeeds(db, f.id),
      refreshRadarSpeeds(db, f.id)
    ])
    await refreshRadarSpeeds(db, f.id)
    expect(pitches((await f.load()).currentPlay)).length(0)
    expect((await f.load()).plays).length(0)
    await refreshRadarSpeeds(db, 'missing-game')
  })
  it('does not enrich imports, manual scoring or records with no times', async () => {
    const f = await fixture()
    await f.score(
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' }
    )
    await f.score({ type: 'gameFlow', kind: 'closePlay' })
    const source = (await f.load()).plays[0]
    for (const system of ['manual', 'teamstation']) {
      await db
        .updateTable('games')
        .set({ status: 'inProgress' })
        .where('id', '=', f.id)
        .execute()
      const copy = structuredClone(source) as any
      delete copy.teamStation.actionTimes
      await postGamePlays(
        db,
        f.id,
        asPostEventsBody({ plays: [copy], source: { system } })
      )
      await f.packet({ pitchSpeed: 85 })
      await refreshRadarSpeeds(db, f.id)
      expect(
        pitches((await f.load()).plays[0]).some(
          p => p.pitchData?.startSpeed != null
        )
      ).equals(false)
    }
    expect(
      await radarReadings(db, f.id, [null], defaultRadarSettings)
    ).deep.equals([])
  })
  it('keeps plain corrections on their reading but rematches changed pitch categories', async () => {
    const f = await fixture()
    await f.packet({ pitchSpeed: 80 })
    await f.score({ type: 'pitch', call: 'B' })
    f.tick(60000)
    expect(f.session.sync([{ type: 'pitch', call: 'C' }])).deep.equals([])
    await f.session.flush()
    expect(
      pitches((await f.load()).currentPlay)[0].pitchData.startSpeed
    ).equals(80)
    await f.packet({ pitchSpeed: 90 })
    expect(f.session.sync([{ type: 'pitch', call: 'F' }])).deep.equals([])
    await f.session.flush()
    expect(
      pitches((await f.load()).currentPlay)[0].pitchData.startSpeed
    ).equals(90)
  })
})
