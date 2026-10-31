import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { recordBrowserCoverage } from '../../e2e/rigs/browserCoverage'
import {
  fill,
  freezeBrowserClock,
  press,
  text
} from '../../e2e/rigs/creationBrowserActions'
import { type GroupFixture, groupFixture } from '../test/groupFixtures'

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
  await text(page, 'Your Home')
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
    // The team's only direct administrator cannot be taken out.
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
    // Adding somebody is in the team's Settings, and an address an account
    // has verified is added at once, with nothing to accept.
    await team.goto(f.h.origin + `/groups/team/${f.teamA}`, {
      waitUntil: 'networkidle0'
    })
    await press(team, 'Manage')
    await press(team, 'Add Person to Team')
    await fill(team, 'E-mail addresses', 'fixture106@example.com')
    await toggle(team, 'Team admin')
    await press(team, 'Send invite')
    await text(team, 'Team management')
    await team.screenshot({
      path: join(artifacts!, 'admin-added-at-once.png')
    })
    await recipient.bringToFront()
    await recipient.goto(f.h.origin + '/notifications', {
      waitUntil: 'networkidle0'
    })
    await text(recipient, 'added you as Admin')
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
    // The new administrator finds themselves among the team's Admins.
    await recipient.goto(f.h.origin + `/teams/${f.teamA}?tab=team`, {
      waitUntil: 'networkidle0'
    })
    await text(recipient, 'ADMINS')
    await text(recipient, 'Tim R')
    await recipient.screenshot({
      path: join(artifacts!, 'roster-admin-after.png')
    })
    lines.push(
      "E9 PASS: the sole direct administrator cannot be taken out; an administrator added from Settings takes effect at once and is told in the inbox; only then does the first administrator's removal succeed"
    )

    await node.bringToFront()
    await node.goto(f.h.origin + '/node', { waitUntil: 'networkidle0' })
    await fill(node, 'Find an account', 'Tim Raines')
    // Suspension remains an API action; this screen manages node access.
    const protectedAccount = await f.h.request(
      'PATCH',
      '/users/106/administration',
      { suspended: true },
      105
    )
    expect(protectedAccount.status).equals(409)
    const second = await f.h.request(
      'POST',
      `/manage/team/${f.teamA}/people`,
      {
        email: 'fixture103@example.com',
        admin: true,
        idempotencyKey: 'browser-node-replacement'
      },
      105
    )
    expect(second.status).equals(201)
    expect(await second.json()).deep.include({ added: true })
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/106/administration',
          { suspended: true },
          105
        )
      ).status
    ).equals(200)
    expect(
      (await f.h.request('GET', '/me/groups', undefined, 106)).status
    ).equals(401)
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/106/administration',
          { suspended: false },
          105
        )
      ).status
    ).equals(200)
    expect(
      (await f.h.request('GET', '/me/groups', undefined, 106)).status
    ).equals(401)
    await node.reload({ waitUntil: 'networkidle0' })
    await fill(node, 'Find an account', 'Tim Raines')
    await press(node, 'Add Tim Raines')
    await node.waitForSelector('[aria-label="Revoke Tim Raines"]')
    await node.screenshot({
      path: join(artifacts!, 'node-administration-after.png')
    })
    await recipient.bringToFront()
    await login(recipient, f, 106)
    await recipient.goto(f.h.origin + '/account', { waitUntil: 'networkidle0' })
    await press(recipient, 'Node administration')
    await recipient.waitForSelector('[aria-label="Find an account"]')
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
      'E9 PASS: sole direct administrator suspension is blocked; a second administrator added at once enables suspension; reactivation preserves identity and requires a fresh sign-in; node role appears on that account; lower scopes cannot read or moderate the node'
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
    await newcomer.goto(f.h.origin + `/teams/${f.teamA}?tab=team`, {
      waitUntil: 'networkidle0'
    })
    await text(newcomer, 'Hank A')
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
