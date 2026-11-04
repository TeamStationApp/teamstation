/**
 * Chat behind the age sheet: every chat entry point drawn, the sheet before
 * the first chat surface of an unconfirmed account, Not Now and asking again,
 * the agreement kept, Apple's 13 or older confirming with no sheet, and the
 * notice for an Apple answer under 13.
 *
 * Against the branch's own API and seed, with parent C and coach Hc left
 * unconfirmed:
 *
 *   TS_CHAT_SEED_UNCONFIRMED=C,Hc scripts/chat-e2e-reset.sh <run>/seed
 *
 * One Maestro D daemon of the run's own, its device already attached (a
 * Chromium for the web modes, the simulator or the emulator for the phones):
 *
 *   TS_CHAT_WEB=<web app> TS_CHAT_API=<API, as the browser reaches it> \
 *   TS_CHAT_FIXTURE=<run>/seed/seed.txt TS_CHAT_ARTIFACTS=<artifacts> \
 *   MAESTRO_D=<daemon> MAESTRO_DEVICE=<device> \
 *   MAESTRO_D_CLIENT_ROOT=~/git/maestro-d/npm/maestro-d \
 *     node -r sucrase/register src/app/chat/declaredAge.e2e.ts <mode> [key]
 *
 * Every mode signs its device out and in as its person first.
 *
 * - `web-consent` (a serve with no `TS_DECLARED_AGE_LOWER`): C taps Chat and
 *   meets the sheet, Not Now, again, Hawks' Chats pill and Not Now, then
 *   agrees; the agreement survives a reload.
 * - `web-apple` (a serve with `TS_DECLARED_AGE_LOWER=13`, C unconfirmed):
 *   Chat opens with no sheet, and the account reads `apple`.
 * - `web-under13` (a serve with `12`): confirmed F sees Chat, and the notice.
 * - `web-message` (no stand-in, Hc unconfirmed): Message on parent A's
 *   page, from coach Hc, asks first and makes no DM until it is agreed to.
 * - `sign-in <key>`: only signs the browser in, for the test that follows.
 * - `ios` (iOS simulator): the `12` stand-in draws Chat and shows F the
 *   notice; `13` opens chat for C with no sheet.
 * - `ios-consent` (iOS simulator, C unconfirmed, no stand-in): Apple's own
 *   prompt declined if it shows, then the sheet, Not Now and the agreement.
 * - `android` (emulator, C unconfirmed): the same, and no sheet after a
 *   relaunch.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { readSeedTable, type SeedTablePerson } from '../../test/chatSeedTable'

const APP = 'app.teamstation.app'

function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}

interface Device {
  assertVisible: (options: object) => Promise<unknown>
  assertNotVisible: (options: object) => Promise<unknown>
  tapOn: (options: object) => Promise<unknown>
  inputText: (options: object) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  openBrowser: (options: object) => Promise<unknown>
  evalBrowserScript: (options: { script: string }) => Promise<{ data: string }>
  launchApp: (options: object) => Promise<unknown>
  stopApp: (options: object) => Promise<unknown>
  screenshot: () => Promise<Buffer>
}

async function attach(): Promise<Device> {
  const { MaestroD } = require(
    resolve(required('MAESTRO_D_CLIENT_ROOT'), 'dist/cjs/index.js')
  )
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  const status = await daemon.status()
  assert(
    status.devices.some(
      (device: { id: string }) => device.id === required('MAESTRO_DEVICE')
    ) === true,
    'Reuse the attached device; never open another'
  )
  return await daemon.attach({ device: required('MAESTRO_DEVICE') })
}

const seedText = (): string => readFileSync(required('TS_CHAT_FIXTURE'), 'utf8')

function person(key: string): SeedTablePerson {
  const found = readSeedTable(seedText())[key]
  assert(found != null, `${key} is in the seed table`)
  return found
}

function step(text: string): void {
  console.log(`$ ${text}`)
}

async function shot(m: Device, name: string): Promise<void> {
  // A sheet slides up, and a page slides across: let both land first.
  await new Promise(resolve => setTimeout(resolve, 1500))
  const path = resolve(required('TS_CHAT_ARTIFACTS'), name)
  writeFileSync(path, await m.screenshot())
  step(`screenshot ${path}`)
}

const sheet = { id: 'chat-age-sheet' }
const agree = { id: 'chat-age-agree' }
// By id: iOS's own "Save Password?" sheet says Not Now too.
const decline = { id: 'chat-age-decline' }
const ok = { id: 'chat-age-ok' }
const locked = { id: 'chat-locked' }

// ---- the web ----

const web = (): string => required('TS_CHAT_WEB').replace(/\/$/, '')
const api = (): string => required('TS_CHAT_API').replace(/\/$/, '')

async function read<T>(m: Device, expression: string): Promise<T> {
  return JSON.parse(
    (
      await m.evalBrowserScript({
        script: `return JSON.stringify(await (${expression}))`
      })
    ).data
  ) as T
}

/** The signed-in person's chat age, read by the page with its session. */
async function chatAge(
  m: Device
): Promise<{ confirmed: boolean; source: string | null }> {
  return await read(
    m,
    `fetch(${JSON.stringify(api() + '/me/account/chat-age')}, { credentials: 'include' }).then(r => r.json())`
  )
}

async function address(m: Device): Promise<string> {
  return await read<string>(m, 'location.pathname + location.search')
}

/** Signs the browser out as the app does, then in as `key`, by password. */
async function webSignIn(m: Device, key: string): Promise<void> {
  const who = person(key)
  step(`sign out, then sign in as ${key} (${who.email})`)
  await m.openBrowser({ url: web() + '/' })
  // The session is an HttpOnly cookie: only the API's sign-out clears it.
  await read(
    m,
    `fetch(${JSON.stringify(api() + '/auth/logout')}, { method: 'POST', credentials: 'include' }).then(r => r.status).catch(() => 0)`
  )
  await read(
    m,
    '(async () => { localStorage.clear(); sessionStorage.clear(); for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name); return true })()'
  )
  await m.openBrowser({ url: web() + '/' })
  await m.tapOn({ text: 'Use a password instead', timeout: 30000 })
  await m.tapOn({ text: 'E-mail address' })
  await m.inputText({ text: who.email })
  await m.tapOn({ text: 'Password' })
  await m.inputText({ text: who.password })
  await m.tapOn({ text: 'Sign in' })
  await m.assertVisible({ text: 'Account, .*', timeout: 30000 })
}

async function webTab(m: Device, label: string): Promise<void> {
  step(`tap the ${label} tab`)
  await m.tapOn({ css: `[role="tab"][aria-label="${label}"]` })
}

async function webConsent(m: Device): Promise<void> {
  await webSignIn(m, 'C')
  assert.equal((await chatAge(m)).confirmed, false, 'C starts unconfirmed')
  await webTab(m, 'Chat')
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await m.assertVisible({ text: 'Before You Chat' })
  await m.assertVisible({ text: 'I’m 13 or Older' })
  await shot(m, 'web-chat-tap-after.png')
  step('Not Now')
  await m.tapOn(decline)
  await m.assertNotVisible({ ...sheet, timeout: 10000 })
  assert.equal(await address(m), '/', 'Not Now returns to Home')
  await webTab(m, 'Chat')
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await m.tapOn(decline)
  await m.assertNotVisible({ ...sheet, timeout: 10000 })

  const hawks = /Hawks (\S+)/.exec(seedText())?.[1]
  assert(hawks != null, 'the seed table names Hawks')
  step(`open /teams/${hawks}?tab=schedule, then its Chats pill`)
  await m.openBrowser({ url: `${web()}/teams/${hawks}?tab=schedule` })
  await m.assertVisible({ text: 'Team sections', timeout: 20000 })
  await m.tapOn({ text: 'Chats' })
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await shot(m, 'web-team-chats-after.png')
  await m.tapOn(decline)
  await m.assertNotVisible({ ...sheet, timeout: 10000 })
  assert.match(await address(m), /tab=schedule/, 'back on the tab before Chats')

  await webTab(m, 'Chat')
  await m.assertVisible({ ...sheet, timeout: 20000 })
  step('I’m 13 or Older')
  await m.tapOn(agree)
  await m.assertNotVisible({ ...sheet, timeout: 20000 })
  await m.assertNotVisible({ ...locked, timeout: 20000 })
  const answer = await chatAge(m)
  assert.equal(answer.confirmed, true)
  assert.equal(answer.source, 'self')
  step('reload, and Chat again')
  await m.openBrowser({ url: web() + '/' })
  await webTab(m, 'Chat')
  await m.assertNotVisible({ ...sheet, timeout: 10000 })
  await m.assertNotVisible({ ...locked, timeout: 20000 })
}

async function webApple(m: Device): Promise<void> {
  await webSignIn(m, 'C')
  await webTab(m, 'Chat')
  await m.assertNotVisible({ ...sheet, timeout: 10000 })
  await m.assertNotVisible({ ...locked, timeout: 20000 })
  assert.equal((await chatAge(m)).source, 'apple', 'the stand-in confirmed C')
}

async function webUnder13(m: Device): Promise<void> {
  await webSignIn(m, 'F')
  await m.assertVisible({ css: '[role="tab"][aria-label="Chat"]' })
  await webTab(m, 'Chat')
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await m.assertVisible({ text: 'Chat Is for Ages 13 and Up' })
  await m.assertNotVisible({ ...agree, timeout: 2000 })
  await shot(m, 'web-under13-notice.png')
  await m.tapOn(ok)
  await m.assertNotVisible({ ...sheet, timeout: 10000 })
  assert.equal(await address(m), '/', 'OK returns to Home')
}

async function webMessage(m: Device): Promise<void> {
  // A coach opens a parent's page from the team; a parent cannot open a
  // coach's.
  await webSignIn(m, 'Hc')
  const parent = person('A')
  const dms = async (): Promise<number> =>
    (
      await read<Array<{ kind: string }>>(
        m,
        `fetch(${JSON.stringify(api() + '/chat/conversations')}, { credentials: 'include' }).then(r => r.json()).then(b => b.conversations ?? b)`
      )
    ).filter(chat => chat.kind === 'dm').length
  const before = await dms()
  const hawks = /Hawks (\S+)/.exec(seedText())?.[1]
  assert(hawks != null, 'the seed table names Hawks')
  const page = `/teams/${hawks}/people/${parent.userId}`
  step(`open parent A's page ${page}`)
  await m.openBrowser({ url: web() + page })
  await m.assertVisible({ id: 'person-message', timeout: 30000 })
  await m.tapOn({ id: 'person-message' })
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await shot(m, 'web-message-after.png')
  await m.tapOn(decline)
  await m.assertNotVisible({ ...sheet, timeout: 10000 })
  assert.equal(await dms(), before, 'Not Now made no DM')
  await m.tapOn({ id: 'person-message' })
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await m.tapOn(agree)
  await m.assertVisible({ id: 'chat-composer', timeout: 30000 })
  assert.match(await address(m), /^\/chat\//, 'the DM with A opened')
}

// ---- the phones ----

/**
 * A field typed whole, by word, or by letter. WebDriverAgent can drop a key
 * from fast typing (`chatPhones.e2e.ts` says how), and a field cannot be read
 * back, so a sign-in that fails is tried again in smaller pieces.
 */
async function typeIn(
  m: Device,
  label: string,
  text: string,
  pieces: 'whole' | 'words' | 'letters'
): Promise<void> {
  await m.tapOn({ text: label })
  const parts =
    pieces === 'whole'
      ? [text]
      : pieces === 'words'
        ? text.split(/(?=[@._-])|(?<=[@._-])/)
        : Array.from(text)
  for (const part of parts) await m.inputText({ text: part })
}

async function phoneSignIn(
  m: Device,
  key: string,
  environment: Record<string, string>
): Promise<void> {
  const who = person(key)
  // Android's input drops no keys and replaces a field's text.
  const tries =
    process.argv[2] === 'android'
      ? (['whole', 'whole'] as const)
      : (['letters', 'letters', 'letters', 'letters', 'words'] as const)
  for (const pieces of tries) {
    step(
      `clearState; launchApp ${JSON.stringify(environment)}; sign in as ${key}, typed as ${pieces}`
    )
    await m.launchApp({ appId: APP, clearState: true, environment })
    if (process.argv[2] === 'ios-consent') {
      // With no stand-in the app asks Apple as it starts; typing while that
      // settles loses keys, so let it answer first.
      await new Promise(resolve => setTimeout(resolve, 8000))
    }
    await m.tapOn({ text: 'Use a password instead', timeout: 30000 })
    await typeIn(m, 'E-mail address', who.email, pieces)
    await typeIn(m, 'Password', who.password, pieces)
    await m.hideKeyboard().catch(() => undefined)
    await m.tapOn({ text: 'Sign in', optional: true, timeout: 5000 })
    // iOS offers to save the password; the age sheet's own Not Now is by id.
    await m.tapOn({ text: 'Not Now', optional: true, timeout: 5000 })
    try {
      await m.assertVisible({ text: 'Account, .*', timeout: 20000 })
      return
    } catch {
      step(`the sign-in typed as ${pieces} did not take; again`)
    }
  }
  throw new Error(`Could not sign in as ${key}`)
}

async function navigation(m: Device): Promise<void> {
  for (const label of ['Home', 'Videos', 'Schedule', 'Search', 'Chat']) {
    step(`assertVisible ${label}`)
    await m.assertVisible({ text: label, timeout: 20000 })
  }
}

async function ios(m: Device): Promise<void> {
  step('clearState; launchApp TS_DECLARED_AGE_LOWER=12, signed out')
  await m.launchApp({
    appId: APP,
    clearState: true,
    environment: { TS_DECLARED_AGE_LOWER: '12' }
  })
  await navigation(m)
  await shot(m, 'ios-under13-nav-after.png')
  await phoneSignIn(m, 'F', { TS_DECLARED_AGE_LOWER: '12' })
  await navigation(m)
  await m.tapOn({ text: 'Chat' })
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await m.assertVisible({ text: 'Chat Is for Ages 13 and Up' })
  await m.assertNotVisible({ ...agree, timeout: 2000 })
  await shot(m, 'ios-under13-notice.png')
  await m.tapOn(ok)
  await m.assertNotVisible({ ...sheet, timeout: 10000 })

  await phoneSignIn(m, 'C', { TS_DECLARED_AGE_LOWER: '13' })
  await m.tapOn({ text: 'Chat' })
  await m.assertNotVisible({ ...sheet, timeout: 10000 })
  await m.assertNotVisible({ ...locked, timeout: 30000 })
  await shot(m, 'ios-apple13-no-sheet.png')
}

/**
 * Taps the age sheet's Not Now or Agree on a phone, once it has landed, until
 * the sheet goes. iOS's own "Save Password?" sheet can come up a moment after
 * a sign-in and take the next tap (`chatPhones.e2e.ts` meets the same), so a
 * tap that left the sheet up is logged and made again, once.
 */
async function answerSheet(m: Device, target: object): Promise<void> {
  // A tap while the sheet is still sliding in can land beside its button.
  await new Promise(resolve => setTimeout(resolve, 1000))
  for (const attempt of [1, 2]) {
    await m.tapOn(target)
    try {
      await m.assertNotVisible({ ...sheet, timeout: 10000 })
      return
    } catch (error) {
      if (attempt === 2) throw error
      step(
        'the tap did not reach the age sheet (iOS’s own sheet took it); again'
      )
    }
  }
}

async function phoneConsent(
  m: Device,
  platform: 'ios' | 'android'
): Promise<void> {
  await phoneSignIn(m, 'C', {})
  if (platform === 'ios') {
    // With no stand-in, iOS asks Apple, which may show its own prompt;
    // a simulator with no Apple Account answers without one.
    await m.tapOn({ text: 'Don.t Share', optional: true, timeout: 8000 })
    step("Apple's age prompt declined, had it shown")
  }
  await navigation(m)
  await m.tapOn({ text: 'Chat' })
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await m.assertVisible({ text: 'Before You Chat' })
  await shot(m, `${platform}-consent-sheet.png`)
  await answerSheet(m, decline)
  // Not Now returns to the tab before Chat: Home, signed in.
  await m.assertVisible({ text: 'Your Home', timeout: 10000 })
  await m.tapOn({ text: 'Chat' })
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await answerSheet(m, agree)
  await m.assertNotVisible({ ...locked, timeout: 30000 })
  step('stopApp; launchApp, still signed in')
  await m.stopApp({ appId: APP })
  await m.launchApp({ appId: APP })
  await m.assertVisible({ text: 'Account, .*', timeout: 30000 })
  await m.tapOn({ text: 'Chat' })
  // The chat list itself, not just no sheet while the answer is pending.
  await m.assertVisible({ text: 'New message', timeout: 30000 })
  await m.assertNotVisible({ ...sheet, timeout: 5000 })
  await m.assertNotVisible({ ...locked, timeout: 5000 })
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? ''
  // The device stays attached: it is the run's, for the next mode.
  const m = await attach()
  if (mode === 'web-consent') await webConsent(m)
  else if (mode === 'web-apple') await webApple(m)
  else if (mode === 'web-under13') await webUnder13(m)
  else if (mode === 'web-message') await webMessage(m)
  else if (mode === 'sign-in') await webSignIn(m, process.argv[3] ?? '')
  else if (mode === 'ios') await ios(m)
  else if (mode === 'ios-consent') await phoneConsent(m, 'ios')
  else if (mode === 'android') await phoneConsent(m, 'android')
  else throw new Error(`Unknown mode ${mode}`)
  console.log(`${mode}: passed`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
