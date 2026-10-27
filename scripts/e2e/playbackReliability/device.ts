import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Rect } from './motion'

/** The slice of maestro-d's `MaestroDevice` the suite drives a phone with. */
export interface DeviceDriver {
  openLink: (args: Record<string, unknown>) => Promise<unknown>
  launchApp: (args?: Record<string, unknown>) => Promise<unknown>
  stopApp: (args?: Record<string, unknown>) => Promise<unknown>
  tapOn: (args: Record<string, unknown>) => Promise<unknown>
  swipe: (args: Record<string, unknown>) => Promise<unknown>
  inputText: (args: Record<string, unknown>) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  hierarchy: () => Promise<HierarchyNode>
}

/** maestro-d's normalized tree, the same on every platform. */
export interface HierarchyNode {
  type?: string
  id?: string
  text?: string
  focused?: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  children?: HierarchyNode[]
}

export interface Found {
  type: string
  text: string
  rect: Rect
}

/** Every node with text and bounds, depth first. */
export function flatten(node: HierarchyNode, into: Found[] = []): Found[] {
  const text = node.text ?? ''
  if (node.bounds != null && text !== '') {
    into.push({
      type: node.type ?? '',
      text,
      rect: {
        x: node.bounds.x,
        y: node.bounds.y,
        w: node.bounds.width,
        h: node.bounds.height
      }
    })
  }
  for (const child of node.children ?? []) flatten(child, into)
  return into
}

/**
 * Nodes whose text is exactly `text` — never a substring, which is what made
 * a tap on "Sign in" land on "Sign in to TeamStation" — optionally of a type,
 * and only those with some size on the screen.
 */
export function findExact(
  nodes: Found[],
  text: string | RegExp,
  type?: string
): Found[] {
  return nodes.filter(
    node =>
      (typeof text === 'string' ? node.text === text : text.test(node.text)) &&
      (type == null || node.type === type) &&
      node.rect.w > 0 &&
      node.rect.h > 0
  )
}

/**
 * The text field that has the keyboard, if the platform says: Android marks
 * it `focused`. iOS does not, but names a password field's type
 * `SecureTextField`. Before typing a secret the suite asks this, and refuses
 * to type unless the answer is a field under the password label — so a
 * password never lands in the e-mail field, on the screen and in its pictures.
 */
export function passwordField(root: HierarchyNode, label: Rect): Rect | null {
  const fields: Array<{ node: HierarchyNode; rect: Rect }> = []
  const walk = (node: HierarchyNode): void => {
    if (node.bounds != null && /EditText|TextField/.test(node.type ?? '')) {
      const b = node.bounds
      fields.push({ node, rect: { x: b.x, y: b.y, w: b.width, h: b.height } })
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  const below = fields.filter(
    field =>
      field.rect.y >= label.y + label.h && field.rect.y <= label.y + label.h * 6
  )
  const secure = below.find(field => field.node.type === 'SecureTextField')
  if (secure != null) return secure.rect
  const focused = below.find(field => field.node.focused === true)
  return focused?.rect ?? null
}

/**
 * An angle chip on the game page: the node with this exact text in the same
 * row as the `Primary` chip — never the navigation bar's `Home` — and the
 * largest of them, which is the control rather than its label.
 */
export function chipFor(nodes: Found[], label: string): Found | null {
  const primary = nodes.find(node => node.text === 'Primary' && node.rect.h > 0)
  if (primary == null) return null
  const row = primary.rect.y + primary.rect.h / 2
  // A chip is a pill, wider than tall: the floating navigation's square Home
  // button can sit level with the chips, and is not one.
  const inRow = nodes.filter(
    node =>
      node.text === label &&
      node.rect.w > node.rect.h &&
      Math.abs(node.rect.y + node.rect.h / 2 - row) <= primary.rect.h / 2
  )
  return (
    inRow.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0] ?? null
  )
}

/**
 * The least scroll that shows the player and its chips together: the chips'
 * row lifted to 70 % of the screen, clear of the floating navigation, without
 * pushing the player's top above 8 % — scrolled further, the player sticks to
 * the top and Android's Chrome drops it from its accessibility tree. Null when
 * both already show. A quick drag: on an iPhone a slower one starts as a
 * press and the page does not move at all. The page carries on a little past
 * the point, which the next look corrects.
 *
 * The drag never starts on the player (`playerBottom` given): a drag across
 * the pictures is the player's own, a scrub, and the page does not move. It
 * starts just above the player, or just below it when there is no room, and
 * near the right edge: a slow drag that starts on a button (the game page's
 * Videos, Box score and Info sit just above the player) is a press there.
 */
export function scrollToFit(
  playerTop: number,
  chipsBottom: number,
  screenHeight: number,
  playerBottom?: number
): Record<string, unknown> | null {
  if (chipsBottom <= screenHeight * 0.75 && playerTop >= screenHeight * 0.08)
    return null
  // The player above its limit is brought back down by itself; otherwise the
  // chips are lifted, but never so far that the player passes its limit.
  const by =
    playerTop < screenHeight * 0.08
      ? playerTop - screenHeight * 0.08
      : Math.min(
          chipsBottom - screenHeight * 0.7,
          playerTop - screenHeight * 0.08
        )
  if (Math.abs(by) < screenHeight * 0.02) return null
  let from = by > 0 ? 0.6 : 0.3
  if (playerBottom != null) {
    const top = playerTop / screenHeight
    const bottom = playerBottom / screenHeight
    if (from >= top && from <= bottom) {
      const fits = (start: number): boolean =>
        start >= 0.05 &&
        start <= 0.9 &&
        start - by / screenHeight >= 0.05 &&
        start - by / screenHeight <= 0.95
      from = [top - 0.03, bottom + 0.03].find(fits) ?? (by > 0 ? 0.6 : 0.3)
    }
  }
  const to = from - by / screenHeight
  return {
    start: `92%,${Math.round(from * 100)}%`,
    end: `92%,${Math.round(to * 100)}%`,
    duration: 300
  }
}

/**
 * Where to tap a node: its middle, or with a screen given, the middle of the
 * part of it on the screen — a chip row scrolls sideways, and the last chip's
 * own middle can be off the glass, where a tap does nothing.
 */
export function centre(
  rect: Rect,
  screen?: { width: number; height: number }
): { x: number; y: number } {
  const left = screen == null ? rect.x : Math.max(0, rect.x)
  const right =
    screen == null ? rect.x + rect.w : Math.min(screen.width, rect.x + rect.w)
  const top = screen == null ? rect.y : Math.max(0, rect.y)
  const bottom =
    screen == null ? rect.y + rect.h : Math.min(screen.height, rect.y + rect.h)
  return {
    x: Math.round((left + right) / 2),
    y: Math.round((top + bottom) / 2)
  }
}

/** The screen's points to the screenshot's pixels, from the screenshot's own width. */
export function toPixels(rect: Rect, scale: number): Rect {
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    w: rect.w * scale,
    h: rect.h * scale
  }
}

/** A PNG's width, from its header. */
export function pngWidth(png: Uint8Array): number {
  if (
    png.length < 24 ||
    png[1] !== 0x50 ||
    png[2] !== 0x4e ||
    png[3] !== 0x47
  ) {
    throw new Error('not a PNG')
  }
  return ((png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19]) >>> 0
}

export interface Shot {
  atMs: number
  file: string
}

/**
 * Screenshots into `dir` as a numbered sequence, each stamped with when it
 * came back, until `untilMs` on this machine's clock. Spaced at least
 * `everyMs` apart; a phone that is slower to answer simply gives fewer.
 */
export async function sampleScreens(
  device: Pick<DeviceDriver, 'screenshot'>,
  dir: string,
  untilMs: number,
  everyMs: number,
  /** The number the first file takes, so batches into one directory continue it. */
  first = 1,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = async ms => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
): Promise<Shot[]> {
  mkdirSync(dir, { recursive: true })
  const shots: Shot[] = []
  while (now() < untilMs) {
    const asked = now()
    const png = await device.screenshot()
    // Halfway through the call is the best guess at when the glass was read.
    const atMs = Math.round((asked + now()) / 2)
    const file = join(
      dir,
      `${String(first + shots.length).padStart(6, '0')}.png`
    )
    writeFileSync(file, png)
    shots.push({ atMs, file })
    const wait = everyMs - (now() - asked)
    if (wait > 0) await sleep(wait)
  }
  return shots
}

/** `1:33:50` or `3:07` as seconds; null for anything else. */
export function clockSeconds(text: string): number | null {
  if (!/^\d+(:\d\d){1,2}$/.test(text)) return null
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

/**
 * Where the scrub bar's knob is, as a fraction of its track: the time beside
 * the track's left end over the total beside its right end.
 */
export function knobFraction(nodes: Found[], track: Rect): number | null {
  const beside = nodes.filter(
    node =>
      clockSeconds(node.text) != null &&
      node.rect.y < track.y + track.h &&
      node.rect.y + node.rect.h > track.y
  )
  const left = beside.filter(node => node.rect.x + node.rect.w <= track.x + 1)
  const right = beside.filter(node => node.rect.x >= track.x + track.w - 1)
  if (left.length === 0 || right.length === 0) return null
  const at = clockSeconds(left[left.length - 1].text) ?? 0
  const total = clockSeconds(right[0].text) ?? 0
  return total > 0 ? Math.min(1, at / total) : null
}

/**
 * A finger dragged along a track from one fraction of it to another, held
 * long enough to be a drag rather than a flick. The track is in the screen's
 * points; the swipe is given as percentages of the screen, because maestro-d
 * reads a swipe's bare numbers as percentages too — `181,2264` went off the
 * screen, and not one scrub happened.
 */
export function dragAlong(
  track: Rect,
  from: number,
  to: number,
  screen: { width: number; height: number },
  durationMs = 600
): Record<string, unknown> {
  const y = track.y + track.h / 2
  const x = (fraction: number): number =>
    track.x + track.w * Math.min(1, Math.max(0, fraction))
  const percent = (value: number, of: number): string =>
    `${((value / of) * 100).toFixed(2)}%`
  return {
    start: `${percent(x(from), screen.width)},${percent(y, screen.height)}`,
    end: `${percent(x(to), screen.width)},${percent(y, screen.height)}`,
    duration: durationMs
  }
}
