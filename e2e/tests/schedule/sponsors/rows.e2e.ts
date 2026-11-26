import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import type { Kysely } from 'kysely'

import { TeamStationClient } from '../../../../src/common/api'
import { makeId } from '../../../../src/common/ids'
import { type Database, makeDatabase } from '../../../../src/server/db/database'
import type {
  FixtureAccount,
  FixtureManifest
} from '../../../../src/server/dev/fixtures/accounts'
import { nodeDatabaseUrl } from '../../../core/dropletStack'
import { signInWithPassword } from '../../../core/fixtures'
import { eventually } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import { appLink, openInApp } from '../../../rigs/app/setServer'
import { apiToken } from '../../../rigs/media/recordingSeek'
import { stackHandle } from '../../../rigs/media/stackSpace'

/**
 * E12 and E13, sponsored rows in Schedules (#220): on the `sponsors` world,
 * the American League places "Bayside Bakery" and the National League
 * "Pacific Diner" through the API, both between Yankees @ Red Sox and
 * Dodgers @ Yankees. The Yankees Schedule shows the AL row between its two
 * games, styled as a sponsored row with its background cropped upper-right,
 * and leaves it at its time when a game moves past it; a person on the
 * Yankees and the Dodgers sees both rows on their own Schedule; the AL
 * season's Schedule shows both, since the Dodgers play in it; a signed-out
 * visitor sees the AL row on the public Yankees page; the iPhone app shows it
 * on the team Schedule. Tapping a row opens its https address: a new tab on
 * the web, Safari on the iPhone. The web scenarios take the after pictures of
 * the plan's before ones, on the same window and pages.
 */

const DESKTOP = { width: 1280, height: 800 }
const APP_ID = 'app.teamstation.develop'
const HOUR = 3_600_000

const AL_ROW = {
  title: 'Bayside Bakery',
  message: 'Fresh bread after every game.',
  url: 'https://example.test/bread'
}
const NL_ROW = {
  title: 'Pacific Diner',
  message: 'Breakfast all day for every team.',
  url: 'https://example.test/diner'
}

/** The rows' titles, as a checkpoint finds them on the page. */
const AL_TITLE = AL_ROW.title
const NL_TITLE = NL_ROW.title

const run = promisify(execFile)
const ffmpeg = (): string => process.env.TS_FFMPEG ?? 'ffmpeg'

/** A still picture made with ffmpeg at `path`. */
async function picture(
  path: string,
  width: number,
  height: number,
  color: string
): Promise<string> {
  await run(ffmpeg(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    // A test pattern, whose corners show where a picture is cropped.
    color === 'pattern'
      ? `testsrc2=size=${width}x${height}:rate=1`
      : `color=c=${color}:s=${width}x${height}`,
    '-frames:v',
    '1',
    path
  ])
  return path
}

interface Rows {
  world: FixtureManifest
  db: Kysely<Database>
  /** When Yankees @ Red Sox starts, as the world seeded it. */
  firstGame: Date
}

/** One league's row, placed by its admin through the API at `startsAt`. */
async function placeRow(
  ctx: E2eContext,
  world: FixtureManifest,
  role: 'alAdmin' | 'nlAdmin',
  row: typeof AL_ROW,
  textColor: 'dark' | 'white',
  startsAt: Date,
  color: string
): Promise<void> {
  const handle = stackHandle(ctx)
  const league =
    role === 'alAdmin' ? world.ids.americanLeague : world.ids.nationalLeague
  const api = new TeamStationClient({
    baseUrl: handle.api,
    token: await apiToken(handle.api, world.accounts[role])
  })
  const upload = async (
    purpose: 'rowLogo' | 'rowBackground',
    width: number,
    height: number,
    tint: string
  ): Promise<string> =>
    (
      await api.uploadSponsorMedia(
        league,
        purpose,
        'image/png',
        new Uint8Array(
          readFileSync(
            await picture(
              join(ctx.runDir, `${role}-${purpose}.png`),
              width,
              height,
              tint
            )
          )
        )
      )
    ).mediaId
  await api.addSponsorRow(league, {
    logoMediaId: await upload('rowLogo', 128, 128, color),
    backgroundMediaId: await upload('rowBackground', 1920, 224, 'pattern'),
    ...row,
    textColor,
    startsAt: startsAt.toISOString()
  })
}

/**
 * The `sponsors` world with the AL row 6 hours after Yankees @ Red Sox and
 * the NL row 12 hours after it, both before Dodgers @ Yankees a day later.
 */
async function sponsoredWorld(ctx: E2eContext): Promise<Rows> {
  const world = await ctx.fixture('sponsors')
  const db = makeDatabase(nodeDatabaseUrl(stackHandle(ctx).databaseUrl))
  const { start_at: first } = await db
    .selectFrom('games')
    .select('start_at')
    .where('id', '=', world.ids.yankeesAtRedSox)
    .executeTakeFirstOrThrow()
  const firstGame = new Date(first)
  await placeRow(
    ctx,
    world,
    'alAdmin',
    AL_ROW,
    'white',
    new Date(firstGame.getTime() + 6 * HOUR),
    'orange'
  )
  await placeRow(
    ctx,
    world,
    'nlAdmin',
    NL_ROW,
    'white',
    new Date(firstGame.getTime() + 12 * HOUR),
    'teal'
  )
  return { world, db, firstGame }
}

/** `account` signed in on the web through the password form. */
async function signedInWeb(
  ctx: E2eContext,
  account: FixtureAccount
): Promise<WebSession> {
  const web = await ctx.browser(DESKTOP)
  await web.m.openLink({ link: ctx.stack.origin })
  await web.m.assertVisible({ text: 'Use a password instead', timeout: 30_000 })
  await web.m.tapOn({ text: 'Use a password instead' })
  await web.m.tapOn({
    css: 'input[aria-label="E-mail address"]',
    timeout: 15_000
  })
  await web.m.inputText({ text: account.email })
  await web.m.tapOn({ css: 'input[aria-label="Password"]', timeout: 15_000 })
  await web.m.inputText({ text: account.password })
  await web.m.pressKey({ key: 'Enter' })
  await eventually(async () => {
    const signedIn = await web.page.evaluate(
      () => document.querySelector('input[aria-label="Password"]') == null
    )
    expect(signedIn, 'the password form has gone').equals(true)
  }, 30_000)
  return web
}

/**
 * Opens `path` and waits for `titles` to show, in that order on the page
 * with `between` in between: each entry is a text the page draws, a game's
 * or a row's.
 */
async function shows(
  ctx: E2eContext,
  web: WebSession,
  path: string,
  order: string[]
): Promise<void> {
  await web.m.openLink({ link: `${ctx.stack.origin}${path}` })
  await eventually(async () => {
    const text = await web.page.evaluate(() => document.body.innerText)
    const places = order.map(each => text.indexOf(each))
    expect(places, `${order.join(' < ')} on ${path}`).not.includes(-1)
    expect([...places].sort((a, b) => a - b)).deep.equals(places)
  }, 45_000)
  // The pictures load after the text.
  await new Promise(resolve => setTimeout(resolve, 2500))
}

/** The rows a page draws, by title. */
async function rowTitles(web: WebSession): Promise<string[]> {
  return await web.page.evaluate(() =>
    [
      ...document.querySelectorAll('[data-testid="sponsored-schedule-row"]')
    ].map(node => String(node.getAttribute('aria-label')))
  )
}

/**
 * The first row's background covers the row and is anchored to its
 * upper-right corner: its right and top edges are the row's.
 */
async function croppedUpperRight(web: WebSession): Promise<void> {
  await eventually(async () => {
    const boxes = await web.page.evaluate(() => {
      const row = document.querySelector(
        '[data-testid="sponsored-schedule-row"]'
      )
      // The page has no helpers for `?.` or `??`.
      if (row == null) return null
      const background = row.querySelector(
        '[data-testid="sponsored-row-background"]'
      )
      if (background == null) return null
      // Inside the row's border, where its children are placed.
      const box = row.getBoundingClientRect()
      const left = box.left + row.clientLeft
      const top = box.top + row.clientTop
      const inner = background.getBoundingClientRect()
      // The row lays its picture out on its border box, so the picture's
      // edge may run under the border, which hides it: up to its width.
      const over = Math.round(inner.right - (left + row.clientWidth))
      return {
        right: over >= 0 && over <= box.width - row.clientWidth ? 0 : over,
        top: Math.round(inner.top - top),
        coversWidth: inner.width >= row.clientWidth - 1,
        coversHeight: inner.height >= row.clientHeight - 1
      }
    })
    expect(boxes, 'the row’s background').deep.equals({
      right: 0,
      top: 0,
      coversWidth: true,
      coversHeight: true
    })
  }, 30_000)
}

async function shot(
  ctx: E2eContext,
  web: WebSession,
  name: string
): Promise<void> {
  await web.m.takeScreenshot({ path: ctx.artifact(name) })
}

function onWeb(ctx: E2eContext): void {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
}

/** E12: the Yankees Schedule, and a game moved past its row. */
async function teamWeb(ctx: E2eContext): Promise<void> {
  onWeb(ctx)
  const { world, db, firstGame } = await sponsoredWorld(ctx)
  try {
    const web = await signedInWeb(ctx, world.accounts.yankeesPlayer)
    const path = `/teams/${world.ids.yankees}?tab=schedule`
    await shows(ctx, web, path, ['@ Red Sox', AL_ROW.title, 'vs Dodgers'])
    expect(await rowTitles(web), 'the AL row alone').deep.equals([
      `Sponsored: ${AL_ROW.title}`
    ])
    await croppedUpperRight(web)
    await ctx.checkpoint('team-schedule-row', {
      expect: [{ text: AL_ROW.message }, { text: 'Sponsored' }]
    })
    await shot(ctx, web, 'team-schedule-web-after.png')

    // Moved past the row: the game takes its new place, the row keeps its.
    await db
      .updateTable('games')
      .set({ start_at: new Date(firstGame.getTime() + 18 * HOUR) })
      .where('id', '=', world.ids.yankeesAtRedSox)
      .execute()
    await shows(ctx, web, path, [AL_ROW.title, '@ Red Sox', 'vs Dodgers'])
    await shot(ctx, web, 'team-schedule-moved-web.png')
    await web.close()
  } finally {
    await db.destroy()
  }
}

/** E12: the combined Schedule of a person on the Yankees and the Dodgers. */
async function combinedWeb(ctx: E2eContext): Promise<void> {
  onWeb(ctx)
  const { world, db } = await sponsoredWorld(ctx)
  try {
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: world.accounts.yankeesPlayer.userId,
        team_id: world.ids.dodgers,
        is_player: true
      })
      .execute()
    const web = await signedInWeb(ctx, world.accounts.yankeesPlayer)
    await shows(ctx, web, '/schedule', [
      '@ Red Sox',
      AL_ROW.title,
      NL_ROW.title,
      'Dodgers'
    ])
    expect(await rowTitles(web)).deep.equals([
      `Sponsored: ${AL_ROW.title}`,
      `Sponsored: ${NL_ROW.title}`
    ])
    await ctx.checkpoint('combined-schedule-rows', {
      expect: [{ text: AL_ROW.message }, { text: NL_ROW.message }]
    })
    await shot(ctx, web, 'combined-schedule-web-after.png')
    await web.close()
  } finally {
    await db.destroy()
  }
}

/** E12: the AL season's Schedule, which the Dodgers play in. */
async function seasonWeb(ctx: E2eContext): Promise<void> {
  onWeb(ctx)
  const { world, db } = await sponsoredWorld(ctx)
  try {
    const web = await signedInWeb(ctx, world.accounts.alAdmin)
    await shows(
      ctx,
      web,
      `/seasons/${world.ids.season}?tab=schedule&when=upcoming`,
      ['@ Red Sox', AL_ROW.title, NL_ROW.title, '@ Yankees']
    )
    expect(await rowTitles(web)).deep.equals([
      `Sponsored: ${AL_ROW.title}`,
      `Sponsored: ${NL_ROW.title}`
    ])
    await ctx.checkpoint('season-schedule-rows', {
      expect: [{ text: AL_TITLE }, { text: NL_TITLE }]
    })
    await shot(ctx, web, 'season-schedule-web-after.png')
    await web.close()
  } finally {
    await db.destroy()
  }
}

/** E12: the public Yankees page, signed out. */
async function publicSignedOut(ctx: E2eContext): Promise<void> {
  onWeb(ctx)
  const { world, db } = await sponsoredWorld(ctx)
  try {
    const web = await ctx.browser(DESKTOP)
    await shows(ctx, web, `/teams/${world.ids.yankees}?tab=schedule`, [
      'Red Sox',
      AL_ROW.title,
      'Dodgers'
    ])
    expect(await rowTitles(web)).deep.equals([`Sponsored: ${AL_ROW.title}`])
    await ctx.checkpoint('public-team-row', {
      expect: [{ text: AL_ROW.message }]
    })
    await shot(ctx, web, 'public-team-web-after.png')
    await web.close()
  } finally {
    await db.destroy()
  }
}

/** The leased iPhone, signed in as the Yankees player on the team Schedule. */
async function teamOnPhone(
  ctx: E2eContext,
  world: FixtureManifest
): Promise<Awaited<ReturnType<E2eContext['attach']>>> {
  if (ctx.surface !== 'ios-app')
    throw new BlockedError(`runs on ios-app, not ${ctx.surface}`)
  const udid = ctx.device('phone')
  const device = await ctx.attach('phone', { platform: 'ios', appId: APP_ID })
  await device.launchApp({ appId: APP_ID, stopApp: true })
  await signInWithPassword(device, world.accounts.yankeesPlayer)
  await openInApp({
    platform: 'ios',
    udid,
    appId: APP_ID,
    link: appLink(`teams/${world.ids.yankees}?tab=schedule`),
    device,
    simulator: true
  })
  await device.scrollUntilVisible({
    element: { id: 'sponsored-schedule-row' },
    timeout: 60_000
  })
  return device
}

/** E12: the team Schedule's row on the iPhone app. */
async function teamIosApp(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'ios-app')
    throw new BlockedError(`runs on ios-app, not ${ctx.surface}`)
  const { world, db } = await sponsoredWorld(ctx)
  try {
    const device = await teamOnPhone(ctx, world)
    await ctx.checkpoint(
      'app-team-schedule-row',
      {
        // The row is one link to the phone's accessibility, named for its
        // title, with its words inside it.
        expect: [
          { id: 'sponsored-schedule-row' },
          { text: `Sponsored: ${AL_TITLE}` },
          { text: '@ Red Sox' },
          { text: 'vs Dodgers' }
        ]
      },
      device
    )
    writeFileSync(
      ctx.artifact('team-schedule-ios-after.png'),
      Buffer.from(await device.screenshot())
    )
  } finally {
    await db.destroy()
  }
}

/** E13: a tap opens the row's address, in a new tab or in Safari. */
async function tapOpensUrl(ctx: E2eContext): Promise<void> {
  const { world, db } = await sponsoredWorld(ctx)
  try {
    if (ctx.surface === 'ios-app') {
      const device = await teamOnPhone(ctx, world)
      await device.tapOn({ id: 'sponsored-schedule-row' })
      // Safari comes forward with the address in its bar.
      await device.assertVisible({
        text: '.*example\\.test.*',
        timeout: 30_000
      })
      writeFileSync(
        ctx.artifact('tap-opens-url-ios.png'),
        Buffer.from(await device.screenshot())
      )
      return
    }
    onWeb(ctx)
    const web = await signedInWeb(ctx, world.accounts.yankeesPlayer)
    await shows(ctx, web, `/teams/${world.ids.yankees}?tab=schedule`, [
      '@ Red Sox',
      AL_ROW.title
    ])
    await web.page.evaluate(() => {
      const opened: unknown[][] = []
      ;(window as unknown as { opened: unknown[][] }).opened = opened
      window.open = (...args: unknown[]) => {
        opened.push(args)
        return null
      }
    })
    await web.m.tapOn({ css: '[data-testid="sponsored-schedule-row"]' })
    await eventually(async () => {
      const opened = await web.page.evaluate(
        () => (window as unknown as { opened: unknown[][] }).opened
      )
      expect(opened).deep.equals([[AL_ROW.url, '_blank', 'noopener']])
    }, 15_000)
    await web.close()
  } finally {
    await db.destroy()
  }
}

export default defineE2e({
  id: 'schedule/sponsors/rows',
  title:
    'Schedules show sponsored rows from the leagues that manage their teams, and a tap opens the sponsor’s site',
  kind: 'e2e',
  covers: [
    'src/server/sponsors/rows.ts',
    'src/server/routes/sponsors.ts',
    'src/app/sponsors/sponsoredRows.ts',
    'src/app/sponsors/useSponsoredRows.ts',
    'src/app/sponsors/SponsoredScheduleRow.tsx',
    'src/app/sponsors/openSponsorUrl.ts',
    'src/app/screens/GamesFeedScreen.tsx',
    'src/app/screens/TeamScreen.tsx',
    'src/app/screens/PublicTeamContent.tsx',
    'src/app/screens/SeasonPresentation.tsx'
  ],
  stack: 'isolated',
  fixtures: ['sponsors'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [] },
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'none' }]
    }
  },
  services: ['web'],
  // The phone runs a local build of this branch (Devices, in the plan).
  apps: [],
  secrets: [],
  costUsd: 0,
  sendsNoMail: true,
  minutes: 6,
  guards: [],
  faults: ['blank-screen', 'hidden-element'],
  manual: false,
  scenarios: {
    'team-web': teamWeb,
    'combined-web': combinedWeb,
    'season-web': seasonWeb,
    'public-signed-out': publicSignedOut,
    'team-ios-app': teamIosApp,
    'tap-opens-url': tapOpensUrl
  }
})
