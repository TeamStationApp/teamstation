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

import { posterSecond } from '../server/media/posters'
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
  /** A signed-out maestro-d web session at the screenshot viewport. */
  browser: (device: string) => Promise<BrowserSession>
}

type ApiLog = (
  method: string,
  route: string,
  user: number | null,
  body?: unknown
) => Promise<{ status: number; body: any }>

const stages: Record<string, (run: Run) => Promise<void>> = {
  apiRoles,
  api
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
