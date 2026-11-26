import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { NavTabId } from '../../../src/app/components/tabBarModel'
import { TeamStationClient } from '../../../src/common/api'
import { navTabId, navTabSelected } from '../../../src/test/navTab.e2e'
import { testPasswordKdf } from '../../../src/test/passwordFixtures'
import { type FixtureAccount, signInWithPassword } from '../../core/fixtures'
import { isHubDevice } from '../../core/maestro'
import { iosIsSimulator } from '../../core/prepare'
import type { E2eContext } from '../../core/spec'
import { DEVELOP_APP, flatten, type Node } from '../coach/coachApp'
import { setServer } from './setServer'

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
      simulator: platform === 'ios' && !isHubDevice(deviceId)
    })
  const simulator =
    platform === 'ios' && !isHubDevice(deviceId) && iosIsSimulator(deviceId)
  if (renderer === 'capsule' && !simulator)
    throw new Error('The capsule launch override needs an iOS simulator')
  if (simulator) {
    await handset.stopApp({ appId })
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
