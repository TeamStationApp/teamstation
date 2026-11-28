import { appendFileSync, writeFileSync } from 'node:fs'

import { expect } from 'chai'
import type { Kysely } from 'kysely'

import type { Database } from '../../../../src/server/db/database'
import type { FixtureManifest } from '../../../../src/server/dev/fixtures/accounts'
import { nodeDatabaseUrl } from '../../../core/dropletStack'
import { eventually } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import { apiToken } from '../../../rigs/media/recordingSeek'
import { stackHandle } from '../../../rigs/media/stackSpace'

/**
 * Scheduling a game whose opponent is TBD (#203), on the `tbd-opponent`
 * world: Create Game from a team page leaves Away as TBD and saves with no
 * team made (E1); Game Settings later assigns Herons to that side through
 * Herons' approval, keeping the game (E2); a season page leaves both sides
 * TBD, then names Home (E3); and, before this change, Save stays disabled
 * while Away is unchosen and the selector offers no TBD (E4, also run on the
 * base with `TS_TBD_OPPONENT_BASE=1`, where the TBD row is absent).
 *
 * Every scenario drives Chromium at the phone width the plan's pictures use.
 */

const PHONE = { width: 402, height: 874 }
const TBD = 'TBD'

/** The base commit, which has no TBD row: E4 run there for its before picture. */
const onBase = (): boolean => process.env.TS_TBD_OPPONENT_BASE === '1'

function onWeb(ctx: E2eContext): void {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
}

/** The 15th of next month: always ahead, and the same day for every run this month. */
function gameDate(now = new Date()): string {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15)
  )
  return next.toISOString().slice(0, 10)
}

interface World {
  world: FixtureManifest
  db: Kysely<Database>
}

async function seeded(ctx: E2eContext): Promise<World> {
  const world = await ctx.fixture('tbd-opponent')
  const { makeDatabase } = await import('../../../../src/server/db/database')
  const db = makeDatabase(nodeDatabaseUrl(stackHandle(ctx).databaseUrl))
  return { world, db }
}

/** A phone-width Chromium signed in as `role` through the password form. */
async function signedIn(ctx: E2eContext, role: string): Promise<WebSession> {
  const web = await ctx.browser(PHONE)
  await web.m.openLink({ link: ctx.stack.origin })
  await ctx.signIn(role, web.m)
  return web
}

async function bodyText(web: WebSession): Promise<string> {
  return await web.page.evaluate(() => document.body.innerText)
}

async function sees(
  web: WebSession,
  text: string,
  timeout = 30_000
): Promise<void> {
  await eventually(async () => {
    expect(await bodyText(web), `"${text}" on the page`).includes(text)
  }, timeout)
}

/** Opens `path` on the stack and waits for `title` as a heading. */
async function open(
  ctx: E2eContext,
  web: WebSession,
  path: string,
  title?: string
): Promise<void> {
  await web.m.openLink({ link: `${ctx.stack.origin}${path}` })
  if (title == null) return
  await eventually(async () => {
    const found = await web.page.evaluate(
      (wanted: string) =>
        [...document.querySelectorAll('[role="heading"],[aria-level]')].some(
          node => node.textContent === wanted
        ),
      title
    )
    expect(found, `the heading "${title}"`).equals(true)
  }, 30_000)
}

/** Taps the element at `css` once it is scrolled to the middle of the window. */
async function tapCss(web: WebSession, css: string): Promise<void> {
  await eventually(async () => {
    const present = await web.page.evaluate(
      (selector: string) => document.querySelector(selector) != null,
      css
    )
    expect(present, css).equals(true)
  }, 20_000)
  await web.m.evalBrowserScript({
    script: `const target = document.querySelector(${JSON.stringify(css)})
      if (target != null) target.scrollIntoView({ block: 'center' })`
  })
  await web.m.tapOn({ css, timeout: 15_000 })
}

const labelled = (label: string): string =>
  `[aria-label=${JSON.stringify(label)}]`

/** Taps the button reading `label`, once it is in the middle of the window. */
async function tapButton(web: WebSession, label: string): Promise<void> {
  await web.m.evalBrowserScript({
    script: `const target = [...document.querySelectorAll('[role="button"]')]
        .find(node => node.textContent === ${JSON.stringify(label)})
      if (target != null) target.scrollIntoView({ block: 'center' })`
  })
  await web.m.tapOn({ text: label, role: 'button', timeout: 15_000 })
}

/** Whether the button reading `label` is disabled. */
async function disabled(web: WebSession, label: string): Promise<boolean> {
  return await web.page.evaluate((wanted: string) => {
    const node = [...document.querySelectorAll('[role="button"]')].find(
      each => each.textContent === wanted
    )
    if (node == null) throw new Error(`no ${wanted} button`)
    return node.getAttribute('aria-disabled') === 'true'
  }, label)
}

/** Types `text` into the field labelled `label`, replacing what it held. */
async function fill(
  web: WebSession,
  label: string,
  text: string
): Promise<void> {
  const css = `input${labelled(label)}`
  await tapCss(web, css)
  await web.m.evalBrowserScript({
    script: `const input = document.querySelector(${JSON.stringify(css)}); input.focus(); input.select()`
  })
  await web.m.eraseText()
  await web.m.inputText({ text })
  await eventually(async () => {
    const value = await web.page.evaluate((selector: string) => {
      const input = document.querySelector<HTMLInputElement>(selector)
      return input == null ? '' : input.value
    }, css)
    expect(value).equals(text)
  }, 10_000)
}

/**
 * The scene scrolled to its top, so a picture frames its Home and Away rows
 * the same way on every run.
 */
async function toTop(web: WebSession): Promise<void> {
  await web.m.evalBrowserScript({
    script: `window.scrollTo(0, 0); for (const node of document.querySelectorAll('div')) if (node.scrollTop > 0) node.scrollTop = 0`
  })
  await eventually(async () => {
    const scrolled = await web.page.evaluate(() =>
      [...document.querySelectorAll('div')].some(node => node.scrollTop > 0)
    )
    expect(scrolled, 'scrolled to the top').equals(false)
  }, 10_000)
  await new Promise(resolve => setTimeout(resolve, 500))
}

/** The date `value`, a day of next month, in the scene's date picker. */
async function chooseDate(web: WebSession, value: string): Promise<void> {
  await tapCss(web, '[data-testid="event-schedule-date"]')
  await tapCss(web, labelled('Next month'))
  await tapCss(web, labelled(`Choose ${value}`))
  await tapButton(web, 'Use date')
}

/** 6:30 PM, on the time picker's wheels. */
async function chooseTime(web: WebSession): Promise<void> {
  await tapCss(web, '[data-testid="event-schedule-time"]')
  for (const [column, option, index] of [
    ['hour', 6, 5],
    ['minute', 30, 6],
    ['period', 1, 1]
  ] as const) {
    await web.m.evalBrowserScript({
      script: `document.querySelector('[data-testid="event-time-${column}-wheel"]').scrollTo({top:${index * 44},behavior:'instant'})`
    })
    await web.m.assertVisible({
      id: `event-time-${column}-${option}`,
      timeout: 5000
    })
    await web.m.tapOn({ id: `event-time-${column}-${option}` })
  }
  await tapButton(web, 'Use time')
}

/** The world's one field, from the registry. */
async function chooseField(
  web: WebSession,
  world: FixtureManifest
): Promise<void> {
  await tapCss(web, labelled('Field: none chosen'))
  await fill(web, 'Search venues', world.ids.venueName)
  await tapCss(
    web,
    `[aria-label^=${JSON.stringify(`${world.ids.venueName},`)}]`
  )
  await tapCss(web, '[aria-label^="Field 1"]')
  await eventually(async () => {
    expect(await bodyText(web)).includes(`${world.ids.venueName} · Field 1`)
  }, 15_000)
}

/** The date, time and field every scenario's game has. */
async function details(web: WebSession, world: FixtureManifest): Promise<void> {
  await chooseDate(web, gameDate())
  await chooseTime(web)
  await chooseField(web, world)
}

/** Opens the side's row in the scene, and waits for its team selector. */
async function openSide(web: WebSession, rowLabel: string): Promise<void> {
  await tapCss(web, `[aria-label^=${JSON.stringify(rowLabel)}]`)
  await tapCss(web, '[data-testid="team-selector"]')
}

/** The selector's TBD row, which leaves the side open. */
async function chooseTbd(web: WebSession): Promise<void> {
  await tapCss(web, '[data-testid="team-tbd"]')
  await eventually(async () => {
    const closed = await web.page.evaluate(
      () => document.querySelector('[data-testid="team-selector"]') == null
    )
    expect(closed, 'the selector closed').equals(true)
  }, 15_000)
}

/** A team found by name in the selector's search. */
async function chooseTeam(
  web: WebSession,
  name: string,
  id: string
): Promise<void> {
  await fill(web, 'Search all teams', name)
  await tapCss(web, `[data-testid="team-result-${id}"]`)
  await eventually(async () => {
    const closed = await web.page.evaluate(
      () => document.querySelector('[data-testid="team-selector"]') == null
    )
    expect(closed, 'the selector closed').equals(true)
  }, 15_000)
}

/** Saves the scene, and returns the game it landed on, from the page's address. */
async function saveToGame(web: WebSession, notice: string): Promise<string> {
  await tapButton(web, 'Save')
  await sees(web, notice)
  let gameId = ''
  await eventually(async () => {
    const path = new URL(web.page.url()).pathname
    const match = /^\/games\/([^/]+)$/.exec(path)
    expect(match, `a game page, not ${path}`).not.equals(null)
    gameId = decodeURIComponent(match![1])
  }, 30_000)
  return gameId
}

async function teamCount(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('teams')
    .select(eb => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow()
  return Number(row.count)
}

async function sides(
  db: Kysely<Database>,
  gameId: string
): Promise<{ home: string | null; away: string | null }> {
  const row = await db
    .selectFrom('games')
    .select(['home_team_id', 'away_team_id'])
    .where('id', '=', gameId)
    .executeTakeFirstOrThrow()
  return { home: row.home_team_id, away: row.away_team_id }
}

/**
 * A `$ …` log of what a scenario asked the server, each request as the curl
 * that would make it and its answer. The bearer token is never written.
 */
class RequestLog {
  constructor(private readonly path: string) {
    writeFileSync(path, '')
  }

  write(command: string, output: unknown): void {
    appendFileSync(
      this.path,
      `$ ${command}\n${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}\n\n`
    )
  }

  /** Logs every game proposal the page posts, with its answer. */
  watch(web: WebSession, api: string): void {
    web.page.on('response', response => {
      const request = response.request()
      if (
        request.method() !== 'POST' ||
        !response.url().includes('/game-requests')
      )
        return
      ;(async () => {
        const answer = await response.text().catch(() => '<unavailable>')
        const posted =
          (await request.fetchPostData().catch(() => undefined)) ?? ''
        const path = new URL(response.url()).pathname.replace(/^\/api\/v1/, '')
        this.write(
          `curl -X POST "${api}${path}" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '${posted}'`,
          `${response.status()} ${answer}`
        )
      })().catch(() => undefined)
    })
  }

  async get(api: string, token: string, path: string): Promise<unknown> {
    const response = await fetch(`${api}${path}`, {
      headers: { authorization: `Bearer ${token}` }
    })
    const body: unknown = await response.json()
    this.write(
      `curl "${api}${path}" -H "Authorization: Bearer $TOKEN"`,
      `${response.status} ${JSON.stringify(body, null, 2)}`
    )
    return body
  }
}

/** Create Game from the Ravens page with Away left as TBD, through to its game page. */
async function ravensGameWithAwayTbd(
  ctx: E2eContext,
  web: WebSession,
  world: FixtureManifest,
  shot?: string
): Promise<string> {
  const { ravens, ravensName } = world.ids
  await open(
    ctx,
    web,
    `/groups/team/${encodeURIComponent(ravens)}/create-game`,
    'Create Game'
  )
  await details(web, world)
  await openSide(web, 'Choose Away Team')
  await chooseTbd(web)
  await sees(web, 'Away · Team to be decided')
  expect(await disabled(web, 'Save'), 'Save with Away TBD').equals(false)
  if (shot != null) {
    await toTop(web)
    await web.m.takeScreenshot({ path: ctx.artifact(shot) })
  }
  return await saveToGame(web, `Game scheduled: ${ravensName} vs ${TBD}`)
}

/**
 * E4: with Away unchosen Save stays disabled and nothing is scheduled; the
 * Away selector lists the TBD row on the branch, and none on the base.
 */
async function beforeCreate(ctx: E2eContext): Promise<void> {
  onWeb(ctx)
  const { world, db } = await seeded(ctx)
  try {
    const web = await signedIn(ctx, 'ravensCoach')
    await open(
      ctx,
      web,
      `/groups/team/${encodeURIComponent(world.ids.ravens)}/create-game`,
      'Create Game'
    )
    await details(web, world)
    await sees(web, 'Choose Away Team')
    expect(await disabled(web, 'Save'), 'Save with Away unchosen').equals(true)
    await ctx.checkpoint('away-unchosen', {
      expect: [{ text: 'Choose Away Team' }, { text: world.ids.ravensName }]
    })
    await toTop(web)
    await web.m.takeScreenshot({ path: ctx.artifact('create-game-before.png') })

    await openSide(web, 'Choose Away Team')
    await sees(web, 'Create Placeholder Team')
    const tbdRow = await web.page.evaluate(
      () => document.querySelector('[data-testid="team-tbd"]') != null
    )
    expect(tbdRow, 'the selector’s TBD row').equals(!onBase())
    await tapCss(web, labelled('Cancel team selector'))

    const games = await db
      .selectFrom('games')
      .select('id')
      .where(eb =>
        eb.or([
          eb('home_team_id', '=', world.ids.ravens),
          eb('away_team_id', '=', world.ids.ravens)
        ])
      )
      .execute()
    expect(games, 'no Ravens game').deep.equals([])
    await web.close()
  } finally {
    await db.destroy()
  }
}

/**
 * E1: the Ravens coach schedules a game with Away TBD. No team is made; the
 * schedule shows TBD with no team link; the API answers `''` and TBD.
 */
async function teamPage(ctx: E2eContext): Promise<void> {
  onWeb(ctx)
  const { world, db } = await seeded(ctx)
  const api = stackHandle(ctx).api
  const log = new RequestLog(ctx.artifact('api-open-side.log'))
  try {
    const teamsBefore = await teamCount(db)
    log.write(
      `psql "$STACK_DATABASE" -c "select count(*) from teams"`,
      teamsBefore
    )
    const web = await signedIn(ctx, 'ravensCoach')
    log.watch(web, api)
    // Ravens holds Home on a team page: that row opens no selector.
    await open(
      ctx,
      web,
      `/groups/team/${encodeURIComponent(world.ids.ravens)}/create-game`,
      'Create Game'
    )
    await sees(web, world.ids.ravensName)
    const homeOpens = await web.page.evaluate(
      (name: string) =>
        [...document.querySelectorAll('[role="button"]')].some(node =>
          String(node.getAttribute('aria-label')).startsWith(`${name}, Home`)
        ),
      world.ids.ravensName
    )
    expect(homeOpens, 'the Home row opens a selector').equals(false)

    const gameId = await ravensGameWithAwayTbd(
      ctx,
      web,
      world,
      'create-game-after.png'
    )
    expect(await sides(db, gameId)).deep.equals({
      home: world.ids.ravens,
      away: null
    })

    await open(
      ctx,
      web,
      `/teams/${encodeURIComponent(world.ids.ravens)}?tab=schedule`
    )
    await sees(web, TBD, 45_000)
    const tbdLinks = await web.page.evaluate(
      () =>
        [...document.querySelectorAll('a')].filter(
          node => (node.textContent ?? '').trim() === 'TBD'
        ).length
    )
    expect(tbdLinks, 'links named TBD').equals(0)
    await ctx.checkpoint('team-schedule-tbd', { expect: [{ text: TBD }] })
    await new Promise(resolve => setTimeout(resolve, 1500))
    await web.m.takeScreenshot({ path: ctx.artifact('team-schedule-tbd.png') })

    const token = await apiToken(api, world.accounts.ravensCoach)
    const rows = (await log.get(
      api,
      token,
      `/teams/${encodeURIComponent(world.ids.ravens)}/games`
    )) as Array<Record<string, unknown>>
    const row = rows.find(each => each.id === gameId)
    expect(row, 'the game in the team’s list').not.equals(undefined)
    expect(row?.awayTeamId).equals('')
    expect(row?.awayTeamName).equals(TBD)
    expect(row?.homeTeamId).equals(world.ids.ravens)
    const teamsAfter = await teamCount(db)
    log.write(
      `psql "$STACK_DATABASE" -c "select count(*) from teams"`,
      teamsAfter
    )
    expect(teamsAfter, 'teams made').equals(teamsBefore)
    await web.close()
  } finally {
    await db.destroy()
  }
}

/**
 * E2: Game Settings assigns Herons to the open Away side. It waits for
 * Herons' approval; then the same game is Ravens vs Herons on both
 * schedules, with no TBD.
 */
async function assignLater(ctx: E2eContext): Promise<void> {
  onWeb(ctx)
  const { world, db } = await seeded(ctx)
  const { ravens, herons, ravensName, heronsName } = world.ids
  try {
    const coach = await signedIn(ctx, 'ravensCoach')
    const gameId = await ravensGameWithAwayTbd(ctx, coach, world)
    await open(
      ctx,
      coach,
      `/games/${encodeURIComponent(gameId)}/settings`,
      'Game Settings'
    )
    await openSide(coach, `${TBD}, Away · Team to be decided`)
    await chooseTeam(coach, heronsName, herons)
    await sees(coach, heronsName)
    await ctx.checkpoint('game-settings-assign', {
      expect: [{ text: heronsName }, { text: ravensName }]
    })
    await coach.m.takeScreenshot({
      path: ctx.artifact('game-settings-assign.png')
    })
    await tapButton(coach, 'Save')
    await sees(coach, `Game proposal sent: ${ravensName} vs ${heronsName}`)
    // Pending until Herons approves.
    expect(await sides(db, gameId)).deep.equals({ home: ravens, away: null })
    await coach.close()

    const heronsCoach = await signedIn(ctx, 'heronsCoach')
    await open(ctx, heronsCoach, '/notifications')
    await tapCss(heronsCoach, '[data-testid="notification-accept"]')
    await eventually(async () => {
      expect(await sides(db, gameId)).deep.equals({
        home: ravens,
        away: herons
      })
    }, 30_000)

    await open(
      ctx,
      heronsCoach,
      `/teams/${encodeURIComponent(herons)}?tab=schedule`
    )
    await sees(heronsCoach, ravensName, 45_000)
    expect(await bodyText(heronsCoach)).not.includes(TBD)
    await ctx.checkpoint('team-schedule-assigned', {
      expect: [{ text: ravensName }, { text: TBD, absent: true }]
    })
    await new Promise(resolve => setTimeout(resolve, 1500))
    await heronsCoach.m.takeScreenshot({
      path: ctx.artifact('team-schedule-assigned.png')
    })

    // The Ravens schedule names Herons too, on the same game.
    const api = stackHandle(ctx).api
    const { TeamStationClient } = await import('../../../../src/common/api')
    for (const [account, team] of [
      [world.accounts.ravensCoach, ravens],
      [world.accounts.heronsCoach, herons]
    ] as const) {
      const client = new TeamStationClient({
        baseUrl: api,
        token: await apiToken(api, account)
      })
      const game = (await client.teamGames(team)).find(
        each => each.id === gameId
      )
      expect(game, `the game on ${team}`).not.equals(undefined)
      expect([game?.homeTeamId, game?.awayTeamId]).deep.equals([ravens, herons])
      expect([game?.homeTeamName, game?.awayTeamName]).deep.equals([
        ravensName,
        heronsName
      ])
    }
    await heronsCoach.close()
  } finally {
    await db.destroy()
  }
}

/**
 * E3: the season administrator schedules a game with both sides TBD, which
 * is accepted on the season's authority, then names Home as Ravens, an
 * active member the season approves for.
 */
async function seasonBothOpen(ctx: E2eContext): Promise<void> {
  onWeb(ctx)
  const { world, db } = await seeded(ctx)
  const { season, ravens, ravensName, seasonName } = world.ids
  try {
    const teamsBefore = await teamCount(db)
    const web = await signedIn(ctx, 'seasonAdmin')
    await open(
      ctx,
      web,
      `/groups/season/${encodeURIComponent(season)}/create-game`,
      'Create Game'
    )
    await details(web, world)
    await openSide(web, 'Choose Home Team')
    await chooseTbd(web)
    await openSide(web, 'Choose Away Team')
    await chooseTbd(web)
    await sees(web, 'Home · Team to be decided')
    await sees(web, 'Away · Team to be decided')
    const gameId = await saveToGame(
      web,
      `Game scheduled: ${TBD} vs ${TBD} in ${seasonName}`
    )
    expect(await sides(db, gameId)).deep.equals({ home: null, away: null })

    await open(
      ctx,
      web,
      `/seasons/${encodeURIComponent(season)}?tab=schedule&when=upcoming`
    )
    await eventually(async () => {
      const text = await bodyText(web)
      expect(text.split(TBD).length - 1, 'TBD on the season schedule').gte(2)
    }, 45_000)
    await ctx.checkpoint('season-both-tbd', { expect: [{ text: TBD }] })
    await new Promise(resolve => setTimeout(resolve, 1500))
    await web.m.takeScreenshot({ path: ctx.artifact('season-both-tbd.png') })

    await open(
      ctx,
      web,
      `/games/${encodeURIComponent(gameId)}/settings`,
      'Game Settings'
    )
    await openSide(web, `${TBD}, Home · Team to be decided`)
    await chooseTeam(web, ravensName, ravens)
    await tapButton(web, 'Save')
    await sees(web, `Game changes saved: ${ravensName} vs ${TBD}`)
    expect(await sides(db, gameId)).deep.equals({ home: ravens, away: null })

    await open(
      ctx,
      web,
      `/seasons/${encodeURIComponent(season)}?tab=schedule&when=upcoming`
    )
    await sees(web, ravensName, 45_000)
    await sees(web, TBD)
    expect(await teamCount(db), 'teams made').equals(teamsBefore)
    await web.close()
  } finally {
    await db.destroy()
  }
}

export default defineE2e({
  id: 'schedule/tbd-opponent/schedule-later',
  title:
    'Create Game can leave a team as TBD, and Game Settings names it later through the usual approval',
  kind: 'e2e',
  covers: [
    'src/app/screens/gameDraft.ts',
    'src/app/screens/GameFormScreen.tsx',
    'src/app/screens/TeamSelectorScene.tsx',
    'src/common/gameApprovals.ts',
    'src/common/openSides.ts',
    'src/server/schedule/gameApprovals.ts',
    'src/server/routes/seasons.ts',
    'src/server/routes/teams.ts',
    'src/server/dev/fixtures/tbdOpponent.ts'
  ],
  stack: 'isolated',
  fixtures: ['tbd-opponent'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['web'],
  apps: [],
  secrets: [],
  costUsd: 0,
  sendsNoMail: true,
  minutes: 8,
  guards: [],
  faults: ['blank-screen', 'hidden-element'],
  manual: false,
  scenarios: {
    'before-create': beforeCreate,
    'team-page': teamPage,
    'assign-later': assignLater,
    'season-both-open': seasonBothOpen
  }
})
