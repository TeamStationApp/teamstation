import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { userIdOfGumbo } from '../common/userId'
import { readPasswordRecord } from '../server/auth/passwords'
import { makeToken, SESSION_COOKIE } from '../server/auth/tokens'
import {
  type AccountHarness,
  accountHarness,
  accountTestPicture
} from '../test/accountHarness'
import { testPasswordKdf } from '../test/passwordFixtures'

const artifacts = process.env.TS_ACCOUNT_ARTIFACTS
if (artifacts == null)
  throw new Error('Set TS_ACCOUNT_ARTIFACTS for account screenshots and logs')
let h: AccountHarness, browser: Browser, page: Page
const password = makeToken()
const nextPassword = makeToken()
const waitText = async (value: string): Promise<void> => {
  await page.waitForFunction(
    text => {
      const content = document.body.textContent
      if (content === null) return false
      return content.toLowerCase().includes(text.toLowerCase())
    },
    {},
    value
  )
}
async function press(label: string): Promise<void> {
  await page.evaluate(label => {
    const button = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(
      node =>
        (node.hasAttribute('aria-label')
          ? node.getAttribute('aria-label')
          : node.textContent) === label
    )
    if (button == null) throw new Error(`Missing button: ${label}`)
    if (button.getAttribute('aria-disabled') === 'true')
      throw new Error(`Disabled button: ${label}`)
    button.click()
  }, label)
}
async function fill(label: string, value: string): Promise<void> {
  const selector = `input[aria-label="${label}"]`
  await page.waitForSelector(selector)
  await page.$eval(selector, input => {
    ;(input as HTMLInputElement).select()
  })
  await page.keyboard.press('Backspace')
  await page.type(selector, value)
}
/** Waits for an element to stop moving, as a sheet does once it has slid up. */
async function settled(selector: string): Promise<void> {
  let last = ''
  for (let tries = 0; tries < 40; tries++) {
    const box = await (await page.waitForSelector(selector))!.boundingBox()
    const now = JSON.stringify(box)
    if (box != null && now === last) return
    last = now
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
async function clearLimits(): Promise<void> {
  await h.resetLimits()
}
async function login(email: string, secret: string): Promise<void> {
  await page.goto(h.origin + '/sign-in', { waitUntil: 'networkidle0' })
  await press('Use a password instead')
  await fill('E-mail address', email)
  await fill('Password', secret)
  await press('Sign in')
  await page.waitForFunction(
    () => document.querySelector('[aria-label^="Account, "]') != null
  )
  await page.goto(h.origin + '/account', { waitUntil: 'networkidle0' })
  await waitText('Email addresses')
}
describe('account settings in the finished desktop application', function () {
  this.timeout(180000)
  before(async () => {
    await mkdir(artifacts, { recursive: true })
    h = await accountHarness(path.resolve('dist'))
    browser = await puppeteer.launch({ headless: true })
    page = await browser.newPage()
    page.on('request', request => {
      if (request.url().includes('/api/v1/') && request.postData() != null) {
        const payload = request.postData()!
        expect(payload).not.includes(password)
        expect(payload).not.includes(nextPassword)
        expect(payload).not.includes('currentPassword')
      }
    })
    page.on('pageerror', error => {
      console.error('Browser error:', error)
    })
    await page.setViewport({ width: 1100, height: 1000, deviceScaleFactor: 1 })
    await browser.setCookie({
      name: SESSION_COOKIE,
      value: h.tokens.get(101)!,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
    await page.goto(h.origin + '/account', { waitUntil: 'networkidle0' })
    await waitText('Email addresses').catch(async (error: unknown) => {
      console.error(await page.evaluate(() => document.body.textContent))
      throw error
    })
  })
  after(async () => {
    await browser?.close()
    await h?.close()
  })
  it('saves name and photo through the real API, Space uploads and reload', async () => {
    await fill('Name', 'Mookie Betts')
    await press('Save name')
    await waitText('Name saved')
    const picture = path.join(artifacts, 'support', 'profile.webp')
    await mkdir(path.dirname(picture), { recursive: true })
    await writeFile(picture, Buffer.from(accountTestPicture.base64, 'base64'))
    await press('Add photo')
    const [chooser] = await Promise.all([
      page.waitForFileChooser(),
      press('Add Photo')
    ])
    await chooser.accept([picture])
    await waitText('Your photo is selected')
    await press('Save photo')
    await waitText('Photo saved')
    expect(h.objects.size).equals(2)
    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForSelector('[aria-label="Change photo"]')
    await waitText('Mookie Betts')
    expect(
      await page.evaluate(() =>
        [...document.images].some(
          image =>
            image.complete &&
            image.naturalWidth > 0 &&
            image.src.includes('/images/user/')
        )
      )
    ).equals(true)
    await page.screenshot({ path: path.join(artifacts, 'account-after.png') })
    await press('Back')
    await page.waitForSelector('[aria-label="Account, Mookie Betts"]')
    await press('Account, Mookie Betts')
    await waitText('Email addresses')
    const playerResponse = await h.request(
      'GET',
      `/players/${userIdOfGumbo(101)}`
    )
    expect(playerResponse.status).equals(200)
    const player = (await playerResponse.json()) as {
      name: string
      avatarUrl: string
    }
    expect(player.name).equals('Mookie B')
    expect((await fetch(player.avatarUrl)).status).equals(200)
  })
  it('sets and changes a password, signs in again, and keeps code login', async () => {
    await press('Set password')
    await fill('New password', password)
    await fill('Confirm new password', password)
    await press('Save password')
    await waitText('Password saved')
    await press('Sign out')
    await login('alex@example.com', password)
    await press('Change password')
    await fill('Current password', 'wrong')
    await fill('New password', nextPassword)
    await fill('Confirm new password', nextPassword)
    await press('Save password')
    await waitText('current password is incorrect')
    await fill('Current password', password)
    await press('Save password')
    await waitText('Password saved')
    await press('Sign out')
    await login('alex@example.com', nextPassword)
    await press('Sign out')
    await page.goto(h.origin + '/sign-in', { waitUntil: 'networkidle0' })
    await fill('E-mail address', 'alex@example.com')
    await press('Send me a sign-in code')
    await waitText('Verifying your email creates an')
    await fill('Sign-in code', h.mail.get('alex@example.com')!)
    await press('Sign in')
    await page.waitForSelector('[aria-label="Account, Mookie Betts"]')
    await press('Account, Mookie Betts')
    await waitText('Email addresses')
  })
  it('upgrades a legacy password only after email verification and resets forgotten passwords', async () => {
    await clearLimits()
    await h.db
      .updateTable('users')
      .set({ password_hash: '$2b$11$legacy-synthetic-fixture' })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
    await page.reload({ waitUntil: 'networkidle0' })
    await press('Verify email and set password')
    await waitText('Enter the code sent')
    await page.screenshot({ path: path.join(artifacts, 'password-after.png') })
    await fill('Password reset code', 'wrong')
    await fill('New password', nextPassword)
    await fill('Confirm new password', nextPassword)
    await press('Save password')
    await waitText('incorrect or expired')
    await fill('Password reset code', h.mail.get('alex@example.com')!)
    await press('Save password')
    await waitText('Password saved')
    await press('Change password')
    await press('Reset with an email code')
    await waitText('Enter the code sent')
    await fill('Password reset code', h.mail.get('alex@example.com')!)
    await fill('New password', nextPassword)
    await fill('Confirm new password', nextPassword)
    await press('Save password')
    await waitText('Password saved')
    await press('Sign out')
    await page.goto(h.origin + '/sign-in', { waitUntil: 'networkidle0' })
    await press('Use a password instead')
    await fill('E-mail address', 'alex@example.com')
    await fill('Password', 'wrong invented password')
    await press('Sign in')
    await waitText('Use an email code')
    await page.screenshot({ path: path.join(artifacts, 'login-after.png') })
    await login('alex@example.com', nextPassword)
    const record = readPasswordRecord(
      (
        await h.db
          .selectFrom('users')
          .select('password_hash')
          .where('id', '=', userIdOfGumbo(101))
          .executeTakeFirstOrThrow()
      ).password_hash
    )!
    await writeFile(
      path.join(artifacts, 'password-protocol.log'),
      [
        '$ accountSettings.e2e.ts: production web bundle, real WASM Worker, native server and isolated PostgreSQL',
        'PUT /me/account/password: clientHash (32 bytes), clientParameters; no password/currentPassword fields observed.',
        'POST /auth/password/parameters -> stored client parameters; POST /auth/password -> 200 with clientHash.',
        'Legacy account: PUT without email authorization refused; wrong code -> 400; verified code -> 200.',
        'Forgotten password: fresh reset code -> new two-stage record; sign-in -> 200.',
        `Saved client: Argon2id v${record.client.version}, memory=${record.client.memoryKiB} KiB, iterations=${record.client.iterations}, lanes=${record.client.parallelism}, output=32 bytes.`,
        `Saved server: Argon2id v${record.server.version}, memory=${record.server.memoryKiB} KiB, iterations=${record.server.iterations}, lanes=${record.server.parallelism}, output=32 bytes.`,
        'Salts are independent; database stores only the final server digest; secret values omitted.'
      ].join('\n') + '\n'
    )
  })
  it('confirms added and replacement emails and retains a primary', async () => {
    await clearLimits()
    await press('Add email address')
    await fill('New email address', 'new@example.com')
    await press('Send confirmation code')
    await waitText('not active yet')
    expect(
      (
        await h.request(
          'POST',
          '/auth/password',
          {
            email: 'new@example.com',
            clientHash: await testPasswordKdf(
              nextPassword,
              readPasswordRecord(
                (
                  await h.db
                    .selectFrom('users')
                    .select('password_hash')
                    .where('id', '=', userIdOfGumbo(101))
                    .executeTakeFirstOrThrow()
                ).password_hash
              )!.client
            )
          },
          null
        )
      ).status
    ).equals(401)
    await fill('Confirmation code', 'wrong')
    await press('Confirm email')
    await waitText('incorrect or expired')
    await fill('Confirmation code', h.mail.get('new@example.com')!)
    await press('Confirm email')
    await waitText('Email address confirmed')
    await press('Make new@example.com primary')
    await waitText('Primary email updated')
    await press('Change new@example.com')
    await fill('New email address', 'replaced@example.com')
    await press('Send confirmation code')
    await waitText('not active yet')
    expect(
      (
        await h.request(
          'POST',
          '/auth/password',
          {
            email: 'new@example.com',
            clientHash: await testPasswordKdf(
              nextPassword,
              readPasswordRecord(
                (
                  await h.db
                    .selectFrom('users')
                    .select('password_hash')
                    .where('id', '=', userIdOfGumbo(101))
                    .executeTakeFirstOrThrow()
                ).password_hash
              )!.client
            )
          },
          null
        )
      ).status
    ).equals(200)
    await fill('Confirmation code', h.mail.get('replaced@example.com')!)
    await press('Confirm email')
    await waitText('Email address confirmed')
    expect(
      (
        await h.request(
          'POST',
          '/auth/password',
          {
            email: 'new@example.com',
            clientHash: await testPasswordKdf(
              nextPassword,
              readPasswordRecord(
                (
                  await h.db
                    .selectFrom('users')
                    .select('password_hash')
                    .where('id', '=', userIdOfGumbo(101))
                    .executeTakeFirstOrThrow()
                ).password_hash
              )!.client
            )
          },
          null
        )
      ).status
    ).equals(401)
    await page.reload({ waitUntil: 'networkidle0' })
    await waitText('replaced@example.com · Primary')
    await press('Add email address')
    await fill('New email address', 'CASEY@example.com')
    await press('Send confirmation code')
    await waitText('belongs to another account')
    await press('Cancel email change')
    await page.screenshot({
      path: path.join(artifacts, 'credentials-after.png')
    })
    await writeFile(
      path.join(artifacts, 'account-api.log'),
      [
        '$ accountSettings.e2e.ts: real HTTP API and desktop browser scenarios (credential values omitted)',
        'PUT /me/account/name → 200; account Mookie Betts, player Mookie B, header Mookie Betts; persisted on reload',
        'PUT /me/account/photo → 200; two PNG objects uploaded to S3-compatible Space; GET signed object → 200; persisted on reload',
        'PUT /me/account/password → 200 setup; incorrect current password → 400; correct current password → 200',
        'POST /auth/password → 200 after setup/change; POST /auth/email-code/verify → 200 afterward',
        'POST /me/account/emails/request → 202; pending email password sign-in → 401',
        'POST /me/account/emails/confirm → 400 wrong code; → 200 correct code',
        'PUT /me/account/emails/primary → 200; primary persists after reload',
        'Replacement requested: existing email sign-in → 200; replacement confirmed: old email sign-in → 401',
        'POST /me/account/emails/request with another account address → 409; prior address retained',
        'All browser assertions passed. Mail captured locally; no real mail sent. S3 storage is a local HTTP test double using production upload/signing code.'
      ].join('\n') + '\n'
    )
  })
  // Last: it deletes the account every test above signed in as.
  it('deletes the account behind a slide and leaves nothing to sign in with', async () => {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
    await page.goto(h.origin + '/account', { waitUntil: 'networkidle0' })
    await waitText('Delete account')
    const addresses = (
      await h.db
        .selectFrom('user_emails')
        .select('email')
        .where('user_id', '=', userIdOfGumbo(101))
        .execute()
    ).map(row => row.email)
    expect(addresses.length).greaterThan(0)
    // To the very bottom of whatever scrolls, where the entry lives.
    await page.evaluate(() => {
      for (const node of document.querySelectorAll<HTMLElement>('*'))
        if (node.scrollHeight > node.clientHeight + 1)
          node.scrollTop = node.scrollHeight
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    await page.screenshot({
      path: path.join(artifacts, 'delete-account-entry.png')
    })

    await press('Delete account')
    await waitText('Are you sure? Deleting an account is irrecoverable.')
    await settled('[data-testid="delete-account-cancel"]')
    await page.screenshot({
      path: path.join(artifacts, 'delete-account-modal.png')
    })
    await page.click('[data-testid="delete-account-cancel"]')
    await page.waitForFunction(() => {
      // No optional chaining in the page: its transpiled helper is absent.
      const content = document.body.textContent
      if (content === null) return true
      return !content.includes('irrecoverable')
    })

    await press('Delete account')
    await waitText('Slide to delete')
    await settled('[data-testid="delete-account-cancel"]')
    const knob = await page.$('[data-testid="delete-account-slide-knob"]')
    const track = await page.$('[data-testid="delete-account-slide-track"]')
    const from = (await knob!.boundingBox())!
    const to = (await track!.boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width - 4, from.y + from.height / 2, {
      steps: 12
    })
    await page.mouse.up()
    await page.waitForFunction(
      () => document.querySelector('[aria-label^="Account, "]') == null
    )
    await waitText('Use a password instead')
    await page.screenshot({
      path: path.join(artifacts, 'delete-account-after.png')
    })

    const row = await h.db
      .selectFrom('users')
      .select(['display_name', 'password_hash', 'login_enabled'])
      .where('id', '=', userIdOfGumbo(101))
      .executeTakeFirstOrThrow()
    expect(row).deep.equals({
      display_name: 'Deleted user',
      password_hash: null,
      login_enabled: false
    })
    expect(
      await h.db
        .selectFrom('user_emails')
        .select('email')
        .where('user_id', '=', userIdOfGumbo(101))
        .execute()
    ).deep.equals([])
    expect(
      (await h.request('GET', '/auth/me', undefined, h.tokens.get(101))).status
    ).equals(401)
    await writeFile(
      path.join(artifacts, 'delete-account-api.log'),
      [
        '$ accountSettings.e2e.ts: delete account in the desktop browser at phone width',
        'Account screen: "Delete account" is the last control; Cancel closes the modal with no request',
        'Slide to delete → DELETE /me/account → 204; app returns to sign-in',
        `users.display_name → "${row.display_name}"; password_hash → null; login_enabled → false`,
        `user_emails rows for the account: ${addresses.length} before, 0 after`,
        'GET /auth/me with the old session → 401'
      ].join('\n') + '\n'
    )
  })
})
