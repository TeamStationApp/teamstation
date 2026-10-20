import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import type { ScoringAction } from '../../common/scoring/actions'
import { newSetup } from '../../common/scoring/lineup'
import { ScoringSession, type StoredGame } from '../../common/scoring/session'
import { asLegacyGameSetup } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { closeInto } from '../admin/people'
import type { Database } from '../db/database'
import { addPlayEvents } from '../events/playEventTimes'
import { postGamePlays, readPlays } from '../events/postPlays'
import { createGuestPlayer } from '../games/guestPlayers'
import { setRostered } from '../games/unroster'
import { startingContext } from '../routes/lineups'
import { resolveScoringGame, scoringIdsIn } from './openRow'

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
    await fixture.db
      .updateTable('users')
      .set({
        is_admin: true,
        login_enabled: true
      })
      .where('id', '=', userIdOfGumbo(118))
      .execute()
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
  const pitches = async (
    calls: Array<'B' | 'C'>,
    ending: ScoringAction[] = []
  ): Promise<StoredGame> => {
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
    for (const action of ending)
      expect(session.apply(action).problems).deep.equals([])
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

  for (const close of [false, true])
    it(`refuses a walk with the next batter on base (${close ? 'explicitly closed' : 'waiting to close'})`, async () => {
      await post(
        await pitches(
          ['B', 'B', 'B', 'B'],
          close ? [{ type: 'gameFlow', kind: 'closePlay' }] : []
        )
      )
      const accounts = await accountState()
      const stored = await raw()
      const error = await refusal(
        closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
      )
      expect(error.details).deep.includes({
        gameId: context.gamePk,
        atBatIndex: 1,
        inning: 1,
        halfInning: 'top',
        outs: 0
      })
      expect(
        (error.details as { participants: unknown }).participants
      ).deep.equals([
        { role: 'batter', gumboId: 102, name: 'Lou G' },
        { role: 'first', gumboId: 101, name: 'Babe R' }
      ])
      expect(await accountState()).deep.equals(accounts)
      expect(await raw()).deep.equals(stored)
    })

  it('refuses a stale terminal walk after a merge without changing saved plays', async () => {
    const stale = await pitches(['B', 'B', 'B', 'B'])
    await post(await pitches(['B']))
    await closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
    const before = await raw()
    const error = await refusal(post(stale))
    expect(error.details).deep.includes({ atBatIndex: 1 })
    expect(await raw()).deep.equals(before)
  })

  for (const ending of [
    'pending',
    'closePlay',
    'endHalf',
    'strikeout',
    'runners'
  ] as const)
    it(`validates mixed historical/canonical partial saves ending with ${ending}`, async () => {
      await post(await pitches(['C', 'C', 'C', 'B']))
      await closeInto(fixture.db, userIdOfGumbo(101), userIdOfGumbo(201))
      let memory = await resolveScoringGame(fixture.db, await raw())
      const offline = await ScoringSession.open(
        {
          load: async () => memory,
          save: async (_, change) => {
            const plays = new Map(
              memory.plays.map(play => [play.about.atBatIndex, play])
            )
            for (const play of change.plays)
              plays.set(play.about.atBatIndex, play)
            return (memory = {
              plays: [...plays.values()],
              currentPlay:
                change.currentPlay === undefined
                  ? memory.currentPlay
                  : change.currentPlay
            })
          }
        },
        context.gamePk,
        context,
        options
      )
      expect(
        offline.apply({
          type: 'lineup',
          kind: 'position',
          side: 'away',
          player: 201,
          position: 'C'
        }).problems
      ).deep.equals([])
      // Moving the old pitcher to catcher also needs a new pitcher before
      // this team fields the next half.
      expect(
        offline.apply({
          type: 'lineup',
          kind: 'position',
          side: 'away',
          player: 104,
          position: 'P'
        }).problems
      ).deep.equals([])
      if (ending === 'runners')
        expect(
          offline.apply({
            type: 'gameFlow',
            kind: 'override',
            batter: 104,
            pitcher: 110,
            bases: [102, 103, null],
            outs: 1
          }).problems
        ).deep.equals([])
      else
        for (let i = 0; i < 3; i++)
          expect(
            offline.apply({
              type: 'pitch',
              call: ending === 'strikeout' ? 'C' : 'B'
            }).problems
          ).deep.equals([])
      if (ending === 'closePlay' || ending === 'endHalf')
        expect(
          offline.apply({ type: 'gameFlow', kind: ending }).problems
        ).deep.equals([])
      await offline.flush()
      await closeInto(fixture.db, userIdOfGumbo(103), userIdOfGumbo(102))
      const before = await raw()
      const accounts = await accountState()
      const write = postGamePlays(
        fixture.db,
        context.gamePk,
        asPostEventsBody({
          ...memory,
          // Real partial save: retain the first play's older IDs in the database.
          plays: memory.plays.filter(play => play.about.atBatIndex !== 0),
          mode: 'live',
          source: { system: 'teamstation' }
        })
      )
      if (
        ending === 'pending' ||
        ending === 'closePlay' ||
        ending === 'runners'
      ) {
        const error = await refusal(write)
        if (ending === 'runners') {
          // The engine itself refuses a projected override with duplicate bases.
          expect(error.message).equals(
            `Cannot verify saved scoring history in game ${context.gamePk}`
          )
        } else {
          expect(error.details).deep.includes({
            gameId: context.gamePk,
            atBatIndex: 2,
            inning: 1,
            halfInning: 'top',
            outs: 1
          })
          expect((error.details as { gumboIds: number[] }).gumboIds).members([
            102, 103
          ])
        }
        expect(await raw()).deep.equals(before)
        expect(await accountState()).deep.equals(accounts)
      } else {
        await write
        expect((await raw()).plays[0]).deep.equals(before.plays[0])
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
        expect(
          reopened.apply({ type: 'pitch', call: 'B' }).problems
        ).deep.equals([])
      }
    })

  for (const ending of ['endHalf', 'endGame'] as const)
    it(`does not advance a terminal walk past ${ending}`, async () => {
      await post(
        await pitches(
          ['B', 'B', 'B', 'B'],
          [{ type: 'gameFlow', kind: ending }]
        )
      )
      const stored = await raw()
      if (ending === 'endGame') {
        // The final saved marker retains the next batter/base overlap.
        await refusal(
          closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
        )
      } else {
        await closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
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
        expect(session.state.liveData.linescore.isTopInning).equals(false)
        expect(
          session.apply({ type: 'pitch', call: 'B' }).problems
        ).deep.equals([])
      }
      expect(await raw()).deep.equals(stored)
    })

  const actor = { userId: userIdOfGumbo(118), isAdmin: true, scopes: [] }
  const member = async (id: number, side: 'away' | 'home'): Promise<void> => {
    await fixture.db
      .insertInto('memberships')
      .values({
        id: `mem_${side}_${id}`,
        user_id: userIdOfGumbo(id),
        team_id: teams[side].id,
        role: 'member',
        is_player: true
      })
      .execute()
  }
  const guest = async (side: 'away' | 'home'): Promise<string> =>
    (
      await createGuestPlayer(fixture.db, actor, context.gamePk, side, {
        firstName: 'Mike',
        lastName: 'Trout',
        jersey: '',
        positions: [],
        bats: null,
        throws: null
      })
    ).userId
  const available = async (): ReturnType<typeof startingContext> =>
    await startingContext(
      fixture.db,
      context.gamePk,
      {
        home_team_id: teams.home.id,
        away_team_id: teams.away.id
      },
      () => true
    )

  for (const mode of ['guests', 'members', 'member-guest'] as const)
    for (const alias of [false, true])
      it(`refuses opposing pregame ${mode} with ${alias ? 'earlier aliases' : 'direct identities'}`, async () => {
        let away = userIdOfGumbo(101)
        let home = userIdOfGumbo(102)
        if (mode === 'guests') away = await guest('away')
        else await member(101, 'away')
        if (mode === 'members') await member(102, 'home')
        else home = await guest('home')
        if (alias) {
          await closeInto(fixture.db, home, userIdOfGumbo(201))
          home = userIdOfGumbo(201)
        }
        const before = await available()
        const accounts = await accountState()
        const game = await fixture.db.selectFrom('games').selectAll().execute()
        const error = await refusal(closeInto(fixture.db, home, away))
        expect(error.message).includes('opposing teams')
        expect(error.details).deep.includes({ gameId: context.gamePk })
        expect(await accountState()).deep.equals(accounts)
        expect(
          await fixture.db.selectFrom('games').selectAll().execute()
        ).deep.equals(game)
        expect(await available()).deep.equals(before)
      })

  for (const mode of ['members', 'member-guest'] as const)
    it(`preserves an earlier-alias exclusion when merging opposing ${mode}`, async () => {
      await member(101, 'away')
      let home = userIdOfGumbo(102)
      if (mode === 'members') await member(102, 'home')
      else home = await guest('home')
      await setRostered(fixture.db, actor, context.gamePk, {
        side: 'away',
        userId: userIdOfGumbo(101),
        rostered: false
      })
      await closeInto(fixture.db, userIdOfGumbo(101), userIdOfGumbo(201))
      await closeInto(fixture.db, home, userIdOfGumbo(201))
      const actual = await available()
      expect(actual.setup.sides.away.players).deep.equals([])
      expect(actual.setup.sides.home.players).deep.equals([201])
    })

  it('keeps a guest merged into an excluded same-side member unavailable', async () => {
    await member(101, 'away')
    const added = await guest('away')
    await setRostered(fixture.db, actor, context.gamePk, {
      side: 'away',
      userId: userIdOfGumbo(101),
      rostered: false
    })
    await closeInto(fixture.db, added, userIdOfGumbo(101))
    expect((await available()).setup.sides.away.players).deep.equals([])
  })

  const importedPitch = (base?: 'first' | 'second' | 'third'): unknown => ({
    type: 'pitch',
    isPitch: true,
    startTime: '2026-01-01T00:00:00Z',
    details: {
      call: { code: 'B', description: 'Ball' },
      code: 'B',
      isInPlay: false,
      isStrike: false,
      isBall: true,
      isOut: false,
      hasReview: false
    },
    count: { balls: 1, strikes: 0, outs: 0 },
    ...(base == null
      ? { pitcher: { id: 102 } }
      : { offense: { [base]: { id: 102, fullName: 'Lou G' } } })
  })
  const imported = (events: unknown[] = []): StoredGame =>
    asPostEventsBody({
      mode: 'live',
      plays: [
        {
          about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
          result: { eventType: 'single', awayScore: 0, homeScore: 0 },
          matchup: { batter: { id: 101 }, pitcher: { id: 110 } },
          playEvents: events
        }
      ],
      currentPlay: null
    }) as StoredGame
  for (const base of ['first', 'second', 'third'] as const)
    it(`checks imported ${base} occupants during merges, reads and stale saves`, async () => {
      const document = imported([importedPitch(base)])
      expect(scoringIdsIn(document)).members([101, 102, 110])
      await importHistory(document)
      const before = await accountState()
      const stored = await raw()
      await refusal(
        closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
      )
      expect(await accountState()).deep.equals(before)
      expect(await raw()).deep.equals(stored)
      await closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(201))
      const projected = await resolveScoringGame(fixture.db, stored)
      const expected = structuredClone(stored)
      const offense = (
        expected.plays[0].playEvents as Array<{
          offense: Record<string, { id: number }>
        }>
      )[0].offense
      offense[base].id = 201
      expect(projected).deep.equals(expected)
      await refusal(
        importHistory(
          imported([
            importedPitch(base),
            { ...(importedPitch(base) as object), pitcher: { id: 201 } }
          ])
        )
      )
      expect(await raw()).deep.equals(stored)
    })

  const patch = async (): Promise<unknown> =>
    await addPlayEvents(fixture.db, context.gamePk, {
      plays: [{ atBatIndex: 0, playEvents: [importedPitch()] }]
    })
  it('refuses an unsafe administrator patch atomically and still allows safe event updates', async () => {
    await importHistory(imported())
    await closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
    const before = await raw()
    const game = await fixture.db.selectFrom('games').selectAll().execute()
    await refusal(patch())
    expect(await raw()).deep.equals(before)
    expect(
      await fixture.db.selectFrom('games').selectAll().execute()
    ).deep.equals(game)
    expect(
      await addPlayEvents(fixture.db, context.gamePk, {
        plays: [
          {
            atBatIndex: 0,
            playEvents: [
              { ...(importedPitch() as object), pitcher: { id: 110 } }
            ]
          }
        ]
      })
    ).deep.equals({ plays: 1, events: 1 })
  })

  it('checks untouched plays and current history before any administrator patch update', async () => {
    const stored = imported()
    stored.plays.push({
      ...structuredClone(stored.plays[0]),
      about: { ...stored.plays[0].about, atBatIndex: 1 },
      matchup: { batter: { id: 103 } }
    })
    await importHistory(stored)
    await closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
    const before = await raw()
    await refusal(
      addPlayEvents(fixture.db, context.gamePk, {
        plays: [
          { atBatIndex: 0, playEvents: [] },
          { atBatIndex: 1, playEvents: [importedPitch()] }
        ]
      })
    )
    expect(await raw()).deep.equals(before)
    // The first play need not be in the PATCH to participate in its check.
    await refusal(
      addPlayEvents(fixture.db, context.gamePk, {
        plays: [{ atBatIndex: 1, playEvents: [importedPitch()] }]
      })
    )
    expect(await raw()).deep.equals(before)
    // An alias in the live at-bat participates even when no completed play
    // contains it and the patch updates a different completed play.
    const current = imported()
    current.currentPlay = {
      ...current.plays[0],
      about: { ...current.plays[0].about, isComplete: false }
    }
    current.plays = [stored.plays[1]]
    await postGamePlays(
      fixture.db,
      context.gamePk,
      asPostEventsBody({
        ...current,
        mode: 'live',
        remove: [0],
        source: { system: 'external' }
      })
    )
    const withCurrent = await raw()
    await refusal(
      addPlayEvents(fixture.db, context.gamePk, {
        plays: [{ atBatIndex: 1, playEvents: [importedPitch()] }]
      })
    )
    expect(await raw()).deep.equals(withCurrent)
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

  for (const writer of ['save', 'patch', 'availability'] as const)
    for (const first of ['write', 'merge'] as const)
      it(`serializes ${first} before the other ${writer} transaction and refuses the conflicting second operation`, async () => {
        if (writer === 'save') await post(await pitches(['B']))
        else if (writer === 'patch') await importHistory(imported())
        else {
          await member(101, 'away')
          await member(102, 'home')
          await setRostered(fixture.db, actor, context.gamePk, {
            side: 'away',
            userId: userIdOfGumbo(101),
            rostered: false
          })
        }
        const stale = await pitches(['B', 'B', 'B', 'B', 'B'])
        const write = async (db: Kysely<Database>): Promise<unknown> => {
          if (writer === 'patch')
            return await addPlayEvents(db, context.gamePk, {
              plays: [{ atBatIndex: 0, playEvents: [importedPitch()] }]
            })
          if (writer === 'availability')
            return await setRostered(db, actor, context.gamePk, {
              side: 'away',
              userId: userIdOfGumbo(101),
              rostered: true
            })
          return await postGamePlays(
            db,
            context.gamePk,
            asPostEventsBody({
              ...stale,
              mode: 'live',
              source: { system: 'teamstation' }
            })
          )
        }
        let held!: () => void
        let release!: () => void
        const ready = new Promise<void>(resolve => {
          held = resolve
        })
        const released = new Promise<void>(resolve => {
          release = resolve
        })
        const one = fixture.db.transaction().execute(async trx => {
          if (first === 'write') await write(trx)
          else await closeInto(trx, userIdOfGumbo(102), userIdOfGumbo(101))
          held()
          await released
        })
        await ready
        const two = (
          first === 'write'
            ? closeInto(fixture.db, userIdOfGumbo(102), userIdOfGumbo(101))
            : write(fixture.db)
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
        const error = await two
        expect(error).instanceOf(HttpError)
        expect((error as HttpError).code).equals('conflict')
        if (writer === 'availability') {
          const setup = (await available()).setup
          expect(setup.sides.away.players).deep.equals(
            first === 'merge' ? [] : [101]
          )
          expect(setup.sides.home.players).deep.equals(
            first === 'merge' ? [101] : [102]
          )
        }
      })
})
