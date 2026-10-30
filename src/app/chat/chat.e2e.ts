import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, afterEach, describe, it } from 'mocha'
import { Pool } from 'pg'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { presignGetUrl } from '../../server/media/presign'
import { chatRowSelector } from '../../test/chatRows'
import { readSeedTable } from '../../test/chatSeedTable'

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
 * `<artifacts>/seed.txt`, which the reset script writes. With no mail relay
 * configured the API logs every invitation and sign-in code instead of
 * sending it; run it with its output in a file and name that file in
 * `TS_CHAT_API_LOG` (E2 reads both from it). Database checks connect to the
 * `databaseUrl` of the local `serverConfig.json`. Each browser is one
 * device of one person, with its own profile in
 * `<artifacts>/profiles/<person>-<n>`, so what a device keeps survives from
 * one scenario to the next — a browser's chat keys included (E5). Pages call
 * the API themselves at `TS_CHAT_API_URL` (default the API above) for what
 * the screens do not show. Screenshots go to `<artifacts>/shots`, and a
 * failed scenario leaves `failed-<scenario>-<device>.png` of every open
 * device. E11 attaches `photo.jpg` and a 20 MB `clip.mp4` from
 * `TS_CHAT_FIXTURES` (default `<artifacts>/../fixtures`) and reads the
 * stand-in Space's files under `TS_FAKE_SPACE_DIR`.
 *
 * **On a deployed copy of the branch** (`TS_CHAT_WEB_URL` and
 * `TS_CHAT_API_URL` on its address), database checks run where its database
 * is instead: `TS_CHAT_SEAT_SSH` is the ssh target there, and
 * `TS_CHAT_SEAT_PSQL` the command, run there, that opens its database in
 * psql. `TS_CHAT_API_LOG` is a local file the runner keeps filled with that
 * API's log. E11 reads the Space objects from its bucket with the key named
 * by `TS_CHAT_SPACE_KEY` in the JSON file `TS_CHAT_SPACE_KEYS` (its
 * `endpoint`, `region`, `bucket`, `accessKeyId`, `secretAccessKey`). Its
 * database is reset beforehand (recreated, migrated, and seeded with
 * `npm run chat-seed`), and the seed's output is the run's `seed.txt`.
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
const API = (
  process.env.TS_CHAT_API_URL ?? 'http://127.0.0.1:9100/api/v1'
).replace(/\/+$/, '')
const API_LOG = process.env.TS_CHAT_API_LOG ?? ''
const SEAT_SSH = process.env.TS_CHAT_SEAT_SSH ?? ''
const SEAT_PSQL = process.env.TS_CHAT_SEAT_PSQL ?? ''

interface Seed {
  ids: Record<string, string>
  people: Record<string, { userId: string; email: string; password: string }>
}

/** The seed's printed table, read back. */
function readSeed(): Seed {
  const text = readFileSync(join(ARTIFACTS, 'seed.txt'), 'utf8')
  const ids: Record<string, string> = {}
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(
      /(Hawks|Eagles|Owls|QPLL|Spring 2027|\(final\)|video) ((?:tem|lea|sea|gam|vid)_\S+)/g
    )) {
      ids[match[1] === '(final)' ? 'hawksOwlsFinal' : match[1]] = match[2]
    }
  }
  return { ids, people: readSeedTable(text) }
}

const browsers: Browser[] = []

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

/** The devices open now, by `<person>-<n>`, so a scenario reuses one. */
const open = new Map<string, { browser: Browser; page: Page }>()

/**
 * One device of one person: a browser with its own lasting profile, the
 * one already open if a scenario before left it open.
 */
async function device(person: string, n = 1): Promise<Page> {
  const key = `${person}-${n}`
  const held = open.get(key)
  if (held?.browser.connected === true) return held.page
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: join(ARTIFACTS, 'profiles', key),
    executablePath: process.env.TS_CHROME_PATH
  })
  browsers.push(browser)
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  open.set(key, { browser, page })
  // On the app, so the page's own calls to the API carry its session.
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle2' })
  return page
}

/** Closes a device's browser; its profile (and keys) stay on disk. */
async function closeDevice(person: string, n = 1): Promise<void> {
  const key = `${person}-${n}`
  await open.get(key)?.browser.close()
  open.delete(key)
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
  // Typed again until the field holds it all: a busy machine can drop keys
  // while the screen redraws under the typing.
  for (let attempt = 0; attempt < 3; attempt++) {
    await input.click({ count: 3 })
    await page.keyboard.press('Backspace')
    await input.type(text)
    const held = await input.evaluate(node => node.value)
    if (held === text) return
  }
  throw new Error(`The ${label} field would not take "${text}"`)
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

/**
 * The last line the API logged for a mail it did not send, once it is
 * there: `[no mail configured] <what> for <address>: <rest>`. Only lines
 * after `skip` count, so a later mail is never mistaken for an earlier one.
 */
async function logged(
  what: 'invitation' | 'sign-in code',
  address: string,
  skip = 0
): Promise<string> {
  if (API_LOG === '' || !existsSync(API_LOG)) {
    throw new Error('Set TS_CHAT_API_LOG to the API output file')
  }
  const prefix = `[no mail configured] ${what} for ${address}: `
  return await until(`the ${what} for ${address} in the API log`, () => {
    const lines = readFileSync(API_LOG, 'utf8').split('\n').slice(skip)
    const line = lines.filter(row => row.includes(prefix)).at(-1)
    return line?.slice(line.indexOf(prefix) + prefix.length).trim()
  })
}

/** How many lines the API log has, to read only what comes after. */
function logLength(): number {
  return API_LOG === '' || !existsSync(API_LOG)
    ? 0
    : // The last piece is the line still being written, or nothing.
      readFileSync(API_LOG, 'utf8').split('\n').length - 1
}

/** Where the checks the screens cannot make are read. */
interface CheckDatabase {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>
  end: () => Promise<void>
}

/**
 * The database the API runs on: the local `serverConfig.json`'s, or on a
 * deployed copy, its own database, reached over ssh.
 */
function database(): CheckDatabase {
  if (SEAT_SSH !== '') return seatDatabase()
  const config = JSON.parse(readFileSync('serverConfig.json', 'utf8')) as {
    databaseUrl: string
  }
  if (
    !/^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl)
  ) {
    throw new Error('serverConfig.json does not name a local database')
  }
  const pool = new Pool({ connectionString: config.databaseUrl })
  return {
    query: async (sql, values) => await pool.query(sql, values),
    end: async () => {
      await pool.end()
    }
  }
}

/** A value written into SQL, for the seat's psql, which takes no parameters. */
function sqlLiteral(value: unknown): string {
  if (value == null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return sqlLiteral(
      `{${value
        .map(item => `"${String(item).replace(/["\\]/g, '\\$&')}"`)
        .join(',')}}`
    )
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * The seat's database, read with `TS_CHAT_SEAT_PSQL` at `TS_CHAT_SEAT_SSH`.
 * Each query's rows come back as JSON, so numbers read as numbers where the
 * local driver hands back strings; the checks compare through `Number()`.
 */
function seatDatabase(): CheckDatabase {
  if (SEAT_PSQL === '') {
    throw new Error(
      'TS_CHAT_SEAT_PSQL must name the command that opens the seat database'
    )
  }
  return {
    query: async (sql, values = []) => {
      const text = sql.replace(/\$(\d+)/g, (_, n: string) =>
        sqlLiteral(values[Number(n) - 1])
      )
      const out = execFileSync(
        'ssh',
        [SEAT_SSH, `${SEAT_PSQL} -X -A -t -q -v ON_ERROR_STOP=1`],
        {
          input: `select coalesce(json_agg(t), '[]'::json) from (${text}) t;\n`,
          encoding: 'utf8'
        }
      )
      return { rows: JSON.parse(out.trim()) as any[] }
    },
    end: async () => {}
  }
}

/**
 * The first bytes of a stored attachment: from the stand-in Space's files,
 * or on a seat from its bucket, signed with its key.
 */
async function objectHead(objectKey: string): Promise<Buffer> {
  const keyName = process.env.TS_CHAT_SPACE_KEY ?? ''
  if (keyName === '') {
    const space =
      process.env.TS_FAKE_SPACE_DIR ?? '/tmp/ts-encryptedChat-m13/space'
    return readFileSync(join(space, ...objectKey.split('/'))).subarray(0, 12)
  }
  const keys = (
    JSON.parse(
      readFileSync(process.env.TS_CHAT_SPACE_KEYS ?? '', 'utf8')
    ) as Record<
      string,
      {
        endpoint: string
        region: string
        bucket: string
        accessKeyId: string
        secretAccessKey: string
      }
    >
  )[keyName]
  const url = presignGetUrl({
    endpoint: keys.endpoint,
    region: keys.region,
    bucket: keys.bucket,
    accessKeyId: keys.accessKeyId,
    secretAccessKey: keys.secretAccessKey,
    key: objectKey,
    expiresSec: 300
  })
  const response = await fetch(url, { headers: { range: 'bytes=0-11' } })
  if (!response.ok) {
    throw new Error(`${keys.bucket}/${objectKey}: HTTP ${response.status}`)
  }
  return Buffer.from(await response.arrayBuffer()).subarray(0, 12)
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
}

/**
 * A GET of the API from inside the page, with the page's own session, as
 * the app itself would make it.
 */
async function apiGet(page: Page, path: string): Promise<any> {
  return await page.evaluate(async (url: string) => {
    const response = await fetch(url, { credentials: 'include' })
    return { status: response.status, body: await response.json() }
  }, `${API}${path}`)
}

/** Any call to the API from inside the page, with its session. */
async function apiCall(
  page: Page,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return await page.evaluate(
    async (url: string, verb: string, sent: string | null) => {
      const response = await fetch(url, {
        method: verb,
        credentials: 'include',
        headers: sent === null ? {} : { 'content-type': 'application/json' },
        // A ternary, not `??`: this runs in the page, where the compiler's
        // helper for it does not exist.
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        body: sent === null ? undefined : sent
      })
      const text = await response.text()
      return {
        status: response.status,
        body: text === '' ? null : JSON.parse(text)
      }
    },
    `${API}${path}`,
    method,
    body === undefined ? null : JSON.stringify(body)
  )
}

/** The id of the chat called `title` in the page's person's list. */
async function chatIdOf(page: Page, title: string): Promise<string> {
  return await until(`the chat ${title}`, async () => {
    const list = (await apiGet(page, '/chat/conversations')).body as Array<{
      id: string
      title: string | null
      members?: unknown
    }>
    return list.find(chat => chat.title === title)?.id
  })
}

/** A DM's id from the page's list, by the user ids in it. */
async function dmWith(page: Page, userIds: string[]): Promise<string> {
  return await until(`a DM with ${userIds.join(', ')}`, async () => {
    const list = (await apiGet(page, '/chat/conversations')).body as Array<{
      id: string
      kind: string
      closed: boolean
    }>
    for (const chat of list) {
      if (chat.kind !== 'dm' || chat.closed) continue
      const members = (
        await apiGet(page, `/chat/conversations/${chat.id}/members`)
      ).body as Array<{ userId: string }>
      const ids = members.map(member => member.userId).sort()
      if (JSON.stringify(ids) === JSON.stringify([...userIds].sort())) {
        return chat.id
      }
    }
    return undefined
  })
}

const CHAT_LIST = '[data-testid="chat-conversation-list"]'

/**
 * Waits for the Chat tab's list, which the tab draws once the device is set
 * up for chat (after a link, or a reset), whatever chats it holds.
 */
async function waitForChatList(page: Page): Promise<void> {
  await until('the chat list', async () => {
    const text = await bodyText(page)
    const list = await page.$(CHAT_LIST)
    return list != null && !text.includes('Opening chat') ? true : undefined
  })
}

/** Opens the Chat tab, which sets the device up for chat, and waits. */
async function openChatTab(page: Page): Promise<void> {
  await page.goto(`${WEB}/chat`, { waitUntil: 'networkidle2' })
  await waitForChatList(page)
}

/**
 * Opens one chat from the Chat tab's list. A row is named by its title and
 * then what it shows (`<title>, <latest message>, <n> unread`), so it is
 * found by the title as the leading part of its name.
 */
async function openChat(page: Page, title: string): Promise<void> {
  await openChatTab(page)
  const row = await until(
    `the chat ${title} in the list`,
    async () => (await page.$(chatRowSelector(title, CHAT_LIST))) ?? undefined
  )
  await row.click()
  await until(`the chat ${title}`, () =>
    /\/chat\/cnv_[^/]+$/.test(page.url()) ? true : undefined
  )
  await until('the chat to load', async () =>
    (await bodyText(page)).includes('members') ? true : undefined
  )
}

/** Types a message into the composer and sends it. */
async function send(page: Page, text: string): Promise<void> {
  const field = await until(
    'an enabled composer',
    async () =>
      (await page.$('textarea[aria-label="Message"]:not([readonly])')) ??
      undefined,
    30000
  )
  await field.click()
  await field.type(text)
  await press(page, 'Send')
  await until(
    `"${text}" sent`,
    async () =>
      await (
        await page.$('textarea[aria-label="Message"]')
      )?.evaluate(node => node.value === '')
  )
}

/** Holds the mouse on a message's words until its menu opens. */
async function longPress(page: Page, words: string): Promise<void> {
  const node = await until(
    `"${words}" on the page`,
    async () =>
      (await page.$(`::-p-text(${JSON.stringify(words)})`)) ?? undefined
  )
  await node.scrollIntoView()
  const box = await node.boundingBox()
  if (box == null) throw new Error(`"${words}" is not on the screen`)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await new Promise(resolve => setTimeout(resolve, 900))
  await page.mouse.up()
}

/** Presses the button saying `words` in the row that holds `row`. */
async function pressInRow(
  page: Page,
  row: string,
  words: string
): Promise<void> {
  const done = await page.evaluate(
    (rowText: string, label: string) => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>('[role="button"]')
      ).filter(node => String(node.textContent).trim() === label)
      let best: HTMLElement | null = null
      let bestSize = Infinity
      for (const button of buttons) {
        let at: HTMLElement | null = button
        while (at !== null && !String(at.innerText).includes(rowText)) {
          at = at.parentElement
        }
        if (at === null) continue
        const size = String(at.innerText).length
        if (size < bestSize) {
          best = button
          bestSize = size
        }
      }
      if (best === null) return false
      best.click()
      return true
    },
    row,
    words
  )
  if (!done) throw new Error(`No ${words} in the row of ${row}`)
}

/** The digits in the first `[aria-label^="<prefix>"]`, once it is there. */
async function codeOn(page: Page, prefix: string): Promise<string> {
  return await until(`the six digits on the page`, async () => {
    const node = await page.$(`[aria-label^="${prefix}"]`)
    const label = await node?.evaluate(found =>
      found.getAttribute('aria-label')
    )
    return /(\d{6})$/.exec(label ?? '')?.[1]
  })
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

  /** A person's main device, signed in (once) with their password. */
  async function signedIn(person: string): Promise<Page> {
    const page = await device(person)
    await signIn(page, seed, person)
    return page
  }

  afterEach(async function () {
    // A failed scenario leaves a picture of every device as it stood.
    if (this.currentTest?.state !== 'failed') return
    const name = (
      this.currentTest.title.split(':')[0] ?? 'failed'
    ).toLowerCase()
    for (const [key, held] of open) {
      if (!held.browser.connected) continue
      await held.page
        .screenshot({
          path: join(SHOTS, `failed-${name}-${key}.png`),
          fullPage: true
        })
        .catch(() => undefined)
    }
  })

  after(async function () {
    for (const browser of browsers) await browser.close()
  })

  /**
   * E2: coach Hc keeps P's guardians and family from P's Settings tab. The
   * aunt, who has no account, joins through her invitation; parent D cannot
   * use the uncle's; parent B is linked as family; G1 is unlinked.
   */
  it('E2: guardians and family from the player’s Settings tab', async function () {
    const db = database()
    try {
      const pat = seed.people.P
      const hawks = seed.ids.Hawks
      const coach = await device('Hc')
      await signIn(coach, seed, 'Hc')
      await coach.goto(`${WEB}/players/${pat.userId}?onTeam=${hawks}`, {
        waitUntil: 'networkidle2'
      })
      await press(coach, 'Settings')
      await waitForText(coach, 'GUARDIANS AND FAMILY')
      await waitForText(coach, 'Glen Guardian')
      const listed = await bodyText(coach)
      expect(listed).contains('Gale Guardian')
      expect(listed).contains('Guardian · g1@chat.example.com')
      expect(listed).contains('Guardian · g2@chat.example.com')
      await shot(coach, 'e2-1-settings-guardians')

      // The aunt has no account: an invitation is mailed (logged).
      await press(coach, 'Change guardians and family')
      await waitForText(coach, 'Guardians and family of Pat P')
      const auntAddress = 'aunt@chat.example.com'
      const before = logLength()
      await typeInto(coach, 'E-mail address or name', auntAddress)
      await press(coach, 'Add by e-mail')
      await waitForText(coach, `An invitation is on its way to ${auntAddress}`)
      await shot(coach, 'e2-2-aunt-invited')
      const auntLink = await logged('invitation', auntAddress, before)
      const auntCode = /\/i\/([^/\s]+)$/.exec(auntLink)?.[1] ?? ''
      expect(auntCode).not.equals('')

      const aunt = await device('Aunt')
      await aunt.goto(`${WEB}/i/${auntCode}`, { waitUntil: 'networkidle2' })
      await waitForText(aunt, 'You are invited to watch Hawks')
      await typeInto(aunt, 'Your name', 'Ava Aunt')
      await typeInto(aunt, 'E-mail address', auntAddress)
      const beforeCode = logLength()
      await pressText(aunt, 'Send me a sign-in code')
      const code = await logged('sign-in code', auntAddress, beforeCode)
      await typeInto(aunt, 'Sign-in code', code.split(/\s/)[0])
      await pressText(aunt, 'Join')
      await waitForText(aunt, 'You are in. Hawks is on your home screen.')
      await shot(aunt, 'e2-3-aunt-joined')

      // The uncle's invitation, opened by parent D signed in as D.
      const uncleAddress = 'uncle@chat.example.com'
      const beforeUncle = logLength()
      await typeInto(coach, 'E-mail address or name', uncleAddress)
      await press(coach, 'Add by e-mail')
      await waitForText(coach, `An invitation is on its way to ${uncleAddress}`)
      const uncleLink = await logged('invitation', uncleAddress, beforeUncle)
      const uncleCode = /\/i\/([^/\s]+)$/.exec(uncleLink)?.[1] ?? ''
      const parentD = await device('D')
      await signIn(parentD, seed, 'D')
      await parentD.goto(`${WEB}/i/${uncleCode}`, {
        waitUntil: 'networkidle2'
      })
      await pressText(parentD, 'Accept the invitation')
      await waitForText(
        parentD,
        'This invitation was sent to another e-mail address.'
      )
      await shot(parentD, 'e2-4-d-refused')

      // Parent B, picked from the team, as an adult family member.
      await press(coach, 'Adult family member')
      await typeInto(coach, 'E-mail address or name', 'Bla')
      await press(coach, 'Add Blair B')
      await waitForText(coach, 'Blair B is linked.')
      await waitForText(coach, 'Family · b@chat.example.com')
      await shot(coach, 'e2-5-b-family')

      // G1 removed.
      await press(coach, 'Remove Gale Guardian')
      await until('G1 to leave the list', async () =>
        (await bodyText(coach)).includes('Gale Guardian') ? undefined : true
      )
      await shot(coach, 'e2-6-g1-removed')
      await pressText(coach, 'Done')
      await until('the Settings tab list to drop G1', async () => {
        const text = await bodyText(coach)
        return !text.includes('Gale Guardian') && text.includes('Ava Aunt')
          ? true
          : undefined
      })
      await shot(coach, 'e2-7-settings-after')

      // What the screens cannot show, read from the database.
      const query = async <T>(sql: string, values: unknown[]): Promise<T[]> =>
        (await db.query(sql, values)).rows as T[]
      const people = Object.fromEntries(
        ['B', 'D', 'G1'].map(key => [key, seed.people[key].userId])
      )
      const b = await query<{ kind: string; links: string }>(
        `select l.kind,
           (select count(*) from memberships m where m.user_id = $1)::text as links
         from user_links l where l.user_id = $1 and l.related_user_id = $2`,
        [people.B, pat.userId]
      )
      expect(b).deep.equals([{ kind: 'family', links: '1' }])
      const bMembership = await query<{ granted: string | null }>(
        `select granted_by_link_id as granted from memberships
         where user_id = $1 and team_id = $2`,
        [people.B, hawks]
      )
      expect(bMembership).deep.equals([{ granted: null }])

      const auntRows = await query<{ kind: string; same: boolean }>(
        `select l.kind, m.granted_by_link_id = l.id as same
         from user_emails e
         join user_links l on l.user_id = e.user_id and l.related_user_id = $2
         join memberships m on m.user_id = e.user_id and m.team_id = $3
         where lower(e.email) = $1`,
        [auntAddress, pat.userId, hawks]
      )
      expect(auntRows).deep.equals([{ kind: 'guardian', same: true }])

      const dLinks = await query<{ id: string }>(
        'select id from user_links where user_id = $1',
        [people.D]
      )
      expect(dLinks).deep.equals([])
      const uncleUses = await query<{ uses: number }>(
        'select uses from invites where lower(code) = lower($1)',
        [uncleCode]
      )
      expect(uncleUses).deep.equals([{ uses: 0 }])

      const g1 = await query<{ id: string }>(
        `select id from user_links where user_id = $1 and related_user_id = $2
         union all
         select id from memberships where user_id = $1 and team_id = $3`,
        [people.G1, pat.userId, hawks]
      )
      expect(g1).deep.equals([])
    } finally {
      await db.end()
    }
  })
  /**
   * E5: parent B opens Chat devices in a first browser, which enrols. A
   * second browser signed in as B opens it too and asks to be linked; both
   * show the same six digits, and the first approves. Then both list the
   * same two devices, and both sessions hold the same identity key.
   */
  it('E5: a second device is linked by matching six digits', async function () {
    const first = await device('B', 1)
    await signIn(first, seed, 'B')
    await first.goto(`${WEB}/chat/devices`, { waitUntil: 'networkidle2' })
    await waitForText(first, 'YOUR DEVICES')
    await waitForText(first, '(this device)')
    const enrolled = await apiGet(first, '/chat/me/keys')
    expect(enrolled.status).equals(200)
    expect(enrolled.body.linked).equals(true)
    await shot(first, 'e5-1-b1-enrolled')

    const second = await device('B', 2)
    await signIn(second, seed, 'B')
    await second.goto(`${WEB}/chat/devices`, { waitUntil: 'networkidle2' })
    await waitForText(second, 'Link this device')
    const shown = await codeOn(second, 'Six-digit code ')
    await shot(second, 'e5-2-b2-code')

    const asked = await codeOn(first, 'Code ')
    expect(asked).equals(shown)
    await shot(first, 'e5-3-b1-request')
    console.log(`      E5 six digits: B-1 ${asked}, B-2 ${shown}`)
    const pending = await apiGet(first, '/chat/links')
    expect(pending.body).length(1)
    await press(first, `Approve ${pending.body[0].newDevice.name as string}`)

    await waitForText(second, 'YOUR DEVICES')
    for (const page of [first, second]) {
      await until('both devices linked on the screen', async () =>
        (await bodyText(page)).split('· Linked').length - 1 === 2
          ? true
          : undefined
      )
    }
    await shot(first, 'e5-4-b1-devices')
    await shot(second, 'e5-5-b2-devices')

    const devices = async (page: Page): Promise<string[]> =>
      (
        (await apiGet(page, '/chat/devices')).body as Array<{
          id: string
          linked: boolean
          revokedAt: string | null
        }>
      )
        .filter(row => row.revokedAt == null && row.linked)
        .map(row => row.id)
        .sort()
    const listedFirst = await devices(first)
    expect(listedFirst).length(2)
    expect(await devices(second)).deep.equals(listedFirst)

    const keysFirst = (await apiGet(first, '/chat/me/keys')).body
    const keysSecond = (await apiGet(second, '/chat/me/keys')).body
    expect(keysFirst.linked).equals(true)
    expect(keysSecond.linked).equals(true)
    expect(keysFirst.deviceId).not.equals(keysSecond.deviceId)
    expect(keysSecond.identity.publicKey).equals(keysFirst.identity.publicKey)
    console.log(
      `      E5 identity key on both: ${keysFirst.identity.publicKey as string}`
    )
  })
  /**
   * E6: coach Hc posts in Hawks Members and keeps it open. Hawks admin Ha
   * makes an invite link; J, new, signs up with an e-mail code and opens
   * Hawks Members: History is locked first, then Hc's message within 5 s,
   * with no reload on either side.
   */
  it('E6: a newcomer sees History is locked, then the history', async function () {
    const coach = await signedIn('Hc')
    await signIn(coach, seed, 'Hc')
    await openChat(coach, 'Hawks Members')
    await send(coach, 'Welcome to Hawks Members')
    await waitForText(coach, 'Welcome to Hawks Members')
    await shot(coach, 'e6-1-hc-posted')

    const admin = await signedIn('Ha')
    await signIn(admin, seed, 'Ha')
    await admin.goto(`${WEB}/teams/${seed.ids.Hawks}/manage`, {
      waitUntil: 'networkidle2'
    })
    const codes = async (): Promise<string[]> =>
      [...(await bodyText(admin)).matchAll(/\/i\/([A-Za-z0-9_-]+)/g)].map(
        found => found[1]
      )
    await waitForText(admin, 'Create an invite link')
    const before = new Set(await codes())
    await pressText(admin, 'Create an invite link')
    await pressText(admin, 'Create')
    const code = await until('the new invite link', async () =>
      (await codes()).find(found => !before.has(found))
    )
    await shot(admin, 'e6-2-invite')

    const newcomer = await device('J')
    newcomer.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warn') {
        console.log(
          `      [J] ${message.type()} ${message.text().slice(0, 300)}`
        )
      }
    })
    newcomer.on('response', response => {
      if (response.url().includes('/api/v1/chat')) {
        console.log(
          `      [J] ${Date.now()} ${response.status()} ${response.request().method()} ${response.url().slice(-70)}`
        )
      }
    })
    const address = 'j@chat.example.com'
    await newcomer.goto(`${WEB}/i/${code}`, { waitUntil: 'networkidle2' })
    await waitForText(newcomer, 'You are invited to watch Hawks')
    await typeInto(newcomer, 'Your name', 'Jules Jay')
    await typeInto(newcomer, 'E-mail address', address)
    const lines = logLength()
    await pressText(newcomer, 'Send me a sign-in code')
    const signInCode = await logged('sign-in code', address, lines)
    await typeInto(newcomer, 'Sign-in code', signInCode.split(/\s/)[0])
    await pressText(newcomer, 'Join')
    await waitForText(newcomer, 'You are in.')

    // Every appearance on J's screen, timed, from before the page loads.
    await newcomer.evaluateOnNewDocument(() => {
      const seen: Record<string, number> = {}
      ;(window as unknown as { seen: Record<string, number> }).seen = seen
      const look = (): void => {
        const text = document.body === null ? '' : document.body.innerText
        for (const words of ['History is locked', 'Welcome to Hawks Members']) {
          if (seen[words] === undefined && text.includes(words)) {
            seen[words] = Date.now()
          }
        }
      }
      new MutationObserver(look).observe(document, {
        subtree: true,
        childList: true,
        characterData: true
      })
    })
    // Straight to the chat, as a link to it opens: J's device enrols on the
    // way in, and Hc's open page grants it the history.
    const members = await chatIdOf(coach, 'Hawks Members')
    await newcomer.goto(`${WEB}/chat/${members}`, { waitUntil: 'load' })
    await waitForText(newcomer, 'Welcome to Hawks Members')
    const seen = await newcomer.evaluate(
      () => (window as unknown as { seen: Record<string, number> }).seen
    )
    console.log(`      E6 seen: ${JSON.stringify(seen)}`)
    // J's device joined the chat without its key, and Hc's open page
    // granted it: J's box for the epoch was made by Hc, after J's identity.
    const db = database()
    try {
      const rows = (
        await db.query(
          `select b.granted_by_user_id::text as granter,
             (extract(epoch from r.opened_at) * 1000)::bigint as opened,
             (extract(epoch from r.filled_at) * 1000)::bigint as filled,
             (extract(epoch from i.created_at) * 1000)::bigint as enrolled
           from chat_epoch_boxes b
           join chat_identities i on i.id = b.identity_id
           join chat_grant_requests r
             on r.conversation_id = b.conversation_id and r.user_id = b.user_id
           join users u on u.id = b.user_id
           where b.conversation_id = $1 and u.display_name = 'Jules Jay'`,
          [members]
        )
      ).rows as Array<{
        granter: string
        opened: string
        filled: string
        enrolled: string
      }>
      expect(rows.length).equals(1)
      expect(rows[0].granter).equals(seed.people.Hc.userId)
      const opened = Number(rows[0].opened)
      const filled = Number(rows[0].filled)
      expect(opened).greaterThanOrEqual(Number(rows[0].enrolled))
      console.log(
        `      E6 J locked from ${opened} until Hc's grant ${filled} ` +
          `(${filled - opened} ms); message on J's screen at ` +
          `${seen['Welcome to Hawks Members']}`
      )
      // The history reached J's screen within 5 s of J joining the chat,
      // with no reload; the lock showed on the screen when it lasted long
      // enough to be drawn.
      expect(seen['Welcome to Hawks Members'] - opened).lessThan(5000)
      if (seen['History is locked'] !== undefined) {
        expect(seen['Welcome to Hawks Members']).greaterThan(
          seen['History is locked']
        )
      }
    } finally {
      await db.end()
    }
    await shot(newcomer, 'e6-3-j-history')
    await shot(coach, 'e6-4-hc-still-open')
  })

  /**
   * E7: Hawks admin Ha removes parent D (added in E4) from Hawks on the
   * Manage page, and Hc posts again: D is out, the post starts epoch n+1,
   * and D has no box for it.
   */
  it('E7: a removed member gets nothing new', async function () {
    const db = database()
    try {
      const coach = await signedIn('Hc')
      const members = await chatIdOf(coach, 'Hawks Members')
      const parentD = await signedIn('D')
      await signIn(parentD, seed, 'D')
      expect(
        (await apiGet(parentD, `/chat/conversations/${members}/messages`))
          .status
      ).equals(200)
      const epochBefore = Number(
        (
          await db.query(
            'select max(epoch) as e from chat_epochs where conversation_id = $1',
            [members]
          )
        ).rows[0].e
      )

      const admin = await signedIn('Ha')
      await admin.goto(`${WEB}/teams/${seed.ids.Hawks}/manage`, {
        waitUntil: 'networkidle2'
      })
      await waitForText(admin, 'Dana Dunn')
      await pressInRow(admin, 'Dana Dunn', 'Remove')
      await until('D to leave the Manage page', async () =>
        (await bodyText(admin)).includes('Dana Dunn') ? undefined : true
      )
      await shot(admin, 'e7-1-d-removed')

      await until('D to be refused Hawks Members', async () =>
        (await apiGet(parentD, `/chat/conversations/${members}/messages`))
          .status === 404
          ? true
          : undefined
      )
      await openChat(coach, 'Hawks Members')
      await send(coach, 'After D left')
      await waitForText(coach, 'After D left')
      await shot(coach, 'e7-2-hc-posted')
      const posted = (
        await db.query(
          `select epoch from chat_messages where conversation_id = $1
           order by seq desc limit 1`,
          [members]
        )
      ).rows[0]
      expect(Number(posted.epoch)).equals(epochBefore + 1)
      const boxes = await db.query(
        `select 1 from chat_epoch_boxes
         where conversation_id = $1 and epoch = $2 and user_id = $3`,
        [members, epochBefore + 1, seed.people.D.userId]
      )
      expect(boxes.rows.length).equals(0)
      console.log(
        `      E7 epoch ${epochBefore} → ${epochBefore + 1}, no box for D`
      )
    } finally {
      await db.end()
    }
  })

  /**
   * E8: Eagles coach Ec and parent D2 are alone in a DM with history. D2
   * resets on a new device while Ec's browser is closed; D2's DM stays
   * locked until Ec opens Chat, sees the changed safety number and the
   * approval, and approves.
   */
  it('E8: a reset identity waits for a person to approve', async function () {
    const coach = await signedIn('Ec')
    await signIn(coach, seed, 'Ec')
    await openChatTab(coach)
    await pressText(coach, 'New message')
    await typeInto(coach, 'Name', 'Drew')
    await press(coach, 'Pick Drew D')
    await pressText(coach, 'Start conversation')
    await until('the DM', () =>
      /\/chat\/cnv_[^/]+$/.test(coach.url()) ? true : undefined
    )
    await send(coach, 'Ec to D2: practice moved')

    const old = await signedIn('D2')
    await signIn(old, seed, 'D2')
    await openChat(old, 'Eddie C')
    await waitForText(old, 'Ec to D2: practice moved')
    await send(old, 'D2: thanks')
    await waitForText(coach, 'D2: thanks')
    await shot(coach, 'e8-1-dm-history')
    const dm = await dmWith(coach, [
      seed.people.Ec.userId,
      seed.people.D2.userId
    ])
    await closeDevice('Ec')

    const fresh = await device('D2', 2)
    await signIn(fresh, seed, 'D2')
    await fresh.goto(`${WEB}/chat`, { waitUntil: 'networkidle2' })
    await waitForText(fresh, 'Link this device')
    await pressText(fresh, 'I can’t reach my other devices')
    await pressText(fresh, 'Reset chat on this device')
    await waitForChatList(fresh)
    await fresh.goto(`${WEB}/chat/${dm}`, { waitUntil: 'networkidle2' })
    await waitForText(fresh, 'History is locked')
    await new Promise(resolve => setTimeout(resolve, 3000))
    expect(await bodyText(fresh)).not.contains('practice moved')
    await shot(fresh, 'e8-2-d2-locked')

    const back = await signedIn('Ec')
    await openChat(back, 'Drew D')
    await waitForText(back, 'Drew D’s safety number changed')
    await waitForText(back, 'reset their chat keys')
    await shot(back, 'e8-3-ec-sees-change')
    await pressText(back, 'Review')
    await waitForText(back, 'OLD SAFETY NUMBER')
    await waitForText(back, 'NEW SAFETY NUMBER')
    await shot(back, 'e8-4-ec-approval')
    await press(back, 'Approve Drew D')
    await until('the approval to go', async () =>
      (await bodyText(back)).includes('OLD SAFETY NUMBER') ? undefined : true
    )
    await waitForText(fresh, 'Ec to D2: practice moved')
    await shot(fresh, 'e8-5-d2-history')
  })

  /**
   * E9: Ec and parent D share a DM with history; Ec leaves. D resets on a
   * new device, opens the DM and writes: nobody can grant the history, so
   * the post starts a new chain and the earlier messages stay unopenable.
   */
  it('E9: with no holder left, the next message breaks the chain', async function () {
    const db = database()
    try {
      const coach = await signedIn('Ec')
      await openChatTab(coach)
      await pressText(coach, 'New message')
      await typeInto(coach, 'Name', 'Dana')
      await press(coach, 'Pick Dana D')
      await pressText(coach, 'Start conversation')
      await until('the DM', () =>
        /\/chat\/cnv_[^/]+$/.test(coach.url()) ? true : undefined
      )
      await send(coach, 'Ec to D: carpool list')
      const parent = await signedIn('D')
      await openChat(parent, 'Eddie C')
      await waitForText(parent, 'Ec to D: carpool list')
      const dm = await dmWith(parent, [
        seed.people.Ec.userId,
        seed.people.D.userId
      ])
      await shot(parent, 'e9-1-d-history')

      await coach.goto(`${WEB}/chat/${dm}/members`, {
        waitUntil: 'networkidle2'
      })
      await pressText(coach, 'Leave this conversation')
      await until('Ec out of the DM', async () =>
        (await apiGet(coach, `/chat/conversations/${dm}/messages`)).status ===
        404
          ? true
          : undefined
      )

      const fresh = await device('D', 2)
      await signIn(fresh, seed, 'D')
      await fresh.goto(`${WEB}/chat`, { waitUntil: 'networkidle2' })
      await waitForText(fresh, 'Link this device')
      await pressText(fresh, 'I can’t reach my other devices')
      await pressText(fresh, 'Reset chat on this device')
      await waitForChatList(fresh)
      await fresh.goto(`${WEB}/chat/${dm}`, { waitUntil: 'networkidle2' })
      await send(fresh, 'still here')
      await waitForText(fresh, 'still here')
      await waitForText(fresh, 'Earlier messages can’t be opened')
      await shot(fresh, 'e9-2-d-chain-break')

      const epoch = (
        await db.query(
          `select e.chain_break from chat_messages m
           join chat_epochs e
             on e.conversation_id = m.conversation_id and e.epoch = m.epoch
           where m.conversation_id = $1 order by m.seq desc limit 1`,
          [dm]
        )
      ).rows[0]
      expect(epoch.chain_break).equals(true)
      const requests = (
        await db.query(
          // The requests of D's identity since the reset (the one before it
          // had its request filled by Ec, back when Ec held the key).
          `select r.filled_at, r.superseded_at from chat_grant_requests r
           join chat_identities i on i.id = r.identity_id
           where r.conversation_id = $1 and r.user_id = $2
             and i.replaced_at is null`,
          [dm, seed.people.D.userId]
        )
      ).rows as Array<{ filled_at: Date | null; superseded_at: Date | null }>
      expect(requests.length).greaterThan(0)
      for (const request of requests) {
        expect(request.filled_at).equals(null)
        expect(request.superseded_at).not.equals(null)
      }
      console.log(`      E9 ${requests.length} request(s), all superseded`)
    } finally {
      await db.end()
    }
  })

  /**
   * E10: Hc writes with 🎉 in Hawks Members, B replies, C reacts 👍: the
   * quote, the count, and Hc's ticks naming B and C as each reads.
   */
  it('E10: reply, reaction and read ticks', async function () {
    const coach = await signedIn('Hc')
    await openChat(coach, 'Hawks Members')
    await send(coach, 'Game day 🎉')

    const parentB = await signedIn('B')
    await signIn(parentB, seed, 'B')
    await openChat(parentB, 'Hawks Members')
    await waitForText(parentB, 'Game day 🎉')
    await until('Hc’s ticks to name B', async () =>
      /Read by [^\n]*Blair B/.test(await bodyText(coach)) ? true : undefined
    )
    await shot(coach, 'e10-1-read-by-b')
    await longPress(parentB, 'Game day 🎉')
    await pressText(parentB, 'Reply')
    await waitForText(parentB, 'Replying to Hank C')
    await send(parentB, 'Can’t wait')
    await waitForText(coach, 'Can’t wait')
    await shot(parentB, 'e10-2-b-reply')

    const parentC = await signedIn('C')
    await signIn(parentC, seed, 'C')
    await openChat(parentC, 'Hawks Members')
    await waitForText(parentC, 'Game day 🎉')
    await until(
      'C’s composer to open',
      async () =>
        (await parentC.$('textarea[aria-label="Message"]:not([readonly])')) ??
        undefined
    )
    await longPress(parentC, 'Game day 🎉')
    await press(parentC, 'React with 👍')
    await waitForText(coach, '👍 1')
    await until('Hc’s ticks to name B and C', async () => {
      const text = await bodyText(coach)
      // Each of Game day's readers by name, in the order they read it.
      const line = text
        .split('Game day 🎉')[1]
        ?.split('\n')
        .find(row => row.includes('Read by'))
      return line?.includes('Blair B') === true && line.includes('Casey C')
        ? true
        : undefined
    })
    const quoted = await bodyText(coach)
    expect(quoted).contains('Hank C')
    await shot(coach, 'e10-3-hc-ticks-reaction')
    await shot(parentC, 'e10-4-c-reacted')
  })

  /**
   * E11: B attaches a JPEG and a 20 MB MP4; both open decrypted elsewhere,
   * and neither object in the Space starts with its format's magic.
   */
  it('E11: a picture and a video, encrypted end to end', async function () {
    const fixtures =
      process.env.TS_CHAT_FIXTURES ?? join(ARTIFACTS, '..', 'fixtures')
    const parentB = await signedIn('B')
    await openChat(parentB, 'Hawks Members')
    const [chooser] = await Promise.all([
      parentB.waitForFileChooser(),
      press(parentB, 'Attach')
    ])
    await chooser.accept([
      join(fixtures, 'photo.jpg'),
      join(fixtures, 'clip.mp4')
    ])
    await waitForText(parentB, 'clip.mp4')
    await send(parentB, 'Photos from practice')
    await shot(parentB, 'e11-1-b-sent')

    const coach = await signedIn('Hc')
    await openChat(coach, 'Hawks Members')
    await waitForText(coach, 'Photos from practice')
    await until(
      'the picture to open',
      async () =>
        await coach.evaluate(() =>
          Array.from(document.querySelectorAll('img')).some(
            image => image.src.startsWith('blob:') && image.naturalWidth > 0
          )
        )
    )
    await press(coach, 'Open clip.mp4')
    const duration = await until(
      'the video to open',
      async () =>
        await coach.evaluate(() => {
          const video = document.querySelector('video')
          return video !== null &&
            video.src.startsWith('blob:') &&
            video.readyState >= 1
            ? video.duration
            : undefined
        }),
      60000
    )
    expect(duration).greaterThan(30)
    await shot(coach, 'e11-2-hc-opened')

    const db = database()
    try {
      const rows = (
        await db.query(
          `select object_key, size from chat_attachments
           where completed_at is not null order by created_at desc limit 2`
        )
      ).rows as Array<{ object_key: string; size: string }>
      expect(rows.length).equals(2)
      for (const row of rows) {
        const head = await objectHead(row.object_key)
        expect(head.subarray(0, 3).toString('hex')).not.equals('ffd8ff')
        expect(head.subarray(4, 8).toString('latin1')).not.equals('ftyp')
        console.log(
          `      E11 ${row.object_key} ${row.size} bytes, starts ${head.toString('hex')}`
        )
      }
    } finally {
      await db.end()
    }
  })

  /**
   * E12: B edits, then deletes, a message; C posts "first from C" and Hc
   * deletes it for everyone. The edit and the deletions reach everyone, and
   * B's post and its edit are cleared on the server.
   */
  it('E12: edit, delete, and a moderator’s Delete for everyone', async function () {
    const parentB = await signedIn('B')
    const parentC = await signedIn('C')
    const coach = await signedIn('Hc')
    await openChat(parentB, 'Hawks Members')
    await openChat(parentC, 'Hawks Members')
    await openChat(coach, 'Hawks Members')
    await send(parentB, 'Snack shedule is up')
    await waitForText(parentC, 'Snack shedule is up')

    await longPress(parentB, 'Snack shedule is up')
    await pressText(parentB, 'Edit')
    await waitForText(parentB, 'Editing your message')
    const field = await parentB.$('textarea[aria-label="Message"]')
    await field!.click({ count: 3 })
    await parentB.keyboard.down('Meta')
    await parentB.keyboard.press('a')
    await parentB.keyboard.up('Meta')
    await field!.type('Snack schedule is up')
    await press(parentB, 'Send')
    for (const page of [parentC, coach]) {
      await waitForText(page, 'Snack schedule is up')
      await waitForText(page, 'edited')
    }
    await shot(parentC, 'e12-1-c-sees-edit')
    const members = await chatIdOf(parentB, 'Hawks Members')
    const ids = (
      (await apiGet(parentB, `/chat/conversations/${members}/messages`))
        .body as Array<{ id: string; kind: string; senderUserId: string }>
    )
      .filter(
        message =>
          message.senderUserId === seed.people.B.userId &&
          (message.kind === 'post' || message.kind === 'edit')
      )
      .slice(-2)
      .map(message => message.id)

    await longPress(parentB, 'Snack schedule is up')
    await pressText(parentB, 'Delete')
    for (const page of [parentC, coach]) {
      await until('the deletion', async () =>
        (await bodyText(page)).includes('Snack schedule is up')
          ? undefined
          : true
      )
      await waitForText(page, 'Message deleted')
    }
    await shot(coach, 'e12-2-hc-sees-delete')

    await send(parentC, 'first from C')
    await waitForText(coach, 'first from C')
    await longPress(coach, 'first from C')
    await pressText(coach, 'Delete for everyone')
    for (const page of [parentB, parentC, coach]) {
      await waitForText(page, 'Removed by a moderator')
    }
    expect(await bodyText(parentB)).not.contains('first from C')
    await shot(parentC, 'e12-3-c-removed-by-moderator')

    const db = database()
    try {
      const rows = (
        await db.query(
          `select id, kind, cleared_at, octet_length(ciphertext) as length
           from chat_messages where id = any($1::text[])`,
          [ids]
        )
      ).rows as Array<{ kind: string; cleared_at: Date | null; length: number }>
      expect(rows.map(row => row.kind).sort()).deep.equals(['edit', 'post'])
      for (const row of rows) {
        expect(row.cleared_at).not.equals(null)
        expect(Number(row.length)).equals(0)
      }
    } finally {
      await db.end()
    }
  })

  /**
   * E13: parent A reads Announcements and may react but not write; season
   * admin S posts and A, Eagles player E and the Eagles coach see it; fan F
   * has no Announcements at all.
   */
  it('E13: Announcements, written by season staff', async function () {
    const admin = await signedIn('S')
    await signIn(admin, seed, 'S')
    const chats = (await apiGet(admin, '/chat/conversations')).body as Array<{
      kind: string
      title: string
      scope?: { id: string }
    }>
    const announcements = chats.find(
      chat =>
        chat.kind === 'seasonAnnouncements' &&
        chat.scope?.id === seed.ids['Spring 2027']
    )!.title
    expect(announcements).matches(/^Spring 2027 - .+ Announcements$/)
    await openChat(admin, announcements)
    await send(admin, 'Opening day is Saturday')

    const parentA = await signedIn('A')
    await signIn(parentA, seed, 'A')
    await openChat(parentA, announcements)
    await waitForText(parentA, 'Opening day is Saturday')
    expect(await parentA.$('textarea[aria-label="Message"]')).equals(null)
    await waitForText(parentA, 'Only season staff post here')
    await longPress(parentA, 'Opening day is Saturday')
    await press(parentA, 'React with 👍')
    await waitForText(admin, '👍 1')
    await shot(parentA, 'e13-1-a-reacted')

    const player = await signedIn('E')
    await signIn(player, seed, 'E')
    await openChat(player, announcements)
    await waitForText(player, 'Opening day is Saturday')
    await shot(player, 'e13-2-e-sees')
    const coach = await signedIn('Ec')
    await openChat(coach, announcements)
    await waitForText(coach, 'Opening day is Saturday')
    await shot(coach, 'e13-3-ec-sees')

    const fan = await signedIn('F')
    await signIn(fan, seed, 'F')
    await openChatTab(fan)
    await waitForText(fan, 'Hawks Fans')
    expect(await bodyText(fan)).not.contains('Announcements')
    await shot(fan, 'e13-4-f-list')
  })

  /**
   * E14: the SafeSport switch. K's DM with P, made while it is off, closes
   * when L turns it on; K's next DM with P needs another adult and K picks
   * Hc; G2's DM with P needs nobody, and closes when Hc unlinks P's
   * remaining guardians; Hc's leave closes K's DM; L turns it off again.
   */
  it('E14: SafeSport includes another adult, and closes what breaks it', async function () {
    const keeper = await signedIn('K')
    await signIn(keeper, seed, 'K')
    const newDm = async (
      page: Page,
      query: string,
      pick: string
    ): Promise<void> => {
      await openChatTab(page)
      await pressText(page, 'New message')
      await typeInto(page, 'Name', query)
      await press(page, `Pick ${pick}`)
      await pressText(page, 'Start conversation')
    }
    await newDm(keeper, 'Pat', 'Pat P')
    await until('the DM', () =>
      /\/chat\/cnv_[^/]+$/.test(keeper.url()) ? true : undefined
    )
    const first = await dmWith(keeper, [
      seed.people.K.userId,
      seed.people.P.userId
    ])
    await send(keeper, 'K to P: bring your glove')
    await shot(keeper, 'e14-1-k-p')

    const league = await signedIn('L')
    await signIn(league, seed, 'L')
    const toggle = async (on: boolean): Promise<void> => {
      await league.goto(`${WEB}/leagues/${seed.ids.QPLL}/manage`, {
        waitUntil: 'networkidle2'
      })
      const sw = await until(
        'the SafeSport switch',
        async () =>
          (await league.$(
            '[aria-label="SafeSport Local Affiliated Organization"]'
          )) ?? undefined
      )
      const now = await sw.evaluate(node =>
        node instanceof HTMLInputElement
          ? node.checked
          : node.getAttribute('aria-checked') === 'true'
      )
      if (now !== on) await sw.click()
      await until('the switch to hold', async () =>
        (await apiGet(league, `/manage/league/${seed.ids.QPLL}`)).body?.scope
          ?.safesportLao === on
          ? true
          : undefined
      )
    }
    await toggle(true)
    await shot(league, 'e14-2-l-switch-on')
    await until('K’s first DM to close', async () => {
      const list = (await apiGet(keeper, '/chat/conversations')).body as Array<{
        id: string
        closed: boolean
      }>
      return list.find(chat => chat.id === first)?.closed === true
        ? true
        : undefined
    })

    await newDm(keeper, 'Pat', 'Pat P')
    await waitForText(keeper, 'Include another adult')
    for (const name of ['Glen G', 'Ava A', 'Blair B', 'Harper H', 'Hank C']) {
      await waitForText(keeper, name)
    }
    expect(await bodyText(keeper)).not.contains('Kim K')
    await shot(keeper, 'e14-3-k-suggestions')
    await typeInto(keeper, 'Search for an adult', 'Eddie')
    await waitForText(keeper, 'Nobody matches that name.')
    await shot(keeper, 'e14-4-k-no-ec')
    await typeInto(keeper, 'Search for an adult', 'Hank')
    await press(keeper, 'Include Hank C')
    await pressText(keeper, 'Start with them')
    await until('the DM with Hc', () =>
      /\/chat\/cnv_[^/]+$/.test(keeper.url()) ? true : undefined
    )
    const second = await dmWith(keeper, [
      seed.people.K.userId,
      seed.people.P.userId,
      seed.people.Hc.userId
    ])
    await shot(keeper, 'e14-5-k-p-hc')

    const guardian = await signedIn('G2')
    await signIn(guardian, seed, 'G2')
    await newDm(guardian, 'Pat', 'Pat P')
    await until('G2’s DM', () =>
      /\/chat\/cnv_[^/]+$/.test(guardian.url()) ? true : undefined
    )
    const g2dm = await dmWith(guardian, [
      seed.people.G2.userId,
      seed.people.P.userId
    ])
    await shot(guardian, 'e14-6-g2-p')

    const coach = await signedIn('Hc')
    await coach.goto(
      `${WEB}/players/${seed.people.P.userId}?onTeam=${seed.ids.Hawks}&tab=settings`,
      { waitUntil: 'networkidle2' }
    )
    await press(coach, 'Settings')
    await press(coach, 'Change guardians and family')
    for (const name of ['Glen Guardian', 'Ava Aunt']) {
      await press(coach, `Remove ${name}`)
      await until(`${name} unlinked`, async () => {
        const text = await bodyText(coach)
        return text.includes(name) ? undefined : true
      })
    }
    await pressText(coach, 'Done')
    await shot(coach, 'e14-7-hc-unlinked')
    await until('G2’s DM to close', async () => {
      const list = (await apiGet(guardian, '/chat/conversations'))
        .body as Array<{
        id: string
        closed: boolean
      }>
      return list.find(chat => chat.id === g2dm)?.closed === true
        ? true
        : undefined
    })

    await coach.goto(`${WEB}/chat/${second}/members`, {
      waitUntil: 'networkidle2'
    })
    await pressText(coach, 'Leave this conversation')
    await until('K’s DM to close', async () => {
      const list = (await apiGet(keeper, '/chat/conversations')).body as Array<{
        id: string
        closed: boolean
      }>
      return list.find(chat => chat.id === second)?.closed === true
        ? true
        : undefined
    })
    await keeper.goto(`${WEB}/chat/${second}`, { waitUntil: 'networkidle2' })
    await waitForText(keeper, 'This chat is closed')
    await shot(keeper, 'e14-8-k-closed')

    await toggle(false)
    await shot(league, 'e14-9-l-switch-off')
  })
  /**
   * E15: C posts "second from C" in Hawks Members and parent B reports it
   * from the long-press menu. Site admin Z opens /admin/chat/reports and
   * sees C's text, verified; B, who is no administrator, finds nothing
   * there. Z resolves it.
   */
  it('E15: a reported message reaches the site administrators, verified', async function () {
    const parentC = await signedIn('C')
    await openChat(parentC, 'Hawks Members')
    await send(parentC, 'second from C')

    const parentB = await signedIn('B')
    await openChat(parentB, 'Hawks Members')
    await waitForText(parentB, 'second from C')
    await longPress(parentB, 'second from C')
    await pressText(parentB, 'Report')
    await waitForText(parentB, 'Report this message?')
    await shot(parentB, 'e15-1-b-asks')
    await pressText(parentB, 'Report message')
    await waitForText(parentB, 'Reported.')
    await shot(parentB, 'e15-2-b-reported')

    const db = database()
    try {
      const rows = (
        await db.query(
          `select r.verified, r.plaintext, m.sender_user_id::text as sender,
             r.reporter_user_id::text as reporter,
             octet_length(r.message_key) as key_length
           from chat_reports r join chat_messages m on m.id = r.message_id
           order by r.created_at desc limit 1`
        )
      ).rows as Array<{
        verified: boolean
        plaintext: string
        sender: string
        reporter: string
        key_length: number
      }>
      expect(rows.length).equals(1)
      expect(rows[0].verified).equals(true)
      expect(rows[0].sender).equals(seed.people.C.userId)
      expect(rows[0].reporter).equals(seed.people.B.userId)
      expect(Number(rows[0].key_length)).equals(32)
      expect((JSON.parse(rows[0].plaintext) as { body: string }).body).equals(
        'second from C'
      )
    } finally {
      await db.end()
    }

    await parentB.goto(`${WEB}/admin/chat/reports`, {
      waitUntil: 'networkidle2'
    })
    await waitForText(parentB, 'There is nothing here.')
    expect(await bodyText(parentB)).not.contains('second from C')
    await shot(parentB, 'e15-3-b-not-found')

    const admin = await signedIn('Z')
    await admin.goto(`${WEB}/admin/chat/reports`, {
      waitUntil: 'networkidle2'
    })
    await waitForText(admin, 'second from C')
    const card = await until(
      'the report',
      async () =>
        await admin.evaluate(() => {
          const found = Array.from(
            document.querySelectorAll<HTMLElement>('[aria-label^="From "]')
          ).find(node => node.innerText.includes('second from C'))
          return found === undefined ? undefined : found.innerText
        })
    )
    expect(card).contains('Hawks Members')
    expect(card).contains('Casey')
    expect(card).match(/(^|\n)verified(\n|$)/)
    expect(card).not.contains('not verified')
    expect(card).contains('Reported by Blair')
    await shot(admin, 'e15-4-z-report')

    await pressInRow(admin, 'second from C', 'Resolve')
    await until('the report to leave the open list', async () =>
      (await bodyText(admin)).includes('second from C') ? undefined : true
    )
    await shot(admin, 'e15-5-z-resolved')
  })

  /**
   * E17: Eagles parent D2 finds Hawks on the Search tab, follows it, and
   * opens it: the schedule and the team, and nothing of its games. Chat's
   * list no longer offers "Follow a team"; following is the Search tab's,
   * which gives a signed-in person a Follow button on each result.
   */
  it('E17: a fan follows Hawks and sees its schedule and team only', async function () {
    const page = await signedIn('D2')
    await signIn(page, seed, 'D2')
    const search = await until(
      'the Search tab',
      async () =>
        (await page.$('[role="tab"][aria-label="Search"]')) ?? undefined
    )
    await search.click()
    await typeInto(page, 'Search by name or city', 'Haw')
    await shot(page, 'e17-1-search')
    await press(page, 'Follow Hawks')
    await until(
      'Following',
      async () => (await page.$('[aria-label="Unfollow Hawks"]')) ?? undefined
    )
    await shot(page, 'e17-2-following')

    await press(page, 'Open Hawks')
    await until('the Hawks page', () =>
      page.url().includes(`/groups/team/${seed.ids.Hawks}`) ? true : undefined
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
  /**
   * E18: Hc starts a DM with fan F, who replies; F has no New message and
   * the server refuses F's own DM.
   */
  it('E18: staff message a fan, who may reply but never start', async function () {
    const coach = await signedIn('Hc')
    await openChatTab(coach)
    await pressText(coach, 'New message')
    await typeInto(coach, 'Name', 'Frank')
    await press(coach, 'Pick Frankie F')
    await shot(coach, 'e18-1-hc-picks-f')
    await pressText(coach, 'Start conversation')
    await until('the DM', () =>
      /\/chat\/cnv_[^/]+$/.test(coach.url()) ? true : undefined
    )
    await send(coach, 'Thanks for cheering, Frankie')

    const fan = await signedIn('F')
    await openChat(fan, 'Hank C')
    await waitForText(fan, 'Thanks for cheering, Frankie')
    await send(fan, 'Go Hawks!')
    await waitForText(coach, 'Go Hawks!')
    await shot(coach, 'e18-2-hc-gets-reply')

    await openChatTab(fan)
    expect(await fan.$('::-p-text(New message)')).equals(null)
    await shot(fan, 'e18-3-f-no-new-message')
    const refused = await apiCall(fan, 'POST', '/chat/dms', {
      userIds: [seed.people.Hc.userId]
    })
    expect(refused.status).equals(403)
    expect(refused.body.details.reason).equals('notCandidate')
  })

  /**
   * E19: P (15) and E (16) need nobody else; neither parent A nor Eagles
   * coach Ec is offered P; Hc's DM with P has no guardian (QPLL is not an
   * LAO); R (12) has no chats.
   */
  it('E19: who may message a player, and nobody under 13', async function () {
    const player = await signedIn('P')
    await signIn(player, seed, 'P')
    await openChatTab(player)
    await pressText(player, 'New message')
    await typeInto(player, 'Name', 'Eli')
    await press(player, 'Pick Eli E')
    await pressText(player, 'Start conversation')
    await until('the DM', () =>
      /\/chat\/cnv_[^/]+$/.test(player.url()) ? true : undefined
    )
    await dmWith(player, [seed.people.P.userId, seed.people.E.userId])
    await shot(player, 'e19-1-p-e')

    for (const who of ['A', 'Ec']) {
      const page = await signedIn(who)
      await openChatTab(page)
      await pressText(page, 'New message')
      await typeInto(page, 'Name', 'Pat')
      await waitForText(page, 'Nobody matches.')
      await shot(page, `e19-2-${who.toLowerCase()}-no-p`)
    }

    const coach = await signedIn('Hc')
    await openChatTab(coach)
    await pressText(coach, 'New message')
    await typeInto(coach, 'Name', 'Pat')
    await press(coach, 'Pick Pat P')
    await pressText(coach, 'Start conversation')
    await until('the DM', () =>
      /\/chat\/cnv_[^/]+$/.test(coach.url()) ? true : undefined
    )
    await dmWith(coach, [seed.people.Hc.userId, seed.people.P.userId])
    await shot(coach, 'e19-3-hc-p')

    const rookie = await signedIn('R')
    await signIn(rookie, seed, 'R')
    await openChatTab(rookie)
    await waitForText(rookie, 'You are in no chats yet.')
    await shot(rookie, 'e19-4-r-no-chats')
  })
})
