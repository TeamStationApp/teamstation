import type { AddressInfo } from 'node:net'

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
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { userRoutes } from '../routes/users'
import { ensureGumboId, insertUser } from './insertUser'
import { mintUserId } from './mintUserId'
import { runSpoken } from './readerNames'
import {
  CANDIDATE_LIMIT,
  CANDIDATE_SCAN,
  CANDIDATE_SCAN_BATCH,
  rosterCandidates
} from './rosterCandidates'

/**
 * `GET /users?forTeam=`, through the real router.
 *
 * The coach coaches the Falcons and is a member of the Owls. The Falcons play
 * the Herons in the current Fall season of the Ridgeview league. The Bears are
 * in that season too, the Hawks in the league's other season, the Pirates only
 * in a season that ended yesterday, and the Gulls and Mets in another league.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_candidates_${process.pid}_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const COACH = 'tok_candidates_coach_000000000000000'
const HERON_SCORER = 'tok_candidates_heron_000000000000000'
const VIEWER = 'tok_candidates_viewer_00000000000000'
const OUTSIDER = 'tok_candidates_outsider_000000000000'

/**
 * The database's own day, which `current_date` reads: in the evening the
 * day in UTC is already the next.
 */
let today = Date.now()
const day = (offset: number): string =>
  new Date(today + offset * 86_400_000).toISOString().slice(0, 10)

const team = {
  falcons: 'tem_candFalcons',
  herons: 'tem_candHerons',
  owls: 'tem_candOwls',
  bears: 'tem_candBears',
  hawks: 'tem_candHawks',
  pirates: 'tem_candPirates',
  gulls: 'tem_candGulls',
  mets: 'tem_candMets'
}
const GAME = 'gam_candGame'

describe('roster candidates', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const people: Record<string, string> = {}

  async function person(
    name: string,
    options: { teamId?: string; isPlayer?: boolean } = {}
  ): Promise<string> {
    const [first, ...rest] = name.split(' ')
    const userId = await insertUser(db!, {
      display_name: name,
      first_name: first,
      last_name: rest.join(' '),
      bats: 'right',
      throws: 'left'
    })
    await ensureGumboId(db!, userId)
    if (options.teamId != null)
      await db!
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: options.teamId,
          role: 'member',
          is_player: options.isPlayer ?? true
        })
        .execute()
    people[name] = userId
    return userId
  }

  async function seed(): Promise<void> {
    const d = db!
    await d
      .insertInto('leagues')
      .values([
        { id: 'lea_candRidgeview', name: 'Ridgeview' },
        { id: 'lea_candCoastal', name: 'Coastal' }
      ])
      .execute()
    await d
      .insertInto('seasons')
      .values([
        {
          id: 'sea_candFall',
          league_id: 'lea_candRidgeview',
          name: 'Fall',
          year: 2026,
          starts_on: day(-30),
          ends_on: day(60)
        },
        {
          id: 'sea_candWinter',
          league_id: 'lea_candRidgeview',
          name: 'Winter',
          year: 2026,
          starts_on: day(-30),
          ends_on: day(0)
        },
        {
          id: 'sea_candOld',
          league_id: 'lea_candRidgeview',
          name: 'Old',
          year: 2026,
          starts_on: day(-90),
          ends_on: day(-1)
        },
        {
          id: 'sea_candCoast',
          league_id: 'lea_candCoastal',
          name: 'Coast',
          year: 2026,
          starts_on: day(30),
          ends_on: day(120)
        }
      ])
      .execute()
    await d
      .insertInto('teams')
      .values([
        {
          id: team.falcons,
          name: 'Ridgeview Falcons',
          league_id: 'lea_candRidgeview'
        },
        {
          id: team.herons,
          name: 'Lakeside Herons',
          league_id: 'lea_candRidgeview'
        },
        { id: team.owls, name: 'Ridgeview Owls', league_id: 'lea_candCoastal' },
        {
          id: team.bears,
          name: 'Valley Bears',
          league_id: 'lea_candRidgeview'
        },
        {
          id: team.hawks,
          name: 'Hillcrest Hawks',
          league_id: 'lea_candRidgeview'
        },
        {
          id: team.pirates,
          name: 'Old Pirates',
          league_id: 'lea_candRidgeview'
        },
        { id: team.gulls, name: 'Coastal Gulls', league_id: 'lea_candCoastal' },
        { id: team.mets, name: 'Coastal Mets', league_id: 'lea_candCoastal' }
      ])
      .execute()
    await d
      .insertInto('season_teams')
      .values([
        { season_id: 'sea_candFall', team_id: team.falcons },
        { season_id: 'sea_candFall', team_id: team.herons },
        { season_id: 'sea_candFall', team_id: team.bears },
        { season_id: 'sea_candWinter', team_id: team.hawks },
        { season_id: 'sea_candOld', team_id: team.pirates },
        { season_id: 'sea_candCoast', team_id: team.gulls }
      ])
      .execute()

    const coach = await person('Dave Roberts', {
      teamId: team.falcons,
      isPlayer: false
    })
    await d
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: coach,
        team_id: team.owls,
        role: 'member'
      })
      .execute()
    const heronScorer = await person('Oliver Marmol', {
      teamId: team.herons,
      isPlayer: false
    })
    const viewer = await person('Tony Kemp', {
      teamId: team.falcons,
      isPlayer: false
    })
    const outsider = await person('Bob Melvin')
    await d
      .insertInto('scope_roles')
      .values([
        {
          id: makeId('scopeRole'),
          user_id: coach,
          scope_type: 'team',
          scope_id: team.falcons,
          role: 'coach'
        },
        {
          id: makeId('scopeRole'),
          user_id: heronScorer,
          scope_type: 'team',
          scope_id: team.herons,
          role: 'scorekeeper'
        }
      ])
      .execute()

    for (const name of [
      'Mookie Betts',
      'Cody Bellinger',
      'Cody Bradford',
      'Shohei Ohtani'
    ])
      await person(name, { teamId: team.owls })
    const disabled = await person('Pete Alonso', { teamId: team.owls })
    await d
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', disabled)
      .execute()
    const old = await person('Aaron Judge', { teamId: team.owls })
    const survivor = await person('Aaron Judge')
    await d
      .updateTable('users')
      .set({ merged_into: survivor })
      .where('id', '=', old)
      .execute()
    people['Aaron Judge (old)'] = old
    people['Aaron Judge'] = survivor

    await person('Corbin Burnes', { teamId: team.bears })
    await person('Max Fried', { teamId: team.hawks })
    await person('Paul Skenes', { teamId: team.pirates })
    await person('José Ramírez', { teamId: team.gulls })
    await person('Clayton Kershaw', { teamId: team.falcons })
    await person('Ryan Helsley', { teamId: team.herons })
    await person('Herons A')
    for (let index = 0; index < 65; index++)
      await person(`Page Player${String(index).padStart(2, '0')}`, {
        teamId: team.mets
      })

    const ohtaniGumbo = await ensureGumboId(d, people['Shohei Ohtani'])
    const placeholder = await ensureGumboId(d, people['Herons A'])
    await d
      .insertInto('games')
      .values({
        id: GAME,
        home_team_id: team.falcons,
        away_team_id: team.herons,
        season_id: 'sea_candFall',
        start_at: new Date(),
        status: 'scheduled',
        guests: JSON.stringify({ [team.herons]: [ohtaniGumbo, placeholder] })
      })
      .execute()

    const now = new Date()
    await d
      .insertInto('auth_sessions')
      .values(
        [
          [COACH, coach],
          [HERON_SCORER, heronScorer],
          [VIEWER, viewer],
          [OUTSIDER, outsider]
        ].map(([token, userId]) => ({
          id: makeId('authSession'),
          user_id: userId,
          token_hash: hashToken(token),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        }))
      )
      .execute()
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
    try {
      await migrateUp(pool, migrations)
    } finally {
      await pool.end()
    }
    db = makeDatabase(scratchUrl)
    const date = await sql<{
      today: string
    }>`select current_date::text as today`.execute(db)
    today = Date.parse(`${date.rows[0].today}T00:00:00Z`)
    await seed()
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', userRoutes(db))
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

  async function ask(
    token: string,
    params: Record<string, string>
  ): Promise<{ status: number; body: any }> {
    const query = new URLSearchParams(params).toString()
    const response = await fetch(`${base}/users?${query}`, {
      headers: { authorization: `Bearer ${token}` }
    })
    return { status: response.status, body: await response.json() }
  }
  const names = (body: any[]): string[] => body.map(row => row.shortName)
  const id = (name: string): string => people[name]

  it('ranks the asker’s own teams, the game’s season, then the league, and leaves the team and the game out', async function () {
    const answer = await ask(COACH, { forTeam: team.falcons, forGame: GAME })
    expect(answer.status).equals(200)
    expect(
      answer.body.map((row: any) => [row.shortName, row.tier])
    ).deep.equals([
      ['Aaron J', 'mine'],
      ['Cody B', 'mine'],
      ['Cody B', 'mine'],
      ['Mookie B', 'mine'],
      ['Corbin B', 'season'],
      ['Max F', 'league'],
      ['Paul S', 'league']
    ])
    // Ohtani is a guest of this game, Helsley a Heron, Kershaw a Falcon, Alonso
    // disabled, and the old Judge row answers as its survivor.
    const ids = answer.body.map((row: any) => row.userId)
    expect(ids).includes(id('Aaron Judge'))
    for (const left of [
      'Shohei Ohtani',
      'Ryan Helsley',
      'Clayton Kershaw',
      'Pete Alonso',
      'Aaron Judge (old)',
      'Herons A'
    ])
      expect(ids).not.includes(id(left))
  })

  it('takes the team’s own seasons without a game, and lists a guest of the game again', async function () {
    const answer = await ask(COACH, { forTeam: team.falcons })
    expect(answer.status).equals(200)
    expect(names(answer.body)).includes('Shohei O')
    expect(names(answer.body)).includes('Ryan H')
    expect(
      answer.body.find((row: any) => row.shortName === 'Ryan H').tier
    ).equals('season')
    expect(names(answer.body)).not.includes('Clayton K')
  })

  it('lists people with no tie only once three letters are typed', async function () {
    const two = await ask(COACH, {
      forTeam: team.falcons,
      forGame: GAME,
      q: 'jo'
    })
    expect(names(two.body)).deep.equals([])
    const three = await ask(COACH, {
      forTeam: team.falcons,
      forGame: GAME,
      q: 'jos'
    })
    expect(three.body.map((row: any) => [row.shortName, row.tier])).deep.equals(
      [['José R', 'other']]
    )
    const accented = await ask(COACH, {
      forTeam: team.falcons,
      forGame: GAME,
      q: 'josé'
    })
    const plain = await ask(COACH, {
      forTeam: team.falcons,
      forGame: GAME,
      q: 'JOSE'
    })
    expect(names(accented.body)).deep.equals(['José R'])
    expect(names(plain.body)).deep.equals(['José R'])
  })

  it('lists a full account that plays for no team, as a stranger or as the guardian’s own', async function () {
    const d = db!
    const account = async (
      name: string,
      email: string | null,
      extra: { password_hash?: string; deleted?: boolean; off?: boolean } = {}
    ): Promise<string> => {
      const [first, last] = name.split(' ')
      const userId = await insertUser(d, {
        display_name: name,
        first_name: first,
        last_name: last,
        password_hash: extra.password_hash ?? null,
        login_enabled: extra.off !== true,
        ...(extra.deleted === true
          ? { deleted_at: new Date(), disabled_at: new Date() }
          : {})
      })
      if (email != null)
        await d
          .insertInto('user_emails')
          .values({ id: makeId('userEmail'), user_id: userId, email })
          .execute()
      return userId
    }
    const devers = await account('Rafael Devers', 'devers@example.test')
    const montero = await account('Rafael Montero', null, {
      password_hash: 'not-a-real-hash'
    })
    const palmeiro = await account('Rafael Palmeiro', 'palmeiro@example.test', {
      deleted: true
    })
    const furcal = await account('Rafael Furcal', 'furcal@example.test', {
      off: true
    })
    const harper = await account('Bryce Harper', 'harper@example.test')
    const coach = await d
      .selectFrom('users')
      .select('id')
      .where('display_name', '=', 'Dave Roberts')
      .executeTakeFirstOrThrow()
    const link = makeId('userLink')
    try {
      // Two letters name nobody with no tie; three find the full account,
      // and neither a password-only, a switched-off nor a deleted one.
      const two = await ask(COACH, { forTeam: team.falcons, q: 'ra' })
      expect(names(two.body)).not.includes('Rafael D')
      const three = await ask(COACH, { forTeam: team.falcons, q: 'raf' })
      expect(three.status).equals(200)
      expect(
        three.body.map((row: any) => [row.shortName, row.tier, row.teams])
      ).deep.equals([['Rafael D', 'other', []]])
      const ids = three.body.map((row: any) => row.userId)
      expect(ids).not.includes(montero)
      expect(ids).not.includes(palmeiro)
      expect(ids).not.includes(furcal)
      // Not with nothing typed, until the coach is Harper's guardian.
      const before = await ask(COACH, { forTeam: team.falcons })
      expect(before.body.map((row: any) => row.userId)).not.includes(harper)
      await d
        .insertInto('user_links')
        .values({
          id: link,
          user_id: coach.id,
          related_user_id: harper,
          kind: 'guardian'
        })
        .execute()
      const guarded = await ask(COACH, { forTeam: team.falcons })
      expect(
        guarded.body.find((row: any) => row.userId === harper)?.tier
      ).equals('mine')
      expect(guarded.body.map((row: any) => row.userId)).not.includes(devers)
    } finally {
      await d.deleteFrom('user_links').where('id', '=', link).execute()
      await d
        .deleteFrom('user_emails')
        .where('user_id', 'in', [devers, palmeiro, furcal, harper])
        .execute()
      await d
        .deleteFrom('users')
        .where('id', 'in', [devers, montero, palmeiro, furcal, harper])
        .execute()
    }
  })

  it('leaves out somebody whose guest entry sits under an account merged since', async function () {
    const search = async (): Promise<string[]> =>
      names(
        (
          await ask(COACH, {
            forTeam: team.falcons,
            forGame: GAME,
            q: 'aaron j'
          })
        ).body
      )
    expect(await search()).includes('Aaron J')
    const gumbo = await ensureGumboId(db!, id('Aaron Judge (old)'))
    const { guests } = await db!
      .selectFrom('games')
      .select('guests')
      .where('id', '=', GAME)
      .executeTakeFirstOrThrow()
    await db!
      .updateTable('games')
      .set({ guests: JSON.stringify({ [team.falcons]: [gumbo] }) })
      .where('id', '=', GAME)
      .execute()
    try {
      expect(await search()).not.includes('Aaron J')
    } finally {
      await db!
        .updateTable('games')
        .set({ guests: JSON.stringify(guests) })
        .where('id', '=', GAME)
        .execute()
    }
  })

  it('leaves out a player already in the game for an opponent from another league', async function () {
    // Ohtani, an Owl, also plays for the Gulls, of another league; the
    // Falcons play the Gulls.
    const membership = makeId('membership')
    await db!
      .insertInto('memberships')
      .values({
        id: membership,
        user_id: id('Shohei Ohtani'),
        team_id: team.gulls,
        role: 'member',
        is_player: true
      })
      .execute()
    await db!
      .insertInto('games')
      .values({
        id: 'gam_candGulls',
        home_team_id: team.falcons,
        away_team_id: team.gulls,
        start_at: new Date(),
        status: 'scheduled'
      })
      .execute()
    try {
      const page = await ask(COACH, {
        forTeam: team.falcons,
        forGame: 'gam_candGulls'
      })
      expect(page.status).equals(200)
      expect(names(page.body)).not.includes('Shohei O')
      expect(names(page.body)).includes('Mookie B')
    } finally {
      await db!.deleteFrom('games').where('id', '=', 'gam_candGulls').execute()
      await db!.deleteFrom('memberships').where('id', '=', membership).execute()
    }
  })

  it('takes wildcards as the characters they are, and counts only letters and digits toward a stranger', async function () {
    for (const q of ['%%%', '___', '%', '\\%', 'r_m'])
      expect(
        names(
          (await ask(COACH, { forTeam: team.falcons, forGame: GAME, q })).body
        ),
        q
      ).deep.equals([])
    // Punctuation does not make up the three letters a stranger needs.
    expect(
      names(
        (await ask(COACH, { forTeam: team.falcons, forGame: GAME, q: 'ra-' }))
          .body
      )
    ).deep.equals([])
  })

  it('counts no word that starts another toward a stranger', async function () {
    for (const q of ['j j j', 'a a a', 'ab a'])
      expect(
        names((await ask(COACH, { forTeam: team.falcons, q })).body).filter(
          name => name.startsWith('Jos')
        ),
        q
      ).deep.equals([])
  })

  it('matches the start of every word typed', async function () {
    const both = await ask(COACH, { forTeam: team.falcons, q: 'mo  b' })
    expect(names(both.body)).deep.equals(['Mookie B'])
    const cody = await ask(COACH, { forTeam: team.falcons, q: 'cody' })
    expect(cody.body.map((row: any) => row.shortParts)).deep.equals([
      { first: 'Cody', last: 'B' },
      { first: 'Cody', last: 'B' }
    ])
  })

  it('finds nobody the asker reads short by a surname the row hides', async function () {
    // The coach reads Mookie (his own Owls) and José (a stranger) short.
    for (const q of ['bet', 'betts', 'ramírez', 'ram'])
      expect(
        names(
          (await ask(COACH, { forTeam: team.falcons, forGame: GAME, q })).body
        ),
        q
      ).deep.equals([])
    // Both halves typed whole find them, and show no more than the label.
    const mookie = await ask(COACH, {
      forTeam: team.falcons,
      q: 'mookie betts'
    })
    expect(names(mookie.body)).deep.equals(['Mookie B'])
    expect(JSON.stringify(mookie.body)).not.includes('Betts')
    const jose = await ask(COACH, {
      forTeam: team.falcons,
      forGame: GAME,
      q: 'jose ramirez'
    })
    expect(names(jose.body)).deep.equals(['José R'])
    // A half typed whole beside the other's start is still the surname alone.
    expect(
      names((await ask(COACH, { forTeam: team.falcons, q: 'mo betts' })).body)
    ).deep.equals([])
  })

  it('reads on past rows a hidden surname found, to fill the answer', async function () {
    // Both play on the Bears, in the Falcons' season, read short by the
    // coach: the first, by first name, is found by his surname alone.
    const hidden = await person('Adam Wainwright', { teamId: team.bears })
    const shown = await person('Walker Buehler', { teamId: team.bears })
    try {
      const answer = await ask(COACH, {
        forTeam: team.falcons,
        q: 'wa',
        capped: '1',
        limit: '1'
      })
      expect(answer.body.map((row: any) => row.userId)).deep.equals([shown])
    } finally {
      await db!
        .deleteFrom('memberships')
        .where('user_id', 'in', [hidden, shown])
        .execute()
    }
  })

  /** Strangers on the Gulls, put in at once: a user and a membership each. */
  async function strangers(names: string[]): Promise<string[]> {
    const rows = names.map(name => {
      const [first, ...rest] = name.split(' ')
      return {
        id: mintUserId(),
        display_name: name,
        first_name: first,
        last_name: rest.join(' ')
      }
    })
    await db!.insertInto('users').values(rows).execute()
    await db!
      .insertInto('memberships')
      .values(
        rows.map(row => ({
          id: makeId('membership'),
          user_id: row.id,
          team_id: team.gulls,
          role: 'member' as const,
          is_player: true
        }))
      )
      .execute()
    return rows.map(row => row.id)
  }

  it('finds a stranger named John past hidden Johnsons in one answer, and stops at the scan bound', async function () {
    // Strangers on the Gulls, read short by the coach: every Davey… Johnson
    // sorts ahead of John Smoltz and is found by his hidden surname alone.
    const hidden = await strangers(
      Array.from(
        { length: 95 },
        (_, index) => `Davey${String(index).padStart(4, '0')} Johnson`
      )
    )
    const john = await person('John Smoltz', { teamId: team.gulls })
    let reads = 0
    const counted = db!.withPlugin({
      transformQuery: args => {
        const node = args.node as { kind: string; sqlFragments?: string[] }
        if (
          node.kind === 'RawNode' &&
          node.sqlFragments?.join('').includes('cursor_user') === true
        )
          reads++
        return args.node
      },
      transformResult: async args => await Promise.resolve(args.result)
    })
    const actor = { userId: id('Dave Roberts'), isAdmin: false, scopes: [] }
    try {
      const answer = await ask(COACH, { forTeam: team.falcons, q: 'john' })
      expect(answer.status).equals(200)
      expect(answer.body.map((row: any) => row.userId)).deep.equals([john])
      expect(JSON.stringify(answer.body)).not.includes('Johnson')
      // A thousand more ahead of him: the search reads its bound of matches
      // and answers what it kept by then.
      hidden.push(
        ...(await strangers(
          Array.from(
            { length: CANDIDATE_SCAN },
            (_, index) => `Davey${String(index + 95).padStart(4, '0')} Johnson`
          )
        ))
      )
      const bounded = await rosterCandidates(counted, actor, {
        teamId: team.falcons,
        q: 'john',
        limit: CANDIDATE_LIMIT.max
      })
      expect(bounded).deep.equals([])
      expect(reads).equals(CANDIDATE_SCAN / CANDIDATE_SCAN_BATCH)
    } finally {
      await db!
        .deleteFrom('memberships')
        .where('user_id', 'in', [...hidden, john])
        .execute()
    }
  })

  it('sends no team the reader may not see, in teams or on the line', async function () {
    // José Ramírez, a stranger to the coach, plays for the Gulls, which are
    // not the coach's to see.
    const answer = await ask(COACH, {
      forTeam: team.falcons,
      forGame: GAME,
      q: 'jos'
    })
    expect(answer.body.map((row: any) => row.userId)).deep.equals([
      id('José Ramírez')
    ])
    const [row] = answer.body
    expect(row.tier).equals('other')
    expect(row.teams).deep.equals([])
    expect(row.affiliations).equals('')
    expect(JSON.stringify(answer.body)).not.includes('Coastal Gulls')
  })

  it('sends nothing about a person but the card, with teams in a current or future season', async function () {
    // A member of each team below, the coach sees them all.
    const seen = [team.gulls, team.bears, team.hawks, team.pirates].map(
      teamId => ({
        id: makeId('membership'),
        user_id: id('Dave Roberts'),
        team_id: teamId,
        role: 'member' as const,
        is_player: false
      })
    )
    await db!.insertInto('memberships').values(seen).execute()
    try {
      await cardTeams()
    } finally {
      await db!
        .deleteFrom('memberships')
        .where(
          'id',
          'in',
          seen.map(each => each.id)
        )
        .execute()
    }
  })

  async function cardTeams(): Promise<void> {
    const answer = await ask(COACH, {
      forTeam: team.falcons,
      forGame: GAME,
      q: 'jos'
    })
    const [row] = answer.body
    expect(Object.keys(row).sort()).deep.equals(
      [
        'affiliations',
        'avatarUrl',
        'bats',
        'cursor',
        'externalIds',
        'gumboId',
        'shortName',
        'shortParts',
        'teams',
        'throws',
        'tier',
        'userId'
      ].sort()
    )
    expect(row).to.include({
      bats: 'right',
      throws: 'left',
      avatarUrl: null,
      cursor: ''
    })
    // A season starting next month counts.
    expect(row.teams).deep.equals([
      { teamId: team.gulls, name: 'Coastal Gulls' }
    ])
    const all = await ask(COACH, { forTeam: team.falcons, forGame: GAME })
    const teamsOf = (short: string): unknown =>
      all.body.find((each: any) => each.shortName === short).teams
    expect(teamsOf('Corbin B')).deep.equals([
      { teamId: team.bears, name: 'Valley Bears' }
    ])
    // The Hawks' season ends today; the Pirates' ended yesterday; the Owls are in none.
    expect(teamsOf('Max F')).deep.equals([
      { teamId: team.hawks, name: 'Hillcrest Hawks' }
    ])
    expect(teamsOf('Paul S')).deep.equals([])
    expect(teamsOf('Mookie B')).deep.equals([])
  }

  it('lines up each candidate’s guardians and teams as the asker may see them', async function () {
    const link = makeId('userLink')
    await db!
      .insertInto('user_links')
      .values({
        id: link,
        user_id: id('Bob Melvin'),
        related_user_id: id('Mookie Betts'),
        kind: 'guardian'
      })
      .execute()
    try {
      const mookie = await ask(COACH, { forTeam: team.falcons, q: 'mook' })
      // The coach is a member of the Owls: he sees Mookie and his guardian.
      // The Owls are in no season, so the line does not name them.
      expect(mookie.body.map((row: any) => row.affiliations)).deep.equals([
        'Guardians: Bob M'
      ])
      // The Gulls are not the coach's to see.
      const ramirez = await ask(COACH, {
        forTeam: team.falcons,
        forGame: GAME,
        q: 'jos'
      })
      expect(ramirez.body.map((row: any) => row.affiliations)).deep.equals([''])
    } finally {
      await db!.deleteFrom('user_links').where('id', '=', link).execute()
    }
  })

  it('names on the line only the teams of a season ending today or later', async function () {
    // The coach and Mookie are both on the Hawks, whose season ends today,
    // and on the Pirates, whose season ended yesterday.
    const places = [
      [id('Dave Roberts'), team.hawks, false],
      [id('Dave Roberts'), team.pirates, false],
      [id('Mookie Betts'), team.hawks, true],
      [id('Mookie Betts'), team.pirates, true]
    ] as const
    const ids = places.map(() => makeId('membership'))
    await db!
      .insertInto('memberships')
      .values(
        places.map(([userId, teamId, isPlayer], index) => ({
          id: ids[index],
          user_id: userId,
          team_id: teamId,
          role: 'member',
          is_player: isPlayer
        }))
      )
      .execute()
    try {
      const [mookie] = (await ask(COACH, { forTeam: team.falcons, q: 'mook' }))
        .body
      expect(mookie.affiliations).equals('Hillcrest Hawks')
      expect(mookie.teams).deep.equals([
        { teamId: team.hawks, name: 'Hillcrest Hawks' }
      ])
    } finally {
      await db!.deleteFrom('memberships').where('id', 'in', ids).execute()
    }
  })

  it('sends the public label beside a name full only for the asker', async function () {
    // Coaching the Owls too, the coach reads their players in full.
    const role = makeId('scopeRole')
    await db!
      .insertInto('scope_roles')
      .values({
        id: role,
        user_id: id('Dave Roberts'),
        scope_type: 'team',
        scope_id: team.owls,
        role: 'coach'
      })
      .execute()
    try {
      const answer = await ask(COACH, { forTeam: team.falcons, q: 'mook' })
      expect(answer.body).has.length(1)
      expect(answer.body[0]).to.include({
        shortName: 'Mookie Betts',
        nameFormat: 'full',
        compactName: 'Mookie B'
      })
      expect(answer.body[0]).not.have.property('compactFormat')
      // The parts the add-to-roster form stores, and the lineup QR sends,
      // are the public label's.
      expect(answer.body[0].shortParts).deep.equals({
        first: 'Mookie',
        last: 'B'
      })
      // Nobody else is told more than the public label.
      const other = await ask(HERON_SCORER, { forTeam: team.herons, q: 'mook' })
      expect(other.body[0]).to.include({ shortName: 'Mookie B' })
      expect(other.body[0]).not.have.property('compactName')
      expect(other.body[0]).not.have.property('nameFormat')
    } finally {
      await db!.deleteFrom('scope_roles').where('id', '=', role).execute()
    }
  })

  it('writes a spoken answer’s short name and parts with no surname for a player stored with none but it', async function () {
    const smith = await insertUser(db!, {
      display_name: 'Smith',
      first_name: null,
      last_name: 'Smith'
    })
    await ensureGumboId(db!, smith)
    await db!
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: smith,
        team_id: team.bears,
        role: 'member',
        is_player: true
      })
      .execute()
    try {
      const actor = {
        userId: id('Oliver Marmol'),
        isAdmin: false,
        scopes: []
      }
      // In the Herons' season, found by the label each read shows: `S`
      // spoken, `Smith` to a person, so one letter is enough.
      const ask = { teamId: team.herons, q: 's', limit: 50 }
      const spoken = await runSpoken(
        async () => await rosterCandidates(db!, actor, ask)
      )
      const row = spoken.find(each => each.userId === smith)!
      expect(row.shortName).equals('S')
      expect(row.shortParts).deep.equals({ first: '', last: 'S' })
      expect(JSON.stringify(row)).not.includes('Smith')
      // Read by a person, the surname is the short name it always was.
      const read = (await rosterCandidates(db!, actor, ask)).find(
        each => each.userId === smith
      )!
      expect(read.shortParts).deep.equals({ first: '', last: 'Smith' })
    } finally {
      await db!.deleteFrom('memberships').where('user_id', '=', smith).execute()
    }
  })

  it('answers at most a hundred, fewer when a capped request’s limit asks, and nothing to a request with after', async function () {
    // Sixty-five Page Players on the Mets, and forty more.
    // An installed build asks for thirty, draws no capped notice, and pages
    // on with after, which answers nothing: it is answered every match.
    const uncapped = await ask(COACH, {
      forTeam: team.falcons,
      q: 'page',
      limit: '30'
    })
    expect(uncapped.status).equals(200)
    expect(uncapped.body).length(65)
    const more = []
    for (let index = 65; index < 105; index++)
      more.push(
        await person(`Page Player${String(index).padStart(3, '0')}`, {
          teamId: team.mets
        })
      )
    try {
      const all = await ask(COACH, { forTeam: team.falcons, q: 'page' })
      expect(all.status).equals(200)
      expect(all.body).length(CANDIDATE_LIMIT.max)
      expect(new Set(all.body.map((row: any) => row.userId)).size).equals(100)
      expect(all.body.every((row: any) => row.cursor === '')).equals(true)
      const thirty = await ask(COACH, {
        forTeam: team.falcons,
        q: 'page',
        capped: '1',
        limit: '30'
      })
      expect(thirty.body.map((row: any) => row.userId)).deep.equals(
        all.body.slice(0, 30).map((row: any) => row.userId)
      )
      // An unmarked limit below the cap is answered whole.
      const installed = await ask(COACH, {
        forTeam: team.falcons,
        q: 'page',
        limit: '30'
      })
      expect(installed.body).length(CANDIDATE_LIMIT.max)
      // An installed build scrolling on from its last row stops there.
      for (const after of ['', 'eyJ0aWVyIjozfQ', all.body[29].userId]) {
        const scrolled = await ask(COACH, {
          forTeam: team.falcons,
          q: 'page',
          limit: '30',
          after
        })
        expect(scrolled.status).equals(200)
        expect(scrolled.body).deep.equals([])
      }
    } finally {
      await db!.deleteFrom('memberships').where('user_id', 'in', more).execute()
    }
  })

  it('refuses a malformed question and anybody who may not add to the team', async function () {
    const refused = async (
      token: string,
      params: Record<string, string>,
      status: number,
      words: string
    ): Promise<void> => {
      const answer = await ask(token, params)
      expect(answer.status, JSON.stringify(params)).equals(status)
      expect(JSON.stringify(answer.body)).includes(words)
    }
    await refused(
      COACH,
      { forTeam: team.falcons, externalId: 'x' },
      400,
      'forTeam alone'
    )
    await refused(
      COACH,
      { forTeam: team.owls, forGame: GAME },
      400,
      'forTeam must play in forGame'
    )
    await refused(COACH, { forTeam: team.falcons, limit: '0' }, 400, 'limit')
    await refused(COACH, { forTeam: team.falcons, limit: '101' }, 400, 'limit')
    await refused(
      COACH,
      { forTeam: team.falcons, capped: 'yes' },
      400,
      'capped must be 1'
    )
    await refused(
      COACH,
      { forTeam: team.falcons, q: 'x'.repeat(101) },
      400,
      'q is at most'
    )
    await refused(COACH, { forTeam: team.falcons, forGame: '' }, 400, 'forGame')
    await refused(COACH, { forTeam: '' }, 400, 'forTeam')
    // Anybody signed in reads a team in the non-member view, so a team that
    // exists is refused rather than not found.
    await refused(OUTSIDER, { forTeam: team.falcons }, 403, 'roster manager')
    await refused(VIEWER, { forTeam: team.falcons }, 403, 'roster manager')
    await refused(COACH, { forTeam: 'tem_nobody' }, 404, '')
    await refused(
      COACH,
      { forTeam: team.falcons, forGame: 'gam_nobody' },
      404,
      ''
    )
    // The Herons' scorekeeper may add to the Falcons' side of this game, and
    // not to the Falcons away from it.
    const scorer = await ask(HERON_SCORER, {
      forTeam: team.falcons,
      forGame: GAME
    })
    expect(scorer.status).equals(200)
    await refused(
      HERON_SCORER,
      { forTeam: team.falcons },
      403,
      'roster manager'
    )
    // A Falcon with no role sees the game, so the Herons' side of it is
    // refused rather than not found.
    await refused(
      VIEWER,
      { forTeam: team.herons, forGame: GAME },
      403,
      'roster manager'
    )
  })
})
