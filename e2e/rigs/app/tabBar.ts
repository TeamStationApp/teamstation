import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { PNG } from 'pngjs'

import type { NavTabId } from '../../../src/app/components/tabBarModel'
import { TeamStationClient } from '../../../src/common/api'
import { navTab, navTabId, navTabSelected } from '../../../src/test/navTab.e2e'
import { testPasswordKdf } from '../../../src/test/passwordFixtures'
import { type FixtureAccount, signInWithPassword } from '../../core/fixtures'
import { isHubDevice } from '../../core/maestro'
import { iosIsSimulator } from '../../core/prepare'
import { BlockedError } from '../../core/result'
import type { E2eContext } from '../../core/spec'
import { DEVELOP_APP, flatten, type Node } from '../coach/coachApp'
import { setServer } from './setServer'

/** Launch the signed-in simulator with the same renderer after visiting Settings. */
export async function launchTabBarSimulator(
  deviceId: string,
  appId: string,
  renderer?: 'capsule'
): Promise<void> {
  // The disposable simulator has no Apple account to answer Declared Age.
  await promisify(execFile)(
    'xcrun',
    [
      'simctl',
      'launch',
      deviceId,
      appId,
      ...(renderer === 'capsule' ? ['-TSNavRenderer', 'capsule'] : [])
    ],
    { env: { ...process.env, SIMCTL_CHILD_TS_DECLARED_AGE_LOWER: '18' } }
  )
}

/** Sign in against the scenario's stack, on the device the harness owns. */
export async function openTabBar(
  ctx: E2eContext,
  role = 'member',
  renderer?: 'capsule',
  account?: FixtureAccount
): ReturnType<E2eContext['attach']> {
  const platform = ctx.surface === 'ios-app' ? 'ios' : 'android'
  const appId = process.env.TS_TAB_APP_ID ?? DEVELOP_APP
  const deviceId = ctx.device('device')
  const simulator =
    platform === 'ios' && !isHubDevice(deviceId) && iosIsSimulator(deviceId)
  const handset = await ctx.attach('device', { platform, appId })
  const builtOrigin = process.env.TS_TAB_BUILT_ORIGIN
  if (builtOrigin != null && builtOrigin !== ctx.stack.origin)
    throw new Error('The test build and scenario must point to the same stack')
  await handset.launchApp({ appId, clearState: true })
  if (builtOrigin == null)
    await setServer({
      origin: ctx.stack.origin,
      platform,
      appId,
      device: handset,
      udid: deviceId,
      hub: isHubDevice(deviceId),
      simulator
    })
  if (renderer === 'capsule' && !simulator)
    throw new Error('The capsule launch override needs an iOS simulator')
  if (simulator) {
    await handset.stopApp({ appId })
    await launchTabBarSimulator(deviceId, appId, renderer)
  }
  const person =
    account ??
    (await ctx.fixture('team-with-roster')).accounts[
      role === 'member' ? 'player' : role
    ]
  if (person == null) throw new Error('No tab-bar fixture account for ' + role)
  const client = new TeamStationClient({
    baseUrl: ctx.stack.origin + '/api/v1',
    passwordKdf: testPasswordKdf
  })
  await client.signInWithPassword(person.email, person.password)
  if ((await client.myAge()).band === 'unknown')
    await client.setMyAge({ adult: true })
  await handset.assertVisible({
    text: 'Use a password instead',
    timeout: 30000
  })
  try {
    await signInWithPassword(handset, person)
  } catch (error) {
    // A slow iOS Return can submit the form before the helper's button tap.
    // Verify the signed-in identity in either case.
    try {
      await handset.assertVisible({
        text: 'Account, ' + person.displayName,
        timeout: 15000
      })
    } catch {
      throw error
    }
  }
  if (renderer === 'capsule')
    await handset.assertVisible({ id: 'tab-bar-capsule', timeout: 10000 })
  await navTabSelected(handset, 'home')
  return handset
}

type TabGestureDevice = Parameters<typeof navTabSelected>[0] & {
  hierarchy: () => Promise<Node>
  swipe: (options: {
    start: string
    end: string
    duration: number
  }) => Promise<unknown>
}

export async function dragTab(
  handset: TabGestureDevice,
  from: NavTabId,
  to: NavTabId,
  duration = 800
): Promise<void> {
  const root = await handset.hierarchy()
  const window = root.bounds
  if (window == null) throw new Error('The app window has no frame')
  const nodes = flatten(root)
  const centre = (id: NavTabId): string => {
    const box = nodes.find(node => node.id === navTabId(id))?.bounds
    if (box == null) throw new Error('Missing tab frame for ' + id)
    const x = Math.round(
      (100 * (box.x + box.width / 2 - window.x)) / window.width
    )
    const y = Math.round(
      (100 * (box.y + box.height / 2 - window.y)) / window.height
    )
    return `${x}%,${y}%`
  }
  await handset.swipe({ start: centre(from), end: centre(to), duration })
  await navTabSelected(handset, to)
}

export async function chatFixture(
  ctx: E2eContext
): Promise<{ person: FixtureAccount; roomId: string }> {
  const world = await ctx.fixture('team-with-roster')
  const person = world.accounts.coach
  const client = new TeamStationClient({
    baseUrl: ctx.stack.origin + '/api/v1',
    passwordKdf: testPasswordKdf
  })
  await client.signInWithPassword(person.email, person.password)
  await client.setMyAge({ adult: true })
  for (let attempt = 0; attempt < 40; attempt++) {
    const room = (await client.chatConversations()).find(
      item => item.scope?.id === world.ids.team
    )
    if (room != null) {
      await client.updateChatPreferences(room.id, { manualUnread: true })
      return { person, roomId: room.id }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('The seeded team has no chat conversation')
}

/** Fresh accounts can receive the notification prompt as the chat list first opens. */
export async function openChatList(
  handset: Awaited<ReturnType<typeof openTabBar>>,
  roomId: string
): Promise<void> {
  await navTab(handset, 'chat')
  await handset.assertVisible({
    id: 'chat-conversation-' + roomId,
    timeout: 45000
  })
  const later = { id: 'notification-ask-not-now' }
  const prompt: boolean = await handset
    .assertVisible({ ...later, timeout: 5000 })
    .then(
      () => true,
      () => false
    )
  if (prompt) {
    await handset.tapOn(later)
    await handset.assertNotVisible({ ...later, timeout: 10000 })
  }
}

type Handset = Awaited<ReturnType<typeof openTabBar>>

/** Require a genuine UIKit tab bar containing both ends of the drag. */
export async function requireSystemTabBar(handset: Handset): Promise<void> {
  const { osVersion } = await handset.platformInfo()
  const major = Number.parseInt(osVersion ?? '', 10)
  if (!Number.isFinite(major) || major < 26)
    throw new BlockedError('The UIKit tab bar needs iOS 26 or newer')
  const bar = flatten(await handset.hierarchy()).find(
    node => node.type === 'TabBar'
  )
  assert(bar != null, 'UIKit exposes the native TabBar')
  const children = flatten(bar)
  for (const id of ['tab-home', 'tab-search'])
    assert(
      children.some(node => node.id === id),
      'UIKit TabBar contains ' + id
    )
}

/** Restore the original appearance even if a screenshot assertion fails. */
export async function withIosAppearance(
  udid: string,
  run: (
    setAppearance: (appearance: 'light' | 'dark') => Promise<void>
  ) => Promise<void>
): Promise<void> {
  if (isHubDevice(udid) || !iosIsSimulator(udid))
    throw new BlockedError('Changing iOS appearance needs a simulator')
  const args = ['simctl', 'ui', udid, 'appearance']
  const read = async (): Promise<string> =>
    (await promisify(execFile)('xcrun', args)).stdout.trim()
  const original = await read()
  assert(
    original === 'light' || original === 'dark',
    'read the original appearance'
  )
  const set = async (value: 'light' | 'dark'): Promise<void> => {
    await promisify(execFile)('xcrun', [...args, value])
    assert.equal(await read(), value)
  }
  try {
    await run(set)
  } finally {
    await set(original)
  }
}

/** Measure the painted badge and background within Chat's accessible tab frame. */
export async function chatTabPixels(
  handset: Handset
): Promise<{ red: number; lightFraction: number }> {
  const root = await handset.hierarchy()
  const frame = root.bounds
  const chat = flatten(root).find(node => node.id === 'tab-chat')?.bounds
  assert(frame != null && chat != null, 'Chat has a visible tab frame')
  const shot = PNG.sync.read(Buffer.from(await handset.screenshot()))
  const scale = shot.width / frame.width
  let red = 0
  let light = 0
  let count = 0
  for (
    let y = Math.round((chat.y - frame.y) * scale);
    y < (chat.y - frame.y + chat.height) * scale;
    y++
  ) {
    for (
      let x = Math.round((chat.x - frame.x) * scale);
      x < (chat.x - frame.x + chat.width) * scale;
      x++
    ) {
      const i = 4 * (y * shot.width + x)
      const [r, g, b] = shot.data.subarray(i, i + 3)
      if (r > 200 && g < 110 && b < 110) red++
      if (r > 180 && g > 180 && b > 180) light++
      count++
    }
  }
  return { red: red / (scale * scale), lightFraction: light / count }
}
