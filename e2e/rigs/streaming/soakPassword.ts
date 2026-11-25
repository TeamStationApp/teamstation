import type { FixtureAccount } from '../../../src/server/dev/fixtures/accounts'
import { signInWithPassword } from '../../core/fixtures'
import type { MaestroDevice } from '../../core/maestro'
import { flatten } from './phonePublisher'
import { SIGNED_OUT, signOutApp } from './soakSignIn'
import { TV_APP } from './streamingSession'
import type { HierarchyNode } from './surfaces/hierarchy'
import { realSleep } from './surfaces/surface'
import { parseTvDump, type TvRemote } from './surfaces/tv'

/** Sign in on the visible app or web page, including a device left signed in. */
export async function signInSoakSurface(
  device: MaestroDevice,
  account: Pick<FixtureAccount, 'email' | 'password'>,
  android = false
): Promise<void> {
  if (account.password === '')
    throw new Error('The soak needs a fresh fixture account')
  try {
    await device.assertVisible({ text: SIGNED_OUT, timeout: 8000 })
  } catch {
    await signOutApp(device)
  }
  const home = '^(TeamStation menu|Your Home)$'
  if (!android) {
    await signInWithPassword(device, account, home)
    return
  }

  await device.tapOn({ text: 'Use a password instead' })
  const fields = async (): Promise<HierarchyNode[]> =>
    flatten((await device.hierarchy()) as HierarchyNode).filter(
      node => node.type === 'EditText'
    )
  for (const [index, value] of [account.email, account.password].entries()) {
    const inputs = await fields()
    const bounds = inputs[index]?.bounds
    if (inputs.length !== 2 || bounds == null)
      throw new Error('Expected the Android email and password inputs')
    await device.tapOn({
      point: `${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)}`
    })
    const focused = (await fields())[index]
    if (focused?.focused !== true)
      throw new Error(
        'The intended Android sign-in field did not receive focus'
      )
    await device.eraseText({ characters: Math.max(80, value.length + 8) })
    await device.inputText({ text: value })
    // The Galaxy keyboard can cover the next field until it is dismissed.
    await device.hideKeyboard()
  }
  await device.tapOn({ text: '^Sign in$', traits: 'button' })
  // Android's system save sheet can cover a successful sign-in on the Pixel.
  await device.tapOn({
    id: 'android:id/autofill_save_no',
    optional: true,
    timeout: 8000
  })
  await device.assertVisible({ text: home, timeout: 20000 })
}

/** The owner enters the leased TV's displayed code on the normal pairing screen. */
export async function pairSoakTv(
  remote: TvRemote,
  signOut: () => Promise<void>,
  owner: MaestroDevice,
  openPairing: () => Promise<void>
): Promise<void> {
  let approved = false
  for (let attempt = 0; attempt < 10; attempt++) {
    const nodes = parseTvDump(await remote([`app:${TV_APP}`, 'wait:3', 'dump']))
    if (
      !nodes.some(
        node => node.type === 'Application' && node.label === 'TeamStation'
      )
    )
      continue
    if (nodes.some(node => node.identifier === 'tv-page-home')) {
      if (approved) return
      await signOut()
      continue
    }
    if (
      !approved &&
      nodes.some(
        node =>
          node.identifier?.startsWith('tv-page-') === true ||
          node.identifier === 'tv-player'
      )
    ) {
      await remote(['menu'])
      continue
    }
    const text =
      nodes.find(node => node.identifier === 'tv-login-code')?.label ?? ''
    const code = /^TV login code ([A-Z]{4})[–-]?([A-Z]{4})$/i.exec(text)
    if (approved || code == null) continue
    await openPairing()
    await owner.tapOn({ text: 'Enter TV code' })
    // The native input moves its selection on every change. Let each letter
    // render before entering the next one on the paired iPhone.
    for (const letter of code[1] + code[2]) {
      await owner.inputText({ text: letter })
      await realSleep(180)
    }
    await owner.assertVisible({ text: 'Your TV is signed in', timeout: 15000 })
    approved = true
  }
  throw new Error(
    'TeamStation TV did not reach the fixture owner’s home after pairing'
  )
}
