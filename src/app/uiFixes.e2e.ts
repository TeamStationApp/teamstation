import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, {
  type Browser,
  type BrowserContext,
  type Page
} from 'puppeteer'

/**
 * The UI Fixes test vectors on Chrome (platform CH), against a running API
 * and web app with a copy of production in their database:
 *
 *   GS_E2E_WEB_URL=http://10.10.7.40:8092 \
 *   GS_API_TEST_URL=http://10.10.7.40:8092/api/v1 \
 *   GS_E2E_SERVER_LOG=server.log \
 *   GS_CHROME_PATH=…/Google Chrome for Testing \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 180000 src/app/uiFixes.e2e.ts
 *
 * Every vector runs twice: in a desktop window and in Chrome's phone
 * emulation. The reference game is Sunday 4 October, Bandits (Ruden) at
 * Allied Gardens (GS_E2E_GAME). The scorer is the Bandits' administrator
 * (GS_E2E_SCORER) and the member a plain member of the team
 * (GS_E2E_MEMBER). Sign-in codes are read from the server's log.
 */
const WEB = (process.env.GS_E2E_WEB_URL ?? 'http://127.0.0.1:8091').replace(
  /\/+$/,
  ''
)
const API = (
  process.env.GS_API_TEST_URL ?? 'http://127.0.0.1:9311/api/v1'
).replace(/\/+$/, '')
const SERVER_LOG = process.env.GS_E2E_SERVER_LOG ?? 'server.log'
const SHOTS = process.env.GS_E2E_SHOTS ?? '/tmp/uiFixesShots'
const GAME = process.env.GS_E2E_GAME ?? 'gam_SZrheufdi_E_bep0'
/** A finished Bandits game with scores and team stats. */
const FINAL_GAME = process.env.GS_E2E_FINAL_GAME ?? 'gam_MFhfPsp53ZiCr_d1'
const SCORER = process.env.GS_E2E_SCORER ?? 'paul@vtex.net'
const MEMBER = process.env.GS_E2E_MEMBER ?? 'paullinator@yahoo.com'

interface Size {
  name: string
  viewport: {
    width: number
    height: number
    isMobile?: boolean
    hasTouch?: boolean
    deviceScaleFactor?: number
  }
}

const SIZES: Size[] = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  {
    name: 'phone',
    viewport: {
      width: 393,
      height: 852,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3
    }
  }
]

async function until<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 20000
): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value != null && value !== false) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

const tokens = new Map<string, string>()

/** A session for `email`, signed in with the code the server logs. */
async function signIn(email: string): Promise<string> {
  const known = tokens.get(email)
  if (known != null) return known
  const before = readFileSync(SERVER_LOG, 'utf8').length
  const asked = await fetch(`${API}/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email })
  })
  expect(asked.status, 'email-code').equals(202)
  const pattern = new RegExp(`sign-in code for ${email}: (\\d{6})`)
  const code = await until('the sign-in code in the log', () => {
    const match = pattern.exec(readFileSync(SERVER_LOG, 'utf8').slice(before))
    return match?.[1]
  })
  const verified = await fetch(`${API}/auth/email-code/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code })
  })
  expect(verified.status, 'verify').equals(200)
  const token = ((await verified.json()) as { token: string }).token
  tokens.set(email, token)
  return token
}

let browser: Browser | undefined

async function contextAs(email?: string): Promise<BrowserContext> {
  if (browser == null) throw new Error('No browser')
  const context = await browser.createBrowserContext()
  if (email != null) {
    await context.setCookie({
      name: 'gs_session',
      value: encodeURIComponent(await signIn(email)),
      domain: new URL(API).hostname,
      path: '/'
    })
  }
  return context
}

async function open(
  context: BrowserContext,
  path: string,
  size: Size
): Promise<Page> {
  const page = await context.newPage()
  await page.setViewport(size.viewport)
  // Headless Chrome keeps no clipboard, so what the page writes to it is
  // recorded on the way through.
  await page.evaluateOnNewDocument(() => {
    const clipboard = navigator.clipboard as Clipboard | undefined
    if (clipboard == null) return
    const write = clipboard.writeText.bind(clipboard)
    clipboard.writeText = async (text: string) => {
      ;(window as unknown as { copied: string }).copied = text
      await write(text).catch(() => undefined)
    }
  })
  await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle2' })
  return page
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

/**
 * The game page's pills, by label, in document order: the tabs that share a
 * row with Box score. The floating capsule's Videos is a tab too, elsewhere.
 */
async function labelled(page: Page, labels: string[]): Promise<string[]> {
  return await page.evaluate(wanted => {
    // No `??` or `?.` in here: this runs in the page, where the compiler's
    // helpers for them do not exist.
    const first = document.querySelector('[role="tab"][aria-label="Box score"]')
    if (first === null) return []
    const list = first.closest('[role="tablist"]')
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- runs in the page, without the compiler's helper for `??`
    const row = list !== null ? list : first.parentElement
    if (row === null) return []
    const found: string[] = []
    for (const node of Array.from(row.querySelectorAll('[role="tab"]'))) {
      const label = node.getAttribute('aria-label')
      if (label !== null && wanted.includes(label)) found.push(label)
    }
    return found
  }, labels)
}

async function leftOf(page: Page, label: string): Promise<number> {
  const node = await page.$(`[role="tab"][aria-label="${label}"]`)
  const box = await node?.boundingBox()
  if (box == null) throw new Error(`No ${label} on the page`)
  return box.x
}

async function press(page: Page, label: string): Promise<void> {
  const node = await until(
    `${label} on the page`,
    async () => (await page.$(`[aria-label="${label}"]`)) ?? undefined
  )
  await node.click()
}

async function bodyText(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.innerText)
}

const PILLS = ['Box score', 'Videos', 'Score Game', 'DJ Game']

before(async function () {
  mkdirSync(SHOTS, { recursive: true })
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.GS_CHROME_PATH,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      // The app is served on the LAN address so the phones and the simulator
      // reach the same server; Chrome keeps the clipboard from a plain-http
      // origin unless it is told to treat this one as secure.
      `--unsafely-treat-insecure-origin-as-secure=${WEB}`
    ]
  })
})

after(async function () {
  await browser?.close()
})

for (const size of SIZES) {
  describe(`CH ${size.name}: Score Game (A)`, function () {
    it('A1 shows the scorer Box score, Videos, Score Game, in that order', async function () {
      const context = await contextAs(SCORER)
      const page = await open(context, `/games/${GAME}`, size)
      await until('the pills', async () =>
        (await labelled(page, PILLS)).length >= 3 ? true : undefined
      )
      // The web has no music, so no DJ Game.
      expect(await labelled(page, PILLS)).deep.equals([
        'Box score',
        'Videos',
        'Score Game'
      ])
      expect(await leftOf(page, 'Box score')).lessThan(
        await leftOf(page, 'Videos')
      )
      expect(await leftOf(page, 'Videos')).lessThan(
        await leftOf(page, 'Score Game')
      )
      await shot(page, `A1-CH-${size.name}`)
      await context.close()
    })

    it('A2 opens the choices, copies the link, and comes back from each', async function () {
      const context = await contextAs(SCORER)
      const page = await open(context, `/games/${GAME}`, size)
      await press(page, 'Score Game')
      await until('the Score Game choices', async () =>
        (await bodyText(page)).includes('Full game scoring') ? true : undefined
      )
      const text = await bodyText(page)
      expect(text).includes('Scoreboard')
      expect(text).includes(`${new URL(WEB).origin}/scoreboard/${GAME}`)
      await shot(page, `A2-CH-${size.name}-choices`)

      await press(page, 'Copy scoreboard link')
      await until('Copied', async () =>
        (await bodyText(page)).includes('Copied') ? true : undefined
      )
      expect(
        await page.evaluate(
          () => (window as unknown as { copied: string }).copied
        )
      ).equals(`${new URL(WEB).origin}/scoreboard/${GAME}`)

      await press(page, 'Full game scoring')
      await until('the scorer', () =>
        page.url().endsWith(`/games/${GAME}/score`) ? true : undefined
      )
      await shot(page, `A2-CH-${size.name}-scorer`)
      await page.goBack()
      await until('the Score Game tab again', async () =>
        (await bodyText(page)).includes('Full game scoring') ? true : undefined
      )

      await press(page, 'Scoreboard')
      await until('the dashboard', () =>
        page.url().includes(`/games/${GAME}/scoreboard-override`)
          ? true
          : undefined
      )
      await until('the Bandits on the dashboard', async () =>
        (await bodyText(page)).includes('Bandits') ? true : undefined
      )
      await shot(page, `A2-CH-${size.name}-dashboard`)
      await page.goBack()
      await until('the Score Game tab after the dashboard', async () =>
        (await bodyText(page)).includes('Full game scoring') ? true : undefined
      )
      await context.close()
    })

    it('A3 shows a member no Score Game', async function () {
      const context = await contextAs(MEMBER)
      const page = await open(context, `/games/${GAME}`, size)
      await until('the pills', async () =>
        (await labelled(page, PILLS)).length >= 2 ? true : undefined
      )
      expect(await labelled(page, PILLS)).deep.equals(['Box score', 'Videos'])
      await shot(page, `A3-CH-${size.name}`)
      await context.close()
    })
  })
}

/** The hero card: the first card on the game page, and what is inside it. */
async function heroCard(page: Page): Promise<{
  box: { x: number; y: number; width: number; height: number }
  /** Everything the card says, nested runs included. */
  all: string
  texts: Array<{
    text: string
    x: number
    y: number
    right: number
    bottom: number
  }>
}> {
  return await page.evaluate(() => {
    // The card holds the date line; its box is the nearest ancestor that is
    // wider than the date and has a border.
    const leaves = Array.from(document.querySelectorAll('div'))
    const date = leaves.find(
      node =>
        node.children.length === 0 &&
        /^[A-Z]{3}, [A-Z]{3} \d+$/.test(String(node.textContent))
    )
    if (date === undefined) throw new Error('no date line')
    let card = date.parentElement
    while (card !== null && getComputedStyle(card).borderTopWidth === '0px') {
      card = card.parentElement
    }
    if (card === null) throw new Error('no card around the date')
    const box = card.getBoundingClientRect()
    const texts = Array.from(card.querySelectorAll('div'))
      .filter(
        node =>
          node.children.length === 0 &&
          node.textContent !== null &&
          node.textContent !== ''
      )
      .map(node => {
        const rect = node.getBoundingClientRect()
        return {
          text: String(node.textContent),
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom
        }
      })
    return {
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      all: card.innerText,
      texts
    }
  })
}

function inside(
  hero: Awaited<ReturnType<typeof heroCard>>,
  text: string
): void {
  const found = hero.texts.filter(item => item.text === text)
  expect(found.length, `${text} in the card`).at.least(1)
  for (const item of found) {
    expect(item.right - item.x, `${text} has width`).greaterThan(0)
    expect(item.bottom - item.y, `${text} has height`).greaterThan(0)
    expect(item.x, `${text} left`).at.least(hero.box.x)
    expect(item.right, `${text} right`).at.most(hero.box.x + hero.box.width)
    expect(item.y, `${text} top`).at.least(hero.box.y)
    expect(item.bottom, `${text} bottom`).at.most(hero.box.y + hero.box.height)
  }
}

for (const size of SIZES) {
  describe(`CH ${size.name}: hero card (B)`, function () {
    it('B1 shows a scheduled game’s date, status, both teams and both scores', async function () {
      const context = await contextAs(SCORER)
      const page = await open(context, `/games/${GAME}`, size)
      await until('the hero card', async () =>
        (await bodyText(page)).includes('Allied Gardens') ? true : undefined
      )
      const hero = await heroCard(page)
      for (const text of [
        'SUN, OCT 4',
        'Bandits (Ruden)',
        'Allied Gardens',
        'Home'
      ]) {
        inside(hero, text)
      }
      expect(hero.texts.some(item => item.text.startsWith('Away'))).equals(true)
      expect(hero.texts.filter(item => item.text === '–')).length(2)
      await shot(page, `B1-CH-${size.name}`)
      await context.close()
    })

    it('B2 shows a finished game’s scores, the winner and the stat line, and opens a team', async function () {
      const context = await contextAs(SCORER)
      const page = await open(context, `/games/${FINAL_GAME}`, size)
      await until('the hero card', async () =>
        (await bodyText(page)).includes('Mission Trails') ? true : undefined
      )
      const hero = await heroCard(page)
      for (const text of ['5', '14', 'Bandits (Ruden) ★', 'Mission Trails']) {
        inside(hero, text)
      }
      // The stat line, a run of its own with `Def:` nested in it.
      expect(hero.all).match(/\d+ H · \d+ BB · \d+ K · \d+ HR · Def: \d+ E/)
      await shot(page, `B2-CH-${size.name}`)
      const name = await page.$('[role="link"][aria-label="Bandits (Ruden)"]')
      if (name == null) throw new Error('no link on the Bandits')
      await name.click()
      await until('the team page', () =>
        page.url().includes('/teams/') ? true : undefined
      )
      await context.close()
    })
  })
}
