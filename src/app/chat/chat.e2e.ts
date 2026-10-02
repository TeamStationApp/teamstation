import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'

/**
 * The chat's browser scenarios, against a running API and web app with
 * the chat fixture in their database:
 *
 *   scripts/chat-e2e-reset.sh <artifacts>
 *   npm start                         # the API, on 127.0.0.1:9100
 *   TS_API_BASE_URL=http://127.0.0.1:9100/api/v1 npm run start.web
 *   TS_CHAT_ARTIFACTS=<artifacts> \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 180000 src/app/chat/chat.e2e.ts
 *
 * The seed's table of people, ids and passwords is read from
 * `<artifacts>/seed.txt`, which the reset script writes. Each browser is one
 * device of one person, with its own profile in
 * `<artifacts>/profiles/<person>-<n>`, so what a device keeps survives from
 * one scenario to the next. Screenshots go to `<artifacts>/shots`.
 *
 * Scenarios run in the order they are written, each on the state the ones
 * before it left.
 */
const ARTIFACTS = process.env.TS_CHAT_ARTIFACTS ?? ''
const WEB = (process.env.TS_CHAT_WEB_URL ?? 'http://127.0.0.1:8080').replace(
  /\/+$/,
  ''
)
const SHOTS = join(ARTIFACTS, 'shots')

interface Seed {
  ids: Record<string, string>
  people: Record<string, { email: string; password: string }>
}

/** The seed's printed table, read back. */
function readSeed(): Seed {
  const text = readFileSync(join(ARTIFACTS, 'seed.txt'), 'utf8')
  const ids: Record<string, string> = {}
  const people: Seed['people'] = {}
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(
      /(Hawks|Eagles|Owls|QPLL|Spring 2027|\(final\)|video) ((?:tem|lea|sea|gam|vid)_\S+)/g
    )) {
      ids[match[1] === '(final)' ? 'hawksOwlsFinal' : match[1]] = match[2]
    }
    const person = /^(\S+)\s.*\s(\S+@\S+)\s+(\S+)$/.exec(line)
    if (person != null) {
      people[person[1]] = { email: person[2], password: person[3] }
    }
  }
  return { ids, people }
}

const browsers: Browser[] = []

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

/** One device of one person: a browser with its own lasting profile. */
async function device(person: string, n = 1): Promise<Page> {
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: join(ARTIFACTS, 'profiles', `${person}-${n}`),
    executablePath: process.env.TS_CHROME_PATH
  })
  browsers.push(browser)
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  return page
}

async function bodyText(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.innerText)
}

async function waitForText(page: Page, words: string): Promise<void> {
  await until(`"${words}" on the page`, async () =>
    (await bodyText(page)).includes(words)
  )
}

async function press(page: Page, label: string): Promise<void> {
  const node = await until(
    `${label} on the page`,
    async () => (await page.$(`[aria-label="${label}"]`)) ?? undefined
  )
  await node.click()
}

/** A button by the words it shows, for one with no label of its own. */
async function pressText(page: Page, words: string): Promise<void> {
  const node = await until(`a button saying ${words}`, async () => {
    for (const handle of await page.$$('[role="button"]')) {
      const said = await handle.evaluate(node => node.textContent)
      if (said?.endsWith(words) === true) return handle
    }
    return undefined
  })
  await node.click()
}

async function typeInto(
  page: Page,
  label: string,
  text: string
): Promise<void> {
  const input = await until(
    `the ${label} field`,
    async () => (await page.$(`input[aria-label="${label}"]`)) ?? undefined
  )
  await input.click({ count: 3 })
  await input.type(text)
}

/** Signs a device in with its person's password, if it is not already. */
async function signIn(page: Page, seed: Seed, person: string): Promise<void> {
  const who = seed.people[person]
  if (who == null) throw new Error(`No ${person} in the seed`)
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle2' })
  if ((await page.$('input[aria-label="E-mail address"]')) == null) return
  await typeInto(page, 'E-mail address', who.email)
  await pressText(page, 'Use a password instead')
  await typeInto(page, 'Password', who.password)
  await pressText(page, 'Sign in')
  await until('the sign-in to finish', async () =>
    (await page.$('input[aria-label="E-mail address"]')) == null
      ? true
      : undefined
  )
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
}

/** The team page's own sections, not the app's navigation. */
async function tabs(page: Page): Promise<string[]> {
  // No `??` or `?.` in here: this runs in the page, where the compiler's
  // helpers for them do not exist.
  return await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[aria-label="Team sections"] [role="tab"]')
    )
      .map(node => node.getAttribute('aria-label'))
      .filter((label): label is string => label !== null && label !== '')
  )
}

describe('chat scenarios in the browser', function () {
  let seed: Seed

  before(function () {
    if (ARTIFACTS === '') throw new Error('Set TS_CHAT_ARTIFACTS')
    mkdirSync(SHOTS, { recursive: true })
    seed = readSeed()
  })

  after(async function () {
    for (const browser of browsers) await browser.close()
  })

  /**
   * E17: Eagles parent D2 finds Hawks from Home, follows it, and opens it:
   * the schedule and the team, and nothing of its games.
   */
  it('E17: a fan follows Hawks and sees its schedule and team only', async function () {
    const page = await device('D2')
    await signIn(page, seed, 'D2')
    await waitForText(page, 'Follow a team')
    await shot(page, 'e17-1-home')
    await pressText(page, 'Follow a team')
    await until('the follow screen', () =>
      page.url().endsWith('/teams/follow') ? true : undefined
    )
    await typeInto(page, 'Team name', 'Haw')
    await press(page, 'Follow Hawks')
    await until(
      'Following',
      async () => (await page.$('[aria-label="Following Hawks"]')) ?? undefined
    )
    await shot(page, 'e17-2-following')

    await press(page, 'Hawks, QPLL Spring 2027')
    await until('the Hawks page', () =>
      page.url().includes(`/teams/${seed.ids.Hawks}`) ? true : undefined
    )
    await waitForText(page, 'vs Owls')
    expect(await tabs(page)).deep.equals(['Schedule', 'Team'])
    const schedule = await bodyText(page)
    expect(schedule).contains('vs Owls')
    expect(schedule).contains('@ Owls')
    expect(schedule).contains('@ Eagles')
    // The cards open nothing: no button carries a game's matchup.
    const cardButtons = await page.$$eval('[role="button"]', nodes =>
      nodes
        .map(node => node.getAttribute('aria-label'))
        .filter(label => label !== null && / (vs|@) /.test(label))
    )
    expect(cardButtons).deep.equals([])
    await shot(page, 'e17-3-schedule')

    await press(page, 'Team')
    await waitForText(page, 'Hank C')
    const team = await bodyText(page)
    for (const words of [
      'STAFF',
      'Harper H',
      'Admin',
      'Coach',
      'Scorekeeper',
      'Songkeeper',
      'PLAYERS',
      'Pat P'
    ]) {
      expect(team, words).contains(words)
    }
    expect(team).not.contains('FOLLOWERS')
    await shot(page, 'e17-4-team')

    await page.goto(`${WEB}/games/${seed.ids.hawksOwlsFinal}`, {
      waitUntil: 'networkidle2'
    })
    await waitForText(page, 'That game is not here')
    await shot(page, 'e17-5-final-game')
  })
})
