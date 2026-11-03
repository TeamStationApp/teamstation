import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import express from 'express'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client } from 'pg'

import type { GameChange } from '../../common/gameSocket'
import { asPostEventsBody } from '../../common/gumboPlay'
import type { PlayerAddTerms } from '../../common/notifications'
import { applyPlayEdits } from '../../common/playEdits'
import { asNewRosterPlayer } from '../../common/playerSettings'
import type { StoredGame } from '../../common/scoring/session'
import { asTeamPlayersBody } from '../../common/teamMembers'
import { userIdOfGumbo } from '../../common/userId'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { scratchDatabase } from '../../test/scoreboardKit'
import { deleteAccount } from '../account/deleteAccount'
import { mergeTeams } from '../admin/mergeTeams'
import { closeInto } from '../admin/people'
import { createSession } from '../auth/sessions'
import { PostgresFeed } from '../changeFeed/postgresFeed'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { postGamePlays } from '../events/postPlays'
import { createGuestPlayer, renameGuestPlayer } from '../games/guestPlayers'
import {
  applyPlayerAdd,
  decidePlayerAdd,
  playerAddPolicy,
  recordPlayerAdd
} from '../groups/noticePolicy'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { accountRoutes } from '../routes/account'
import { eventRoutes } from '../routes/events'
import { groupRoutes } from '../routes/groups'
import { onboardingRoutes } from '../routes/onboarding'
import { playerRoutes } from '../routes/players'
import { addPlayers } from '../teams/addPlayers'
import { GameFanout } from './fanout'
import { GAME_CHANGES_CHANNEL, notifyLiveGamesRenamed } from './gameChanges'

type PlaysChange = Extract<GameChange, { kind: 'playEdits' }>

/**
 * A game's viewers are sent only the plays each post wrote, so whatever
 * renames its players without posting has them read the game again: a guest
 * renamed in any game, a person renaming themselves or renamed by a roster
 * manager, an account deleted, two people merged, a team's name format
 * changed above it, two teams merged, and a player add rejected, which names
 * them by a placeholder. Only games in progress are told.
 */
describe('renames told to the games they name', function () {
  this.timeout(60_000)

  let db: Kysely<Database>
  let url: string
  let drop: (() => Promise<void>) | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''

  const HOME = 'tem_rn_home'
  const AWAY = 'tem_rn_away'
  const OTHER = 'tem_rn_other'
  const FAR = 'tem_rn_far'
  /** HOME at AWAY, in progress. */
  const LIVE = 'gam_rn_live'
  /** OTHER at FAR, in progress: the member plays in it as a pool player. */
  const BORROWED = 'gam_rn_borrowed'
  /** HOME at OTHER, over. */
  const DONE = 'gam_rn_done'
  /** OTHER at FAR, in progress, naming nobody of HOME's. */
  const ELSEWHERE = 'gam_rn_elsewhere'
  const member = { gumboId: 8_200_001, userId: userIdOfGumbo(8_200_001) }
  const newcomer = { gumboId: 8_200_002, userId: userIdOfGumbo(8_200_002) }
  const admin = { gumboId: 8_200_003, userId: userIdOfGumbo(8_200_003) }
  const tokens = new Map<string, string>()

  before(async function () {
    ;({ db, url, drop } = await scratchDatabase('renamenotices'))
    const now = new Date()
    await insertFixtureUsers(db, [
      { id: member.gumboId, display_name: 'Babe Ruth', login_enabled: true },
      {
        id: newcomer.gumboId,
        display_name: 'Newcomer',
        login_enabled: true,
        onboarding_step: 'name'
      },
      {
        id: admin.gumboId,
        display_name: 'Site Admin',
        login_enabled: true,
        is_admin: true
      }
    ])
    await db
      .insertInto('teams')
      .values(
        [HOME, AWAY, OTHER, FAR].map(id => ({ id, name: id, kind: 'full' }))
      )
      .execute()
    await db
      .insertInto('memberships')
      .values([
        {
          id: 'mem_rn_member',
          user_id: member.userId,
          team_id: HOME,
          is_player: true,
          joined_at: now
        },
        {
          id: 'mem_rn_newcomer',
          user_id: newcomer.userId,
          team_id: AWAY,
          is_player: true,
          joined_at: now
        }
      ])
      .execute()
    await db
      .insertInto('games')
      .values(
        [
          [LIVE, HOME, AWAY, 'inProgress'],
          [BORROWED, OTHER, FAR, 'inProgress'],
          [DONE, HOME, OTHER, 'final'],
          [ELSEWHERE, OTHER, FAR, 'inProgress']
        ].map(([id, home, away, status]) => ({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: now,
          status: status as 'inProgress' | 'final'
        }))
      )
      .execute()
    // The member bats in a game of two other teams.
    const event = await db
      .insertInto('events')
      .values({
        id: 'evt_rn_borrowed',
        gameId: BORROWED,
        startTime: null,
        endTime: null,
        battingTeamId: OTHER,
        gumbo: {
          about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
          result: { eventType: 'single' },
          matchup: { batter: { id: member.gumboId } }
        },
        titleOverride: null,
        createdAt: now,
        updatedAt: now
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const named = await db
      .selectFrom('event_players')
      .select('id')
      .where('event_id', '=', event.id)
      .execute()
    if (named.length === 0)
      await db
        .insertInto('event_players')
        .values({
          id: 'evp_rn_borrowed',
          event_id: event.id,
          gumbo_id: member.gumboId,
          team_id: OTHER,
          role: 'batter',
          position: null
        })
        .execute()
    // Organization setup is done, so a group's settings may change.
    await sql`insert into system_settings (key, value)
      values ('creation.hierarchyReady', 'true')`.execute(db)
    for (const person of [member, newcomer, admin])
      tokens.set(
        person.userId,
        (await createSession(db, person.userId, 'rename-notices')).token
      )
    const media: MediaContext = {
      mediaRoot: mkdtempSync(join(tmpdir(), 'tsRenameNotices-')),
      ffmpegPath: 'ffmpeg',
      mediaSecret: 'secret',
      publicUrl: 'http://127.0.0.1',
      space: {
        endpoint: '',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        pathStyle: true
      }
    }
    const app = express()
    // Signed in first, as the server is: a group's body can hold a picture.
    app.use(withActor(db))
    app.use(jsonBody)
    app.use('/api/v1', groupRoutes(db, media))
    app.use('/api/v1', eventRoutes(db))
    app.use('/api/v1', playerRoutes(db, media))
    app.use(
      '/api/v1',
      onboardingRoutes(db, { ffmpegPath: media.ffmpegPath, space: media.space })
    )
    app.use(
      '/api/v1',
      accountRoutes(db, {
        ffmpegPath: media.ffmpegPath,
        space: media.space,
        sendCode: async () => undefined,
        publicUrl: 'http://127.0.0.1'
      })
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    const listening = server
    if (listening != null)
      await new Promise(resolve => listening.close(resolve))
    await drop?.()
  })

  /** The games told to read their plays again while `act` runs, sorted. */
  const toldDuring = async (act: () => Promise<unknown>): Promise<string[]> => {
    const listener = new Client({ connectionString: url })
    await listener.connect()
    const games: string[] = []
    listener.on('notification', message => {
      const payload = JSON.parse(message.payload ?? 'null') as {
        game?: string
        kind?: string
        fromDigest?: string
      } | null
      if (
        payload?.kind === 'playEdits' &&
        payload.fromDigest == null &&
        payload.game != null
      )
        games.push(payload.game)
    })
    try {
      await listener.query(`listen ${GAME_CHANGES_CHANNEL}`)
      await act()
      await listener.query('select 1')
      return games.sort()
    } finally {
      await listener.end()
    }
  }

  const call = async (
    as: string,
    method: string,
    path: string,
    body: unknown
  ): Promise<number> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens.get(as)}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    const text = await response.text()
    // The answer, on a failure, says why.
    if (response.status !== 200) expect(text, path).equals('')
    return response.status
  }

  /** A play in `gameId` that `teamId` bats in, naming `gumboId` at bat. */
  const playIn = async (
    gameId: string,
    teamId: string,
    gumboId: number,
    id: string
  ): Promise<void> => {
    const now = new Date()
    await db
      .insertInto('events')
      .values({
        id,
        gameId,
        startTime: null,
        endTime: null,
        battingTeamId: teamId,
        gumbo: {
          about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
          result: { eventType: 'single' },
          matchup: { batter: { id: gumboId } }
        },
        titleOverride: null,
        createdAt: now,
        updatedAt: now
      })
      .execute()
    const named = await db
      .selectFrom('event_players')
      .select('id')
      .where('event_id', '=', id)
      .execute()
    if (named.length === 0)
      await db
        .insertInto('event_players')
        .values({
          id: `evp_${id}`,
          event_id: id,
          gumbo_id: gumboId,
          team_id: teamId,
          role: 'batter',
          position: null
        })
        .execute()
  }

  /** The name a play gives its batter. */
  const batterOf = (gumbo: unknown): string =>
    (gumbo as { matchup: { batter: { fullName: string } } }).matchup.batter
      .fullName

  /**
   * A game's plays as a replay holds them, read as `GET
   * /games/:gameId/events` answers them, and the name of the first play's
   * batter.
   */
  const readReplay = async (
    gameId: string
  ): Promise<StoredGame & { batter: string }> => {
    const response = await fetch(`${base}/games/${gameId}/events`, {
      headers: { authorization: `Bearer ${tokens.get(admin.userId)}` }
    })
    expect(response.status).equals(200)
    const answer = (await response.json()) as {
      plays: Array<{ gumbo: unknown }>
      currentPlay: unknown
      playsDigest: string
      namesDigest: string
      generation: number
    }
    return {
      plays: answer.plays.map(row => row.gumbo) as StoredGame['plays'],
      currentPlay: answer.currentPlay as StoredGame['currentPlay'],
      playsDigest: answer.playsDigest,
      namesDigest: answer.namesDigest,
      generation: answer.generation,
      batter: batterOf(answer.plays[0].gumbo)
    }
  }

  /**
   * Which games were told while `act` ran, and the plays change a viewer
   * watching `game` through a fanout was sent for it: told to read again,
   * unless `reread` is false, as for a pitch.
   */
  const watching = async (
    game: { id: string; home: string; away: string },
    act: () => Promise<unknown>,
    reread = true
  ): Promise<{ told: string[]; change: PlaysChange }> => {
    const feed = new PostgresFeed({
      databaseUrl: url,
      retryMs: 50,
      log: () => undefined
    })
    const fanout = new GameFanout({
      db,
      feed,
      coalesceMs: 10,
      authorize: async subscribers => subscribers.map(() => true)
    })
    const sent: GameChange[] = []
    try {
      await fanout.listening
      fanout.watch(
        game.id,
        { homeTeamId: game.home, awayTeamId: game.away, seasonId: null },
        {
          send: message => sent.push(message),
          token: 'token',
          userId: admin.userId,
          signedOut: () => undefined,
          resync: () => undefined
        }
      )
      const told = await toldDuring(act)
      const deadline = Date.now() + 5000
      while (
        !sent.some(message => message.kind === 'playEdits') &&
        Date.now() < deadline
      )
        await new Promise(resolve => setTimeout(resolve, 20))
      if (reread) expect(told, 'told').includes(game.id)
      const change = sent.find(
        (message): message is PlaysChange => message.kind === 'playEdits'
      )
      expect(change, 'a plays change').not.equals(undefined)
      return { told, change: change! }
    } finally {
      await fanout.close()
      await feed.close()
    }
  }

  it('tells every game in progress a person plays in, by membership or by play, and a team’s', async function () {
    expect(
      await toldDuring(async () => {
        await notifyLiveGamesRenamed(db, { users: [member.userId] })
      })
    ).deep.equals([BORROWED, LIVE])
    expect(
      await toldDuring(async () => {
        await notifyLiveGamesRenamed(db, { teams: [FAR] })
      })
    ).deep.equals([BORROWED, ELSEWHERE])
    expect(
      await toldDuring(async () => {
        await notifyLiveGamesRenamed(db, {})
      })
    ).deep.equals([])
  })

  it('tells them when a person renames themselves, in Account and in onboarding', async function () {
    expect(
      await toldDuring(async () => {
        expect(
          await call(member.userId, 'PUT', '/me/account/name', {
            displayName: 'George Ruth'
          })
        ).equals(200)
      })
    ).deep.equals([BORROWED, LIVE])
    expect(
      await toldDuring(async () => {
        expect(
          await call(newcomer.userId, 'PUT', '/me/onboarding/name', {
            displayName: 'Cy Young'
          })
        ).equals(200)
      })
    ).deep.equals([LIVE])
  })

  it('tells them when a roster manager renames a player, and not for a jersey', async function () {
    const path = `/teams/${HOME}/players/${member.userId}/settings`
    expect(
      await toldDuring(async () => {
        expect(
          await call(admin.userId, 'PUT', path, {
            name: { firstName: 'Babe', lastName: 'Ruth' }
          })
        ).equals(200)
      })
    ).deep.equals([BORROWED, LIVE])
    expect(
      await toldDuring(async () => {
        expect(await call(admin.userId, 'PUT', path, { jersey: '3' })).equals(
          200
        )
      })
    ).deep.equals([])
  })

  it('tells them when a person deletes their account, and is named a deleted user', async function () {
    const gone = { gumboId: 8_200_004, userId: userIdOfGumbo(8_200_004) }
    await insertFixtureUsers(db, [
      { id: gone.gumboId, display_name: 'Leaving Soon', login_enabled: true }
    ])
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_rn_gone',
        user_id: gone.userId,
        team_id: AWAY,
        is_player: true,
        joined_at: new Date()
      })
      .execute()
    expect(
      await toldDuring(async () => {
        await deleteAccount(db, gone.userId)
      })
    ).deep.equals([LIVE])
  })

  it('tells the games either person plays in when one is merged into the other', async function () {
    const closing = { gumboId: 8_200_005, userId: userIdOfGumbo(8_200_005) }
    const keeping = { gumboId: 8_200_006, userId: userIdOfGumbo(8_200_006) }
    await insertFixtureUsers(db, [
      {
        id: closing.gumboId,
        display_name: 'Lou Gehrig',
        first_name: 'Lou',
        last_name: 'Gehrig'
      },
      { id: keeping.gumboId, display_name: 'Lou', first_name: 'Lou' }
    ])
    // The closing row plays for FAR, the kept one for HOME.
    await db
      .insertInto('memberships')
      .values([
        {
          id: 'mem_rn_closing',
          user_id: closing.userId,
          team_id: FAR,
          is_player: true,
          joined_at: new Date()
        },
        {
          id: 'mem_rn_keeping',
          user_id: keeping.userId,
          team_id: HOME,
          is_player: true,
          joined_at: new Date()
        }
      ])
      .execute()
    expect(
      await toldDuring(async () => {
        expect(
          (await closeInto(db, closing.userId, keeping.userId)).closed
        ).equals(true)
      })
    ).deep.equals([BORROWED, ELSEWHERE, LIVE])
    // The survivor took the fuller name.
    expect(
      (
        await db
          .selectFrom('users')
          .select('display_name')
          .where('id', '=', keeping.userId)
          .executeTakeFirstOrThrow()
      ).display_name
    ).equals('Lou Gehrig')
  })

  it('tells nothing for an import, which writes no existing player’s name', async function () {
    const actor = { userId: admin.userId, isAdmin: true, scopes: [] }
    const row = (
      firstName: string
    ): ReturnType<typeof asTeamPlayersBody>['players'] =>
      asTeamPlayersBody({
        players: [
          {
            externalId: { system: 'league', kind: 'player', id: 'rn-import' },
            firstName,
            lastName: 'Import',
            bats: 'left'
          }
        ]
      }).players
    expect(
      await toldDuring(async () => {
        expect(
          (await addPlayers(db, actor, HOME, row('First'))).results[0].result
        ).equals('created')
      })
    ).deep.equals([])
    // Imported again under another name, the person keeps theirs: only
    // their hands are an import's to write.
    let userId: string | undefined
    expect(
      await toldDuring(async () => {
        const again = await addPlayers(db, actor, HOME, row('Second'))
        const [result] = again.results
        if (result.result !== 'error') userId = result.userId
      })
    ).deep.equals([])
    expect(
      (
        await db
          .selectFrom('users')
          .select('display_name')
          .where('id', '=', userId!)
          .executeTakeFirstOrThrow()
      ).display_name
    ).equals('First Import')
  })

  it('tells the games in progress of every team a name format change reaches', async function () {
    expect(
      await toldDuring(async () => {
        expect(
          await call(admin.userId, 'PUT', `/groups/team/${FAR}`, {
            playerNamePrivacy: 'initials'
          })
        ).equals(200)
      })
    ).deep.equals([BORROWED, ELSEWHERE])
  })

  it('has a held replay read a guest renamed mid-game again, and shows the new name', async function () {
    const actor = { userId: admin.userId, isAdmin: true, scopes: [] }
    const guest = await createGuestPlayer(
      db,
      actor,
      LIVE,
      'home',
      asNewRosterPlayer({
        firstName: 'Christy',
        lastName: 'Mathewson',
        jersey: '',
        bats: 'right',
        throws: 'right',
        positions: []
      })
    )
    // A play naming the guest, and the game as a viewer holds it.
    await postGamePlays(
      db,
      LIVE,
      asPostEventsBody({
        mode: 'live',
        source: { system: 'manual' },
        plays: [
          {
            about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
            result: { eventType: 'single', awayScore: 0, homeScore: 0 },
            matchup: {
              batter: { id: guest.gumboId, fullName: 'Stale' },
              pitcher: { id: member.gumboId, fullName: 'Stale' }
            }
          }
        ]
      })
    )
    const held = await readReplay(LIVE)
    expect(held.batter).equals('Christy M')

    const { told, change } = await watching(
      { id: LIVE, home: HOME, away: AWAY },
      async () => {
        await renameGuestPlayer(db, actor, LIVE, guest.userId, {
          firstName: 'Walter',
          lastName: 'Johnson'
        })
      }
    )
    // Told once, by both notices.
    expect(told).deep.equals([LIVE])
    // Nothing to apply: the replay reads the game again, renamed.
    expect(applyPlayEdits(held, change.data)).equals(null)
    expect((await readReplay(LIVE)).batter).equals('Walter J')
  })

  it('tells every other game in progress a renamed guest plays in, and the game edited with no play of theirs yet', async function () {
    const actor = { userId: admin.userId, isAdmin: true, scopes: [] }
    const guest = await createGuestPlayer(
      db,
      actor,
      LIVE,
      'away',
      asNewRosterPlayer({
        firstName: 'Mordecai',
        lastName: 'Brown',
        jersey: '',
        bats: 'right',
        throws: 'right',
        positions: []
      })
    )
    // Added to another game too, and named by a play there.
    await playIn(ELSEWHERE, FAR, guest.gumboId!, 'evt_rn_guest_elsewhere')
    expect(
      await toldDuring(async () => {
        await renameGuestPlayer(db, actor, LIVE, guest.userId, {
          firstName: 'Three Finger',
          lastName: 'Brown'
        })
      })
    ).deep.equals([ELSEWHERE, LIVE])
  })

  it('has a held replay read a game again when a player add is rejected mid-game, and shows the placeholder', async function () {
    const CLUB = 'tem_rn_club'
    const RIVAL = 'tem_rn_rival'
    const JUNIOR = 'gam_rn_junior'
    const kid = { gumboId: 8_200_007, userId: userIdOfGumbo(8_200_007) }
    const clock = { now: () => new Date() }
    await insertFixtureUsers(db, [
      {
        id: kid.gumboId,
        display_name: 'Kid Rookie',
        first_name: 'Kid',
        last_name: 'Rookie',
        login_enabled: true
      }
    ])
    await db
      .insertInto('teams')
      .values([CLUB, RIVAL].map(id => ({ id, name: id, kind: 'full' })))
      .execute()
    // RIVAL hosts CLUB, under way.
    await db
      .insertInto('games')
      .values({
        id: JUNIOR,
        home_team_id: RIVAL,
        away_team_id: CLUB,
        start_at: new Date(),
        status: 'inProgress'
      })
      .execute()
    const requestId = await atomic(db, async trx => {
      const terms: PlayerAddTerms = {
        kind: 'playerAdd',
        mode: 'roster',
        userId: kid.userId,
        teamId: CLUB,
        jersey: '7',
        positions: [],
        teamName: CLUB
      }
      expect(await playerAddPolicy(trx, kid.userId, CLUB)).equals('notice')
      return await recordPlayerAdd(
        trx,
        { userId: admin.userId, isAdmin: true, scopes: [] },
        await applyPlayerAdd(trx, terms),
        'applied',
        clock
      )
    })
    // The kid bats for CLUB, and a viewer holds the play by their name.
    await postGamePlays(
      db,
      JUNIOR,
      asPostEventsBody({
        mode: 'live',
        source: { system: 'manual' },
        plays: [
          {
            about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
            result: { eventType: 'single', awayScore: 0, homeScore: 0 },
            matchup: { batter: { id: kid.gumboId, fullName: 'Stale' } },
            // Put in play: the game is under way.
            playEvents: [{ isPitch: true, details: { isInPlay: true } }]
          }
        ]
      })
    )
    const held = await readReplay(JUNIOR)
    expect(held.batter).equals('Kid R')

    try {
      const { told, change } = await watching(
        { id: JUNIOR, home: RIVAL, away: CLUB },
        async () => {
          await atomic(db, async trx => {
            const request = await trx
              .selectFrom('group_requests')
              .selectAll()
              .where('id', '=', requestId!)
              .executeTakeFirstOrThrow()
            await decidePlayerAdd(
              trx,
              { userId: kid.userId, isAdmin: false, scopes: [] },
              request,
              'decline',
              clock
            )
          })
        }
      )
      expect(told).deep.equals([JUNIOR])
      // Nothing to apply: the replay reads the game again, under the
      // placeholder the rejection gave them.
      expect(applyPlayEdits(held, change.data)).equals(null)
      const { label } = await db
        .selectFrom('game_withdrawn_players')
        .select('label')
        .where('game_id', '=', JUNIOR)
        .where('user_id', '=', kid.userId)
        .executeTakeFirstOrThrow()
      expect((await readReplay(JUNIOR)).batter).equals(label)
    } finally {
      await db
        .updateTable('games')
        .set({ status: 'final' })
        .where('id', '=', JUNIOR)
        .execute()
    }
  })

  it('tells the games in progress of a team merged into another, and of the survivor', async function () {
    const FROM = 'tem_rn_from'
    const INTO = 'tem_rn_into'
    // Two opponents: one fixture of each team against the same one would be
    // a duplicate the merge folds into one.
    const RIVAL = 'tem_rn_merge_rival'
    const NEIGHBOR = 'tem_rn_merge_neighbor'
    await db
      .insertInto('teams')
      .values(
        [FROM, INTO, RIVAL, NEIGHBOR].map(id => ({
          id,
          name: id,
          kind: 'full'
        }))
      )
      .execute()
    // The survivor's privacy is the looser: the merge keeps the stricter.
    await db
      .updateTable('teams')
      .set({ player_name_privacy: 'initials' })
      .where('id', '=', FROM)
      .execute()
    // The survivor has an administrator of its own, as a merge requires.
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_rn_into_admin',
        user_id: admin.userId,
        team_id: INTO,
        role: 'manager',
        joined_at: new Date()
      })
      .execute()
    const now = new Date()
    await db
      .insertInto('games')
      .values(
        [
          ['gam_rn_moved', FROM, RIVAL, 'inProgress'],
          ['gam_rn_survivor', NEIGHBOR, INTO, 'inProgress'],
          ['gam_rn_moved_done', FROM, RIVAL, 'final']
        ].map(([id, home, away, status]) => ({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: now,
          status: status as 'inProgress' | 'final'
        }))
      )
      .execute()
    try {
      expect(
        await toldDuring(async () => {
          await mergeTeams(db, {
            fromTeamId: FROM,
            intoTeamId: INTO,
            apply: true
          })
        })
      ).deep.equals(['gam_rn_moved', 'gam_rn_survivor'])
    } finally {
      await db
        .updateTable('games')
        .set({ status: 'final' })
        .where('id', 'in', ['gam_rn_moved', 'gam_rn_survivor'])
        .execute()
    }
  })

  describe('a player named otherwise with nothing written', function () {
    /** The team the players appear for, holding them only by open adds. */
    const LEND = 'tem_rn_lend'
    /** A team of theirs that shows only initials. */
    const STRICT = 'tem_rn_strict'
    const HOST = 'tem_rn_host'
    const clock = { now: () => new Date() }

    before(async function () {
      await db
        .insertInto('teams')
        .values(
          [LEND, STRICT, HOST].map(id => ({ id, name: id, kind: 'full' }))
        )
        .execute()
      await db
        .updateTable('teams')
        .set({ player_name_privacy: 'initials' })
        .where('id', '=', STRICT)
        .execute()
    })

    /** Adds `userId` to `teamId`'s roster, held open for its side to reject. */
    const heldAdd = async (userId: string, teamId: string): Promise<string> =>
      await atomic(db, async trx => {
        const terms: PlayerAddTerms = {
          kind: 'playerAdd',
          mode: 'roster',
          userId,
          teamId,
          jersey: '',
          positions: [],
          teamName: teamId
        }
        const id = await recordPlayerAdd(
          trx,
          { userId: admin.userId, isAdmin: true, scopes: [] },
          await applyPlayerAdd(trx, terms),
          'applied',
          clock
        )
        expect(id, 'a hold').not.equals(null)
        return id!
      })

    /** A live pitch by `gumboId`, batting for LEND at `HOST`. */
    const pitch = async (
      gameId: string,
      gumboId: number,
      index: number
    ): Promise<void> => {
      await postGamePlays(
        db,
        gameId,
        asPostEventsBody({
          mode: 'live',
          source: { system: 'manual' },
          plays: [
            {
              about: { atBatIndex: index, inning: 1, halfInning: 'top' },
              result: { eventType: 'single', awayScore: 0, homeScore: 0 },
              matchup: { batter: { id: gumboId, fullName: 'Stale' } },
              playEvents: [{ isPitch: true, details: { isInPlay: true } }]
            }
          ]
        })
      )
    }

    /**
     * A game in progress of `HOST` against LEND in which `player`, lent to
     * LEND by an open add, has batted; `rename` changes their public format
     * without a write any notice follows; then the next pitch reaches a
     * replay holding the first read.
     */
    const heldAcross = async (
      gameId: string,
      player: { gumboId: number; userId: string },
      rename: () => Promise<void>
    ): Promise<{
      held: StoredGame & { batter: string }
      change: PlaysChange
      read: StoredGame & { batter: string }
    }> => {
      await db
        .insertInto('games')
        .values({
          id: gameId,
          home_team_id: HOST,
          away_team_id: LEND,
          start_at: new Date(),
          status: 'inProgress'
        })
        .execute()
      try {
        await heldAdd(player.userId, LEND)
        await pitch(gameId, player.gumboId, 0)
        const held = await readReplay(gameId)
        await rename()
        const { told, change } = await watching(
          { id: gameId, home: HOST, away: LEND },
          async () => {
            await pitch(gameId, player.gumboId, 1)
          },
          false
        )
        // No rename was told: the pitch came as edits, from what was held.
        expect(told).deep.equals([])
        expect(change.data.fromDigest).equals(held.playsDigest)
        return { held, change, read: await readReplay(gameId) }
      } finally {
        await db
          .updateTable('games')
          .set({ status: 'final' })
          .where('id', '=', gameId)
          .execute()
      }
    }

    it('has a held replay read again on the next pitch once a hold lapses mid-game', async function () {
      const player = { gumboId: 8_200_011, userId: userIdOfGumbo(8_200_011) }
      await insertFixtureUsers(db, [
        {
          id: player.gumboId,
          display_name: 'Pat Lapse',
          first_name: 'Pat',
          last_name: 'Lapse',
          login_enabled: true
        }
      ])
      // On STRICT too, by an add its side may still reject: not theirs yet,
      // so STRICT has no say in how they are named.
      const strict = await heldAdd(player.userId, STRICT)
      const { held, change, read } = await heldAcross(
        'gam_rn_lapse',
        player,
        async () => {
          // The window closes with nothing written: STRICT's format is
          // theirs. Time passes here as if it had been sent days ago.
          await db
            .updateTable('group_requests')
            .set({
              sent_at: new Date(Date.now() - 86_400_000),
              expires_at: new Date(Date.now() - 1000)
            })
            .where('id', '=', strict)
            .execute()
        }
      )
      expect(held.batter).equals('Pat L')
      // The new pitch is named by initials, the held play by more.
      const [put] = change.data.edits ?? []
      expect(put?.op).equals('put')
      const named = put?.op === 'put' ? batterOf(put.play.gumbo) : ''
      expect(named).not.equals('Pat L')
      expect(change.data.namesDigest).not.equals(held.namesDigest)
      // So the replay reads the game again, and every play reads alike.
      expect(applyPlayEdits(held, change.data)).equals(null)
      expect(read.batter).equals(named)
      expect(read.namesDigest).equals(change.data.namesDigest)
    })

    it('has a held replay read again on the next pitch once a lent player is added to a roster at once', async function () {
      const player = { gumboId: 8_200_012, userId: userIdOfGumbo(8_200_012) }
      await insertFixtureUsers(db, [
        {
          id: player.gumboId,
          display_name: 'Lee Added',
          first_name: 'Lee',
          last_name: 'Added',
          login_enabled: true
        }
      ])
      const { held, change, read } = await heldAcross(
        'gam_rn_added',
        player,
        async () => {
          // An add nobody may reject applies at once, holding nothing.
          await atomic(db, async trx => {
            await applyPlayerAdd(trx, {
              kind: 'playerAdd',
              mode: 'roster',
              userId: player.userId,
              teamId: STRICT,
              jersey: '',
              positions: [],
              teamName: STRICT
            })
          })
        }
      )
      expect(held.batter).equals('Lee A')
      expect(change.data.namesDigest).not.equals(held.namesDigest)
      expect(applyPlayEdits(held, change.data)).equals(null)
      expect(read.batter).not.equals('Lee A')
      expect(read.namesDigest).equals(change.data.namesDigest)
    })
  })
})
