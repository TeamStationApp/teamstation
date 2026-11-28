import { spawn } from 'node:child_process'

import { expect } from 'chai'
import { PNG } from 'pngjs'

import {
  recordHubDevice,
  type RecordingDevice
} from '../../../src/test/hubRecording.e2e'
import { iosIsSimulator } from '../../core/prepare'

/**
 * What the glass-growth scenarios read of a pinned pill band, or a sticky
 * section, and the header over it, on a page or a phone, and what they
 * expect of it: the header's glass grows 1:1 with the scroll from the
 * header's lower edge down to the band's lower edge over the last
 * band-height before the band pins (`glassGrowth` in
 * `src/app/components/pinnedHead.ts`), and the header hands its glass and
 * its lower line to the band's pane while the pane has grown.
 */

/**
 * Which kind of pinned bar a frame is read from: a `PillBand` (`pill-band`,
 * or the event's `event-pill-band`) and its pane, or a
 * `StickySectionLayout`'s section and its pane.
 */
export type GlassKind = 'band' | 'sticky'

export const GLASS_IDS: Record<GlassKind, { bands: string[]; pane: string }> = {
  band: { bands: ['pill-band', 'event-pill-band'], pane: 'pill-band-glass' },
  sticky: { bands: ['sticky-season-sections'], pane: 'sticky-section-glass' }
}

/** One frame, in the screen's units, top to bottom. */
export interface GlassFrame {
  /** The header's lower edge. */
  headerBottom: number
  /** The band's pane: from the top of the screen to how far it has grown. */
  paneTop: number
  paneBottom: number
  /** The pill band itself. */
  bandTop: number
  bandBottom: number
}

/** How many units a reading may be off: a browser's rounding, or iOS's. */
export const SLACK = 1.5

/**
 * The band's travel to the pin at rest, `pinAt`, as the growth is measured
 * against: how far below the header its top starts.
 */
export function pinAtOf(rest: GlassFrame): number {
  return Math.max(0, rest.bandTop - rest.headerBottom)
}

/** Where the pane's lower edge belongs in `frame`, for a band that starts `pinAt` below the header. */
export function expectedPaneBottom(frame: GlassFrame, pinAt: number): number {
  const band = frame.bandBottom - frame.bandTop
  const reach = Math.max(0, frame.bandTop - frame.headerBottom)
  const travel = Math.min(band, pinAt)
  const progress =
    travel <= 0 ? 0 : Math.min(1, Math.max(0, 1 - reach / travel))
  return frame.headerBottom + progress * band
}

/** How far the pane has grown below the header, 0 to 1. */
export function grownOf(frame: GlassFrame): number {
  const band = frame.bandBottom - frame.bandTop
  return band <= 0
    ? 0
    : Math.max(0, Math.min(1, (frame.paneBottom - frame.headerBottom) / band))
}

/**
 * Checks one frame: the pane starts at the top of the screen, its lower edge
 * is where the scroll puts it, and it never leaves a gap under the header.
 */
export function expectFrame(
  frame: GlassFrame,
  pinAt: number,
  what: string,
  slack = SLACK
): void {
  expect(Math.abs(frame.paneTop), `${what}: the pane starts at the top`).lte(
    slack
  )
  expect(
    frame.paneBottom,
    `${what}: the pane reaches the header’s lower edge`
  ).gte(frame.headerBottom - slack)
  expect(
    Math.abs(frame.paneBottom - expectedPaneBottom(frame, pinAt)),
    `${what}: the pane’s lower edge follows the scroll (${JSON.stringify(frame)})`
  ).lte(slack)
}

/** Whether the band is pinned under the header in this frame. */
export function pinned(frame: GlassFrame, slack = SLACK): boolean {
  return Math.abs(frame.bandTop - frame.headerBottom) <= slack
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}
interface Node {
  id?: string
  text?: string
  accessibilityText?: string
  bounds?: Box
  children?: Node[]
}

/**
 * The frame in a phone's hierarchy: the header (`app-header`), and the
 * band on screen (`GLASS_IDS[kind]`) with its pane, the one inside the band
 * the screen shows.
 */
export function glassFrameOf(
  root: Node,
  screenHeight: number,
  kind: GlassKind = 'band'
): GlassFrame | undefined {
  const ids = GLASS_IDS[kind]
  const all: Array<{ node: Node; parent: Node | undefined }> = []
  const walk = (node: Node, parent: Node | undefined): void => {
    all.push({ node, parent })
    for (const child of node.children ?? []) walk(child, node)
  }
  walk(root, undefined)
  const header = all.find(row => row.node.id === 'app-header')?.node.bounds
  if (header == null) return undefined
  const onScreen = (box: Box | undefined): box is Box =>
    box != null && box.height > 0 && box.y < screenHeight && box.x >= 0
  const bands = all.filter(
    row => ids.bands.includes(row.node.id ?? '') && onScreen(row.node.bounds)
  )
  for (const { node: band } of bands) {
    const inside: Node[] = []
    const collect = (node: Node): void => {
      for (const child of node.children ?? []) {
        inside.push(child)
        collect(child)
      }
    }
    collect(band)
    const pane = inside.find(node => node.id === ids.pane)?.bounds
    if (pane == null || band.bounds == null) continue
    return {
      headerBottom: header.y + header.height,
      paneTop: pane.y,
      paneBottom: pane.y + pane.height,
      bandTop: band.bounds.y,
      bandBottom: band.bounds.y + band.bounds.height
    }
  }
  return undefined
}

/** The bounds of the first element with test id `id`, if any is drawn. */
export function boundsOf(root: Node, id: string): Box | undefined {
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.id === id && node.bounds != null && node.bounds.height > 0)
      return node.bounds
    stack.push(...(node.children ?? []))
  }
  return undefined
}

/**
 * A screen's band without its pane: Android leaves an empty view out of its
 * hierarchy, so there the pane's lower edge is read from the picture.
 */
export function bandFrameOf(
  root: Node,
  kind: GlassKind
): { headerBottom: number; bandTop: number; bandBottom: number } | undefined {
  const header = boundsOf(root, 'app-header')
  const band = GLASS_IDS[kind].bands
    .map(id => boundsOf(root, id))
    .find(box => box != null)
  if (header == null || band == null) return undefined
  return {
    headerBottom: header.y + header.height,
    bandTop: band.y,
    bandBottom: band.y + band.height
  }
}

/**
 * The thin horizontal lines down one column of a screenshot, above
 * `bottom`, as their centres in its pixels: the header's lower line, or the
 * pane's that took it over, against the surface on either side of it.
 */
export function linesInColumn(
  png: Buffer,
  x: number,
  bottom: number
): number[] {
  const image = PNG.sync.read(png)
  const lum = (y: number): number => {
    const i = (y * image.width + x) * 4
    return (
      0.3 * image.data[i] + 0.59 * image.data[i + 1] + 0.11 * image.data[i + 2]
    )
  }
  const found: number[] = []
  for (let y = 4; y < Math.min(bottom, image.height - 6); y++) {
    for (let run = 1; run <= 4; run++) {
      const above = lum(y - 1)
      const below = lum(y + run)
      let inside = 0
      for (let k = 0; k < run; k++) inside += lum(y + k)
      inside /= run
      if (
        Math.abs(above - below) < 4 &&
        above - inside > 6 &&
        below - inside > 6
      ) {
        found.push(y + run / 2)
        y += run
        break
      }
    }
  }
  return found
}

/** What `stepOnPhone` needs of a maestro-d device. */
export interface StepDevice {
  hierarchy: () => Promise<unknown>
  dragPath: (options: {
    points: string[]
    duration: number
  }) => Promise<unknown>
}

/** A phone frame, read now. */
export async function phoneFrame(
  m: StepDevice,
  screen: { height: number },
  name: string,
  kind: GlassKind = 'band'
): Promise<GlassFrame> {
  // A screen just opened may not have drawn its band yet.
  const end = Date.now() + 15000
  for (;;) {
    const frame = glassFrameOf(
      (await m.hierarchy()) as Node,
      screen.height,
      kind
    )
    if (frame != null) return frame
    if (Date.now() > end) throw new Error(`${name}: no band on screen`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/**
 * 40pt drags on the phone from rest until the band pins, checking the pane
 * and taking the screen after each, then (unless `stayPinned`) back to rest
 * the same way. Returns how many drags it took to pin.
 */
export async function stepOnPhone(
  m: StepDevice,
  screen: { width: number; height: number },
  name: string,
  shot: (name: string) => Promise<void>,
  stayPinned = false,
  /** How far a reading may be off: 2pt on iOS, more pixels on Android. */
  slack = 2,
  kind: GlassKind = 'band'
): Promise<number> {
  const drag = async (dy: number): Promise<void> => {
    // In the page's margin, clear of the cards (a drag held on a map pans
    // it, and one on text selects it), slowly, so the page does not coast
    // on after the finger lifts. Percentages: the path's absolute points
    // are the screen's pixels, the hierarchy's are points.
    const pct = (value: number): string => `${value.toFixed(3)}%`
    const from = 60
    const to = from - (dy / screen.height) * 100
    await m.dragPath({
      points: [`2%, ${pct(from)}`, `2%, ${pct(to)}`],
      duration: 1500
    })
  }
  const read = async (): Promise<GlassFrame> =>
    await phoneFrame(m, screen, name, kind)
  const rest = await read()
  const pinAt = pinAtOf(rest)
  let step = 0
  for (let frame = rest; !pinned(frame, slack) && step < 40; step++) {
    expectFrame(frame, pinAt, `${name} step ${step}`, slack)
    await shot(`${name}-step-${String(step).padStart(2, '0')}`)
    await drag(40)
    frame = await read()
  }
  const top = await read()
  expect(pinned(top, slack), `${name}: pinned`).equals(true)
  expectFrame(top, pinAt, `${name} pinned`, slack)
  await shot(`${name}-pinned`)
  if (stayPinned) return step
  for (let back = 0; back < step + 4; back++) {
    await drag(-40)
    const frame = await read()
    expectFrame(frame, pinAt, `${name} back ${back}`, slack)
  }
  return step
}

/**
 * Drags the page down until its band stops moving: a page that opens
 * anchored (the umpire schedule, at its next game) starts pinned, and the
 * steps start from the top.
 */
export async function phoneToTop(
  m: StepDevice,
  screen: { width: number; height: number },
  name: string,
  kind: GlassKind = 'band'
): Promise<void> {
  let last = Number.NaN
  for (let i = 0; i < 20; i++) {
    const frame = await phoneFrame(m, screen, name, kind)
    if (Math.abs(frame.bandTop - last) < 1) return
    last = frame.bandTop
    await m.dragPath({ points: ['2%, 30%', '2%, 85%'], duration: 400 })
    await new Promise(resolve => setTimeout(resolve, 1200))
  }
}

/**
 * Records the phone's screen into `path` while `run` runs: a simulator
 * through `simctl io recordVideo` on this Mac, a leased device on its hub.
 */
export async function recordPhone(
  udid: string,
  device: RecordingDevice,
  path: string,
  run: () => Promise<void>
): Promise<void> {
  if (!iosIsSimulator(udid)) {
    await recordHubDevice(device, path, run)
    return
  }
  const recorder = spawn(
    'xcrun',
    ['simctl', 'io', udid, 'recordVideo', '--codec', 'h264', '--force', path],
    { stdio: 'ignore' }
  )
  // The recorder takes a moment to start writing.
  await new Promise(resolve => setTimeout(resolve, 1500))
  try {
    await run()
  } finally {
    const done = new Promise(resolve => recorder.once('exit', resolve))
    recorder.kill('SIGINT')
    await done
  }
}

/**
 * The point of the pill labelled `label` in the band on screen: the nav bar
 * has a Videos of its own.
 */
export async function tabPoint(
  m: StepDevice,
  screen: { height: number },
  label: string
): Promise<string> {
  const root = (await m.hierarchy()) as Node
  const frame = glassFrameOf(root, screen.height)
  if (frame == null) throw new Error('no band on screen')
  const all: Node[] = []
  const walk = (node: Node): void => {
    all.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  const tab = all.find(
    node =>
      (node.accessibilityText ?? node.text) === label &&
      node.bounds != null &&
      node.bounds.y >= frame.bandTop - 1 &&
      node.bounds.y + node.bounds.height <= frame.bandBottom + 1
  )
  if (tab?.bounds == null) throw new Error(`no ${label} pill in the band`)
  const { x, y, width, height } = tab.bounds
  return `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
}
