import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { fold } from '../../common/search/match'
import {
  asSearchServerFrame,
  type Location,
  type SearchAsk,
  type SearchResult
} from '../../common/search/types'
import { type FakeJev, fakeJev } from '../../test/fakeJev'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import {
  fixtureUserId,
  insertFixtureUsers
} from '../../test/insertFixtureUsers'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import {
  PERSON_ASSOCIATIONS_MAX,
  type SearchDeps,
  searchJev,
  searchOnce
} from './engine'
import { ACTIVITY_ROWS, PEOPLE_ONLY_MAX, PER_KIND } from './gather'
import { searchReach } from './reach'
import { type ReaderCache, readerCache } from './readerCache'

/**
 * The search engine against a real database.
 *
 * The reader, Dave Roberts, is a spectator member of the Reach Tigers, which
 * Season Three of League Three manages, and holds a role on the Reach
 * Royals. He guards Miguel Rojas of the Reach Padres, is a member of
 * League One and Season One, holds roles on League Two and Season Two, and
 * follows the Followed Falcons. Each of those reaches a player; the
 * Falcons' and a stranger's do not.
 */

const READER = 301
const ADMIN = 105

const base = { latitude: 40, longitude: -100 }
/** A point this many miles north of the base. */
const north = (miles: number): { latitude: number; longitude: number } => ({
  latitude: base.latitude + miles / 69.0934,
  longitude: base.longitude
})
const locality = (
  city: string,
  region = 'Demo Region',
  country = 'US'
): {
  city: string
  region: string
  country: string
  placeId: null
  timezone: string
} => ({ city, region, country, placeId: null, timezone: 'UTC' })

const demoCity: Location = {
  kind: 'city',
  id: 'geonames:990001',
  label: 'Demo City, Demo Region',
  city: 'Demo City',
  region: 'Demo Region',
  country: 'US',
  ...base
}
const demoRegion: Location = {
  kind: 'region',
  id: 'region:US:Demo Region',
  label: 'Demo Region',
  region: 'Demo Region',
  country: 'US'
}
const unitedStates: Location = {
  kind: 'country',
  id: 'country:US',
  label: 'USA',
  country: 'US'
}
const quietRegion: Location = {
  kind: 'region',
  id: 'region:US:Quiet Region',
  label: 'Quiet Region',
  region: 'Quiet Region',
  country: 'US'
}

const ask = (text: string, more: Partial<SearchAsk> = {}): SearchAsk => ({
  text,
  location: null,
  mode: 'all',
  ...more
})

const names = (
  results: SearchResult[],
  kind?: SearchResult['kind']
): string[] =>
  results
    .filter(result => kind == null || result.kind === kind)
    .map(result => result.name)

describe('search engine', function () {
  this.timeout(120000)

  let f: GroupFixture
  let db: Kysely<Database>
  let jev: FakeJev
  let deps: SearchDeps
  const people: Record<string, string> = {}
  const reader: Actor = {
    userId: fixtureUserId(READER),
    isAdmin: false,
    scopes: []
  }
  const admin: Actor = {
    userId: fixtureUserId(ADMIN),
    isAdmin: true,
    scopes: []
  }
  let nextUser = 400

  async function person(name: string, teamId?: string): Promise<string> {
    const id = ++nextUser
    const [first, ...rest] = name.split(' ')
    await insertFixtureUsers(db, {
      id,
      legacyId: `usr_search_${id}`,
      display_name: name,
      first_name: first,
      last_name: rest.join(' ')
    })
    const userId = fixtureUserId(id)
    if (teamId != null) await member(userId, teamId, true)
    people[name] = userId
    return userId
  }

  async function member(
    userId: string,
    teamId: string,
    isPlayer: boolean
  ): Promise<void> {
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: teamId,
        role: 'member',
        is_player: isPlayer
      })
      .execute()
  }

  async function role(
    userId: string,
    scope: 'league' | 'season' | 'team',
    scopeId: string
  ): Promise<void> {
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userId,
        scope_type: scope,
        scope_id: scopeId,
        role: 'admin'
      })
      .execute()
  }

  async function league(
    id: string,
    name: string,
    place?: { locality: ReturnType<typeof locality>; at?: typeof base }
  ): Promise<string> {
    await db
      .insertInto('leagues')
      .values({
        id,
        name,
        locality: place == null ? null : JSON.stringify(place.locality),
        latitude: place?.at?.latitude ?? null,
        longitude: place?.at?.longitude ?? null
      })
      .execute()
    return id
  }

  async function season(
    id: string,
    name: string,
    leagueId: string | null
  ): Promise<string> {
    await db
      .insertInto('seasons')
      .values({
        id,
        name,
        league_id: leagueId,
        year: 2026,
        starts_on: '2026-01-01',
        ends_on: '2026-12-31'
      })
      .execute()
    return id
  }

  async function team(
    id: string,
    name: string,
    options: {
      leagueId?: string
      locality?: ReturnType<typeof locality>
      at?: typeof base
      seasonId?: string
      managedBy?: string
    } = {}
  ): Promise<string> {
    await db
      .insertInto('teams')
      .values({
        id,
        name,
        league_id: options.leagueId ?? null,
        locality:
          options.locality == null ? null : JSON.stringify(options.locality),
        latitude: options.at?.latitude ?? null,
        longitude: options.at?.longitude ?? null
      })
      .execute()
    if (options.seasonId != null)
      await db
        .insertInto('season_teams')
        .values({ season_id: options.seasonId, team_id: id })
        .execute()
    if (options.managedBy != null)
      await db
        .insertInto('season_team_parents')
        .values({ season_id: options.managedBy, team_id: id })
        .execute()
    return id
  }

  async function seedReach(): Promise<void> {
    await insertFixtureUsers(db, {
      id: READER,
      legacyId: 'usr_search_reader',
      display_name: 'Dave Roberts',
      first_name: 'Dave',
      last_name: 'Roberts',
      login_enabled: true
    })
    const me = reader.userId
    await league('lea_srchOne', 'League One')
    await league('lea_srchTwo', 'League Two')
    await league('lea_srchThree', 'League Three')
    await league('lea_srchSix', 'League Six')
    await season('sea_srchOne', 'Season One', null)
    await season('sea_srchTwo', 'Season Two', null)
    await season('sea_srchThree', 'Season Three', 'lea_srchThree')
    await db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: me,
        league_id: 'lea_srchOne'
      })
      .execute()
    await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: me,
        season_id: 'sea_srchOne'
      })
      .execute()
    await role(me, 'league', 'lea_srchTwo')
    await role(me, 'season', 'sea_srchTwo')
    await team('tem_srchTigers', 'Reach Tigers', {
      managedBy: 'sea_srchThree',
      leagueId: 'lea_srchThree',
      locality: locality('Demo City'),
      at: base
    })
    await member(me, 'tem_srchTigers', false)
    await team('tem_srchRoyals', 'Reach Royals')
    await role(me, 'team', 'tem_srchRoyals')
    await team('tem_srchPadres', 'Reach Padres')
    await team('tem_srchL1', 'League One Team', { leagueId: 'lea_srchOne' })
    await team('tem_srchL2', 'League Two Team', { leagueId: 'lea_srchTwo' })
    await team('tem_srchS1', 'Season One Team', { seasonId: 'sea_srchOne' })
    await team('tem_srchS2', 'Season Two Team', { managedBy: 'sea_srchTwo' })
    await team('tem_srchS3', 'Season Three Team', { seasonId: 'sea_srchThree' })
    await team('tem_srchL3', 'League Three Team', { leagueId: 'lea_srchThree' })
    await team('tem_srchFalcons', 'Followed Falcons')
    await team('tem_srchFalcons2', 'Falcons Two')
    await team('tem_srchStranger', 'Stranger Team', { leagueId: 'lea_srchSix' })
    await team('tem_srchStranger2', 'Stranger Two', { leagueId: 'lea_srchSix' })
    await db
      .insertInto('follows')
      .values({ user_id: me, group_type: 'team', group_id: 'tem_srchFalcons' })
      .execute()
    await person('Clayton Kershaw', 'tem_srchL1')
    await person('Walker Buehler', 'tem_srchL2')
    await person('Max Muncy', 'tem_srchS1')
    await person('Will Smith', 'tem_srchS2')
    await person('Freddie Freeman', 'tem_srchTigers')
    await person('José Abreu', 'tem_srchTigers')
    await person('Jason Heyward', 'tem_srchS3')
    await person('Chris Taylor', 'tem_srchL3')
    await person('Mookie Betts', 'tem_srchRoyals')
    const child = await person('Miguel Rojas', 'tem_srchPadres')
    await person('Enrique Hernandez', 'tem_srchPadres')
    const guardian = await person('Austin Barnes')
    for (const [from, to] of [
      [me, child],
      [guardian, people['Freddie Freeman']]
    ])
      await db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: from,
          related_user_id: to,
          kind: 'guardian'
        })
        .execute()
    await person('Shohei Ohtani', 'tem_srchFalcons')
    await person('Yoshinobu Yamamoto', 'tem_srchStranger')
    await person('Tyler Glasnow', 'tem_srchStranger2')
  }

  async function seedPlaces(): Promise<void> {
    await team('tem_srchWInside', 'Widen Inside', {
      locality: locality('Demo City'),
      at: base
    })
    await team('tem_srchWClose', 'Widen Close', {
      locality: locality('Southtown'),
      at: north(2)
    })
    await team('tem_srchWNear', 'Widening Near', {
      locality: locality('Northtown'),
      at: north(6)
    })
    await team('tem_srchWFar', 'Widen Far', {
      locality: locality('Fartown'),
      at: north(8)
    })
    await team('tem_srchWDistant', 'Widen Distant', {
      locality: locality('Distant Town'),
      at: north(30)
    })
    await team('tem_srchWNowhere', 'Widen Nowhere', {
      locality: locality('Nowhere Town')
    })
    for (let at = 0; at < 20; ++at)
      await team(`tem_srchWExtra${at}`, `Widen Extra ${at}`, {
        locality: locality(`Extra Town ${at}`),
        at: north(50 + at)
      })

    await league('lea_srchFilter', 'Filter League', {
      locality: locality('Demo City'),
      at: base
    })
    await season('sea_srchFilter', 'Filter Season', 'lea_srchFilter')
    await team('tem_srchFilterA', 'Filter A', {
      locality: locality('Demo City')
    })
    await team('tem_srchFilterB', 'Filter B', {
      locality: locality('Elsewhere', 'Other Region')
    })
    await team('tem_srchFilterC', 'Filter C', {
      locality: locality('Maple Town', 'Demo Region', 'CA')
    })

    const quiet = locality('Quiet Town', 'Quiet Region')
    await team('tem_srchQuiet1', 'Quiet One', { locality: quiet })
    await team('tem_srchQuiet2', 'Quiet Two', { locality: quiet })
    await team('tem_srchQuiet3', 'Quiet Three', { locality: quiet })
    for (const [teamId, daysAgo] of [
      ['tem_srchQuiet1', 1],
      ['tem_srchQuiet2', 365]
    ] as const)
      await db
        .insertInto('team_events')
        .values({
          id: makeId('teamEvent'),
          team_id: teamId,
          title: 'Practice',
          start_at: new Date(Date.now() - daysAgo * 86_400_000)
        })
        .execute()

    for (let at = 0; at < 22; ++at) {
      await league(`lea_srchCap${at}`, `Capstone League ${at}`)
      await season(`sea_srchCap${at}`, `Capstone Season ${at}`, null)
      await team(`tem_srchCap${at}`, `Capstone Team ${at}`)
    }
  }

  before(async () => {
    f = await groupFixture()
    db = f.h.db
    jev = await fakeJev()
    deps = { space: f.h.space, jevBaseUrl: jev.baseUrl, log: () => undefined }
    await seedReach()
    await seedPlaces()
  })

  after(async () => {
    await jev?.close()
    await f?.h.close()
  })

  afterEach(async () => {
    jev.reset()
    await db
      .deleteFrom('system_settings')
      .where('key', '=', 'jev.apiKey')
      .execute()
  })

  async function setKey(): Promise<void> {
    await db
      .insertInto('system_settings')
      .values({ key: 'jev.apiKey', value: JSON.stringify('ts-search-key') })
      .execute()
  }

  describe('reach', () => {
    it('holds every own group and the managing season and league of each team', async () => {
      const reach = await searchReach(db, reader)
      expect([...reach.teamIds].sort()).deep.equals(
        ['tem_srchPadres', 'tem_srchRoyals', 'tem_srchTigers'].sort()
      )
      expect([...reach.seasonIds].sort()).deep.equals(
        ['sea_srchOne', 'sea_srchThree', 'sea_srchTwo'].sort()
      )
      expect([...reach.leagueIds].sort()).deep.equals(
        ['lea_srchOne', 'lea_srchThree', 'lea_srchTwo'].sort()
      )
      const signedOut = await searchReach(db, null)
      expect(signedOut.teamIds.size + signedOut.seasonIds.size).equals(0)
      expect(signedOut.leagueIds.size).equals(0)
    })

    it('finds people through every membership kind, guardians, and team to season and league', async () => {
      for (const name of [
        'Clayton Kershaw',
        'Walker Buehler',
        'Max Muncy',
        'Will Smith',
        'Freddie Freeman',
        'Jason Heyward',
        'Chris Taylor',
        'Mookie Betts',
        'Miguel Rojas',
        'Enrique Hernandez',
        'Austin Barnes'
      ]) {
        const first = name.split(' ')[0]
        const { results } = await searchOnce(db, reader, ask(first), deps)
        const found = results.filter(result => result.kind === 'person')
        expect(
          found.map(result => result.kind === 'person' && result.userId),
          name
        ).includes(people[name])
      }
    })

    it('finds nobody only followed or with no tie, and nobody when signed out', async () => {
      for (const first of ['Shohei', 'Yoshinobu', 'Tyler'])
        expect(
          names(
            (await searchOnce(db, reader, ask(first), deps)).results,
            'person'
          ),
          first
        ).deep.equals([])
      const signedOut = await searchOnce(db, null, ask('freddie'), deps)
      expect(names(signedOut.results, 'person')).deep.equals([])
      // Organizations are anybody's to find.
      expect(
        names((await searchOnce(db, null, ask('reach'), deps)).results, 'team')
      ).includes('Reach Tigers')
    })
  })

  describe('people', () => {
    it('matches the name the reader is shown, or the stored name typed whole', async () => {
      const shown = async (text: string): Promise<string[]> =>
        names((await searchOnce(db, reader, ask(text), deps)).results, 'person')
      expect(await shown('fred')).deep.equals(['Freddie F'])
      expect(await shown('freeman'), 'a hidden surname alone').deep.equals([])
      expect(await shown('freddie freeman')).deep.equals(['Freddie F'])
      // The reader holds a role on the Royals, and reads their people in full.
      expect(await shown('betts')).deep.equals(['Mookie Betts'])
      expect(await shown('jose')).deep.equals(['José A'])
    })

    it('finds ø, ł and ß names by either spelling, folded alike in SQL and JS', async () => {
      // The reader reads the Royals' people in full.
      const soler = await person('Jørge Soler', 'tem_srchRoyals')
      const kepler = await person('Max Kepłer', 'tem_srchRoyals')
      const martin = await person('Rußell Martin', 'tem_srchRoyals')
      await team('tem_srchFjord', 'Fjørd Foxes', {
        locality: locality('Sjøby')
      })
      const ids = async (text: string): Promise<string[]> =>
        (await searchOnce(db, reader, ask(text), deps)).results.map(result =>
          result.kind === 'person' ? result.userId : result.id
        )
      for (const [typed, id] of [
        ['jorge', soler],
        ['jørge soler', soler],
        ['kepler', kepler],
        ['KEPŁER', kepler],
        ['russell', martin],
        ['rußell', martin],
        ['fjord', 'tem_srchFjord'],
        ['fjørd', 'tem_srchFjord'],
        ['sjoby', 'tem_srchFjord']
      ] as const)
        expect(await ids(typed), typed).deep.equals([id])
      // Every Latin-1 and Latin Extended-A letter folds as `ts_name_fold`.
      const letters = Array.from({ length: 0x180 - 0xc0 }, (_, at) =>
        String.fromCodePoint(0xc0 + at)
      )
        .concat('ẞ')
        .filter(letter => /\p{L}/u.test(letter))
      const { rows } = await sql<{ folded: string[] }>`
        select array(
          select ts_name_fold(letter) from unnest(${letters}::text[])
            with ordinality as each(letter, at) order by at
        ) as folded
      `.execute(db)
      expect(letters.map(fold)).deep.equals(rows[0]?.folded)
    })

    it('finds a name with a curly or modifier apostrophe by a straight one, and the other way, folded alike in SQL and JS', async () => {
      // The reader reads the Royals' people in full.
      const oneill = await person('Tyler O’Neill', 'tem_srchRoyals')
      const ohearn = await person("Ryan O'Hearn", 'tem_srchRoyals')
      const ids = async (text: string): Promise<string[]> =>
        (await searchOnce(db, reader, ask(text), deps)).results.flatMap(
          result => (result.kind === 'person' ? [result.userId] : [])
        )
      for (const [typed, id] of [
        ["o'neill", oneill],
        ['O’Neill', oneill],
        ['oʼneill', oneill],
        ["o'hearn", ohearn],
        ['O’Hearn', ohearn],
        ['o‘hearn', ohearn],
        ['oʻhearn', ohearn]
      ] as const)
        expect(await ids(typed), typed).deep.equals([id])
      // Every mark unaccent makes an apostrophe folds as `ts_name_fold`.
      const marks = ['’', '‘', '‛', '′', '＇', 'ʹ', 'ʻ', 'ʼ', 'ʽ', 'ˈ'].map(
        mark => `O${mark}Brien`
      )
      const { rows } = await sql<{ folded: string[] }>`
        select array(
          select ts_name_fold(mark) from unnest(${marks}::text[])
            with ordinality as each(mark, at) order by at
        ) as folded
      `.execute(db)
      expect(marks.map(fold)).deep.equals(rows[0]?.folded)
      expect(new Set(marks.map(fold))).deep.equals(new Set(["o'brien"]))
    })

    it('finds a person the reader reads in full by any stored name, the display name too', async () => {
      const named = async (
        id: number,
        first: string,
        last: string,
        display: string,
        teamId: string
      ): Promise<string> => {
        await insertFixtureUsers(db, {
          id,
          legacyId: `usr_search_${id}`,
          display_name: display,
          first_name: first,
          last_name: last
        })
        const userId = fixtureUserId(id)
        await member(userId, teamId, true)
        return userId
      }
      // The reader reads the Royals in full and the Tigers short.
      const witt = await named(390, 'Robert', 'Witt', 'Bobby', 'tem_srchRoyals')
      await named(391, 'Kenneth', 'Griffey', 'Junior', 'tem_srchTigers')
      const found = async (text: string): Promise<string[]> =>
        (await searchOnce(db, reader, ask(text), deps)).results.flatMap(
          result => (result.kind === 'person' ? [result.userId] : [])
        )
      expect(await found('bobby')).deep.equals([witt])
      expect(await found('bobby witt')).deep.equals([witt])
      // Read short, a display name the row does not show finds nobody.
      expect(await found('junior')).deep.equals([])
    })

    it('shows a person’s affiliations', async () => {
      const { results } = await searchOnce(db, reader, ask('mookie'), deps)
      const [mookie] = results
      expect(mookie).deep.include({
        kind: 'person',
        userId: people['Mookie Betts'],
        name: 'Mookie Betts',
        associations: 'Reach Royals'
      })
    })

    it('keeps the associations of a person on 40 teams under the client’s limit: newest team first, then how many more', async () => {
      // Every team is in League One, which the reader belongs to, and in
      // Season One, which ends this year, so the cards list the teams too.
      const edman = await person('Tommy Edman')
      for (let at = 0; at < 40; ++at) {
        const id = `tem_srchMany${String(at).padStart(2, '0')}`
        await team(
          id,
          `Zephyr Club ${at} ${'Z'.repeat(at === 39 ? 120 : 20)}`,
          {
            seasonId: 'sea_srchOne',
            leagueId: 'lea_srchOne'
          }
        )
        await db
          .insertInto('memberships')
          .values({
            id: makeId('membership'),
            user_id: edman,
            team_id: id,
            role: 'member',
            is_player: true,
            joined_at: new Date(Date.UTC(2000 + at, 0, 1))
          })
          .execute()
      }
      for (const more of [
        {},
        { mode: 'people' as const, forTeam: 'tem_srchRoyals' }
      ]) {
        const { results } = await searchOnce(
          db,
          reader,
          ask('tommy', more),
          deps
        )
        const [found] = results
        expect(found?.kind).equals('person')
        const line = found?.associations ?? ''
        expect(line.length).lessThan(1024)
        expect(line.length).most(PERSON_ASSOCIATIONS_MAX)
        // The newest team first, its long name cut with an ellipsis.
        expect(line).match(/^Zephyr Club 39 Z+…, Zephyr Club 38 /)
        expect(line).match(/, \+\d+ more$/)
        // The frame the socket sends with it is one the client accepts.
        expect(() =>
          asSearchServerFrame({
            type: 'results',
            seq: 1,
            stage: 'lexicographic',
            results,
            locations: []
          })
        ).not.throws()
      }
    })

    it('hides people under a pill', async () => {
      for (const location of [demoCity, demoRegion, unitedStates])
        expect(
          names(
            (await searchOnce(db, reader, ask('freddie', { location }), deps))
              .results,
            'person'
          )
        ).deep.equals([])
    })

    it('for a team, leaves out who it holds and anybody already in the game', async () => {
      const forTeam = async (
        actor: Actor,
        text: string,
        more: Partial<SearchAsk> = {}
      ): Promise<string[]> =>
        names(
          (
            await searchOnce(
              db,
              actor,
              ask(text, { mode: 'people', forTeam: 'tem_srchRoyals', ...more }),
              deps
            )
          ).results
        )
      expect(await forTeam(reader, 'mookie')).deep.equals([])
      expect(await forTeam(reader, 'freddie')).deep.equals(['Freddie F'])
      // People mode answers no organizations.
      expect(await forTeam(reader, 'reach')).deep.equals([])
      await db
        .insertInto('games')
        .values({
          id: 'gam_srchGame',
          home_team_id: 'tem_srchRoyals',
          away_team_id: 'tem_srchPadres',
          start_at: new Date()
        })
        .execute()
      expect(await forTeam(reader, 'enrique')).deep.equals(['Enrique H'])
      expect(
        await forTeam(reader, 'enrique', { forGame: 'gam_srchGame' })
      ).deep.equals([])
      // The target's league widens the reach of an administrator, who has
      // none of their own.
      const outside = async (): Promise<string[]> =>
        names(
          (
            await searchOnce(
              db,
              admin,
              ask('tyler', { mode: 'people', forTeam: 'tem_srchStranger' }),
              deps
            )
          ).results
        )
      expect(await outside()).deep.equals(['Tyler Glasnow'])
      expect(
        names(
          (await searchOnce(db, admin, ask('tyler'), deps)).results,
          'person'
        )
      ).deep.equals([])
      let refused: unknown
      try {
        await searchOnce(
          db,
          reader,
          ask('freddie', { mode: 'people', forTeam: 'tem_srchTigers' }),
          deps
        )
      } catch (error) {
        refused = error
      }
      expect(refused, 'a spectator adds nobody').instanceOf(Error)
    })

    it('offers a tournament’s other teams’ players for a team it plays in and for a game in it', async () => {
      // The Royals play in the Tourney Cup that Tourney League runs, through
      // season_teams, with no managing season of their own there. A game of
      // theirs is in the Tourney Bowl, which they do not play in.
      await league('lea_srchTourney', 'Tourney League')
      await season('sea_srchCup', 'Tourney Cup', 'lea_srchTourney')
      await season('sea_srchBowl', 'Tourney Bowl', 'lea_srchTourney')
      await db
        .insertInto('season_teams')
        .values({ season_id: 'sea_srchCup', team_id: 'tem_srchRoyals' })
        .execute()
      await team('tem_srchCupRival', 'Cup Rival', { seasonId: 'sea_srchCup' })
      await team('tem_srchBowlRival', 'Bowl Rival', {
        seasonId: 'sea_srchBowl'
      })
      await team('tem_srchBowlThird', 'Bowl Third', {
        seasonId: 'sea_srchBowl'
      })
      const cupPlayer = await person('Jarren Duran', 'tem_srchCupRival')
      await person('Triston Casas', 'tem_srchBowlRival')
      const bowlPlayer = await person('Ceddanne Rafaela', 'tem_srchBowlThird')
      await db
        .insertInto('games')
        .values({
          id: 'gam_srchBowl',
          home_team_id: 'tem_srchRoyals',
          away_team_id: 'tem_srchBowlRival',
          season_id: 'sea_srchBowl',
          start_at: new Date()
        })
        .execute()
      const found = async (
        text: string,
        more: Partial<SearchAsk> = {}
      ): Promise<Array<[string, string]>> =>
        (
          await searchOnce(
            db,
            reader,
            ask(text, { mode: 'people', forTeam: 'tem_srchRoyals', ...more }),
            deps
          )
        ).results.flatMap(result =>
          result.kind === 'person'
            ? [[result.userId, result.roster?.tier ?? '']]
            : []
        )
      expect(await found('jarren')).deep.equals([[cupPlayer, 'season']])
      // Search alone does not reach the tournament.
      expect(
        names((await searchOnce(db, reader, ask('jarren'), deps)).results)
      ).deep.equals([])
      // The game's season is reached for the game, its opponent left out.
      expect(await found('ceddanne')).deep.equals([])
      expect(await found('ceddanne', { forGame: 'gam_srchBowl' })).deep.equals([
        [bowlPlayer, 'season']
      ])
      expect(await found('triston', { forGame: 'gam_srchBowl' })).deep.equals(
        []
      )
    })

    it('carries on each Add Existing Player card only the typed words that found that person', async () => {
      const matched = async (text: string): Promise<Record<string, unknown>> =>
        Object.fromEntries(
          (
            await searchOnce(
              db,
              reader,
              ask(text, { mode: 'people', forTeam: 'tem_srchRoyals' }),
              deps
            )
          ).results.flatMap(result =>
            result.kind === 'person'
              ? [[result.name, result.roster?.matched]]
              : []
          )
        )
      expect(await matched('freddie enrique')).deep.equals({
        'Freddie F': ['freddie'],
        'Enrique H': ['enrique']
      })
      // Typed whole, the hidden surname found him too.
      expect(await matched('freddie freeman')).deep.equals({
        'Freddie F': ['freddie', 'freeman']
      })
      // Nothing typed found nobody by a word.
      const listed = Object.values(await matched(''))
      expect(listed).to.not.have.length(0)
      expect(listed.every(words => words === undefined)).equals(true)
    })

    it('offers Add Existing Player only players and the reader’s own wards, though Search finds everybody in reach', async () => {
      // The Royals' coach and a League One administrator play nowhere; a
      // ward of the reader is on no team.
      const coach = await person('Dusty Baker')
      await member(coach, 'tem_srchRoyals', false)
      const leagueAdmin = await person('Dusty Rhodes')
      await role(leagueAdmin, 'league', 'lea_srchOne')
      const ward = await person('Dusty Wathan')
      await db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: reader.userId,
          related_user_id: ward,
          kind: 'guardian'
        })
        .execute()
      const found = async (more: Partial<SearchAsk>): Promise<string[]> =>
        (await searchOnce(db, reader, ask('dusty', more), deps)).results.map(
          result => (result.kind === 'person' ? result.userId : result.id)
        )
      expect(
        await found({ mode: 'people', forTeam: 'tem_srchRoyals' })
      ).deep.equals([ward])
      expect(await found({})).to.have.members([coach, leagueAdmin, ward])
    })

    it("cards Add Existing Player's people with the socket's kept scopes and grants", async () => {
      const cache = readerCache()
      let scopes = 0
      let grants = 0
      const spied: ReaderCache = {
        ...cache,
        of: (on, actor) => {
          const reads = cache.of(on, actor)
          return {
            ...reads,
            scopes: async () => {
              scopes++
              return await reads.scopes()
            },
            grants: async () => {
              grants++
              return await reads.grants()
            }
          }
        }
      }
      const socket: SearchDeps = { ...deps, reader: spied }
      const forRoyals = ask('freddie', {
        mode: 'people',
        forTeam: 'tem_srchRoyals'
      })
      const first = await searchOnce(db, reader, forRoyals, socket)
      expect(names(first.results)).deep.equals(['Freddie F'])
      expect(scopes, 'the cards read the kept scopes').greaterThan(0)
      expect(grants).greaterThan(0)
      const read = cache.reads()
      const second = await searchOnce(db, reader, forRoyals, socket)
      // Nothing of the reader's is read again for the cards.
      expect(cache.reads()).equals(read)
      expect(second.results).deep.equals(first.results)
    })
  })

  describe('people only', () => {
    it('gathers 80 people in mode people, shows 50, and Jev re-ranks all 80 to 50; mode all keeps 20', async () => {
      // Eighty-five on the Royals, whose people the reader reads in full.
      for (let at = 0; at < 85; ++at)
        await person(
          `Depth Player${String(at).padStart(2, '0')}`,
          'tem_srchRoyals'
        )
      const text = ask('depth', { mode: 'people' })
      const once = await searchOnce(db, reader, text, deps)
      expect(PEOPLE_ONLY_MAX).equals(80)
      expect(once.context.ordered).length(PEOPLE_ONLY_MAX)
      expect(once.results).length(50)
      expect(names(once.results)).deep.equals(
        names(once.context.results.slice(0, 50))
      )
      const mixed = await searchOnce(db, reader, ask('depth'), deps)
      expect(names(mixed.context.results, 'person')).length(PER_KIND)

      await setKey()
      // The last of the eighty (`c80`: Jev reads a narrowed name), past the
      // first fifty, ranked first.
      const last = names(once.context.results).at(-1)!
      expect(names(once.results)).not.includes(last)
      jev.setNouls({ [`c${PEOPLE_ONLY_MAX}`]: 0.99 }, 0.5)
      const ranked = await searchJev(db, reader, text, once.context, deps)
      expect(ranked).not.equals(null)
      expect(ranked!.results).length(50)
      expect(names(ranked!.results)[0]).equals(last)
      const [request] = jev.requests
      expect(Object.keys(request.body.state?.candidates ?? {})).length(
        PEOPLE_ONLY_MAX
      )
    })
  })

  describe('organizations', () => {
    it('keeps 20 of each kind and the first 50', async () => {
      const { results, context } = await searchOnce(
        db,
        null,
        ask('capstone'),
        deps
      )
      expect(context.ordered).length(3 * PER_KIND)
      expect(results).length(50)
      for (const kind of ['league', 'season', 'team'] as const)
        expect(
          context.results.filter(result => result.kind === kind),
          kind
        ).length(PER_KIND)
      // Kinds interleave by match: the shorter names lead.
      expect(names(results.slice(0, 3))).deep.equals([
        'Capstone Team 0',
        'Capstone Team 1',
        'Capstone Team 2'
      ])
    })

    it('reads the follow state, the city line and the associations', async () => {
      const { results } = await searchOnce(db, reader, ask('falcons'), deps)
      expect(
        results.map(result => result.kind !== 'person' && result.follow)
      ).deep.equals(['follow', 'following'])
      const own = (await searchOnce(db, reader, ask('tigers'), deps)).results
      expect(own[0]).deep.equals({
        kind: 'team',
        id: 'tem_srchTigers',
        name: 'Reach Tigers',
        imageUrl: null,
        cityLine: 'Demo City, Demo Region',
        associations: 'Season Three · League Three',
        follow: null
      })
      const signedOut = (await searchOnce(db, null, ask('falcons'), deps))
        .results
      expect(
        signedOut.map(result => result.kind !== 'person' && result.follow)
      ).deep.equals([null, null])
      const filter = (await searchOnce(db, null, ask('filter'), deps)).results
      const league = filter.find(result => result.kind === 'league')
      const season = filter.find(result => result.kind === 'season')
      expect(league).deep.include({
        cityLine: null,
        associations: 'Demo City, Demo Region'
      })
      expect(season).deep.include({
        cityLine: 'Demo City, Demo Region',
        associations: 'Filter League'
      })
    })

    it('widens a city by distance, in 5-mile rings, until each kind has 20', async () => {
      const { results } = await searchOnce(
        db,
        null,
        ask('widen', { location: demoCity }),
        deps
      )
      expect(names(results, 'team')).deep.equals([
        'Widen Inside',
        'Widen Close',
        'Widen Far',
        'Widening Near',
        'Widen Distant',
        ...Array.from({ length: 15 }, (_, at) => `Widen Extra ${at}`)
      ])
    })

    it('only filters by a region or a country', async () => {
      const found = async (location: Location): Promise<string[]> =>
        names(
          (await searchOnce(db, null, ask('filter', { location }), deps))
            .results
        )
      expect((await found(demoRegion)).sort()).deep.equals(
        ['Filter A', 'Filter League', 'Filter Season'].sort()
      )
      expect((await found(unitedStates)).sort()).deep.equals(
        ['Filter A', 'Filter B', 'Filter League', 'Filter Season'].sort()
      )
    })

    it('lists a pill’s organizations by recent activity with no text', async () => {
      const { results } = await searchOnce(
        db,
        reader,
        ask('', { location: quietRegion }),
        deps
      )
      expect(names(results)).deep.equals([
        'Quiet One',
        'Quiet Two',
        'Quiet Three'
      ])
    })

    it(`reads recent activity for the nearest ${ACTIVITY_ROWS} of a kind under a pill, then lists the most recently active`, async () => {
      const busy = locality('Busy Town', 'Busy Region')
      const ids = Array.from(
        { length: ACTIVITY_ROWS + 10 },
        (_, at) => `tem_srchBusy${String(at).padStart(3, '0')}`
      )
      await db
        .insertInto('teams')
        .values(
          ids.map(id => ({
            id,
            name: `Busy ${id.slice(-3)}`,
            locality: JSON.stringify(busy)
          }))
        )
        .execute()
      // Busy 005 is among the first by name; Busy 209 is past them.
      for (const teamId of ['tem_srchBusy005', 'tem_srchBusy209'])
        await db
          .insertInto('team_events')
          .values({
            id: makeId('teamEvent'),
            team_id: teamId,
            title: 'Practice',
            start_at: new Date(Date.now() - 86_400_000)
          })
          .execute()
      try {
        const { results } = await searchOnce(
          db,
          reader,
          ask('', {
            location: {
              kind: 'region',
              id: 'region:US:Busy Region',
              label: 'Busy Region',
              region: 'Busy Region',
              country: 'US'
            }
          }),
          deps
        )
        const teams = names(results, 'team')
        expect(teams).length(PER_KIND)
        expect(teams[0]).equals('Busy 005')
        expect(teams.slice(1, 4)).deep.equals([
          'Busy 000',
          'Busy 001',
          'Busy 002'
        ])
        expect(teams).not.includes('Busy 209')
      } finally {
        await db.deleteFrom('team_events').where('team_id', 'in', ids).execute()
        await db.deleteFrom('teams').where('id', 'in', ids).execute()
      }
    })

    it('keeps a long-running team’s associations under the client’s limit: newest seasons first, then how many more', async () => {
      await league('lea_srchLong', `Longrun League ${'L'.repeat(120)}`)
      const seasons = Array.from(
        { length: 40 },
        (_, at) => `sea_srchLong${String(at).padStart(2, '0')}`
      )
      await db
        .insertInto('seasons')
        .values(
          seasons.map((id, at) => ({
            id,
            name: `Longrun Season ${1987 + at} of the Longrun League Spring and Fall`,
            league_id: 'lea_srchLong',
            year: 1987 + at,
            starts_on: `${1987 + at}-01-01`,
            ends_on: `${1987 + at}-12-31`
          }))
        )
        .execute()
      await team('tem_srchLong', 'Longrun Team', { leagueId: 'lea_srchLong' })
      await db
        .insertInto('season_teams')
        .values(seasons.map(id => ({ season_id: id, team_id: 'tem_srchLong' })))
        .execute()
      const { results } = await searchOnce(db, reader, ask('longrun'), deps)
      const longrun = results.find(result => result.kind === 'team')
      const line = longrun?.associations ?? ''
      expect(line.length).lessThan(1024)
      expect(line.startsWith('Longrun Season 2026 of')).equals(true)
      expect(line).match(/\+\d+ more ·/)
      // The league's name is cut short with an ellipsis.
      expect(line).match(/Longrun League L+…$/)
      // The frame the socket sends with it is one the client accepts.
      expect(() =>
        asSearchServerFrame({
          type: 'results',
          seq: 1,
          stage: 'lexicographic',
          results,
          locations: []
        })
      ).not.throws()
    })

    it('answers nothing and suggests no pill for an empty search', async () => {
      const empty = await searchOnce(db, reader, ask('  '), deps)
      expect(empty.results).deep.equals([])
      expect(empty.locations).deep.equals([])
      expect(await searchJev(db, reader, ask(''), empty.context, deps)).equals(
        null
      )
      const chosen = await searchOnce(
        db,
        null,
        ask('demo', { location: demoRegion }),
        deps
      )
      expect(chosen.locations, 'no pills beside a chosen one').deep.equals([])
      const open = await searchOnce(db, null, ask('demo'), deps)
      expect(open.locations.length).within(1, 4)
    })
  })

  describe('Jev', () => {
    it('re-orders the candidates by noul', async () => {
      await setKey()
      jev.setNouls({ 'Widen Distant': 0.99, 'Widen Inside': 0.01 }, 0.5)
      const text = ask('widen', { location: demoCity })
      const once = await searchOnce(db, reader, text, deps)
      const ranked = await searchJev(db, reader, text, once.context, deps)
      expect(ranked).not.equals(null)
      expect(ranked!.model).equals('jev-1.13.0-fake')
      const order = names(ranked!.results)
      expect(order[0]).equals('Widen Distant')
      expect(order.at(-1)).equals('Widen Inside')
      // The rest keep the lexicographic order between them.
      expect(order.slice(1, 4)).deep.equals([
        'Widen Close',
        'Widen Far',
        'Widening Near'
      ])
      const [request] = jev.requests
      expect(request.authorization).equals('Bearer ts-search-key')
      const facts = request.body.state?.candidates ?? {}
      const close = Object.values(facts).find(
        each => each.name === 'Widen Close'
      ) as Record<string, unknown>
      expect(close.milesAway).within(1.9, 2.1)
      expect(close.placeLabel).equals('Southtown, Demo Region')
      expect(close.ties).deep.equals({ member: false, follows: false })
      expect(close.words).deep.equals([{ word: 'widen', match: 'perfect' }])
    })

    it('reads a group’s activity and the reader’s ties', async () => {
      await setKey()
      const text = ask('quiet')
      const once = await searchOnce(db, reader, text, deps)
      expect(await searchJev(db, reader, text, once.context, deps)).not.equals(
        null
      )
      const facts = Object.values(
        jev.requests[0].body.state?.candidates ?? {}
      ) as Array<Record<string, unknown>>
      const one = facts.find(each => each.name === 'Quiet One')
      const three = facts.find(each => each.name === 'Quiet Three')
      expect(one?.lastActivityOn).equals(
        new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
      )
      expect(three).not.has.property('lastActivityOn')
      jev.reset()
      const tigers = ask('tigers')
      const own = await searchOnce(db, reader, tigers, deps)
      await searchJev(db, reader, tigers, own.context, deps)
      const tiger = jev.requests[0].body.state?.candidates?.c1 as Record<
        string,
        unknown
      >
      expect(tiger.ties).deep.equals({ member: true, follows: false })
    })

    it('reads only the narrowed names models get', async () => {
      await setKey()
      const text = ask('mookie')
      const once = await searchOnce(db, reader, text, deps)
      expect(names(once.results)).deep.equals(['Mookie Betts'])
      const ranked = await searchJev(db, reader, text, once.context, deps)
      expect(names(ranked!.results), 'the rows stay the reader’s').deep.equals([
        'Mookie Betts'
      ])
      const body = JSON.stringify(jev.requests[0].body)
      expect(body).not.contains('Betts')
      const mookie = jev.requests[0].body.state?.candidates?.c1 as Record<
        string,
        unknown
      >
      expect(mookie.name).equals('Mookie B')
      expect(mookie.ties).deep.equals({ sharesTeam: true, guardian: false })
      jev.reset()
      const forTeam = ask('freddie', {
        mode: 'people',
        forTeam: 'tem_srchRoyals'
      })
      const target = await searchOnce(db, reader, forTeam, deps)
      await searchJev(db, reader, forTeam, target.context, deps)
      const freddie = jev.requests[0].body.state?.candidates?.c1 as Record<
        string,
        unknown
      >
      expect(freddie.ties).deep.equals({
        sharesTeam: true,
        guardian: false,
        inTargetSeason: false,
        inTargetLeague: false
      })
    })

    it('is null with no key, a failure, or an aborted call', async () => {
      const text = ask('widen')
      const once = await searchOnce(db, null, text, deps)
      expect(await searchJev(db, null, text, once.context, deps)).equals(null)
      expect(jev.requests).length(0)
      await setKey()
      jev.fail(500)
      expect(await searchJev(db, null, text, once.context, deps)).equals(null)
      jev.reset()
      const controller = new AbortController()
      controller.abort()
      expect(
        await searchJev(db, null, text, once.context, deps, controller.signal)
      ).equals(null)
      expect(jev.requests).length(0)
      jev.delay(500)
      expect(
        await searchJev(db, null, text, once.context, {
          ...deps,
          jevTimeoutMs: 50
        })
      ).equals(null)
    })

    it('ranks the location pills too', async () => {
      await setKey()
      const text = ask('demo')
      const once = await searchOnce(db, null, text, deps)
      const pills = once.context.locations
      expect(pills.length).greaterThan(1)
      const last = pills.at(-1)!.location
      jev.setNouls({ [last.label]: 0.99 }, 0.1)
      const ranked = await searchJev(db, null, text, once.context, deps)
      expect(ranked!.locations[0].id).equals(last.id)
      expect(ranked!.locations.length).lessThanOrEqual(4)
      const facts = jev.requests[0].body.state?.locations ?? {}
      expect(Object.keys(facts)).length(pills.length)
    })
  })
})
