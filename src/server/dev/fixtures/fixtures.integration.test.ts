import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { buildSchedule } from '../../../common/scheduler/engine'
import { migrations } from '../../../migrate/migrations'
import { migrateUp } from '../../../migrate/runner'
import {
  dropScratchDatabase,
  testDatabaseUrl
} from '../../../migrate/testDatabase'
import { readPasswordRecord } from '../../auth/passwords'
import { preparePreview } from '../../autoScheduler/previews'
import { type Database, makeDatabase } from '../../db/database'
import { accountMailEnabled } from '../../email/accountMail'
import { serverConfig } from '../../serverConfig'
import { createAccount, type FixtureManifest, makeNonce } from './accounts'
import { isTestAddress, splitMailbox, testAddress } from './address'
import { refuseRealAddresses, runBaseline } from './baseline'
import {
  parseFixtureArgs,
  refuseWithoutTestSettings,
  runCli,
  runFixture,
  WORLDS
} from './cli'
import { runCoachGame } from './coachGame'
import { NODE_SETTINGS, UNSET_SETTINGS } from './nodeSettings'
import { runPackedLeague, runPackedLeagueLimit } from './packedLeague'
import { runRefreshNotices } from './refreshNotices'
import {
  hasGroupCoordinates,
  runSearch,
  SEARCH_JEV_PLACEHOLDER
} from './search'
import { runStreaming } from './streaming'
import { runTeamWithRoster } from './teamWithRoster'
import { RATE_LIMIT_SCALE, runTess } from './tess'

const MAILBOX = 'testmailbox@example.test'
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_fixtures_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

/** The message `run` rejects with, or fails when it resolves. */
async function rejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a rejection')
}

describe('fixture addresses', function () {
  it('makes only + addresses on the mailbox, and knows one when it sees one', function () {
    expect(testAddress(MAILBOX, 'World-Role-1')).equals(
      'testmailbox+world-role-1@example.test'
    )
    expect(isTestAddress(MAILBOX, 'TestMailbox+a@example.test')).equals(true)
    expect(isTestAddress(MAILBOX, MAILBOX)).equals(false)
    expect(isTestAddress(MAILBOX, 'pat+a@example.test')).equals(false)
    expect(isTestAddress(MAILBOX, 'testmailbox+a@other.test')).equals(false)
  })

  it('refuses a mailbox that is not one', function () {
    for (const bad of [
      '',
      'nobody',
      '@example.test',
      'a@',
      'a+b@example.test'
    ]) {
      expect(() => splitMailbox(bad)).to.throw('not a plain mailbox')
    }
  })
})

describe('the fixtures script', function () {
  it('refuses unless testSettings is true, whatever NODE_ENV says', function () {
    const saved = process.env.NODE_ENV
    for (const env of ['production', 'test', undefined]) {
      process.env.NODE_ENV = env
      expect(() => {
        refuseWithoutTestSettings(false)
      }).to.throw('testSettings')
    }
    process.env.NODE_ENV = saved
    refuseWithoutTestSettings(true)
  })

  it('refuses to run without a mailbox or a known world', function () {
    expect(() => parseFixtureArgs(['baseline', '--json'])).to.throw('Usage')
    expect(() => parseFixtureArgs(['--mailbox', MAILBOX])).to.throw('Usage')
    for (const name of ['constructor', 'toString', '__proto__']) {
      expect(
        () => parseFixtureArgs([name, '--mailbox', MAILBOX]),
        name
      ).to.throw('No fixture world')
    }
    expect(() => parseFixtureArgs(['nowhere', '--mailbox', MAILBOX])).to.throw(
      'No fixture world'
    )
    expect(() =>
      parseFixtureArgs(['baseline', '--mailbox', 'not-a-mailbox'])
    ).to.throw('not a plain mailbox')
    expect(
      parseFixtureArgs(['baseline', '--json', '--mailbox', MAILBOX])
    ).deep.equals({ world: 'baseline', mailbox: MAILBOX })
    expect(Object.keys(WORLDS)).includes('team-with-roster')
    expect(Object.keys(WORLDS)).includes('streaming')
    expect(Object.keys(WORLDS)).includes('packed-league')
    expect(Object.keys(WORLDS)).includes('packed-league-limit')
  })
})

describe('fixture worlds', function () {
  this.timeout(120000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  const the = (): Kysely<Database> => {
    if (db == null) throw new Error('no database')
    return db
  }

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
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
  })

  after(async function () {
    await db?.destroy()
    if (adminPool != null) {
      await dropScratchDatabase(adminPool, scratchName)
      await adminPool.end()
    }
  })

  it('baseline makes all its accounts or none, so no password is lost to a failure part way', async function () {
    const { sql } = await import('kysely')
    // The member's insert fails after the admin's has gone in.
    await sql`create function e2e_refuse_griffey() returns trigger language plpgsql as $$
      begin
        if new.last_name = 'Griffey' then raise exception 'refused for the test'; end if;
        return new;
      end $$`.execute(the())
    await sql`create trigger e2e_refuse_griffey before insert on users
      for each row execute function e2e_refuse_griffey()`.execute(the())
    try {
      expect(
        await rejection(async () => await runBaseline(the(), MAILBOX))
      ).includes('refused for the test')
    } finally {
      await sql`drop trigger e2e_refuse_griffey on users`.execute(the())
      await sql`drop function e2e_refuse_griffey()`.execute(the())
    }
    const emails = await the()
      .selectFrom('user_emails')
      .select('email')
      .execute()
    expect(emails).deep.equals([])
  })

  it('baseline succeeds on an empty database, and a second run is idempotent', async function () {
    const first = await runBaseline(the(), MAILBOX)
    expect(Object.keys(first.accounts).sort()).deep.equals(['admin', 'member'])
    const users = async (): Promise<number> =>
      (await the().selectFrom('users').select('id').execute()).length
    const count = await users()
    const second = await runBaseline(the(), MAILBOX)
    expect(second.accounts).deep.equals({})
    expect(await users()).equals(count)
    expect(await accountMailEnabled(the())).equals(true)
    const rows = await the()
      .selectFrom('system_settings')
      .select(['key', 'value'])
      .execute()
    for (const [key, value] of Object.entries(NODE_SETTINGS)) {
      expect(rows.find(row => row.key === key)?.value, key).deep.equals(value)
    }
    const admin = first.accounts.admin
    expect(admin.role).equals('admin')
    const row = await the()
      .selectFrom('users')
      .select(['is_admin', 'password_hash', 'onboarding_step'])
      .where('id', '=', admin.userId as never)
      .executeTakeFirstOrThrow()
    expect(row.is_admin).equals(true)
    expect(row.onboarding_step).equals('complete')
    // F5: stored hashed, in no row in plain text.
    expect(row.password_hash).not.includes(admin.password)
    expect(readPasswordRecord(row.password_hash)).not.equals(null)
  })

  it('baseline refuses a database holding any other address', async function () {
    const other = 'otherbox@example.test'
    expect(
      await rejection(async () => await runBaseline(the(), other))
    ).includes('not test addresses')
    expect(
      await rejection(async () => {
        await refuseRealAddresses(the(), other)
      })
    ).includes('fixtures refuse')
  })

  it('gives two worlds under different nonces no user or team in common', async function () {
    const run = async (): Promise<FixtureManifest> =>
      await runTeamWithRoster({
        db: the(),
        mailbox: MAILBOX,
        nonce: makeNonce()
      })
    const [a, b] = [await run(), await run()]
    expect(a.nonce).not.equals(b.nonce)
    expect(a.ids.team).not.equals(b.ids.team)
    const ids = (m: FixtureManifest): string[] =>
      Object.values(m.accounts).map(account => account.userId)
    expect(ids(a).filter(id => ids(b).includes(id))).deep.equals([])
    const emails = Object.values(a.accounts).map(account => account.email)
    expect(emails.every(email => isTestAddress(MAILBOX, email))).equals(true)
    const members = await the()
      .selectFrom('memberships')
      .select(['user_id', 'is_player'])
      .where('team_id', '=', a.ids.team)
      .execute()
    expect(members.length).greaterThanOrEqual(2)
    // The two players are on the roster as players.
    for (const role of ['player', 'teammate']) {
      const row = members.find(m => m.user_id === a.accounts[role].userId)
      expect(row?.is_player, role).equals(true)
    }
    const team = await the()
      .selectFrom('teams')
      .select('name')
      .where('id', '=', a.ids.team)
      .executeTakeFirstOrThrow()
    expect(team.name).includes(a.nonce)
  })

  it('packed-league gives its admin a league of six seasons, ready to schedule, under each nonce', async function () {
    const run = async (): Promise<FixtureManifest> =>
      await runPackedLeague({
        db: the(),
        mailbox: MAILBOX,
        nonce: makeNonce()
      })
    const [a, b] = [await run(), await run()]
    expect(a.world).equals('packed-league')
    expect(a.ids.league).not.equals(b.ids.league)
    const teamsOf = (m: FixtureManifest): string[] =>
      Object.entries(m.ids)
        .filter(([key]) => key.startsWith('tem_'))
        .map(([, id]) => id)
    expect(teamsOf(a)).lengthOf(51)
    expect(teamsOf(a).filter(id => teamsOf(b).includes(id))).deep.equals([])
    expect(a.accounts.admin.userId).not.equals(b.accounts.admin.userId)
    expect(isTestAddress(MAILBOX, a.accounts.admin.email)).equals(true)
    const administers = await the()
      .selectFrom('scope_roles')
      .select('role')
      .where('user_id', '=', a.accounts.admin.userId)
      .where('scope_type', '=', 'league')
      .where('scope_id', '=', a.ids.league)
      .executeTakeFirstOrThrow()
    expect(administers.role).equals('admin')
    const setup = await the()
      .selectFrom('league_schedule_setups')
      .select(['season_ids', 'field_ids', 'avoid_head_coach_conflicts'])
      .where('league_id', '=', a.ids.league)
      .executeTakeFirstOrThrow()
    expect(setup.season_ids).lengthOf(6)
    expect(setup.field_ids).lengthOf(5)
    expect(setup.avoid_head_coach_conflicts).equals(true)
    const settings = await the()
      .selectFrom('season_schedule_settings')
      .select(['season_id', 'field_ids'])
      .where('season_id', 'in', setup.season_ids)
      .execute()
    expect(settings).lengthOf(6)
    for (const row of settings) expect(row.field_ids).lengthOf(1)
    // Six head coaches coach a team in two seasons.
    const coaches = await the()
      .selectFrom('scope_roles')
      .select('user_id')
      .where('is_head_coach', '=', true)
      .where('scope_id', 'in', teamsOf(a))
      .execute()
    expect(coaches).lengthOf(51)
    expect(new Set(coaches.map(row => row.user_id)).size).equals(45)
    // The server's own preparation reads it as the packed league: built by
    // the engine, its seasons get 10, 10, 12, 14, 16 and 16 games per team.
    const prepared = await preparePreview(
      the(),
      { userId: a.accounts.admin.userId, isAdmin: false, scopes: [] },
      a.ids.league,
      { mode: 'full' },
      { now: () => new Date('2026-11-16T08:00:00Z') }
    )
    const built = await buildSchedule({ input: prepared.input })
    if (built.kind !== 'options') expect.fail(built.message)
    expect(
      built.targets.map(target => target.regular).sort((x, y) => x - y)
    ).deep.equals([10, 10, 12, 14, 16, 16])
  })

  it('packed-league-limit is the packed league with a 3 s solver limit', async function () {
    const m = await runPackedLeagueLimit({
      db: the(),
      mailbox: MAILBOX,
      nonce: makeNonce()
    })
    expect(m.world).equals('packed-league-limit')
    const setup = await the()
      .selectFrom('league_schedule_setups')
      .select(['season_ids', 'solver_limit_ms'])
      .where('league_id', '=', m.ids.league)
      .executeTakeFirstOrThrow()
    expect(setup.season_ids).lengthOf(6)
    expect(setup.solver_limit_ms).equals(3000)
    const admin = {
      userId: m.accounts.admin.userId,
      isAdmin: false,
      scopes: []
    }
    const clock = { now: () => new Date('2026-11-16T08:00:00Z') }
    // Only a test server gives the device the league's own limit.
    expect(
      (
        await preparePreview(
          the(),
          admin,
          m.ids.league,
          { mode: 'full' },
          clock,
          {
            testSettings: true
          }
        )
      ).solverLimitMs
    ).equals(3000)
    expect(
      (
        await preparePreview(
          the(),
          admin,
          m.ids.league,
          { mode: 'full' },
          clock
        )
      ).solverLimitMs
    ).equals(120000)
  })

  it('streaming gives the coach the home team, an empty game and one with two videos', async function () {
    const world = await runStreaming({
      db: the(),
      mailbox: MAILBOX,
      nonce: makeNonce()
    })
    const roles = await the()
      .selectFrom('memberships')
      .select(['user_id', 'role', 'is_player'])
      .where('team_id', '=', world.ids.homeTeam)
      .execute()
    const of = (name: string): (typeof roles)[number] | undefined =>
      roles.find(row => row.user_id === world.accounts[name].userId)
    expect(of('coach')?.role).equals('owner')
    expect(of('viewer')?.role).equals('member')
    expect(of('player')?.is_player).equals(true)
    const videos = await the()
      .selectFrom('videos')
      .select(['game_id', 'title'])
      .where('game_id', 'in', [world.ids.game, world.ids.gameWithVideos])
      .execute()
    expect(videos.map(video => video.game_id)).deep.equals([
      world.ids.gameWithVideos,
      world.ids.gameWithVideos
    ])
    expect(videos.map(video => video.title).sort()).deep.equals([
      'First Base',
      'Home Plate'
    ])
  })

  it('refresh-notices gives a spectator 320 games on four teams, and a scorekeeper four soon on three of them', async function () {
    const world = await runRefreshNotices({
      db: the(),
      mailbox: MAILBOX,
      nonce: makeNonce()
    })
    const teams = world.ids.teams.split(',')
    expect(teams).to.have.length(4)
    const games = await the()
      .selectFrom('games')
      .select(['id', 'start_at', 'status', 'home_team_id', 'away_team_id'])
      .where('home_team_id', 'in', teams)
      .execute()
    expect(games).to.have.length(320)
    const soon = world.ids.soon.split(',')
    const now = Date.now()
    for (const id of soon) {
      const game = games.find(row => row.id === id)!
      const hours = (new Date(game.start_at).getTime() - now) / 3_600_000
      expect(hours).within(0, 96)
      expect(game.status).equals('scheduled')
    }
    const memberships = await the()
      .selectFrom('memberships')
      .select('team_id')
      .where('user_id', '=', world.accounts.spectator.userId as never)
      .execute()
    expect(memberships.map(row => row.team_id).sort()).deep.equals(
      [...teams].sort()
    )
    const roles = await the()
      .selectFrom('scope_roles')
      .select(['scope_id', 'role'])
      .where('user_id', '=', world.accounts.scorer.userId as never)
      .execute()
    expect(roles.map(row => row.scope_id).sort()).deep.equals(
      teams.slice(0, 3).sort()
    )
    expect(roles.every(row => row.role === 'scorekeeper')).equals(true)
  })

  it('coach-game gives the home team a head coach, an assistant and a scorekeeper, and names its lineup', async function () {
    const world = await runCoachGame({
      db: the(),
      mailbox: MAILBOX,
      nonce: makeNonce()
    })
    const roles = await the()
      .selectFrom('scope_roles')
      .select(['user_id', 'role'])
      .where('scope_type', '=', 'team')
      .where('scope_id', '=', world.ids.homeTeam)
      .execute()
    const roleOf = (name: string): string[] =>
      roles
        .filter(row => row.user_id === world.accounts[name].userId)
        .map(row => row.role)
    expect(roleOf('coach')).deep.equals(['coach'])
    expect(roleOf('assistant')).deep.equals(['assistant'])
    expect(roleOf('scorekeeper')).deep.equals(['scorekeeper'])
    for (const account of Object.values(world.accounts)) {
      expect(isTestAddress(MAILBOX, account.email)).equals(true)
    }
    const game = await the()
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id', 'status'])
      .where('id', '=', world.ids.game)
      .executeTakeFirstOrThrow()
    expect(game).deep.equals({
      home_team_id: world.ids.homeTeam,
      away_team_id: world.ids.awayTeam,
      status: 'scheduled'
    })
    const lineup = Array.from(
      { length: 9 },
      (_, i) => world.ids[`homePlayer${i + 1}`]
    )
    expect(new Set(lineup).size).equals(9)
    const jerseys = await the()
      .selectFrom('memberships')
      .innerJoin('gumbo_ids', 'gumbo_ids.user_id', 'memberships.user_id')
      .select(['gumbo_ids.gumbo_id', 'memberships.jersey'])
      .where('memberships.team_id', '=', world.ids.homeTeam)
      .where('memberships.is_player', '=', true)
      .execute()
    expect(
      lineup.map(id => jerseys.find(row => String(row.gumbo_id) === id)?.jersey)
    ).deep.equals(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    // The world runs on a database the baseline accepts: no other address.
    expect(await refuseRealAddresses(the(), MAILBOX)).not.equals(undefined)
  })

  it('search gives each scenario its own named organizations, people in and out of reach, and a Jev key', async function () {
    const { searchOnce } = await import('../../search/engine')
    const { jevKey } = await import('../../nodeSettings')
    const world = await runSearch({
      db: the(),
      mailbox: MAILBOX,
      nonce: makeNonce()
    })
    const other = await runSearch({
      db: the(),
      mailbox: MAILBOX,
      nonce: makeNonce()
    })
    expect(Object.keys(world.accounts).sort()).deep.equals([
      'child',
      'coach',
      'guardian',
      'hawk',
      'nodeAdmin',
      'reliever',
      'seasonPlayer',
      'stranger',
      'teammate'
    ])
    expect(await jevKey(the())).equals(SEARCH_JEV_PLACEHOLDER)
    const admin = await the()
      .selectFrom('users')
      .select('is_admin')
      .where('id', '=', world.accounts.nodeAdmin.userId as never)
      .executeTakeFirstOrThrow()
    expect(admin.is_admin).equals(true)
    // Every league and team has the coordinates of its city.
    expect(await hasGroupCoordinates(the())).equals(true)
    const placed = await the()
      .selectFrom('teams')
      .select(['name', 'latitude'])
      .where('name', 'like', `%${world.nonce}`)
      .execute()
    expect(placed.length).equals(9)
    expect(placed.every(row => row.latitude != null)).equals(true)

    const deps = {
      space: {
        endpoint: '',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        pathStyle: false
      },
      jevBaseUrl: 'http://127.0.0.1:1',
      log: () => undefined
    }
    const actor = (
      role: string
    ): { userId: string; isAdmin: boolean; scopes: [] } => ({
      userId: world.accounts[role].userId,
      isAdmin: false,
      scopes: []
    })
    const ask = (
      text: string,
      location: any = null
    ): { text: string; location: any; mode: 'all' } => ({
      text,
      location,
      mode: 'all' as const
    })
    const names = async (
      role: string | null,
      text: string,
      location: any = null
    ): Promise<string[]> =>
      (
        await searchOnce(
          the(),
          role == null ? null : actor(role),
          ask(text, location),
          deps
        )
      ).results.map(result => result.name)
    const tag = world.nonce

    // One field finds the four kinds, the world's own only.
    const coach = await searchOnce(
      the(),
      actor('coach'),
      ask(`hawk ${tag}`),
      deps
    )
    const kinds = new Set(coach.results.map(result => result.kind))
    expect([...kinds].sort()).deep.equals([
      'league',
      'person',
      'season',
      'team'
    ])
    // Another world's match one typed word of two, after all of this one's.
    const mine = coach.results.map(result => result.name.endsWith(tag))
    expect(mine.lastIndexOf(true)).lessThan(
      coach.results.findIndex(result => result.name.endsWith(other.nonce))
    )
    const follow = (name: string): unknown =>
      coach.results.find(result => result.name === `${name} ${tag}`)
    expect((follow('Demo Hawks') as any).follow).equals(null)
    expect((follow('Ridge Hawks') as any).follow).equals('follow')
    const shown = coach.results.map(result => result.name)
    expect(shown.indexOf(`Hawks Blue ${tag}`)).lessThan(
      shown.indexOf(`Hawks Gold ${tag}`)
    )

    // The guardian finds the child's teammate only by both names, shortened.
    expect(await names('guardian', 'Freddie')).includes('Freddie F')
    expect(await names('guardian', 'Freeman')).deep.equals([])
    expect(await names('guardian', 'Freddie Freeman')).deep.equals([
      'Freddie F'
    ])
    expect(await names('guardian', 'Yoshinobu Yamamoto')).deep.equals([])
    // Signed out: organizations, and nobody.
    const signedOut = await names(null, `hawk ${tag}`)
    expect(signedOut).includes(`Ridge Hawks ${tag}`)
    expect(signedOut.some(name => name.startsWith('LaTroy'))).equals(false)
    expect(await names(null, 'LaTroy Hawkins')).deep.equals([])

    // Add Player finds a player of the same season, never one of another league.
    const adding = async (text: string): Promise<string[]> =>
      (
        await searchOnce(
          the(),
          actor('coach'),
          { text, location: null, mode: 'people', forTeam: world.ids.team },
          deps
        )
      ).results.map(result => result.name)
    expect(await adding('Corbin')).deep.equals(['Corbin Burnes'])
    expect(await adding('Yoshinobu Yamamoto')).deep.equals([])
    expect(await adding('Freddie')).deep.equals([])

    // The pills the location scenarios tap.
    const pills = async (text: string): Promise<string[]> =>
      (await searchOnce(the(), actor('coach'), ask(text), deps)).locations.map(
        location => location.label
      )
    expect((await pills('san die'))[0]).equals('San Diego, CA')
    expect(await pills('californ')).includes('California')

    // San Diego first, then the cities around it by distance; no people.
    const sanDiego = {
      kind: 'city',
      id: 'geonames:5391811',
      label: 'San Diego, CA',
      city: 'San Diego',
      region: 'California',
      country: 'US',
      latitude: 32.71571,
      longitude: -117.16472
    }
    const widened = await searchOnce(
      the(),
      actor('coach'),
      ask(`hawk ${tag}`, sanDiego),
      deps
    )
    // Another world's are in the same rings, after this one's in each.
    const teams = widened.results
      .filter(result => result.kind === 'team' && result.name.endsWith(tag))
      .map(result => result.name.replace(` ${tag}`, ''))
    expect(teams).deep.equals([
      'Demo Hawks',
      'Bay Hawks',
      'Ridge Hawks',
      'Hawks Blue',
      'Hawks Gold',
      'East Hawks',
      'North Hawks',
      'Desert Hawks',
      'Capital Hawks'
    ])
    expect(widened.results.some(result => result.kind === 'person')).equals(
      false
    )
    // California only, with no widening.
    const california = await names('coach', `hawk ${tag}`, {
      kind: 'region',
      id: 'region:US:California',
      label: 'California',
      region: 'California',
      country: 'US'
    })
    expect(california).includes(`Capital Hawks ${tag}`)
    expect(california.some(name => name.startsWith('Desert'))).equals(false)
  })

  it('search knows a database without organization coordinates', async function () {
    const { sql } = await import('kysely')
    await the()
      .transaction()
      .execute(async trx => {
        await sql`alter table leagues drop column latitude cascade`.execute(trx)
        expect(await hasGroupCoordinates(trx)).equals(false)
        throw new Error('rolled back')
      })
      .catch((error: unknown) => {
        expect((error as Error).message).equals('rolled back')
      })
    expect(await hasGroupCoordinates(the())).equals(true)
  })

  it('tess gives the admin Demo Hawks in the umpired league, eight games, a player the admin cannot see and room for its sign-in codes, twice over', async function () {
    const worlds = [
      await runTess({ db: the(), mailbox: MAILBOX, nonce: makeNonce() }),
      await runTess({ db: the(), mailbox: MAILBOX, nonce: makeNonce() })
    ]
    const [world, again] = worlds
    expect(again.ids.teamA).not.equals(world.ids.teamA)
    const hawks = await the()
      .selectFrom('teams')
      .select('name')
      .where('id', '=', world.ids.teamA)
      .executeTakeFirstOrThrow()
    expect(hawks.name).equals('Demo Hawks')
    const games = await the()
      .selectFrom('games')
      .select(['id', 'status'])
      .where(eb =>
        eb.or([
          eb('home_team_id', '=', world.ids.teamA),
          eb('away_team_id', '=', world.ids.teamA)
        ])
      )
      .execute()
    expect(games).length(8)
    expect(games.filter(game => game.status === 'final')).length(7)
    const umpire = await the()
      .selectFrom('league_umpires')
      .select('user_id')
      .where('league_id', '=', world.ids.league)
      .executeTakeFirstOrThrow()
    expect(umpire.user_id).equals(world.accounts.admin.userId)
    const hidden = await the()
      .selectFrom('memberships')
      .select(['team_id', 'jersey'])
      .where('user_id', '=', world.ids.hiddenPlayer as never)
      .executeTakeFirstOrThrow()
    expect(hidden.team_id).equals(world.ids.standaloneTeam)
    const adminTeams = await the()
      .selectFrom('memberships')
      .select('team_id')
      .where('user_id', '=', world.accounts.admin.userId as never)
      .execute()
    expect(adminTeams.map(row => row.team_id)).not.includes(
      world.ids.standaloneTeam
    )
    const scale = await the()
      .selectFrom('system_settings')
      .select('value')
      .where('key', '=', 'test.rateLimitScale')
      .executeTakeFirstOrThrow()
    expect(scale.value).equals(RATE_LIMIT_SCALE)
  })

  it('creates accounts with no role by default and distinct passwords', async function () {
    const context = { db: the(), mailbox: MAILBOX, nonce: makeNonce() }
    const person = { first: 'Pat', last: 'Neshek' }
    const one = await createAccount(context, 'w', 'one', person)
    const two = await createAccount(context, 'w', 'two', person)
    expect(one.password).not.equals(two.password)
    expect(one.email).not.equals(two.email)
    expect(one.displayName).equals('Pat Neshek')
  })

  it('prints the manifest on stdout, and only why it failed on stderr', async function () {
    const saved = serverConfig.testSettings
    const savedUrl = serverConfig.databaseUrl
    const printed: string[] = []
    const failed: string[] = []
    const out = {
      log: (line: string) => printed.push(line),
      error: (line: string) => failed.push(line)
    }
    try {
      serverConfig.testSettings = true
      serverConfig.databaseUrl = scratchUrl
      const argv = ['team-with-roster', '--json', '--mailbox', MAILBOX]
      expect(await runCli(argv, out)).equals(0)
      expect(JSON.parse(printed[0]).world).equals('team-with-roster')
      expect(failed).deep.equals([])
      expect(await runCli(['nowhere', '--mailbox', MAILBOX], out)).equals(1)
      expect(failed[0]).includes('No fixture world')
      expect(printed.length).equals(1)
    } finally {
      serverConfig.testSettings = saved
      serverConfig.databaseUrl = savedUrl
    }
  })

  it('runs through the script guard against the configured database', async function () {
    const saved = serverConfig.testSettings
    const savedUrl = serverConfig.databaseUrl
    serverConfig.testSettings = false
    try {
      expect(
        await rejection(
          async () => await runFixture({ world: 'baseline', mailbox: MAILBOX })
        )
      ).includes('testSettings')
      serverConfig.testSettings = true
      serverConfig.databaseUrl = scratchUrl
      const baseline = await runFixture({ world: 'baseline', mailbox: MAILBOX })
      expect(baseline.world).equals('baseline')
      const world = await runFixture({
        world: 'team-with-roster',
        mailbox: MAILBOX
      })
      expect(world.accounts.coach.role).equals('coach')
      // Every world, not only the baseline, refuses another mailbox's database.
      expect(
        await rejection(
          async () =>
            await runFixture({
              world: 'streaming',
              mailbox: 'otherbox@example.test'
            })
        )
      ).includes('fixtures refuse this database')
    } finally {
      serverConfig.testSettings = saved
      serverConfig.databaseUrl = savedUrl
    }
  })
})

/** Every `.ts` under a directory, tests aside. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

describe('settings a node holds outside migrations', function () {
  it('names every key the server reads, or says why it needs no row', function () {
    const keys = new Set<string>()
    for (const file of sources('src/server')) {
      if (file.includes('/dev/fixtures/')) continue
      const text = readFileSync(file, 'utf8')
      if (!text.includes('system_settings')) continue
      for (const match of text.matchAll(
        /\.where\('key', '(?:=|like)', '([^']+)'\)/g
      )) {
        keys.add(match[1].replace(/%$/, ''))
      }
      for (const match of text.matchAll(
        /(?:Key|KEY)\s*=\s*'([a-zA-Z]+\.[a-zA-Z.]+)'/g
      )) {
        keys.add(match[1])
      }
    }
    expect(keys.size).greaterThan(0)
    const known = (key: string): boolean =>
      NODE_SETTINGS[key] != null ||
      Object.keys(UNSET_SETTINGS).some(prefix => key.startsWith(prefix))
    expect([...keys].filter(key => !known(key))).deep.equals([])
    // And every setting a fixture writes is one the server reads.
    expect(
      Object.keys(NODE_SETTINGS).filter(key => !keys.has(key))
    ).deep.equals([])
    expect(keys.has('creation.hierarchyReady')).equals(true)
  })
})
