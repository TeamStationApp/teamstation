/**
 * The chat's phone scenarios (P1–P4) on an iOS simulator or an Android
 * emulator, through maestro-d's JavaScript client, with the other person in
 * a Puppeteer browser on their run profile.
 *
 *   MAESTRO_D=chat-<run> CHAT_PLATFORM=ios|android CHAT_DEVICE=<id> \
 *     CHAT_ARTIFACTS=<run dir> \
 *     node -r sucrase/register src/app/chat/chatPhones.e2e.ts P1|P3|P2|P4
 *
 * Required: `MAESTRO_D`, a daemon of this run's own, already started from
 * `$HOME` (`MAESTRO_RUNNER_HOME=$HOME/.maestro-d maestro-d start --daemon
 * "$MAESTRO_D"`; run `maestro-d ps` first and never share one);
 * `CHAT_PLATFORM`, `ios` (the default) or `android`; `CHAT_DEVICE`, the
 * simulator's UDID or the emulator's serial, which the test pins and never
 * chooses; `CHAT_ARTIFACTS`, the run directory of the browser scenarios
 * (its `seed.txt`, and `profiles/` with the browsers' keys). Optional:
 * `MAESTRO_D_CLIENT_ROOT` (a checkout of the maestro-d npm package), `TS_CHAT_WEB_URL`
 * (the web app, default `http://127.0.0.1:8091`), `TS_CHAT_API_URL` (the API
 * as the browser reaches it, default `http://127.0.0.1:9120/api/v1`),
 * `TS_CHROME_PATH`, and `CHAT_P1_PERSON`, the seed person P1 signs in as
 * (`N` by default; any Hawks parent new to chat), and `CHAT_P2_PERSON`, the
 * one P2 links (`B` by default; any Hawks parent with a browser profile
 * `<person>-1` in the run).
 *
 * The app on the simulator is a Release build whose `TS_API_BASE_URL` is the
 * Mac's LAN address, against the same API and stand-in Space as the browser
 * scenarios, both listening on the LAN — or, for the full pass on a deployed
 * copy of the branch (P4), its https address, with `TS_CHAT_WEB_URL` and
 * `TS_CHAT_API_URL` on it too. Run in this order, P1, P3, P2, P4: P3
 * continues as P1's person, before P2 signs in as B, and P4 follows P2 on
 * B's phone. P3's photo must already be in the simulator's library
 * (`xcrun simctl addmedia`); on Android only P1 and P2 run, since the
 * picker P3 drives is iOS's.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import puppeteer, { type Browser, type Page } from 'puppeteer'

import { chatRowText } from '../../test/chatRows'
import { readSeedTable } from '../../test/chatSeedTable'

interface Device {
  launchApp: (options: object) => Promise<unknown>
  tapOn: (options: object) => Promise<unknown>
  tapOnPoint: (options: object) => Promise<unknown>
  inputText: (options: object) => Promise<unknown>
  openLink: (options: object) => Promise<unknown>
  assertVisible: (options: object) => Promise<unknown>
  assertNotVisible: (options: object) => Promise<unknown>
  scrollUntilVisible: (options: object) => Promise<unknown>
  takeScreenshot: (options: object) => Promise<unknown>
  hideKeyboard: (options?: object) => Promise<unknown>
  hierarchy: () => Promise<HierarchyNode>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  close: () => Promise<unknown>
}
interface HierarchyNode {
  text?: string
  children?: HierarchyNode[]
}

const APP = 'app.teamstation.app'
const WEB = (process.env.TS_CHAT_WEB_URL ?? 'http://127.0.0.1:8091').replace(
  /\/+$/,
  ''
)
const API = (
  process.env.TS_CHAT_API_URL ?? 'http://127.0.0.1:9120/api/v1'
).replace(/\/+$/, '')

function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}

/** The seed's people, by key: e-mail and password. */
function people(
  run: string
): Record<string, { email: string; password: string }> {
  return readSeedTable(readFileSync(join(run, 'seed.txt'), 'utf8'))
}

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
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

/** The other person: a browser on their run profile, keys and all. */
async function browserOf(
  run: string,
  key: string
): Promise<{ browser: Browser; page: Page }> {
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: join(run, 'profiles', key),
    executablePath: process.env.TS_CHROME_PATH
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle2' })
  return { browser, page }
}

/**
 * The Hawks Members row in the Chat tab's list. iOS names a row by all it
 * shows (`Hawks Members, hello 🎉, 1 unread`), so it is matched by its
 * title as the leading part of that name; Android keeps the title's own text.
 */
function membersRow(): string {
  return chatRowText(
    'Hawks Members',
    process.env.CHAT_PLATFORM === 'android' ? 'android' : 'ios'
  )
}

async function bodyText(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.innerText)
}

async function chatIdOf(page: Page, title: string): Promise<string> {
  return await until(`the chat ${title}`, async () => {
    const list = (await page.evaluate(async (url: string) => {
      const response = await fetch(url, { credentials: 'include' })
      return await response.json()
    }, `${API}/chat/conversations`)) as Array<{ id: string; title: string }>
    return list.find(chat => chat.title === title)?.id
  })
}

/** Text anywhere on the phone's screen, from maestro-d's hierarchy. */
async function phoneText(m: Device): Promise<string[]> {
  const flatten = (node: HierarchyNode): HierarchyNode[] => [
    node,
    ...(node.children ?? []).flatMap(flatten)
  ]
  return flatten(await m.hierarchy())
    .map(node => node.text ?? '')
    .filter(text => text !== '')
}

/**
 * Types into a field in pieces. The simulator's keyboard can drop keys of a
 * fast-typed e-mail address ("n@chat…" once arrived as "nhat…"); WebDriverAgent
 * has no clipboard to paste from, and a field's value cannot be read back, so
 * a sign-in that fails is tried again with smaller pieces.
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
        : Array.from(new Intl.Segmenter().segment(text), part => part.segment)
  for (const part of parts) await m.inputText({ text: part })
}

/**
 * Opens the Chat tab with a tap on its glyph in the floating capsule, and
 * waits for `expect`, a maestro text pattern.
 *
 * Right after a password sign-in, iOS's own "Save Password?" sheet can still
 * be over the app (it comes up a moment after Home, and is not always gone
 * by the time the tab is tapped). That sheet takes the tap and closes;
 * XCUITest then reports the tab as not displayed. So a tap that did not
 * open Chat is followed by a second tap, and only after that by the tab's
 * own address, `teamstation://chat` (logged, so a run shows it).
 */
async function chatTab(m: Device, expect: string): Promise<void> {
  for (const tap of [1, 2]) {
    const step = (await m.tapOn({ text: 'Chat' })) as {
      element?: { visible?: boolean }
    }
    const covered = step.element?.visible === false
    try {
      await m.assertVisible({ text: expect, timeout: 15000 })
      return
    } catch {
      console.log(
        `Tap ${tap} on the Chat tab did not open it` +
          (covered ? ' (iOS reported the tab covered, by its own sheet)' : '')
      )
    }
  }
  console.log('Opening teamstation://chat')
  await m.openLink({ link: 'teamstation://chat' })
  await m.assertVisible({ text: expect, timeout: 60000 })
}

/** Signs the app in by password, from a cleared launch. */
async function signIn(
  m: Device,
  who: { email: string; password: string }
): Promise<void> {
  // Android's input replaces a field's text rather than adding to it, and
  // drops no keys, so it types each field whole.
  const tries =
    process.env.CHAT_PLATFORM === 'android'
      ? (['whole', 'whole'] as const)
      : (['letters', 'letters', 'words'] as const)
  for (const pieces of tries) {
    await m.launchApp({ appId: APP, clearState: true })
    await m.tapOn({ text: 'Use a password instead', timeout: 30000 })
    await typeIn(m, 'E-mail address', who.email, pieces)
    await typeIn(m, 'Password', who.password, pieces)
    // Putting the keyboard away can press its return key, which signs in
    // on its own; Sign in is then gone, and that is fine.
    await m.hideKeyboard().catch(() => undefined)
    await m.tapOn({ text: 'Sign in', optional: true, timeout: 5000 })
    // iOS offers to save the password; nothing here needs it.
    await m.tapOn({ text: 'Not Now', optional: true, timeout: 5000 })
    try {
      // Signed in: the header's Notifications button, which a signed-out
      // app never draws (chat2.e2e reads the same chrome).
      await m.assertVisible({ text: 'Notifications', timeout: 20000 })
      return
    } catch {
      console.log(`Sign-in typed as ${pieces} did not take; again`)
    }
  }
  throw new Error(`Could not sign in as ${who.email}`)
}

async function p1(m: Device, run: string, shots: string): Promise<void> {
  const seed = people(run)
  const coach = await browserOf(run, 'Hc-1')
  try {
    const members = await chatIdOf(coach.page, 'Hawks Members')
    await coach.page.goto(`${WEB}/chat/${members}`, {
      waitUntil: 'networkidle2'
    })
    await until('Hc’s chat', async () =>
      (await bodyText(coach.page)).includes('members') ? true : undefined
    )

    const who = process.env.CHAT_P1_PERSON ?? 'N'
    assert(seed[who] != null, `${who} is not in the seed`)
    await signIn(m, seed[who])
    await chatTab(m, membersRow())
    await m.tapOn({ text: membersRow() })
    // Hc's open page grants N the history; then the composer opens.
    await m.assertNotVisible({
      text: 'Waiting for history to unlock…',
      timeout: 60000
    })
    // The composer by its id: "Message" alone also finds "Message deleted".
    await m.assertVisible({
      id: 'chat-composer',
      enabled: true,
      timeout: 60000
    })
    await m.tapOn({ id: 'chat-composer' })
    await m.inputText({ text: 'hello 🎉' })
    // Android's keyboard covers Send; iOS's leaves it showing.
    if (process.env.CHAT_PLATFORM === 'android') await m.hideKeyboard()
    await m.tapOn({ text: 'Send' })
    await m.assertVisible({ text: 'hello 🎉', timeout: 30000 })
    await m.takeScreenshot({ path: join(shots, 'p1-1-phone-sent') })

    await until('“hello 🎉” on Hc’s page', async () =>
      (await bodyText(coach.page)).includes('hello 🎉') ? true : undefined
    )
    await coach.page.screenshot({ path: join(shots, 'p1-2-hc-web.png') })
    console.log('P1 PASS: the bubble on the phone, and on Hc’s page')
  } finally {
    await coach.browser.close()
  }
}

async function p3(m: Device, run: string, shots: string): Promise<void> {
  const coach = await browserOf(run, 'Hc-1')
  try {
    const members = await chatIdOf(coach.page, 'Hawks Members')
    await coach.page.goto(`${WEB}/chat/${members}`, {
      waitUntil: 'networkidle2'
    })
    const picturesBefore = await coach.page.evaluate(
      () =>
        Array.from(document.querySelectorAll('img')).filter(image =>
          image.src.startsWith('blob:')
        ).length
    )

    // Still N, right after P1. Attaching again can bring the app back to
    // where it starts, so Hawks Members is opened by its address if needed.
    try {
      await m.assertVisible({ text: 'hello 🎉', timeout: 5000 })
    } catch {
      await m.openLink({ link: `teamstation://chat/${members}` })
      await m.assertVisible({ text: 'hello 🎉', timeout: 60000 })
    }
    await m.tapOn({ text: 'Attach' })
    await m.tapOn({ text: 'Photo library' })
    // The system's picker runs outside the app, where maestro-d sees no
    // names: its grid's first cell, the photo added for this run, by point.
    await new Promise(resolve => setTimeout(resolve, 4000))
    await m.takeScreenshot({ path: join(shots, 'p3-1-library') })
    await m.tapOnPoint({ point: '17%,43%' })
    await m.assertVisible({ id: 'chat-attachment-chip', timeout: 30000 })
    await m.tapOn({ text: 'Send' })
    await m.assertNotVisible({ id: 'chat-attachment-chip', timeout: 60000 })
    await m.takeScreenshot({ path: join(shots, 'p3-2-phone-photo-sent') })
    await until(
      'the photo on Hc’s page',
      async () =>
        (await coach.page.evaluate(
          () =>
            Array.from(document.querySelectorAll('img')).filter(
              image => image.src.startsWith('blob:') && image.naturalWidth > 0
            ).length
        )) > picturesBefore
          ? true
          : undefined,
      60000
    )
    await coach.page.screenshot({ path: join(shots, 'p3-3-hc-web-photo.png') })

    // B's 20 MB video from E11, decrypted to a cache file and played.
    await m.scrollUntilVisible({
      element: { text: 'Open clip.mp4' },
      direction: 'UP',
      timeout: 60000
    })
    // Tapped again if the first lands while the list is still settling
    // from the scroll.
    for (let attempt = 0; ; attempt++) {
      await m.tapOn({ text: 'Open clip.mp4' })
      try {
        await m.assertNotVisible({ text: 'Open clip.mp4', timeout: 20000 })
        break
      } catch (error) {
        if (attempt >= 2) throw error
      }
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
    const first = join(shots, 'p3-4-video-a')
    const second = join(shots, 'p3-5-video-b')
    await m.takeScreenshot({ path: first })
    await new Promise(resolve => setTimeout(resolve, 2000))
    await m.takeScreenshot({ path: second })
    const a = readFileSync(`${first}.png`)
    const b = readFileSync(`${second}.png`)
    assert(
      !a.equals(b),
      'The two screenshots of the playing video are the same'
    )
    console.log(
      `P3 PASS: the photo on Hc’s page; the video's two frames differ (${a.length} vs ${b.length} bytes)`
    )
  } finally {
    await coach.browser.close()
  }
}

async function p2(m: Device, run: string, shots: string): Promise<void> {
  const seed = people(run)
  const who = process.env.CHAT_P2_PERSON ?? 'B'
  assert(seed[who] != null, `${who} is not in the seed`)
  const parent = await browserOf(run, `${who}-1`)
  try {
    await signIn(m, seed[who])
    await chatTab(m, 'Link this device')
    await m.takeScreenshot({ path: join(shots, 'p2-1-phone-code') })
    const shown = (await phoneText(m))
      .map(text => /(\d{3}) ?(\d{3})/.exec(text))
      .find(found => found != null)
    assert(shown != null, 'No six digits on the phone')
    const phoneCode = `${shown[1]}${shown[2]}`

    await parent.page.goto(`${WEB}/chat/devices`, { waitUntil: 'networkidle2' })
    const label = await until(`the request on ${who}’s page`, async () => {
      const node = await parent.page.$('[aria-label^="Code "]')
      return (
        (await node?.evaluate(found => found.getAttribute('aria-label'))) ??
        undefined
      )
    })
    const webCode = /(\d{6})$/.exec(label)?.[1]
    await parent.page.screenshot({
      path: join(shots, 'p2-2-b-web-request.png')
    })
    console.log(`P2 six digits: phone ${phoneCode}, web ${webCode ?? '?'}`)
    assert.equal(webCode, phoneCode, 'The six digits differ')
    const approve = await until(
      'Approve',
      async () => (await parent.page.$('[aria-label^="Approve "]')) ?? undefined
    )
    await approve.click()

    await m.assertVisible({ text: membersRow(), timeout: 60000 })
    await m.tapOn({ text: membersRow() })
    await m.assertVisible({ text: 'hello 🎉', timeout: 60000 })
    await m.takeScreenshot({ path: join(shots, 'p2-3-phone-history') })
    console.log(
      `P2 PASS: the same six digits; the history, granted by ${who}’s own web device`
    )
  } finally {
    await parent.browser.close()
  }
}

/**
 * P4's last step, right after P2: coach Hc's web page deletes for everyone
 * the message the simulator sent in P1 ("hello 🎉", N's), and the phone,
 * now B's, shows "Removed by a moderator" in its place.
 */
async function p4(m: Device, run: string, shots: string): Promise<void> {
  const coach = await browserOf(run, 'Hc-1')
  try {
    const members = await chatIdOf(coach.page, 'Hawks Members')
    await coach.page.goto(`${WEB}/chat/${members}`, {
      waitUntil: 'networkidle2'
    })
    try {
      await m.assertVisible({ text: 'hello 🎉', timeout: 5000 })
    } catch {
      await m.openLink({ link: `teamstation://chat/${members}` })
      await m.assertVisible({ text: 'hello 🎉', timeout: 60000 })
    }

    const words = await until(
      '“hello 🎉” on Hc’s page',
      async () => (await coach.page.$('::-p-text(hello 🎉)')) ?? undefined
    )
    await words.scrollIntoView()
    const box = await words.boundingBox()
    assert(box != null, '“hello 🎉” is not on Hc’s screen')
    await coach.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await coach.page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 900))
    await coach.page.mouse.up()
    const remove = await until('Delete for everyone', async () => {
      for (const handle of await coach.page.$$('[role="button"]')) {
        const said = await handle.evaluate(node => node.textContent)
        if (said?.endsWith('Delete for everyone') === true) return handle
      }
      return undefined
    })
    await remove.click()
    await until('the removal on Hc’s page', async () =>
      (await bodyText(coach.page)).includes('Removed by a moderator')
        ? true
        : undefined
    )
    await coach.page.screenshot({
      path: join(shots, 'p4-1-hc-web-removed.png')
    })

    await m.assertVisible({ text: 'Removed by a moderator', timeout: 60000 })
    await m.assertNotVisible({ text: 'hello 🎉', timeout: 30000 })
    await m.takeScreenshot({ path: join(shots, 'p4-2-phone-removed') })
    console.log(
      'P4 PASS: Hc deleted the simulator’s message for everyone; the phone shows Removed by a moderator'
    )
  } finally {
    await coach.browser.close()
  }
}

async function main(): Promise<void> {
  const scenario = process.argv[2]
  assert(
    scenario === 'P1' ||
      scenario === 'P2' ||
      scenario === 'P3' ||
      scenario === 'P4',
    'Name the scenario: P1, P3, P2 or P4'
  )
  const root = process.env.MAESTRO_D_CLIENT_ROOT
  const load =
    root != null && root !== ''
      ? createRequire(join(resolve(root), 'package.json'))
      : createRequire(__filename)
  const { MaestroD } = load('maestro-d') as {
    MaestroD: { connect: (options: object) => Promise<Daemon> }
  }
  const run = resolve(required('CHAT_ARTIFACTS'))
  const shots = join(run, 'shots')
  await mkdir(shots, { recursive: true })
  const platform = process.env.CHAT_PLATFORM ?? 'ios'
  assert(
    platform === 'ios' || platform === 'android',
    `CHAT_PLATFORM is ios or android, not ${platform}`
  )
  assert(
    platform === 'ios' || scenario === 'P1' || scenario === 'P2',
    `${scenario} runs on iOS only`
  )
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  const m = await daemon.attach({
    device: required('CHAT_DEVICE'),
    platform,
    appId: APP,
    artifacts: 'on-failure'
  })
  try {
    if (scenario === 'P1') await p1(m, run, shots)
    else if (scenario === 'P3') await p3(m, run, shots)
    else if (scenario === 'P2') await p2(m, run, shots)
    else await p4(m, run, shots)
  } finally {
    await m.detach()
    await daemon.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
