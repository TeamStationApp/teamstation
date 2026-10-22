/**
 * An iPhone and an Android phone in one direct message (S12), each on its
 * own native chat crypto core, through two maestro-d daemons.
 *
 *   MAESTRO_D_IOS=chat-core-ios MAESTRO_D_ANDROID=chat-core-android \
 *     CHAT_IOS_DEVICE=<udid> CHAT_ANDROID_DEVICE=<serial> \
 *     CHAT_ARTIFACTS=<run dir> [TS_CHAT_API_URL=<API as this Mac reaches it>] \
 *     node -r sucrase/register src/app/chat/chatPhonesCross.e2e.ts
 *
 * It follows `chatPhones.e2e.ts` P1 on the iPhone (a parent enrolled there,
 * `CHAT_IOS_PERSON`, `N` by default, as `CHAT_P1_PERSON` was) and P2 on the
 * emulator (parent B's phone linked there), and uses both phones as those
 * runs left them: signed in, keys and all. Their DM is opened through the
 * API as the iPhone's person, who sends a message from the iPhone; B reads
 * it on Android and reacts, and the iPhone sees the reaction. Then each opens the DM's
 * members and the safety number with the other, and the two must be the
 * same 60 digits. The phones' screenshots go to `<run dir>/shots`, with the
 * two side by side in `cross-dm.png` (ffmpeg).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { readSeedTable } from '../../test/chatSeedTable'
import { signInTestAccount } from '../../test/passwordFixtures'

interface Device {
  tapOn: (options: object) => Promise<unknown>
  longPressOn: (options: object) => Promise<unknown>
  inputText: (options: object) => Promise<unknown>
  openLink: (options: object) => Promise<unknown>
  assertVisible: (options: object) => Promise<unknown>
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
const API = (
  process.env.TS_CHAT_API_URL ?? 'http://127.0.0.1:9120/api/v1'
).replace(/\/+$/, '')

function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}

/** The seed table's row for a person, and the short name chat shows. */
function person(
  run: string,
  key: string
): { userId: string; email: string; password: string; shortName: string } {
  const row = readSeedTable(readFileSync(join(run, 'seed.txt'), 'utf8'))[key]
  assert(row != null, `${key} is not in the seed table`)
  const [first, last] = row.name.split(' ')
  return {
    userId: row.userId,
    email: row.email,
    password: row.password,
    shortName: `${first} ${last.slice(0, 1)}`
  }
}

/** The iPhone person's DM with B, opened (or found) through the API as them. */
async function dmOf(
  n: { email: string; password: string },
  b: { userId: string }
): Promise<string> {
  // Through the password protocol, as the app signs in: the raw password
  // never leaves this process.
  const token = await signInTestAccount(API, n)
  const dm = await fetch(`${API}/chat/dms`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ userIds: [b.userId] })
  })
  const body = (await dm.json()) as { id?: string }
  assert(body.id != null, `No DM: ${dm.status} ${JSON.stringify(body)}`)
  return body.id
}

/**
 * The texts on a phone's screen, from the hierarchy's leaves only: iOS also
 * reports a container with its child's text, which would read every group
 * of digits twice.
 */
async function phoneText(m: Device): Promise<string[]> {
  const leaves = (node: HierarchyNode): HierarchyNode[] =>
    node.children == null || node.children.length === 0
      ? [node]
      : node.children.flatMap(leaves)
  return leaves(await m.hierarchy())
    .map(node => node.text ?? '')
    .filter(text => text !== '')
}

/** The 60 digits a phone's safety number screen shows, in order. */
async function safetyDigits(m: Device, name: string): Promise<string> {
  await m.tapOn({ text: `Safety number with ${name}` })
  await m.assertVisible({ text: `Safety number with ${name}`, timeout: 30000 })
  for (let attempt = 0; attempt < 20; attempt++) {
    const groups = (await phoneText(m)).filter(text => /^\d{5}$/.test(text))
    if (groups.length >= 12) return groups.slice(0, 12).join('')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`No safety number with ${name} on the phone`)
}

async function main(): Promise<void> {
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
  const n = person(run, process.env.CHAT_IOS_PERSON ?? 'N')
  const b = person(run, 'B')
  const dm = await dmOf(n, b)

  const iosDaemon = await MaestroD.connect({
    name: required('MAESTRO_D_IOS'),
    spawn: false
  })
  const androidDaemon = await MaestroD.connect({
    name: required('MAESTRO_D_ANDROID'),
    spawn: false
  })
  const iphone = await iosDaemon.attach({
    device: required('CHAT_IOS_DEVICE'),
    platform: 'ios',
    appId: APP,
    artifacts: 'on-failure'
  })
  const android = await androidDaemon.attach({
    device: required('CHAT_ANDROID_DEVICE'),
    platform: 'android',
    appId: APP,
    artifacts: 'on-failure'
  })
  try {
    const words = `From the iPhone ${Date.now() % 100000} 🎉`
    await iphone.openLink({ link: `teamstation://chat/${dm}` })
    await iphone.tapOn({ id: 'chat-composer', timeout: 60000 })
    await iphone.inputText({ text: words })
    await iphone.hideKeyboard().catch(() => undefined)
    await iphone.tapOn({ text: 'Send' })
    await iphone.assertVisible({ text: words, timeout: 30000 })

    await android.openLink({ link: `teamstation://chat/${dm}` })
    await android.assertVisible({ text: words, timeout: 60000 })
    await android.longPressOn({ text: words })
    await android.tapOn({ text: 'React with 👍', timeout: 15000 })
    await android.assertVisible({ text: '👍.*', timeout: 30000 })

    await iphone.assertVisible({ text: '👍.*', timeout: 60000 })
    await iphone.takeScreenshot({ path: join(shots, 'cross-dm-ios') })
    await android.takeScreenshot({ path: join(shots, 'cross-dm-android') })

    await iphone.openLink({ link: `teamstation://chat/${dm}/members` })
    await android.openLink({ link: `teamstation://chat/${dm}/members` })
    const onIphone = await safetyDigits(iphone, b.shortName)
    const onAndroid = await safetyDigits(android, n.shortName)
    await iphone.takeScreenshot({ path: join(shots, 'cross-safety-ios') })
    await android.takeScreenshot({ path: join(shots, 'cross-safety-android') })
    console.log(`Safety number on the iPhone: ${onIphone}`)
    console.log(`Safety number on Android:    ${onAndroid}`)
    assert.equal(onIphone.length, 60, 'Not 60 digits on the iPhone')
    assert.equal(onAndroid, onIphone, 'The safety numbers differ')

    for (const [left, right, out] of [
      ['cross-dm-ios', 'cross-dm-android', 'cross-dm'],
      ['cross-safety-ios', 'cross-safety-android', 'cross-safety']
    ]) {
      execFileSync('ffmpeg', [
        '-loglevel',
        'error',
        '-y',
        '-i',
        join(shots, `${left}.png`),
        '-i',
        join(shots, `${right}.png`),
        '-filter_complex',
        '[0]scale=-1:1600[a];[1]scale=-1:1600[b];[a][b]hstack',
        join(shots, `${out}.png`)
      ])
    }
    console.log(
      'S12 PASS: the iPhone’s message read on Android, its reaction back, and one safety number'
    )
  } finally {
    await iphone.detach()
    await android.detach()
    await iosDaemon.close()
    await androidDaemon.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
