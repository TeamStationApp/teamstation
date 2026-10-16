import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { groupFixture } from '../test/groupFixtures'
import { recordBrowserCoverage } from './browserCoverage.e2e'
import {
  fill,
  freezeBrowserClock,
  press,
  text
} from './creationBrowserActions.e2e'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null) throw new Error('Set TS_CREATION_ARTIFACTS for UI proof')

async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const f = await groupFixture(resolve('dist'))
  let browser: Browser | undefined
  const pages: Page[] = []
  const lines = ['$ node -r sucrase/register src/app/creationUi.e2e.ts']
  try {
    await f.h.db
      .updateTable('users')
      .set({
        display_name: 'Demo Viewer',
        first_name: 'Demo',
        last_name: 'Viewer'
      })
      .where('id', '=', 106)
      .execute()
    browser = await puppeteer.launch({ headless: true, args: ['--lang=en-US'] })
    async function login(user: number): Promise<Page> {
      const context = await browser!.createBrowserContext()
      const page = await context.newPage()
      pages.push(page)
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        includeRawScriptCoverage: true
      })
      await page.setViewport({ width: 1440, height: 1000 })
      await freezeBrowserClock(page)
      await page.emulateTimezone('America/Los_Angeles')
      const email =
        user === 101 ? 'alex@example.com' : `fixture${user}@example.com`
      await page.goto(f.h.origin + '/sign-in')
      await fill(page, 'E-mail address', email)
      await press(page, 'Send me a sign-in code')
      await text(page, 'six-digit code is on its way')
      await fill(page, 'Sign-in code', f.h.mail.get(email)!)
      await press(page, 'Sign in')
      await page.waitForSelector('[aria-label^="Account,"]')
      await text(
        page,
        user === 106
          ? 'Create League'
          : user === 101
            ? 'Demo League A'
            : 'Demo Only Team'
      )
      return page
    }
    async function navigation(
      page: Page
    ): Promise<
      Array<{ left: number; right: number; top: number; bottom: number }>
    > {
      return await page.evaluate(() =>
        [
          '[role="tab"][aria-label="Home"]',
          '[role="tab"][aria-label="Videos"]',
          '[role="tab"][aria-label="Schedule"]',
          '[aria-label="Notifications"]',
          '[aria-label^="Account,"]'
        ].map(selector => {
          const node = document.querySelector(selector)
          if (node == null)
            throw new Error('Missing navigation control: ' + selector)
          const r = node.getBoundingClientRect()
          if (
            r.width <= 0 ||
            r.height <= 0 ||
            r.left < 0 ||
            r.right > innerWidth ||
            r.top < -1 ||
            r.bottom > innerHeight
          )
            throw new Error(
              'Navigation control outside viewport: ' +
                selector +
                ' ' +
                JSON.stringify(r.toJSON())
            )
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
        })
      )
    }
    const shot = async (page: Page, name: string): Promise<void> => {
      await page.screenshot({ path: join(artifacts!, name + '-after.png') })
    }
    const p = await login(106)
    await shot(p, 'empty-home')
    await press(p, 'Create League')
    await shot(p, 'league-name')
    await fill(p, 'League name', 'Demo Only League')
    await press(p, 'Continue')
    await fill(p, 'City', 'York')
    await p.waitForSelector('[aria-label^="Choose "]')
    const cityChoice = await p.$eval('[aria-label^="Choose "]', node =>
      node.getAttribute('aria-label')
    )
    if (cityChoice == null) throw new Error('No city matched York')
    await press(p, cityChoice)
    await press(p, 'Continue')
    await press(p, 'Use initials')
    expect(await p.$('[aria-label="Initials preview: DO"]')).not.equals(null)
    expect(await p.$('[aria-label="Baseball"]')).equals(null)
    await shot(p, 'group-photo')
    await press(p, 'Create League')
    await text(p, 'Group settings')
    await p.goto(f.h.origin)
    await text(p, 'Demo Only League')
    await shot(p, 'partial-no-teams-home')
    await press(p, 'Create Season')
    await fill(p, 'Season name', 'Demo Spring')
    await press(p, 'Continue')
    await press(p, 'Custom time frame')
    await press(p, '2026-10-08')
    await press(p, '2026-10-20')
    const range = await p.evaluate(() => {
      const style = (day: string): CSSStyleDeclaration =>
        getComputedStyle(document.querySelector(`[aria-label="${day}"]`)!)
      return {
        blue: style('2026-10-08').backgroundColor,
        left: style('2026-10-08').borderTopLeftRadius,
        cutoff: style('2026-10-10').borderTopRightRadius,
        continuation: style('2026-10-11').borderTopLeftRadius,
        white: getComputedStyle(
          document.querySelector('[aria-label="2026-10-12"]')!
            .firstElementChild!
        ).color
      }
    })
    expect(range.blue).equals('rgb(23, 105, 210)')
    expect(range.left).not.equals('0px')
    expect(range.cutoff).equals('0px')
    expect(range.continuation).equals('0px')
    expect(range.white).equals('rgb(255, 255, 255)')
    await shot(p, 'calendar')
    await press(p, 'Use this range')
    await press(p, 'Continue')
    await press(p, 'Use initials')
    await press(p, 'Create Season')
    await text(p, 'Group settings')
    await p.reload()
    await text(p, 'Demo Spring')
    lines.push(
      'PASS: name-first league and season creation, initials preview, persisted creation, blue wrapped calendar with white dates'
    )
    const admin = await login(101)
    const desktop = await navigation(admin)
    for (let index = 1; index < desktop.length; index++) {
      expect(desktop[index - 1].right).at.most(desktop[index].left)
      expect(desktop[index].top).lessThan(60)
    }
    await shot(admin, 'populated-home')
    expect(await admin.evaluate(() => document.body.textContent)).not.includes(
      'Create an organization'
    )
    await press(admin, 'Demo League A')
    await press(admin, 'Group settings')
    await press(admin, 'Change picture')
    await shot(admin, 'settings-photo')
    await admin.setViewport({ width: 390, height: 844 })
    await admin.goto(f.h.origin)
    await text(admin, 'Demo League A')
    await shot(admin, 'narrow-header')
    const narrow = await navigation(admin)
    expect(narrow[3].right).at.most(narrow[4].left)
    expect(narrow[3].top).lessThan(60)
    expect(narrow[4].top).lessThan(60)
    for (const tab of narrow.slice(0, 3)) expect(tab.top).greaterThan(700)
    expect(
      await admin.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      )
    ).equals(false)
    await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Only Team',
        locality: {
          city: 'Demo City',
          region: 'Demo Region',
          country: 'US',
          placeId: null,
          timezone: 'UTC'
        },
        idempotencyKey: 'ui-only-team'
      },
      104
    )
    const team = await login(104)
    await text(team, 'Demo Only Team')
    await shot(team, 'team-only-home')
    expect(await team.evaluate(() => document.body.textContent)).not.includes(
      'Create an organization'
    )
    await press(team, 'Add Team')
    await fill(team, 'Team name', 'Demo New Team')
    await press(team, 'Continue')
    await press(team, 'Enter location manually')
    await fill(team, 'City', 'Demo City')
    await fill(team, 'State or region', 'Demo Region')
    await press(team, 'Confirm location')
    await press(team, 'Continue')
    const chooser = team.waitForFileChooser()
    await press(team, 'Add Photo')
    await (
      await chooser
    ).accept([resolve('src/app/assets/sports/baseball-192.png')])
    await team.waitForSelector('[aria-label="Your selected photo"]')
    await press(team, 'Create Team')
    await text(team, 'Group settings')
    await team.reload()
    await text(team, 'Demo New Team')
    lines.push(
      'PASS: contextual home controls, settings photo chooser, narrow navigation order and no overflow, photo team creation survives reload'
    )
    await recordBrowserCoverage(
      pages,
      f.h.origin,
      resolve('coverage/creation/ui-browser.json')
    )
    await writeFile(join(artifacts!, 'ui-browser.log'), lines.join('\n') + '\n')
    console.log(lines.slice(1).join('\n'))
  } finally {
    await browser?.close()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
