import { writeFileSync } from 'node:fs'

import type { HarnessContext } from '../../core/spec'
import { frames, recordScreen, videoSize } from '../../core/video'
import {
  flatten as flattenNodes,
  type Node as CoachNode
} from '../coach/coachApp'
import { fieldTopPerFrame, motionOf, restRow } from './keyboardMotion'
import { pointAtStack } from './pointAtStack'

/**
 * What the keyboard-dock scenarios share on a phone or tablet: reading the
 * hierarchy for where things sit, reaching Search and its tabs, typing as
 * each platform allows, and measuring a move in maestro-d's recording of
 * the device's screen.
 */

/** The app id the caller passed for this run's platform. */
export const appOf = (ctx: HarnessContext): string =>
  ctx.app(ctx.surface === 'ios-app' ? 'teamstation-ios' : 'teamstation-android')
export const PLACEHOLDER = 'Search leagues, seasons, teams and people'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}
/** The coach rig's hierarchy node, which some drivers place by x and y. */
export interface Node extends CoachNode, Partial<Box> {
  children?: Node[]
}

/** Every element of a hierarchy, the coach rig's way. */
export function flatten(node: Node | undefined): Node[] {
  return node == null ? [] : flattenNodes(node)
}
export const boxOf = (node: Node | undefined): Box | undefined =>
  node?.bounds ??
  (node?.y == null
    ? undefined
    : {
        x: node.x ?? 0,
        y: node.y,
        width: node.width ?? 0,
        height: node.height ?? 0
      })

/** The device's own screenshot, kept with the run's evidence. */
export async function prove(
  ctx: HarnessContext,
  device: any,
  name: string
): Promise<void> {
  writeFileSync(ctx.artifact(name), await device.screenshot())
}

/** A text log kept with the run's evidence. */
export function proveLog(
  ctx: HarnessContext,
  name: string,
  text: string
): void {
  writeFileSync(ctx.artifact(name), text)
}

/** What a run's platform is, by its surface. */
export const platformOf = (ctx: HarnessContext): 'ios' | 'android' =>
  ctx.surface === 'ios-app' ? 'ios' : 'android'

/** `iphone`, `pixel` or `ipad`, for a proving file's name. */
export async function deviceName(
  ctx: HarnessContext,
  device: any
): Promise<string> {
  if (platformOf(ctx) === 'android') return 'pixel'
  // An iPad's screen is wider, in points, than any iPhone's is tall.
  const width = Math.max(
    ...flatten((await device.hierarchy()) as Node)
      .map(boxOf)
      .filter((box): box is Box => box != null)
      .map(box => box.x + box.width)
  )
  return width >= 700 ? 'ipad' : 'iphone'
}

/**
 * Whether `box` sits wholly above the keyboard. A hierarchy that shows no
 * keyboard (Android lists none), or only an unrotated one, says nothing, and
 * the dock's rise and the screenshot decide.
 */
export async function aboveKeyboard(
  device: any,
  box: Box
): Promise<{ above: boolean; keyboard: Box } | null> {
  const nodes = flatten((await device.hierarchy()) as Node)
  const keyboard = boxOf(nodes.find(node => node.type === 'Keyboard'))
  // A keyboard is wider than it is tall; an iPad held sideways reports its
  // frame unrotated, which says nothing about where it covers.
  if (keyboard == null || keyboard.width < keyboard.height) return null
  return { above: box.y + box.height <= keyboard.y, keyboard }
}

export async function boxOfField(device: any): Promise<Box> {
  const nodes = flatten((await device.hierarchy()) as Node)
  const field = nodes.find(
    node =>
      node.id === 'Search field' ||
      node.accessibilityText === PLACEHOLDER ||
      node.text === PLACEHOLDER
  )
  const box = boxOf(field)
  if (box == null) throw new Error('the Search field is not on screen')
  return box
}

/**
 * Taps a tab where it is drawn: a phone's floating bar or a tablet's
 * header, an icon labelled with the tab's name (a longer label that holds
 * the name, such as the Search field's, is bigger, so the smallest match is
 * the tab).
 */
export async function tapTab(device: any, label: string): Promise<void> {
  // A keyboard left up covers a phone's floating tab bar, and a tap at the
  // tab's place would land on a key (iOS's emoji key sits under Home): put
  // it away until the tab is clear.
  for (let tries = 0; ; ++tries) {
    const nodes = flatten((await device.hierarchy()) as Node)
    const tabs = nodes.filter(
      node =>
        (node.text ?? node.accessibilityText) === label && boxOf(node) != null
    )
    const tab = boxOf(
      tabs.sort((a, b) => {
        const [x, y] = [boxOf(a)!, boxOf(b)!]
        return x.width * x.height - y.width * y.height
      })[0]
    )
    if (tab == null) throw new Error(`no ${label} tab on screen`)
    const centre = { x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 }
    const keyboard = boxOf(nodes.find(node => node.type === 'Keyboard'))
    const covered =
      keyboard != null &&
      centre.x >= keyboard.x &&
      centre.x <= keyboard.x + keyboard.width &&
      centre.y >= keyboard.y &&
      centre.y <= keyboard.y + keyboard.height
    if (!covered) {
      await device.tapOn({
        point: `${Math.round(centre.x)},${Math.round(centre.y)}`
      })
      return
    }
    if (tries === 2)
      throw new Error(`the keyboard still covers the ${label} tab`)
    await device.hideKeyboard()
  }
}

/**
 * A key at a time on iOS, where a whole string typed at once can lose
 * letters; at once on Android, where each `inputText` sets the field's text.
 */
export async function typeKeys(
  device: any,
  ios: boolean,
  text: string
): Promise<void> {
  if (!ios) {
    await device.inputText({ text })
    return
  }
  for (const key of text) await device.inputText({ text: key })
}

/**
 * Opens Search on a fresh launch. `signedOut` clears the app's state first
 * (a scenario that signs in leaves it signed in), and points the cleared
 * app back at the run's stack, which a clear forgets.
 */
export async function openSearch(
  ctx: HarnessContext,
  device: any,
  options: { signedOut?: boolean } = {}
): Promise<void> {
  const appId = appOf(ctx)
  if (options.signedOut === true) {
    await device.launchApp({ appId, stopApp: true, clearState: true })
    await pointAtStack(device, ctx.stack.origin, appId)
  } else await device.launchApp({ appId, stopApp: true })
  await device.assertVisible({ text: 'Search', timeout: 30000 })
  // A launch can settle on Home after its first frame (signed out, the
  // sign-in card): a tap that lands before then is undone, so tap again.
  for (let attempt = 1; ; attempt++) {
    await tapTab(device, 'Search')
    try {
      await device.assertVisible({ text: PLACEHOLDER, timeout: 8000 })
      return
    } catch (error) {
      if (attempt === 3) throw error
    }
  }
}

/** How long a recording runs before and after the measured action. */
const LEAD_MS = 1500

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** The screen's height in points: the hierarchy's root, or what its nodes reach. */
export function screenPoints(nodes: Node[]): number {
  const root = boxOf(nodes[0])
  if (root != null && root.height > 0) return root.y + root.height
  return Math.max(
    0,
    ...nodes.map(node => {
      const box = boxOf(node)
      return box == null ? 0 : box.y + box.height
    })
  )
}

/** Whether maestro-d said this device has no screen capture (an iOS simulator, a browser). */
export function captureUnavailable(error: unknown): boolean {
  const found = error as { code?: unknown; message?: unknown } | null
  return (
    found?.code === 'CAPTURE_UNAVAILABLE' ||
    /CAPTURE_UNAVAILABLE|screen capture unavailable/i.test(
      String(found?.message ?? error)
    )
  )
}

/**
 * The top edge of what is followed (Search's field, or the element `rest`
 * finds) through maestro-d's recording of the device's screen around
 * `action`. A device maestro-d cannot record says so and measures nothing.
 */
export async function measure(
  ctx: HarnessContext,
  device: any,
  name: string,
  action: () => Promise<void>,
  rest: (device: any) => Promise<Box> = boxOfField
): Promise<{ up: boolean; down: boolean } | null> {
  const nodes = flatten((await device.hierarchy()) as Node)
  const at = await rest(device)
  const screen = screenPoints(nodes)
  let acted = false
  let file: string
  try {
    file = (
      await recordScreen(device, ctx.runDir, `motion-${name}`, async () => {
        acted = true
        // The edge at rest first, and the whole animation back after.
        await wait(LEAD_MS)
        await action()
        await wait(LEAD_MS)
      })
    ).file
  } catch (error) {
    if (acted || !captureUnavailable(error)) throw error
    ctx.degrade(
      `maestro-d cannot record this device's screen: motion not measured`
    )
    await action()
    return null
  }
  const size = videoSize(file)
  const positions = fieldTopPerFrame(
    await frames(file, { ...size, x: 0, y: 0 }),
    restRow(at.y, screen, size.height)
  )
  const motion = motionOf(positions)
  const log = [
    `$ keyboardMotion ${name} on ${ctx.device('phone')} (${positions.length} frames of ${size.width}x${size.height})`,
    `field top per frame: ${positions.join(' ')}`,
    `rest ${motion.up.rest}, raised ${motion.up.raised}`,
    `up: ${motion.up.between.length} places between (${motion.up.animated ? 'animated' : 'jumped'})`,
    `down: ${motion.down.between.length} places between (${motion.down.animated ? 'animated' : 'jumped'})`
  ].join('\n')
  const who = await deviceName(ctx, device)
  proveLog(ctx, `${who}-${name}-frames.log`, `${log}\n`)
  return { up: motion.up.animated, down: motion.down.animated }
}
