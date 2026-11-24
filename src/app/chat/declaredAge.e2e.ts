/**
 * Chat behind the age modal: every chat entry point drawn, the modal before
 * the first chat surface of somebody with no age on file, closing it and
 * asking again, a year and month checked before Save, 18 or older, Apple's
 * 18 or older answering with no modal, Apple's 13 to 15 narrowing the
 * modal, and the notice for an Apple answer under 13.
 *
 * Against the branch's own API and seed, with parent C and coach Hc left
 * with no age:
 *
 *   TS_CHAT_SEED_NO_AGE=C,Hc scripts/chat-e2e-reset.sh <run>/seed
 *
 * (the phones: `TS_CHAT_SEED_NO_AGE=C,Hc,A,B,N`, below)
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
 * Every mode signs its device out and in as its person first, and the reset
 * runs again before each web mode that gives C an age.
 *
 * - `web-age` (a serve with no `TS_DECLARED_AGE_LOWER`): C taps Chat and
 *   meets the modal, closes it, again from Hawks' Chats pill, then enters a
 *   year and month (Save stays off for a three-digit year and month 13);
 *   chat opens, and no modal after a reload.
 * - `web-adult` (no stand-in): C answers 18 or older.
 * - `web-apple` (a serve with `TS_DECLARED_AGE_LOWER=18`): Chat opens with
 *   no modal, and the account reads `apple`.
 * - `web-apple-minor` (a serve with `13` and `TS_DECLARED_AGE_UPPER=15`):
 *   no 18 or older, a 17-year-old's year refused, a 14-year-old's taken.
 * - `web-under13` (a serve with `12`): F sees Chat, and the notice.
 * - `web-message` (no stand-in, Hc with no age): Message on parent A's
 *   page, from coach Hc, asks first and makes no DM until an age is given.
 * - `sign-in <key>`: only signs the browser in, for the test that follows.
 *
 * The phones run a release build of the app against the same API, which
 * `TS_CHAT_API` names as this machine reaches it, and a seed with more
 * people left with no age (`TS_CHAT_SEED_NO_AGE=C,Hc,A,B,N`), as each mode
 * uses up the one it gives an age to:
 *
 * - `ios [minor] [adult]` (S12): Apple's answers by stand-in. Under 13 (`12`),
 *   F sees the notice; 13 to 15 (`13` and `TS_DECLARED_AGE_UPPER=15`),
 *   `minor` (B) meets the modal with no 18 or older and a year wheel that
 *   stops at the range, and saves a year in it; 18, `adult` (A), meets no
 *   modal and their age is Apple's.
 * - `ios-age [key]` (S10, no stand-in): `key` (C) meets the modal, closes
 *   it, meets it again, opens the picker at 10 years ago and this month,
 *   turns the year to an adult's and saves; no modal after a relaunch.
 * - `android [key]` (S11): the same on the emulator, but `key` goes back
 *   from the picker and answers 18 or older.
 * - `ios-wake <record> [key]` (S12): the server's logged iOS message (one
 *   `push.jsonl` line) for a DM to C while they had no age, pushed to the
 *   simulator once `key` (Ha, who has an age already, so the modes using C,
 *   A and B are left to run) has let the app notify in Account, and the
 *   notification it shows.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  turnWheel,
  wheelAt,
  type WheelNode,
  wheelValue
} from '../../../e2e/rigs/iosWheel'
import { TeamStationClient } from '../../common/api'
import { readSeedTable, type SeedTablePerson } from '../../test/chatSeedTable'
import { dismissNotificationAskOn } from '../../test/notificationAsk'
import { testPasswordKdf } from '../../test/passwordFixtures'
import { lstrings } from '../locales/strings'

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
  eraseText: (options: object) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  openBrowser: (options: object) => Promise<unknown>
  evalBrowserScript: (options: { script: string }) => Promise<{ data: string }>
  launchApp: (options: object) => Promise<unknown>
  stopApp: (options: object) => Promise<unknown>
  screenshot: () => Promise<Buffer>
  hierarchy: () => Promise<unknown>
  waitForAnimationToEnd: (args?: Record<string, unknown>) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  scrollUntilVisible: (options: object) => Promise<unknown>
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
const agree = { id: 'chat-age-adult' }
const enter = { id: 'chat-age-enter' }
const save = { id: 'chat-age-save' }
// By id: iOS's own "Save Password?" sheet says Not Now too.
const decline = { id: 'chat-age-close' }
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

/** The signed-in person's age, read by the page with its session. */
async function age(m: Device): Promise<{
  band: string
  isAdult: boolean
  ageSource: string | null
  birthYear: number | null
}> {
  return await read(
    m,
    `fetch(${JSON.stringify(api() + '/me/account/age')}, { credentials: 'include' }).then(r => r.json())`
  )
}

/**
 * Types into one of the modal's fields, its text replaced: tapped, emptied
 * (a field holds at most four digits) and typed into, as a person would, so
 * no script is built from the text.
 */
async function typeField(m: Device, id: string, text: string): Promise<void> {
  step(`type ${text} into ${id}`)
  await m.tapOn({ id })
  await m.eraseText({ characters: 8 })
  await m.inputText({ text })
}

/** Whether the modal's Save can be pressed. */
async function saveOn(m: Device): Promise<boolean> {
  return await read<boolean>(
    m,
    `Promise.resolve(document.querySelector('[data-testid="chat-age-save"]')?.getAttribute('aria-disabled') !== 'true')`
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

/**
 * Chat open past its gates asks about notifications, once per person per
 * device: answered Not Now, as nothing here is about it.
 */
async function notNow(m: Device): Promise<void> {
  if (await dismissNotificationAskOn(m)) step('notification ask: Not Now')
}

async function webTab(m: Device, label: string): Promise<void> {
  step(`tap the ${label} tab`)
  await m.tapOn({ css: `[role="tab"][aria-label="${label}"]` })
}

async function webAge(m: Device): Promise<void> {
  await webSignIn(m, 'C')
  assert.equal((await age(m)).band, 'unknown', 'C starts with no age')
  await webTab(m, 'Chat')
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await m.assertVisible({ text: 'Your Age' })
  await m.assertVisible({ text: 'Enter Birth Year and Month' })
  await m.assertVisible({ text: 'I’m 18 or Older' })
  await m.assertVisible({ text: '.*keep chat respectful.*' })
  await shot(m, 'web-chat-tap-after.png')
  step('close')
  await m.tapOn(decline)
  await m.assertNotVisible({ ...sheet, timeout: 10000 })
  assert.equal(await address(m), '/', 'closing returns to Home')

  const hawks = /Hawks (\S+)/.exec(seedText())?.[1]
  assert(hawks != null, 'the seed table names Hawks')
  step(`open /teams/${hawks}?tab=schedule, then its Chats pill`)
  await m.openBrowser({ url: `${web()}/teams/${hawks}?tab=schedule` })
  await m.assertVisible({ text: 'Team sections', timeout: 20000 })
  await m.tapOn({ text: 'Chats' })
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await m.tapOn(decline)
  await m.assertNotVisible({ ...sheet, timeout: 10000 })
  assert.match(await address(m), /tab=schedule/, 'back on the tab before Chats')

  await webTab(m, 'Chat')
  await m.assertVisible({ ...sheet, timeout: 20000 })
  step('Enter Birth Year and Month')
  await m.tapOn(enter)
  await m.assertVisible({ id: 'chat-age-year', timeout: 10000 })
  const order = await read<Array<string | null>>(
    m,
    `Promise.resolve([...document.querySelectorAll('[data-testid="chat-age-sheet"] input')].map(f => f.dataset.testid + ' ' + f.getAttribute('inputmode')))`
  )
  assert.deepEqual(order, ['chat-age-year numeric', 'chat-age-month numeric'])
  await shot(m, 'web-age-entry.png')
  await typeField(m, 'chat-age-year', '202')
  await typeField(m, 'chat-age-month', '6')
  assert.equal(await saveOn(m), false, 'a three-digit year is refused')
  await typeField(m, 'chat-age-year', '2009')
  await typeField(m, 'chat-age-month', '13')
  assert.equal(await saveOn(m), false, 'month 13 is refused')
  await typeField(m, 'chat-age-month', '6')
  assert.equal(await saveOn(m), true)
  step('Save')
  await m.tapOn(save)
  await m.assertNotVisible({ ...sheet, timeout: 20000 })
  await m.assertNotVisible({ ...locked, timeout: 20000 })
  await notNow(m)
  const given = await age(m)
  assert.equal(given.birthYear, 2009)
  assert.equal(given.ageSource, 'self')
  step('reload, and Chat again')
  await m.openBrowser({ url: web() + '/' })
  await webTab(m, 'Chat')
  await m.assertNotVisible({ ...sheet, timeout: 10000 })
  await m.assertNotVisible({ ...locked, timeout: 20000 })
  await notNow(m)
}

async function webAdult(m: Device): Promise<void> {
  await webSignIn(m, 'C')
  await webTab(m, 'Chat')
  await m.assertVisible({ ...sheet, timeout: 20000 })
  step('I’m 18 or Older')
  await m.tapOn(agree)
  await m.assertNotVisible({ ...sheet, timeout: 20000 })
  await m.assertNotVisible({ ...locked, timeout: 20000 })
  await notNow(m)
  const given = await age(m)
  assert.equal(given.isAdult, true)
  assert.equal(given.ageSource, 'self')
}

async function webApple(m: Device): Promise<void> {
  await webSignIn(m, 'C')
  await webTab(m, 'Chat')
  await m.assertNotVisible({ ...sheet, timeout: 10000 })
  await m.assertNotVisible({ ...locked, timeout: 20000 })
  await notNow(m)
  assert.equal((await age(m)).ageSource, 'apple', 'the stand-in gave C’s age')
}

async function webAppleMinor(m: Device): Promise<void> {
  await webSignIn(m, 'C')
  await webTab(m, 'Chat')
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await m.assertNotVisible({ ...agree, timeout: 2000 })
  await shot(m, 'web-apple-minor.png')
  await m.tapOn(enter)
  await m.assertVisible({ id: 'chat-age-year', timeout: 10000 })
  const year = new Date().getUTCFullYear()
  await typeField(m, 'chat-age-year', String(year - 18))
  await typeField(m, 'chat-age-month', '1')
  assert.equal(await saveOn(m), false, 'a 17-year-old is outside 13 to 15')
  await typeField(m, 'chat-age-year', String(year - 15))
  assert.equal(await saveOn(m), true, 'a 14-year-old is inside it')
  await m.tapOn(save)
  await m.assertNotVisible({ ...sheet, timeout: 20000 })
  await notNow(m)
  const given = await age(m)
  assert.equal(given.band, 'minor')
  assert.equal(given.ageSource, 'apple')
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
  // coach's. With no age, Hc can list no chats, so no DM is made until the
  // age is given: the DM that opens then is the first.
  await webSignIn(m, 'Hc')
  const parent = person('A')
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
  await m.tapOn({ id: 'person-message' })
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await m.tapOn(agree)
  await m.assertVisible({ id: 'chat-composer', timeout: 30000 })
  await notNow(m)
  assert.match(await address(m), /^\/chat\//, 'the DM with A opened')
}

// ---- the phones ----

/** The signed-in API client of `key`, by password, for what a phone cannot read back. */
async function clientOf(key: string): Promise<TeamStationClient> {
  const who = person(key)
  const client = new TeamStationClient({
    baseUrl: api(),
    passwordKdf: testPasswordKdf
  })
  await client.signInWithPassword(who.email, who.password)
  return client
}

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
  const parts =
    pieces === 'whole'
      ? [text]
      : pieces === 'words'
        ? text.split(/(?=[@._-])|(?<=[@._-])/)
        : Array.from(text)
  await m.tapOn({ text: label })
  try {
    await m.inputText({ text: parts[0] })
  } catch {
    // The app can redraw as it settles and drop the field's focus.
    step(`${label} did not take the keyboard; tap it again`)
    await new Promise(resolve => setTimeout(resolve, 1000))
    await m.tapOn({ text: label })
    await m.inputText({ text: parts[0] })
  }
  for (const part of parts.slice(1)) await m.inputText({ text: part })
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
    if (process.argv[2] === 'ios-age') {
      // With no stand-in the app asks Apple as it starts; typing while that
      // settles loses keys, so let it answer first.
      await new Promise(resolve => setTimeout(resolve, 8000))
    }
    // A tap while the relaunched app is still settling can be lost: the
    // button turns to "Use a sign-in code" when it has taken.
    const passwordMode = { text: 'Use a sign-in code' }
    await m.tapOn({ text: 'Use a password instead', timeout: 30000 })
    try {
      await m.assertVisible({ ...passwordMode, timeout: 5000 })
    } catch {
      step('Use a password instead did not take; again')
      await m.tapOn({ text: 'Use a password instead', timeout: 10000 })
      await m.assertVisible({ ...passwordMode, timeout: 10000 })
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
    await typeIn(m, 'E-mail address', who.email, pieces)
    await typeIn(m, 'Password', who.password, pieces)
    await m.hideKeyboard().catch(() => undefined)
    await m.tapOn({ text: 'Sign in', optional: true, timeout: 5000 })
    // iOS offers to save the password; the age modal's own close is by id.
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

/**
 * Taps one of the age modal's controls on a phone, once it has landed, until
 * it has done its work (`gone`, the modal going, unless given). iOS's own
 * "Save Password?" sheet can come up a moment after a sign-in and take the
 * next tap (`chatPhones.e2e.ts` meets the same), so a tap that left things
 * as they were is logged and made again, once.
 */
async function answerModal(
  m: Device,
  target: object,
  gone: object = sheet
): Promise<void> {
  // A tap while the modal is still sliding in can land beside its button.
  await new Promise(resolve => setTimeout(resolve, 1000))
  for (const attempt of [1, 2]) {
    await m.tapOn(target)
    try {
      await m.assertNotVisible({ ...gone, timeout: 10000 })
      return
    } catch (error) {
      if (attempt === 2) throw error
      step(
        'the tap did not reach the age modal (iOS’s own sheet took it); again'
      )
    }
  }
}

/** How the native picker names a month: the device's own long name. */
const monthName = (month: number): string =>
  new Date(2000, month - 1, 1).toLocaleString('en-US', { month: 'long' })

/** The year and month the picker first shows: 10 years ago, this month. */
function tenYearsAgo(): { year: number; month: number } {
  const now = new Date()
  return { year: now.getFullYear() - 10, month: now.getMonth() + 1 }
}

const chosen = { id: 'chat-age-chosen' }

/** The picker's line under its wheels reads `month year`. */
async function picked(m: Device, year: number, month: number): Promise<void> {
  step(`assertVisible the picker at ${monthName(month)} ${year}`)
  await m.assertVisible({
    ...chosen,
    text: `${monthName(month)} ${year}`,
    timeout: 10000
  })
}

/** The year wheel, the first of the two on the screen. */
const yearWheel = async (m: Device): Promise<WheelNode> => await wheelAt(m, 0)

/** Every year the year wheel offers, oldest first, as the wheel reads them. */
function years(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, at) => String(from + at))
}

/**
 * S10 and S11: with no stand-in, `key` (no age) meets the modal on Chat,
 * closes it back to Home, then meets it again. On iOS they open the picker,
 * see it at 10 years ago and this month, turn the year wheel to an adult's
 * year and save; on Android they see the picker and go back, then answer
 * 18 or older. Chat opens, and after a relaunch no modal comes.
 */
async function phoneAge(
  m: Device,
  platform: 'ios' | 'android',
  key: string
): Promise<void> {
  assert.equal(
    (await (await clientOf(key)).myAge()).band,
    'unknown',
    `${key} starts with no age`
  )
  await phoneSignIn(m, key, {})
  if (platform === 'ios') {
    // With no stand-in, iOS asks Apple, which may show its own prompt;
    // a simulator with no Apple Account answers without one.
    await m.tapOn({ text: 'Don.t Share', optional: true, timeout: 8000 })
    step("Apple's age prompt declined, had it shown")
  }
  await navigation(m)
  await m.tapOn({ text: 'Chat' })
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await m.assertVisible({ text: 'Your Age' })
  await m.assertVisible({ text: 'Enter Birth Year and Month' })
  await m.assertVisible({ text: 'I’m 18 or Older' })
  await answerModal(m, decline)
  // Closing returns to the tab before Chat: Home, signed in.
  await m.assertVisible({ text: 'Your Home', timeout: 10000 })
  await m.tapOn({ text: 'Chat' })
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await answerModal(m, enter, enter)
  const start = tenYearsAgo()
  await picked(m, start.year, start.month)
  await m.assertVisible({ id: 'chat-age-save', timeout: 5000 })
  if (platform === 'ios') {
    const shown = await yearWheel(m)
    assert.equal(wheelValue(shown), String(start.year), 'the year wheel')
    assert.equal(
      wheelValue(await wheelAt(m, 1)),
      monthName(start.month),
      'the month wheel'
    )
    await shot(m, 'age-modal-ios.png')
    const adult = start.year - 10
    step(`turn the year wheel to ${adult}`)
    await turnWheel(
      m,
      async () => await yearWheel(m),
      String(adult),
      years(1900, new Date().getFullYear())
    )
    await picked(m, adult, start.month)
    step('Save')
    await m.tapOn(save)
    await m.assertNotVisible({ ...sheet, timeout: 20000 })
    await m.assertNotVisible({ ...locked, timeout: 30000 })
    await notNow(m)
    const given = await (await clientOf(key)).myAge()
    assert.equal(given.band, 'adult')
    assert.equal(given.birthYear, adult)
    assert.equal(given.ageSource, 'self')
  } else {
    await shot(m, 'age-modal-android.png')
    step('Back, then I’m 18 or Older')
    await answerModal(m, { id: 'chat-age-back' }, chosen)
    await answerModal(m, agree)
    await m.assertNotVisible({ ...locked, timeout: 30000 })
    await notNow(m)
    const given = await (await clientOf(key)).myAge()
    assert.equal(given.isAdult, true)
    assert.equal(given.ageSource, 'self')
  }
  step('stopApp; launchApp, still signed in')
  await m.stopApp({ appId: APP })
  await m.launchApp({ appId: APP })
  await m.assertVisible({ text: 'Account, .*', timeout: 30000 })
  // Chat itself, not just no modal while the answer is pending: the chat
  // list, or this phone's request to link when `key` already chats on
  // another device. A tap while the relaunched app settles can be lost: once
  // more if so.
  for (const attempt of [1, 2]) {
    await m.tapOn({ text: 'Chat' })
    await notNow(m)
    try {
      await m.assertVisible({
        text: '(New message|Link this device.*)',
        timeout: 20000
      })
      break
    } catch (error) {
      if (attempt === 2) throw error
      step('the Chat tab did not open; again')
    }
  }
  await m.assertNotVisible({ ...sheet, timeout: 5000 })
  await m.assertNotVisible({ ...locked, timeout: 5000 })
}

/**
 * S12: Apple's answers, by the stand-in the app is launched with. Under 13
 * (`12`), fan F sees the notice and no modal. A range of 13 to 15, for
 * `minor` (no age): the modal has no 18 or older, and its year wheel offers
 * only the years such an age allows; they save one and chat opens, their
 * age a minor's from `apple`. 18 or older, for `adult` (no age): chat opens
 * with no modal, and their age is Apple's.
 */
async function ios(m: Device, minor: string, adult: string): Promise<void> {
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

  const range = { TS_DECLARED_AGE_LOWER: '13', TS_DECLARED_AGE_UPPER: '15' }
  await phoneSignIn(m, minor, range)
  await m.tapOn({ text: 'Chat' })
  await m.assertVisible({ ...sheet, timeout: 20000 })
  await m.assertVisible({ text: 'Your Age' })
  await m.assertNotVisible({ ...agree, timeout: 2000 })
  await shot(m, 'ios-apple-minor.png')
  await answerModal(m, enter, enter)
  // 13 to 15 today: born from this month 16 years ago to this month 13
  // years ago. The wheel starts at the nearest year to 10 years ago.
  const now = new Date()
  const youngest = now.getUTCFullYear() - 13
  const allowed = years(youngest - 3, youngest)
  // It starts at the year and month in range nearest 10 years ago this
  // local month. The range goes by UTC and the start by the local month, so
  // around the turn of a month the start is read, not worked out.
  const startYear = wheelValue(await yearWheel(m), allowed)
  step(`the picker starts in ${startYear}`)
  // Inside the range, at a month the server ages 13 or more: in January
  // the youngest year has none, and it starts a year earlier.
  assert(allowed.includes(startYear), `it starts in range, at ${startYear}`)
  await m.assertVisible({ ...chosen, text: `.* ${startYear}`, timeout: 5000 })
  step(`turn the year wheel down to ${allowed[0]}, and no further`)
  await turnWheel(m, async () => await yearWheel(m), allowed[0], allowed)
  try {
    await turnWheel(
      m,
      async () => await yearWheel(m),
      String(youngest - 4),
      [String(youngest - 4), ...allowed],
      { maxSteps: 3 }
    )
    assert.fail(`the year wheel offered ${youngest - 4}`)
  } catch (error) {
    assert.match(String(error), /stopped at|none of the options/)
  }
  // Born in January of the oldest year is 16 now: outside the range.
  step('turn the month wheel to January')
  await turnWheel(
    m,
    async () => await wheelAt(m, 1),
    monthName(1),
    Array.from({ length: 12 }, (_, at) => monthName(at + 1))
  )
  if (now.getUTCMonth() > 0) {
    await m.assertVisible({ text: lstrings.chat_age_invalid, timeout: 5000 })
    step('a 16-year-old’s January is refused; the next year instead')
    await turnWheel(m, async () => await yearWheel(m), allowed[1], allowed)
  }
  await m.assertNotVisible({ text: lstrings.chat_age_invalid, timeout: 5000 })
  step('Save')
  await m.tapOn(save)
  await m.assertNotVisible({ ...sheet, timeout: 20000 })
  await m.assertNotVisible({ ...locked, timeout: 30000 })
  await notNow(m)
  const given = await (await clientOf(minor)).myAge()
  assert.equal(given.band, 'minor')
  assert.equal(given.ageSource, 'apple')

  await phoneSignIn(m, adult, { TS_DECLARED_AGE_LOWER: '18' })
  await m.tapOn({ text: 'Chat' })
  await m.assertNotVisible({ ...sheet, timeout: 10000 })
  await m.assertNotVisible({ ...locked, timeout: 30000 })
  await notNow(m)
  await shot(m, 'ios-apple-adult-no-modal.png')
  const apple = await (await clientOf(adult)).myAge()
  assert.equal(apple.band, 'adult')
  assert.equal(apple.ageSource, 'apple')
}

const MESSAGES_SWITCH = 'Notify for direct messages and mentions'
const BLOCKED = 'Notifications are blocked by this device'

/**
 * Answers iOS's notification question with Allow. It is SpringBoard's: while
 * it is up the app's hierarchy is hidden, so its Allow is tapped where an
 * iPhone shows it, again until the app's switch is back (as
 * `mobile/test/teamStationAppNotifications.e2e.ts` does). A phone that
 * allowed the app before is not asked again.
 */
async function allowIos(m: Device): Promise<void> {
  const flatten = (node: { text?: string; children?: unknown[] }): string[] => [
    node.text ?? '',
    ...((node.children ?? []) as Array<typeof node>).flatMap(flatten)
  ]
  let answered = false
  for (let tries = 0; tries < 30; tries++) {
    await new Promise(resolve => setTimeout(resolve, 1500))
    const texts = flatten((await m.hierarchy()) as { text?: string })
    if (!texts.includes(MESSAGES_SWITCH)) {
      await m.tapOn({ point: '68%,59%' })
      answered = true
      continue
    }
    // Answered, or allowed before and so not asked again.
    if (answered || tries >= 3) return
  }
  throw new Error('iOS was not answered Allow')
}

/**
 * S12's wake, on the simulator: the iOS message the server logged for a DM
 * to somebody with no age (`record`, one `push.jsonl` line), addressed to
 * `key`, who is signed in here, delivered as APNs would (`simctl push`),
 * and the notification it shows. The extension passes a generic wake to
 * the person signed in as it came (and hides one for anybody else), so what
 * `simctl push` shows, without running the extension, is what that phone
 * shows. `ChatWakeDecryptorTests` runs the extension's own checks.
 */
async function iosWake(m: Device, record: string, key: string): Promise<void> {
  const logged = JSON.parse(readFileSync(record, 'utf8')) as {
    platform: string
    message: { payload: Record<string, unknown> }
  }
  assert.equal(logged.platform, 'ios')
  const payload = logged.message.payload as {
    aps: { alert?: { body?: string; title?: string } }
    u?: string
    generic?: boolean
    env?: unknown
  }
  assert.equal(payload.generic, true)
  assert.equal(payload.env, undefined)
  assert.equal(payload.aps.alert?.body, 'You have a new message')
  assert.equal(payload.aps.alert?.title, undefined)
  // The server's own wake, for the person this phone is signed in as.
  step(`the logged wake readdressed to ${key}, who is signed in here`)
  const file = resolve(required('TS_CHAT_ARTIFACTS'), 'wake-generic-ios.json')
  writeFileSync(file, JSON.stringify({ ...payload, u: person(key).userId }))
  // `simctl push` shows nothing for an app iOS has not allowed to notify.
  // The person signed in turns on message notifications in Account (as the
  // phone scenario N6 does), which works whether or not they chat on this
  // device yet, and iOS's question is answered Allow.
  await phoneSignIn(m, key, { TS_DECLARED_AGE_LOWER: '18' })
  step('Account: turn on notifications for direct messages; iOS asks; Allow')
  await m.openLink({ link: 'teamstation://account' })
  await m.scrollUntilVisible({ element: { text: 'Sign out' }, timeout: 30000 })
  // The switch itself: its label is a text of the same name beside it.
  const flat = (node: WheelNode & { type?: string }): Array<typeof node> => [
    node,
    ...(node.children ?? []).flatMap(flat)
  ]
  const toggle = flat((await m.hierarchy()) as WheelNode).find(
    node => node.type === 'Switch' && node.text === MESSAGES_SWITCH
  )?.bounds
  assert(toggle != null, 'Account shows the messages switch')
  await m.tapOn({
    point: `${Math.round(toggle.x + toggle.width / 2)},${Math.round(toggle.y + toggle.height / 2)}`
  })
  await allowIos(m)
  await m.assertNotVisible({ text: BLOCKED, timeout: 5000 })
  step('stopApp, so the wake lands as a notification')
  await m.stopApp({ appId: APP })
  const udid = required('MAESTRO_DEVICE')
  step(`xcrun simctl push <device> ${APP} wake-generic-ios.json`)
  execFileSync('xcrun', ['simctl', 'push', udid, APP, file])
  await m.assertVisible({ text: '.*You have a new message.*', timeout: 20000 })
  await shot(m, 'wake-generic-ios.png')
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? ''
  // The device stays attached: it is the run's, for the next mode.
  const m = await attach()
  if (mode === 'web-age') await webAge(m)
  else if (mode === 'web-adult') await webAdult(m)
  else if (mode === 'web-apple') await webApple(m)
  else if (mode === 'web-apple-minor') await webAppleMinor(m)
  else if (mode === 'web-under13') await webUnder13(m)
  else if (mode === 'web-message') await webMessage(m)
  else if (mode === 'sign-in') await webSignIn(m, process.argv[3] ?? '')
  else if (mode === 'ios')
    await ios(m, process.argv[3] ?? 'B', process.argv[4] ?? 'A')
  else if (mode === 'ios-age') await phoneAge(m, 'ios', process.argv[3] ?? 'C')
  else if (mode === 'ios-wake')
    await iosWake(m, process.argv[3] ?? '', process.argv[4] ?? 'Ha')
  else if (mode === 'android')
    await phoneAge(m, 'android', process.argv[3] ?? 'C')
  else throw new Error(`Unknown mode ${mode}`)
  console.log(`${mode}: passed`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
