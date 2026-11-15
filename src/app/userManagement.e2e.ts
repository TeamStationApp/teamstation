// Node administration's User Management in a real browser, against the real
// server and database:
//
//   npm run build.web
//   TS_CREATION_ARTIFACTS=<dir> node -r sucrase/register src/app/userManagement.e2e.ts
//
// Writes its screenshots and `node-activity-api.log` to the artifacts
// directory, and the browser's coverage to
// `coverage/userManagement/browser.json` for `coverage.userManagement`.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { sql } from 'kysely'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import type { ActivityPage } from '../common/api'
import { makeId } from '../common/ids'
import { userIdOfGumbo } from '../common/userId'
import { createSession } from '../server/auth/sessions'
import { hashToken, makeToken } from '../server/auth/tokens'
import { type GroupFixture, groupFixture } from '../test/groupFixtures'
import { userAgents } from '../test/userAgents'
import { recordBrowserCoverage } from './browserCoverage.e2e'
import {
  fill,
  freezeBrowserClock,
  press,
  text
} from './creationBrowserActions.e2e'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null)
  throw new Error('Set TS_CREATION_ARTIFACTS for the User Management proof')
const NODE = 105
const RAINES = 106
const base = Date.UTC(2030, 0, 1, 12)

async function login(page: Page, f: GroupFixture, user: number): Promise<void> {
  await freezeBrowserClock(page)
  const email = user === 101 ? 'alex@example.com' : `fixture${user}@example.com`
  await page.goto(f.h.origin + '/sign-in', { waitUntil: 'networkidle0' })
  await fill(page, 'E-mail address', email)
  await press(page, 'Send me a sign-in code')
  await text(page, 'six-digit code is on its way')
  await fill(page, 'Sign-in code', f.h.mail.get(email)!)
  await press(page, 'Sign in')
  await page.waitForSelector('[aria-label^="Account,"]')
}

/** How many rows of a list are drawn, newest-first labels and all. */
async function drawn(page: Page, prefix: string): Promise<string[]> {
  return await page.evaluate(
    prefix =>
      [
        ...document.querySelectorAll<HTMLElement>(`[aria-label^="${prefix}"]`)
      ].map(node => String(node.getAttribute('aria-label'))),
    prefix
  )
}

/** Scrolls to the bottom of the page until `done` holds, or gives up. */
async function scrollUntil(
  page: Page,
  done: () => Promise<boolean>
): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await done()) return
    await page.evaluate(() => {
      const scrollers = [
        document.scrollingElement,
        ...document.querySelectorAll<HTMLElement>('*')
      ].filter(
        (node): node is HTMLElement =>
          node instanceof HTMLElement &&
          node.scrollHeight > node.clientHeight + 4 &&
          getComputedStyle(node).overflowY !== 'visible'
      )
      for (const node of scrollers) node.scrollTop = node.scrollHeight
      window.scrollTo(0, document.body.scrollHeight)
    })
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('The list never reached what was asked of it')
}

async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const f = await groupFixture(resolve('dist'))
  const db = f.h.db
  let browser: Browser | undefined
  const pages: Page[] = []
  const log: string[] = []
  /** A request as the log shows it: a curl line, then the answer. */
  const call = async (
    path: string,
    user: number,
    label = `<token of fixture ${user}>`
  ): Promise<{ status: number; body: unknown }> => {
    const response = await f.h.request('GET', path, undefined, user)
    const body: unknown = await response.json()
    log.push(
      `$ curl -s -H 'authorization: Bearer ${label}' '<origin>/api/v1${path}'`,
      `HTTP ${response.status}`,
      JSON.stringify(body, null, 2),
      ''
    )
    return { status: response.status, body }
  }
  try {
    // 120 logins a minute apart, the newest of all, one person three times.
    for (let i = 0; i < 120; i++)
      await db
        .insertInto('auth_sessions')
        .values({
          id: makeId('authSession'),
          user_id: userIdOfGumbo(i < 3 ? 101 : 102 + (i % 4)),
          token_hash: hashToken(makeToken()),
          user_agent: [
            userAgents.iPhoneSafari,
            userAgents.androidWithModel,
            userAgents.macChrome,
            userAgents.nativeApple
          ][i % 4],
          device_name: i % 4 === 3 ? 'iPad' : null,
          created_at: new Date(base - i * 60_000),
          expires_at: new Date(base + 365 * 86400000)
        })
        .execute()
    // Raines: a second, unverified address, and a coach on the Hawks.
    await db
      .insertInto('user_emails')
      .values({
        id: makeId('userEmail'),
        user_id: userIdOfGumbo(RAINES),
        email: 'raines.second@example.com',
        is_primary: false,
        verified_at: null,
        created_at: new Date()
      })
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(RAINES),
        scope_type: 'team',
        scope_id: f.teamA,
        role: 'coach',
        is_head_coach: true,
        granted_by: null,
        granted_at: new Date()
      })
      .execute()

    // ...a member of the Regular season, and following League A.
    await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: userIdOfGumbo(RAINES),
        season_id: f.seasonA,
        joined_at: new Date()
      })
      .execute()
    await db
      .insertInto('follows')
      .values({
        user_id: userIdOfGumbo(RAINES),
        group_type: 'league',
        group_id: f.leagueA
      })
      .execute()

    browser = await puppeteer.launch({ headless: true })
    const open = async (
      user: number,
      width = 1280,
      height = 900
    ): Promise<Page> => {
      const context = await browser!.createBrowserContext()
      const page = await context.newPage()
      pages.push(page)
      await page.setViewport({ width, height, deviceScaleFactor: 2 })
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        includeRawScriptCoverage: true
      })
      await login(page, f, user)
      return page
    }

    // 1. The row on Node administration, and the screen behind it.
    const node = await open(NODE)
    // Node administration is the sidebar's row directly above the account.
    await node.goto(f.h.origin + '/', { waitUntil: 'networkidle0' })
    const footer = await node.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[data-testid="sidebar-account-footer"] [role="button"]'
        )
      ].map(button => String(button.getAttribute('aria-label')))
    )
    expect(footer.slice(-2)).deep.equals([
      'Node administration',
      'Account, José Alvarez'
    ])
    await node.screenshot({ path: join(artifacts!, 'sidebar-node-admin.png') })
    await press(node, 'Node administration')
    await node.waitForFunction(() => location.pathname === '/node')
    // And Account no longer offers it.
    await node.goto(f.h.origin + '/account', { waitUntil: 'networkidle0' })
    await text(node, 'Delete account')
    expect(
      await node.evaluate(() =>
        [
          ...document.querySelectorAll('main [role="button"], [role="button"]')
        ].some(
          button =>
            button.closest('[data-testid="navigation-sidebar"]') == null &&
            String(button.textContent) === 'Node administration'
        )
      )
    ).equals(false)
    await node.goto(f.h.origin + '/node', { waitUntil: 'networkidle0' })
    await text(node, 'User Management')
    await node.screenshot({
      path: join(artifacts!, 'node-administration-after.png')
    })
    const row = await node.evaluate(() => {
      const button = [
        ...document.querySelectorAll<HTMLElement>('[role="button"]')
      ].find(node => String(node.textContent).startsWith('User Management'))
      return button == null ? '' : String(button.textContent)
    })
    expect(row).includes('chevron_right')
    await node.evaluate(() => {
      ;[...document.querySelectorAll<HTMLElement>('[role="button"]')]
        .find(button =>
          String(button.textContent).startsWith('User Management')
        )!
        .click()
    })
    await node.waitForFunction(() => location.pathname === '/node/users')
    for (const label of ['Recent Logins', 'Recent Sessions', 'User List'])
      await node.waitForFunction(
        label =>
          [...document.querySelectorAll('[role="tab"]')].some(
            tab => tab.textContent === label
          ),
        {},
        label
      )

    // 2. Recent Logins: 50, then 50 more, then 20, then the end.
    const seen: string[] = []
    node.on('response', response => {
      if (!response.url().includes('/api/v1/node/logins')) return
      response
        .json()
        .then((page: ActivityPage) => {
          seen.push(...page.items.map(item => item.id))
        })
        .catch(() => undefined)
    })
    await node.reload({ waitUntil: 'networkidle0' })
    await node.waitForSelector('[aria-label^="Login time"]')
    const first = await drawn(node, 'Login time')
    expect(first[0]).includes('2030-01-01')
    await node.screenshot({ path: join(artifacts!, 'recent-logins.png') })
    await scrollUntil(node, async () => seen.length >= 100)
    await node.screenshot({
      path: join(artifacts!, 'recent-logins-pinned.png')
    })
    // The title has handed up into the header: drawn, and shown, at the top.
    const handedUp = await node.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('div')].some(node => {
        if (node.textContent !== 'User Management') return false
        const box = node.getBoundingClientRect()
        let shown: HTMLElement | null = node
        while (shown != null) {
          if (Number(getComputedStyle(shown).opacity) < 0.5) return false
          shown = shown.parentElement
        }
        return box.top >= 0 && box.bottom < 90 && box.height > 0
      })
    )
    expect(handedUp, 'the title handed up into the header').equals(true)
    await scrollUntil(node, async () =>
      (await node.evaluate(() => String(document.body.textContent))).includes(
        'No older activity.'
      )
    )
    expect(new Set(seen).size, 'no login read twice').equals(seen.length)
    const total = await db
      .selectFrom('auth_sessions')
      .select(eb => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow()
    expect(seen.length).equals(Number(total.n))
    // A login arriving now sorts above every cursor: no page repeats.
    await call('/node/logins?limit=2', NODE)
    const firstPage = (await call('/node/logins?limit=50', NODE))
      .body as ActivityPage
    await createSession(db, userIdOfGumbo(104), 'arrives meanwhile')
    const secondPage = (
      await call(`/node/logins?limit=50&cursor=${firstPage.nextCursor!}`, NODE)
    ).body as ActivityPage
    const ids = [...firstPage.items, ...secondPage.items].map(item => item.id)
    expect(new Set(ids).size).equals(100)
    expect((await call('/node/logins', 101)).status).equals(403)

    // 3. A page that fails keeps the rows above it, and Retry reads it again.
    const retry = await open(NODE)
    let failed = 0
    // The second page fails until Retry: reaching the end again reads it too.
    let failing = true
    await retry.setRequestInterception(true)
    retry.on('request', request => {
      if (failing && request.url().includes('/api/v1/node/logins?cursor=')) {
        failed += 1
        request
          .respond({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'The server is not answering' })
          })
          .catch(() => undefined)
        return
      }
      request.continue().catch(() => undefined)
    })
    await retry.goto(f.h.origin + '/node/users', { waitUntil: 'networkidle0' })
    await retry.waitForSelector('[aria-label^="Login time"]')
    await scrollUntil(retry, async () =>
      (await retry.evaluate(() => String(document.body.textContent))).includes(
        'Retry'
      )
    )
    // Retry on show, under the rows that stayed.
    await retry.evaluate(() => {
      ;[...document.querySelectorAll<HTMLElement>('[role="button"]')]
        .filter(button => String(button.textContent).includes('Retry'))
        .at(-1)!
        .scrollIntoView({ block: 'center' })
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    await retry.screenshot({
      path: join(artifacts!, 'recent-logins-retry.png')
    })
    const kept = await retry.evaluate(() => window.scrollY)
    failing = false
    await press(retry, 'Retry')
    await retry.waitForFunction(
      () => !String(document.body.textContent).includes('Could not load more')
    )
    expect(failed).greaterThan(0)
    expect(
      Math.abs((await retry.evaluate(() => window.scrollY)) - kept)
    ).lessThan(400)

    // 4. Recent Sessions, from real requests an hour and more apart.
    const tablet = await createSession(
      db,
      userIdOfGumbo(103),
      userAgents.iPadSafari
    )
    const laptop = await createSession(
      db,
      userIdOfGumbo(103),
      userAgents.macChrome
    )
    const back = async (session: string, minutes: number): Promise<void> => {
      await db
        .updateTable('auth_sessions')
        .set({
          last_used_at: sql`last_used_at - ${`${minutes} minutes`}::interval`
        })
        .where('id', '=', session)
        .execute()
    }
    await f.h.request('GET', '/me/groups', undefined, tablet.token)
    await back(tablet.sessionId, 30)
    await f.h.request('GET', '/me/groups', undefined, tablet.token)
    await f.h.request('GET', '/me/groups', undefined, laptop.token)
    await back(tablet.sessionId, 120)
    await f.h.request('GET', '/me/groups', undefined, tablet.token)
    const sessions = (await call('/node/sessions', NODE)).body as ActivityPage
    // The tablet's first use, the laptop's, then the tablet's after two hours.
    const ours = new Set(
      (
        await db
          .selectFrom('device_sessions')
          .select('id')
          .where('auth_session_id', 'in', [tablet.sessionId, laptop.sessionId])
          .execute()
      ).map(item => item.id)
    )
    const trout = sessions.items.filter(item => ours.has(item.id))
    // Newest first: the tablet after two hours, the laptop, the tablet's first.
    expect(trout.map(item => item.device)).deep.equals(['iPad', 'Mac', 'iPad'])
    expect(
      trout
        .map(item => item.at)
        .every((at, i, all) => i === 0 || at <= all[i - 1])
    ).equals(true)
    const ofTablet = await db
      .selectFrom('device_sessions')
      .select('id')
      .where('auth_session_id', '=', tablet.sessionId)
      .execute()
    expect(ofTablet).to.have.length(2)
    expect(new Set(trout.map(item => item.lastActiveAt)).size).equals(1)
    expect(sessions.recordedSince).to.be.a('string')
    await node.goto(f.h.origin + '/node/users?tab=sessions', {
      waitUntil: 'networkidle0'
    })
    await text(node, 'Sessions recorded since')
    await node.waitForSelector('[aria-label^="Session start"]')
    await text(node, 'iPad')
    await text(node, 'Mac')
    await node.screenshot({ path: join(artifacts!, 'recent-sessions.png') })

    // 5. User List: a secondary address finds Raines; his card, his account.
    await press(node, 'User List', 'tab')
    await node.waitForFunction(() => location.search === '?tab=users')
    await fill(node, 'Find a person', 'raines.sec')
    await text(node, 'raines.second@example.com')
    // The line under the name, as Add Person draws it.
    await text(node, 'Demo Hawks')
    await node.screenshot({ path: join(artifacts!, 'user-list-results.png') })
    await press(node, 'Tim Raines')
    await text(node, 'Head coach')
    await text(node, 'Unverified')
    await text(node, 'Season · Member')
    await text(node, 'League · Following')
    await node.screenshot({ path: join(artifacts!, 'user-list-details.png') })
    await node.evaluate(() => {
      ;[...document.querySelectorAll<HTMLElement>('[role="button"]')]
        .find(button => String(button.textContent).startsWith('Demo Hawks'))!
        .click()
    })
    await node.waitForFunction(
      teamA => location.pathname.includes(teamA),
      {},
      f.teamA
    )
    await node.goBack({ waitUntil: 'networkidle0' })
    await node.waitForFunction(() => location.pathname === '/node/users')
    await fill(node, 'Find a person', 'raines.sec')
    await press(node, 'Tim Raines')
    await press(node, 'Edit Tim Raines’s account')
    await node.waitForFunction(() =>
      /^\/node\/users\/[^/]+\/account$/.test(location.pathname)
    )
    await node.waitForSelector('input[aria-label="Name"]')
    await text(node, 'Account · Tim Raines')
    // Once the page has slid all the way in.
    await new Promise(resolve => setTimeout(resolve, 800))
    await node.screenshot({ path: join(artifacts!, 'admin-account.png') })
    expect(
      await node.evaluate(() => String(document.body.textContent))
    ).not.includes('Delete account')
    await fill(node, 'Name', 'Timothy Raines')
    await press(node, 'Save name')
    await text(node, 'Name saved')
    expect(
      (
        await db
          .selectFrom('users')
          .select('display_name')
          .where('id', '=', userIdOfGumbo(RAINES))
          .executeTakeFirstOrThrow()
      ).display_name
    ).equals('Timothy Raines')
    await node.goto(f.h.origin + '/node/users?tab=users', {
      waitUntil: 'networkidle0'
    })
    await fill(node, 'Find a person', 'raines.sec')
    await press(node, 'Timothy Raines')
    await text(node, 'Timothy Raines')

    // 1, continued: anybody else is refused, and so is the API, and Node
    // administration offers them no User Management row.
    const member = await open(101)
    await member.goto(f.h.origin + '/', { waitUntil: 'networkidle0' })
    await member.waitForSelector('[data-testid="sidebar-account-footer"]')
    expect(
      await member.evaluate(
        () =>
          document.querySelector('[aria-label="Node administration"]') == null
      )
    ).equals(true)
    await member.goto(f.h.origin + '/node', { waitUntil: 'networkidle0' })
    await new Promise(resolve => setTimeout(resolve, 3500))
    expect(
      await member.evaluate(() =>
        String(document.body.textContent).includes('User Management')
      )
    ).equals(false)
    for (const path of [
      '/node/users',
      `/node/users/${userIdOfGumbo(RAINES)}/account`
    ]) {
      await member.goto(f.h.origin + path, { waitUntil: 'networkidle0' })
      await text(member, 'Only node administrators can open User Management.')
      // No tab of User Management, and no field of the account.
      expect(
        await member.evaluate(
          () =>
            [...document.querySelectorAll('[role="tab"]')].filter(tab =>
              ['Recent Logins', 'Recent Sessions', 'User List'].includes(
                String(tab.textContent)
              )
            ).length +
            document.querySelectorAll('input[aria-label="Name"]').length
        )
      ).equals(0)
    }
    expect(
      await member.evaluate(
        async () => (await fetch('/api/v1/node/logins')).status
      )
    ).equals(403)

    // 6. A phone: every column of a row, nothing off its edge.
    const phone = await open(NODE, 390, 844)
    // No sidebar: the account menu's last row.
    await phone.goto(f.h.origin + '/', { waitUntil: 'networkidle0' })
    await press(phone, 'Account, José Alvarez')
    await phone.waitForSelector('[aria-label="Node administration"]')
    await new Promise(resolve => setTimeout(resolve, 400))
    await phone.screenshot({ path: join(artifacts!, 'menu-node-admin.png') })
    await press(phone, 'Node administration')
    await phone.waitForFunction(() => location.pathname === '/node')
    await phone.goto(f.h.origin + '/node/users', { waitUntil: 'networkidle0' })
    await phone.waitForSelector('[aria-label^="Login time"]')
    await text(phone, 'Last active')
    expect(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      ),
      'no sideways scroll'
    ).equals(true)
    await phone.screenshot({
      path: join(artifacts!, 'recent-logins-phone.png')
    })
    await phone.goto(f.h.origin + '/node/users?tab=sessions', {
      waitUntil: 'networkidle0'
    })
    await phone.waitForSelector('[aria-label^="Session start"]')

    await mkdir(resolve('coverage/userManagement'), { recursive: true })
    await recordBrowserCoverage(
      pages,
      f.h.origin,
      resolve('coverage/userManagement/browser.json')
    )
    await writeFile(
      join(artifacts!, 'node-activity-api.log'),
      log.join('\n') + '\n'
    )
    console.log('userManagement.e2e: scenarios 1–6 pass')
  } finally {
    await browser?.close()
    await f.h.close()
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
