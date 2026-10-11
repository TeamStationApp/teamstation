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
  player,
  guardian
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
 * The roster in six sections and the Assistant switch: the admin opens the
 * team's roster, then a coach's roles, and turns on Scorekeeper, which holds
 * Songkeeper on. Spectators holds a member of the team, then a member of its
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
  // Only a player's row opens anything, and only it has a chevron: staff,
  // family, spectators and followers have no page.
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
    'Grace H'
  ]) {
    expect(found(name).button, name).equals(false)
    expect(row(name), name).not.includes('chevron_right')
  }
  for (const name of ['Avery S', 'Ben C', 'Cody D', 'Drew E', 'Eli F']) {
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

  await admin.m.openBrowser({ url: `${f.h.origin}/teams/${f.teamA}/manage` })
  await contains(admin.page, 'Ichiro')
  await admin.m.scrollUntilVisible({
    element: { css: '[aria-label="Roles for Ichiro"]' },
    centerElement: true,
    timeout: 15000
  })
  await admin.m.tapOn({
    css: '[aria-label="Roles for Ichiro"]',
    timeout: 15000
  })
  await contains(admin.page, 'Same as a coach')
  const switches = async (): Promise<
    Record<string, { checked: boolean; disabled: boolean }>
  > =>
    await admin.page.evaluate(() =>
      Object.fromEntries(
        [
          'Team admin',
          'Coach',
          'Assistant',
          'Scorekeeper',
          'Songkeeper',
          'Videographer'
        ].map(label => {
          const input = document.querySelector<HTMLInputElement>(
            `input[aria-label="${label}"]`
          )
          return [
            label,
            input === null
              ? { checked: false, disabled: true }
              : { checked: input.checked, disabled: input.disabled }
          ]
        })
      )
    )
  const before = await switches()
  expect(before.Coach).deep.equals({ checked: true, disabled: false })
  expect(before.Assistant).deep.equals({ checked: false, disabled: false })
  expect(before.Songkeeper).deep.equals({ checked: false, disabled: false })

  await admin.m.tapOn({
    css: 'input[aria-label="Scorekeeper"]',
    timeout: 15000
  })
  await contains(admin.page, 'Scorekeepers can do this')
  const after = await switches()
  expect(after.Scorekeeper).deep.equals({ checked: true, disabled: false })
  expect(after.Songkeeper).deep.equals({ checked: true, disabled: true })
  await run.shot(admin, 'roles-modal-after.png')

  // Save sends what was set, not what Scorekeeper holds on.
  const { tap } = await import('../test/refinementsMaestro.e2e')
  await tap(admin.m, 'Save')
  await admin.page.waitForFunction(
    () => document.querySelector('input[aria-label="Scorekeeper"]') == null,
    { timeout: 15000 }
  )
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
        user_id: avery.id,
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
  expect(await tabNames(coach)).deep.equals([
    'Videos',
    'Stats',
    'Teams',
    'Settings'
  ])
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
  await coach.m.tapOn({ text: 'Settings', role: 'tab', timeout: 15000 })
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
    'Teams',
    'Settings'
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
  await faye.m.tapOn({ text: 'Settings', role: 'tab', timeout: 15000 })
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
  const blocked =
    'Three guardian requests were declined. You can ask again on October 13, 2026.'
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
