/**
 * End to end for guardians, roles, the non-member view and Home cards.
 *
 *   node src/build.mjs
 *   TS_GUARDIAN_STAGE=<stage|all> \
 *   TS_GUARDIAN_ARTIFACTS=<artifacts dir> \
 *   node -r sucrase/register src/app/guardianAndKeeperRights.e2e.ts
 *
 * Each stage starts its own real server, database and web app through
 * `guardianFixture`, so stages never see each other's changes and `all` runs
 * them in order. Every request a stage makes through `api` is written to that
 * stage's log in the artifacts: `$ <METHOD> <path> as <user>`, the body sent,
 * then the status and the answer, which a stage may cut to the fields that
 * matter (`api(file, summarize)`).
 *
 * A stage that drives the web app opens maestro-d web sessions with
 * `run.browser(device)`, which needs `MAESTRO_D` (an unused daemon name),
 * `MAESTRO_D_BIN` and `TS_MAESTRO_D_CLIENT`. A stage that only calls the API,
 * like `apiRoles`, needs none of them.
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { makeId } from '../common/ids'
import { createSession } from '../server/auth/sessions'
import { posterSecond } from '../server/media/posters'
import { stillKey } from '../server/media/stills'
import { type GuardianFixture, guardianFixture } from '../test/guardianFixture'
import type { BrowserSession } from '../test/refinementsMaestro.e2e'

/** The viewport every screenshot is taken at, the same as the befores. */
const WIDTH = 390
const HEIGHT = 844

interface Run {
  f: GuardianFixture
  artifacts: string
  /**
   * A request as one user, written to `file` in the artifacts: the whole
   * answer, or what `summarize` keeps of it.
   */
  api: (
    file: string,
    summarize?: (route: string, body: any) => unknown
  ) => ApiLog
  /** A `# ` line in a log of `api`'s, for what happened between requests. */
  note: (file: string, text: string) => Promise<void>
  /** A signed-out maestro-d web session at the screenshot viewport. */
  browser: (device: string) => Promise<BrowserSession>
  /**
   * A web session signed in as `user` with an e-mailed code, the way a person
   * signs in, at the screenshot viewport.
   */
  signIn: (device: string, user: number) => Promise<BrowserSession>
  /**
   * Saves what the session shows as `name` in the artifacts, once the page
   * has stopped loading. With `fit`, the viewport grows (same width) to the
   * page's scrolled height first, so a long page is in one picture.
   */
  shot: (
    session: BrowserSession,
    name: string,
    options?: { fit?: boolean }
  ) => Promise<void>
}

type ApiLog = (
  method: string,
  route: string,
  user: number | null,
  body?: unknown
) => Promise<{ status: number; body: any }>

const stages: Record<string, (run: Run) => Promise<void>> = {
  apiRoles,
  api,
  roster,
  people,
  player,
  guardian,
  follower,
  home
}

/**
 * Assistant equals Coach, Scorekeeper includes Songkeeper, and only the
 * roster managers (admin, coach, assistant, scorekeeper) read a full name.
 */
async function apiRoles(run: Run): Promise<void> {
  const { f } = run
  const { people } = f
  const api = run.api('api-roles.log')
  const [avery, ben] = f.players

  const settings = await api(
    'PUT',
    `/teams/${f.teamA}/players/${avery.id}/settings`,
    people.assistant,
    { jersey: '8', positions: ['SS', 'CF'] }
  )
  expect(settings.status).equals(200)
  expect(settings.body).deep.include({ jersey: '8', positions: ['SS', 'CF'] })

  const song = await api(
    'PUT',
    `/teams/${f.teamA}/players/${ben.id}/walk-up-song`,
    people.scorekeeper,
    {
      provider: 'appleMusic',
      providerId: '1000000001',
      isrc: null,
      title: 'Demo Walk-up',
      artist: 'Demo Band',
      album: null,
      artworkUrl: null,
      durationMs: 180000,
      startMs: 30000,
      endMs: 45000
    }
  )
  expect(song.status).equals(200)
  expect(song.body).deep.include({ title: 'Demo Walk-up' })

  const hidden = await api('GET', `/players/${avery.id}/name`, people.follower)
  expect(hidden.status).equals(404)
  for (const reader of [people.scorekeeper, people.assistant]) {
    const shown = await api('GET', `/players/${avery.id}/name`, reader)
    expect(shown.status).equals(200)
    expect(shown.body).deep.include({ firstName: 'Avery', lastName: 'Stone' })
  }

  const assistant = await api('GET', '/me/roles', people.assistant)
  expect(assistant.status).equals(200)
  expect(assistant.body.teams[f.teamA]).deep.equals(['assistant'])
  const scorekeeper = await api('GET', '/me/roles', people.scorekeeper)
  expect(scorekeeper.body.teams[f.teamA]).deep.equals([
    'scorekeeper',
    'songkeeper'
  ])
  const admin = await api('GET', '/me/roles', people.admin)
  expect(admin.body.teams[f.teamA]).includes('assistant')
}

/**
 * The non-member view through the API: a follower, somebody signed in who
 * follows nothing, nobody signed in, and a member each read every route the
 * non-member view touches. The two signed in who are not members read the
 * same answers, following or not. Long answers are cut to the fields that
 * show what is given and what is withheld.
 */
async function api(run: Run): Promise<void> {
  const { f } = run
  const { people } = f
  const [game] = f.games
  // The Hawks compete in Demo Regular, so the season has a table.
  await f.h.db
    .insertInto('season_teams')
    .values({ season_id: f.seasonA, team_id: f.teamA, joined_at: new Date() })
    .execute()
  await f.h.db
    .updateTable('games')
    .set({
      linescore: JSON.stringify({
        away: { runs: [1, 0, 2], r: 3, h: 6, e: 2, bb: 1, k: 4, hr: 0, hbp: 1 },
        home: { runs: [2, 1, 3], r: 6, h: 9, e: 0, bb: 3, k: 2, hr: 1, hbp: 0 }
      })
    })
    .where('id', '=', game.id)
    .execute()
  await f.h.db
    .updateTable('users')
    .set({ avatar_path: 'avatars/avery' })
    .where('id', '=', f.players[0].id)
    .execute()

  const call = run.api('api-follower.log', nonMemberSummary)
  const routes = [
    `/teams/${f.teamA}`,
    `/teams/${f.teamA}/roster`,
    `/teams/${f.teamA}/games`,
    `/teams/${f.teamA}/stats`,
    `/teams/${f.teamA}/stats?kind=pitching`,
    `/seasons/${f.seasonA}/standings`,
    `/games/${game.id}`,
    `/games/${game.id}/box-score`,
    `/videos/${game.videoId}/highlights`,
    `/videos/${game.videoId}/playback`,
    // A second whose still the fixture keeps, so a member's answer is the still.
    `/videos/${game.videoId}/still?t=${posterSecond(7200)}`
  ]
  const expected: Record<string, number[]> = {
    // follower, stranger, nobody, member
    [routes[0]]: [200, 200, 200, 200],
    [routes[1]]: [200, 200, 401, 200],
    [routes[2]]: [200, 200, 401, 200],
    [routes[3]]: [403, 403, 401, 200],
    [routes[4]]: [403, 403, 401, 200],
    [routes[5]]: [200, 200, 401, 200],
    [routes[6]]: [200, 200, 401, 200],
    [routes[7]]: [403, 403, 401, 200],
    [routes[8]]: [200, 200, 401, 200],
    [routes[9]]: [403, 403, 401, 200],
    [routes[10]]: [403, 403, 401, 200]
  }
  const users = [people.follower, people.oneTeam, null, people.teamCoach]
  for (const [at, user] of users.entries()) {
    for (const route of routes) {
      const answer = await call('GET', route, user)
      expect(answer.status, `${route} as ${user}`).equals(expected[route][at])
      if (answer.status === 403)
        expect(answer.body).deep.equals({
          code: 'membersOnly',
          message: 'You need to be a member of one of the teams to see this.'
        })
      // The follower and the stranger, the two signed in who are not members.
      const outside = at < 2
      if (route === routes[0]) expect(answer.body.nonMemberView).equals(outside)
      if (route === routes[6] && answer.status === 200) {
        expect(answer.body.nonMemberView).equals(outside)
        expect(answer.body.linescore.home.h).equals(outside ? null : 9)
      }
      if (route === routes[1] && answer.status === 200) {
        const avery = (
          answer.body as Array<{ userId: number; avatarUrl: string | null }>
        ).find(row => row.userId === f.players[0].id)
        expect(avery?.avatarUrl == null).equals(outside)
      }
    }
  }
}

/**
 * What the non-member log keeps of an answer: the fields that show what a
 * non-member is given and what is withheld, not every row in full.
 */
function nonMemberSummary(route: string, body: any): unknown {
  if (body == null || typeof body !== 'object') return body
  if (/^\/teams\/[^/]+$/.test(route))
    return {
      group: { id: body.group?.id, name: body.group?.name },
      canViewPrivate: body.canViewPrivate,
      canManage: body.canManage,
      nonMemberView: body.nonMemberView,
      '…': 'parents, children, staff and games left out'
    }
  if (route.endsWith('/roster'))
    return (body as any[]).map(row => ({
      shortName: row.shortName,
      section: row.section,
      jersey: row.jersey,
      avatarUrl: row.avatarUrl == null ? null : '<signed picture URL>'
    }))
  if (route.endsWith('/games'))
    return (body as any[]).map(row => ({
      id: row.id,
      homeTeamName: row.homeTeamName,
      awayTeamName: row.awayTeamName,
      homeScore: row.homeScore,
      awayScore: row.awayScore,
      videoCount: row.videoCount,
      posterUrl: row.posterUrl == null ? null : '<signed poster URL>'
    }))
  if (route.endsWith('/standings'))
    return (body as any[]).map(row => ({
      teamName: row.teamName,
      w: row.w,
      l: row.l
    }))
  if (/^\/games\/[^/]+$/.test(route))
    return {
      id: body.id,
      homeTeamName: body.homeTeamName,
      awayTeamName: body.awayTeamName,
      homeScore: body.homeScore,
      awayScore: body.awayScore,
      homeRecord: body.homeRecord,
      awayRecord: body.awayRecord,
      homeLogoUrl: body.homeLogoUrl,
      awayLogoUrl: body.awayLogoUrl,
      canScore: body.canScore,
      canDj: body.canDj,
      nonMemberView: body.nonMemberView,
      linescore: body.linescore,
      videos: (body.videos as any[]).map(video => ({
        id: video.id,
        posterUrl: video.posterUrl == null ? null : '<signed poster URL>'
      }))
    }
  if (route.endsWith('/box-score'))
    return {
      batting: `${body.batting.length} lines`,
      pitching: `${body.pitching.length} lines`,
      stats: body.stats
    }
  if (route.endsWith('/stats') || route.includes('/stats?'))
    return Array.isArray(body) ? `${body.length} lines` : body
  if (route.endsWith('/highlights'))
    return {
      withheld: body.withheld,
      highlights: (body.highlights as any[]).map(highlight => ({
        title: highlight.title,
        stillUrl: highlight.stillUrl.replace(/\?t=.*$/, '?t=<token>')
      }))
    }
  if (route.endsWith('/playback'))
    return { ...body, url: body.url == null ? null : '<signed playlist URL>' }
  return body
}

/**
 * The roster in six sections, and a coach's roles from their profile: the
 * admin opens the team's roster, where every row opens (a player's page,
 * anybody else's profile), then Ichiro's profile, and adds Scorekeeper there
 * at once. Spectators holds a member of the team, then a member of its
 * league and one of its season, each pilled with the level; Followers holds
 * the two who follow the team.
 */
async function roster(run: Run): Promise<void> {
  const { f } = run
  const { people } = f
  // Somebody on the team who neither plays nor helps: Hank Moss joins the
  // Hawks with no role.
  await f.h.db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      user_id: people.oneTeam,
      team_id: f.teamA,
      role: 'member',
      is_player: false
    })
    .execute()
  // A member of Demo Regular and one of Demo League A, each a member of the
  // Hawks through it, and a second follower beside Grace Hill.
  const adult = async (
    id: number,
    first: string,
    last: string
  ): Promise<void> => {
    await f.h.db
      .insertInto('users')
      .values({
        id,
        legacyId: `usr_guardian_${id}`,
        display_name: `${first} ${last}`,
        first_name: first,
        last_name: last
      })
      .execute()
  }
  await adult(270, 'Sadie', 'Lake')
  await f.h.db
    .insertInto('season_members')
    .values({ id: makeId('seasonMember'), user_id: 270, season_id: f.seasonA })
    .execute()
  await adult(271, 'Leo', 'Grant')
  await f.h.db
    .insertInto('league_members')
    .values({ id: makeId('leagueMember'), user_id: 271, league_id: f.leagueA })
    .execute()
  await adult(272, 'Fern', 'Ash')
  await f.h.db
    .insertInto('follows')
    .values({ user_id: 272, group_type: 'team', group_id: f.teamA })
    .execute()

  const admin = await run.signIn('roster-admin', people.admin)
  await admin.m.openBrowser({ url: `${f.h.origin}/teams/${f.teamA}?tab=team` })
  const { contains } = await import('../test/refinementsMaestro.e2e')
  await contains(admin.page, 'FOLLOWERS')

  // No `??` or `?.` inside a callback the browser runs: Sucrase compiles
  // them to helpers the browser does not have.
  const page =
    (await admin.page.evaluate(() => document.body.textContent)) ?? ''
  const headings = [
    'ADMINS',
    'STAFF',
    'PLAYERS',
    'FAMILY MEMBERS',
    'SPECTATORS',
    'FOLLOWERS'
  ].map(heading => ({ heading, at: page.indexOf(heading) }))
  for (const { heading, at } of headings) expect(at, heading).gte(0)
  expect(headings.map(({ at }) => at)).deep.equals(
    headings.map(({ at }) => at).sort((a, b) => a - b)
  )
  expect(page).not.includes('COACHES')
  expect(page).not.includes('OTHER MEMBERS')
  // Each row's text, by its name, and whether it is a button: the row around
  // the name's own text.
  const rows = (
    await admin.page.evaluate(() =>
      [...document.querySelectorAll('div, span')]
        .filter(node => node.children.length === 0)
        .map(node => {
          const found = node.parentElement
          const row = found === null ? null : found.parentElement
          return {
            name: node.textContent,
            text: row === null ? '' : row.textContent,
            button: row !== null && row.getAttribute('role') === 'button'
          }
        })
    )
  ).map(({ name, text, button }) => ({
    name: name ?? '',
    text: text ?? '',
    button
  }))
  const found = (name: string): { text: string; button: boolean } => {
    const match = rows.find(each => each.name === name)
    expect(match, name).not.equals(undefined)
    return match!
  }
  const row = (name: string): string => found(name).text
  expect(row('Mike T')).includes('Season coach')
  expect(row('Babe R')).includes('League admin')
  expect(row('Owen P')).includes('Assistant')
  expect(row('Nora Q')).includes('Scorekeeper')
  expect(row('Ichiro')).includes('Coach')
  expect(row('Ichiro')).not.includes('Season')
  expect(row('Avery S')).includes('SS · 2B')
  expect(row('Avery S')).includes('#7')
  expect(row('Tim R')).not.includes('#')
  expect(row('Hank M')).not.includes('#')
  expect(row('Sadie L')).includes('Season spectator')
  expect(row('Leo G')).includes('League spectator')
  // The team's own spectator and the followers carry no pill.
  for (const name of ['Hank M', 'Grace H', 'Fern A'])
    expect(row(name), name).not.match(/Season|League/)
  // For the team's admin every row opens, with a chevron: a player's page,
  // and staff, family, spectators and followers their profile.
  for (const name of [
    'Babe R',
    'Mike T',
    'Owen P',
    'Nora Q',
    'Ichiro',
    'Tim R',
    'Hank M',
    'Leo G',
    'Sadie L',
    'Fern A',
    'Grace H',
    'Avery S',
    'Ben C',
    'Cody D',
    'Drew E',
    'Eli F'
  ]) {
    expect(found(name).button, name).equals(true)
    expect(row(name), name).includes('chevron_right')
  }
  // In its section's order: the team's own staff, then the season's coach.
  expect(page.indexOf('Owen P')).lessThan(page.indexOf('Mike T'))
  expect(page.indexOf('Mike T')).lessThan(page.indexOf('PLAYERS'))
  expect(page.indexOf('Tim R')).greaterThan(page.indexOf('FAMILY MEMBERS'))
  // The team's own spectator, then the league's and the season's by name,
  // then the followers by name.
  expect(page.indexOf('Hank M')).greaterThan(page.indexOf('SPECTATORS'))
  expect(page.indexOf('Hank M')).lessThan(page.indexOf('Leo G'))
  expect(page.indexOf('Leo G')).lessThan(page.indexOf('Sadie L'))
  expect(page.indexOf('Sadie L')).lessThan(page.indexOf('FOLLOWERS'))
  expect(page.indexOf('FOLLOWERS')).lessThan(page.indexOf('Fern A'))
  expect(page.indexOf('Fern A')).lessThan(page.indexOf('Grace H'))
  await run.shot(admin, 'roster-after.png', { fit: true })
  // The place and the gear share the card's right-hand column without
  // touching, and "Demo Hawks" keeps its words whole, on this phone and on a
  // narrow one.
  expect(await cardColumn(admin, WIDTH)).deep.equals({
    parts: ['1st Place', 'settings'],
    overlaps: [],
    brokenWords: []
  })
  expect(await cardColumn(admin, 320)).deep.equals({
    parts: ['1st Place', 'settings'],
    overlaps: [],
    brokenWords: []
  })
  await writeFile(
    join(run.artifacts, 'roster-header-narrow.png'),
    await admin.page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: 320, height: 240 }
    })
  )
  await admin.page.setViewport({
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1
  })

  // Ichiro's row opens his profile from the team, where his team roles
  // change at once.
  await admin.m.openBrowser({ url: `${f.h.origin}/teams/${f.teamA}?tab=team` })
  await contains(admin.page, 'Ichiro')
  await admin.page.evaluate(() => {
    const name = [...document.querySelectorAll('div, span')].find(
      node => node.children.length === 0 && node.textContent === 'Ichiro'
    )
    if (name === undefined) throw new Error('No Ichiro')
    name.scrollIntoView({ block: 'center' })
  })
  await admin.m.tapOn({ text: 'Ichiro', timeout: 15000 })
  await contains(admin.page, 'Team · Demo Hawks')
  expect(new URL(admin.page.url()).pathname).equals(
    `/teams/${f.teamA}/people/${people.teamCoach}`
  )
  expect(await heldRows(admin, 'team')).deep.include({
    coach: 'On',
    scorekeeper: 'Off',
    songkeeper: 'Off',
    admin: 'Off',
    follower: 'Not following'
  })
  await pressRole(admin, 'team', 'scorekeeper')
  await admin.page.waitForFunction(
    () => {
      const row = document.querySelector(
        '[data-testid="role-team-scorekeeper"]'
      )
      return (
        row !== null &&
        row.querySelector('[role="switch"][aria-checked="true"]') !== null
      )
    },
    { timeout: 15000 }
  )
  // The rows that used to be the roles sheet, after Scorekeeper was added:
  // the sheet is gone, and this is where a coach's roles change now.
  await scrollTo(admin, '[data-testid="roles-team"]')
  await run.shot(admin, 'roles-modal-after.png')
  let held: string[] = []
  for (let tries = 0; tries < 50; tries++) {
    held = (
      await f.h.db
        .selectFrom('scope_roles')
        .select('role')
        .where('user_id', '=', people.teamCoach)
        .where('scope_type', '=', 'team')
        .where('scope_id', '=', f.teamA)
        .execute()
    )
      .map(({ role }) => role)
      .sort()
    if (held.includes('scorekeeper')) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  expect(held).deep.equals(['coach', 'scorekeeper'])
}

/**
 * The person profile in Chromium, and the people API behind it.
 *
 * The admin adds Grace Hill, who only follows the Hawks, as their Coach from
 * her profile and takes it away again; Ichiro, their coach, opens Tim
 * Raines's profile, with Avery under "Parent/Guardian of", and has no Admin
 * buttons; the admin opens Tim from Demo Regular, where the season's roles
 * change and the league's are for reading; a player who can sign in has
 * Team roles at the bottom of Settings, where one who cannot has none; and
 * the admin takes the first off the team from below them, back to a roster
 * without him. Then, by the API alone: an add by address that applies at once, the
 * notification it leaves, leaving, a coach refused Admin, and the season's
 * people.
 */
async function people(run: Run): Promise<void> {
  const { f } = run
  const { people } = f
  const { contains } = await import('../test/refinementsMaestro.e2e')
  const [, ben, cody] = f.players
  // Ben can sign in; Cody cannot.
  await f.h.db
    .updateTable('users')
    .set({ login_enabled: true })
    .where('id', '=', ben.id)
    .execute()
  await f.h.db
    .insertInto('user_emails')
    .values({
      id: 'email_people_ben',
      user_id: ben.id,
      email: 'ben@example.com',
      is_primary: true,
      verified_at: new Date(),
      source: 'manual'
    })
    .execute()
  const roleRows = async (userId: number): Promise<string[]> =>
    (
      await f.h.db
        .selectFrom('scope_roles')
        .select('role')
        .where('user_id', '=', userId)
        .where('scope_type', '=', 'team')
        .where('scope_id', '=', f.teamA)
        .execute()
    )
      .map(({ role }) => role)
      .sort()
  const until = async (check: () => Promise<boolean>): Promise<void> => {
    for (let tries = 0; tries < 50; tries++) {
      if (await check()) return
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('Never happened')
  }

  // The admin adds Grace as Coach from her profile, and takes it away.
  const admin = await run.signIn('people-admin', people.admin)
  await admin.m.openBrowser({
    url: `${f.h.origin}/teams/${f.teamA}/people/${people.follower}`
  })
  await contains(admin.page, 'Grace Hill')
  await contains(admin.page, 'Team · Demo Hawks')
  expect(await heldRows(admin, 'team')).deep.include({
    admin: 'Off',
    coach: 'Off',
    member: 'Off',
    follower: 'Following'
  })
  await pressRole(admin, 'team', 'coach')
  await until(async () => (await roleRows(people.follower)).includes('coach'))
  await admin.page.waitForFunction(
    () => {
      const row = document.querySelector('[data-testid="role-team-member"]')
      return (
        row !== null &&
        row.querySelector('[role="switch"][aria-checked="true"]') !== null
      )
    },
    { timeout: 15000 }
  )
  expect(await heldRows(admin, 'team')).deep.include({
    coach: 'On',
    member: 'On'
  })
  await pressRole(admin, 'team', 'coach')
  await until(async () => (await roleRows(people.follower)).length === 0)

  // Ichiro, the team's coach, opens Tim Raines: Avery under Parent/Guardian
  // of, his roles here changeable, Admin not.
  const coach = await run.signIn('people-coach', people.teamCoach)
  await coach.m.openBrowser({
    url: `${f.h.origin}/teams/${f.teamA}/people/${people.guardian}`
  })
  await contains(coach.page, 'Tim Raines')
  await contains(coach.page, 'PARENT/GUARDIAN OF')
  await contains(coach.page, 'Avery S')
  const coachView = await heldRows(coach, 'team')
  expect(coachView.admin).equals('—')
  expect(coachView.coach).equals('Off')
  for (const level of ['season', 'league'])
    expect(
      Object.values(await heldRows(coach, level)).some(
        value => value === 'On' || value === 'Off'
      ),
      level
    ).equals(false)
  await run.shot(coach, 'person-profile-team.png', { fit: true })
  // Avery's row opens Avery, on the Hawks.
  await coach.m.tapOn({ text: 'Avery S', timeout: 15000 })
  await coach.page.waitForFunction(
    () => location.pathname.startsWith('/players/'),
    { timeout: 15000 }
  )
  expect(new URL(coach.page.url()).searchParams.get('onTeam')).equals(f.teamA)

  // The same person from the season: its roles change, the league's don't.
  await admin.m.openBrowser({
    url: `${f.h.origin}/seasons/${f.seasonA}/people/${people.guardian}`
  })
  await contains(admin.page, 'Season · Demo Regular')
  await contains(admin.page, 'Avery S')
  const page =
    (await admin.page.evaluate(() => document.body.textContent)) ?? ''
  expect(page).includes('SEASON ROLES')
  expect(page).includes('LEAGUE ROLES')
  expect(page).not.includes('TEAM ROLES')
  expect((await heldRows(admin, 'season')).admin).equals('Off')
  expect((await heldRows(admin, 'league')).admin).equals('—')
  await run.shot(admin, 'person-profile-season.png', { fit: true })

  // A player who can sign in has Team roles at the bottom of Settings.
  await admin.m.openBrowser({
    url: `${f.h.origin}/players/${ben.id}?tab=settings&onTeam=${f.teamA}`
  })
  await contains(admin.page, 'TEAM ROLES')
  await scrollTo(admin, '[data-testid="playerTeamRoles"]')
  await pressRole(admin, 'team', 'songkeeper')
  await until(async () => (await roleRows(ben.id)).includes('songkeeper'))
  await admin.page.waitForFunction(
    () => {
      const row = document.querySelector('[data-testid="role-team-songkeeper"]')
      return (
        row !== null &&
        row.querySelector('[role="switch"][aria-checked="true"]') !== null
      )
    },
    { timeout: 15000 }
  )
  await run.shot(admin, 'player-roles-settings.png', { fit: true })
  // One who cannot sign in has none.
  await admin.m.openBrowser({
    url: `${f.h.origin}/players/${cody.id}?tab=settings&onTeam=${f.teamA}`
  })
  await contains(admin.page, 'JERSEY NUMBER')
  await settle(admin)
  expect(
    (await admin.page.evaluate(() => document.body.textContent)) ?? ''
  ).not.includes('TEAM ROLES')

  // The admin takes Ben, who can sign in and is a songkeeper now, off the
  // Hawks from the very bottom of his Settings: after the sheet, the roster,
  // without him, and every team role gone with him.
  await admin.m.openBrowser({
    url: `${f.h.origin}/players/${ben.id}?tab=settings&onTeam=${f.teamA}`
  })
  await contains(admin.page, 'TEAM ROLES')
  await settle(admin)
  await scrollTap(admin, 'Remove from Demo Hawks')
  await contains(
    admin.page,
    'Ben C leaves Demo Hawks: off the roster, and every role they hold on it.'
  )
  await admin.m.tapOn({ css: '[aria-label="Remove Ben C"]', timeout: 15000 })
  await admin.page.waitForFunction(
    teamId => location.pathname === '/teams/' + teamId,
    { timeout: 15000 },
    f.teamA
  )
  const onHawks = async (userId: number): Promise<boolean> =>
    (await f.h.db
      .selectFrom('memberships')
      .select('id')
      .where('team_id', '=', f.teamA)
      .where('user_id', '=', userId)
      .executeTakeFirst()) != null
  await until(async () => !(await onHawks(ben.id)))
  expect(await roleRows(ben.id)).deep.equals([])
  await contains(admin.page, 'Removed Ben C from Demo Hawks')
  await contains(admin.page, 'Avery S')
  const rosterNames = await admin.page.evaluate(() => {
    const roster = document.querySelector('[data-testid="teamTabContent"]')
    if (roster === null) throw new Error('No roster')
    return [...roster.querySelectorAll('div, span')]
      .filter(node => node.children.length === 0)
      .map(node => String(node.textContent))
  })
  expect(rosterNames).includes('Avery S')
  expect(rosterNames).includes('Cody D')
  expect(rosterNames).not.includes('Ben C')
  await run.shot(admin, 'player-remove-from-team.png', { fit: true })

  // By the API: adding an account by address applies at once, tells them,
  // and they can leave; a coach is refused Admin; the season's people.
  const api = run.api('api-people.log', (route, body) => {
    if (route.endsWith('/people') && Array.isArray(body?.people))
      return body.people.map(
        (person: any) =>
          `${person.section} ${person.shortName}${person.inheritedFrom == null ? '' : ` (${person.inheritedFrom.level} ${person.inheritedFrom.role})`}`
      )
    if (route.startsWith('/me/notifications') && Array.isArray(body?.items))
      return body.items.map((item: any) => ({
        type: item.type,
        title: item.title,
        viewed: item.viewed,
        leave: item.leave
      }))
    return body
  })
  await run.note(
    'api-people.log',
    'The admin adds Hank Moss, who has an account, as Scorekeeper of Demo Hawks by his address: no invitation.'
  )
  const added = await api(
    'POST',
    `/manage/team/${f.teamA}/people`,
    people.admin,
    {
      email: f.emails[people.oneTeam],
      flags: ['scorekeeper'],
      idempotencyKey: 'people-stage-add-hank'
    }
  )
  expect(added.status).equals(201)
  expect(added.body.added).equals(true)
  expect(await roleRows(people.oneTeam)).deep.equals(['scorekeeper'])
  const told = await api('GET', '/me/notifications', people.oneTeam)
  expect(told.body.hasPending).equals(true)
  const grant = told.body.items.find((item: any) => item.type === 'grant')
  expect(grant.title).equals('Babe Ruth added you as Scorekeeper of Demo Hawks')
  expect(grant.leave).deep.equals({
    kind: 'team',
    id: f.teamA,
    name: 'Demo Hawks'
  })
  await run.note('api-people.log', 'Hank leaves the Hawks himself.')
  const left = await api('DELETE', `/me/groups/team/${f.teamA}`, people.oneTeam)
  expect(left.body).deep.equals({ removed: true })
  expect(await roleRows(people.oneTeam)).deep.equals([])
  await run.note(
    'api-people.log',
    'Ichiro, coach of the Hawks, may give Grace Hill any role but Admin.'
  )
  const refused = await api(
    'PUT',
    `/manage/team/${f.teamA}/people/${people.follower}/roles/admin`,
    people.teamCoach,
    {}
  )
  expect(refused.status).equals(403)
  const given = await api(
    'PUT',
    `/manage/team/${f.teamA}/people/${people.follower}/roles/videographer`,
    people.teamCoach,
    {}
  )
  expect(given.body).deep.equals({
    userId: people.follower,
    roles: ['videographer'],
    member: true
  })
  await run.note('api-people.log', 'Grace steps down as videographer.')
  const down = await api(
    'DELETE',
    `/me/groups/team/${f.teamA}/roles/videographer`,
    people.follower
  )
  expect(down.body.roles).deep.equals([])
  await run.note('api-people.log', "Demo Regular's people, by section.")
  const season = await api('GET', `/seasons/${f.seasonA}/people`, people.admin)
  expect(season.status).equals(200)
  expect(season.body.manages).equals(true)
}

/**
 * The Player screen opened from a team: the team's coach opens a player from
 * the roster and finds Videos and Stats narrowed to that team, a filter pill
 * over the videos, a Teams tab, and Settings holding only the jersey and
 * positions. The player's guardian reads the Teams tab with every team the
 * child plays on, newest first.
 */
async function player(run: Run): Promise<void> {
  const { f } = run
  const { people } = f
  const [avery] = f.players
  const db = f.h.db
  const { contains } = await import('../test/refinementsMaestro.e2e')

  // A season on each of Avery's teams, so the Teams tab has an order to
  // show: Demo Regular is this year's, Demo Playoffs (the Comets') next
  // year's.
  await db
    .updateTable('seasons')
    .set({ year: 2026 })
    .where('id', '=', f.seasonA)
    .execute()
  await db
    .insertInto('season_teams')
    .values({
      season_id: f.playoffs,
      team_id: f.secondTeam,
      joined_at: new Date()
    })
    .execute()
  // A Hawks game outside any season, with one highlight of Avery's, so a
  // season narrows the Hawks' videos. Stat lines for Avery in all three, so
  // the filter has Demo Regular to offer.
  const extra = {
    id: 'guardian-game-3',
    videoId: 'vid_guardian_3',
    startAt: new Date('2026-10-03T18:00:00Z')
  }
  await db
    .insertInto('games')
    .values({
      id: extra.id,
      home_team_id: f.teamA,
      away_team_id: f.standaloneTeam,
      season_id: null,
      start_at: extra.startAt,
      venue: 'Demo Field',
      status: 'final',
      home_score: 4,
      away_score: 1,
      timezone: 'UTC'
    })
    .execute()
  await db
    .insertInto('videos')
    .values({
      id: extra.videoId,
      game_id: extra.id,
      kind: 'program',
      title: 'Demo game video',
      storage: 'spaces',
      status: 'ready',
      start_at: extra.startAt,
      duration_sec: 7200
    })
    .execute()
  const at = new Date(extra.startAt.getTime() + 30 * 60_000).toISOString()
  await db
    .insertInto('events')
    .values({
      id: 'evt_guardian_guardian-game-3_0',
      gameId: extra.id,
      startTime: at,
      battingTeamId: f.teamA,
      gumbo: {
        about: {
          atBatIndex: 0,
          inning: 1,
          halfInning: 'bottom',
          isScoringPlay: false,
          startTime: at
        },
        result: { eventType: 'double', awayScore: 0, homeScore: 0 },
        credits: [
          {
            eventType: 'double',
            label: 'Double: Avery S',
            teamId: f.teamA,
            creditUserId: avery.id,
            credit: { name: 'Avery S', role: 'batter', position: null }
          }
        ]
      }
    })
    .execute()
  for (const gameId of [...f.games.map(game => game.id), extra.id])
    await db
      .insertInto('game_player_stats')
      .values({
        id: makeId('gamePlayerStats'),
        game_id: gameId,
        gumbo_id: avery.id,
        team_id: f.teamA,
        pa: 4,
        ab: 4,
        h: 1,
        singles: 1
      })
      .execute()
  // The new video's stills, as the fixture keeps the others'.
  const still = f.h.objects.get(
    `/${f.h.space.bucket}/${stillKey(f.games[0].videoId, posterSecond(7200))}`
  )
  if (still == null) throw new Error('The fixture kept no poster')
  f.h.objects.set(
    `/${f.h.space.bucket}/${stillKey(extra.videoId, posterSecond(7200))}`,
    still
  )
  const answer = await f.h.request(
    'GET',
    `/videos/${extra.videoId}/highlights`,
    undefined,
    people.siteAdmin
  )
  const { highlights } = (await answer.json()) as {
    highlights: Array<{ stillUrl: string }>
  }
  expect(highlights).has.length(1)
  for (const highlight of highlights) {
    const second = /\/stills\/(\d+)\.jpg/.exec(highlight.stillUrl)
    if (second == null) throw new Error(`No still in ${highlight.stillUrl}`)
    f.h.objects.set(
      `/${f.h.space.bucket}/${stillKey(extra.videoId, Number(second[1]))}`,
      still
    )
  }

  /** The tab labels in the bar, in order. */
  const tabNames = async (session: BrowserSession): Promise<string[]> =>
    (
      await session.page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '[aria-label="Player sections"] [role="tab"]'
          )
        ].map(node => node.textContent)
      )
    ).map(name => name ?? '')
  /** The highlight rows' labels: `Demo Hawks Double, <when>`. */
  const highlightRows = async (session: BrowserSession): Promise<string[]> =>
    (
      await session.page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '[role="button"][aria-label^="Demo Hawks "]'
          )
        ].map(node => node.getAttribute('aria-label'))
      )
    ).map(label => label ?? '')
  /** The Teams tab's rows, top to bottom, as their text reads. */
  const teamRows = async (session: BrowserSession): Promise<string[]> =>
    (
      await session.page.evaluate(() =>
        [...document.querySelectorAll('[role="button"]')]
          .map(node => node.textContent)
          .filter(text => text !== null && /^D(H|C)Demo /.test(text))
      )
    ).map(text => text ?? '')
  const pill = async (session: BrowserSession): Promise<string> =>
    (await session.page.evaluate(() => {
      const node = document.querySelector('[aria-label="Filter videos"]')
      return node === null ? null : node.textContent
    })) ?? ''

  // The coach opens Avery from the roster.
  const coach = await run.signIn('player-coach', people.teamCoach)
  await coach.m.openBrowser({ url: `${f.h.origin}/teams/${f.teamA}?tab=team` })
  await contains(coach.page, 'PLAYERS')
  await coach.m.tapOn({ css: '[aria-label^="Avery S"]', timeout: 15000 })
  await coach.page.waitForSelector('[aria-label="Filter videos"]', {
    timeout: 20000
  })
  await contains(coach.page, 'Home run')
  const opened = new URL(coach.page.url())
  expect(opened.pathname).equals(`/players/${avery.id}`)
  expect(opened.search).equals(`?onTeam=${f.teamA}`)
  expect(await tabNames(coach)).deep.equals(['Videos', 'Stats', 'Teams'])
  // Narrowed to the Hawks: the pill says so, and every row is a Hawks play,
  // the season's four and the game outside it.
  expect(await pill(coach)).includes('Demo Hawks')
  const hawks = await highlightRows(coach)
  expect(hawks).has.length(5)
  expect(hawks.filter(label => label.includes('Oct 3, 2026'))).has.length(1)
  await run.shot(coach, 'player-team-after.png')

  // A season narrows the list to its games.
  await coach.m.tapOn({ css: '[aria-label="Filter videos"]', timeout: 15000 })
  await contains(coach.page, 'Which games?')
  // The choice reads "Demo Regular" over its year, so it is found by its
  // text rather than by an accessible name of its own.
  await coach.page.evaluate(() => {
    const choice = [...document.querySelectorAll('[role="radio"]')].find(
      node => {
        const text = node.textContent
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- Sucrase would compile `?.` to a helper the browser does not have.
        return text !== null && text.startsWith('Demo Regular')
      }
    )
    if (choice === undefined) throw new Error('No Demo Regular choice')
    ;(choice as HTMLElement).click()
  })
  await coach.m.tapOn({ text: 'Show these', role: 'button', timeout: 15000 })
  await coach.page.waitForFunction(
    () =>
      document.querySelectorAll('[role="button"][aria-label^="Demo Hawks "]')
        .length === 4,
    { timeout: 20000 }
  )
  const regular = await highlightRows(coach)
  expect(regular).has.length(4)
  expect(regular.filter(label => label.includes('Oct 3, 2026'))).deep.equals([])
  expect(await pill(coach)).includes('Demo Regular')
  expect(new URL(coach.page.url()).searchParams.get('vseason')).equals(
    f.seasonA
  )

  // Teams: only the teams the coach can see, each once with Avery's number
  // there; the game outside any season adds no second Hawks row.
  await coach.m.tapOn({ text: 'Teams', role: 'tab', timeout: 15000 })
  await contains(coach.page, 'Demo Regular')
  expect(await teamRows(coach)).deep.equals([
    'DHDemo HawksDemo Regular · SS · 2B#7chevron_right'
  ])
  expect(new URL(coach.page.url()).searchParams.get('tab')).equals('teams')

  // Settings beside the team: the name a roster manager may correct, the
  // jersey and positions, and no hands.
  await coach.m.tapOn({
    text: 'Player settings',
    role: 'button',
    timeout: 15000
  })
  await coach.page.waitForSelector('input[aria-label="Jersey number"]', {
    timeout: 20000
  })
  // No `??` or `?.` in here: see `roster`.
  const form = await coach.page.evaluate(() => ({
    name: [
      document.querySelector<HTMLInputElement>(
        'input[aria-label="First name"]'
      )!.value,
      document.querySelector<HTMLInputElement>('input[aria-label="Last name"]')!
        .value
    ],
    jersey: document.querySelector<HTMLInputElement>(
      'input[aria-label="Jersey number"]'
    )!.value,
    on: [...document.querySelectorAll('[role="checkbox"]')]
      .filter(node => node.getAttribute('aria-checked') === 'true')
      .map(node => node.getAttribute('aria-label')),
    hands: document.querySelectorAll('[role="radio"]').length,
    text: document.body.textContent
  }))
  expect(form.name).deep.equals(['Avery', 'Stone'])
  expect(form.jersey).equals('7')
  expect(form.on).deep.equals(['2B', 'SS'])
  expect(form.hands).equals(0)
  expect(form.text).not.includes('BATS')
  expect(form.text).not.includes('THROWS')
  await run.shot(coach, 'player-settings-team-after.png')

  // The guardian sees every team Avery plays on, newest season first.
  const guardian = await run.signIn('player-guardian', people.guardian)
  await guardian.m.openBrowser({
    url: `${f.h.origin}/players/${avery.id}?tab=teams&onTeam=${f.teamA}`
  })
  await contains(guardian.page, 'Demo Comets')
  expect(await tabNames(guardian)).deep.equals([
    'Videos',
    'Stats',
    'Walk-up',
    'Teams'
  ])
  expect(await teamRows(guardian)).deep.equals([
    'DCDemo CometsDemo Playoffs · P#9chevron_right',
    'DHDemo HawksDemo Regular · SS · 2B#7chevron_right'
  ])
  await run.shot(guardian, 'player-teams-tab.png')
}

/**
 * Guardians in the app. The coach invites the first guardian of Cody, who
 * has none, by address from Settings; once Cody has one, the coach's
 * Settings offers no invitation and the API refuses the team's. Tim, Avery's
 * guardian, invites a second guardian from Avery's Settings; the invitee
 * accepts in their notifications, opens Avery from the team and saves the
 * jersey and positions, and finds the walk-up song they set. Avery leaves
 * the Comets and the guardian loses that team. A member who is a stranger to
 * Ben asks to be his guardian and Ben, whose account signs in, approves. One
 * user is stopped at a sixth waiting request; another, after three declined
 * by Avery's guardian and by the coach of two players with none, is told the
 * date they may ask again, and on that date may.
 */
async function guardian(run: Run): Promise<void> {
  const { f } = run
  const { people } = f
  const db = f.h.db
  const [avery, ben, cody, drew, eli] = f.players
  const { contains, fill, tap } = await import('../test/refinementsMaestro.e2e')
  const summarize = (route: string, body: any): unknown => {
    if (route === '/teams')
      return (body as any[]).map(team => ({ id: team.id, name: team.name }))
    if (route.endsWith('/roster'))
      return (body as any[])
        .filter(row => row.userId === avery.id)
        .map(row => ({
          shortName: row.shortName,
          jersey: row.jersey,
          positions: row.positions
        }))
    if (/^\/teams\/[^/]+$/.test(route))
      return {
        name: body.group?.name,
        canViewPrivate: body.canViewPrivate
      }
    if (route.startsWith('/me/notifications'))
      return (body.items as any[]).map(item => ({
        type: item.type,
        title: item.title,
        status: item.status
      }))
    return body
  }
  const api = run.api('api-guardian.log', summarize)

  // The people this stage needs, each signing in with an address: Faye, who
  // is invited; Gil and Ivy, members of the Hawks who ask; and Ben's own
  // account. Hank, who runs another team, joins the Hawks without a role.
  // Finn is a sixth Hawk, so Gil has a sixth player to ask about.
  const signsIn = async (id: number, email: string): Promise<void> => {
    await db
      .updateTable('users')
      .set({ login_enabled: true })
      .where('id', '=', id)
      .execute()
    await db
      .insertInto('user_emails')
      .values({
        id: `email_guardian_stage_${id}`,
        user_id: id,
        email,
        is_primary: true,
        verified_at: new Date(),
        source: 'manual'
      })
      .execute()
    f.emails[id] = email
    f.h.tokens.set(id, (await createSession(db, id, 'guardian')).token)
  }
  const person = async (
    id: number,
    first: string,
    last: string,
    email: string | null
  ): Promise<void> => {
    await db
      .insertInto('users')
      .values({
        id,
        legacyId: `usr_guardian_stage_${id}`,
        display_name: `${first} ${last}`,
        first_name: first,
        last_name: last,
        login_enabled: false
      })
      .execute()
    if (email != null) await signsIn(id, email)
  }
  const joinsHawks = async (
    id: number,
    player?: { jersey: string; positions: string[] }
  ): Promise<void> => {
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: id,
        team_id: f.teamA,
        role: 'member',
        is_player: player != null,
        jersey: player?.jersey ?? null,
        positions: player?.positions ?? []
      })
      .execute()
  }
  const invitee = 211
  const asker = 212
  const declined = 213
  const first = 214
  const finn = 206
  await person(invitee, 'Faye', 'Grant', 'invitee@example.com')
  await person(asker, 'Gil', 'Hart', 'asker@example.com')
  await person(declined, 'Ivy', 'Jones', 'declined@example.com')
  await person(first, 'Jade', 'Kim', 'first@example.com')
  await person(finn, 'Finn', 'Gray', null)
  await signsIn(ben.id, 'player@example.com')
  for (const id of [people.oneTeam, asker, declined]) await joinsHawks(id)
  await joinsHawks(finn, { jersey: '31', positions: ['RF'] })

  /** The guardian links to a player, by guardian. */
  const guardiansOf = async (playerId: number): Promise<number[]> =>
    (
      await db
        .selectFrom('user_links')
        .select('user_id')
        .where('related_user_id', '=', playerId)
        .where('kind', '=', 'guardian')
        .orderBy('user_id')
        .execute()
    ).map(row => Number(row.user_id))
  /** Guardian requests a user sent for themselves, by status. */
  const requestsBy = async (
    sender: number,
    status: 'pending' | 'declined'
  ): Promise<Array<{ id: string; player: number }>> =>
    (
      await db
        .selectFrom('group_requests')
        .select(['id', 'terms'])
        .where('sender_id', '=', sender)
        .where('kind', '=', 'guardian')
        .where('status', '=', status)
        .orderBy('sent_at')
        .execute()
    ).map(row => ({
      id: row.id,
      player: Number((row.terms as { playerUserId: number }).playerUserId)
    }))
  /** Opens a player of the Hawks from the team's roster. */
  const openFromRoster = async (
    session: BrowserSession,
    rowLabel: string,
    playerId: number
  ): Promise<void> => {
    await session.m.openBrowser({
      url: `${f.h.origin}/teams/${f.teamA}?tab=team`
    })
    await contains(session.page, 'PLAYERS')
    await session.m.scrollUntilVisible({
      element: { css: `[aria-label^="${rowLabel}"]` },
      centerElement: true,
      timeout: 15000
    })
    await session.m.tapOn({
      css: `[aria-label^="${rowLabel}"]`,
      timeout: 15000
    })
    await session.page.waitForFunction(
      path => location.pathname === path,
      { timeout: 20000 },
      `/players/${playerId}`
    )
    await settle(session)
  }
  /** Asks to be the open player's guardian through the sheet. */
  const ask = async (session: BrowserSession, name: string): Promise<void> => {
    await contains(session.page, 'Request to be a guardian')
    await tap(session.m, 'Request to be a guardian')
    await contains(session.page, `Ask to be ${name}’s guardian?`)
    await tap(session.m, 'Send request')
  }
  /** The request button's label, or null when there is none. */
  const requestLabel = async (session: BrowserSession): Promise<string> =>
    (await session.page.evaluate(() => {
      const button = [...document.querySelectorAll('[role="button"]')].find(
        node =>
          node.textContent === 'Request to be a guardian' ||
          node.textContent === 'Guardian request sent'
      )
      return button === undefined ? null : button.textContent
    })) ?? ''
  /** Opens a player's Settings beside the Hawks, once its form is drawn. */
  const openSettings = async (
    session: BrowserSession,
    playerId: number
  ): Promise<void> => {
    await session.m.openBrowser({
      url: `${f.h.origin}/players/${playerId}?tab=settings&onTeam=${f.teamA}`
    })
    await session.page.waitForSelector('input[aria-label="Jersey number"]', {
      timeout: 20000
    })
    await settle(session)
  }
  const bodyText = async (session: BrowserSession): Promise<string> =>
    (await session.page.evaluate(() => document.body.textContent)) ?? ''

  // The coach invites the first guardian of Cody, who has none, from his
  // Settings beside the Hawks. Jade accepts.
  const coach = await run.signIn('guardian-coach', people.teamCoach)
  await openSettings(coach, cody.id)
  await contains(coach.page, 'Invite a guardian')
  await fill(coach.m, 'E-mail address', 'first@example.com')
  await scrollTap(coach, 'Send invitation')
  await contains(
    coach.page,
    'An invitation is on its way to first@example.com.'
  )
  const invited = await requestsBy(people.teamCoach, 'pending')
  expect(invited.map(row => row.player)).deep.equals([cody.id])
  expect(f.h.invitations.get('first@example.com')).deep.include({
    playerName: 'Cody D',
    teamName: 'Demo Hawks'
  })
  const sent = await api('GET', '/me/notifications?sent=1', people.teamCoach)
  expect(sent.body.items.map((item: any) => item.title)).deep.equals([
    'Be a guardian of Cody D'
  ])
  const jade = await api(
    'POST',
    `/relationship-requests/${invited[0].id}/accept`,
    first,
    { idempotencyKey: 'guardian-stage-first-accept' }
  )
  expect(jade.body.status).equals('accepted')
  expect(await guardiansOf(cody.id)).deep.equals([first])

  // Cody has a guardian now: the coach's Settings for him, as for Avery,
  // offers no invitation, and the team's is refused.
  for (const p of [cody, avery]) {
    await openSettings(coach, p.id)
    expect(await bodyText(coach), p.first).not.includes('Invite a guardian')
  }
  const refused = await api(
    'POST',
    '/relationship-requests',
    people.teamCoach,
    {
      kind: 'guardian',
      playerUserId: cody.id,
      guardian: { email: 'second.parent@example.com' },
      sender: { kind: 'team', id: f.teamA },
      idempotencyKey: 'guardian-stage-coach-again'
    }
  )
  expect(refused.status).equals(403)
  expect(refused.body.message).equals(
    'Cody D has a guardian already. Ask them to invite another guardian.'
  )

  // Tim, Avery's guardian, invites Faye from Avery's Settings beside the
  // Hawks, in his own name.
  const tim = await run.signIn('guardian-tim', people.guardian)
  await openSettings(tim, avery.id)
  await contains(tim.page, 'Invite a guardian')
  await fill(tim.m, 'E-mail address', 'invitee@example.com')
  await scrollTap(tim, 'Send invitation')
  await contains(
    tim.page,
    'An invitation is on its way to invitee@example.com.'
  )
  const byTim = await requestsBy(people.guardian, 'pending')
  expect(byTim.map(row => row.player)).deep.equals([avery.id])
  const mailed = f.h.invitations.get('invitee@example.com')
  expect(mailed).deep.include({
    playerName: 'Avery S',
    invitedBy: 'Tim Raines'
  })
  expect(mailed).not.has.property('teamName')
  const timSent = await api('GET', '/me/notifications?sent=1', people.guardian)
  expect(timSent.body.items.map((item: any) => item.title)).deep.equals([
    'Be a guardian of Avery S'
  ])
  const beforeTeams = await api('GET', '/teams', invitee)
  expect(beforeTeams.body).deep.equals([])

  // Faye accepts in her notifications.
  const faye = await run.signIn('guardian-invitee', invitee)
  await faye.m.openBrowser({ url: `${f.h.origin}/notifications` })
  await contains(faye.page, 'Be a guardian of Avery S')
  await contains(faye.page, 'Tim Raines invited you')
  await faye.m.tapOn({
    css: '[aria-label="Be a guardian of Avery S"]',
    timeout: 15000
  })
  await contains(faye.page, 'Accept invitation')
  await tap(faye.m, 'Accept invitation')
  await contains(faye.page, 'Accepted')
  expect(await guardiansOf(avery.id)).deep.equals([people.guardian, invitee])
  const inbox = await api('GET', '/me/notifications?history=1', invitee)
  expect(inbox.body.items[0]).deep.include({
    title: 'Be a guardian of Avery S',
    status: 'accepted'
  })
  const roles = await api('GET', '/me/roles', invitee)
  expect(roles.body.guardianOf).deep.equals([avery.id])
  const teams = await api('GET', '/teams', invitee)
  expect(teams.body.map((team: any) => team.id).sort()).deep.equals(
    [f.teamA, f.secondTeam].sort()
  )

  // She opens Avery from the Hawks and saves his number and positions.
  await openFromRoster(faye, 'Avery S', avery.id)
  await faye.m.tapOn({
    text: 'Player settings',
    role: 'button',
    timeout: 15000
  })
  await faye.page.waitForSelector('input[aria-label="Jersey number"]', {
    timeout: 20000
  })
  // A guardian manages the child, and may invite another guardian.
  expect(await bodyText(faye)).includes('Invite a guardian')
  await fill(faye.m, 'Jersey number', '17')
  await faye.m.tapOn({
    css: '[role="checkbox"][aria-label="2B"]',
    timeout: 15000
  })
  await faye.m.tapOn({
    css: '[role="checkbox"][aria-label="CF"]',
    timeout: 15000
  })
  await scrollTap(faye, 'Save')
  await contains(faye.page, 'Saved.')
  const saved = await db
    .selectFrom('memberships')
    .select(['jersey', 'positions'])
    .where('user_id', '=', avery.id)
    .where('team_id', '=', f.teamA)
    .executeTakeFirstOrThrow()
  expect(saved).deep.equals({ jersey: '17', positions: ['SS', 'CF'] })
  await run.shot(faye, 'guardian-settings-team.png')
  const roster = await api('GET', `/teams/${f.teamA}/roster`, invitee)
  expect(roster.body.find((row: any) => row.userId === avery.id)).deep.include({
    jersey: '17',
    positions: ['SS', 'CF']
  })

  // The web app has no song picker, so the song goes in through the API as
  // Faye; the Walk-up tab then shows it.
  const song = await api(
    'PUT',
    `/teams/${f.teamA}/players/${avery.id}/walk-up-song`,
    invitee,
    {
      provider: 'appleMusic',
      providerId: '1000000002',
      isrc: null,
      title: 'Demo Walk-up',
      artist: 'Demo Band',
      album: null,
      artworkUrl: null,
      durationMs: 180000,
      startMs: 30000,
      endMs: 45000
    }
  )
  expect(song.status).equals(200)
  await faye.m.tapOn({ text: 'Walk-up', role: 'tab', timeout: 15000 })
  await contains(faye.page, 'Demo Walk-up')
  await contains(faye.page, 'Demo Band')
  expect(new URL(faye.page.url()).searchParams.get('tab')).equals('walkup')
  await run.shot(faye, 'guardian-walkup.png')

  // Avery leaves the Comets, and Faye, who is there only through him, loses
  // the team.
  const comets = await api('GET', `/teams/${f.secondTeam}`, invitee)
  expect(comets.body.canViewPrivate).equals(true)
  const removed = await api(
    'DELETE',
    `/manage/team/${f.secondTeam}/people/${avery.id}`,
    people.admin
  )
  expect(removed.status).equals(200)
  expect(removed.body).deep.equals({ removed: true })
  const after = await api('GET', '/teams', invitee)
  expect(after.body.map((team: any) => team.id)).deep.equals([f.teamA])
  const gone = await api('GET', `/teams/${f.secondTeam}`, invitee)
  expect(gone.body.canViewPrivate).equals(false)

  // Hank, a member with no say over Ben, asks to be his guardian.
  const hank = await run.signIn('guardian-stranger', people.oneTeam)
  await openFromRoster(hank, 'Ben C', ben.id)
  await contains(hank.page, 'Request to be a guardian')
  await tap(hank.m, 'Request to be a guardian')
  await contains(hank.page, 'Ask to be Ben C’s guardian?')
  await contains(
    hank.page,
    'Ben C or a guardian of theirs decides, or a coach of one of their teams if they have no guardian.'
  )
  await run.shot(hank, 'guardian-request-sheet.png')
  await tap(hank.m, 'Send request')
  await contains(hank.page, 'Guardian request sent')
  expect(await requestLabel(hank)).equals('Guardian request sent')
  expect(
    await hank.page.evaluate(() => {
      const button = [...document.querySelectorAll('[role="button"]')].find(
        node => node.textContent === 'Guardian request sent'
      )
      return button === undefined ? null : button.getAttribute('aria-disabled')
    })
  ).equals('true')
  await run.shot(hank, 'guardian-request.png')
  const hanks = await requestsBy(people.oneTeam, 'pending')
  expect(hanks.map(row => row.player)).deep.equals([ben.id])

  // Ben signs in and approves.
  const benSession = await run.signIn('guardian-player', ben.id)
  await benSession.m.openBrowser({ url: `${f.h.origin}/notifications` })
  const asked = "Hank Moss asks to be Ben C's guardian"
  await contains(benSession.page, asked)
  await benSession.m.tapOn({ css: `[aria-label="${asked}"]`, timeout: 15000 })
  await tap(benSession.m, 'Accept invitation')
  await contains(benSession.page, 'Accepted')
  expect(await guardiansOf(ben.id)).deep.equals([people.oneTeam])
  const hankRoles = await api('GET', '/me/roles', people.oneTeam)
  expect(hankRoles.body.guardianOf).deep.equals([ben.id])

  // Gil has five requests waiting; the sixth, in the app, is refused.
  const limit =
    'You have 5 guardian requests waiting. Wait for an answer before asking again.'
  let retry = 0
  const request = async (user: number, playerId: number): Promise<any> =>
    await api('POST', '/relationship-requests', user, {
      kind: 'guardian',
      playerUserId: playerId,
      guardian: { userId: user },
      idempotencyKey: `guardian-stage-${user}-${++retry}`
    })
  for (const p of [avery, ben, cody, drew, eli]) {
    const answer = await request(asker, p.id)
    expect(answer.status, `Gil asks about ${p.first}`).equals(201)
  }
  const gil = await run.signIn('guardian-asker', asker)
  await openFromRoster(gil, 'Finn G', finn)
  await ask(gil, 'Finn G')
  await contains(gil.page, limit)
  expect(await requestLabel(gil)).equals('Request to be a guardian')
  await run.shot(gil, 'guardian-limit.png')
  const sixth = await request(asker, finn)
  expect(sixth.status).equals(429)
  expect(sixth.body).deep.include({ code: 'rateLimited', message: limit })
  expect(await requestsBy(asker, 'pending')).has.length(5)

  // Ivy has three requests declined, by those with a say: Tim for Avery,
  // and the coach for Drew and Finn, who have no guardian. The fourth is
  // refused until a week after the third decline.
  for (const [p, decider] of [
    [avery.id, people.guardian],
    [drew.id, people.teamCoach],
    [finn, people.teamCoach]
  ] as const) {
    const answer = await request(declined, p)
    expect(answer.status, `Ivy asks about ${p}`).equals(201)
    const decided = await api(
      'POST',
      `/relationship-requests/${answer.body.id}/decline`,
      decider,
      { idempotencyKey: `guardian-stage-decline-${++retry}` }
    )
    expect(decided.status).equals(200)
    expect(decided.body.status).equals('declined')
  }
  const retryOn = new Date(
    f.clock.now().getTime() + 7 * 24 * 3600 * 1000
  ).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  })
  const blocked = `Three guardian requests were declined. You can ask again on ${retryOn}.`
  const ivy = await run.signIn('guardian-declined', declined)
  await openFromRoster(ivy, 'Eli F', eli.id)
  await ask(ivy, 'Eli F')
  await contains(ivy.page, blocked)
  expect(await requestLabel(ivy)).equals('Request to be a guardian')
  await run.shot(ivy, 'guardian-blocked.png')
  const fourth = await request(declined, eli.id)
  expect(fourth.status).equals(429)
  expect(fourth.body).deep.include({ code: 'rateLimited', message: blocked })

  // A week on, the request is taken.
  f.advance(7 * 24 * 3600 * 1000)
  await run.note(
    'api-guardian.log',
    'The clock moves on 7 days (604800 s), to the end of the block.'
  )
  const taken = await request(declined, eli.id)
  expect(taken.status).equals(201)
  expect(taken.body.status).equals('pending')
  // In the app, asking again answers with the request already waiting: the
  // block is gone and no second request is made.
  await ivy.page.reload()
  await settle(ivy)
  expect(await requestLabel(ivy)).equals('Request to be a guardian')
  await ask(ivy, 'Eli F')
  await contains(ivy.page, 'Guardian request sent')
  expect(await bodyText(ivy)).not.includes(
    'Three guardian requests were declined'
  )
  expect(
    (await requestsBy(declined, 'pending')).map(row => row.player)
  ).deep.equals([eli.id])
  const ivySent = await api('GET', '/me/notifications?sent=1', declined)
  expect(ivySent.body.items).deep.equals([
    {
      ...ivySent.body.items[0],
      title: "Ivy Jones asks to be Eli F's guardian",
      status: 'pending'
    }
  ])
}

/**
 * The non-member view in the app. Grace Hill follows Demo Hawks and belongs
 * to neither team: she reads every name on the roster without a photo, the
 * season's performance, the schedule with its thumbnails, and on a game the
 * score, the records, the line score and the highlights' pictures. The rest
 * says it is for members, in the page's own text colour on the page, with no
 * empty player box, and the app never asks for what the server keeps for
 * members. A game nothing was recorded of says "No videos." with no player
 * box. Hank Moss, who follows nothing here, opens the Hawks from Search and
 * gets the same page, bar the Follow button.
 */
async function follower(run: Run): Promise<void> {
  const { f } = run
  const { people } = f
  const [game] = f.games
  const { contains, fill, tap } = await import('../test/refinementsMaestro.e2e')
  const membersOnly = 'You need to be a member of one of the teams to see this.'
  const videosMembersOnly =
    "You need to be a member of one of the teams to watch this game's videos."
  const boxMembersOnly =
    'You need to be a member of one of these teams to see individual player stats.'
  // As the `api` stage: the Hawks compete in Demo Regular, so the season has
  // a table and the games records; the first game has its innings and its
  // totals; and Avery has a photo, which a non-member is not sent.
  await f.h.db
    .insertInto('season_teams')
    .values({ season_id: f.seasonA, team_id: f.teamA, joined_at: new Date() })
    .execute()
  await f.h.db
    .updateTable('games')
    .set({
      linescore: JSON.stringify({
        away: { runs: [1, 0, 2], r: 3, h: 6, e: 2, bb: 1, k: 4, hr: 0, hbp: 1 },
        home: { runs: [2, 1, 3], r: 6, h: 9, e: 0, bb: 3, k: 2, hr: 1, hbp: 0 }
      })
    })
    .where('id', '=', game.id)
    .execute()
  await f.h.db
    .updateTable('users')
    .set({ avatar_path: 'avatars/avery' })
    .where('id', '=', f.players[0].id)
    .execute()

  const grace = await run.signIn('follower', people.follower)
  // Every request the page makes from here on, to show what it never asks.
  const requests: string[] = []
  grace.page.on('request', request => {
    requests.push(
      new URL(request.url()).pathname + new URL(request.url()).search
    )
  })
  const text = async (): Promise<string> =>
    (await grace.page.evaluate(() => document.body.textContent)) ?? ''
  const tab = async (name: string): Promise<void> => {
    await grace.m.tapOn({ text: name, role: 'tab', timeout: 15000 })
    await settle(grace)
  }
  /** Stills shown on the page that have loaded, by their signed paths. */
  const loadedStills = async (): Promise<string[]> =>
    await grace.page.evaluate(() =>
      [...document.querySelectorAll('img')]
        .filter(
          image =>
            image.src.includes('/stills/') &&
            image.complete &&
            image.naturalWidth > 0
        )
        .map(image => new URL(image.src).pathname)
    )
  /**
   * A notice's text colour and the colour painted behind it: the page's own
   * text on the page's own background, not a hint's grey, nor anything on a
   * player's black.
   */
  const readable = async (
    session: BrowserSession,
    words: string
  ): Promise<void> => {
    const seen = await session.page.evaluate(words => {
      const node = [...document.querySelectorAll('[role="alert"]')].find(
        item => item.textContent === words
      )
      if (node === undefined) throw new Error(`No notice: ${words}`)
      let paint: Element | null = node
      let background = ''
      while (paint !== null && background === '') {
        const painted = getComputedStyle(paint).backgroundColor
        if (painted !== 'rgba(0, 0, 0, 0)' && painted !== 'transparent')
          background = painted
        paint = paint.parentElement
      }
      return { color: getComputedStyle(node).color, background }
    }, words)
    expect(seen, words).deep.equals({
      color: 'rgb(26, 33, 22)',
      background: 'rgb(245, 247, 241)'
    })
  }
  /** Whether the player's box, which is black, is anywhere on the page. */
  const playerBox = async (session: BrowserSession): Promise<boolean> =>
    await session.page.evaluate(() =>
      [...document.querySelectorAll('div')].some(
        node => getComputedStyle(node).backgroundColor === 'rgb(0, 0, 0)'
      )
    )
  /** The bottom of a scrolled element, centred so no bar is over it. */
  const centre = async (css: string): Promise<void> => {
    await grace.page.evaluate(css => {
      const node = document.querySelector(css)
      if (node === null) throw new Error(`Nothing at ${css}`)
      node.scrollIntoView({ block: 'center' })
    }, css)
  }

  // The team: the members' page, every name, no photo, and no name opens.
  await grace.m.openBrowser({ url: `${f.h.origin}/teams/${f.teamA}?tab=team` })
  await contains(grace.page, 'PLAYERS')
  const roster = await text()
  for (const name of [
    'Babe R',
    'Ichiro',
    'Nora Q',
    'Owen P',
    'Mike T',
    'Avery S',
    'Ben C',
    'Cody D',
    'Drew E',
    'Eli F',
    'Tim R'
  ])
    expect(roster, name).includes(name)
  for (const heading of ['ADMINS', 'STAFF', 'PLAYERS', 'FAMILY MEMBERS'])
    expect(roster, heading).includes(heading)
  // Initials in every circle, and no picture of anybody.
  expect(roster).includes('ASAvery S')
  const pictures = await grace.page.evaluate(() =>
    [...document.querySelectorAll('img')].map(image => image.src)
  )
  expect(pictures.filter(src => src.includes('avatar'))).deep.equals([])
  // A player's page answers a non-member 404, so a name is not a button.
  expect(
    await grace.page.evaluate(
      () =>
        document.querySelectorAll('[role="button"][aria-label^="Avery S"]')
          .length
    )
  ).equals(0)
  expect(roster).not.includes('chevron_right')
  expect(roster).includes('Following')
  expect(roster).not.includes('Team membership is required')
  await run.shot(grace, 'follower-team-after.png', { fit: true })
  for (const width of [WIDTH, 320])
    expect(await cardColumn(grace, width), `${width} wide`).deep.equals({
      parts: ['1st Place', 'Following'],
      overlaps: [],
      brokenWords: []
    })
  await grace.page.setViewport({
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1
  })

  // Stats: the season's performance, and the players' figures kept back.
  await tab('Stats')
  await contains(grace.page, 'SEASON PERFORMANCE')
  await contains(grace.page, membersOnly)
  await readable(grace, membersOnly)
  const stats = await text()
  expect(stats).includes('2–0')
  expect(stats).not.includes('BATTING')
  expect(stats).not.includes('PITCHING')

  // Videos: the library is kept for members.
  await tab('Videos')
  await contains(grace.page, membersOnly)
  await readable(grace, membersOnly)
  expect(await text()).not.includes('GAME VIDEO LIBRARY')

  // Schedule: each game with its count and its thumbnail.
  await tab('Schedule')
  const card = `[role="button"][aria-label^="Demo Hawks vs Demo Visitors"]`
  await grace.page.waitForSelector(card, { timeout: 20000 })
  const schedule = await grace.page.evaluate(() =>
    [...document.querySelectorAll('[role="button"][aria-label]')]
      .map(node => node.getAttribute('aria-label'))
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- Sucrase would compile `?.` to a helper the browser does not have.
      .filter(label => label !== null && label.includes(' video'))
  )
  expect(schedule).has.length(2)
  for (const label of schedule) expect(label).includes('1 video')
  await grace.page.waitForFunction(
    () =>
      [...document.querySelectorAll('img')].filter(
        image =>
          image.src.includes('/stills/') &&
          image.complete &&
          image.naturalWidth > 0
      ).length >= 2,
    { timeout: 20000 }
  )
  const posters = await loadedStills()
  expect(posters.some(path => path.includes(game.videoId))).equals(true)
  await run.shot(grace, 'follower-schedule.png', { fit: true })

  // A game: the score and the records, and nothing counted under them.
  await centre(card)
  await grace.m.tapOn({ css: card, timeout: 15000 })
  await grace.page.waitForFunction(
    gameId => location.pathname === `/games/${gameId}`,
    { timeout: 20000 },
    game.id
  )
  await contains(grace.page, 'Highlights')
  await contains(grace.page, videosMembersOnly)
  await settle(grace)
  const hero = await grace.page.evaluate(() => {
    // The card: the smallest block holding both sides' notes.
    const blocks = [...document.querySelectorAll('div')].filter(node => {
      const words = node.textContent
      return (
        words !== null &&
        words.includes('Away · 0–1') &&
        words.includes('Home · 2–0')
      )
    })
    const row = blocks[blocks.length - 1]
    const card = row.parentElement
    if (card === null) throw new Error('No card')
    return {
      text: card.textContent,
      ruled: [...card.children].filter(
        child => getComputedStyle(child).borderTopWidth === '1px'
      ).length
    }
  })
  for (const words of ['Demo Visitors', 'Demo Hawks', '3', '6', 'FINAL'])
    expect(hero.text, words).includes(words)
  expect(hero.text).not.includes(' BB')
  expect(hero.text).not.includes('Def:')
  expect(hero.ruled).equals(0)
  expect(await grace.page.$('video')).equals(null)
  await run.shot(grace, 'follower-game-after.png')

  // Videos: the message where the video would be, readable and with no
  // empty player box, above the highlights, whose pictures load.
  expect(await playerBox(grace)).equals(false)
  await readable(grace, videosMembersOnly)
  const watch = await text()
  const firstPlay = watch.indexOf('Avery S')
  expect(firstPlay).greaterThan(0)
  expect(watch.indexOf(videosMembersOnly)).lessThan(firstPlay)
  expect(watch).not.includes('All angles')
  await grace.page.waitForFunction(
    () =>
      [...document.querySelectorAll('img')].filter(
        image =>
          image.src.includes('/stills/') &&
          image.complete &&
          image.naturalWidth > 0
      ).length >= 2,
    { timeout: 20000 }
  )
  const stills = await loadedStills()
  expect(stills.every(path => path.includes(game.videoId))).equals(true)
  // With no player box the card, the message and the list fit the screen
  // together, so nothing is scrolled.
  await run.shot(grace, 'follower-videos.png')

  // A highlight seeks nothing and links nothing; the message above says why,
  // and says it again under the highlight tapped, where they are looking.
  const play = await grace.page.evaluate(() => {
    const node = [...document.querySelectorAll('[tabindex="0"]')].find(item => {
      const words = item.textContent
      return (
        words !== null &&
        words.includes('Avery S') &&
        item.querySelector('img') !== null
      )
    })
    if (node === undefined) throw new Error('No highlight')
    node.scrollIntoView({ block: 'center' })
    return node.textContent
  })
  expect(play).includes('Avery S')
  await grace.page.evaluate(() => {
    const node = [...document.querySelectorAll('[tabindex="0"]')].find(item => {
      const words = item.textContent
      return (
        words !== null &&
        words.includes('Avery S') &&
        item.querySelector('img') !== null
      )
    })
    ;(node as HTMLElement).click()
  })
  await settle(grace)
  expect(
    await grace.page.evaluate(() =>
      [...document.querySelectorAll('[role="alert"]')].map(
        node => node.textContent
      )
    )
  ).deep.equals([videosMembersOnly, videosMembersOnly])
  expect(
    await grace.page.evaluate(() => {
      const repeated = document.querySelector(
        '[data-testid="highlightMembersOnly"]'
      )
      const tapped = repeated === null ? null : repeated.parentElement
      const words = tapped === null ? null : tapped.textContent
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- Sucrase would compile `?.` to a helper the browser does not have.
      return words !== null && words.includes('Avery S')
    })
  ).equals(true)
  expect(new URL(grace.page.url()).searchParams.get('t')).equals(null)
  expect(await grace.page.$('video')).equals(null)
  expect(await playerBox(grace)).equals(false)
  await run.shot(grace, 'follower-highlight.png')

  // Box score: the innings and the runs, then the message.
  await grace.page.evaluate(() => {
    window.scrollTo(0, 0)
  })
  await tab('Box score')
  await contains(grace.page, boxMembersOnly)
  await readable(grace, boxMembersOnly)
  const box = await text()
  const innings = box.indexOf('Demo Visitors1023')
  expect(innings, 'away line: 1 0 2 then 3').greaterThan(0)
  expect(box.indexOf('Demo Hawks2136')).greaterThan(innings)
  expect(box.indexOf(boxMembersOnly)).greaterThan(innings)
  expect(box).not.includes('Batting —')
  expect(box).not.includes('Pitching —')
  await run.shot(grace, 'follower-boxscore.png')

  // Nothing kept for members was asked for: no player stats, no box score,
  // no video and no still by the second.
  const asked = requests.filter(path => path.startsWith('/api/'))
  expect(asked.some(path => path.includes(`/games/${game.id}`))).equals(true)
  expect(asked.some(path => path.includes('/highlights'))).equals(true)
  expect(
    asked.filter(path =>
      /\/teams\/[^/]+\/stats|\/box-score|\/playback|\/still\?|\/players\//.test(
        path
      )
    )
  ).deep.equals([])

  // Hank follows nothing here and opens the Hawks from Search: the same page
  // Grace reads, bar the Follow button.
  const hank = await run.signIn('follower-search', people.oneTeam)
  await hank.m.openBrowser({ url: `${f.h.origin}/discover` })
  await tap(hank.m, 'Teams')
  await fill(hank.m, 'Search by name or city', 'Demo Hawks')
  // Two teams are called that here; the Hawks are the one in Demo League A,
  // whose row is named with its city.
  const hawks = '[role="button"][aria-label^="Open Demo Hawks, Demo City"]'
  await hank.page.waitForSelector(hawks, { timeout: 20000 })
  await hank.m.tapOn({ css: hawks, timeout: 15000 })
  await hank.page.waitForFunction(
    teamId => location.pathname.includes(teamId),
    { timeout: 20000 },
    f.teamA
  )
  await hank.m.tapOn({ text: 'Team', role: 'tab', timeout: 15000 })
  await contains(hank.page, 'PLAYERS')
  await settle(hank)
  const found =
    (await hank.page.evaluate(() => document.body.textContent)) ?? ''
  for (const name of ['Babe R', 'Ichiro', 'Avery S', 'Tim R'])
    expect(found, name).includes(name)
  for (const heading of ['ADMINS', 'STAFF', 'PLAYERS', 'FAMILY MEMBERS'])
    expect(found, heading).includes(heading)
  expect(found).includes('ASAvery S')
  expect(found).not.includes('Team membership is required')
  expect(found).not.includes('Standalone team')
  expect(
    (
      await hank.page.evaluate(() =>
        [...document.querySelectorAll('img')].map(image => image.src)
      )
    ).filter(src => src.includes('avatar'))
  ).deep.equals([])
  expect(
    await hank.page.$('[aria-label="Follow Demo Hawks"]'),
    'Follow, not Following'
  ).not.equals(null)
  await run.shot(hank, 'discover-team.png', { fit: true })
  await hank.m.tapOn({ text: 'Stats', role: 'tab', timeout: 15000 })
  await contains(hank.page, 'SEASON PERFORMANCE')
  await contains(hank.page, membersOnly)
  await readable(hank, membersOnly)

  // A game nothing was recorded of: "No videos.", and no player box. Added
  // last, so the team's record on every page above is the two games'.
  const unrecorded = 'guardian-game-unrecorded'
  await f.h.db
    .insertInto('games')
    .values({
      id: unrecorded,
      home_team_id: f.teamA,
      away_team_id: f.standaloneTeam,
      season_id: f.seasonA,
      start_at: new Date('2026-09-27T18:00:00Z'),
      venue: 'Demo Field',
      status: 'final',
      home_score: 4,
      away_score: 4,
      timezone: 'UTC'
    })
    .execute()
  await grace.m.openBrowser({ url: `${f.h.origin}/games/${unrecorded}` })
  await contains(grace.page, 'No videos.')
  await settle(grace)
  await readable(grace, 'No videos.')
  expect(await playerBox(grace)).equals(false)
  expect(await grace.page.$('video')).equals(null)
  expect(await text()).not.includes(videosMembersOnly)
  expect(await text()).not.includes('Highlights')
  await run.shot(grace, 'game-no-videos.png')
}

/**
 * Home. The guardian finds Avery under "Your Players", above "Your teams",
 * and a large card for each kind they have nothing in under the team
 * (`home-after.png`). Opened from there, Avery's page is his whole career,
 * its Teams tab still has the Comets he has left, and its Settings are how he
 * bats and throws, which the guardian saves. Hank Moss, with one team and
 * nothing else, gets a large card for each of the other two kinds under his
 * team (`home-one-team.png`, beside `home-before.png`).
 */
async function home(run: Run): Promise<void> {
  const { f } = run
  const { people } = f
  const [avery] = f.players
  const db = f.h.db
  const { contains } = await import('../test/refinementsMaestro.e2e')

  // A Comets game Avery played, so the team stays on his page after he
  // leaves it, and a stat line on each team for the career to add up.
  const comets = {
    id: 'guardian-game-comets',
    startAt: new Date('2026-09-27T18:00:00Z')
  }
  await db
    .insertInto('games')
    .values({
      id: comets.id,
      home_team_id: f.secondTeam,
      away_team_id: f.standaloneTeam,
      season_id: f.playoffs,
      start_at: comets.startAt,
      venue: 'Demo Field',
      status: 'final',
      home_score: 4,
      away_score: 1,
      timezone: 'UTC'
    })
    .execute()
  for (const [gameId, teamId, ab, h] of [
    [f.games[0].id, f.teamA, 4, 2],
    [comets.id, f.secondTeam, 3, 1]
  ] as const)
    await db
      .insertInto('game_player_stats')
      .values({
        id: makeId('gamePlayerStats'),
        game_id: gameId,
        gumbo_id: avery.id,
        team_id: teamId,
        pa: ab,
        ab,
        h,
        singles: h
      })
      .execute()
  // Avery leaves the Comets.
  const removed = await f.h.request(
    'DELETE',
    `/manage/team/${f.secondTeam}/people/${avery.id}`,
    undefined,
    people.admin
  )
  expect(removed.status).equals(200)

  /** The section titles and row labels, top to bottom. */
  const page = async (session: BrowserSession): Promise<string> =>
    (await session.page.evaluate(() => document.body.textContent)) ?? ''
  /** Each control named `title`, with the words in it. */
  const controls = async (
    session: BrowserSession,
    title: string
  ): Promise<string[]> =>
    (
      await session.page.evaluate(
        title =>
          [...document.querySelectorAll('[role="button"]')]
            .filter(node => node.getAttribute('aria-label') === title)
            .map(node => node.textContent),
        title
      )
    ).map(text => text ?? '')
  const tabNames = async (session: BrowserSession): Promise<string[]> =>
    (
      await session.page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '[aria-label="Player sections"] [role="tab"]'
          )
        ].map(node => node.textContent)
      )
    ).map(name => name ?? '')

  // The guardian's Home: Avery above the team he plays on.
  const guardian = await run.signIn('home-guardian', people.guardian)
  await guardian.m.openBrowser({ url: `${f.h.origin}/` })
  await contains(guardian.page, 'YOUR PLAYERS')
  const guardianHome = await page(guardian)
  /** Where each of `words` is, after the one before it. */
  const inOrder = (text: string, words: string[]): number[] => {
    const at: number[] = []
    for (const word of words) at.push(text.indexOf(word, at.at(-1) ?? 0))
    return at
  }
  const guardianOrder = inOrder(guardianHome, [
    'YOUR PLAYERS',
    'Avery S',
    'YOUR TEAMS',
    'Demo Hawks',
    'Create League',
    'Create an organization',
    'Create Season',
    'Create a season or tournament'
  ])
  expect(guardianOrder.every(at => at >= 0)).equals(true)
  // The Comets went with Avery; the kinds the guardian has nothing in are
  // large cards under the team.
  expect(guardianHome).not.includes('Demo Comets')
  expect((await controls(guardian, 'Create League'))[0]).includes(
    'Create an organization'
  )
  expect((await controls(guardian, 'Create Season'))[0]).includes(
    'Create a season or tournament'
  )
  await run.shot(guardian, 'home-after.png', { fit: true })

  // Opened from Home, Avery's page has no team: his whole career.
  await guardian.m.tapOn({ css: '[aria-label="Avery S"]', timeout: 15000 })
  await guardian.page.waitForSelector('[aria-label="Filter videos"]', {
    timeout: 20000
  })
  const opened = new URL(guardian.page.url())
  expect(opened.pathname).equals(`/players/${avery.id}`)
  expect(opened.search).equals('')
  expect(await tabNames(guardian)).deep.equals(['Videos', 'Stats', 'Teams'])
  await guardian.m.tapOn({ text: 'Stats', role: 'tab', timeout: 15000 })
  await contains(guardian.page, 'Career')
  await settle(guardian)
  const stats = await page(guardian)
  // Both teams' games: the Hawks' 4 at-bats and the Comets' 3.
  expect(stats).includes('2 games · Career')
  expect(stats).includes('PA7AB7H3AVG.429')

  // Teams: the Comets he has left are still on his page.
  await guardian.m.tapOn({ text: 'Teams', role: 'tab', timeout: 15000 })
  await contains(guardian.page, 'Demo Comets')
  const teamRows = (
    await guardian.page.evaluate(() =>
      [...document.querySelectorAll('[role="button"]')]
        .map(node => node.textContent)
        .filter(text => text !== null && /^D(H|C)Demo /.test(text))
    )
  ).map(text => text ?? '')
  expect(teamRows).deep.equals([
    'DCDemo CometsDemo Playoffschevron_right',
    'DHDemo HawksDemo Regular · SS · 2B#7chevron_right'
  ])

  // Settings from Home: how he bats and throws, nothing about a team.
  await guardian.m.tapOn({
    text: 'Player settings',
    role: 'button',
    timeout: 15000
  })
  await guardian.page.waitForSelector('[aria-label="Bats Switch"]', {
    timeout: 20000
  })
  // No `??` or `?.` in here: see `roster`.
  const form = await guardian.page.evaluate(() => ({
    jersey: document.querySelectorAll('input[aria-label="Jersey number"]')
      .length,
    positions: document.querySelectorAll('[role="checkbox"]').length,
    radios: [...document.querySelectorAll('[role="radio"]')].map(node =>
      node.getAttribute('aria-label')
    )
  }))
  expect(form.jersey).equals(0)
  expect(form.positions).equals(0)
  expect(form.radios).deep.equals([
    'Bats Right',
    'Bats Left',
    'Bats Switch',
    'Throws Right',
    'Throws Left'
  ])
  expect(new URL(guardian.page.url()).searchParams.get('tab')).equals(
    'settings'
  )
  await guardian.m.tapOn({ css: '[aria-label="Bats Switch"]', timeout: 15000 })
  await guardian.m.tapOn({ css: '[aria-label="Throws Left"]', timeout: 15000 })
  await scrollTap(guardian, 'Save')
  await contains(guardian.page, 'Saved.')
  const hands = await db
    .selectFrom('users')
    .select(['bats', 'throws', 'bats_source'])
    .where('id', '=', avery.id)
    .executeTakeFirstOrThrow()
  expect(hands).deep.equals({
    bats: 'switch',
    throws: 'left',
    bats_source: 'manual'
  })
  await run.shot(guardian, 'guardian-settings-home.png')

  // Hank Moss runs one team and nothing else: a large card for a league
  // and one for a season, under it.
  const hank = await run.signIn('home-one-team', people.oneTeam)
  await hank.m.openBrowser({ url: `${f.h.origin}/` })
  await contains(hank.page, 'YOUR TEAMS')
  await contains(hank.page, 'Create Season')
  const hankHome = await page(hank)
  expect(hankHome).not.includes('YOUR PLAYERS')
  expect(
    inOrder(hankHome, [
      'YOUR TEAMS',
      'Demo Rookies',
      'Create League',
      'Create Season'
    ]).every(at => at >= 0)
  ).equals(true)
  const league = await controls(hank, 'Create League')
  const season = await controls(hank, 'Create Season')
  expect(league).has.length(1)
  expect(league[0]).includes('Create an organization')
  expect(season).has.length(1)
  expect(season[0]).includes('Create a season or tournament')
  // The team he has keeps its own Create beside its title.
  expect(await controls(hank, 'Create Team')).deep.equals(['Create Team'])
  await run.shot(hank, 'home-one-team.png', { fit: true })
}

async function main(): Promise<void> {
  const artifacts = process.env.TS_GUARDIAN_ARTIFACTS
  if (artifacts == null || artifacts === '')
    throw new Error(
      'Set TS_GUARDIAN_ARTIFACTS to the directory for the screenshots and logs'
    )
  const wanted = process.env.TS_GUARDIAN_STAGE ?? 'all'
  const names = wanted === 'all' ? Object.keys(stages) : [wanted]
  for (const name of names)
    if (stages[name] == null)
      throw new Error(
        `Unknown TS_GUARDIAN_STAGE ${name}: one of ${Object.keys(stages).join(', ')} or all`
      )
  await mkdir(artifacts, { recursive: true })
  const web = resolve('dist')
  for (const name of names) {
    console.log(`stage ${name}`)
    await runStage(
      name,
      artifacts,
      existsSync(join(web, 'index.html')) ? web : undefined
    )
    console.log(`stage ${name} PASS`)
  }
}

async function runStage(
  name: string,
  artifacts: string,
  web: string | undefined
): Promise<void> {
  const f = await guardianFixture(web)
  const sessions: BrowserSession[] = []
  // Browser profiles are throwaway: kept out of the artifacts, removed after.
  let profiles: string | undefined
  let daemon: { shutdown: () => Promise<unknown> } | undefined
  // Read at the first request rather than now, so the people a stage adds
  // before it calls the API are named in its log too.
  let names: Map<number, string> | undefined
  const started = new Set<string>()
  /** A stage's log, emptied the first time the stage writes to it. */
  const logPath = async (file: string): Promise<string> => {
    const path = join(artifacts, file)
    if (!started.has(path)) {
      started.add(path)
      await writeFile(path, '')
    }
    return path
  }
  const run: Run = {
    f,
    artifacts,
    note: async (file, text) => {
      await appendFile(await logPath(file), `# ${text}\n\n`)
    },
    api: (file, summarize) => async (method, route, user, body) => {
      const path = await logPath(file)
      names ??= await userNames(f)
      const who = user == null ? 'nobody signed in' : (names.get(user) ?? user)
      const lines = [`$ ${method} /api/v1${route} as ${who}`]
      if (body !== undefined) lines.push(`> ${JSON.stringify(body)}`)
      const response = await f.h.request(method, route, body, user)
      const type = response.headers.get('content-type') ?? ''
      if (response.ok && !type.includes('json')) {
        // A still, after the redirect to it: its size and type, not its bytes.
        const bytes = (await response.arrayBuffer()).byteLength
        lines.push(
          String(response.status),
          `(${bytes} bytes of ${type}${response.redirected ? ', after a redirect' : ''})`,
          ''
        )
        await appendFile(path, lines.join('\n') + '\n')
        return { status: response.status, body: undefined }
      }
      const text = await response.text()
      const parsed: unknown = text === '' ? undefined : JSON.parse(text)
      const shown =
        text === ''
          ? '(no body)'
          : summarize == null || !response.ok
            ? text
            : oneLinePerField(summarize(route, parsed))
      lines.push(String(response.status), shown, '')
      await appendFile(path, lines.join('\n') + '\n')
      return { status: response.status, body: parsed }
    },
    browser: async device => {
      if (web == null) throw new Error('Run `node src/build.mjs` first')
      const maestroD = await import('../test/refinementsMaestro.e2e')
      if (daemon == null) {
        const daemonName = process.env.MAESTRO_D
        if (daemonName == null)
          throw new Error('Supply MAESTRO_D (an unused daemon name)')
        daemon = await maestroD.maestro(daemonName)
      }
      profiles ??= await mkdtemp(join(tmpdir(), 'guardianE2e-'))
      const session = await maestroD.browserSession(
        daemon as Parameters<typeof maestroD.browserSession>[0],
        `${device}-${Date.now().toString(36)}`,
        WIDTH,
        HEIGHT,
        profiles
      )
      sessions.push(session)
      return session
    },
    signIn: async (device, user) => {
      const { contains, fill, tap } =
        await import('../test/refinementsMaestro.e2e')
      const email = f.emails[user]
      if (email == null) throw new Error(`User ${user} has no sign-in address`)
      const session = await run.browser(device)
      await f.h.resetLimits()
      await session.m.openBrowser({ url: `${f.h.origin}/sign-in` })
      await fill(session.m, 'E-mail address', email)
      await tap(session.m, 'Send me a sign-in code')
      await contains(session.page, 'six-digit code')
      const code = f.h.mail.get(email)
      if (code == null) throw new Error(`No sign-in code for ${email}`)
      await fill(session.m, 'Sign-in code', code)
      await tap(session.m, 'Sign in')
      await session.page.waitForFunction(
        () => !location.pathname.startsWith('/sign-in'),
        { timeout: 20000 }
      )
      await settle(session)
      return session
    },
    shot: async (session, name, options = {}) => {
      const { capture } = await import('../test/refinementsMaestro.e2e')
      await settle(session)
      if (options.fit === true) {
        // The page scrolls inside the app, not the window: the tallest
        // scrolled box is how tall the page would be.
        const height = await session.page.evaluate(() =>
          Math.max(
            innerHeight,
            ...[...document.querySelectorAll('*')].map(node => {
              const style = getComputedStyle(node)
              return /(auto|scroll)/.test(style.overflowY)
                ? node.scrollHeight + (innerHeight - node.clientHeight)
                : 0
            })
          )
        )
        await session.page.setViewport({
          width: WIDTH,
          height: Math.min(height, 3 * HEIGHT),
          deviceScaleFactor: 1
        })
        await settle(session)
        await writeFile(
          join(artifacts, name),
          await session.page.screenshot({ type: 'png' })
        )
        await session.page.setViewport({
          width: WIDTH,
          height: HEIGHT,
          deviceScaleFactor: 1
        })
      } else {
        await capture(session.m, artifacts, name)
      }
      console.log(`captured ${join(artifacts, name)}`)
    }
  }
  try {
    await stages[name](run)
  } finally {
    for (const session of sessions) {
      await session.browser.disconnect().catch(() => undefined)
      await session.m.detach().catch(() => undefined)
    }
    await daemon?.shutdown().catch(() => undefined)
    await f.h.close()
    if (profiles != null) await rm(profiles, { recursive: true, force: true })
  }
}

/**
 * What each row of a person's roles at `level` offers: its toggle (`On`,
 * `Off`) or, with none, its status (`Yes`, `—`, `Following`).
 */
async function heldRows(
  session: BrowserSession,
  level: string
): Promise<Record<string, string>> {
  // No `??` or `?.` in here: see `roster`.
  return await session.page.evaluate(level => {
    const rows = [
      ...document.querySelectorAll(`[data-testid^="role-${level}-"]`)
    ]
    return Object.fromEntries(
      rows.map(row => {
        const id = row.getAttribute('data-testid')
        const toggle = row.querySelector('[role="switch"]')
        const label = row.children.length > 1 ? row.children[1] : null
        const shown =
          toggle !== null
            ? toggle.getAttribute('aria-checked') === 'true'
              ? 'On'
              : 'Off'
            : label === null
              ? ''
              : label.textContent
        /* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Sucrase would compile `??` to a helper the browser does not have. */
        return [
          (id === null ? '' : id).slice(`role-${level}-`.length),
          shown === null ? '' : shown
        ]
        /* eslint-enable @typescript-eslint/prefer-nullish-coalescing */
      })
    )
  }, level)
}

/** Scrolls the element `css` names to the middle of the screen. */
async function scrollTo(session: BrowserSession, css: string): Promise<void> {
  await session.page.evaluate(css => {
    const node = document.querySelector(css)
    if (node === null) throw new Error(`Nothing at ${css}`)
    node.scrollIntoView({ block: 'center' })
  }, css)
  await settle(session)
}

/** Presses the switch of one role's row, scrolled clear of the bottom bar. */
async function pressRole(
  session: BrowserSession,
  level: string,
  role: string
): Promise<void> {
  const css = `[data-testid="role-${level}-${role}"] [role="switch"]`
  await scrollTo(session, css)
  await session.m.tapOn({ css, timeout: 15000 })
}

/**
 * Taps a button by its text once it is scrolled clear of the bottom bar,
 * which otherwise covers the last button of a long form. Maestro's
 * `scrollUntilVisible` counts a covered button as visible, and a tap on it
 * then never returns, timeout or not.
 */
async function scrollTap(session: BrowserSession, text: string): Promise<void> {
  const { tap } = await import('../test/refinementsMaestro.e2e')
  await session.page.evaluate(text => {
    const button = [...document.querySelectorAll('[role="button"]')].find(
      node => node.textContent === text
    )
    if (button === undefined) throw new Error(`No ${text} button`)
    button.scrollIntoView({ block: 'center' })
  }, text)
  await tap(session.m, text)
}

/**
 * The team card's right-hand column at this width: what it holds, top to
 * bottom; which of those, and the team's name, overlap; and which words of
 * the name are broken across lines.
 */
async function cardColumn(
  session: BrowserSession,
  width: number
): Promise<{ parts: string[]; overlaps: string[]; brokenWords: string[] }> {
  await session.page.setViewport({
    width,
    height: HEIGHT,
    deviceScaleFactor: 1
  })
  await settle(session)
  // No `??` or `?.` in here: see `roster`.
  return await session.page.evaluate(() => {
    const end = document.querySelector('[data-testid="team-card-end"]')
    if (end === null) throw new Error('No team card column')
    const name = [...document.querySelectorAll('div')].find(
      node =>
        node.children.length === 0 &&
        node.textContent === 'Demo Hawks' &&
        node.getBoundingClientRect().top < end.getBoundingClientRect().bottom
    )
    if (name === undefined) throw new Error('No team name')
    const boxes = [
      { label: 'name', rect: name.getBoundingClientRect() },
      ...[...end.children].map(child => ({
        // An element's text is never null; only a document's is.
        label: String(child.textContent),
        rect: child.getBoundingClientRect()
      }))
    ]
    const overlaps: string[] = []
    boxes.forEach((a, i) => {
      for (const b of boxes.slice(i + 1)) {
        const x =
          Math.min(a.rect.right, b.rect.right) -
          Math.max(a.rect.left, b.rect.left)
        const y =
          Math.min(a.rect.bottom, b.rect.bottom) -
          Math.max(a.rect.top, b.rect.top)
        if (x > 0 && y > 0) overlaps.push(`${a.label} / ${b.label}`)
      }
    })
    const text = name.firstChild
    const brokenWords: string[] = []
    if (text !== null) {
      let at = 0
      for (const word of 'Demo Hawks'.split(' ')) {
        const range = document.createRange()
        range.setStart(text, at)
        range.setEnd(text, at + word.length)
        if (range.getClientRects().length > 1) brokenWords.push(word)
        at += word.length + 1
      }
    }
    return {
      parts: boxes.slice(1).map(box => box.label),
      overlaps,
      brokenWords
    }
  })
}

/** Waits until nothing says Loading and the network has gone quiet. */
async function settle(session: BrowserSession): Promise<void> {
  await session.page
    .waitForFunction(
      () => {
        const text = document.body.textContent
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- Sucrase would compile `?.` to a helper the browser does not have.
        return text === null || !text.includes('Loading')
      },
      { timeout: 20000 }
    )
    .catch(() => {
      console.log(`NOTE: still "Loading" at ${session.page.url()}`)
    })
  await session.page
    .waitForNetworkIdle({ idleTime: 750, timeout: 10000 })
    .catch(() => undefined)
}

/**
 * JSON with each row of a list, or each field of an object, on a line of its
 * own: short enough to read down, and every value still on show.
 */
function oneLinePerField(value: unknown): string {
  if (Array.isArray(value))
    return `[\n${value.map(item => `  ${JSON.stringify(item)}`).join(',\n')}\n]`
  if (value != null && typeof value === 'object')
    return `{\n${Object.entries(value)
      .map(([key, item]) => `  ${JSON.stringify(key)}: ${JSON.stringify(item)}`)
      .join(',\n')}\n}`
  return JSON.stringify(value)
}

/** `Owen Pratt (assistant)`, for the API logs. */
async function userNames(f: GuardianFixture): Promise<Map<number, string>> {
  const rows = await f.h.db
    .selectFrom('users')
    .select(['id', 'display_name'])
    .execute()
  const roles = new Map<number, string>(
    Object.entries(f.people).map(([role, id]) => [id, role])
  )
  return new Map(
    rows.map(row => {
      const role = roles.get(row.id)
      return [
        row.id,
        role == null ? row.display_name : `${row.display_name} (${role})`
      ]
    })
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
