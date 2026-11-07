import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { makeId } from '../common/ids'
import { userIdOfGumbo } from '../common/userId'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { groupFixture } from '../test/groupFixtures'
import { insertFixtureUsers } from '../test/insertFixtureUsers'
import {
  browserSession,
  contains,
  fill,
  maestro,
  tap
} from '../test/refinementsMaestro.e2e'

async function main(): Promise<void> {
  const artifacts = process.env.TS_ADD_PEOPLE_ARTIFACTS
  const work = process.env.TS_ADD_PEOPLE_WORK
  if (artifacts == null || work == null)
    throw new Error('Supply TS_ADD_PEOPLE_ARTIFACTS and TS_ADD_PEOPLE_WORK')
  await mkdir(artifacts, { recursive: true })
  const f = await groupFixture(resolve('dist'))
  const daemon = await maestro('addMember')
  const log = ['$ node -r sucrase/register src/app/addPeople.e2e.ts']
  try {
    await insertFixtureUsers(
      f.h.db,
      Array.from({ length: 6 }, (_, n) => ({
        id: 400 + n,
        display_name: `Mookie Betts ${n}`,
        first_name: `Mookie${n}`,
        last_name: 'Betts',
        login_enabled: true,
        email: `selection${n}@example.test`
      }))
    )
    await f.h.db
      .insertInto('memberships')
      .values(
        Array.from({ length: 6 }, (_, n) => ({
          id: makeId('membership'),
          team_id: f.teamB,
          user_id: userIdOfGumbo(400 + n),
          role: 'member' as const,
          is_player: true
        }))
      )
      .execute()
    const session = await browserSession(
      daemon,
      'addMember-browser',
      1280,
      900,
      work
    )
    const { m, page, browser } = session
    try {
      await browser.setCookie({
        name: SESSION_COOKIE,
        value: f.h.tokens.get(101)!,
        domain: new URL(f.h.origin).hostname,
        path: '/'
      })
      const url = `${f.h.origin}/groups/team/${f.teamA}/settings/people`
      await m.openBrowser({ url })
      await contains(page, 'Add People')
      const emailTop = async (): Promise<number> =>
        await page.$eval(
          '[aria-label="E-mail addresses"]',
          node => node.getBoundingClientRect().top
        )
      const before = await emailTop()
      await fill(m, 'Search users', 'Mookie')
      await m.assertVisible({ text: 'Select Mookie0 B', timeout: 10000 })
      assert.equal(
        await page.$$eval(
          '[data-testid="account-search-results"] [role="button"]',
          rows => rows.length
        ),
        5
      )
      assert.equal(await emailTop(), before)
      const identity = await page.$eval(
        '[aria-label="Select Mookie0 B"]',
        row => row.textContent
      )
      assert.ok(identity?.includes('MB') === true)
      assert.ok(identity?.includes('Demo Eagles'))
      await writeFile(
        join(artifacts, 'account-results.png'),
        await m.screenshot()
      )
      await tap(m, 'Select Mookie0 B')
      assert.equal(
        await page.$eval(
          '[aria-label="Search users"]',
          node => (node as HTMLInputElement).value
        ),
        ''
      )
      assert.equal(await page.$('[data-testid="account-search-results"]'), null)
      await fill(m, 'Search users', 'Mookie')
      await m.assertVisible({ text: 'Select Mookie1 B', timeout: 10000 })
      assert.equal(await page.$('[aria-label="Select Mookie0 B"]'), null)
      await tap(m, 'Select Mookie1 B')
      await tap(m, 'Remove Mookie0 B')
      await fill(m, 'Search users', 'Mookie0')
      await tap(m, 'Select Mookie0 B')
      await writeFile(
        join(artifacts, 'add-people-after.png'),
        await m.screenshot()
      )
      await fill(m, 'Search users', 'Nobody matching')
      await contains(page, 'No accounts match')
      await m.pressKey({ key: 'ESCAPE' })
      assert.equal(await page.$('[data-testid="account-search-results"]'), null)
      await fill(m, 'Search users', 'Mookie2')
      await m.assertVisible({ text: 'Select Mookie2 B', timeout: 10000 })
      await tap(m, 'Close account results')
      assert.equal(await page.$('[data-testid="account-search-results"]'), null)
      await fill(
        m,
        'E-mail addresses',
        'selection0@example.test, invited@example.test'
      )
      await tap(m, 'Add people')
      await contains(page, 'Added 2, invited 1')
      const memberships = await f.h.db
        .selectFrom('memberships')
        .select('user_id')
        .where('team_id', '=', f.teamA)
        .where('user_id', 'in', [userIdOfGumbo(400), userIdOfGumbo(401)])
        .execute()
      assert.equal(memberships.length, 2)
      assert.ok(f.h.links.has('invited@example.test'))
      log.push(
        'PASS: five-result overlay keeps email fixed; multiple selections, removal, exclusions, Escape/outside dismissal and no-match state.',
        'PASS: selected accounts plus duplicate email add two members once and invite one new address.'
      )
      await m.openBrowser({ url })
      await fill(m, 'Search users', 'Mookie2')
      await tap(m, 'Select Mookie2 B')
      await tap(m, 'Add people')
      await contains(page, 'Added 1, invited 0')
      log.push(
        'PASS: selected accounts alone enable submit and persist membership.'
      )
      await writeFile(join(artifacts, 'add-people.log'), log.join('\n') + '\n')
      console.log(log.join('\n'))
    } finally {
      await browser.disconnect()
    }
  } finally {
    await daemon.shutdown()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
