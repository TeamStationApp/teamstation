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
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { hashToken } from '../auth/tokens'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { gameAvailability } from '../games/rosterAvailability'
import { refuseOtherSide } from '../groups/noticePolicy'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { lineupRoutes } from '../routes/lineups'
import { playerRoutes } from '../routes/players'
import { ensureGumboId, insertUser } from '../users/insertUser'

/**
 * `POST /teams/:teamId/roster-players` and `POST /games/:gameId/guest-players`
 * with `{ userId }`, through the real routers.
 *
 * The coach coaches and scores the Falcons, who play the Herons today. Mookie Betts and
 * Freddie Freeman play for the Owls; Betts has a guardian. Tony Kemp is a
 * Falcons parent, a member who does not play there, and plays for the Bears.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_existing_${process.pid}_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const COACH = 'tok_existing_coach_00000000000000000'
const FAN = 'tok_existing_fan_0000000000000000000'
const TEAM = {
  falcons: 'tem_existingAFalcons',
  herons: 'tem_existingAHerons',
  owls: 'tem_existingAOwls',
  bears: 'tem_existingABears'
}
const GAME = 'gam_existingAGame'
const FINAL = 'gam_existingAFinal'

describe('adding a player who already exists', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const ids: Record<string, string> = {}
  const gumbo: Record<string, number> = {}

  async function person(
    name: string,
    teamId?: string,
    isPlayer = true
  ): Promise<string> {
    const [first, ...rest] = name.split(' ')
    const userId = await insertUser(db!, {
      display_name: name,
      first_name: first,
      last_name: rest.join(' '),
      bats: 'left',
      throws: 'right',
      login_enabled: true
    })
    gumbo[name] = await ensureGumboId(db!, userId)
    if (teamId != null)
      await db!
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: teamId,
          role: 'member',
          is_player: isPlayer
        })
        .execute()
    ids[name] = userId
    return userId
  }

  async function post(
    path: string,
    body: unknown,
    token = COACH,
    key?: string
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(key == null ? {} : { 'idempotency-key': key })
      },
      body: JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  const roster = async (
    body: unknown,
    token?: string,
    key?: string
  ): ReturnType<typeof post> =>
    await post(`/teams/${TEAM.falcons}/roster-players`, body, token, key)
  const guest = async (body: unknown, game = GAME): ReturnType<typeof post> =>
    await post(`/games/${game}/guest-players`, body)

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
      .insertInto('leagues')
      .values({ id: 'lea_existingA', name: 'Valley League' })
      .execute()
    await db
      .insertInto('teams')
      .values(
        [
          { id: TEAM.falcons, name: 'Ridgeview Falcons' },
          { id: TEAM.herons, name: 'Lakeside Herons' },
          { id: TEAM.owls, name: 'Ridgeview Owls' },
          { id: TEAM.bears, name: 'Valley Bears' }
        ].map(team => ({ ...team, league_id: 'lea_existingA' }))
      )
      .execute()
    const coach = await person('Dave Roberts', TEAM.falcons, false)
    await d
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: coach,
        scope_type: 'team',
        scope_id: TEAM.falcons,
        role: 'coach'
      })
      .execute()
    // The coach scores the Falcons' games too, so may add to either side.
    await d
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: coach,
        scope_type: 'team',
        scope_id: TEAM.falcons,
        role: 'scorekeeper'
      })
      .execute()
    const fan = await person('Falcon Fan', TEAM.falcons, false)
    await person('Mookie Betts', TEAM.owls)
    const guardian = await person('Mookie Guardian')
    await d
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: guardian,
        related_user_id: ids['Mookie Betts'],
        kind: 'guardian',
        can_manage: true
      })
      .execute()
    await person('Freddie Freeman', TEAM.owls)
    await person('Tony Kemp', TEAM.falcons, false)
    await d
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: ids['Tony Kemp'],
        team_id: TEAM.bears,
        role: 'member',
        is_player: true
      })
      .execute()
    await person('Ryan Helsley', TEAM.herons)
    await person('Nobody Plays')
    const disabled = await person('Pete Alonso', TEAM.owls)
    await d
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', disabled)
      .execute()
    for (const [id, status] of [
      [GAME, 'scheduled'],
      [FINAL, 'final']
    ] as const)
      await d
        .insertInto('games')
        .values({
          id,
          home_team_id: TEAM.falcons,
          away_team_id: TEAM.herons,
          start_at: new Date(),
          status
        })
        .execute()
    await d
      .insertInto('auth_sessions')
      .values(
        [
          [COACH, coach],
          [FAN, fan]
        ].map(([token, userId]) => ({
          id: makeId('authSession'),
          user_id: userId,
          token_hash: hashToken(token),
          created_at: new Date(),
          expires_at: new Date(Date.now() + 3_600_000)
        }))
      )
      .execute()

    const media: MediaContext = {
      mediaRoot: mkdtempSync(join(tmpdir(), 'tsExisting-')),
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
    app.use('/api/v1', playerRoutes(db, media))
    app.use('/api/v1', lineupRoutes(db))
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

  const membership = async (name: string, teamId: string): Promise<any> =>
    await db!
      .selectFrom('memberships')
      .selectAll()
      .where('user_id', '=', ids[name])
      .where('team_id', '=', teamId)
      .executeTakeFirst()

  it('puts an existing player on the roster with a notice, and answers a retry the same', async function () {
    const added = await roster(
      { userId: ids['Mookie Betts'], jersey: '50', positions: ['RF'] },
      COACH,
      'add-betts'
    )
    expect(added.status).equals(201)
    expect(added.body).to.include({
      userId: ids['Mookie Betts'],
      shortName: 'Mookie B',
      jersey: '50',
      isPlayer: true
    })
    expect(added.body.positions).deep.equals(['RF'])
    expect(added.body.nameDetails).equals(undefined)
    expect(added.body.notice.requestId).match(/^inv_/)
    expect(added.body.notice.told).equals('guardians')
    const again = await roster(
      { userId: ids['Mookie Betts'], jersey: '50', positions: ['RF'] },
      COACH,
      'add-betts'
    )
    expect(again).deep.equals(added)
    // Already on the team, a new call changes nothing.
    const unchanged = await roster({ userId: ids['Mookie Betts'] })
    expect(unchanged.status).equals(200)
    expect(unchanged.body.unchanged).equals(true)
    expect(unchanged.body.jersey).equals('50')
    expect(unchanged.body.notice).equals(undefined)
  })

  it('makes a parent of the team a player, and asks first once a notice was rejected', async function () {
    const kemp = await roster({ userId: ids['Tony Kemp'] })
    expect(kemp.status).equals(201)
    expect(await membership('Tony Kemp', TEAM.falcons)).to.include({
      is_player: true,
      role: 'member'
    })
    await db!
      .insertInto('group_requests')
      .values({
        id: 'inv_existingDeclined',
        kind: 'playerAdd',
        sender_id: ids['Dave Roberts'],
        sender_scope_type: 'team',
        sender_scope_id: TEAM.falcons,
        terms: JSON.stringify({ userId: ids['Freddie Freeman'] }),
        status: 'declined',
        sent_at: new Date(),
        expires_at: new Date(Date.now() + 3_600_000),
        initiating_team_id: TEAM.falcons
      })
      .execute()
    const asked = await roster({ userId: ids['Freddie Freeman'] }, COACH, 'ask')
    expect(asked.status).equals(202)
    expect(asked.body.pending.requestId).match(/^inv_/)
    expect(await membership('Freddie Freeman', TEAM.falcons)).equals(undefined)
    expect(
      await roster({ userId: ids['Freddie Freeman'] }, COACH, 'ask')
    ).deep.equals(asked)
    // Asked again under another key while it waits: the same request, and
    // the player's side is asked once.
    const again = await roster(
      { userId: ids['Freddie Freeman'] },
      COACH,
      'again'
    )
    expect(again.status).equals(202)
    expect(again.body.pending.requestId).equals(asked.body.pending.requestId)
    expect(
      await db!
        .selectFrom('group_requests')
        .select('id')
        .where('kind', '=', 'playerAdd')
        .where('status', '=', 'pending')
        .where(sql<boolean>`terms->>'userId' = ${ids['Freddie Freeman']}`)
        .execute()
    ).has.length(1)
    // Unanswered past its date, it lapses: the next add asks afresh.
    await db!
      .updateTable('group_requests')
      .set({
        sent_at: new Date(Date.now() - 7_200_000),
        expires_at: new Date(Date.now() - 1000)
      })
      .where('id', '=', asked.body.pending.requestId)
      .execute()
    const afresh = await roster(
      { userId: ids['Freddie Freeman'] },
      COACH,
      'afresh'
    )
    expect(afresh.status).equals(202)
    expect(afresh.body.pending.requestId).not.equals(
      asked.body.pending.requestId
    )
  })

  it('refuses anybody who is not a player, and anything about the person', async function () {
    for (const name of ['Nobody Plays', 'Pete Alonso'])
      expect((await roster({ userId: ids[name] })).status, name).equals(404)
    expect((await roster({ userId: 'usr_missing' })).status).equals(404)
    for (const key of ['firstName', 'bats', 'throws', 'externalId']) {
      const refused = await roster({ userId: ids['Ryan Helsley'], [key]: 'x' })
      expect(refused.status, key).equals(400)
      expect(JSON.stringify(refused.body)).includes(
        `${key} is not allowed with userId`
      )
    }
    expect((await roster({ userId: '' })).status).equals(400)
    // Not a roster manager of the team.
    expect((await roster({ userId: ids['Ryan Helsley'] }, FAN)).status).equals(
      404
    )
    // The creating body still makes a new player.
    const made = await roster({
      firstName: 'Max',
      lastName: 'Muncy',
      jersey: '13',
      positions: ['3B'],
      bats: 'left',
      throws: 'right'
    })
    expect(made.status).equals(201)
    expect(made.body.nameDetails.firstName).equals('Max')
  })

  it('only asks for a full account that plays for no team, and refuses one switched off', async function () {
    const harper = await person('Bryce Harper')
    const off = await person('Rafael Furcal')
    await db!
      .insertInto('user_emails')
      .values([
        {
          id: makeId('userEmail'),
          user_id: harper,
          email: 'harper@example.test'
        },
        { id: makeId('userEmail'), user_id: off, email: 'furcal@example.test' }
      ])
      .execute()
    await db!
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', off)
      .execute()
    const added = await roster({
      userId: harper,
      jersey: '3',
      positions: ['RF']
    })
    // Nobody's player, so nobody this team has a reason to know: he is asked,
    // and nothing about him reaches the team until he accepts.
    expect(added.status).equals(202)
    expect(added.body.pending.requestId).match(/^inv_/)
    expect(await membership('Bryce Harper', TEAM.falcons)).equals(undefined)
    expect((await roster({ userId: off })).status).equals(404)
  })

  it('never adds a stranger on nobody’s say', async function () {
    // On a team outside the league, with no guardian, no sign-in and no coach
    // to stand in: nobody can answer for them.
    await db!
      .insertInto('teams')
      .values({ id: 'tem_existingAFar', name: 'Faraway Gulls' })
      .execute()
    await person('Faraway Child', 'tem_existingAFar')
    await db!
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', ids['Faraway Child'])
      .execute()
    const asked = await roster({ userId: ids['Faraway Child'] })
    expect(asked.status).equals(403)
    expect(JSON.stringify(asked.body)).includes('Nobody can approve')
    expect(await membership('Faraway Child', TEAM.falcons)).equals(undefined)
  })

  it('adds a coach with no player row of their own to the roster and to a game', async function () {
    const self = ids['Dave Roberts']
    await db!
      .insertInto('user_emails')
      .values({
        id: makeId('userEmail'),
        user_id: self,
        email: 'roberts@example.test'
      })
      .execute()
    const pool = await guest({
      side: 'home',
      teamId: TEAM.falcons,
      userId: self
    })
    expect(pool.status).equals(201)
    await db!
      .deleteFrom('game_guest_details')
      .where('user_id', '=', self)
      .execute()
    const added = await roster({ userId: self })
    expect(added.status).equals(201)
    expect(added.body.notice).equals(undefined)
    expect(await membership('Dave Roberts', TEAM.falcons)).to.include({
      is_player: true
    })
    // Back as they were, for the tests after.
    await db!
      .updateTable('memberships')
      .set({ is_player: false })
      .where('user_id', '=', self)
      .where('team_id', '=', TEAM.falcons)
      .execute()
  })

  it('answers two adds of one person at once as one add', async function () {
    await person('Twice At Once', TEAM.owls)
    const answers = await Promise.all([
      roster({ userId: ids['Twice At Once'] }),
      roster({ userId: ids['Twice At Once'] })
    ])
    expect(answers.map(answer => answer.status)).has.members([200, 201])
  })

  it('adds an existing player to one side of a game as a pool player', async function () {
    const added = await guest({
      side: 'away',
      teamId: TEAM.herons,
      userId: ids['Freddie Freeman'],
      jersey: '5',
      positions: ['1B']
    })
    expect(added.status).equals(201)
    expect(added.body).to.include({
      userId: ids['Freddie Freeman'],
      shortName: 'Freddie F',
      jersey: '5',
      bats: 'left',
      throws: 'right'
    })
    expect(added.body.notice).to.include({ told: 'player' })
    const details = await db!
      .selectFrom('game_guest_details')
      .selectAll()
      .where('game_id', '=', GAME)
      .execute()
    expect(details.map(row => [row.user_id, row.pool, row.jersey])).deep.equals(
      [[ids['Freddie Freeman'], true, '5']]
    )
    const game = await db!
      .selectFrom('games')
      .selectAll()
      .where('id', '=', GAME)
      .executeTakeFirstOrThrow()
    expect((game.guests as Record<string, number[]>)[TEAM.herons]).deep.equals([
      gumbo['Freddie Freeman']
    ])
    const availability = await gameAvailability(db!, game)
    expect(
      availability.guestPlayers.away.map(row => [
        row.shortName,
        row.bats,
        row.throws
      ])
    ).deep.equals([['Freddie F', 'left', 'right']])
    expect(availability.guestPlayers.away[0].pool).equals(true)

    // In the game once: on either side, and not as a player of either team.
    const twice = await guest({ side: 'home', userId: ids['Freddie Freeman'] })
    expect(twice.status).equals(409)
    expect(JSON.stringify(twice.body)).includes('already in this game')
    // Nor onto the other team's roster while that game is still to play.
    const across = await roster({ userId: ids['Freddie Freeman'] })
    expect(across.status).equals(409)
    expect(JSON.stringify(across.body)).includes(
      'plays for the other team in the game on'
    )
    expect(await membership('Freddie Freeman', TEAM.falcons)).equals(undefined)
    // Nor from the other team's roster: a scoring read of that game would throw.
    const opposing = await roster({ userId: ids['Ryan Helsley'] })
    expect(opposing.status).equals(409)
    expect(JSON.stringify(opposing.body)).includes(
      'plays for the other team in the game on'
    )
    expect(await membership('Ryan Helsley', TEAM.falcons)).equals(undefined)
    // A game long past that nobody scored holds nothing up.
    const { start_at: starts } = await db!
      .selectFrom('games')
      .select('start_at')
      .where('id', '=', GAME)
      .executeTakeFirstOrThrow()
    await db!
      .updateTable('games')
      .set({ start_at: new Date(Date.now() - 30 * 86_400_000) })
      .where('id', '=', GAME)
      .execute()
    const stale = await atomic(db!, async trx => {
      await refuseOtherSide(trx, [ids['Ryan Helsley']], {
        kind: 'playerAdd',
        mode: 'roster',
        userId: ids['Ryan Helsley'],
        teamId: TEAM.falcons,
        jersey: null,
        positions: [],
        teamName: 'Ridgeview Falcons'
      })
      return 'allowed'
    })
    expect(stale).equals('allowed')
    await db!
      .updateTable('games')
      .set({ start_at: starts })
      .where('id', '=', GAME)
      .execute()
    // Unless that game left them out of it.
    await db!
      .updateTable('games')
      .set({
        unrostered: JSON.stringify({ [TEAM.herons]: [gumbo['Ryan Helsley']] })
      })
      .where('id', '=', GAME)
      .execute()
    expect((await roster({ userId: ids['Ryan Helsley'] })).status).equals(201)
    await db!
      .updateTable('games')
      .set({ unrostered: JSON.stringify({}) })
      .where('id', '=', GAME)
      .execute()
    for (const name of ['Ryan Helsley', 'Mookie Betts']) {
      const rostered = await guest({ side: 'away', userId: ids[name] })
      expect(rostered.status, name).equals(409)
      expect(JSON.stringify(rostered.body)).includes(
        'already on a team in this game'
      )
    }
    expect(
      (await guest({ side: 'home', userId: ids['Nobody Plays'] })).status
    ).equals(404)
    expect(
      (await guest({ side: 'home', userId: ids['Tony Kemp'], bats: 'left' }))
        .status
    ).equals(400)
    // A game that is over takes nobody, by the same gate as a new guest.
    const over = await guest({ side: 'home', userId: ids['Tony Kemp'] }, FINAL)
    expect(over.status).equals(409)
    expect(JSON.stringify(over.body)).includes('cannot accept players')
    // Expected another team on the side: refused as a new guest is.
    expect(
      (
        await guest({
          side: 'home',
          teamId: TEAM.herons,
          userId: ids['Tony Kemp']
        })
      ).status
    ).equals(409)
    // A new guest is still made, and is no pool player.
    const made = await guest({
      side: 'home',
      firstName: 'Max',
      lastName: 'Fried',
      jersey: '54',
      positions: ['P'],
      bats: 'left',
      throws: 'left'
    })
    expect(made.status).equals(201)
    const fried = await db!
      .selectFrom('game_guest_details')
      .select('pool')
      .where('user_id', '=', made.body.userId)
      .executeTakeFirstOrThrow()
    expect(fried.pool).equals(false)
  })

  it('asks first for a pool add once one was rejected', async function () {
    await db!
      .insertInto('group_requests')
      .values({
        id: 'inv_existingPoolDeclined',
        kind: 'playerAdd',
        sender_id: ids['Dave Roberts'],
        sender_scope_type: 'team',
        sender_scope_id: TEAM.falcons,
        terms: JSON.stringify({ userId: ids['Mookie Betts'] }),
        status: 'declined',
        sent_at: new Date(),
        expires_at: new Date(Date.now() + 3_600_000),
        initiating_team_id: TEAM.herons
      })
      .execute()
    await db!
      .deleteFrom('memberships')
      .where('user_id', '=', ids['Mookie Betts'])
      .where('team_id', '=', TEAM.falcons)
      .execute()
    const asked = await guest({ side: 'away', userId: ids['Mookie Betts'] })
    expect(asked.status).equals(202)
    expect(asked.body.pending.requestId).match(/^inv_/)
  })
  it('rebuilds a replayed answer whose stored copy is gone, and answers an add with nobody to tell', async function () {
    const forget = async (key: string): Promise<void> => {
      await db!
        .updateTable('sync_idempotency')
        .set({ status: null, body: null })
        .where('key', '=', key)
        .execute()
    }
    const loner = await person('Lonely Pirate', TEAM.bears)
    await db!
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', loner)
      .execute()
    const added = await roster({ userId: loner }, COACH, 'loner')
    expect(added.status).equals(201)
    expect(added.body.notice).equals(undefined)
    await forget('loner')
    expect(await roster({ userId: loner }, COACH, 'loner')).deep.equals(added)
    // The same for an unchanged add and for one waiting on approval.
    const kept = await roster({ userId: loner }, COACH, 'loner-again')
    expect(kept.status).equals(200)
    await forget('loner-again')
    expect(await roster({ userId: loner }, COACH, 'loner-again')).deep.equals(
      kept
    )
    await forget('ask')
    const asked = await roster({ userId: ids['Freddie Freeman'] }, COACH, 'ask')
    expect(asked.status).equals(202)
    expect(asked.body.pending.requestId).match(/^inv_/)
  })
})
