import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import type { RosterEntry } from '../../common/api'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import type { PlayerNamePrivacy } from '../../common/playerNamePrivacy'
import { newSetup, type RosterPlayer } from '../../common/scoring/lineup'
import type {
  EventStore,
  SessionContext,
  StoredGame
} from '../../common/scoring/session'
import { ScoringSession } from '../../common/scoring/session'
import type { GamePlayer } from '../../common/scoring/state'
import { asGumboId, userIdOfGumbo } from '../../common/userId'
import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import {
  addGame,
  dropPrefix,
  quiet,
  requireRedis,
  testPrefix,
  testStore,
  until
} from '../../test/scoreboardKit'
import { mergeTeams } from '../admin/mergeTeams'
import { createSession } from '../auth/sessions'
import { chatPeople } from '../chat/listing'
import { readPlays } from '../events/postPlays'
import { gameAvailability } from '../games/rosterAvailability'
import { withdrawnKey } from '../games/withdrawn'
import { TESS_HEADER } from '../middleware/withAuth'
import { narrationsFor } from '../replay/narrationAudio'
import {
  boardTimeline,
  makeBoardTimelineCache,
  timelineVersion
} from '../scoreboard/boardTimeline'
import { gamesAround, scoreboardFromGame } from '../scoreboard/gameSource'
import type { ScoreboardStore } from '../scoreboard/scoreboardStore'
import { resolveScoringGame } from '../scoring/openRow'
import { candidatePerson } from '../teams/addExistingPlayer'
import { userContext } from '../tess/userContext'
import { people as umpirePeople } from '../umpires/admin'
import { gameNamesDigest, shortNamesOf } from '../users/nameBook'
import { runSpoken } from '../users/readerNames'
import { publicNames, teamFormats } from './playerNamePrivacy'

/** The part of a named play these tests read. */
interface Staged {
  teamStation?: { setupBefore: { players: Record<number, GamePlayer> } }
}

const ALEX = 7001
const RILEY = 7101
const SCORER = 7201
const STRANGER = 7202
/** A teammate of Alex's, who reads names in the public format. */
const TEAMMATE = ALEX + 1

describe('a game named in player name privacy', function () {
  this.timeout(60000)
  let f: GroupFixture
  let store: ScoreboardStore
  let close: () => Promise<void>
  const prefix = testPrefix()
  let gameId: string
  let context: SessionContext

  const privacy = async (
    teamId: string,
    value: PlayerNamePrivacy | null
  ): Promise<void> => {
    await f.h.db
      .updateTable('teams')
      .set({ player_name_privacy: value })
      .where('id', '=', teamId)
      .execute()
  }
  const read = async (gameId_ = gameId): Promise<StoredGame> =>
    await resolveScoringGame(
      f.h.db,
      {
        plays: (await readPlays(f.h.db, gameId_)).map(
          row => row.gumbo as GumboPlay
        ),
        currentPlay: (
          await f.h.db
            .selectFrom('games')
            .select('currentPlay')
            .where('id', '=', gameId_)
            .executeTakeFirstOrThrow()
        ).currentPlay as CurrentPlay | null
      },
      { gameId: gameId_ }
    )
  const setupPlayer = async (id: number): Promise<GamePlayer | undefined> =>
    ((await read()).currentPlay as unknown as Staged | null)?.teamStation
      ?.setupBefore.players[id]
  const events = async (userId?: number): Promise<Record<string, unknown>> =>
    (await (
      await f.h.request('GET', `/games/${gameId}/events`, undefined, userId)
    ).json()) as Record<string, unknown>
  /** The board is written again in the background, after the save answers. */
  const boardShows = async (name: string): Promise<void> => {
    await until(`the board to show ${name}`, async () => {
      const board = (await (
        await f.h.request('GET', `/scoreboard/${gameId}`)
      ).json()) as { state: { batterName: string; pitcherName: string } }
      return [board.state.batterName, board.state.pitcherName]
        .join()
        .includes(name)
    })
  }
  const viaTess = async (path: string, userId: number): Promise<unknown> =>
    await (
      await fetch(`${f.h.origin}/api/v1${path}`, {
        headers: {
          authorization: `Bearer ${f.h.tokens.get(userId)!}`,
          [TESS_HEADER]: '1'
        }
      })
    ).json()

  before(async function () {
    await requireRedis()
    const made = await testStore(prefix)
    store = made.store
    close = async () => {
      await made.client.close()
      await dropPrefix(prefix)
    }
    f = await groupFixture(
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      {},
      {
        store,
        log: quiet
      }
    )
    const { db, tokens } = f.h
    const roster = (
      start: number,
      first: string,
      last: string
    ): Array<{
      id: number
      legacyId: string
      display_name: string
      first_name: string
      last_name: string
    }> =>
      Array.from({ length: 9 }, (_, i) => ({
        id: start + i,
        legacyId: `usr_privacy_${start + i}`,
        display_name: i === 0 ? `${first} ${last}` : `Filler ${start + i}`,
        first_name: i === 0 ? first : 'Filler',
        last_name: i === 0 ? last : String(start + i)
      }))
    await insertFixtureUsers(db, [
      ...roster(ALEX, 'Alex', 'Lee'),
      ...roster(RILEY, 'Riley', 'Chen'),
      {
        id: SCORER,
        legacyId: 'usr_privacy_scorer',
        display_name: 'Cal Ripken',
        login_enabled: true
      },
      {
        id: STRANGER,
        legacyId: 'usr_privacy_stranger',
        display_name: 'Babe Ruth',
        login_enabled: true
      }
    ])
    for (const [start, teamId] of [
      [ALEX, f.teamA],
      [RILEY, f.teamB]
    ] as const)
      for (let i = 0; i < 9; i++) {
        await db
          .insertInto('memberships')
          .values({
            id: makeId('membership'),
            user_id: userIdOfGumbo(start + i),
            team_id: teamId,
            role: 'member',
            is_player: true
          })
          .execute()
      }
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(SCORER),
        scope_type: 'team',
        scope_id: f.teamA,
        role: 'scorekeeper',
        granted_by: userIdOfGumbo(101),
        granted_at: new Date()
      })
      .execute()
    await db
      .updateTable('users')
      .set({ login_enabled: true })
      .where('id', '=', userIdOfGumbo(TEAMMATE))
      .execute()
    const { createSession } = await import('../auth/sessions')
    for (const id of [SCORER, STRANGER, TEAMMATE])
      tokens.set(
        id,
        (await createSession(db, userIdOfGumbo(id), 'privacy-reads')).token
      )
    const teams = {
      home: { id: f.teamA, name: 'Demo Hawks', logoUrl: null },
      away: { id: f.teamB, name: 'Demo Eagles', logoUrl: null }
    }
    const rows = (start: number): RosterPlayer[] =>
      Array.from({ length: 9 }, (_, i) => ({
        userId: userIdOfGumbo(start + i),
        gumboId: asGumboId(start + i),
        shortName: ''
      }))
    context = {
      gamePk: 'pending',
      teams,
      setup: newSetup(teams, { away: rows(RILEY), home: rows(ALEX) })
    }
    gameId = await addGame(db, {
      homeTeamId: f.teamA,
      awayTeamId: f.teamB,
      startAt: new Date(),
      status: 'inProgress'
    })
    const storeOf: EventStore = {
      load: async id => ({
        plays: (await readPlays(db, id)).map(row => row.gumbo as GumboPlay),
        currentPlay: null
      }),
      save: async (id, change) => {
        const answer = await f.h.request(
          'POST',
          `/games/${id}/events`,
          { ...change, mode: 'live', source: { system: 'teamstation' } },
          SCORER
        )
        if (!answer.ok) throw new Error(await answer.text())
        return await storeOf.load(id)
      }
    }
    const session = await ScoringSession.open(storeOf, gameId, {
      ...context,
      gamePk: gameId
    })
    session.apply({ type: 'pitch', call: 'B' })
    await session.flush()
  })
  after(async function () {
    await f.h.close()
    await close()
  })
  beforeEach(async function () {
    await privacy(f.teamA, null)
    await privacy(f.teamB, null)
  })

  it('reads as it always has with nothing configured', async function () {
    const player = await setupPlayer(ALEX)
    expect(player?.fullName).equals('Alex L')
    expect(player).not.have.property('nameFormat')
  })

  it('names each team in its own format and says so', async function () {
    await privacy(f.teamA, 'full')
    await privacy(f.teamB, 'initials')
    const home = await setupPlayer(ALEX)
    expect(home?.fullName).equals('Alex Lee')
    expect(home?.nameFormat).equals('full')
    const away = await setupPlayer(RILEY)
    expect(away?.fullName).equals('R C')
    expect(away?.nameFormat).equals('initials')
  })

  it('takes a game read for speech down to no surname', async function () {
    await privacy(f.teamA, 'full')
    await privacy(f.teamB, 'initialLast')
    const game = await f.h.db
      .selectFrom('games')
      .select('currentPlay')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    const spoken = await resolveScoringGame(
      f.h.db,
      { plays: [], currentPlay: game.currentPlay as CurrentPlay | null },
      { gameId, spoken: true }
    )
    const players = (spoken.currentPlay as unknown as Staged | null)
      ?.teamStation?.setupBefore.players
    expect(players?.[ALEX]?.fullName).equals('Alex L')
    expect(players?.[RILEY]?.fullName).equals('R C')
  })

  it('never narrates a surname', async function () {
    await privacy(f.teamA, 'full')
    const full = [...(await narrationsFor(f.h.db, gameId)).values()]
    expect(JSON.stringify(full)).not.include('Lee')
    await privacy(f.teamA, 'initials')
    const initials = [...(await narrationsFor(f.h.db, gameId)).values()]
    expect(JSON.stringify(initials)).not.include('Alex')
  })

  it('moves the digests when a format moves', async function () {
    const before = await gameNamesDigest(f.h.db, gameId)
    const version = await timelineVersion(f.h.db, gameId)
    await privacy(f.teamA, 'initials')
    expect(await gameNamesDigest(f.h.db, gameId)).not.equals(before)
    expect(await timelineVersion(f.h.db, gameId)).not.equals(version)
  })

  it('writes the board in the format of each team', async function () {
    await privacy(f.teamA, 'full')
    await privacy(f.teamB, 'initials')
    const source = await scoreboardFromGame(f.h.db, gameId, quiet)
    expect(source?.state.batterName ?? '').match(/^(Alex Lee|R C)$/)
  })

  it('answers the timeline in the current format', async function () {
    const before = await boardTimeline(f.h.db, gameId)
    await privacy(f.teamB, 'initials')
    const after = await boardTimeline(f.h.db, gameId)
    expect(JSON.stringify(after)).not.equals(JSON.stringify(before))
  })

  it('gives modelNames only to whoever may dictate', async function () {
    await privacy(f.teamB, 'initials')
    const scorer = await events(SCORER)
    expect((scorer.modelNames as Record<string, string>)[String(RILEY)]).equals(
      'Riley C.'
    )
    expect((scorer.modelNames as Record<string, string>)[String(ALEX)]).equals(
      'Alex L.'
    )
    const stranger = await events(STRANGER)
    expect(stranger).not.have.property('modelNames')
    expect(JSON.stringify(stranger)).not.include('Chen')
    expect(JSON.stringify(stranger)).not.include('Riley')
  })

  it('clamps what a model reads, and only a read', async function () {
    await privacy(f.teamA, 'full')
    expect(
      await runSpoken(async () => (await setupPlayer(ALEX))?.fullName)
    ).equals('Alex L')
    expect(await setupPlayer(ALEX)).property('fullName', 'Alex Lee')
    expect(
      JSON.stringify(await viaTess(`/games/${gameId}/events`, 101))
    ).not.include('"fullName":"Alex Lee"')
    expect(JSON.stringify(await events(101))).include('"fullName":"Alex Lee"')
    // A change made through Tess writes the real name to the board.
    const put = await fetch(`${f.h.origin}/api/v1/groups/team/${f.teamB}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${f.h.tokens.get(102)!}`,
        'content-type': 'application/json',
        [TESS_HEADER]: '1'
      },
      body: JSON.stringify({ playerNamePrivacy: 'full' })
    })
    expect(put.status).equals(200)
    await boardShows('Chen')
  })

  it("adds no letter of a surname to a model's list", async function () {
    await privacy(f.teamA, 'full')
    const rename = async (first: string, last: string): Promise<void> => {
      await f.h.db
        .updateTable('users')
        .set({
          display_name: `${first} ${last}`,
          first_name: first,
          last_name: last
        })
        .where('id', '=', userIdOfGumbo(ALEX + 1))
        .execute()
    }
    await rename('Alex', 'Leigh')
    const said = JSON.stringify(await viaTess(`/teams/${f.teamA}/roster`, 101))
    await rename('Filler', String(ALEX + 1))
    expect(said).include('"shortName":"Alex L"')
    expect(said).not.include('Alex Le')
  })

  it("keeps a model's timeline apart from the public one", async function () {
    await privacy(f.teamA, 'full')
    const cache = makeBoardTimelineCache(2)
    const [spoken, open] = await Promise.all([
      runSpoken(async () => await cache.get(f.h.db, gameId)),
      cache.get(f.h.db, gameId)
    ])
    expect(JSON.stringify(spoken)).not.include('Alex Lee')
    expect(JSON.stringify(open)).include('Alex Lee')
    expect(JSON.stringify(await cache.get(f.h.db, gameId))).include('Alex Lee')
  })

  it('blanks the live board for a model and keeps the score', async function () {
    await privacy(f.teamA, 'full')
    const board = (await viaTess(`/scoreboard/${gameId}`, 101)) as {
      state: { batterName: string; pitcherName: string; balls: number }
    }
    expect(board.state.batterName).equals('')
    expect(board.state.pitcherName).equals('')
    expect(board.state.balls).equals(1)
  })

  it("keeps the board and narration public after the scorekeeper's play", async function () {
    // The scorekeeper of Alex's team reads him in full, a teammate does not,
    // and the plays' labels read the same for both: only the scorekeeper's
    // halves set them apart.
    const labels = (read: Record<string, unknown>): string =>
      JSON.stringify(read.currentPlay, (key, value: unknown) =>
        key === 'firstName' || key === 'lastName' ? undefined : value
      )
    const scorer = await events(SCORER)
    expect(scorer.readerNames).property(String(ALEX), 'Alex Lee')
    const teammate = await events(TEAMMATE)
    expect(teammate).not.have.nested.property(`readerNames.${ALEX}`)
    expect(scorer.namesDigest).equals(teammate.namesDigest)
    expect(labels(scorer)).equals(labels(teammate))
    expect(labels(scorer)).not.include('Alex Lee')
    // A play he posts goes to the live board in the public format.
    const scored = await addGame(f.h.db, {
      homeTeamId: f.teamA,
      awayTeamId: f.teamB,
      startAt: new Date(),
      status: 'inProgress'
    })
    const storeOf: EventStore = {
      load: async () => ({ plays: [], currentPlay: null }),
      save: async (id, change) => {
        const answer = await f.h.request(
          'POST',
          `/games/${id}/events`,
          { ...change, mode: 'live', source: { system: 'teamstation' } },
          SCORER
        )
        if (!answer.ok) throw new Error(await answer.text())
        const posted = (await answer.json()) as Record<string, unknown>
        expect(posted.readerNames).property(String(ALEX), 'Alex Lee')
        return { plays: [], currentPlay: null }
      }
    }
    const session = await ScoringSession.open(storeOf, scored, {
      ...context,
      gamePk: scored
    })
    session.apply({ type: 'pitch', call: 'B' })
    await session.flush()
    await until('the board to show the pitch', async () => {
      const board = (await (
        await f.h.request('GET', `/scoreboard/${scored}`)
      ).json()) as { state?: { balls: number } }
      return board.state?.balls === 1
    })
    const board = JSON.stringify(
      await (await f.h.request('GET', `/scoreboard/${scored}`)).json()
    )
    expect(board).include('Alex L')
    expect(board).not.include('Lee')
    expect(
      JSON.stringify(await scoreboardFromGame(f.h.db, scored, quiet))
    ).not.include('Lee')
    expect(
      JSON.stringify([...(await narrationsFor(f.h.db, scored)).values()])
    ).not.include('Lee')
  })

  it('blanks the dashboard for a model too', async function () {
    await privacy(f.teamA, 'full')
    const board = JSON.stringify(
      await viaTess(`/scoreboard/${gameId}/dashboard`, 101)
    )
    expect(board).not.include('Lee')
    expect(board).include('"batterName":""')
    expect(
      JSON.stringify(
        await (
          await f.h.request(
            'GET',
            `/scoreboard/${gameId}/dashboard`,
            undefined,
            101
          )
        ).json()
      )
    ).not.include('"batterName":""')
  })

  it('writes a live board again when privacy changes', async function () {
    const put = await f.h.request(
      'PUT',
      `/groups/team/${f.teamB}`,
      { playerNamePrivacy: 'full' },
      102
    )
    expect(put.status).equals(200)
    await boardShows('Chen')
  })

  it('leaves a closed board closed', async function () {
    const closed = await addGame(f.h.db, {
      homeTeamId: f.teamA,
      awayTeamId: f.teamB,
      startAt: new Date()
    })
    await f.h.request(
      'PUT',
      `/groups/team/${f.teamA}`,
      { playerNamePrivacy: 'initials' },
      101
    )
    expect(await store.exists(closed)).equals(false)
  })

  describe('outside a game', function () {
    const name = async (
      route: string,
      userId: number | null
    ): Promise<string> =>
      JSON.stringify(
        await (await f.h.request('GET', route, undefined, userId)).json()
      )

    it('writes a roster player in the team format and nobody else', async function () {
      await privacy(f.teamA, 'full')
      const roster = async (reader: number): Promise<RosterEntry[]> =>
        (await (
          await f.h.request(
            'GET',
            `/teams/${f.teamA}/roster`,
            undefined,
            reader
          )
        ).json()) as RosterEntry[]
      const rows = await roster(TEAMMATE)
      const alex = rows.find(row => row.userId === userIdOfGumbo(ALEX))!
      expect(alex.shortName).equals('Alex Lee')
      expect(alex.nameFormat).equals('full')
      const staff = rows.find(row => row.userId === userIdOfGumbo(SCORER))!
      expect(staff.shortName).equals('Cal R')
      expect(staff).not.have.property('nameFormat')
      // The league's administrator manages the team's people, and reads its
      // staff in full (`mayViewFullNames`), the built-in public label beside.
      const managed = (await roster(101)).find(
        row => row.userId === userIdOfGumbo(SCORER)
      )!
      expect(managed).to.include({
        shortName: 'Cal Ripken',
        nameFormat: 'full',
        compactName: 'Cal R'
      })
    })

    it('reads no format on a roster with nothing chosen', async function () {
      const rows = (await (
        await f.h.request(
          'GET',
          `/teams/${f.teamA}/roster`,
          undefined,
          TEAMMATE
        )
      ).json()) as RosterEntry[]
      expect(
        rows.find(row => row.userId === userIdOfGumbo(ALEX))
      ).not.have.property('nameFormat')
    })

    it('keeps an authorized full name under a narrower format', async function () {
      await privacy(f.teamA, 'initials')
      const full = (await (
        await f.h.request(
          'GET',
          `/teams/${f.teamA}/roster?includeFullNames=true`,
          undefined,
          SCORER
        )
      ).json()) as RosterEntry[]
      const alex = full.find(row => row.userId === userIdOfGumbo(ALEX))!
      expect(alex.nameDetails?.lastName).equals('Lee')
      // The scorekeeper reads the name in full, the public format beside it.
      expect(alex.shortName).equals('Alex Lee')
      expect(alex.compactName).equals('A L')
      expect(alex.compactFormat).equals('initials')
      const named = await f.h.request(
        'GET',
        `/players/${userIdOfGumbo(ALEX)}/name`,
        undefined,
        SCORER
      )
      expect(await named.text()).include('Lee')
      expect(
        (
          await f.h.request(
            'GET',
            `/players/${userIdOfGumbo(ALEX)}/name`,
            undefined,
            STRANGER
          )
        ).status
      ).equals(404)
    })

    it('uses a current team for a player page and ignores any other', async function () {
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userIdOfGumbo(ALEX),
          team_id: f.teamB,
          role: 'member',
          is_player: true
        })
        .execute()
      await privacy(f.teamA, 'full')
      await privacy(f.teamB, 'initials')
      const page = async (query: string): Promise<string> =>
        (
          (await (
            await f.h.request(
              'GET',
              `/players/${userIdOfGumbo(ALEX)}${query}`,
              undefined,
              TEAMMATE
            )
          ).json()) as { name: string }
        ).name
      expect(await page('')).equals('A L')
      expect(await page(`?forTeam=${f.teamA}`)).equals('Alex Lee')
      expect(await page(`?forTeam=${f.standaloneTeam}`)).equals('A L')
      await f.h.db
        .deleteFrom('memberships')
        .where('user_id', '=', userIdOfGumbo(ALEX))
        .where('team_id', '=', f.teamB)
        .execute()
    })

    it('names a level list and a people search with no single team', async function () {
      await privacy(f.teamA, 'initials')
      // The league's admin reads Alex in full, the public format beside it.
      expect(await name(`/leagues/${f.leagueA}/people`, 101)).include(
        '"shortName":"Alex Lee","nameFormat":"full","compactName":"A L"'
      )
      await f.h.db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: userIdOfGumbo(103),
          related_user_id: userIdOfGumbo(ALEX),
          kind: 'guardian'
        })
        .execute()
      // A guardian reads their child in full.
      expect(await name('/users?guardedBy=me', 103)).include(
        '"shortName":"Alex Lee"'
      )
      // No tile label beside it: the tile's colour is the id's.
      expect(await name('/users?guardedBy=me', 103)).not.include('publicName')
      await f.h.db
        .deleteFrom('user_links')
        .where('related_user_id', '=', userIdOfGumbo(ALEX))
        .execute()
    })

    it('splits a player by their team or by their teams now', async function () {
      await privacy(f.teamA, 'initials')
      const person = {
        id: userIdOfGumbo(ALEX),
        firstName: 'Alex',
        lastName: 'Lee',
        displayName: 'Alex Lee'
      }
      const [named] = await publicNames(f.h.db, [{ person }]).then(names => [
        names.get(person.id)
      ])
      expect(named).equals('A L')
      await privacy(f.teamB, 'full')
      expect(
        (await publicNames(f.h.db, [{ person, teamId: f.teamB }])).get(
          person.id
        )
      ).equals('Alex Lee')
      expect(
        (await publicNames(f.h.db, [{ person, player: false }])).get(person.id)
      ).equals('Alex L')
    })

    it('writes stats in the team of each row', async function () {
      await f.h.db
        .insertInto('game_player_stats')
        .values({
          id: makeId('gamePlayerStats'),
          game_id: gameId,
          gumbo_id: ALEX,
          team_id: f.teamA,
          pa: 1,
          ab: 1,
          h: 1,
          singles: 1
        })
        .execute()
      await privacy(f.teamA, 'initialLast')
      await f.h.db
        .updateTable('games')
        .set({ season_id: f.seasonA })
        .where('id', '=', gameId)
        .execute()
      expect(await name(`/games/${gameId}/box-score`, TEAMMATE)).include(
        '"shortName":"A Lee"'
      )
      expect(await name(`/teams/${f.teamA}/stats`, TEAMMATE)).include(
        '"shortName":"A Lee"'
      )
      // The scorekeeper and the league's admin read the box score and the
      // stats in full.
      expect(await name(`/games/${gameId}/box-score`, SCORER)).include(
        '"shortName":"Alex Lee"'
      )
      // So is its playback, its replay documents the public's with whom he
      // reads in full beside them; its board, the public timeline, is not.
      const playback = await name(
        `/games/${gameId}/box-score?view=playback`,
        SCORER
      )
      expect(playback).include(`"readerNames":{"${ALEX}":"Alex Lee"`)
      expect(playback).not.include('"fullName":"Alex Lee"')
      expect(
        await name(`/games/${gameId}/box-score?view=playback`, TEAMMATE)
      ).not.include('Alex Lee')
      const board = await name(`/games/${gameId}/box-score?view=board`, SCORER)
      expect(board).include('A Lee')
      expect(board).not.include('Alex Lee')
      expect(
        await name(`/games/${gameId}/box-score?view=line`, SCORER)
      ).not.include('Alex Lee')
      expect(await name(`/teams/${f.teamA}/stats`, SCORER)).include(
        '"shortName":"Alex Lee"'
      )
      expect(await name(`/seasons/${f.seasonA}/stats`, 101)).include(
        '"shortName":"Alex Lee"'
      )
    })

    it("leaves a withdrawn player's placeholder whole", async function () {
      await privacy(f.teamA, 'initials')
      const key = withdrawnKey('grq_privacy', gameId)
      const person = { id: key, firstName: 'Demo Hawks A', displayName: '' }
      expect(
        (await publicNames(f.h.db, [{ person, teamId: f.teamA }])).get(key)
      ).equals('Demo Hawks A')
    })

    it('writes the player in guardian mail and its notification', async function () {
      await privacy(f.teamA, 'full')
      const email = 'parent.privacy@example.test'
      const answer = await f.h.request(
        'POST',
        '/relationship-requests',
        {
          kind: 'guardian',
          playerUserId: userIdOfGumbo(ALEX),
          guardian: { email },
          sender: { kind: 'team', id: f.teamA },
          idempotencyKey: 'privacy-guardian-1'
        },
        101
      )
      expect(answer.status, await answer.clone().text()).lessThan(300)
      expect(JSON.stringify(f.h.invitations.get(email))).include('Alex Lee')
    })

    it('writes the player in copy that names them with no team', async function () {
      await privacy(f.teamA, 'initials')
      await f.h.db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: userIdOfGumbo(103),
          related_user_id: userIdOfGumbo(ALEX),
          kind: 'guardian'
        })
        .execute()
      const answer = await f.h.request(
        'POST',
        '/relationship-requests',
        {
          kind: 'guardian',
          playerUserId: userIdOfGumbo(ALEX),
          guardian: { userId: userIdOfGumbo(STRANGER) },
          sender: { kind: 'team', id: f.teamA },
          idempotencyKey: 'privacy-guardian-2'
        },
        101
      )
      expect(await answer.text()).include('A L has a guardian already')
      await f.h.db
        .deleteFrom('user_links')
        .where('related_user_id', '=', userIdOfGumbo(ALEX))
        .execute()
    })

    it('writes a notice in the teams the player plays for', async function () {
      await privacy(f.teamA, 'initials')
      const user = userIdOfGumbo(ALEX)
      expect((await shortNamesOf(f.h.db, [user])).get(user)).equals('A L')
      expect((await shortNamesOf(f.h.db, [])).size).equals(0)
    })

    it('writes a roster candidate in the format they play in', async function () {
      await privacy(f.teamB, 'initials')
      // Initials hide both halves: typed whole, they find the row, and
      // either alone finds nothing.
      for (const q of ['Riley', 'Chen'])
        expect(
          await name(`/users?forTeam=${f.teamA}&q=${q}`, SCORER),
          q
        ).equals('[]')
      const found = await name(
        `/users?forTeam=${f.teamA}&q=Riley%20Chen`,
        SCORER
      )
      expect(found).include('"shortName":"R C"')
      expect(found).include('"shortParts":{"first":"R","last":"C"}')
      // A site administrator reads every candidate in full.
      const admin = await name(`/users?forTeam=${f.teamA}&q=Riley`, 105)
      expect(admin).include('"shortName":"Riley Chen"')
      // The parts the add-to-roster form stores are the public label's.
      expect(admin).include('"shortParts":{"first":"R","last":"C"}')
    })

    it('keeps modelNames from a model', async function () {
      const said = await viaTess(`/games/${gameId}/events`, SCORER)
      expect(said).not.have.property('modelNames')
    })

    it('answers a change Tess made in a name a model may read', async function () {
      await privacy(f.teamA, 'full')
      const answer = await fetch(`${f.h.origin}/api/v1/relationship-requests`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${f.h.tokens.get(101)!}`,
          'content-type': 'application/json',
          [TESS_HEADER]: '1'
        },
        body: JSON.stringify({
          kind: 'guardian',
          playerUserId: userIdOfGumbo(ALEX),
          guardian: { email: 'tess.parent@example.test' },
          sender: { kind: 'team', id: f.teamA },
          idempotencyKey: 'privacy-guardian-3'
        })
      })
      expect(await answer.text()).not.include('Alex Lee')
      // The mail itself is for a person, and keeps the public name.
      expect(
        JSON.stringify(f.h.invitations.get('tess.parent@example.test'))
      ).include('Alex Lee')
    })

    it('keeps a survivor from reading wider for its new parents', async function () {
      const team = async (
        name: string,
        parent: { kind: 'league' | 'season'; id: string }
      ): Promise<string> =>
        (
          (await (
            await f.h.request(
              'POST',
              '/teams',
              {
                name,
                idempotencyKey: `privacy-${name}`,
                locality: demoLocality,
                parent
              },
              102
            )
          ).json()) as { id: string }
        ).id
      const survivor = await team('League Larks', {
        kind: 'league',
        id: f.leagueB
      })
      const closing = await team('Season Larks', {
        kind: 'season',
        id: f.seasonB
      })
      await f.h.db
        .updateTable('leagues')
        .set({ player_name_privacy: 'initials' })
        .where('id', '=', f.leagueB)
        .execute()
      await f.h.db
        .updateTable('seasons')
        .set({ player_name_privacy: 'full' })
        .where('id', '=', f.seasonB)
        .execute()
      await mergeTeams(f.h.db, {
        fromTeamId: closing,
        intoTeamId: survivor,
        apply: true
      })
      const reads = (await teamFormats(f.h.db, [survivor])).get(survivor)
      await f.h.db
        .updateTable('leagues')
        .set({ player_name_privacy: null })
        .where('id', '=', f.leagueB)
        .execute()
      await f.h.db
        .updateTable('seasons')
        .set({ player_name_privacy: null })
        .where('id', '=', f.seasonB)
        .execute()
      expect(reads).equals('initials')
    })

    it('merges a team on what it inherited, before its parents go', async function () {
      const team = async (name: string): Promise<string> =>
        (
          (await (
            await f.h.request(
              'POST',
              '/teams',
              {
                name,
                idempotencyKey: `privacy-${name}`,
                locality: demoLocality,
                parent: { kind: 'season', id: f.seasonB }
              },
              102
            )
          ).json()) as { id: string }
        ).id
      const closing = await team('Closing Comets')
      const survivor = await team('Surviving Comets')
      await f.h.db
        .updateTable('seasons')
        .set({ player_name_privacy: 'initials' })
        .where('id', '=', f.seasonB)
        .execute()
      await privacy(survivor, 'full')
      await mergeTeams(f.h.db, {
        fromTeamId: closing,
        intoTeamId: survivor,
        apply: true
      })
      const kept = await f.h.db
        .selectFrom('teams')
        .select('player_name_privacy')
        .where('id', '=', survivor)
        .executeTakeFirstOrThrow()
      expect(kept.player_name_privacy).equals('initials')
      await f.h.db
        .updateTable('seasons')
        .set({ player_name_privacy: null })
        .where('id', '=', f.seasonB)
        .execute()
    })

    it('labels a guest in the team they are added to', async function () {
      await privacy(f.teamA, 'initials')
      const person = await candidatePerson(
        f.h.db,
        f.teamA,
        userIdOfGumbo(RILEY)
      )
      expect(person.shortName).equals('R C')
      expect(person.nameFormat).equals('initials')
      await f.h.db
        .updateTable('games')
        .set({ guests: { [f.teamA]: [RILEY], [f.teamB]: [] } })
        .where('id', '=', gameId)
        .execute()
      const game = await f.h.db
        .selectFrom('games')
        .selectAll()
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
      const { guestPlayers } = await gameAvailability(f.h.db, game, {
        roster: false
      })
      const guest = [...guestPlayers.home, ...guestPlayers.away][0]
      expect(guest.shortName).equals('R C')
      expect(guest.nameFormat).equals('initials')
      await f.h.db
        .updateTable('games')
        .set({ guests: {} })
        .where('id', '=', gameId)
        .execute()
    })

    it('writes a player in a chat list', async function () {
      await privacy(f.teamA, 'initials')
      const space = { bucket: 'b', baseUrl: 'https://cdn.example.test' }
      const people = await chatPeople(f.h.db, space as never, [
        userIdOfGumbo(ALEX)
      ])
      expect(people.get(userIdOfGumbo(ALEX))?.shortName).equals('A L')
      const named = async (userId: number): Promise<string | undefined> =>
        (
          await chatPeople(f.h.db, space as never, [userIdOfGumbo(ALEX)], {
            reader: { userId: userIdOfGumbo(userId), isAdmin: false }
          })
        ).get(userIdOfGumbo(ALEX))?.shortName
      // The team's scorekeeper reads Alex in full; a teammate reads him short.
      expect(await named(SCORER)).equals('Alex Lee')
      expect(await named(TEAMMATE)).equals('A L')
    })

    it('writes a player in a DJ roster', async function () {
      await privacy(f.teamA, 'initials')
      expect(await name(`/games/${gameId}/dj`, TEAMMATE)).not.include('Alex')
      // The team's scorekeeper reads the batter in full.
      expect(await name(`/games/${gameId}/dj`, SCORER)).include(
        '"name":"Alex Lee"'
      )
    })

    it('takes the stricter team of a player on both sides of an event', async function () {
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userIdOfGumbo(ALEX),
          team_id: f.teamB,
          role: 'member',
          is_player: true
        })
        .execute()
      await f.h.db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: userIdOfGumbo(103),
          related_user_id: userIdOfGumbo(ALEX),
          kind: 'guardian'
        })
        .execute()
      await privacy(f.teamA, 'full')
      await privacy(f.teamB, 'initials')
      const info = await name(`/events/${gameId}/info`, TEAMMATE)
      // Their guardian reads them in full.
      const guardian = await name(`/events/${gameId}/info`, 103)
      await f.h.db
        .deleteFrom('user_links')
        .where('related_user_id', '=', userIdOfGumbo(ALEX))
        .execute()
      await f.h.db
        .deleteFrom('memberships')
        .where('user_id', '=', userIdOfGumbo(ALEX))
        .where('team_id', '=', f.teamB)
        .execute()
      expect(info).include('"A L"')
      expect(info).not.include('Alex Lee')
      expect(guardian).include('"Alex Lee"')
    })

    it('writes a player in the umpire list, and the adults as they were', async function () {
      await privacy(f.teamA, 'initials')
      await f.h.db
        .insertInto('league_umpires')
        .values({
          league_id: f.leagueA,
          user_id: userIdOfGumbo(ALEX),
          granted_by: userIdOfGumbo(101)
        })
        .execute()
      const list = JSON.stringify(await umpirePeople(f.h.db, f.leagueA))
      // The league's admin reads the list with Alex in full.
      const admin = JSON.stringify(
        await umpirePeople(f.h.db, f.leagueA, undefined, undefined, {
          userId: userIdOfGumbo(101),
          isAdmin: false
        })
      )
      await f.h.db
        .deleteFrom('league_umpires')
        .where('user_id', '=', userIdOfGumbo(ALEX))
        .execute()
      expect(list).include('"A L"')
      expect(list).not.include('Alex L"')
      expect(admin).include('"Alex Lee"')
    })

    it("tells a guardian's Tess context the format of their child", async function () {
      await privacy(f.teamA, 'initials')
      await f.h.db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: userIdOfGumbo(103),
          related_user_id: userIdOfGumbo(ALEX),
          kind: 'guardian'
        })
        .execute()
      const context = await userContext(f.h.db, userIdOfGumbo(103), false)
      await f.h.db
        .deleteFrom('user_links')
        .where('related_user_id', '=', userIdOfGumbo(ALEX))
        .execute()
      expect(JSON.stringify(context)).include('"name":"A L"')
    })

    it('leaves a repeated value alone', async function () {
      await privacy(f.teamA, 'initials')
      const before = await f.h.db
        .selectFrom('teams')
        .select('updated_at')
        .where('id', '=', f.teamA)
        .executeTakeFirstOrThrow()
      await f.h.request(
        'PUT',
        `/groups/team/${f.teamA}`,
        { playerNamePrivacy: 'initials' },
        101
      )
      expect(
        await f.h.db
          .selectFrom('teams')
          .select('updated_at')
          .where('id', '=', f.teamA)
          .executeTakeFirstOrThrow()
      ).deep.equals(before)
    })

    it('names another league administrator in full to a league administrator, and short to everybody else', async function () {
      const jeter = 7301
      const { db, tokens } = f.h
      await insertFixtureUsers(db, {
        id: jeter,
        legacyId: 'usr_privacy_jeter',
        display_name: 'Derek Jeter',
        first_name: 'Derek',
        last_name: 'Jeter',
        login_enabled: true
      })
      tokens.set(
        jeter,
        (await createSession(db, userIdOfGumbo(jeter), 'privacy')).token
      )
      await db
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(jeter),
          scope_type: 'league',
          scope_id: f.leagueA,
          role: 'admin',
          granted_by: userIdOfGumbo(101),
          granted_at: new Date()
        })
        .execute()
      // League B's administrator and Ichiro are plain members of League A.
      await db
        .insertInto('league_members')
        .values(
          [102, 104].map(id => ({
            id: makeId('leagueMember'),
            user_id: userIdOfGumbo(id),
            league_id: f.leagueA,
            joined_at: new Date()
          }))
        )
        .execute()
      const people = `/leagues/${f.leagueA}/people`
      for (const reader of [101, jeter, 105])
        expect(await name(people, reader), String(reader)).include(
          '"shortName":"Derek Jeter"'
        )
      for (const reader of [102, 104]) {
        const read = await name(people, reader)
        expect(read, String(reader)).include('"shortName":"Derek J"')
        expect(read, String(reader)).not.include('Jeter')
      }
      // The profile opened from the list, as it was: in full for the
      // administrator who manages the league's people, and for himself.
      const profile = async (reader: number): Promise<unknown> =>
        (
          (await (
            await f.h.request(
              'GET',
              `${people}/${userIdOfGumbo(jeter)}`,
              undefined,
              reader
            )
          ).json()) as { person: { fullName: unknown } }
        ).person.fullName
      expect(await profile(101)).equals('Derek Jeter')
      expect(await profile(jeter)).equals('Derek Jeter')
      // Nothing that leaves the reader carries what a league administrator
      // reads: a model's read of the list, nor guardian mail.
      const spoken = JSON.stringify(await viaTess(people, 101))
      expect(spoken).not.include('Derek Jeter')
      expect(spoken).not.include('Alex Lee')
      const email = 'parent.leagueadmin@example.test'
      const answer = await f.h.request(
        'POST',
        '/relationship-requests',
        {
          kind: 'guardian',
          playerUserId: userIdOfGumbo(ALEX),
          guardian: { email },
          sender: { kind: 'team', id: f.teamA },
          idempotencyKey: 'privacy-guardian-league-admin'
        },
        101
      )
      expect(answer.status, await answer.clone().text()).lessThan(300)
      const mail = JSON.stringify(f.h.invitations.get(email))
      expect(mail).include('Alex L')
      expect(mail).not.include('Alex Lee')
      // The request's stored snapshot carries no name the sender read.
      const stored = await db
        .selectFrom('notification_events')
        .select('metadata')
        .where('source_type', '=', 'groupRequest')
        .execute()
      expect(JSON.stringify(stored)).not.include('Alex Lee')
    })

    it('writes a person profile and a split in the team', async function () {
      await privacy(f.teamA, 'initialLast')
      // The profile is for those who manage the team, who read Alex in full.
      expect(
        await name(`/teams/${f.teamA}/people/${userIdOfGumbo(ALEX)}`, 101)
      ).include('"shortName":"Alex Lee"')
      // With the public format it is written in, which the board strip
      // prints whole.
      expect(await name(`/teams/${f.teamA}/roster`, 101)).include(
        '"compactName":"A Lee","compactFormat":"initialLast"'
      )
    })
  })

  it('tells the open screens of an affected game', async function () {
    expect(await gamesAround(f.h.db, [f.teamB], new Date())).include(gameId)
    expect(await gamesAround(f.h.db, [], new Date())).deep.equals([])
    const later = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
    expect(await gamesAround(f.h.db, [f.teamB], later)).not.include(gameId)
  })

  it('tells a level above what changed', async function () {
    const put = await f.h.request(
      'PUT',
      `/groups/league/${f.leagueB}`,
      { playerNamePrivacy: 'initials' },
      102
    )
    expect(put.status).equals(200)
    await boardShows('R C')
    await f.h.db
      .updateTable('leagues')
      .set({ player_name_privacy: null })
      .where('id', '=', f.leagueB)
      .execute()
  })
})
