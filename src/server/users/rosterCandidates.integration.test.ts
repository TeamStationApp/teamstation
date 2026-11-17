import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { SEARCH_RESULTS_MAX } from '../../common/search/types'
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
import { searchJev, searchOnce } from '../search/engine'
import { gather, PEOPLE_ONLY_MAX, PER_KIND } from '../search/gather'
import { ensureGumboId, insertUser } from './insertUser'
import { mintUserId } from './mintUserId'
import { runSpoken } from './readerNames'
import {
  CANDIDATE_LIMIT,
  rosterCandidates,
  shownMatches
} from './rosterCandidates'

/**
 * `GET /users?forTeam=`, through the real router.
 *
 * The coach coaches the Falcons and is a member of the Owls, which are in no
 * league. The Falcons play the Herons in the current Fall season of the
 * Ridgeview league. The Bears are in that season too, the Hawks in the
 * league's other season, the Pirates only in a season that ended yesterday,
 * and the Gulls and Mets in another league, outside the coach's reach: their
 * players are outsiders to him, whom no search finds.
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
/** Media settings for the engine's search, which reads no image. */
const SPACE = {
  endpoint: 'https://media.example.test',
  region: 'test',
  bucket: 'synthetic-images',
  accessKeyId: '00000000000000000000',
  secretAccessKey: '0000000000000000000000000000000000000000',
  pathStyle: true
}

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
        { id: team.owls, name: 'Ridgeview Owls' },
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
    // The players in the coach's reach, each tier by name. The coach
    // himself and the Falcons' viewer, who hold places on his teams, and the
    // Herons' scorekeeper, on a team of the game's season, play nowhere and
    // are not offered.
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
      'Herons A',
      // Members of teams in the reach who play on none of them.
      'Dave Roberts',
      'Oliver Marmol',
      'Tony Kemp',
      // On the Gulls and the Mets, of a league outside the coach's reach.
      'José Ramírez',
      'Page Player00'
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

  it('finds people in the reach from two letters, and nobody outside it however much is typed', async function () {
    // Max Fried plays in the Falcons' league: two letters find him.
    const two = await ask(COACH, {
      forTeam: team.falcons,
      forGame: GAME,
      q: 'ma'
    })
    expect(two.body.map((row: any) => [row.shortName, row.tier])).deep.equals([
      ['Max F', 'league']
    ])
    // José Ramírez plays only for the Gulls, of another league: once three
    // letters were typed he was found as a stranger, and now never is.
    for (const q of [
      'jo',
      'jos',
      'josé',
      'JOSE',
      'jose ramirez',
      'José Ramírez',
      'j j j',
      'ab a'
    ])
      expect(
        names(
          (await ask(COACH, { forTeam: team.falcons, forGame: GAME, q })).body
        ).filter(name => name.startsWith('Jos')),
        q
      ).deep.equals([])
  })

  it('lists a full account that plays for no team only as the guardian’s own', async function () {
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
      // A full account with no tie was found once three letters were typed;
      // now it is outside the reach, as a password-only, a switched-off and
      // a deleted one are.
      for (const q of ['ra', 'raf', 'rafael', 'rafael devers']) {
        const answer = await ask(COACH, { forTeam: team.falcons, q })
        expect(answer.status).equals(200)
        const ids = answer.body.map((row: any) => row.userId)
        for (const nobody of [devers, montero, palmeiro, furcal])
          expect(ids, q).not.includes(nobody)
      }
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
      // And by what is typed.
      const typed = await ask(COACH, { forTeam: team.falcons, q: 'bry' })
      expect(
        typed.body.map((row: any) => [row.userId, row.tier, row.teams])
      ).deep.equals([[harper, 'mine', []]])
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

  it('takes wildcards as the characters they are, and text with no letters or digits as finding nobody', async function () {
    for (const q of ['%%%', '___', '%', '\\%', '-'])
      expect(
        names(
          (await ask(COACH, { forTeam: team.falcons, forGame: GAME, q })).body
        ),
        q
      ).deep.equals([])
  })

  it('ranks first whoever matches the most words typed', async function () {
    // The engine's lexicographic order: Mookie B matches both words, the
    // rest one each.
    const both = await ask(COACH, { forTeam: team.falcons, q: 'mo  b' })
    expect(names(both.body)[0]).equals('Mookie B')
    expect(names(both.body)).includes('Corbin B')
    const cody = await ask(COACH, { forTeam: team.falcons, q: 'cody' })
    expect(cody.body.map((row: any) => row.shortParts)).deep.equals([
      { first: 'Cody', last: 'B' },
      { first: 'Cody', last: 'B' }
    ])
  })

  it('finds nobody the asker reads short by a surname the row hides', async function () {
    // The coach reads Mookie (his own Owls) and Corbin (in the season) short.
    for (const q of ['bet', 'betts', 'burnes', 'bur'])
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
    const corbin = await ask(COACH, {
      forTeam: team.falcons,
      forGame: GAME,
      q: 'corbin burnes'
    })
    expect(names(corbin.body)).deep.equals(['Corbin B'])
    // A half typed whole beside the other's start finds whom the start alone
    // finds: the surname confirms nothing.
    const mo = await ask(COACH, { forTeam: team.falcons, q: 'mo' })
    const moBetts = await ask(COACH, { forTeam: team.falcons, q: 'mo betts' })
    expect(names(moBetts.body)).deep.equals(names(mo.body))
    expect(JSON.stringify(moBetts.body)).not.includes('Betts')
  })

  it('finds a hidden hyphenated surname typed whole with the first name', async function () {
    // The coach reads him short, on the Bears in the Falcons' season.
    const ikf = await person('Isiah Kiner-Falefa', { teamId: team.bears })
    try {
      for (const q of ['isiah kiner-falefa', 'Isiah Kiner Falefa']) {
        const found = await ask(COACH, { forTeam: team.falcons, q })
        expect(names(found.body), q).deep.equals(['Isiah K'])
        expect(JSON.stringify(found.body)).not.includes('Falefa')
      }
      // Half the surname confirms nothing.
      const half = await ask(COACH, {
        forTeam: team.falcons,
        q: 'isiah falefa'
      })
      expect(names(half.body)).deep.equals(
        names((await ask(COACH, { forTeam: team.falcons, q: 'isiah' })).body)
      )
      // Typed whole, every word found him, the surname's halves too: the
      // words the phone keeps to find him again.
      const engine = await searchOnce(
        db!,
        { userId: id('Dave Roberts'), isAdmin: false, scopes: [] },
        {
          text: 'isiah kiner-falefa',
          location: null,
          mode: 'people',
          forTeam: team.falcons
        },
        { space: SPACE, jevBaseUrl: 'http://jev.example.test' }
      )
      expect(
        engine.results.map(result =>
          result.kind === 'person' ? result.roster?.matched : undefined
        )
      ).deep.equals([['isiah', 'kiner', 'falefa']])
      // The route says the same, and only the words that found each row: a
      // search keeps anybody any one typed word found.
      const whole = await ask(COACH, {
        forTeam: team.falcons,
        q: 'isiah kiner-falefa'
      })
      expect(
        (whole.body as Array<{ userId: string; matched?: string[] }>).map(
          row => [row.userId, row.matched]
        )
      ).deep.equals([[ikf, ['isiah', 'kiner', 'falefa']]])
      const halfRows = half.body as Array<{
        userId: string
        matched?: string[]
      }>
      expect(halfRows.find(row => row.userId === ikf)?.matched).deep.equals([
        'isiah'
      ])
      const stored = { first_name: 'Isiah', last_name: 'Kiner-Falefa' }
      expect(shownMatches(['kiner', 'falefa', 'isiah'], 'I K', stored)).equals(
        true
      )
      expect(shownMatches(['kiner', 'isiah'], 'I K', stored)).equals(false)
    } finally {
      await db!.deleteFrom('memberships').where('user_id', '=', ikf).execute()
    }
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

  /** Players on the Bears, put in at once: a user and a membership each. */
  async function bears(names: string[]): Promise<string[]> {
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
          team_id: team.bears,
          role: 'member' as const,
          is_player: true
        }))
      )
      .execute()
    return rows.map(row => row.id)
  }

  it('finds John past a thousand hidden Johnsons in one answer', async function () {
    // Bears, in the Falcons' season, read short by the coach: every Davey…
    // Johnson holds "john" in his hidden surname, and none is found by it.
    const hidden = await bears(
      Array.from(
        { length: 1095 },
        (_, index) => `Davey${String(index).padStart(4, '0')} Johnson`
      )
    )
    const john = await person('John Smoltz', { teamId: team.bears })
    try {
      const answer = await ask(COACH, { forTeam: team.falcons, q: 'john' })
      expect(answer.status).equals(200)
      expect(answer.body.map((row: any) => row.userId)).deep.equals([john])
      expect(JSON.stringify(answer.body)).not.includes('Johnson')
    } finally {
      await db!
        .deleteFrom('memberships')
        .where('user_id', 'in', [...hidden, john])
        .execute()
    }
  })

  it('reads on, a page at a time, past three hundred rows a hidden surname found first', async function () {
    // Bears, read short by the coach, whose shorter names the prefilter
    // ranks first: each A… Johnson holds "john" only in his hidden surname.
    const hidden = await bears(
      Array.from(
        { length: 300 },
        (_, index) => `A${String(index).padStart(3, '0')} Johnson`
      )
    )
    // John plays for the coach's own Owls, whose name his line shows.
    const john = await person('John Mayberry', { teamId: team.owls })
    try {
      const answer = await ask(COACH, { forTeam: team.falcons, q: 'john' })
      expect(answer.status).equals(200)
      expect(answer.body.map((row: any) => row.userId)).deep.equals([john])
      // The search socket's people, in mode all, read on the same way.
      const socket = await searchOnce(
        db!,
        { userId: id('Dave Roberts'), isAdmin: false, scopes: [] },
        { text: 'john', location: null, mode: 'all' },
        { space: SPACE, jevBaseUrl: 'http://jev.example.test' }
      )
      expect(
        socket.results.flatMap(row =>
          row.kind === 'person' ? [row.userId] : []
        )
      ).deep.equals([john])
      // His line is read though he came after the rows it was started for.
      const line = socket.results.find(row => row.kind === 'person')
      expect(line?.associations).includes('Owls')
      // Affiliations start for the first twenty rows alone, not every row
      // read: the twenty the search would answer were none hidden.
      const handed: string[][] = []
      await gather(
        db!,
        { userId: id('Dave Roberts'), isAdmin: false, scopes: [] },
        { text: 'john', location: null, mode: 'all' },
        { onPeople: ({ ids }) => handed.push(ids) }
      )
      expect(handed.map(ids => ids.length)).deep.equals([PER_KIND])
      expect(handed[0]).not.includes(john)
    } finally {
      await db!
        .deleteFrom('memberships')
        .where('user_id', 'in', [...hidden, john])
        .execute()
    }
  })

  it('sends no team the reader may not see, in teams or on the line', async function () {
    // Max Fried, in the Falcons' league, plays for the Hawks, which are not
    // the coach's to see.
    const answer = await ask(COACH, {
      forTeam: team.falcons,
      forGame: GAME,
      q: 'max'
    })
    expect(answer.body.map((row: any) => row.userId)).deep.equals([
      id('Max Fried')
    ])
    const [row] = answer.body
    expect(row.tier).equals('league')
    expect(row.teams).deep.equals([])
    expect(row.affiliations).equals('')
    expect(JSON.stringify(answer.body)).not.includes('Hillcrest Hawks')
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
        'matched',
        'shortName',
        'shortParts',
        'teams',
        'throws',
        'tier',
        'userId'
      ].sort()
    )
    // The typed word that found the person, folded: nothing else of theirs.
    expect(row.matched).deep.equals(['jos'])
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
      // The Hawks are not the coach's to see.
      const fried = await ask(COACH, {
        forTeam: team.falcons,
        forGame: GAME,
        q: 'max'
      })
      expect(fried.body.map((row: any) => row.affiliations)).deep.equals([''])
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
    const hawk = makeId('membership')
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
      // Nobody else is told more than the public label: on the Hawks too,
      // Mookie is in the Herons' league, inside their scorekeeper's reach.
      await db!
        .insertInto('memberships')
        .values({
          id: hawk,
          user_id: id('Mookie Betts'),
          team_id: team.hawks,
          role: 'member',
          is_player: true
        })
        .execute()
      const other = await ask(HERON_SCORER, { forTeam: team.herons, q: 'mook' })
      expect(other.body[0]).to.include({ shortName: 'Mookie B' })
      expect(other.body[0]).not.have.property('compactName')
      expect(other.body[0]).not.have.property('nameFormat')
    } finally {
      await db!.deleteFrom('scope_roles').where('id', '=', role).execute()
      await db!.deleteFrom('memberships').where('id', '=', hawk).execute()
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

  it('answers up to the hundred an installed build asks for, fewer when a capped request’s limit asks, and nothing to a request with after; the socket shows fifty', async function () {
    let extra: string[] = ['usr_none']
    // Sixty-five Page Players on the Mets, brought into the coach's reach.
    await db!
      .updateTable('teams')
      .set({ league_id: 'lea_candRidgeview' })
      .where('id', '=', team.mets)
      .execute()
    try {
      // An installed build asks for thirty, draws no capped notice, and pages
      // on with after, which answers nothing: it is answered the whole list.
      const uncapped = await ask(COACH, {
        forTeam: team.falcons,
        q: 'page',
        limit: '30'
      })
      expect(uncapped.status).equals(200)
      expect(uncapped.body).length(65)
      expect(new Set(uncapped.body.map((row: any) => row.userId)).size).equals(
        65
      )
      expect(uncapped.body.every((row: any) => row.cursor === '')).equals(true)
      // The search socket gathers all sixty-five and shows the first fifty.
      const socket = await searchOnce(
        db!,
        { userId: id('Dave Roberts'), isAdmin: false, scopes: [] },
        { text: 'page', location: null, mode: 'people', forTeam: team.falcons },
        {
          space: {
            endpoint: 'https://media.example.test',
            region: 'test',
            bucket: 'synthetic-images',
            accessKeyId: '00000000000000000000',
            secretAccessKey: '0000000000000000000000000000000000000000',
            pathStyle: true
          },
          jevBaseUrl: 'http://jev.example.test'
        }
      )
      expect(socket.context.ordered).length(65)
      expect(
        socket.results.map(row => (row.kind === 'person' ? row.userId : ''))
      ).deep.equals(
        uncapped.body.slice(0, SEARCH_RESULTS_MAX).map((row: any) => row.userId)
      )
      const ten = await ask(COACH, {
        forTeam: team.falcons,
        q: 'page',
        capped: '1',
        limit: '10'
      })
      expect(ten.body.map((row: any) => row.userId)).deep.equals(
        uncapped.body.slice(0, 10).map((row: any) => row.userId)
      )
      // An installed build scrolling on from its last row stops there.
      for (const after of ['', 'eyJ0aWVyIjozfQ', uncapped.body[9].userId]) {
        const scrolled = await ask(COACH, {
          forTeam: team.falcons,
          q: 'page',
          limit: '30',
          after
        })
        expect(scrolled.status).equals(200)
        expect(scrolled.body).deep.equals([])
      }
      // Even scrolling on, a team the asker may not add to is refused.
      const refused = await ask(VIEWER, { forTeam: team.falcons, after: '' })
      expect(refused.status).equals(403)
      // Forty more Page players on the Bears: an installed build asking for
      // a hundred, capped, gets a hundred, and tells the user more may match.
      extra = await bears(
        Array.from(
          { length: 40 },
          (_, index) => `Page Extra${String(index).padStart(2, '0')}`
        )
      )
      const asks: Array<Record<string, string>> = [
        { capped: '1', limit: '100' },
        { capped: '1' },
        { limit: '30' }
      ]
      for (const more of asks) {
        const full = await ask(COACH, {
          forTeam: team.falcons,
          q: 'page',
          ...more
        })
        expect(full.body, JSON.stringify(more)).length(CANDIDATE_LIMIT.max)
      }
      const fifty = await searchOnce(
        db!,
        { userId: id('Dave Roberts'), isAdmin: false, scopes: [] },
        { text: 'page', location: null, mode: 'people', forTeam: team.falcons },
        { space: SPACE, jevBaseUrl: 'http://jev.example.test' }
      )
      expect(fifty.results).length(SEARCH_RESULTS_MAX)
      expect(fifty.context.ordered).length(PEOPLE_ONLY_MAX)
    } finally {
      await db!
        .updateTable('teams')
        .set({ league_id: 'lea_candCoastal' })
        .where('id', '=', team.mets)
        .execute()
      await db!
        .deleteFrom('memberships')
        .where('user_id', 'in', extra)
        .execute()
    }
  })

  it('answers as the search engine’s people rows carry it, one card for both', async function () {
    const actor = { userId: id('Dave Roberts'), isAdmin: false, scopes: [] }
    const deps = {
      // Nobody here has a picture, so no address is made from it.
      space: {
        endpoint: 'https://media.example.test',
        region: 'test',
        bucket: 'synthetic-images',
        accessKeyId: '00000000000000000000',
        secretAccessKey: '0000000000000000000000000000000000000000',
        pathStyle: true
      },
      jevBaseUrl: 'http://jev.example.test'
    }
    for (const q of ['', 'cody', 'mookie betts']) {
      const route = await ask(COACH, {
        forTeam: team.falcons,
        forGame: GAME,
        q
      })
      const engine = await searchOnce(
        db!,
        actor,
        {
          text: q,
          location: null,
          mode: 'people',
          forTeam: team.falcons,
          forGame: GAME
        },
        deps
      )
      expect(engine.locations, q).deep.equals([])
      // The route's rows, built from the person row and its card.
      const cards = engine.results.map(result => {
        if (result.kind !== 'person' || result.roster == null)
          throw new Error('Expected a person row with its card')
        // The words that found the person go to the phone with the card.
        const { tier, ...card } = result.roster
        return {
          userId: result.userId,
          externalIds: [],
          ...card,
          avatarUrl: result.avatarUrl,
          affiliations: result.associations,
          tier,
          cursor: ''
        }
      })
      const sorted = (rows: any[]): any[] =>
        rows.map(row =>
          Object.fromEntries(
            Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1))
          )
        )
      expect(sorted(cards), q).deep.equals(sorted(route.body))
    }
    // Mode all carries no card, and an empty field there answers nothing.
    const all = await searchOnce(
      db!,
      actor,
      { text: 'cody', location: null, mode: 'all' },
      deps
    )
    const person = all.results.find(result => result.kind === 'person')
    expect(person).not.equals(undefined)
    expect(person).not.have.property('roster')
    expect(
      (
        await searchOnce(
          db!,
          actor,
          { text: '', location: null, mode: 'all' },
          deps
        )
      ).results
    ).deep.equals([])
    // An empty Add Player field stays nearest first: Jev is not asked.
    const empty = await searchOnce(
      db!,
      actor,
      { text: '', location: null, mode: 'people', forTeam: team.falcons },
      deps
    )
    expect(empty.results.length).greaterThan(0)
    expect(
      await searchJev(
        db!,
        actor,
        { text: '', location: null, mode: 'people', forTeam: team.falcons },
        empty.context,
        deps
      )
    ).equals(null)
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
