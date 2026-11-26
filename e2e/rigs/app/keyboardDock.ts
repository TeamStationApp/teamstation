import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { navTab, navTabId } from '../../../src/test/navTab.e2e'
import type { E2eContext } from '../../core/spec'
import {
  flatten as flattenNodes,
  type Node as CoachNode
} from '../coach/coachApp'
import { ARTIFACTS_ENV, proveLog } from '../search/searchRig'
import {
  fieldTopPerFrame,
  frames,
  motionFile,
  motionOf,
  record,
  webcamFor
} from './keyboardMotion'

/**
 * What the keyboard-dock scenarios share on a phone or tablet: reading the
 * hierarchy for where things sit, reaching Search and its tabs, typing as
 * each platform allows, and measuring a move on the bench camera.
 */

export const APP = 'app.teamstation.develop'
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

/** The device's own screenshot, kept with the run and with the plan's proof. */
export async function prove(
  ctx: E2eContext,
  device: any,
  name: string
): Promise<void> {
  const file = ctx.artifact(name)
  writeFileSync(file, await device.screenshot())
  const dir = process.env[ARTIFACTS_ENV]
  if (dir != null && dir !== '') {
    mkdirSync(dir, { recursive: true })
    copyFileSync(file, join(dir, name))
  }
}

/** What a run's platform is, by its surface. */
export const platformOf = (ctx: E2eContext): 'ios' | 'android' =>
  ctx.surface === 'ios-app' ? 'ios' : 'android'

/** `iphone`, `pixel` or `ipad`, for a proving file's name. */
export async function deviceName(
  ctx: E2eContext,
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

export async function tapTab(
  device: any,
  id: 'home' | 'search'
): Promise<void> {
  // A keyboard left up covers a phone's floating tab bar, and a tap at the
  // tab's place would land on a key (iOS's emoji key sits under Home): put
  // it away until the tab is clear.
  for (let tries = 0; ; ++tries) {
    const nodes = flatten((await device.hierarchy()) as Node)
    const tab = boxOf(nodes.find(node => node.id === navTabId(id)))
    if (tab == null) throw new Error(`no ${id} tab on screen`)
    const centre = { x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 }
    const keyboard = boxOf(nodes.find(node => node.type === 'Keyboard'))
    const covered =
      keyboard != null &&
      centre.x >= keyboard.x &&
      centre.x <= keyboard.x + keyboard.width &&
      centre.y >= keyboard.y &&
      centre.y <= keyboard.y + keyboard.height
    if (!covered) {
      await navTab(device, id)
      return
    }
    if (tries === 2) throw new Error(`the keyboard still covers the ${id} tab`)
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
 * (a scenario that signs in leaves it signed in); a Mason develop build
 * talks to its own seat again after a clear, so setServer's choice is lost.
 */
export async function openSearch(
  device: any,
  options: { signedOut?: boolean } = {}
): Promise<void> {
  await device.launchApp({
    appId: APP,
    stopApp: true,
    ...(options.signedOut === true ? { clearState: true } : {})
  })
  await device.assertVisible({ text: 'Search', timeout: 30000 })
  // A launch can settle on Home after its first frame (signed out, the
  // sign-in card): a tap that lands before then is undone, so tap again.
  for (let attempt = 1; ; attempt++) {
    await tapTab(device, 'search')
    try {
      await device.assertVisible({ text: PLACEHOLDER, timeout: 8000 })
      return
    } catch (error) {
      if (attempt === 3) throw error
    }
  }
}

/**
 * The dock's top edge through a recording on the bench camera; a run with
 * no camera crop for its device says so and measures nothing.
 */
export async function measure(
  ctx: E2eContext,
  device: any,
  name: string,
  action: () => Promise<void>,
  /**
   * What is followed when not Search's field: its crop is the device's id
   * then `#<target>`, whose rest row is where that element rests.
   */
  target?: string
): Promise<{ up: boolean; down: boolean } | null> {
  const key =
    target == null ? ctx.device('phone') : `${ctx.device('phone')}#${target}`
  const camera = webcamFor(key)
  if (camera == null) {
    ctx.degrade(`no webcam crop for ${key}: motion not measured`)
    await action()
    return null
  }
  const file = await record(camera.url, motionFile(ctx.runDir, name), action)
  const positions = fieldTopPerFrame(
    await frames(file, camera.crop),
    camera.crop.fieldY
  )
  const motion = motionOf(positions)
  const log = [
    `$ keyboardMotion ${name} on ${ctx.device('phone')} (${positions.length} frames)`,
    `field top per frame: ${positions.join(' ')}`,
    `rest ${motion.up.rest}, raised ${motion.up.raised}`,
    `up: ${motion.up.between.length} places between (${motion.up.animated ? 'animated' : 'jumped'})`,
    `down: ${motion.down.between.length} places between (${motion.down.animated ? 'animated' : 'jumped'})`
  ].join('\n')
  const who = await deviceName(ctx, device)
  proveLog(ctx, `${who}-${name}-frames.log`, `${log}\n`)
  const dir = process.env[ARTIFACTS_ENV]
  if (dir != null && dir !== '') {
    mkdirSync(dir, { recursive: true })
    copyFileSync(file, join(dir, `${who}-${name}.mp4`))
  }
  return { up: motion.up.animated, down: motion.down.animated }
}
