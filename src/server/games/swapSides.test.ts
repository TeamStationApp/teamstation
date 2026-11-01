import { expect } from 'chai'
import { type Kysely, type Selectable, sql } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { storedGuests } from '../../common/guests'
import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { asNewRosterPlayer } from '../../common/playerSettings'
import type { ScoringAction } from '../../common/scoring/actions'
import { recordOf, storedRecordOf } from '../../common/scoring/gumbo'
import { reconcileRoster } from '../../common/scoring/rosterAvailability'
import {
  type EventStore,
  ScoringSession,
  type SessionContext
} from '../../common/scoring/session'
import { type GameSetup, setupOf } from '../../common/scoring/state'
import { recordBySide } from '../../common/scoring/teamRecord'
import { teamsOfRow } from '../../common/teamLists'
import { storedUnrostered } from '../../common/unroster'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { game as fixture, TEAMS } from '../../test/scoringGames'
import { lockPlayerEdits, MERGE_LOCK } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import { type Database, makeDatabase } from '../db/database'
import { atBatOf } from '../events/atBatInProgress'
import { postGamePlays, readPlays } from '../events/postPlays'
import { lineupsAnswer, storedLineupsDigest } from '../events/teamLineups'
import { GAME_CHANGES_CHANNEL } from '../socket/gameChanges'
import { SCREEN_SCOPES_CHANNEL } from '../socket/syncRevision'
import { createGuestPlayer } from './guestPlayers'
import { retargetGameTeams } from './retargetTeams'
import { gameAvailability } from './rosterAvailability'
import { SWAP_REFUSED, swapGameSides } from './swapSides'
import { setRostered } from './unroster'

const coach = (id: number): Actor => ({
  userId: userIdOfGumbo(id),
  isAdmin: false,
  scopes: []
})
const AWAY_COACH = coach(123)
const HOME_COACH = coach(128)
const exchanged = (setup: GameSetup): GameSetup => ({
  ...setup,
  sides: { home: setup.sides.away, away: setup.sides.home }
})

describe('swapping a game’s home and away teams', function () {
  this.timeout(60000)
  const name = `teamstation_side_swap_${process.pid}_${Date.now()}`
  let admin: Pool
  let db: Kysely<Database>
  let listener: Client
  let heard: Array<{ channel: string; payload: Record<string, unknown> }> = []

  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    const pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(url)
    await insertFixtureUsers(
      db,
      [...Array.from({ length: 20 }, (_, i) => i + 1), 123, 128].map(id => ({
        id,
        legacyId: makeId('user'),
        display_name: 'Hank Aaron'
      }))
    )
    await db
      .insertInto('teams')
      .values([
        { id: TEAMS.away.id, name: TEAMS.away.name },
        { id: TEAMS.home.id, name: TEAMS.home.name }
      ])
      .execute()
    // Nine starters a side, as the fixture's lineups, and one more on each
    // bench: 19 with the visitors and 20 with the hosts.
    await db
      .insertInto('memberships')
      .values(
        Array.from({ length: 20 }, (_, i) => ({
          id: makeId('membership'),
          user_id: userIdOfGumbo(i + 1),
          team_id: i < 9 || i === 18 ? TEAMS.away.id : TEAMS.home.id,
          role: 'member' as const,
          is_player: true,
          jersey: String(i + 1)
        }))
      )
      .execute()
    await db
      .insertInto('scope_roles')
      .values([
        {
          id: makeId('scopeRole'),
          user_id: AWAY_COACH.userId,
          scope_type: 'team' as const,
          scope_id: TEAMS.away.id,
          role: 'coach' as const
        },
        {
          id: makeId('scopeRole'),
          user_id: HOME_COACH.userId,
          scope_type: 'team' as const,
          scope_id: TEAMS.home.id,
          role: 'coach' as const
        }
      ])
      .execute()
    listener = new Client({ connectionString: url })
    await listener.connect()
    listener.on('notification', message => {
      if (message.payload != null)
        heard.push({
          channel: message.channel,
          payload: JSON.parse(message.payload) as Record<string, unknown>
        })
    })
    await listener.query(`listen ${GAME_CHANGES_CHANNEL}`)
    await listener.query(`listen ${SCREEN_SCOPES_CHANNEL}`)
  })
  after(async () => {
    await listener?.end()
    await db?.destroy()
    await admin.query(`drop database if exists ${name}`)
    await admin.end()
  })
  beforeEach(() => {
    heard = []
  })

  const guestsOf = async (
    id: string
  ): Promise<{ away: number[]; home: number[] }> => {
    const game = await row(id)
    return storedGuests(game.guests, teamsOfRow(game))
  }
  const row = async (id: string): Promise<Selectable<Database['games']>> =>
    await db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const newGame = async (id: string): Promise<void> => {
    await db
      .insertInto('games')
      .values({
        id,
        home_team_id: TEAMS.home.id,
        away_team_id: TEAMS.away.id,
        start_at: new Date()
      })
      .execute()
  }
  /** The game as the server stores it, read as the scoring screen reads it. */
  const store = (id: string): EventStore => ({
    load: async () => {
      const game = await row(id)
      const plays = await readPlays(db, id)
      return {
        plays: plays.map(play => play.gumbo as GumboPlay),
        currentPlay: atBatOf(game, plays.length > 0) as CurrentPlay | null,
        lineupsDigest: await storedLineupsDigest(db, game)
      }
    },
    save: async (_id, change) => {
      const posted = await postGamePlays(
        db,
        id,
        asPostEventsBody({
          ...change,
          mode: 'live',
          source: { system: 'teamstation' }
        })
      )
      return {
        plays: posted.plays.map(play => play.gumbo as GumboPlay),
        currentPlay: posted.currentPlay as CurrentPlay | null,
        lineupsDigest: posted.lineupsDigest ?? undefined
      }
    }
  })
  const contextFor = (id: string, swapped = false): SessionContext => ({
    gamePk: id,
    teams: swapped ? { home: TEAMS.away, away: TEAMS.home } : TEAMS,
    setup: swapped ? exchanged(setupOf(fixture())) : setupOf(fixture())
  })
  const open = async (id: string, swapped = false): Promise<ScoringSession> =>
    await ScoringSession.open(store(id), id, contextFor(id, swapped), {
      setTimer: () => null,
      clearTimer: () => undefined
    })
  /** A scorer's device: opens the game, applies the actions, saves them. */
  const score = async (
    id: string,
    actions: (session: ScoringSession) => ScoringAction[]
  ): Promise<ScoringSession> => {
    const session = await open(id)
    for (const action of actions(session))
      expect(
        session.apply(action).problems,
        JSON.stringify(action)
      ).deep.equals([])
    await session.flush()
    expect(session.problem).equals(null)
    return session
  }
  /** Three roster saves: as loaded, the leadoffs exchanged, and back. */
  const threeSaves = (session: ScoringSession): ScoringAction[] => {
    const setup = setupOf(session.state)
    const [first, second, ...rest] = setup.sides.away.battingOrder
    const leadoffs = structuredClone(setup)
    leadoffs.sides.away.battingOrder = [second, first, ...rest]
    return [setup, leadoffs, setup].map(setup => ({
      type: 'lineup',
      kind: 'roster',
      setup,
      confirmed: ['away', 'home']
    }))
  }
  /** A game as tonight's was: lineups saved, a home guest, an away absence. */
  const prepared = async (id: string): Promise<void> => {
    await newGame(id)
    await score(id, threeSaves)
    await createGuestPlayer(
      db,
      HOME_COACH,
      id,
      'home',
      asNewRosterPlayer({
        firstName: 'Gus',
        lastName: 'Guest',
        jersey: '77',
        positions: ['LF'],
        bats: 'left',
        throws: 'right'
      })
    )
    await setRostered(db, AWAY_COACH, id, {
      side: 'away',
      userId: userIdOfGumbo(19),
      rostered: false
    })
  }
  const swap = async (id: string): Promise<void> => {
    await atomic(db, async trx => {
      await lockPlayerEdits(trx)
      await swapGameSides(trx, id)
    })
  }
  const failure = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run()
    } catch (error) {
      return error
    }
    return expect.fail('it was not refused')
  }
  const refused = async (id: string): Promise<void> => {
    const before = await row(id)
    const error = await failure(async () => {
      await swap(id)
    })
    expect(error).property('code', 'conflict')
    expect(error).property('message', SWAP_REFUSED)
    expect(await row(id)).deep.equals(before)
  }
  /** Lets the listener hear what a commit announced. */
  const settle = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  /**
   * Hears out what the commits so far announced, then forgets it. The queue
   * keeps commit order, so a notice sent now arrives after all of those, however
   * late a busy machine delivers them.
   */
  const forgetHeard = async (): Promise<void> => {
    const mark = makeId('game')
    await sql`select pg_notify(${GAME_CHANGES_CHANNEL}, ${JSON.stringify({ mark })})`.execute(
      db
    )
    while (!heard.some(({ payload }) => payload.mark === mark))
      await new Promise(resolve => setTimeout(resolve, 5))
    heard = []
  }
  const notices = (id: string, kind: string): number =>
    heard.filter(
      ({ channel, payload }) =>
        channel === GAME_CHANGES_CHANNEL &&
        payload.game === id &&
        payload.kind === kind
    ).length
  const staleRoster = async (id: string, base: string): Promise<unknown> =>
    await failure(
      async () =>
        await postGamePlays(
          db,
          id,
          asPostEventsBody({
            mode: 'live',
            source: { system: 'teamstation' },
            lineupsBase: base,
            plays: [],
            currentPlay: atBatOf(await row(id), false) as CurrentPlay
          })
        )
    )

  it('swaps the teams and scores of a game nobody has opened, and tells both teams', async function () {
    await newGame('gam_plain')
    await db
      .updateTable('games')
      .set({ home_score: 1, away_score: 2 })
      .where('id', '=', 'gam_plain')
      .execute()
    await swap('gam_plain')
    const game = await row('gam_plain')
    expect([game.home_team_id, game.away_team_id]).deep.equals([
      TEAMS.away.id,
      TEAMS.home.id
    ])
    expect([game.home_score, game.away_score]).deep.equals([2, 1])
    expect(game.currentPlay).equals(null)
    await settle()
    expect(notices('gam_plain', 'game')).equals(1)
    const told = heard
      .filter(({ channel }) => channel === SCREEN_SCOPES_CHANNEL)
      .map(({ payload }) => payload.teamId)
    expect(told).include.members([TEAMS.away.id, TEAMS.home.id])
  })

  it('carries saved lineups, guests and absences to their teams’ new sides', async function () {
    await prepared('gam_saved')
    const before = await row('gam_saved')
    const guest = storedGuests(before.guests, teamsOfRow(before)).home[0]
    expect(guest).a('number')
    expect(storedUnrostered(before.unrostered, teamsOfRow(before))).deep.equals(
      {
        away: [19],
        home: []
      }
    )
    await swap('gam_saved')
    const game = await row('gam_saved')
    // Stored by team, the lists are what they were; by side they moved.
    expect(game.guests).deep.equals(before.guests)
    expect(game.unrostered).deep.equals(before.unrostered)
    expect(storedGuests(game.guests, teamsOfRow(game))).deep.equals({
      away: [guest],
      home: []
    })
    expect(storedUnrostered(game.unrostered, teamsOfRow(game))).deep.equals({
      away: [],
      home: [19]
    })

    const lineups = await lineupsAnswer(db, game)
    expect(lineups.home.teamId).equals(TEAMS.away.id)
    expect(lineups.away.teamId).equals(TEAMS.home.id)
    expect(
      lineups.home.current!.batters.map(batter => batter.gumboId)
    ).deep.equals([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(
      lineups.away.current!.batters.map(batter => batter.gumboId)
    ).deep.equals([10, 11, 12, 13, 14, 15, 16, 17, 18])

    // No at-bat is stored before the first pitch: the lineups are the
    // pregame record, and the hosts, now away, bat first against the
    // visitors' pitcher.
    expect(game.currentPlay).equals(null)
    expect(game.pregame).not.equals(null)
    const setup = recordOf(atBatOf(game, false), {
      away: { id: game.away_team_id },
      home: { id: game.home_team_id }
    })!.setupBefore
    const reopened = await open('gam_saved', true)
    expect(reopened.state.liveData.linescore.offense.batter?.id).equals(10)
    expect(reopened.state.liveData.boxscore.teams.home.defense.P).equals(
      setup.sides.home.defense.P
    )
    expect(setup.sides.home.players).include(1)
  })

  it('refuses a guest a device still adds to its team’s old side', async function () {
    await prepared('gam_guest_after')
    await swap('gam_guest_after')
    const guest = asNewRosterPlayer({
      firstName: 'Late',
      lastName: 'Guest',
      jersey: '88',
      positions: [],
      bats: 'right',
      throws: 'right'
    })
    // The hosts' coach, still showing them at home.
    const stale = await failure(
      async () =>
        await createGuestPlayer(
          db,
          HOME_COACH,
          'gam_guest_after',
          'home',
          guest,
          TEAMS.home.id
        )
    )
    expect(stale).property('code', 'conflict')
    expect(stale).property(
      'message',
      "This game's teams changed. Open it again."
    )
    expect(await guestsOf('gam_guest_after'))
      .property('home')
      .deep.equals([])
    // Read again, his team is away.
    const added = await createGuestPlayer(
      db,
      HOME_COACH,
      'gam_guest_after',
      'away',
      guest,
      TEAMS.home.id
    )
    expect(await guestsOf('gam_guest_after'))
      .property('away')
      .includes(added.gumboId)
  })

  it('keeps a game readable when one of its teams is replaced by another', async function () {
    await newGame('gam_retarget')
    await score('gam_retarget', session => [
      ...threeSaves(session),
      { type: 'result', eventType: 'intent_walk' },
      { type: 'gameFlow', kind: 'closePlay' },
      { type: 'pitch', call: 'B' }
    ])
    const replacement = makeId('team')
    await db
      .insertInto('teams')
      .values({ id: replacement, name: 'Replacement' })
      .execute()
    await db
      .updateTable('games')
      .set({
        guests: { [TEAMS.home.id]: [7], [TEAMS.away.id]: [] },
        unrostered: { [TEAMS.home.id]: [3], [TEAMS.away.id]: [] }
      })
      .where('id', '=', 'gam_retarget')
      .execute()
    await atomic(db, async trx => {
      await trx
        .updateTable('games')
        .set({ home_team_id: replacement })
        .where('id', '=', 'gam_retarget')
        .execute()
      await retargetGameTeams(trx, ['gam_retarget'], TEAMS.home.id, replacement)
    })
    const game = await row('gam_retarget')
    const plays = await readPlays(db, 'gam_retarget')
    const stored = JSON.stringify([
      game.currentPlay,
      ...plays.map(p => p.gumbo)
    ])
    expect(stored).not.includes(`"${TEAMS.home.id}"`)
    expect(stored).includes(`"${replacement}"`)
    const teams = {
      away: { id: TEAMS.away.id },
      home: { id: replacement }
    }
    expect(recordOf(game.currentPlay, teams)).not.equals(null)
    expect(game.guests).deep.equals({
      [replacement]: [7],
      [TEAMS.away.id]: []
    })
    expect(game.unrostered).deep.equals({
      [replacement]: [3],
      [TEAMS.away.id]: []
    })
    expect(
      recordOf(plays[0].gumbo, teams)!.setupBefore.sides.home.battingOrder
    ).length(9)
    // A game that names neither team is left as it was.
    await retargetGameTeams(db, ['gam_retarget'], 'tem_absent', 'tem_other')
    expect(JSON.stringify((await row('gam_retarget')).currentPlay)).equals(
      JSON.stringify(game.currentPlay)
    )
    await retargetGameTeams(db, [], TEAMS.away.id, replacement)
  })

  it('swaps a game whose pregame is still stored by side, each team keeping its lineup (P9)', async function () {
    await prepared('gam_side_pregame')
    const before = await row('gam_side_pregame')
    const teams = teamsOfRow(before)
    // As an older write left it: version 2, by side.
    await db
      .updateTable('games')
      .set({ pregame: recordBySide(before.pregame, teams) as never })
      .where('id', '=', 'gam_side_pregame')
      .execute()
    const was = await lineupsAnswer(db, await row('gam_side_pregame'))
    await swap('gam_side_pregame')
    const game = await row('gam_side_pregame')
    expect(game.pregame).deep.include({ version: 3 })
    // Written through the cleaners, and stored naming nobody.
    expect(JSON.stringify(game.pregame)).not.include('"fullName"')
    const now = await lineupsAnswer(db, game)
    expect(now.home.teamId).equals(was.away.teamId)
    expect(now.home.current).deep.equals(was.away.current)
    expect(now.away.current).deep.equals(was.home.current)
  })

  it('leaves a record that replays on the new teams and their rosters', async function () {
    await prepared('gam_replays')
    await swap('gam_replays')
    const session = await open('gam_replays', true)
    expect(session.problem).equals(null)
    const game = await row('gam_replays')
    const availability = await gameAvailability(db, game)
    const setup = reconcileRoster(
      setupOf(session.state),
      contextFor('gam_replays', true).teams,
      availability.roster,
      availability.guestPlayers,
      availability.unrostered
    )
    expect(setup.sides.home.battingOrder).length(9)
    expect(setup.sides.away.battingOrder).length(9)
    expect(setup.sides.home.battingOrder).deep.equals([
      1, 2, 3, 4, 5, 6, 7, 8, 9
    ])
  })

  it('changes the lineups digest and announces the plays, game and lineups, so a stale device is refused', async function () {
    await prepared('gam_digest')
    const base = await storedLineupsDigest(db, await row('gam_digest'))
    heard = []
    await swap('gam_digest')
    expect(await storedLineupsDigest(db, await row('gam_digest'))).not.equals(
      base
    )
    await settle()
    for (const kind of ['plays', 'game', 'lineups'])
      expect(notices('gam_digest', kind), kind).above(0)
    const stale = await staleRoster('gam_digest', base)
    expect(stale).property('code', 'conflict')
    expect(stale).nested.property('details.stale', true)
  })

  it('stores lists an older write left keyed by side under their teams as it swaps', async function () {
    await newGame('gam_sideLists')
    await db
      .updateTable('games')
      .set({
        guests: { away: [], home: [7] },
        unrostered: { away: [19], home: [] }
      })
      .where('id', '=', 'gam_sideLists')
      .execute()
    await swap('gam_sideLists')
    const game = await row('gam_sideLists')
    expect(game.guests).deep.equals({
      [TEAMS.away.id]: [],
      [TEAMS.home.id]: [7]
    })
    expect(game.unrostered).deep.equals({
      [TEAMS.away.id]: [19],
      [TEAMS.home.id]: []
    })
    expect(storedUnrostered(game.unrostered, teamsOfRow(game))).deep.equals({
      away: [],
      home: [19]
    })
  })

  it('changes the digest of a game with no record, so a stale device is refused', async function () {
    await newGame('gam_unrecorded')
    await setRostered(db, AWAY_COACH, 'gam_unrecorded', {
      side: 'away',
      userId: userIdOfGumbo(19),
      rostered: false
    })
    const before = await row('gam_unrecorded')
    expect(before.currentPlay).equals(null)
    const base = await storedLineupsDigest(db, before)
    await swap('gam_unrecorded')
    const game = await row('gam_unrecorded')
    expect(game.lineups_digest).not.equals(null)
    expect(game.lineups_digest).not.equals(base)
    expect(storedUnrostered(game.unrostered, teamsOfRow(game))).deep.equals({
      away: [],
      home: [19]
    })
    const stale = await failure(
      async () =>
        await postGamePlays(
          db,
          'gam_unrecorded',
          asPostEventsBody({
            mode: 'live',
            source: { system: 'teamstation' },
            lineupsBase: base,
            plays: [],
            currentPlay: null
          })
        )
    )
    expect(stale).nested.property('details.stale', true)
  })

  it('refuses once a pitch, a completed play or a placed runner is stored', async function () {
    await newGame('gam_pitched')
    await score('gam_pitched', session => [
      ...threeSaves(session),
      { type: 'pitch', call: 'B' }
    ])
    await refused('gam_pitched')

    await newGame('gam_walked')
    await score('gam_walked', session => [
      ...threeSaves(session),
      { type: 'result', eventType: 'intent_walk' },
      { type: 'gameFlow', kind: 'closePlay' }
    ])
    expect(await readPlays(db, 'gam_walked')).length.above(0)
    await refused('gam_walked')

    await prepared('gam_placed')
    // A runner placed before any pitch begins the game: the at-bat that
    // holds it is stored.
    const current = atBatOf(await row('gam_placed'), false) as CurrentPlay
    const record = (current as { teamStation?: { actions: unknown[] } })
      .teamStation!
    await db
      .updateTable('games')
      .set({
        currentPlay: {
          ...current,
          teamStation: {
            ...record,
            actions: [
              ...record.actions,
              { type: 'gameFlow', kind: 'placeRunner', runner: 9, base: '2B' }
            ]
          }
        }
      })
      .where('id', '=', 'gam_placed')
      .execute()
    expect(storedRecordOf((await row('gam_placed')).currentPlay)).not.equals(
      null
    )
    await refused('gam_placed')
  })

  it('refuses a game under way or final with no play stored here', async function () {
    for (const [id, status] of [
      ['gam_elsewhere_live', 'inProgress'],
      ['gam_elsewhere_final', 'final']
    ] as const) {
      await newGame(id)
      await db
        .updateTable('games')
        .set({ status })
        .where('id', '=', id)
        .execute()
      await refused(id)
    }
  })

  it('refuses an at-bat TeamStation did not score', async function () {
    await prepared('gam_outside')
    const { teamStation, ...outside } = atBatOf(
      await row('gam_outside'),
      false
    ) as CurrentPlay & { teamStation?: unknown }
    expect(teamStation).not.equals(undefined)
    await db
      .updateTable('games')
      .set({ currentPlay: outside })
      .where('id', '=', 'gam_outside')
      .execute()
    await refused('gam_outside')
  })

  it('gives the game back after two swaps', async function () {
    await prepared('gam_twice')
    const before = await row('gam_twice')
    await swap('gam_twice')
    await swap('gam_twice')
    const game = await row('gam_twice')
    for (const key of [
      'home_team_id',
      'away_team_id',
      'home_score',
      'away_score',
      'guests',
      'unrostered'
    ] as const)
      expect(game[key], key).deep.equals(before[key])
    // Each swap changes the lineups digest, so a device that missed both is
    // still refused.
    expect(game.lineups_digest).not.equals(before.lineups_digest)
    const was = recordOf(atBatOf(before, false), {
      away: { id: before.away_team_id },
      home: { id: before.home_team_id }
    })!
    const now = recordOf(atBatOf(game, false), {
      away: { id: game.away_team_id },
      home: { id: game.home_team_id }
    })!
    expect(now.setupBefore).deep.equals(was.setupBefore)
    expect(now.actions).deep.equals(was.actions)
    expect(game.pregame).deep.equals(before.pregame)
  })

  it('leaves nothing and says nothing when its transaction rolls back', async function () {
    await prepared('gam_rolled')
    const before = await row('gam_rolled')
    await forgetHeard()
    const error = await failure(
      async () =>
        await atomic(db, async trx => {
          await lockPlayerEdits(trx)
          await swapGameSides(trx, 'gam_rolled')
          throw new Error('rolled back')
        })
    )
    expect(error).property('message', 'rolled back')
    expect(await row('gam_rolled')).deep.equals(before)
    await settle()
    expect(heard).deep.equals([])
  })

  describe('beside a merge', function () {
    /** A Game Settings swap, in its lock order. */
    const settingsSwap = async (
      id: string,
      held?: Promise<void>
    ): Promise<void> => {
      await atomic(db, async trx => {
        await lockKeys(trx, ['creation:parent-graph', `game:${id}`])
        await lockPlayerEdits(trx)
        await held
        await swapGameSides(trx, id)
      })
    }
    /** A merge, holding its locks until `release` resolves. */
    const merge = async (
      held: Promise<void>,
      locked: () => void
    ): Promise<void> => {
      await atomic(db, async trx => {
        await lockKeys(trx, ['creation:parent-graph', MERGE_LOCK])
        locked()
        await held
      })
    }
    const unheld = async (id: string): Promise<boolean> =>
      await db.transaction().execute(async trx => {
        const { rows } = await sql<{
          id: string
        }>`select id from games where id = ${id} for update skip locked`.execute(
          trx
        )
        return rows.length === 1
      })
    const gate = (): { held: Promise<void>; release: () => void } => {
      let release = (): void => undefined
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      return { held, release }
    }

    it('waits for a merge holding no game row, then swaps, with a scorer’s post beside it', async function () {
      await prepared('gam_merged')
      const base = await storedLineupsDigest(db, await row('gam_merged'))
      const merging = gate()
      let locked = (): void => undefined
      const mergeLocked = new Promise<void>(resolve => {
        locked = resolve
      })
      const merged = merge(merging.held, locked)
      await mergeLocked
      const swapped = settingsSwap('gam_merged')
      const posted = postGamePlays(
        db,
        'gam_merged',
        asPostEventsBody({
          mode: 'live',
          source: { system: 'teamstation' },
          lineupsBase: base,
          plays: [],
          currentPlay: (await row('gam_merged')).currentPlay as CurrentPlay
        })
      )
      await new Promise(resolve => setTimeout(resolve, 300))
      // Both wait on the merge's locks, neither on the game row.
      expect(await unheld('gam_merged')).equals(true)
      merging.release()
      const settled = await Promise.allSettled([merged, swapped, posted])
      const reasons = settled
        .filter(each => each.status === 'rejected')
        .map(each => each.reason as Error)
      expect(reasons.map(reason => reason.message).join()).not.match(/deadlock/)
      expect(settled[0].status).equals('fulfilled')
      expect(settled[1].status).equals('fulfilled')
      // The post went first, or the swap did and it was stale.
      if (settled[2].status === 'rejected')
        expect(settled[2].reason).nested.property('details.stale', true)
      expect((await row('gam_merged')).home_team_id).equals(TEAMS.away.id)
    })

    it('holds a merge off while it swaps', async function () {
      await prepared('gam_first')
      const swapping = gate()
      const swapped = settingsSwap('gam_first', swapping.held)
      await new Promise(resolve => setTimeout(resolve, 200))
      let mergeLocked = false
      const merged = merge(Promise.resolve(), () => {
        mergeLocked = true
      })
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(mergeLocked).equals(false)
      swapping.release()
      const settled = await Promise.allSettled([swapped, merged])
      expect(settled.map(each => each.status)).deep.equals([
        'fulfilled',
        'fulfilled'
      ])
      expect(mergeLocked).equals(true)
      expect((await row('gam_first')).home_team_id).equals(TEAMS.away.id)
    })
  })
})
