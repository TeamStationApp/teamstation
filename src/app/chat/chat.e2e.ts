import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'
import { Pool } from 'pg'
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
 * `<artifacts>/seed.txt`, which the reset script writes. With no mail relay
 * configured the API logs every invitation and sign-in code instead of
 * sending it; run it with its output in a file and name that file in
 * `TS_CHAT_API_LOG` (E2 reads both from it). Database checks connect to the
 * `databaseUrl` of the local `serverConfig.json`. Each browser is one
 * device of one person, with its own profile in
 * `<artifacts>/profiles/<person>-<n>`, so what a device keeps survives from
 * one scenario to the next — a browser's chat keys included (E5). Pages call
 * the API themselves at `TS_CHAT_API_URL` (default the API above) for what
 * the screens do not show. Screenshots go to `<artifacts>/shots`.
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

interface Seed {
  ids: Record<string, string>
  people: Record<string, { userId: string; email: string; password: string }>
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
    const person = /^(\S+)\s.*?\s(\d{6,})\s+(\S+@\S+)\s+(\S+)$/.exec(line)
    if (person != null) {
      people[person[1]] = {
        userId: person[2],
        email: person[3],
        password: person[4]
      }
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

/** The database the local API runs on, for checks the screens cannot make. */
function localDatabase(): Pool {
  const config = JSON.parse(readFileSync('serverConfig.json', 'utf8')) as {
    databaseUrl: string
  }
  if (
    !/^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl)
  ) {
    throw new Error('serverConfig.json does not name a local database')
  }
  return new Pool({ connectionString: config.databaseUrl })
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
  /**
   * E2: coach Hc keeps P's guardians and family from P's Settings tab. The
   * aunt, who has no account, joins through her invitation; parent D cannot
   * use the uncle's; parent B is linked as family; G1 is unlinked.
   */
  it('E2: guardians and family from the player’s Settings tab', async function () {
    const db = localDatabase()
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
})
