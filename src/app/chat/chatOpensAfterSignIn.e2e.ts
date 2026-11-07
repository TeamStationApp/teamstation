import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer'

import { readSeedTable } from '../../test/chatSeedTable'

/**
 * A fresh profile opens Chat in the same second as signing in.
 *
 *   scripts/chat-e2e-reset.sh <artifacts>
 *   npm start
 *   TS_API_BASE_URL=http://127.0.0.1:9100/api/v1 npm run start.web
 *   TS_CHAT_ARTIFACTS=<artifacts> \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 180000 src/app/chat/chatOpensAfterSignIn.e2e.ts
 *
 * The web app is `TS_CHAT_WEB_URL` (default http://127.0.0.1:8080). The
 * seed table is `<artifacts>/seed.txt`.
 */
const ARTIFACTS = process.env.TS_CHAT_ARTIFACTS ?? ''
const WEB = (process.env.TS_CHAT_WEB_URL ?? 'http://127.0.0.1:8080').replace(
  /\/+$/,
  ''
)

const CHAT_LIST = '[data-testid="chat-conversation-list"]'

function seedPerson(): { email: string; password: string } {
  if (ARTIFACTS === '') throw new Error('Set TS_CHAT_ARTIFACTS')
  const people = readSeedTable(
    readFileSync(join(ARTIFACTS, 'seed.txt'), 'utf8')
  )
  const person = Object.values(people)[0]
  if (person == null) throw new Error('The seed table has no people')
  return person
}

async function until(
  what: string,
  read: () => boolean | Promise<boolean>,
  timeoutMs: number,
  detail?: () => Promise<string>
): Promise<void> {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (await read()) return
    if (Date.now() > end) {
      const extra = detail == null ? '' : await detail()
      throw new Error(`Timed out waiting for ${what}: ${extra.slice(0, 500)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

async function bodyText(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.innerText)
}

async function pressText(page: Page, words: string): Promise<void> {
  let found: ElementHandle | undefined
  await until(
    `a button saying ${words}`,
    async () => {
      for (const handle of await page.$$('[role="button"]')) {
        const said = await handle.evaluate(node => node.textContent)
        if (said != null && said.endsWith(words)) {
          found = handle
          return true
        }
      }
      return false
    },
    10000
  )
  if (found == null) throw new Error(`No button saying ${words}`)
  await found.click()
}

async function typeInto(
  page: Page,
  label: string,
  text: string
): Promise<void> {
  const input = await page.waitForSelector(`input[aria-label="${label}"]`)
  if (input == null) throw new Error(`No ${label} field`)
  for (let attempt = 0; attempt < 3; attempt++) {
    await input.click({ count: 3 })
    await page.keyboard.press('Backspace')
    await input.type(text)
    const held = await input.evaluate(node => node.value)
    if (held === text) return
  }
  throw new Error(`The ${label} field would not take the typed text`)
}

describe('chat opens in the same second as sign-in', function () {
  this.timeout(180000)
  let browser: Browser | undefined
  let page: Page | undefined
  let profile = ''

  after(async () => {
    await browser?.close()
    if (profile !== '') rmSync(profile, { recursive: true, force: true })
  })

  it('leaves Opening chat, and a reload does too', async () => {
    const who = seedPerson()
    profile = mkdtempSync(join(tmpdir(), 'chat-opens-'))
    browser = await puppeteer.launch({
      headless: true,
      userDataDir: profile,
      executablePath: process.env.TS_CHROME_PATH
    })
    page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    const finished: string[] = []
    page.on('requestfinished', request => {
      const url = request.url()
      const method = request.method()
      if (
        url.includes('/chat/me/keys') ||
        (method === 'POST' && /\/chat\/devices$/.test(new URL(url).pathname))
      ) {
        finished.push(`${method} ${url}`)
      }
    })
    await page.goto(`${WEB}/`, { waitUntil: 'networkidle2' })
    await typeInto(page, 'E-mail address', who.email)
    await pressText(page, 'Use a password instead')
    await typeInto(page, 'Password', who.password)
    await pressText(page, 'Sign in')
    await until(
      'the sign-in to finish',
      async () => (await page!.$('input[aria-label="E-mail address"]')) == null,
      30000
    )
    const names = (await page.cookies()).map(cookie => cookie.name)
    if (!names.includes('ts_session')) {
      throw new Error(`Signed in without ts_session (${names.join(', ')})`)
    }
    await page.goto(`${WEB}/chat`, { waitUntil: 'domcontentloaded' })
    await until(
      'chat to leave Opening chat',
      async () => {
        const text = await bodyText(page!)
        if (text.includes('Opening chat')) return false
        const list = await page!.$(CHAT_LIST)
        return list != null || text.includes('Link this device')
      },
      20000,
      async () => await bodyText(page!)
    )
    expect(finished.length).to.be.greaterThan(0)
    const shots = join(ARTIFACTS, 'shots')
    mkdirSync(shots, { recursive: true })
    await page.screenshot({
      path: join(shots, 'opening-chat-after.png') as `${string}.png`
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await until(
      'a reloaded chat to leave Opening chat',
      async () => {
        const text = await bodyText(page!)
        if (text.includes('Opening chat')) return false
        const list = await page!.$(CHAT_LIST)
        return list != null || text.includes('Link this device')
      },
      20000
    )
    await page.screenshot({
      path: join(shots, 'opening-chat-reload-after.png') as `${string}.png`
    })
  })
})
