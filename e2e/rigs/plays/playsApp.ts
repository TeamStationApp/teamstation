import { expect } from 'chai'

import {
  type FixtureAccount,
  type FixtureManifest,
  signInWithPassword
} from '../../core/fixtures'
import type { E2eContext, WebSession } from '../../core/spec'
import { clearSignInLimits } from '../coach/coachApp'

/**
 * The Plays tab's scenarios on the web: maestro-d's Chromium at a phone or a
 * wide window, signed in as one of the `plays-game` world's people or not at
 * all. Everything that acts goes through maestro-d; the page is only read,
 * and its requests only listened to.
 */

/** The game's own pills, not the app's tab bar, which is tabs too. */
const GAME_PILLS = '[data-testid="gameSection"]'
const PILL = `${GAME_PILLS} [role="tab"]`
/** Every pill, Replay and Live included, which are buttons rather than tabs. */
const ANY_PILL = `${GAME_PILLS} [role="tablist"] [role="tab"], ${GAME_PILLS} [role="tablist"] [role="button"]`

export const PHONE = { width: 393, height: 852 }
export const WIDE = { width: 1440, height: 900 }

export interface PlaysApp {
  m: any
  web: WebSession
  origin: string
  /** Every path the page asked the API for, in order, since it opened. */
  requests: string[]
  /** Opens a page of the app by its path. */
  go: (path: string) => Promise<void>
  /** The game's pills, as they read, left to right. */
  pills: () => Promise<string[]>
  /** The selected pill's words. */
  selected: () => Promise<string | null>
  /** Taps a pill by its words. */
  choose: (label: string) => Promise<void>
  /** The page's address, path and query. */
  address: () => Promise<string>
  /** What the page reads, all of it. */
  text: () => Promise<string>
  /** Waits until `ready` holds of the page, or fails naming `what`. */
  until: <T>(
    what: string,
    ready: () => Promise<T | undefined>,
    ms?: number
  ) => Promise<T>
  /** Every drawn element whose test id matches, in page order. */
  testIds: (pattern: RegExp) => Promise<string[]>
  /** Taps an at-bat line by its index in the game. */
  tapLine: (atBatIndex: number) => Promise<void>
  /** The pitch rows an open line shows, as they read. */
  pitchRows: (atBatIndex: number) => Promise<string[]>
  /** Where an element is on the window, by its test id. */
  rect: (testId: string) => Promise<DOMRect | null>
  /** Saves the window as it looks now, into the run's directory. */
  screenshot: (name: string) => Promise<string>
}

/**
 * Opens the app at `size`, and signs `account` in through the password form,
 * or nobody when it is null.
 */
export async function openPlaysApp(
  ctx: E2eContext,
  account: FixtureAccount | null,
  size: { width: number; height: number } = PHONE
): Promise<PlaysApp> {
  const origin = ctx.stack.origin
  if (account != null) await clearSignInLimits(ctx)
  const web = await ctx.browser(size)
  const { m, page } = web
  const requests: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin === origin && url.pathname.startsWith('/api/'))
      requests.push(url.pathname)
  })
  await m.openLink({ link: `${origin}/` })
  // A wide window has no menu button: its sidebar names whoever is signed in.
  if (account != null)
    await signInWithPassword(
      m,
      account,
      size.width >= 1024 ? account.displayName : undefined
    )
  const until = async <T>(
    what: string,
    ready: () => Promise<T | undefined>,
    ms = 60000
  ): Promise<T> => {
    const end = Date.now() + ms
    for (;;) {
      const value = await ready().catch(() => undefined)
      if (value !== undefined) return value
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  const pills = async (): Promise<string[]> =>
    await page.evaluate(
      (pill: string) =>
        Array.from(document.querySelectorAll(pill)).map(tab =>
          String(tab.textContent)
        ),
      ANY_PILL
    )
  const app: PlaysApp = {
    m,
    web,
    origin,
    requests,
    go: async path => {
      await m.openLink({ link: `${origin}${path}` })
    },
    pills,
    selected: async () =>
      await page.evaluate((pill: string) => {
        // Selectors go in as arguments: the page has none of this module.
        const tab = document.querySelector(pill + '[aria-selected="true"]')
        return tab == null ? null : String(tab.textContent)
      }, PILL),
    choose: async label => {
      await m.tapOn({
        css: `${GAME_PILLS} [role="tab"][aria-label="${label}"]`
      })
      await until(`${label} selected`, async () =>
        (await app.selected()) === label ? true : undefined
      )
    },
    address: async () =>
      await page.evaluate(() => location.pathname + location.search),
    text: async () =>
      await page.evaluate(() => String(document.body.textContent)),
    until,
    testIds: async pattern =>
      await page.evaluate((source: string) => {
        const match = new RegExp(source)
        return Array.from(document.querySelectorAll('[data-testid]'))
          .map(node => String(node.getAttribute('data-testid')))
          .filter(id => match.test(id))
      }, pattern.source),
    tapLine: async atBatIndex => {
      await m.tapOn({
        css: `[data-testid="plays-line-${atBatIndex}"] [role="button"]`
      })
    },
    pitchRows: async atBatIndex =>
      await page.evaluate(
        (index: number) =>
          Array.from(
            document.querySelectorAll(
              `[data-testid="plays-line-${index}"] [data-testid="plays-pitch"]`
            )
          ).map(row => String(row.textContent)),
        atBatIndex
      ),
    rect: async testId =>
      await page.evaluate((id: string) => {
        const node = document.querySelector(`[data-testid="${id}"]`)
        return node == null ? null : node.getBoundingClientRect().toJSON()
      }, testId),
    screenshot: async name => {
      const path = ctx.artifact(name)
      await m.takeScreenshot({ path })
      return path
    }
  }
  return app
}

/** The game's page, waited for until its pills are drawn. */
export async function openGame(
  app: PlaysApp,
  gameId: string,
  query = ''
): Promise<void> {
  await app.go(`/games/${gameId}${query}`)
  await app.until('the game pills', async () =>
    (await app.pills()).length > 0 ? true : undefined
  )
}

/** Plays, from its pill, waited for until its stream or its notice shows. */
export async function openPlays(app: PlaysApp): Promise<void> {
  await app.choose('Plays')
  await app.until('the Plays tab', async () =>
    (await app.testIds(/^plays-(stream|members-only)$/)).length > 0
      ? true
      : undefined
  )
}

/** The `/games/<id>/events` reads among the page's requests. */
export function eventsReads(app: PlaysApp, gameId: string): string[] {
  return app.requests.filter(path => path === `/api/v1/games/${gameId}/events`)
}

/** The world's game ids, by name, failing for a world without them. */
export function gamesOf(world: FixtureManifest): {
  final: string
  inProgress: string
  mixed: string
  imported: string
  onePitch: string
  unplayed: string
} {
  const { final, inProgress, mixed, imported, onePitch, unplayed } = world.ids
  for (const [name, id] of Object.entries({
    final,
    inProgress,
    mixed,
    imported,
    onePitch,
    unplayed
  }))
    expect(id, `the world's ${name} game`).to.be.a('string')
  return { final, inProgress, mixed, imported, onePitch, unplayed }
}
