import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import express from 'express'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import type { PlayerAddTerms } from '../../common/notifications'
import { placeholderTeamName } from '../../common/placeholderNames'
import { newSetup } from '../../common/scoring/lineup'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { MERGE_LOCK } from '../admin/people'
import { hashToken } from '../auth/tokens'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { gameAvailability } from '../games/rosterAvailability'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { playerRemovedWords } from '../notifications/requestInformation'
import { groupRoutes } from '../routes/groups'
import { notificationRoutes } from '../routes/notifications'
import { playerRoutes, teamsOf } from '../routes/players'
import { statsRoutes } from '../routes/stats'
import { teamRoutes } from '../routes/teams'
import { resolveScoringGame } from '../scoring/openRow'
import { battingLines } from '../stats'
import { statRows } from '../stats/rows'
import { addByPolicy } from '../teams/addExistingPlayer'
import { ensureGumboId, insertUser } from '../users/insertUser'
import { gameNames, gameNamesDigest } from '../users/nameBook'
import {
  applyPlayerAdd,
  decidePlayerAdd,
  NOTICE_DAYS,
  playerAddApprovers,
  playerAddPolicy,
  recordPlayerAdd,
  supersededPlayerAdd
} from './noticePolicy'

/**
 * Adds made with a notice, through the real routers.
 *
 * Mookie Betts plays for the Owls and has a guardian. Freddie Freeman plays
 * for the Owls with no guardian and signs in himself. Tony Kemp plays for the
 * Bears with neither, and the Bears' coach stands in. The coach coaches the
 * Falcons, who play the Herons in this season.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_notices_${process.pid}_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)
const DAY = 86_400_000

const TOKENS = {
  admin: 'tok_notice_admin_00000000000000000000',
  coach: 'tok_notice_coach_00000000000000000000',
  guardian: 'tok_notice_guardian_00000000000000000',
  freeman: 'tok_notice_freeman_000000000000000000',
  bearsCoach: 'tok_notice_bears_00000000000000000000',
  falcon: 'tok_notice_falcon_0000000000000000000',
  owl: 'tok_notice_owl_0000000000000000000000',
  muncy: 'tok_notice_muncy_00000000000000000000'
} as const

const TEAM = {
  falcons: 'tem_noticeFalcons',
  herons: 'tem_noticeHerons',
  owls: 'tem_noticeOwls',
  bears: 'tem_noticeBears',
  cubs: 'tem_noticeCubs'
}
const SEASON = 'sea_noticeFall'

describe('adds made with a notice', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  let now = new Date()
  const clock = { now: () => now }
  const ids: Record<string, string> = {}
  const gumbo: Record<string, number> = {}
  let gameNumber = 0

  async function person(
    name: string,
    options: { teamId?: string; login?: boolean; admin?: boolean } = {}
  ): Promise<string> {
    const [first, ...rest] = name.split(' ')
    const userId = await insertUser(db!, {
      display_name: name,
      first_name: first,
      last_name: rest.join(' '),
      login_enabled: options.login ?? false,
      is_admin: options.admin ?? false
    })
    gumbo[name] = await ensureGumboId(db!, userId)
    if (options.teamId != null)
      await db!
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: options.teamId,
          role: 'member',
          is_player: true
        })
        .execute()
    ids[name] = userId
    return userId
  }

  async function role(
    userId: string,
    teamId: string,
    held: 'coach' | 'admin'
  ): Promise<void> {
    await db!
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userId,
        scope_type: 'team',
        scope_id: teamId,
        role: held
      })
      .execute()
  }

  async function game(
    options: { startedAt?: Date; current?: boolean } = {}
  ): Promise<string> {
    const id = `gam_notice${++gameNumber}`
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: TEAM.falcons,
        away_team_id: TEAM.herons,
        season_id: SEASON,
        start_at: options.startedAt ?? now,
        status: 'scheduled',
        ...(options.current === true
          ? { currentPlay: JSON.stringify({ about: { atBatIndex: 0 } }) }
          : {})
      })
      .execute()
    return id
  }

  /** A line in a game for a side: two at-bats, one hit. */
  async function line(
    gameId: string,
    name: string,
    teamId: string
  ): Promise<void> {
    await db!
      .insertInto('game_player_stats')
      .values({
        id: makeId('gamePlayerStats'),
        game_id: gameId,
        gumbo_id: gumbo[name],
        team_id: teamId,
        pa: 2,
        ab: 2,
        h: 1,
        singles: 1
      })
      .execute()
  }

  /** A credited play for a person in a game: what their plays and clips read. */
  async function play(
    gameId: string,
    name: string,
    teamId: string
  ): Promise<void> {
    await db!
      .insertInto('events')
      .values({
        id: makeId('event'),
        gameId,
        startTime: now,
        battingTeamId: teamId,
        gumbo: {
          about: {
            atBatIndex: gameNumber * 10,
            inning: 1,
            halfInning: 'top',
            isScoringPlay: false,
            startTime: now
          },
          matchup: { batter: { id: gumbo[name] } },
          result: { eventType: 'single', awayScore: 0, homeScore: 0 },
          credits: [
            {
              eventType: 'single',
              label: `Single: ${name}`,
              teamId,
              creditUserId: gumbo[name],
              credit: { name, role: 'batter', position: null }
            }
          ]
        }
      })
      .execute()
  }

  /** What the M3 writes do: the policy, then the add and its record. */
  async function add(
    mode: 'roster' | 'pool',
    name: string,
    extra: Partial<PlayerAddTerms> = {}
  ): Promise<{ policy: 'notice' | 'approval'; requestId: string | null }> {
    return await atomic(db!, async trx => {
      const terms: PlayerAddTerms = {
        kind: 'playerAdd',
        mode,
        userId: ids[name],
        teamId: TEAM.falcons,
        jersey: '50',
        positions: ['RF'],
        teamName: 'Ridgeview Falcons',
        ...extra
      }
      const policy = await playerAddPolicy(trx, terms.userId, terms.teamId)
      if (policy === 'approval')
        return {
          policy,
          requestId: await recordPlayerAdd(
            trx,
            { userId: ids.coach, isAdmin: false, scopes: [] },
            terms,
            'pending',
            clock
          )
        }
      const applied = await applyPlayerAdd(trx, terms)
      return {
        policy,
        requestId: await recordPlayerAdd(
          trx,
          { userId: ids.coach, isAdmin: false, scopes: [] },
          applied,
          'applied',
          clock
        )
      }
    })
  }

  async function call(
    token: string,
    method: string,
    path: string
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      ...(method === 'GET' ? {} : { body: '{}' })
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? null : JSON.parse(text)
    }
  }
  const inbox = async (token: string, history = false): Promise<any> =>
    (
      await call(
        token,
        'GET',
        `/me/notifications${history ? '?history=1' : ''}`
      )
    ).body
  const request = async (id: string): Promise<any> =>
    await db!
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const membership = async (name: string, teamId: string): Promise<any> =>
    await db!
      .selectFrom('memberships')
      .selectAll()
      .where('user_id', '=', ids[name])
      .where('team_id', '=', teamId)
      .executeTakeFirst()

  before(async function () {
    adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
      return
    }
    await adminPool.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    try {
      await migrateUp(pool, migrations)
    } finally {
      await pool.end()
    }
    db = makeDatabase(scratchUrl)
    const d = db
    await d
      .insertInto('system_settings')
      .values({ key: 'creation.hierarchyReady', value: JSON.stringify(true) })
      .execute()
    await d
      .insertInto('leagues')
      .values({ id: 'lea_notice', name: 'Ridgeview' })
      .execute()
    await d
      .insertInto('seasons')
      .values({
        id: SEASON,
        league_id: 'lea_notice',
        name: 'Fall',
        year: 2026,
        starts_on: '2026-01-01',
        ends_on: '2099-12-31'
      })
      .execute()
    await d
      .insertInto('teams')
      .values([
        {
          id: TEAM.falcons,
          name: 'Ridgeview Falcons',
          league_id: 'lea_notice',
          default_lineup: JSON.stringify({
            lineup: { batters: [], defense: {} }
          })
        },
        { id: TEAM.herons, name: 'Lakeside Herons', league_id: 'lea_notice' },
        { id: TEAM.owls, name: 'Ridgeview Owls', league_id: 'lea_notice' },
        { id: TEAM.bears, name: 'Valley Bears', league_id: 'lea_notice' },
        { id: TEAM.cubs, name: 'Little Cubs', league_id: 'lea_notice' }
      ])
      .execute()
    await d
      .insertInto('season_teams')
      .values(
        [TEAM.falcons, TEAM.herons].map(teamId => ({
          season_id: SEASON,
          team_id: teamId
        }))
      )
      .execute()

    await person('Site Admin', { login: true, admin: true })
    await person('Dave Roberts', { login: true })
    ids.coach = ids['Dave Roberts']
    await role(ids.coach, TEAM.falcons, 'coach')
    await role(ids.coach, TEAM.falcons, 'admin')
    await person('Mookie Betts', { teamId: TEAM.owls })
    await person('Mookie Guardian', { login: true })
    await d
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: ids['Mookie Guardian'],
        related_user_id: ids['Mookie Betts'],
        kind: 'guardian',
        can_manage: true
      })
      .execute()
    await person('Freddie Freeman', { teamId: TEAM.owls, login: true })
    await person('Tony Kemp', { teamId: TEAM.bears })
    await person('Bears Coach', { login: true })
    await role(ids['Bears Coach'], TEAM.bears, 'coach')
    await person('Lonely Cub', { teamId: TEAM.cubs })
    await person('Falcon Fan', { login: true })
    await d
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: ids['Falcon Fan'],
        team_id: TEAM.falcons,
        role: 'member'
      })
      .execute()
    await person('Owl Fan', { login: true })
    await d
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: ids['Owl Fan'],
        team_id: TEAM.owls,
        role: 'member'
      })
      .execute()

    const sessions: Array<[string, string]> = [
      [TOKENS.admin, ids['Site Admin']],
      [TOKENS.coach, ids.coach],
      [TOKENS.guardian, ids['Mookie Guardian']],
      [TOKENS.freeman, ids['Freddie Freeman']],
      [TOKENS.bearsCoach, ids['Bears Coach']],
      [TOKENS.falcon, ids['Falcon Fan']],
      [TOKENS.owl, ids['Owl Fan']]
    ]
    await d
      .insertInto('auth_sessions')
      .values(
        sessions.map(([token, userId]) => ({
          id: makeId('authSession'),
          user_id: userId,
          token_hash: hashToken(token),
          created_at: new Date(),
          expires_at: new Date(Date.now() + 365 * DAY)
        }))
      )
      .execute()

    const media: MediaContext = {
      mediaRoot: mkdtempSync(join(tmpdir(), 'tsNotices-')),
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
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', groupRoutes(db, media, clock))
    app.use('/api/v1', notificationRoutes(db, clock))
    app.use('/api/v1', statsRoutes(db, media))
    app.use('/api/v1', playerRoutes(db, media))
    app.use('/api/v1', teamRoutes(db, media))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    const listening = server
    if (listening != null)
      await new Promise(resolve => listening.close(resolve))
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  it('tells the guardian, the player, or the coaches of their other teams, in that order', async function () {
    expect(
      await playerAddApprovers(db!, ids['Mookie Betts'], TEAM.falcons)
    ).deep.equals({ userIds: [ids['Mookie Guardian']], standIn: false })
    expect(
      await playerAddApprovers(db!, ids['Freddie Freeman'], TEAM.falcons)
    ).deep.equals({ userIds: [ids['Freddie Freeman']], standIn: false })
    expect(
      await playerAddApprovers(db!, ids['Tony Kemp'], TEAM.falcons)
    ).deep.equals({ userIds: [ids['Bears Coach']], standIn: true })
    // On no other team: nobody, and the add simply applies.
    expect(
      await playerAddApprovers(db!, ids['Lonely Cub'], TEAM.falcons)
    ).deep.equals({ userIds: [], standIn: false })
    const cub = await add('roster', 'Lonely Cub')
    expect(cub).deep.equals({ policy: 'notice', requestId: null })
    expect((await membership('Lonely Cub', TEAM.falcons))?.is_player).equals(
      true
    )
    // Nobody is told of their own add: the Bears' coach adding Kemp, whose
    // only stand-in they are, records no notice.
    const own = await atomic(
      db!,
      async trx =>
        await recordPlayerAdd(
          trx,
          { userId: ids['Bears Coach'], isAdmin: false, scopes: [] },
          {
            kind: 'playerAdd',
            mode: 'roster',
            userId: ids['Tony Kemp'],
            teamId: TEAM.falcons,
            jersey: null,
            positions: [],
            teamName: 'Ridgeview Falcons'
          },
          'applied',
          clock
        )
    )
    expect(own).equals(null)
  })

  it('adds a player with a notice their guardian may reject, which undoes it and makes the next add ask first', async function () {
    const first = await add('roster', 'Mookie Betts')
    expect(first.policy).equals('notice')
    const held = await membership('Mookie Betts', TEAM.falcons)
    expect(held).to.include({ is_player: true, jersey: '50' })
    expect(held.positions).deep.equals(['RF'])
    const stored = await request(first.requestId!)
    expect(stored).to.include({
      kind: 'playerAdd',
      status: 'applied',
      initiating_team_id: TEAM.falcons
    })
    expect(stored.expires_at.getTime() - stored.sent_at.getTime()).equals(
      NOTICE_DAYS * DAY
    )

    // The guardian sees it as news, with Reject and no Accept.
    const pending = await inbox(TOKENS.guardian)
    expect(pending.hasPending).equals(true)
    const card = pending.items.find(
      (item: any) => item.requestId === first.requestId
    )
    expect(card).to.include({
      status: 'applied',
      canAct: false,
      canReject: true,
      title: 'Dave Roberts added Mookie B to Ridgeview Falcons'
    })
    expect(card.rejectUntil).equals(stored.expires_at.toISOString())
    expect(
      (await inbox(TOKENS.guardian, true)).items.map(
        (item: any) => item.requestId
      )
    ).not.includes(first.requestId)
    // Accepting a change already made is refused.
    expect(
      (
        await call(
          TOKENS.guardian,
          'POST',
          `/relationship-requests/${first.requestId}/accept`
        )
      ).status
    ).equals(409)
    // Nobody else may decide it.
    expect(
      (
        await call(
          TOKENS.owl,
          'POST',
          `/relationship-requests/${first.requestId}/decline`
        )
      ).status
    ).equals(403)

    // In the Falcons' default lineup, batting and at right field.
    const betts = { gumboId: gumbo['Mookie Betts'], name: 'Mookie B' }
    const other = { gumboId: gumbo['Dave Roberts'], name: 'Dave R' }
    await db!
      .updateTable('teams')
      .set({
        default_lineup: JSON.stringify({
          lineup: {
            batters: [betts, other],
            defense: { RF: betts, C: other }
          }
        })
      })
      .where('id', '=', TEAM.falcons)
      .execute()
    const rejected = await call(
      TOKENS.guardian,
      'POST',
      `/relationship-requests/${first.requestId}/decline`
    )
    expect(rejected.body).deep.equals({
      id: first.requestId,
      status: 'declined'
    })
    expect(await membership('Mookie Betts', TEAM.falcons)).equals(undefined)
    const lineup = await db!
      .selectFrom('teams')
      .select('default_lineup')
      .where('id', '=', TEAM.falcons)
      .executeTakeFirstOrThrow()
    expect(lineup.default_lineup).deep.equals({
      lineup: { batters: [other], defense: { RF: null, C: other } }
    })
    const told = await db!
      .selectFrom('notification_events')
      .selectAll()
      .where('source_type', '=', 'playerAddRejected')
      .where('source_id', '=', first.requestId!)
      .executeTakeFirstOrThrow()
    expect(told.recorded_recipients).includes(ids.coach)
    // It keeps ids, not the player's name: the card reads it from `users`.
    expect(JSON.stringify(told.metadata)).not.includes('Mookie')
    // It waits in the coach's Pending, lighting the bell, until dismissed.
    const coachInbox = (await call(TOKENS.coach, 'GET', '/me/notifications'))
      .body
    expect(coachInbox.hasPending).equals(true)
    expect(
      coachInbox.items.find((item: any) => item.requestId === told.id)
    ).to.include({
      type: 'playerAddRejected',
      canAct: false,
      title: 'A guardian removed Mookie B from Ridgeview Falcons',
      description: 'Mookie B is no longer on it.'
    })
    // A rename shows on the card already sent.
    const was = await db!
      .selectFrom('users')
      .select(['first_name', 'display_name'])
      .where('id', '=', ids['Mookie Betts'])
      .executeTakeFirstOrThrow()
    const rename = async (
      first: string | null,
      display: string
    ): Promise<void> => {
      await db!
        .updateTable('users')
        .set({ first_name: first, display_name: display })
        .where('id', '=', ids['Mookie Betts'])
        .execute()
    }
    await rename('Markus', 'Markus Betts')
    const renamed = (await call(TOKENS.coach, 'GET', '/me/notifications')).body
      .items as any[]
    await rename(was.first_name, was.display_name)
    expect(renamed.find(item => item.requestId === told.id)?.title).equals(
      'A guardian removed Markus B from Ridgeview Falcons'
    )
    await call(TOKENS.coach, 'PUT', `/me/notifications/${told.id}/dismissed`)
    expect(
      (await call(TOKENS.coach, 'GET', '/me/notifications')).body.items.some(
        (item: any) => item.requestId === told.id
      )
    ).equals(false)

    // The one automatic add is used: the next asks, and changes nothing.
    const second = await add('roster', 'Mookie Betts')
    expect(second.policy).equals('approval')
    expect((await request(second.requestId!)).status).equals('pending')
    // The sender cannot submit a player add again from Sent: it is asked
    // again by adding the player again.
    const sent = (await call(TOKENS.coach, 'GET', '/me/notifications?sent=1'))
      .body
    const asked = sent.items.find(
      (item: any) => item.requestId === second.requestId
    )
    expect(asked, 'the pending add in Sent').not.equals(undefined)
    expect(asked.canResend).equals(false)
    expect(await membership('Mookie Betts', TEAM.falcons)).equals(undefined)
    const asking = (await inbox(TOKENS.guardian)).items.find(
      (item: any) => item.requestId === second.requestId
    )
    expect(asking).to.include({
      status: 'pending',
      canAct: true,
      title: 'Dave Roberts asks to add Mookie B to Ridgeview Falcons'
    })
    // Another team's first add still goes through with a notice.
    expect(await playerAddPolicy(db!, ids['Mookie Betts'], TEAM.herons)).equals(
      'notice'
    )

    expect(
      (
        await call(
          TOKENS.guardian,
          'POST',
          `/relationship-requests/${second.requestId}/accept`
        )
      ).body.status
    ).equals('accepted')
    expect(await membership('Mookie Betts', TEAM.falcons)).to.include({
      is_player: true,
      jersey: '50'
    })
  })

  it('turns the games already played into a placeholder off the player’s own record', async function () {
    // Freeman plays two Owls games and two Falcons games in the season.
    const owlsGames = [await game(), await game()]
    for (const id of owlsGames) {
      await db!
        .updateTable('games')
        .set({ home_team_id: TEAM.owls })
        .where('id', '=', id)
        .execute()
      await line(id, 'Freddie Freeman', TEAM.owls)
      await play(id, 'Freddie Freeman', TEAM.owls)
    }
    const added = await add('roster', 'Freddie Freeman', {
      jersey: '5',
      positions: []
    })
    const falconsGames = [await game(), await game()]
    for (const id of falconsGames) {
      await line(id, 'Freddie Freeman', TEAM.falcons)
      await play(id, 'Freddie Freeman', TEAM.falcons)
    }
    // A third is under way: he has batted, and no stat line is built yet.
    const live = await game({ current: true })
    await play(live, 'Freddie Freeman', TEAM.falcons)
    // A game he sat out entirely is not his.
    const other = await game({ current: true })
    await play(other, 'Mookie Betts', TEAM.falcons)
    // Nor is a game against the Falcons he played for the other team.
    const across = await game()
    await line(across, 'Freddie Freeman', TEAM.herons)
    await play(across, 'Freddie Freeman', TEAM.herons)
    const totalsBefore = battingLines(
      await statRows(db!, { seasonId: SEASON })
    ).reduce((sum, each) => sum + each.h, 0)
    // As a Falcon he is visible to the Falcons' members.
    expect(
      (await call(TOKENS.falcon, 'GET', `/players/${ids['Freddie Freeman']}`))
        .status
    ).equals(200)

    // He decides for himself: no guardian, and he signs in.
    expect(
      (
        await call(
          TOKENS.freeman,
          'POST',
          `/relationship-requests/${added.requestId}/decline`
        )
      ).body.status
    ).equals('declined')
    const withdrawn = await db!
      .selectFrom('game_withdrawn_players')
      .selectAll()
      .orderBy('game_id')
      .execute()
    const falconsLabel = `${placeholderTeamName('Ridgeview Falcons')} A`
    expect(falconsLabel).equals('RFLCNS A')
    expect(
      withdrawn.map(row => [row.game_id, row.side, row.label])
    ).deep.equals(
      [...falconsGames, live].sort().map(id => [id, 'home', falconsLabel])
    )
    const told = await db!
      .selectFrom('notification_events')
      .selectAll()
      .where('source_type', '=', 'playerAddRejected')
      .where('source_id', '=', added.requestId!)
      .executeTakeFirstOrThrow()
    expect(told.metadata).to.include({ games: 3, mode: 'roster' })
    expect(
      playerRemovedWords(told.metadata as any, 'Freddie F').description
    ).includes('3 games already played now read a placeholder')

    // The season keeps both lines apart, and its totals.
    const season = await call(TOKENS.admin, 'GET', `/seasons/${SEASON}/stats`)
    const mine = season.body.batting.filter(
      (row: any) => row.userId === ids['Freddie Freeman']
    )
    const gone = season.body.batting.filter(
      (row: any) => row.shortName === falconsLabel
    )
    // The two Owls games and the one against the Falcons for the Herons.
    expect(mine.map((row: any) => row.h)).deep.equals([3])
    // One line a game: the placeholder never adds up into one person.
    expect(gone.map((row: any) => [row.h, row.userId])).deep.equals([
      [1, null],
      [1, null]
    ])
    expect(
      battingLines(await statRows(db!, { seasonId: SEASON })).reduce(
        (sum, each) => sum + each.h,
        0
      )
    ).equals(totalsBefore)
    const team = await call(TOKENS.admin, 'GET', `/teams/${TEAM.falcons}/stats`)
    expect(
      team.body
        .filter((row: any) => row.shortName === falconsLabel)
        .map((row: any) => row.userId)
    ).deep.equals([null, null])
    expect(team.body.map((row: any) => row.userId)).not.includes(
      ids['Freddie Freeman']
    )
    const box = await call(
      TOKENS.admin,
      'GET',
      `/games/${falconsGames[0]}/box-score`
    )
    expect(
      box.body.batting.map((row: any) => [row.shortName, row.userId])
    ).deep.equals([[falconsLabel, null]])
    // The line names the batter it stands in for in this game, and no other
    // line names anybody that way.
    expect(box.body.batting[0].standsFor).equals(gumbo['Freddie Freeman'])

    // His own record leaves the Falcons games out, for anybody asking.
    const own = await statRows(db!, { userId: ids['Freddie Freeman'] })
    const byGame = (a: Array<string | null>, b: Array<string | null>): number =>
      String(a[0]).localeCompare(String(b[0]))
    expect(own.map(row => [row.gameId, row.teamId]).sort(byGame)).deep.equals(
      [...owlsGames.map(id => [id, TEAM.owls]), [across, TEAM.herons]].sort(
        byGame
      )
    )
    for (const token of [TOKENS.freeman, TOKENS.admin]) {
      const plays = await call(
        token,
        'GET',
        `/players/${ids['Freddie Freeman']}/plays`
      )
      expect(plays.status).equals(200)
      expect(JSON.stringify(plays.body)).not.includes(falconsGames[0])
      expect(JSON.stringify(plays.body)).includes(owlsGames[0])
      const clips = await call(
        token,
        'GET',
        `/players/${ids['Freddie Freeman']}/highlights`
      )
      expect(clips.status).equals(200)
      for (const id of falconsGames)
        expect(JSON.stringify(clips.body)).not.includes(id)
    }
    // The Falcons are not a team he played for, so a Falcon cannot open him;
    // an Owl still can.
    expect(
      (await teamsOf(db!, [ids['Freddie Freeman']])).map(row => row.teamId)
    ).not.includes(TEAM.falcons)
    expect(
      (await call(TOKENS.falcon, 'GET', `/players/${ids['Freddie Freeman']}`))
        .status
    ).equals(404)
    expect(
      (await call(TOKENS.owl, 'GET', `/players/${ids['Freddie Freeman']}`))
        .status
    ).equals(200)
  })

  it('takes a pool player out of a game not yet played, and keeps a played one under a placeholder', async function () {
    const fresh = await game()
    // Evening in Los Angeles is already the next day in UTC: the notice
    // names the game's own day.
    await db!
      .updateTable('games')
      .set({
        timezone: 'America/Los_Angeles',
        start_at: new Date('2026-10-29T02:30:00Z')
      })
      .where('id', '=', fresh)
      .execute()
    const kemp = await add('pool', 'Tony Kemp', {
      gameId: fresh,
      side: 'away',
      teamId: TEAM.herons,
      teamName: 'Lakeside Herons'
    })
    const details = await db!
      .selectFrom('game_guest_details')
      .selectAll()
      .where('game_id', '=', fresh)
      .executeTakeFirstOrThrow()
    expect(details).to.include({ pool: true, jersey: '50' })
    const guests = async (id: string): Promise<unknown> =>
      (
        (
          await db!
            .selectFrom('games')
            .select('guests')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        ).guests as Record<string, unknown>
      )[TEAM.herons]
    expect(await guests(fresh)).deep.equals([gumbo['Tony Kemp']])
    // The Bears' coach stands in for a guardian, and is told why.
    const card = (await inbox(TOKENS.bearsCoach)).items.find(
      (item: any) => item.requestId === kemp.requestId
    )
    expect(card.title).equals(
      'Dave Roberts added Tony K to Lakeside Herons for the game on Oct 28'
    )
    // Stored once and kept: it says only what stays true.
    expect(card.description).match(
      /^Tony K was added to play for Lakeside Herons\. /
    )
    expect(card.description).includes('has no guardian on TeamStation')
    // How long a Reject holds is the card's own line, not the stored text,
    // which outlives it.
    expect(card.description).not.includes('until')
    expect(card.description).not.includes('removes')
    // The game's sides swap before its first pitch: the Herons, who took him
    // on the away side, are at home now, and the reject still finds him.
    await db!
      .updateTable('games')
      .set(eb => ({
        home_team_id: eb.ref('away_team_id'),
        away_team_id: eb.ref('home_team_id')
      }))
      .where('id', '=', fresh)
      .execute()
    expect(card.rejectUntil).to.be.a('string')
    await call(
      TOKENS.bearsCoach,
      'POST',
      `/relationship-requests/${kemp.requestId}/decline`
    )
    // Decided, the card still carries both fields of the shape.
    const decided = (await inbox(TOKENS.bearsCoach, true)).items.find(
      (item: any) => item.requestId === kemp.requestId
    )
    expect(decided).to.include({ canReject: false, rejectUntil: null })
    // The roster managers hear that a coach stood in, not a guardian.
    const removal = await db!
      .selectFrom('notification_events')
      .select('metadata')
      .where('source_type', '=', 'playerAddRejected')
      .where('source_id', '=', kemp.requestId!)
      .executeTakeFirstOrThrow()
    expect(removal.metadata).to.include({ remover: 'coach', mode: 'pool' })
    expect(playerRemovedWords(removal.metadata as any, 'Tony K').title).equals(
      "A coach of another of their teams removed Tony K from Lakeside Herons's game"
    )
    expect(await guests(fresh)).deep.equals([])
    expect(
      await db!
        .selectFrom('game_guest_details')
        .selectAll()
        .where('game_id', '=', fresh)
        .execute()
    ).deep.equals([])

    // Under way: he stays in the record, as a placeholder.
    const started = await game({ current: true })
    await db!
      .updateTable('memberships')
      .set({ is_player: true })
      .where('user_id', '=', ids['Tony Kemp'])
      .execute()
    await db!
      .deleteFrom('group_requests')
      .where('kind', '=', 'playerAdd')
      .where('initiating_team_id', '=', TEAM.herons)
      .execute()
    const again = await add('pool', 'Tony Kemp', {
      gameId: started,
      side: 'away',
      teamId: TEAM.herons,
      teamName: 'Lakeside Herons'
    })
    await line(started, 'Tony Kemp', TEAM.herons)
    // The side already has a placeholder guest named as its first one.
    const herons = placeholderTeamName('Lakeside Herons')
    await person(`${herons} A`)
    const held = await db!
      .selectFrom('games')
      .select('guests')
      .where('id', '=', started)
      .executeTakeFirstOrThrow()
    const lists = held.guests as Record<string, number[]>
    await db!
      .updateTable('games')
      .set({
        guests: JSON.stringify({
          ...lists,
          [TEAM.herons]: [...(lists[TEAM.herons] ?? []), gumbo[`${herons} A`]]
        })
      })
      .where('id', '=', started)
      .execute()
    const digestBefore = await gameNamesDigest(db!, started)
    await call(
      TOKENS.bearsCoach,
      'POST',
      `/relationship-requests/${again.requestId}/decline`
    )
    expect(await guests(started)).deep.equals([
      gumbo['Tony Kemp'],
      gumbo[`${herons} A`]
    ])
    const withdrawn = await db!
      .selectFrom('game_withdrawn_players')
      .selectAll()
      .where('game_id', '=', started)
      .execute()
    // The side's first placeholder name is taken, so his is the next free.
    expect(withdrawn.map(row => [row.side, row.label])).deep.equals([
      ['away', `${herons} B`]
    ])
    // Every surface of that game reads him so: its guests, its names and the
    // digest whatever caches them is keyed by.
    const game_ = await db!
      .selectFrom('games')
      .selectAll()
      .where('id', '=', started)
      .executeTakeFirstOrThrow()
    expect(
      (await gameAvailability(db!, game_)).guestPlayers.away.map(
        row => row.shortName
      )
    ).includes(`${herons} B`)
    const book = (await gameNames(db!, [started])).get(started)!
    expect(book.nameOf(gumbo['Tony Kemp'])).equals(`${herons} B`)
    expect(await gameNamesDigest(db!, started)).not.equals(digestBefore)
    const named = await resolveScoringGame(
      db!,
      {
        plays: [],
        currentPlay: {
          teamStation: {
            setupBefore: {
              players: {
                [gumbo['Tony Kemp']]: { id: gumbo['Tony Kemp'] }
              }
            }
          }
        } as any
      },
      { gameId: started }
    )
    expect(JSON.stringify(named)).includes(`${herons} B`)
  })

  it('lets a notice be rejected for 90 days, from the inbox or after dismissing it, and not after', async function () {
    const started = new Date(now)
    const owlsAdd = await atomic(db!, async trx => {
      await trx
        .deleteFrom('group_requests')
        .where('kind', '=', 'playerAdd')
        .where('initiating_team_id', '=', TEAM.owls)
        .execute()
      return null
    })
    expect(owlsAdd).equals(null)
    await person('Clayton Kershaw', { teamId: TEAM.bears, login: true })
    const first = await add('roster', 'Clayton Kershaw')
    await person('Walker Buehler', { teamId: TEAM.bears, login: true })
    const second = await add('roster', 'Walker Buehler')
    const token = async (name: string): Promise<string> => {
      const value = `tok_notice_${name.replace(/\W/g, '')}`.padEnd(37, '0')
      await db!
        .insertInto('auth_sessions')
        .values({
          id: makeId('authSession'),
          user_id: ids[name],
          token_hash: hashToken(value),
          created_at: new Date(),
          expires_at: new Date(Date.now() + 365 * DAY)
        })
        .execute()
      return value
    }
    const kershaw = await token('Clayton Kershaw')
    const buehler = await token('Walker Buehler')

    now = new Date(started.getTime() + 89 * DAY)
    // Dismissed, it leaves the inbox for History, still rejectable there.
    expect(
      (
        await call(
          kershaw,
          'PUT',
          `/me/notifications/${first.requestId}/dismissed`
        )
      ).status
    ).equals(204)
    const inboxNow = await inbox(kershaw)
    expect(inboxNow.items.map((item: any) => item.requestId)).not.includes(
      first.requestId
    )
    expect(inboxNow.hasPending).equals(false)
    const history = (await inbox(kershaw, true)).items.find(
      (item: any) => item.requestId === first.requestId
    )
    expect(history).to.include({ canReject: true, status: 'applied' })
    expect(
      (
        await call(
          kershaw,
          'POST',
          `/relationship-requests/${first.requestId}/decline`
        )
      ).body.status
    ).equals('declined')

    now = new Date(started.getTime() + 90 * DAY)
    const late = await call(
      buehler,
      'POST',
      `/relationship-requests/${second.requestId}/decline`
    )
    expect(late.status).equals(409)
    expect(JSON.stringify(late.body)).includes(
      'This can no longer be rejected.'
    )
    expect(
      (await membership('Walker Buehler', TEAM.falcons))?.is_player
    ).equals(true)
    const final = (await inbox(buehler, true)).items.find(
      (item: any) => item.requestId === second.requestId
    )
    expect(final).to.include({ canReject: false, status: 'applied' })
    expect(
      (await inbox(buehler)).items.map((item: any) => item.requestId)
    ).not.includes(second.requestId)
    now = new Date()
  })

  it('lets a pending pool add expire once its game is over, and a declined pending add stays declined', async function () {
    await db!
      .deleteFrom('group_requests')
      .where('kind', '=', 'playerAdd')
      .where('initiating_team_id', '=', TEAM.falcons)
      .execute()
    const over = await game()
    await db!
      .insertInto('group_requests')
      .values({
        id: 'inv_noticeDeclined',
        kind: 'playerAdd',
        sender_id: ids.coach,
        sender_scope_type: 'team',
        sender_scope_id: TEAM.falcons,
        terms: JSON.stringify({ userId: ids['Mookie Betts'] }),
        status: 'declined',
        sent_at: now,
        expires_at: new Date(now.getTime() + DAY),
        initiating_team_id: TEAM.falcons
      })
      .execute()
    const pending = await add('pool', 'Mookie Betts', {
      gameId: over,
      side: 'home'
    })
    expect(pending.policy).equals('approval')
    await db!
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', over)
      .execute()
    expect(
      (
        await call(
          TOKENS.guardian,
          'POST',
          `/relationship-requests/${pending.requestId}/accept`
        )
      ).body.status
    ).equals('expired')
    expect(
      await db!
        .selectFrom('game_guest_details')
        .selectAll()
        .where('game_id', '=', over)
        .execute()
    ).deep.equals([])
    // Accepted after he joined the game another way: it can never apply.
    const open = await game()
    const twice = await add('pool', 'Mookie Betts', {
      gameId: open,
      side: 'home'
    })
    await db!
      .updateTable('games')
      .set({
        guests: JSON.stringify({ [TEAM.herons]: [gumbo['Mookie Betts']] })
      })
      .where('id', '=', open)
      .execute()
    expect(
      (
        await call(
          TOKENS.guardian,
          'POST',
          `/relationship-requests/${twice.requestId}/accept`
        )
      ).body.status
    ).equals('expired')
    expect(
      (
        await db!
          .selectFrom('games')
          .select('guests')
          .where('id', '=', open)
          .executeTakeFirstOrThrow()
      ).guests
    ).deep.equals({ [TEAM.herons]: [gumbo['Mookie Betts']] })
    const declined = await add('roster', 'Mookie Betts')
    expect(
      (
        await call(
          TOKENS.guardian,
          'POST',
          `/relationship-requests/${declined.requestId}/decline`
        )
      ).body.status
    ).equals('declined')
    // Decided already, a second answer changes nothing.
    expect(
      (
        await call(
          TOKENS.guardian,
          'POST',
          `/relationship-requests/${declined.requestId}/accept`
        )
      ).body.status
    ).equals('declined')
  })
  it('makes an existing member a player and, rejected, only a member again', async function () {
    // He held a jersey and a position on the team before.
    await db!
      .updateTable('memberships')
      .set({ jersey: '7', positions: ['LF'] })
      .where('user_id', '=', ids['Owl Fan'])
      .where('team_id', '=', TEAM.owls)
      .execute()
    const owl = await add('roster', 'Owl Fan', {
      teamId: TEAM.owls,
      teamName: 'Ridgeview Owls',
      jersey: '12',
      positions: ['SS']
    })
    expect(await membership('Owl Fan', TEAM.owls)).to.include({
      is_player: true,
      jersey: '12'
    })
    await call(
      TOKENS.owl,
      'POST',
      `/relationship-requests/${owl.requestId}/decline`
    )
    const back = await membership('Owl Fan', TEAM.owls)
    expect(back).to.include({ is_player: false, jersey: '7' })
    expect(back.positions).deep.equals(['LF'])
  })

  it('keeps a withdrawn pitcher apart on the team’s pitching table', async function () {
    const pitched = await game()
    await person('Walker Buehler Jr', { teamId: TEAM.bears, login: true })
    const added = await add('roster', 'Walker Buehler Jr')
    await db!
      .insertInto('game_player_stats')
      .values({
        id: makeId('gamePlayerStats'),
        game_id: pitched,
        gumbo_id: gumbo['Walker Buehler Jr'],
        team_id: TEAM.falcons,
        pitch_bf: 3,
        pitch_outs: 3
      })
      .execute()
    const value = 'tok_notice_buehlerjr'.padEnd(37, '0')
    await db!
      .insertInto('auth_sessions')
      .values({
        id: makeId('authSession'),
        user_id: ids['Walker Buehler Jr'],
        token_hash: hashToken(value),
        created_at: new Date(),
        expires_at: new Date(Date.now() + 365 * DAY)
      })
      .execute()
    await call(
      value,
      'POST',
      `/relationship-requests/${added.requestId}/decline`
    )
    const pitching = await call(
      TOKENS.admin,
      'GET',
      `/teams/${TEAM.falcons}/stats?kind=pitching`
    )
    expect(pitching.status).equals(200)
    const pitchers = pitching.body.map((row: any) => row.userId)
    expect(pitchers).includes(null)
    expect(pitchers).not.includes(ids['Walker Buehler Jr'])
  })

  it('lets a pending add lapse once its 90 days pass', async function () {
    await db!
      .deleteFrom('group_requests')
      .where('kind', '=', 'playerAdd')
      .where('initiating_team_id', '=', TEAM.falcons)
      .execute()
    await db!
      .insertInto('group_requests')
      .values({
        id: 'inv_noticeLapsed',
        kind: 'playerAdd',
        sender_id: ids.coach,
        sender_scope_type: 'team',
        sender_scope_id: TEAM.falcons,
        terms: JSON.stringify({ userId: ids['Mookie Betts'] }),
        status: 'declined',
        sent_at: now,
        expires_at: new Date(now.getTime() + DAY),
        initiating_team_id: TEAM.falcons
      })
      .execute()
    const asked = await add('roster', 'Mookie Betts')
    expect(asked.policy).equals('approval')
    const started = now
    now = new Date(started.getTime() + (NOTICE_DAYS + 1) * DAY)
    const late = await call(
      TOKENS.guardian,
      'POST',
      `/relationship-requests/${asked.requestId}/accept`
    )
    now = new Date()
    expect(late.body.status).equals('expired')
  })

  /** The player deciding for themselves, as the route would. */
  async function decide(
    name: string,
    requestId: string,
    decision: 'accept' | 'decline'
  ): Promise<string> {
    return await atomic(db!, async trx => {
      const decided = await decidePlayerAdd(
        trx,
        { userId: ids[name], isAdmin: false, scopes: [] },
        await request(requestId),
        decision,
        clock
      )
      return decided.status
    })
  }

  it('keeps a game they played as an approved pool player when a later roster add is rejected', async function () {
    await person('Corey Seager', { login: true })
    // Yesterday he played one Falcons game as a pool player, and nobody
    // rejected that.
    const pooled = await game({
      startedAt: new Date(now.getTime() - 12 * 3_600_000)
    })
    const pool = await add('pool', 'Corey Seager', {
      gameId: pooled,
      side: 'home'
    })
    expect(pool.policy).equals('notice')
    await line(pooled, 'Corey Seager', TEAM.falcons)
    await play(pooled, 'Corey Seager', TEAM.falcons)
    // Today the Falcons put him on their roster, and he plays for them.
    const roster = await add('roster', 'Corey Seager')
    const after = await game()
    await line(after, 'Corey Seager', TEAM.falcons)
    await play(after, 'Corey Seager', TEAM.falcons)

    expect(await decide('Corey Seager', roster.requestId!, 'decline')).equals(
      'declined'
    )
    // Only the game the roster add covers reads a placeholder.
    const withdrawn = await db!
      .selectFrom('game_withdrawn_players')
      .select('game_id')
      .where('user_id', '=', ids['Corey Seager'])
      .execute()
    expect(withdrawn.map(row => row.game_id)).deep.equals([after])
    const own = await statRows(db!, { userId: ids['Corey Seager'] })
    expect(own.map(row => row.gameId)).deep.equals([pooled])
    // And he is still that game's pool player.
    expect(
      await db!
        .selectFrom('game_guest_details')
        .select('pool')
        .where('game_id', '=', pooled)
        .where('user_id', '=', ids['Corey Seager'])
        .executeTakeFirst()
    ).deep.equals({ pool: true })
  })

  it('lets only the latest add of a person to a team be rejected', async function () {
    await person('Max Muncy', { login: true })
    const first = await add('roster', 'Max Muncy')
    // The coach takes him off, then adds him again a moment later.
    await db!
      .deleteFrom('memberships')
      .where('user_id', '=', ids['Max Muncy'])
      .where('team_id', '=', TEAM.falcons)
      .execute()
    now = new Date(now.getTime() + 60_000)
    const second = await add('roster', 'Max Muncy', { jersey: '13' })
    expect(second.policy).equals('notice')
    now = new Date()
    expect(
      await supersededPlayerAdd(db!, await request(first.requestId!))
    ).equals(true)
    expect(
      await supersededPlayerAdd(db!, await request(second.requestId!))
    ).equals(false)
    // Only the newer notice offers Reject, in his own Notifications.
    await db!
      .insertInto('auth_sessions')
      .values({
        id: makeId('authSession'),
        user_id: ids['Max Muncy'],
        token_hash: hashToken(TOKENS.muncy),
        created_at: new Date(),
        expires_at: new Date(Date.now() + 365 * DAY)
      })
      .execute()
    const card = async (id: string): Promise<any> =>
      [
        ...(await inbox(TOKENS.muncy)).items,
        ...(await inbox(TOKENS.muncy, true)).items
      ].find((item: any) => item.requestId === id)
    const pending = async (id: string): Promise<boolean> =>
      (await inbox(TOKENS.muncy)).items.some(
        (item: any) => item.requestId === id
      )
    expect(await card(first.requestId!)).to.include({ canReject: false })
    // Nothing to do on it, so it waits in History, not Pending.
    expect(await pending(first.requestId!)).equals(false)
    expect(await pending(second.requestId!)).equals(true)
    expect(await card(second.requestId!)).to.include({ canReject: true })
    // Rejecting the older one is refused and changes nothing.
    let refused: unknown
    try {
      await decide('Max Muncy', first.requestId!, 'decline')
    } catch (error) {
      refused = error
    }
    expect(String((refused as Error)?.message)).includes(
      'They were added again since'
    )
    expect(await membership('Max Muncy', TEAM.falcons)).to.include({
      is_player: true,
      jersey: '13'
    })
    expect((await request(first.requestId!)).status).equals('applied')
    // The newer one rejects as ever.
    expect(await decide('Max Muncy', second.requestId!, 'decline')).equals(
      'declined'
    )
    expect(await membership('Max Muncy', TEAM.falcons)).equals(undefined)
    // With the newer add undone, the older one is the latest again: its own
    // games are his to take off his record too.
    expect(await card(first.requestId!)).to.include({ canReject: true })
  })

  it('waits behind a merge holding the parent graph, rather than deadlock with it', async function () {
    await person('Lock Holder', { login: true })
    const added = await add('roster', 'Lock Holder')
    let decided: Promise<string> | undefined
    // As a merge and an account deletion do: the graph, then the merge lock.
    await atomic(db!, async trx => {
      await lockKeys(trx, ['creation:parent-graph'])
      decided = decide('Lock Holder', added.requestId!, 'decline')
      await new Promise(resolve => setTimeout(resolve, 300))
      await sql`set local lock_timeout = '5s'`.execute(trx)
      await sql`select pg_advisory_xact_lock(hashtextextended(${MERGE_LOCK}, 0))`.execute(
        trx
      )
    })
    expect(await decided).equals('declined')
  })

  it('withdraws a game under way that holds them with no line yet: pitching, or due up', async function () {
    const under = async (): Promise<string> => {
      const id = await game()
      await db!
        .updateTable('games')
        .set({ status: 'inProgress' })
        .where('id', '=', id)
        .execute()
      return id
    }
    await person('Only Pitching', { login: true })
    const pitching = await add('roster', 'Only Pitching')
    const mound = await under()
    const event = makeId('event')
    await db!
      .insertInto('events')
      .values({
        id: event,
        gameId: mound,
        startTime: new Date(),
        battingTeamId: TEAM.herons,
        gumbo: JSON.stringify({ about: { atBatIndex: 0 } })
      })
      .execute()
    await db!
      .insertInto('event_players')
      .values({
        id: makeId('eventPlayer'),
        event_id: event,
        gumbo_id: gumbo['Only Pitching'],
        team_id: TEAM.falcons,
        role: 'pitcher',
        position: null
      })
      .execute()
    await decide('Only Pitching', pitching.requestId!, 'decline')

    await person('Due Up', { login: true })
    const waiting = await add('roster', 'Due Up')
    const order = await under()
    const teams = {
      away: { id: TEAM.herons, name: 'Lakeside Herons' },
      home: { id: TEAM.falcons, name: 'Ridgeview Falcons' }
    }
    const setup = newSetup(
      teams,
      {
        away: [],
        home: [
          {
            gumboId: gumbo['Due Up'],
            shortName: 'Due U'
          }
        ]
      },
      false
    )
    setup.sides.home.battingOrder = [gumbo['Due Up']]
    await db!
      .updateTable('games')
      .set({
        currentPlay: JSON.stringify({
          about: { atBatIndex: 0 },
          teamStation: { version: 2, setupBefore: setup, actions: [] }
        })
      })
      .where('id', '=', order)
      .execute()
    await decide('Due Up', waiting.requestId!, 'decline')

    const rows = await db!
      .selectFrom('game_withdrawn_players')
      .select('game_id')
      .where('game_id', 'in', [mound, order])
      .orderBy('game_id')
      .execute()
    expect(rows.map(row => row.game_id).sort()).deep.equals(
      [mound, order].sort()
    )
    await db!
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', 'in', [mound, order])
      .execute()
  })

  it('leaves a role given since the add when it is rejected', async function () {
    await person('Now Coaching', { login: true })
    const added = await add('roster', 'Now Coaching')
    await role(ids['Now Coaching'], TEAM.falcons, 'coach')
    await decide('Now Coaching', added.requestId!, 'decline')
    expect(await membership('Now Coaching', TEAM.falcons)).to.include({
      is_player: false
    })
  })

  it('finds the ask already waiting under an account merged since', async function () {
    await person('Merged Asker', { login: true })
    const first = await add('roster', 'Merged Asker')
    await decide('Merged Asker', first.requestId!, 'decline')
    const terms = (userId: string): PlayerAddTerms => ({
      kind: 'playerAdd',
      mode: 'roster',
      userId,
      teamId: TEAM.falcons,
      jersey: null,
      positions: [],
      teamName: 'Ridgeview Falcons'
    })
    const actor = { userId: ids['Dave Roberts'], isAdmin: false, scopes: [] }
    const ask = async (userId: string): Promise<unknown> =>
      await atomic(
        db!,
        async trx => await addByPolicy(trx, actor, terms(userId), clock)
      )
    const asked = (await ask(ids['Merged Asker'])) as { requestId: string }
    await person('Kept Asker', { login: true })
    await db!
      .updateTable('users')
      .set({ merged_into: ids['Kept Asker'] })
      .where('id', '=', ids['Merged Asker'])
      .execute()
    expect(await ask(ids['Kept Asker'])).to.include({
      kind: 'pending',
      requestId: asked.requestId
    })
  })
})
