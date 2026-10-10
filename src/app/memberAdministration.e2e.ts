import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { type GroupFixture, groupFixture } from '../test/groupFixtures'
import { recordBrowserCoverage } from './browserCoverage.e2e'
import {
  fill,
  freezeBrowserClock,
  press,
  text
} from './creationBrowserActions.e2e'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null)
  throw new Error('Set TS_CREATION_ARTIFACTS for member administration proof')
async function login(page: Page, f: GroupFixture, user: number): Promise<void> {
  await freezeBrowserClock(page)
  const email =
    user === 101
      ? 'alex@example.com'
      : user === 102
        ? 'casey@example.com'
        : `fixture${user}@example.com`
  await page.goto(f.h.origin + '/sign-in', { waitUntil: 'networkidle0' })
  await fill(page, 'E-mail address', email)
  await press(page, 'Send me a sign-in code')
  await text(page, 'six-digit code is on its way')
  await fill(page, 'Sign-in code', f.h.mail.get(email)!)
  await press(page, 'Sign in')
  await page.waitForSelector('[aria-label^="Account,"]')
  await text(page, 'Discover leagues, seasons and teams')
}
async function toggle(page: Page, label: string): Promise<void> {
  await page.waitForSelector(`input[aria-label="${label}"]`)
  await page.$eval(`input[aria-label="${label}"]`, input => {
    input.click()
  })
}
async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const f = await groupFixture(resolve('dist'))
  let browser: Browser | undefined
  const pages: Page[] = []
  const lines = [
    '$ node -r sucrase/register src/app/memberAdministration.e2e.ts'
  ]
  try {
    browser = await puppeteer.launch({ headless: true })
    const actorPage = async (user: number | undefined): Promise<Page> => {
      const context = await browser!.createBrowserContext()
      const page = await context.newPage()
      pages.push(page)
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        includeRawScriptCoverage: true
      })
      if (user != null) await login(page, f, user)
      return page
    }
    const team = await actorPage(101)
    const recipient = await actorPage(106)
    const node = await actorPage(105)
    await team.bringToFront()
    await team.goto(f.h.origin + `/groups/team/${f.teamA}`, {
      waitUntil: 'networkidle0'
    })
    await press(team, 'Manage people and roles')
    await text(team, 'Add somebody')
    await fill(team, 'E-mail address', 'fixture106@example.com')
    await press(team, 'Choose invitation roles')
    await toggle(team, 'Team admin')
    await press(team, 'Save')
    await press(team, 'Add')
    await text(team, 'An invitation is on its way')
    await press(team, 'Open sent invitation')
    await text(team, 'Pending')
    const requestId = new URL(team.url()).pathname.split('/').at(-1)!
    expect(
      (
        await f.h.request(
          'DELETE',
          `/manage/team/${f.teamA}/people/101`,
          undefined,
          101
        )
      ).status
    ).equals(409)
    await team.screenshot({
      path: join(artifacts!, 'pending-admin-replacement.png')
    })
    await recipient.bringToFront()
    await recipient.goto(f.h.origin + `/notifications/${requestId}`, {
      waitUntil: 'networkidle0'
    })
    await text(recipient, 'administrator')
    await press(recipient, 'Accept invitation')
    await text(recipient, 'Accepted')
    expect(
      (
        await f.h.request(
          'DELETE',
          `/manage/team/${f.teamA}/people/101`,
          undefined,
          101
        )
      ).status
    ).equals(200)
    await recipient.goto(f.h.origin + `/groups/team/${f.teamA}`, {
      waitUntil: 'networkidle0'
    })
    await press(recipient, 'Manage people and roles')
    await text(recipient, 'Tim Raines')
    await recipient.screenshot({ path: join(artifacts!, 'manage-after.png') })
    lines.push(
      'E9 PASS: requested direct administrator access stays pending; last-direct removal is refused before acceptance and succeeds after the real recipient approves'
    )

    await node.bringToFront()
    await node.goto(f.h.origin + '/node', { waitUntil: 'networkidle0' })
    await fill(node, 'Find an account', 'Tim Raines')
    await press(node, 'Suspend Tim Raines')
    await press(node, 'Confirm account change')
    await text(node, 'Add another active direct administrator')
    await node.screenshot({
      path: join(artifacts!, 'last-admin-protected.png')
    })
    // A second independent signed-in recipient accepts the team replacement.
    const second = await actorPage(103)
    const invitation = await f.h.request(
      'POST',
      `/manage/team/${f.teamA}/people`,
      {
        email: 'fixture103@example.com',
        admin: true,
        idempotencyKey: 'browser-node-replacement'
      },
      105
    )
    const next = (
      (await invitation.json()) as { invited: { requestId: string } }
    ).invited.requestId
    await second.goto(f.h.origin + `/notifications/${next}`, {
      waitUntil: 'networkidle0'
    })
    await press(second, 'Accept invitation')
    await text(second, 'Accepted')
    await node.bringToFront()
    await press(node, 'Confirm account change')
    await text(node, 'Suspended')
    expect(
      (await f.h.request('GET', '/me/groups', undefined, 106)).status
    ).equals(401)
    await press(node, 'Reactivate Tim Raines')
    await press(node, 'Confirm account change')
    await text(node, 'Account · Active')
    expect(
      (await f.h.request('GET', '/me/groups', undefined, 106)).status
    ).equals(401)
    await press(node, 'Grant node role to Tim Raines')
    await press(node, 'Confirm account change')
    await text(node, 'Node administrator · Active')
    await node.screenshot({
      path: join(artifacts!, 'node-administration-after.png')
    })
    await recipient.bringToFront()
    await login(recipient, f, 106)
    await recipient.goto(f.h.origin + '/account', { waitUntil: 'networkidle0' })
    await press(recipient, 'Node administration')
    await text(recipient, 'Find an account')
    await team.bringToFront()
    await team.goto(f.h.origin + '/node', { waitUntil: 'networkidle0' })
    await text(team, 'Only a node administrator')
    expect(await team.evaluate(() => document.body.textContent)).not.includes(
      'fixture106@example.com'
    )
    await team.screenshot({
      path: join(artifacts!, 'node-admin-protected.png')
    })
    lines.push(
      'E9 PASS: sole direct administrator suspension is blocked; an accepted replacement enables suspension; reactivation preserves identity and requires a fresh sign-in; node role appears on that account; lower scopes cannot read or moderate the node'
    )

    const unknownEmail = 'new-browser-member@example.com'
    const personal = await f.h.request(
      'POST',
      `/manage/team/${f.teamA}/people`,
      {
        email: unknownEmail,
        flags: ['coach'],
        idempotencyKey: 'browser-new-person-invitation'
      },
      101
    )
    expect(personal.status).equals(201)
    const invitationCode = (
      (await personal.json()) as { invited: { code: string } }
    ).invited.code
    expect(
      await f.h.db
        .selectFrom('user_emails')
        .select('id')
        .where('email', '=', unknownEmail)
        .execute()
    ).length(0)
    const newcomer = await actorPage(undefined)
    await newcomer.goto(f.h.origin + '/i/' + invitationCode, {
      waitUntil: 'networkidle0'
    })
    await fill(newcomer, 'Your name', 'Hank Aaron')
    await fill(newcomer, 'E-mail address', unknownEmail)
    await press(newcomer, 'Send me a sign-in code')
    await newcomer.waitForSelector('input[aria-label="Sign-in code"]')
    await fill(newcomer, 'Sign-in code', f.h.mail.get(unknownEmail)!)
    await press(newcomer, 'Join')
    await newcomer.waitForSelector('input[aria-label="Name"]')
    await fill(newcomer, 'Name', 'Hank Aaron')
    await press(newcomer, 'Continue')
    await press(newcomer, 'Use my initials')
    await text(newcomer, 'You can already watch')
    await press(newcomer, 'Have a look')
    const person = await f.h.db
      .selectFrom('user_emails')
      .select('user_id')
      .where('email', '=', unknownEmail)
      .executeTakeFirstOrThrow()
    expect(
      await f.h.db
        .selectFrom('scope_roles')
        .select(['scope_type', 'scope_id', 'role'])
        .where('user_id', '=', person.user_id)
        .execute()
    ).deep.equals([{ scope_type: 'team', scope_id: f.teamA, role: 'coach' }])
    expect(
      await f.h.db
        .selectFrom('users')
        .select(['is_admin', 'onboarding_step'])
        .where('id', '=', person.user_id)
        .executeTakeFirstOrThrow()
    ).deep.equals({ is_admin: false, onboarding_step: 'complete' })
    await newcomer.goto(f.h.origin + `/groups/team/${f.teamA}`, {
      waitUntil: 'networkidle0'
    })
    await text(newcomer, 'Hank A.')
    await newcomer.screenshot({
      path: join(artifacts!, 'person-invitation-onboarding.png')
    })
    lines.push(
      'E8 PASS: an unknown personal invitation creates no early account; email verification claims only its explicit coach role; name/photo onboarding completes and private membership stays on the invited team'
    )
    await recordBrowserCoverage(
      pages,
      f.h.origin,
      resolve('coverage/creation/members-browser.json')
    )
    await writeFile(
      join(artifacts!, 'member-browser-vectors.log'),
      lines.join('\n') + '\n'
    )
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
