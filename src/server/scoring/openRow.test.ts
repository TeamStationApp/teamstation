import { expect } from 'chai'
import { before, describe, it } from 'mocha'

import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { shortNames } from '../../common/names'
import { cleanAction } from '../../common/scoring/actions'
import { applyAction } from '../../common/scoring/apply'
import { recordOf } from '../../common/scoring/gumbo'
import { freshGame, newSetup } from '../../common/scoring/lineup'
import {
  type EventStore,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import { namesIn } from '../../common/scoring/storedNames'
import { ownTeams } from '../../common/scoring/teamRecord'
import { userIdOfGumbo } from '../../common/userId'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import {
  AWAY_PLAYERS,
  HOME_PLAYERS,
  inProgressGame,
  type Player,
  REPLAY_TEAMS,
  replaySetup
} from '../../test/replayGameFixture'
import { statsDatabase } from '../../test/statsDatabase'
import { closeInto, survivorsOf } from '../admin/people'
import { postGamePlays, readPlays } from '../events/postPlays'
import { lineupsAnswer, storedLineupsDigest } from '../events/teamLineups'
import {
  computeBoardTimeline,
  timelineVersion
} from '../scoreboard/boardTimeline'
import { scoreboardFromGame } from '../scoreboard/gameSource'
import { resolveScoringGame, scoringIdsIn } from './openRow'

// Full persisted rosters, including a guest whose account later closes into another.
describe('opening scoring through account merges', function () {
  this.timeout(60000)
  const fixture = statsDatabase('openrow')
  const users = Array.from({ length: 18 }, () => mintUserId(() => false))
  const teams = {
    away: { id: 'tem_away', name: 'Owls' },
    home: { id: 'tem_home', name: 'Hawks' }
  }
  const roster = (
    start: number
  ): Array<{
    userId: string
    gumboId: number
    shortName: string
    jersey: string
  }> =>
    users.slice(start, start + 9).map((user, i) => ({
      userId: userIdOfGumbo(user.userId),
      gumboId: user.userId,
      shortName: `Player ${i + 1}`,
      jersey: String(i + 1)
    }))
  const setup = newSetup(teams, { away: roster(0), home: roster(9) })
  const context = { gamePk: 'gam_demo', teams, setup }
  const options = { setTimer: () => null, clearTimer: () => undefined }
  before(async () => {
    await fixture.db
      .updateTable('users')
      .set({ first_name: 'Miguel', last_name: 'Cabrera' })
      .where('id', '=', userIdOfGumbo(fixture.ids[0]))
      .execute()
    await insertFixtureUsers(
      fixture.db,
      users.map(user => ({
        id: user.userId,
        legacyId: user.legacyId,
        display_name: 'Mike Trout',
        login_enabled: false
      }))
    )
  })
  const raw = async (): Promise<StoredGame> => ({
    plays: (await readPlays(fixture.db, 'gam_demo')).map(
      row => row.gumbo as GumboPlay
    ),
    currentPlay: (
      await fixture.db
        .selectFrom('games')
        .select('currentPlay')
        .where('id', '=', 'gam_demo')
        .executeTakeFirstOrThrow()
    ).currentPlay as CurrentPlay | null
  })
  const store: EventStore = {
    load: async () => await resolveScoringGame(fixture.db, await raw()),
    save: async (_id, change) => {
      const posted = await postGamePlays(
        fixture.db,
        'gam_demo',
        asPostEventsBody({
          ...change,
          source: { system: 'teamstation' },
          mode: 'live'
        })
      )
      return {
        plays: posted.plays.map(row => row.gumbo as GumboPlay),
        currentPlay: posted.currentPlay as CurrentPlay | null
      }
    }
  }
  it('opens as the survivor, writes the next play with that identity and keeps completed history intact', async () => {
    const session = await ScoringSession.open(
      store,
      'gam_demo',
      context,
      options
    )
    for (let i = 0; i < 3; i++)
      expect(session.apply({ type: 'pitch', call: 'C' }).problems).deep.equals(
        []
      )
    expect(
      session.apply({ type: 'gameFlow', kind: 'closePlay' }).problems
    ).deep.equals([])
    expect(
      session.apply({
        type: 'gameFlow',
        kind: 'override',
        batter: users[0].userId
      }).problems
    ).deep.equals([])
    expect(session.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
    await session.flush()
    expect(session.problem).equals(null)
    const before = await raw()
    const historical = JSON.stringify(before.plays)
    const original = users[0].userId
    const survivor = fixture.ids[0]
    const oldTimelineVersion = await timelineVersion(fixture.db, 'gam_demo')
    await closeInto(
      fixture.db,
      userIdOfGumbo(original),
      userIdOfGumbo(survivor)
    )
    expect(await timelineVersion(fixture.db, 'gam_demo')).not.equals(
      oldTimelineVersion
    )
    expect(
      (await scoreboardFromGame(fixture.db, 'gam_demo', () => undefined))!.state
        .batterName
    ).equals('Miguel C')
    expect(
      (await computeBoardTimeline(fixture.db, 'gam_demo'))!.steps.at(-1)!.state
        .batterName
    ).equals('Miguel C')
    await fixture.db
      .updateTable('games')
      .set({ lineups_digest: null })
      .where('id', '=', 'gam_demo')
      .execute()
    const gameRow = await fixture.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', 'gam_demo')
      .executeTakeFirstOrThrow()
    expect(await storedLineupsDigest(fixture.db, gameRow)).equals(
      (await lineupsAnswer(fixture.db, gameRow)).digest
    )
    const projected = await resolveScoringGame(fixture.db, before)
    const projectedPlayer = recordOf(
      projected.currentPlay,
      ownTeams(projected.currentPlay?.teamStation)
    )!.setupBefore.players[survivor]
    expect(projectedPlayer.fullName).equals('Miguel C')
    expect(projectedPlayer.firstName).equals(undefined)
    expect(projectedPlayer.lastName).equals(undefined)
    expect(JSON.stringify(before.plays)).equals(historical)
    expect(await raw()).deep.equals(before)
    const opened = await ScoringSession.open(
      store,
      'gam_demo',
      context,
      options
    )
    expect(opened.state.liveData.boxscore.teams.away.battingOrder[0]).equals(
      survivor
    )
    expect(opened.state.liveData.boxscore.teams.away.defense.P).equals(survivor)
    expect(opened.state.liveData.plays.currentPlay!.matchup.batter.id).equals(
      survivor
    )
    expect(projected.plays[0].matchup?.batter?.id).equals(survivor)
    // Credited by the survivor's id, and named from his account.
    expect(projected.plays[0].credits).deep.equals(
      before.plays[0].credits?.map(credit => {
        const id =
          credit.creditUserId === original ? survivor : credit.creditUserId
        const name = id === survivor ? 'Miguel C' : 'Mike T'
        return {
          ...credit,
          creditUserId: id,
          credit: { ...(credit.credit as object), name },
          label: `${(credit as { head?: string }).head}: ${name}`
        }
      })
    )
    expect(opened.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
    await opened.flush()
    expect(opened.problem).equals(null)
    const after = await raw()
    expect(JSON.stringify(after.plays)).equals(historical)
    expect(
      recordOf(after.currentPlay, ownTeams(after.currentPlay?.teamStation))!
        .setupBefore.sides.away.battingOrder[0]
    ).equals(survivor)
    expect(
      (after.currentPlay!.matchup as { batter: { id: number } }).batter.id
    ).equals(survivor)
  })
  it('replays fielding routes after their fielder merges without changing coordinates or saved history', async () => {
    const original = users[13].userId
    const survivor = mintUserId(() => false)
    await insertFixtureUsers(fixture.db, {
      id: survivor.userId,
      legacyId: survivor.legacyId,
      display_name: 'Hank Aaron',
      login_enabled: false
    })
    const actions = [
      {
        type: 'gameFlow',
        kind: 'override',
        bases: [users[1].userId, null, null]
      },
      { type: 'ballInPlay', contact: 'swing', fielder: original },
      { type: 'result', eventType: 'fielders_choice' },
      {
        type: 'runnerMovement',
        runner: users[1].userId,
        to: '2B',
        out: true,
        fielders: [original],
        fieldingRoute: [{ id: original, point: { x: 1, z: 2 } }]
      }
    ]
    const saved = {
      plays: [],
      currentPlay: {
        about: { atBatIndex: 0, isComplete: false as const },
        teamStation: { version: 2, setupBefore: setup, actions }
      }
    }
    const originalJson = JSON.stringify(saved)
    await closeInto(
      fixture.db,
      userIdOfGumbo(original),
      userIdOfGumbo(survivor.userId)
    )
    const projected = await resolveScoringGame(fixture.db, saved)
    const record = recordOf(projected.currentPlay, teams)!
    expect(record.actions[3]).includes({
      runner: users[1].userId
    })
    const movement = record.actions[3]
    if (movement.type !== 'runnerMovement')
      throw new Error('Expected runner movement')
    expect(movement.fieldingRoute).deep.equals([
      { id: survivor.userId, point: { x: 1, z: 2 } }
    ])
    let state = freshGame('gam_relay', teams, record.setupBefore)
    for (const action of record.actions) {
      const parsed = cleanAction(action)
      if ('problem' in parsed) throw new Error(parsed.problem.message)
      const applied = applyAction(state, parsed.action)
      expect(applied.problems).deep.equals([])
      state = applied.state
    }
    expect(state.liveData.linescore.outs).equals(1)
    expect(JSON.stringify(saved)).equals(originalJson)
  })
  it('deduplicates merged options and sums pitch counts without dropping historical credits', async () => {
    const original = users[0].userId
    const survivor = fixture.ids[0]
    const saved = await raw()
    const record = recordOf(
      saved.plays[0],
      ownTeams(saved.plays[0].teamStation)
    )!
    const aliasSetup = structuredClone(record.setupBefore)
    aliasSetup.players[survivor] = {
      ...aliasSetup.players[original],
      id: survivor
    }
    aliasSetup.sides.away.players.push(survivor)
    aliasSetup.tagOrder.push(survivor)
    aliasSetup.sides.away.pitchCounts[original] = 7
    aliasSetup.sides.away.pitchCounts[survivor] = 9
    const source = {
      plays: [
        {
          ...saved.plays[0],
          teamStation: {
            ...record,
            setupBefore: aliasSetup,
            extraMetadata: { kept: true },
            detail: {
              fieldingRoute: [
                { player: { id: original }, location: { x: 1, z: 2 } }
              ],
              runnerActions: [
                {
                  runner: { id: original },
                  origin: 1,
                  credits: [{ player: { id: original } }]
                }
              ]
            }
          },
          hitData: { fielder: { id: original } },
          credits: [
            { creditUserId: original, credit: {} },
            { creditUserId: survivor, credit: {} }
          ]
        }
      ],
      currentPlay: null
    }
    const expectedSource = JSON.stringify(source)
    const projected = await resolveScoringGame(fixture.db, source)
    const result = recordOf(
      projected.plays[0],
      ownTeams(projected.plays[0].teamStation)
    )!.setupBefore
    expect(result.sides.away.players.filter(id => id === survivor)).has.length(
      1
    )
    expect(result.tagOrder.filter(id => id === survivor)).has.length(1)
    expect(result.sides.away.pitchCounts[survivor]).equals(16)
    expect(
      projected.plays[0].credits.map(credit => credit.creditUserId)
    ).deep.equals([survivor, survivor])
    expect(projected.plays[0].hitData.fielder.id).equals(survivor)
    expect(projected.plays[0].teamStation.extraMetadata).deep.equals({
      kept: true
    })
    expect(
      recordOf(projected.plays[0], ownTeams(projected.plays[0].teamStation))!
        .detail
    ).deep.equals({
      fieldingRoute: [
        {
          player: { id: survivor, fullName: 'Miguel C' },
          location: { x: 1, z: 2 }
        }
      ],
      runnerActions: [
        {
          runner: { id: survivor, fullName: 'Miguel C' },
          origin: 1,
          credits: [{ player: { id: survivor, fullName: 'Miguel C' } }]
        }
      ]
    })
    expect(JSON.stringify(source)).equals(expectedSource)
    aliasSetup.players[survivor].teamId = teams.home.id
    let error: unknown
    try {
      await resolveScoringGame(fixture.db, structuredClone(source))
    } catch (caught) {
      error = caught
    }
    expect((error as Error).message).includes('opposing teams')
  })

  it('preserves database failures instead of reporting unresolved history', async () => {
    const outage = new Error('Database unavailable')
    const failing = fixture.db.withPlugin({
      transformQuery() {
        throw outage
      },
      async transformResult({ result }) {
        return result
      }
    })
    const stored: StoredGame = {
      plays: [
        {
          about: { atBatIndex: 0 },
          result: { eventType: 'single' },
          matchup: { batter: { id: users[0].userId } }
        }
      ],
      currentPlay: null
    }
    let failure: unknown
    try {
      await resolveScoringGame(failing, stored)
    } catch (error) {
      failure = error
    }
    expect(failure).equals(outage)
  })

  it('follows a second merge, leaves open identities alone and refuses missing or cyclic chains', async () => {
    const [middle, survivor] = fixture.ids
    await closeInto(fixture.db, userIdOfGumbo(middle), userIdOfGumbo(survivor))
    const projected = await resolveScoringGame(fixture.db, await raw())
    const opened = await ScoringSession.open(
      { ...store, load: async () => projected },
      'gam_demo',
      context,
      options
    )
    expect(opened.state.liveData.boxscore.teams.away.battingOrder[0]).equals(
      survivor
    )
    const open = await survivorsOf(fixture.db, [
      userIdOfGumbo(survivor),
      userIdOfGumbo(users[0].userId)
    ])
    expect([...open.values()]).deep.equals([
      userIdOfGumbo(survivor),
      userIdOfGumbo(survivor)
    ])
    for (const corrupt of ['missing', 'cycle']) {
      if (corrupt === 'cycle')
        await fixture.db
          .updateTable('users')
          .set({ merged_into: userIdOfGumbo(middle) })
          .where('id', '=', userIdOfGumbo(survivor))
          .execute()
      let error: unknown
      try {
        await survivorsOf(fixture.db, [
          userIdOfGumbo(corrupt === 'missing' ? 1 : middle)
        ])
      } catch (caught) {
        error = caught
      }
      expect(error).instanceOf(Error)
    }
    await fixture.db
      .updateTable('users')
      .set({ merged_into: null })
      .where('id', '=', userIdOfGumbo(survivor))
      .execute()
  })
})

// A whole game named from the accounts, as every read names it.
describe('naming a scoring game from the accounts', function () {
  this.timeout(60000)
  const fixture = statsDatabase('namedread')
  const everyone = [...AWAY_PLAYERS, ...HOME_PLAYERS]
  const taken = new Set<number>()
  const minted = new Map(
    everyone.map(player => {
      const one = mintUserId(id => taken.has(id))
      taken.add(one.userId)
      return [player, one] as const
    })
  )
  const mint = (): { userId: number; legacyId: string } => {
    const one = mintUserId(id => taken.has(id))
    taken.add(one.userId)
    return one
  }
  const guests = { away: mint(), home: mint() }
  const idOf = (player: Player): number => minted.get(player)!.userId
  const setup = replaySetup(idOf)
  // A game-only player on each side, his setup holding the whole name he
  // was typed with.
  for (const [side, guest, jersey] of [
    ['away', guests.away, '51'],
    ['home', guests.home, '55']
  ] as const) {
    setup.players[guest.userId] = {
      id: guest.userId,
      teamId: REPLAY_TEAMS[side].id,
      fullName: 'Typed Whole Name',
      firstName: 'Typed',
      lastName: 'Whole Name',
      jersey,
      bats: 'left',
      throws: 'right',
      positions: [],
      local: true
    }
    setup.sides[side].players.push(guest.userId)
    setup.tagOrder.push(guest.userId)
  }
  const accounts = [
    ...everyone.map(player => ({
      ...minted.get(player)!,
      first: player.first,
      last: player.last
    })),
    { ...guests.away, first: 'Ichiro', last: 'Suzuki' },
    { ...guests.home, first: 'Hideki', last: 'Matsui' }
  ]
  const shown = shortNames(
    accounts.map(person => ({
      id: person.userId,
      displayName: `${person.first} ${person.last}`,
      firstName: person.first,
      lastName: person.last
    }))
  )
  let stored: StoredGame
  before(async () => {
    await insertFixtureUsers(
      fixture.db,
      accounts.map(person => ({
        id: person.userId,
        legacyId: person.legacyId,
        display_name: `${person.first} ${person.last}`,
        first_name: person.first,
        last_name: person.last,
        login_enabled: false
      }))
    )
    stored = await inProgressGame(setup)
  })

  it('names every reference, setup player, credit and sentence by short names over the game', async () => {
    const before = JSON.stringify(stored)
    const named = await resolveScoringGame(fixture.db, stored)
    expect(JSON.stringify(stored)).equals(before)
    const documents = [...named.plays, named.currentPlay]
    let checked = 0
    for (const document of documents)
      for (const [id, name] of namesIn(document)) {
        expect(name, String(id)).equals(shown.get(id))
        checked++
      }
    expect(checked).greaterThan(100)
    const text = JSON.stringify(named)
    for (const player of everyone)
      expect(text).not.includes(`${player.first} ${player.last}`)
    expect(text).not.includes('Typed Whole Name')
    // Sentences read the game's short names: the pitching change, the pinch
    // hitter and the wild pitch among them.
    const sentences = documents.flatMap(document =>
      (
        (document?.playEvents ?? []) as Array<{
          details?: { eventType?: string; description?: string }
        }>
      ).flatMap(event =>
        event.details?.description == null ? [] : [event.details]
      )
    )
    for (const type of [
      'pitching_substitution',
      'offensive_substitution',
      'wild_pitch'
    ])
      expect(
        sentences.find(details => details.eventType === type)?.description,
        type
      ).matches(/[A-Z][a-z]+ [A-Z]\b/)
    const labels = named.plays.flatMap(play =>
      (play.credits ?? []).map(credit => credit.label)
    )
    expect(labels).includes('Walk: Juan S')
    // Nobody's halves on a general read: the scoreboards read it too.
    const record = recordOf(named.currentPlay, REPLAY_TEAMS)!
    for (const player of Object.values(record.setupBefore.players)) {
      expect(player.firstName, String(player.id)).equals(undefined)
      expect(player.lastName, String(player.id)).equals(undefined)
    }
    expect(record.setupBefore.players[guests.away.userId].fullName).equals(
      'Ichiro S'
    )
  })

  it("gives every player's halves, rostered and game-only, only on the teams asked for", async () => {
    const halvesOf = async (
      halves: string[]
    ): Promise<Record<string, unknown>> => {
      const named = await resolveScoringGame(fixture.db, stored, { halves })
      const players = recordOf(named.currentPlay, REPLAY_TEAMS)!.setupBefore
        .players
      const parts = (id: number): unknown =>
        players[id].firstName == null && players[id].lastName == null
          ? null
          : `${players[id].firstName} ${players[id].lastName}`
      return {
        awayGuest: parts(guests.away.userId),
        homeGuest: parts(guests.home.userId),
        away: parts(idOf(AWAY_PLAYERS[0])),
        home: parts(idOf(HOME_PLAYERS[0]))
      }
    }
    const { away, home } = REPLAY_TEAMS
    expect(await halvesOf([away.id, home.id])).deep.equals({
      awayGuest: 'Ichiro Suzuki',
      homeGuest: 'Hideki Matsui',
      away: 'Juan Soto',
      home: 'Mookie Betts'
    })
    expect(await halvesOf([home.id])).deep.equals({
      awayGuest: null,
      homeGuest: 'Hideki Matsui',
      away: null,
      home: 'Mookie Betts'
    })
    expect(await halvesOf([])).deep.equals({
      awayGuest: null,
      homeGuest: null,
      away: null,
      home: null
    })
  })

  it('stores no name from a build that sends named sentences and no said, and reads its sentences back the same', async () => {
    const teams = Object.values(REPLAY_TEAMS)
    await fixture.db
      .insertInto('teams')
      .values(teams.map(team => ({ id: team.id, name: team.name })))
      .onConflict(conflict => conflict.doNothing())
      .execute()
    await fixture.db
      .insertInto('games')
      .values({
        id: 'gam_oldbuild',
        start_at: new Date('2026-01-01T00:00:00Z'),
        home_team_id: REPLAY_TEAMS.home.id,
        away_team_id: REPLAY_TEAMS.away.id
      })
      .execute()
    // What a build from before sentences carried their `said` posts.
    const unsaid = <T>(document: T): T =>
      JSON.parse(
        JSON.stringify(document, (key, value: unknown) =>
          key === 'said' ? undefined : value
        )
      ) as T
    await postGamePlays(
      fixture.db,
      'gam_oldbuild',
      asPostEventsBody({
        mode: 'live',
        source: { system: 'teamstation' },
        plays: stored.plays.map(unsaid),
        currentPlay: unsaid(stored.currentPlay)
      })
    )
    const rows = await readPlays(fixture.db, 'gam_oldbuild')
    const game = await fixture.db
      .selectFrom('games')
      .select(['currentPlay', 'pregame'])
      .where('id', '=', 'gam_oldbuild')
      .executeTakeFirstOrThrow()
    const text = JSON.stringify([
      rows.map(row => row.gumbo),
      game.currentPlay,
      game.pregame
    ])
    for (const person of accounts) {
      expect(text).not.includes(`${person.first} ${person.last}`)
      expect(text).not.includes(shown.get(person.userId)!)
    }
    expect(text).not.includes('Typed Whole Name')
    // Every sentence was read back to what it is worded from.
    const described = rows.flatMap(row =>
      (((row.gumbo as GumboPlay).playEvents ?? []) as unknown[]).filter(
        event =>
          (event as { said?: unknown }).said != null ||
          (event as { details?: { description?: unknown } }).details
            ?.description != null
      )
    )
    expect(described.length).greaterThan(5)
    const sentences = (game: StoredGame): unknown =>
      [...game.plays, game.currentPlay].map(document =>
        ((document?.playEvents ?? []) as unknown[]).map(
          event =>
            (event as { details?: { description?: unknown } }).details
              ?.description
        )
      )
    const named = await resolveScoringGame(fixture.db, {
      plays: rows.map(row => row.gumbo as GumboPlay),
      currentPlay: game.currentPlay as CurrentPlay | null
    })
    expect(sentences(named)).deep.equals(
      sentences(await resolveScoringGame(fixture.db, stored))
    )
  })

  it('names a merged player by his survivor, in every sentence that names him', async () => {
    const replaced = idOf(AWAY_PLAYERS[8])
    const survivor = mint()
    await insertFixtureUsers(fixture.db, {
      id: survivor.userId,
      legacyId: survivor.legacyId,
      display_name: 'Hank Aaron',
      first_name: 'Hank',
      last_name: 'Aaron',
      login_enabled: false
    })
    await closeInto(
      fixture.db,
      userIdOfGumbo(replaced),
      userIdOfGumbo(survivor.userId)
    )
    const named = await resolveScoringGame(fixture.db, stored)
    // Annotation signatures are opaque, and stay as they were tagged.
    const text = JSON.stringify(named, (key, value: unknown) =>
      key === 'tagTargets' ? undefined : value
    )
    expect(text).not.includes(String(replaced))
    for (const document of [...named.plays, named.currentPlay])
      expect(namesIn(document).get(survivor.userId) ?? 'Hank A').equals(
        'Hank A'
      )
    expect(
      [...named.plays, named.currentPlay].some(
        document => namesIn(document).get(survivor.userId) === 'Hank A'
      )
    ).equals(true)
  })
})

describe('the scoring ids a game names', function () {
  it("reads each sentence's players, and leaves typed names and odd shapes alone", () => {
    const stored = {
      plays: [
        {
          about: { atBatIndex: 0 },
          playEvents: [
            {
              said: {
                kind: 'order',
                moved: [
                  { player: 11, bats: 1 },
                  { player: { name: 'Typed Name' }, bats: 2 }
                ]
              }
            },
            {
              said: {
                kind: 'action',
                eventType: 'wild_pitch',
                lead: { player: 12, role: 'pitcher' }
              }
            },
            {
              said: { kind: 'pinch', player: 13, replaced: 14, running: false }
            },
            { said: { kind: 'action', eventType: 'balk', lead: null } },
            { said: 'odd' },
            { catcher: { id: 15 } }
          ]
        }
      ],
      currentPlay: null
    } as unknown as StoredGame
    expect(scoringIdsIn(stored)).members([11, 12, 13, 14, 15])
  })
})

describe('naming a game whose record does not read', function () {
  this.timeout(60000)
  const fixture = statsDatabase('oddrecord')
  it("keeps what it cannot name, and names nobody's halves", async () => {
    const stored = {
      plays: [
        {
          about: { atBatIndex: 0 },
          teamStation: {
            version: 2,
            setupBefore: { players: { 1: 'odd', 2: { id: 2, local: true } } },
            actions: [
              { type: 'pitch' },
              'odd',
              { type: 'lineup', setup: 'odd' }
            ]
          }
        }
      ],
      currentPlay: { about: { atBatIndex: 1 }, teamStation: 'odd' }
    } as unknown as StoredGame
    const named = await resolveScoringGame(fixture.db, stored, {
      halves: ['tem_home']
    })
    expect(named.plays[0].teamStation).deep.equals({
      version: 2,
      setupBefore: {
        players: { 1: 'odd', 2: { id: 2, local: true, fullName: '' } }
      },
      actions: [{ type: 'pitch' }, 'odd', { type: 'lineup', setup: 'odd' }]
    })
    expect(named.currentPlay).deep.equals(stored.currentPlay)
  })
})
