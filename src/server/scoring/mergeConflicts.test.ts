import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { newSetup } from '../../common/scoring/lineup'
import { ScoringSession, type StoredGame } from '../../common/scoring/session'
import { asLegacyGameSetup } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { closeInto } from '../admin/people'
import { postGamePlays, readPlays } from '../events/postPlays'
import { resolveScoringGame } from './openRow'

describe('account merges preserve distinct physical scoring roles', function () {
  this.timeout(30000)
  let fixture: AccountHarness
  const teams = {
    away: { id: 'tem_away', name: 'Owls' },
    home: { id: 'tem_home', name: 'Hawks' }
  }
  const roster = (
    start: number
  ): Array<{ gumboId: number; shortName: string }> =>
    Array.from({ length: 9 }, (_, i) => ({
      gumboId: start + i,
      shortName:
        start + i === 101 ? 'Babe R' : start + i === 102 ? 'Lou G' : 'Mike T'
    }))
  const setup = newSetup(teams, { away: roster(101), home: roster(110) })
  const context = { gamePk: 'gam_merge_roles', teams, setup }
  const options = { setTimer: () => null, clearTimer: () => undefined }
  beforeEach(async () => {
    fixture = await accountHarness()
    await insertFixtureUsers(
      fixture.db,
      [...Array.from({ length: 16 }, (_, i) => i + 103), 201].map(id => ({
        id,
        display_name: 'Mike Trout',
        login_enabled: false
      }))
    )
    await fixture.db.insertInto('teams').values(Object.values(teams)).execute()
    await fixture.db
      .insertInto('games')
      .values({
        id: context.gamePk,
        home_team_id: teams.home.id,
        away_team_id: teams.away.id,
        start_at: new Date('2026-01-01T00:00:00Z')
      })
      .execute()
  })
  afterEach(async () => {
    await fixture?.close()
  })

  const raw = async (): Promise<StoredGame> => ({
    plays: (await readPlays(fixture.db, context.gamePk)).map(
      row => row.gumbo as GumboPlay
    ),
    currentPlay: (
      await fixture.db
        .selectFrom('games')
        .select('currentPlay')
        .where('id', '=', context.gamePk)
        .executeTakeFirstOrThrow()
    ).currentPlay as CurrentPlay | null
  })
  const post = async (stored: StoredGame): Promise<void> => {
    await postGamePlays(
      fixture.db,
      context.gamePk,
      asPostEventsBody(
        structuredClone({
          ...stored,
          mode: 'live',
          source: { system: 'teamstation' }
        })
      )
    )
  }
  const importHistory = async (stored: StoredGame): Promise<void> => {
    await postGamePlays(
      fixture.db,
      context.gamePk,
      asPostEventsBody(
        structuredClone({
          ...stored,
          mode: 'live',
          source: { system: 'external' }
        })
      )
    )
  }
  const withoutActions = (
    stored: StoredGame,
    indexes?: number[]
  ): StoredGame => {
    const copy = structuredClone(stored)
    for (const document of [...copy.plays, copy.currentPlay])
      if (
        document != null &&
        (indexes == null || indexes.includes(document.about.atBatIndex))
      )
        delete document.teamStation
    return copy
  }
  const pitches = async (calls: Array<'B' | 'C'>): Promise<StoredGame> => {
    let stored: StoredGame = { plays: [], currentPlay: null }
    const session = await ScoringSession.open(
      {
        load: async () => stored,
        save: async (_, change) => {
          const plays = new Map(
            stored.plays.map(play => [play.about.atBatIndex, play])
          )
          for (const play of change.plays)
            plays.set(play.about.atBatIndex, play)
          return (stored = {
            plays: [...plays.values()],
            currentPlay:
              change.currentPlay === undefined
                ? stored.currentPlay
                : change.currentPlay
          })
        }
      },
      context.gamePk,
      context,
      options
    )
    for (const call of calls)
      expect(session.apply({ type: 'pitch', call }).problems).deep.equals([])
    await session.flush()
    return stored
  }
  const accountState = async (): Promise<object> => ({
    users: await fixture.db
      .selectFrom('users')
      .selectAll()
      .orderBy('id')
      .execute(),
    memberships: await fixture.db
      .selectFrom('memberships')
      .selectAll()
      .orderBy('id')
      .execute(),
    sessions: await fixture.db
      .selectFrom('auth_sessions')
      .selectAll()
      .orderBy('id')
      .execute(),
    mappings: await fixture.db
      .selectFrom('gumbo_ids')
      .selectAll()
      .orderBy('gumbo_id')
      .execute()
  })
  const refusal = async (work: Promise<unknown>): Promise<HttpError> => {
    const error = await work.then(
      () => null,
      (error: unknown) => error
    )
    expect(error).instanceOf(HttpError)
    if (!(error instanceof HttpError)) throw new Error('Expected a conflict')
    expect(error.code).equals('conflict')
    return error
  }

  it('refuses the five-pitch reproduction atomically and identifies the exact play and occupants', async () => {
    await post(await pitches(['B', 'B', 'B', 'B', 'B']))
    const before = await accountState()
    const stored = await raw()
    const error = await refusal(
      closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
    )
    expect(error.details).deep.equals({
      gameId: context.gamePk,
      atBatIndex: 1,
      inning: 1,
      halfInning: 'top',
      outs: 0,
      participants: [
        { role: 'batter', gumboId: 102, name: 'Lou G' },
        { role: 'first', gumboId: 101, name: 'Babe R' }
      ]
    })
    expect(await accountState()).deep.equals(before)
    expect(await raw()).deep.equals(stored)
  })

  for (const closing of [110, 201])
    it(`refuses opposing-side merges through account ${closing} before changing readable history`, async () => {
      await post(await pitches(['B']))
      if (closing === 201)
        await closeInto(fixture.db, userIdOfGumbo(110), userIdOfGumbo(201))
      const accounts = await accountState()
      const stored = await raw()
      const readable = await resolveScoringGame(fixture.db, stored)
      const error = await refusal(
        closeInto(fixture.db, userIdOfGumbo(closing), userIdOfGumbo(101))
      )
      expect(error.message).includes('opposing teams')
      expect(error.details).deep.includes({
        gameId: context.gamePk,
        atBatIndex: 0,
        inning: 1,
        halfInning: 'top'
      })
      const participants = (
        error.details as {
          participants: Array<{ gumboId: number; teamId: string; name: string }>
        }
      ).participants
      expect(participants.map(person => person.gumboId)).members([101, closing])
      expect(participants.map(person => person.teamId)).members([
        teams.away.id,
        teams.home.id
      ])
      expect(participants.every(person => person.name.length > 0)).equals(true)
      expect(await accountState()).deep.equals(accounts)
      expect(await raw()).deep.equals(stored)
      expect(await resolveScoringGame(fixture.db, await raw())).deep.equals(
        readable
      )
    })

  for (const mode of [
    'imported',
    'completed',
    'current-only',
    'mixed-prefix',
    'mixed-current'
  ] as const)
    it(`refuses unverifiable ${mode} history without mutating accounts or plays`, async () => {
      const calls: Array<'B' | 'C'> = ['B', 'B', 'B', 'B', 'B']
      if (mode === 'completed') calls.push('C', 'C', 'C', 'B')
      const stored = withoutActions(
        await pitches(calls),
        mode === 'mixed-prefix'
          ? [0]
          : mode === 'mixed-current'
            ? [1]
            : undefined
      )
      if (mode === 'completed') stored.currentPlay = null
      if (mode === 'current-only') {
        stored.plays = []
        stored.currentPlay!.runners = [
          {
            details: { runner: { id: 101, fullName: 'Babe R' } },
            movement: { start: '1B', end: '1B', isOut: false }
          }
        ]
      }
      await importHistory(stored)
      const accounts = await accountState()
      const before = await raw()
      const error = await refusal(
        closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
      )
      expect(error.message).includes('scoring actions are unavailable')
      expect(error.details).deep.includes({
        gameId: context.gamePk,
        atBatIndex: mode === 'mixed-current' || mode === 'current-only' ? 1 : 0,
        inning: 1,
        halfInning: 'top'
      })
      expect(await accountState()).deep.equals(accounts)
      expect(await raw()).deep.equals(before)
    })

  it('refuses an opposing-side guest introduced only by a saved action', async () => {
    const stored = await pitches(['B'])
    const record = stored.currentPlay!.teamStation as { actions: unknown[] }
    record.actions.unshift({
      type: 'lineup',
      kind: 'addPlayer',
      side: 'home',
      player: 201,
      name: 'Mike Trout',
      jersey: '20'
    })
    await post(stored)
    const accounts = await accountState()
    const before = await raw()
    const error = await refusal(
      closeInto(fixture.db, userIdOfGumbo(201), userIdOfGumbo(101))
    )
    expect(error.message).includes('cannot be replayed')
    expect(error.details).deep.includes({ gameId: context.gamePk })
    expect(await accountState()).deep.equals(accounts)
    expect(await raw()).deep.equals(before)
    expect(await resolveScoringGame(fixture.db, before)).deep.equals(before)
  })

  it('refuses an imported stale save after a merge while retaining valid single-identity imports', async () => {
    const stale = withoutActions(await pitches(['B', 'B', 'B', 'B', 'B']))
    await closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
    const before = await raw()
    const error = await refusal(importHistory(stale))
    expect(error.message).includes('scoring actions are unavailable')
    expect(await raw()).deep.equals(before)
    const valid = withoutActions(await pitches(['B']))
    await importHistory(valid)
    expect((await raw()).currentPlay).deep.equals(valid.currentPlay)
  })

  it('refuses imported aliases after an earlier merge even when a later play supplies a replay context', async () => {
    const mixed = withoutActions(await pitches(['B', 'B', 'B', 'B', 'B']), [0])
    await closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
    const before = await raw()
    await refusal(importHistory(mixed))
    expect(await raw()).deep.equals(before)
  })

  it('checks earlier aliases and completed history even when the conflict is no longer current', async () => {
    await post(await pitches(['B', 'B', 'B', 'B', 'B', 'C', 'C', 'C', 'B']))
    await closeInto(fixture.db, userIdOfGumbo(101), userIdOfGumbo(201))
    const before = await accountState()
    const error = await refusal(
      closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(201))
    )
    expect(error.message).includes('plate appearance 2')
    expect(await accountState()).deep.equals(before)
  })

  it('allows a nonconflicting merge after the first batter strikes out', async () => {
    await post(await pitches(['C', 'C', 'C', 'B']))
    const before = await raw()
    expect(
      (await closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101)))
        .closed
    ).equals(true)
    const session = await ScoringSession.open(
      {
        load: async () => await resolveScoringGame(fixture.db, await raw()),
        save: async () => {
          throw new Error('Read-only store')
        }
      },
      context.gamePk,
      context,
      options
    )
    expect(session.problem).equals(null)
    expect(session.apply({ type: 'pitch', call: 'C' }).problems).deep.equals([])
    expect(await raw()).deep.equals(before)
  })

  it('identifies two distinct runners on different bases in a later half-inning', async () => {
    await post({
      plays: [],
      currentPlay: {
        about: {
          atBatIndex: 0,
          inning: 3,
          halfInning: 'bottom',
          isComplete: false
        },
        teamStation: {
          version: 2,
          setupBefore: setup,
          actions: [
            {
              type: 'gameFlow',
              kind: 'override',
              inning: 3,
              top: false,
              outs: 1,
              batter: 110,
              pitcher: 101,
              bases: [111, 112, null]
            },
            { type: 'pitch', call: 'B' }
          ]
        }
      }
    })
    const error = await refusal(
      closeInto(fixture.db, userIdOfGumbo(112), userIdOfGumbo(111))
    )
    expect(error.details).deep.includes({
      inning: 3,
      halfInning: 'bottom',
      outs: 1
    })
    expect(
      (
        error.details as { participants: Array<{ role: string }> }
      ).participants.map(person => person.role)
    ).deep.equals(['first', 'second'])
  })

  it('refuses a merge when the affected saved history cannot be verified', async () => {
    const incomplete = structuredClone(setup)
    incomplete.sides.away.battingOrder = []
    const unreadable: CurrentPlay = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top', isComplete: false },
      teamStation: {
        version: 2,
        setupBefore: incomplete,
        actions: [{ type: 'pitch', call: 'B' }]
      }
    }
    await fixture.db
      .updateTable('games')
      .set({ currentPlay: sql`${JSON.stringify(unreadable)}::jsonb` })
      .where('id', '=', context.gamePk)
      .execute()
    const before = await accountState()
    const error = await refusal(
      closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
    )
    expect(error.message).equals(
      `Cannot verify saved scoring history in game ${context.gamePk}`
    )
    expect(await accountState()).deep.equals(before)
  })

  it('refuses stale history that introduces overlapping aliases after a merge', async () => {
    const stale = await pitches(['B', 'B', 'B', 'B', 'B'])
    await post(await pitches(['B']))
    await closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
    const before = await raw()
    await refusal(post(stale))
    expect(await raw()).deep.equals(before)
  })

  it('refuses a newly authored duplicate in the first saved setup', async () => {
    const duplicate = structuredClone(setup)
    duplicate.sides.away.battingOrder[1] = 101
    const before = await raw()
    const error = await refusal(
      post({
        plays: [],
        currentPlay: {
          about: {
            atBatIndex: 0,
            inning: 1,
            halfInning: 'top',
            isComplete: false
          },
          teamStation: {
            version: 2,
            setupBefore: duplicate,
            actions: [{ type: 'pitch', call: 'B' }]
          }
        }
      })
    )
    expect(error.message).includes('duplicate lineup placements')
    expect(await raw()).deep.equals(before)
  })

  for (const version of [1, 2])
    for (const kind of ['batting', 'defense'] as const)
      it(`replays version ${version} historical ${kind} additions but refuses new duplicate placements`, async () => {
        const before = structuredClone(setup)
        if (kind === 'batting')
          before.sides.away.battingOrder =
            before.sides.away.battingOrder.filter(id => id !== 102)
        else before.sides.away.defense.C = null
        const encode = (setup: typeof before): unknown =>
          version === 1
            ? asLegacyGameSetup({
                ...setup,
                identities: {
                  sourceToSession: Object.fromEntries(
                    Object.values(setup.players).map(player => [
                      `number:${player.id}`,
                      player.id
                    ])
                  ),
                  sessionToSource: Object.fromEntries(
                    Object.values(setup.players).map(player => [
                      player.id,
                      player.id
                    ])
                  ),
                  nextId: 119
                },
                players: Object.fromEntries(
                  Object.values(setup.players).map(player => [
                    player.id,
                    { ...player, userId: player.id }
                  ])
                )
              })
            : setup
        const stored: StoredGame = {
          plays: [],
          currentPlay: {
            about: {
              atBatIndex: 0,
              inning: 1,
              halfInning: 'top',
              isComplete: false
            },
            teamStation: {
              version,
              setupBefore: encode(before),
              actions: [
                { type: 'lineup', kind: 'roster', setup: encode(setup) },
                { type: 'pitch', call: 'B' }
              ]
            }
          }
        }
        await post(stored)
        const original = await raw()
        await closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
        const history = await raw()
        expect(history).deep.equals(original)
        const session = await ScoringSession.open(
          {
            load: async () => await resolveScoringGame(fixture.db, await raw()),
            save: async (_, change) => {
              await postGamePlays(
                fixture.db,
                context.gamePk,
                asPostEventsBody({
                  ...change,
                  mode: 'live',
                  source: { system: 'teamstation' }
                })
              )
              return await resolveScoringGame(fixture.db, await raw())
            }
          },
          context.gamePk,
          context,
          options
        )
        expect(session.problem).equals(null)
        expect(
          session.apply({ type: 'pitch', call: 'C' }).problems
        ).deep.equals([])
        await session.flush()
        expect(session.problem).equals(null)
        const reopened = await ScoringSession.open(
          {
            load: async () => await resolveScoringGame(fixture.db, await raw()),
            save: async () => {
              throw new Error('Read-only store')
            }
          },
          context.gamePk,
          context,
          options
        )
        expect(reopened.problem).equals(null)
        expect(reopened.state.liveData.linescore.strikes).equals(1)
        const extra = structuredClone(setup)
        extra.sides.away.battingOrder = [
          101, 101, 101, 104, 105, 106, 107, 108, 109
        ]
        expect(
          session.apply({ type: 'lineup', kind: 'roster', setup: extra })
            .problems
        ).not.deep.equals([])
        const invalid = await resolveScoringGame(fixture.db, await raw())
        const record = invalid.currentPlay!.teamStation as {
          actions: unknown[]
        }
        record.actions.push({ type: 'lineup', kind: 'roster', setup: extra })
        await refusal(post(invalid))
      })

  for (const first of ['save', 'merge'] as const)
    it(`serializes ${first} before the other transaction and refuses the conflicting second operation`, async () => {
      await post(await pitches(['B']))
      const stale = await pitches(['B', 'B', 'B', 'B', 'B'])
      let held!: () => void
      let release!: () => void
      const ready = new Promise<void>(resolve => {
        held = resolve
      })
      const released = new Promise<void>(resolve => {
        release = resolve
      })
      const one = fixture.db.transaction().execute(async trx => {
        if (first === 'save')
          await postGamePlays(
            trx,
            context.gamePk,
            asPostEventsBody({
              ...stale,
              mode: 'live',
              source: { system: 'teamstation' }
            })
          )
        else await closeInto(trx, userIdOfGumbo(102), userIdOfGumbo(101))
        held()
        await released
      })
      await ready
      const two = (
        first === 'save'
          ? closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
          : post(stale)
      ).then(
        () => null,
        (error: unknown) => error
      )
      try {
        let waiting = false
        for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
          const result = await sql<{
            waiting: boolean
          }>`select exists(select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())) as waiting`.execute(
            fixture.db
          )
          waiting = result.rows[0].waiting
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(waiting).equals(true)
      } finally {
        release()
      }
      await one
      expect(await two).instanceOf(HttpError)
    })
})
