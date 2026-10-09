import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import puppeteer, { type Browser, type Page } from 'puppeteer'

/**
 * Chat without its crypto core, in a browser (S2, S3).
 *
 *   TS_CHAT_ARTIFACTS=<run dir> TS_CHAT_WEB_URL=<web app> \
 *     TS_CHAT_API_URL=<API> TS_CHAT_API_LOG=<API output file> \
 *     node -r sucrase/register src/app/chat/chatNoWasm.e2e.ts noWasm|badModule
 *
 * Parent B (from `<run dir>/seed.txt`) signs in on a fresh browser profile:
 *
 * - `noWasm`: the page has no `WebAssembly` (removed before any script runs;
 *   Chrome ignores `--js-flags=--noexpose_wasm` here). Chat, Chat devices and
 *   the link screen each say "Chat needs WebAssembly"; the module is never
 *   asked for; the page makes no `ts-chat` key database before or after
 *   sign-out; B's devices are the same before and after; Home and the
 *   Schedule still work; and when Hc posts to Hawks Members from the run's
 *   own Hc-1 profile, B's Chat tab shows the unread dot.
 * - `badModule`: the module arrives with one byte changed (its integrity
 *   fails), then not at all (404). Each time Chat says "Chat needs
 *   WebAssembly", the reason `fetchFailed` reaches the console and the API's
 *   log as `[client chatCore-web]`, and nothing is made.
 *
 * Screenshots go to `<run dir>/shots/no-wasm-*.png`. It fails on the first
 * thing that is not so.
 */
const ARTIFACTS = process.env.TS_CHAT_ARTIFACTS ?? ''
const WEB = (process.env.TS_CHAT_WEB_URL ?? 'http://127.0.0.1:8080').replace(
  /\/+$/,
  ''
)
const API = (process.env.TS_CHAT_API_URL ?? `${WEB}/api/v1`).replace(/\/+$/, '')
const API_LOG = process.env.TS_CHAT_API_LOG ?? ''
const SHOTS = join(ARTIFACTS, 'shots')
const NEEDS = 'Chat needs WebAssembly'

interface Person {
  email: string
  password: string
}

function seedPerson(key: string): Person {
  const row = readFileSync(join(ARTIFACTS, 'seed.txt'), 'utf8')
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .find(cells => cells[0] === key)
  if (row == null) throw new Error(`${key} is not in the seed table`)
  return { email: row[4], password: row[5] }
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAIL ${what}`)
  console.log(`  ok ${what}`)
}

async function until<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 30000
): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value != null && value !== false) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

const bodyText = async (page: Page): Promise<string> =>
  await page.evaluate(() => document.body.innerText)

async function waitForText(page: Page, words: string): Promise<void> {
  await until(`"${words}" on the page`, async () =>
    (await bodyText(page)).includes(words)
  )
}

async function signIn(page: Page, person: Person): Promise<void> {
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle2' })
  const field = async (label: string): Promise<void> => {
    const input = await until(
      `the ${label} field`,
      async () => (await page.$(`input[aria-label="${label}"]`)) ?? undefined
    )
    await input.type(label === 'Password' ? person.password : person.email)
  }
  const button = async (words: string): Promise<void> => {
    const node = await until(`a button saying ${words}`, async () => {
      for (const handle of await page.$$('[role="button"]')) {
        const said = await handle.evaluate(node => node.textContent)
        if (said?.endsWith(words) === true) return handle
      }
      return undefined
    })
    await node.click()
  }
  await field('E-mail address')
  await button('Use a password instead')
  await field('Password')
  await button('Sign in')
  await until('the sign-in to finish', async () =>
    (await page.$('input[aria-label="E-mail address"]')) == null
      ? true
      : undefined
  )
}

async function apiGet(page: Page, path: string): Promise<any> {
  return await page.evaluate(async (url: string) => {
    const response = await fetch(url, { credentials: 'include' })
    return await response.json()
  }, `${API}${path}`)
}

/** Whether the page has a `ts-chat` IndexedDB database. */
async function hasKeyDatabase(page: Page): Promise<boolean> {
  return await page.evaluate(async () =>
    (await indexedDB.databases()).some(found => found.name === 'ts-chat')
  )
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `no-wasm-${name}.png`) })
}

interface Watched {
  browser: Browser
  page: Page
  moduleRequests: string[]
  console: string[]
}

/** A fresh profile, watching module requests and the console. */
async function freshBrowser(
  setup: (page: Page) => Promise<void>
): Promise<Watched & { profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'ts-no-wasm-'))
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: profile,
    executablePath: process.env.TS_CHROME_PATH
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  const watched: Watched & { profile: string } = {
    browser,
    page,
    moduleRequests: [],
    console: [],
    profile
  }
  page.on('request', request => {
    if (request.url().includes('chat-crypto')) {
      watched.moduleRequests.push(request.url())
    }
  })
  page.on('console', message => {
    watched.console.push(message.text())
  })
  await setup(page)
  return watched
}

async function signOut(page: Page): Promise<void> {
  await page.goto(`${WEB}/account`, { waitUntil: 'networkidle2' })
  const node = await until('Sign out', async () => {
    for (const handle of await page.$$('[role="button"]')) {
      const said = await handle.evaluate(found => found.textContent)
      if (said?.trim() === 'Sign out') return handle
    }
    return undefined
  })
  await node.click()
  await until('the sign-in screen', async () =>
    (await page.$('input[aria-label="E-mail address"]')) != null
      ? true
      : undefined
  )
}

const liveDevices = (
  devices: Array<{ id: string; revokedAt?: unknown }>
): string =>
  devices
    .filter(found => found.revokedAt == null)
    .map(found => found.id)
    .sort()
    .join(',')

async function noWasm(): Promise<void> {
  const b = seedPerson('B')
  const one = await freshBrowser(async page => {
    await page.evaluateOnNewDocument(() => {
      // As a browser without it, or with it turned off.
      delete (globalThis as { WebAssembly?: unknown }).WebAssembly
    })
  })
  const { page } = one
  try {
    await signIn(page, b)
    check(!(await hasKeyDatabase(page)), 'no ts-chat database at sign-in')
    const devicesBefore = liveDevices(await apiGet(page, '/chat/devices'))

    for (const [path, name] of [
      ['/chat', 'chat'],
      ['/chat/devices', 'devices'],
      ['/chat/link', 'link']
    ]) {
      await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle2' })
      await waitForText(page, NEEDS)
      await shot(page, name)
      check(true, `${path} says "${NEEDS}"`)
    }
    check(one.moduleRequests.length === 0, 'the module was never asked for')
    check(!(await hasKeyDatabase(page)), 'no ts-chat database after Chat')
    check(
      liveDevices(await apiGet(page, '/chat/devices')) === devicesBefore,
      'no device was registered'
    )

    for (const path of ['/', '/schedule']) {
      await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle2' })
      check(!(await bodyText(page)).includes(NEEDS), `${path} works`)
    }

    // Hc posts from a browser with the core; B's tab gets the dot.
    const members = (
      (await apiGet(page, '/chat/conversations')) as Array<{
        id: string
        title: string
      }>
    ).find(chat => chat.title === 'Hawks Members')
    if (members == null) throw new Error('B is not in Hawks Members')
    await page.goto(`${WEB}/`, { waitUntil: 'networkidle2' })
    const hc = await puppeteer.launch({
      headless: true,
      userDataDir: join(ARTIFACTS, 'profiles', 'Hc-1'),
      executablePath: process.env.TS_CHROME_PATH
    })
    try {
      const hcPage = await hc.newPage()
      await hcPage.goto(`${WEB}/chat/${members.id}`, {
        waitUntil: 'networkidle2'
      })
      const field = await until(
        'an enabled composer',
        async () =>
          (await hcPage.$('textarea[aria-label="Message"]:not([readonly])')) ??
          undefined
      )
      await field.click()
      await field.type('Hello from a browser with WebAssembly')
      const send = await until(
        'Send',
        async () => (await hcPage.$('[aria-label="Send"]')) ?? undefined
      )
      await send.click()
      // Sent once the composer empties; closing sooner can lose the post.
      await until(
        'the message sent',
        async () =>
          await (
            await hcPage.$('textarea[aria-label="Message"]')
          )?.evaluate(node => node.value === '')
      )
    } finally {
      await hc.close()
    }
    await until(
      "the Chat tab's unread dot",
      async () => (await page.$('[data-testid="chat-unread"]')) ?? undefined
    )
    await shot(page, 'unread-dot')
    check(true, 'the unread dot appears without the core')

    await signOut(page)
    check(!(await hasKeyDatabase(page)), 'no ts-chat database after sign-out')
  } finally {
    await one.browser.close()
    rmSync(one.profile, { recursive: true, force: true })
  }
}

async function badModule(): Promise<void> {
  const b = seedPerson('B')
  for (const how of ['altered', 'missing'] as const) {
    // The last piece is the line still being written, or nothing.
    const logLines = readFileSync(API_LOG, 'utf8').split('\n').length - 1
    const run = await freshBrowser(async page => {
      await page.setRequestInterception(true)
      page.on('request', request => {
        if (!request.url().includes('chat-crypto')) {
          request.continue().catch(() => undefined)
          return
        }
        if (how === 'missing') {
          request.respond({ status: 404, body: 'gone' }).catch(() => undefined)
          return
        }
        fetch(request.url())
          .then(async response => Buffer.from(await response.arrayBuffer()))
          .then(async bytes => {
            bytes[bytes.length - 1] ^= 1
            await request.respond({
              status: 200,
              contentType: 'application/wasm',
              body: bytes
            })
          })
          .catch(() => undefined)
      })
    })
    const { page } = run
    try {
      await signIn(page, b)
      const devicesBefore = liveDevices(await apiGet(page, '/chat/devices'))
      await page.goto(`${WEB}/chat`, { waitUntil: 'networkidle2' })
      await waitForText(page, NEEDS)
      await shot(page, `bad-module-${how}`)
      check(true, `the ${how} module: "${NEEDS}"`)
      check(
        run.console.some(line => line.includes('fetchFailed')),
        `the ${how} module: fetchFailed in the console`
      )
      await until(`the ${how} module's reason in the API log`, () =>
        readFileSync(API_LOG, 'utf8')
          .split('\n')
          .slice(logLines)
          .some(
            line =>
              line.includes('chatCore-web') && line.includes('fetchFailed')
          )
      )
      check(true, `the ${how} module: [client chatCore-web] fetchFailed logged`)
      check(!(await hasKeyDatabase(page)), `the ${how} module: no keys`)
      check(
        liveDevices(await apiGet(page, '/chat/devices')) === devicesBefore,
        `the ${how} module: no device`
      )
    } finally {
      await run.browser.close()
      rmSync(run.profile, { recursive: true, force: true })
    }
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (ARTIFACTS === '' || (mode !== 'noWasm' && mode !== 'badModule')) {
    throw new Error(
      'usage: TS_CHAT_ARTIFACTS=<run> chatNoWasm.e2e.ts noWasm|badModule'
    )
  }
  if (mode === 'badModule' && API_LOG === '') {
    throw new Error('badModule reads the API log: set TS_CHAT_API_LOG')
  }
  mkdirSync(SHOTS, { recursive: true })
  if (mode === 'noWasm') await noWasm()
  else await badModule()
  console.log(`PASS ${mode}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
