import { writeFileSync } from 'node:fs'

import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../../src/app/field/cameraModel'
import { BASES, createPlayers } from '../../../src/app/field/fieldModel'
import { runnerTargets } from '../../../src/app/scoring/runnerDrag'
import type { FixtureManifest } from '../../core/fixtures'
import { BlockedError } from '../../core/result'
import type { HarnessContext } from '../../core/spec'
import { clearSignInLimits } from '../coach/coachApp'
import { browserAppOf } from '../mobileWeb'

/**
 * The scoring screen in a phone's own browser (Safari on an iPhone), signed
 * in as the `scoring-preview` world's scorer, driven as a scorer's finger
 * drives it: through the accessibility tree the phone reports, with taps and
 * drags at points on the 3D field that the field's own camera model places.
 * Every step is a maestro-d command on the device the run was handed.
 */

export interface Point {
  x: number
  y: number
  /** How long the move to this point takes, in ms. */
  duration?: number
  /** How long the finger rests here, in ms. */
  pause?: number
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Node {
  text?: string
  type?: string
  id?: string
  enabled?: boolean
  bounds?: Bounds
  children?: Node[]
}

/** Where each defender stands before a play, by position (`1B`, `SS`, …). */
export const DEFENDERS: Record<string, { x: number; z: number }> =
  Object.fromEntries(
    createPlayers().map(player => [player.id, player.position])
  )

/** Why a path through more than two points cannot be drawn. */
export const MULTI_POINT =
  "maestro-d draws a touch from one point to one other (dragAndDrop, swipe); this step's finger turns through several points on one press, which only WebDriverAgent's own actions endpoint takes, and a test may not reach a device's port"

/** Why a finger cannot stay down while the screen is read. */
export const HELD_FINGER =
  'maestro-d releases every touch it starts; this step reads the screen with the finger still down'

export function flatten(node: Node | undefined): Node[] {
  if (node == null) return []
  return [node, ...(node.children ?? []).flatMap(flatten)]
}

export function center(bounds: Bounds): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

/** Whether every point of `points` lies, in order, on the line from the first to the last. */
export function collinear(points: Point[], tolerance = 2): boolean {
  const first = points[0]
  const last = points[points.length - 1]
  const dx = last.x - first.x
  const dy = last.y - first.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return points.every(p => p.x === first.x && p.y === first.y)
  let along = 0
  for (const p of points) {
    const t = ((p.x - first.x) * dx + (p.y - first.y) * dy) / length
    const off = Math.abs((p.x - first.x) * dy - (p.y - first.y) * dx) / length
    if (off > tolerance || t < along - tolerance) return false
    along = t
  }
  return true
}

const round = (p: Point): string => `${Math.round(p.x)},${Math.round(p.y)}`

/**
 * A finger pressed at `points[0]`, held `hold` ms, moved through the rest,
 * and lifted: a tap for one point; a held drag (`dragAndDrop`) when it rests
 * before moving, a swipe when it moves at once. A path that turns blocks,
 * naming `MULTI_POINT`: drawing it straight would be another gesture.
 */
export async function gesture(
  m: any,
  points: Point[],
  hold = 500
): Promise<void> {
  if (points.length === 1) {
    await m.tapOnPoint({
      x: Math.round(points[0].x),
      y: Math.round(points[0].y)
    })
    return
  }
  if (!collinear(points)) throw new BlockedError(MULTI_POINT)
  const from = points[0]
  const to = points[points.length - 1]
  const duration = points
    .slice(1)
    .reduce((sum, p) => sum + (p.duration ?? 850), 0)
  if (hold >= 300) {
    await m.dragAndDrop({
      from: { point: round(from) },
      to: { point: round(to) },
      holdDuration: hold,
      duration
    })
    return
  }
  await m.swipe({
    startX: Math.round(from.x),
    startY: Math.round(from.y),
    endX: Math.round(to.x),
    endY: Math.round(to.y),
    duration
  })
}

export interface FieldGeometry {
  field: Bounds
  /** Where ground point (x, z), `y` up, draws on the phone's screen. */
  project: (x: number, z: number, y?: number) => Point
  /** The centres of the Safe and Out targets for a runner going to `base`. */
  targets: (base: number) => Record<string, Point>
}

/** The field's camera as the scoring screen sets it, over `field`'s bounds. */
export function fieldGeometry(field: Bounds): FieldGeometry {
  const camera = new PerspectiveCamera()
  applyFieldCamera(camera, {
    ...field,
    view: 'home',
    zoom: 1.25,
    tilt: (-11 * Math.PI) / 180,
    heightOffset: 33,
    bottomExtension: 112
  })
  const project = (x: number, z: number, y = 0.7): Point => {
    const p = new Vector3(x, y, z).project(camera)
    return {
      x: field.x + ((p.x + 1) / 2) * field.width,
      y: field.y + ((1 - p.y) / 2) * field.height
    }
  }
  const targets = (base: number): Record<string, Point> => {
    const at = BASES[base % 4]
    const p = project(at.x, at.z, 9)
    const result = runnerTargets(
      { x: p.x - field.x, y: p.y - field.y },
      field.width,
      field.height,
      base
    )
    return Object.fromEntries(
      Object.entries(result).map(([key, rect]) => [
        key,
        {
          x: field.x + rect.x + rect.width / 2,
          y: field.y + rect.y + rect.height / 2
        }
      ])
    )
  }
  return { field, project, targets }
}

export interface PhoneScorer {
  m: any
  world: FixtureManifest
  nodes: () => Promise<Node[]>
  /** The bounds of the first enabled node whose text `pattern` matches. */
  find: (pattern: RegExp) => Promise<Bounds>
  tap: (text: string) => Promise<void>
  visible: (text: string, timeout?: number) => Promise<void>
  absent: (text: string) => Promise<void>
  touch: (point: Point) => Promise<void>
  gesture: (points: Point[], hold?: number) => Promise<void>
  geometry: () => Promise<FieldGeometry>
  orient: (orientation: 'portrait' | 'landscape') => Promise<void>
  /** The screen and its hierarchy, kept in the run directory, numbered. */
  shot: (label: string) => Promise<void>
  log: (message: string) => void
  /**
   * Opens the world's next unscored game at its scoring screen and waits for
   * its first pitch; `restart` quits and opens the browser first. A hint
   * shown over it (its OK) is dismissed unless `dismiss` is false.
   */
  freshGame: (options?: {
    restart?: boolean
    dismiss?: boolean
  }) => Promise<string>
  /** Writes what the scenario did to `steps.txt`. */
  finish: () => void
}

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Signs the browser on the `browser` role's phone out of any earlier run's
 * session, from the account page, which shows the sign-in form when there
 * is none.
 */
async function signedOut(m: any, origin: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await m.openLink({ link: `${origin}/account`, browser: true })
    const out: boolean = await m
      .assertVisible({ text: 'Sign in to TeamStation', timeout: 8000 })
      .then(
        () => true,
        () => false
      )
    if (out) return
    try {
      await m.scrollUntilVisible({
        element: { text: 'Sign out' },
        direction: 'DOWN'
      })
      await m.tapOn({ text: 'Sign out' })
      await pause(3000)
    } catch {
      // Not drawn yet: looked for again.
    }
  }
}

/**
 * Seeds `scoring-preview`, opens the phone's browser, signs its scorer in
 * through the real form, and returns the scorer's hands.
 */
export async function openPhoneScorer(
  ctx: HarnessContext,
  role = 'browser'
): Promise<PhoneScorer> {
  const world = await ctx.fixture('scoring-preview')
  const origin = ctx.stack.origin.replace(/\/+$/, '')
  await clearSignInLimits(ctx)
  const m = await ctx.mobileBrowser(role, `${origin}/account`)
  await signedOut(m, origin)
  await m.openLink({ link: `${origin}/sign-in`, browser: true })
  await ctx.signIn('scorer', m)
  return phoneScorer(ctx, m, world, origin)
}

/** The scorer's hands on a browser already signed in. */
export function phoneScorer(
  ctx: HarnessContext,
  m: any,
  world: FixtureManifest,
  origin: string
): PhoneScorer {
  const report: string[] = []
  let serial = 0
  let played = 0
  const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
  const find = async (pattern: RegExp): Promise<Bounds> => {
    const node = (await nodes()).find(
      n => pattern.test(n.text ?? '') && n.enabled !== false
    )
    if (node?.bounds == null)
      throw new Error(`Missing visible control ${String(pattern)}`)
    return node.bounds
  }
  const log = (message: string): void => {
    report.push(message)
  }
  const tap = async (text: string): Promise<void> => {
    await m.tapOn({ text: `^${text}$`, enabled: true, timeout: 10000 })
  }
  const visible = async (text: string, timeout = 15000): Promise<void> => {
    await m.assertVisible({ text, enabled: true, timeout })
  }
  const absent = async (text: string): Promise<void> => {
    await m.assertNotVisible({ text })
  }
  const shot = async (label: string): Promise<void> => {
    const stem = `${String(++serial).padStart(2, '0')}-${label}`
    await m.takeScreenshot({ path: ctx.artifact(`${stem}.png`) })
    writeFileSync(
      ctx.artifact(`${stem}.json`),
      JSON.stringify(await m.hierarchy(), null, 2)
    )
    log(`Captured ${label}`)
  }
  const { appId } = browserAppOf(ctx.surface)
  return {
    m,
    world,
    nodes,
    find,
    tap,
    visible,
    absent,
    touch: async point => {
      await gesture(m, [point], 80)
    },
    gesture: async (points, hold) => {
      await gesture(m, points, hold)
    },
    geometry: async () => fieldGeometry(await find(/^Baseball field\./)),
    orient: async orientation => {
      await m.setOrientation(orientation)
    },
    shot,
    log,
    freshGame: async (options = {}) => {
      const game = world.ids[`game${++played}`]
      if (game == null)
        throw new Error(`scoring-preview has no game ${played} to open`)
      if (options.restart === true) {
        await m.stopApp({ appId })
        await m.launchApp({ appId })
      }
      await m.openLink({ link: `${origin}/games/${game}/score`, browser: true })
      await visible('^Swing in Play$', 30000)
      if (
        options.dismiss !== false &&
        (await nodes()).some(n => n.text === 'OK')
      )
        await tap('OK')
      return game
    },
    finish: () => {
      writeFileSync(ctx.artifact('steps.txt'), report.join('\n') + '\n')
    }
  }
}

/**
 * Runs `steps` on a fresh scorer, keeping a `failure` screen when a step
 * fails and the steps taken either way.
 */
export async function withPhoneScorer(
  ctx: HarnessContext,
  steps: (scorer: PhoneScorer) => Promise<void>
): Promise<void> {
  const scorer = await openPhoneScorer(ctx)
  try {
    await steps(scorer)
  } catch (error) {
    await scorer.shot('failure').catch(() => undefined)
    throw error
  } finally {
    scorer.finish()
  }
}

/**
 * Places the fielder who took the ball: the pitcher dragged out to the
 * field's middle, then, once the trajectory control waits (it does not move
 * on its own), the trajectory dragged down a little and let go.
 */
export async function fieldAndTrajectory(s: PhoneScorer): Promise<void> {
  await s.visible('Tap or drag a player to where the ball was fielded')
  const g = await s.geometry()
  await s.gesture([
    g.project(0, -18.44, 6),
    { x: g.field.x + g.field.width / 2, y: g.field.y + g.field.height * 0.61 }
  ])
  await s.visible('Drag up and down for ball trajectory')
  await s.shot('trajectory-before-movement')
  await pause(1300)
  await s.shot('trajectory-still-waiting')
  const start = {
    x: g.field.x + g.field.width / 2,
    y: g.field.y + g.field.height * 0.55
  }
  await s.gesture([start, { x: start.x, y: start.y + 35 }])
}

/** Drags the runner on `base` onto the next base's Safe or Out target. */
export async function dragRunner(
  s: PhoneScorer,
  base: number,
  decision: 'safe' | 'out'
): Promise<void> {
  const g = await s.geometry()
  const at = BASES[base]
  await s.gesture([g.project(at.x, at.z, 6), g.targets(base + 1)[decision]])
}

/** Cancels a runner's move: its targets and its reasons are gone. */
export async function cancelRunner(s: PhoneScorer): Promise<void> {
  await s.touch(center(await s.find(/^Cancel$/)))
  await s.absent('^(Safe|Out) drag target$')
  await s.absent('^Runner (advance|out)$')
}

/**
 * Taps a sheet's row once it is in the web view. Safari reports rows
 * scrolled out of sight, even those under its toolbar, so the sheet is
 * scrolled until the row is inside the field's frame first.
 */
export async function tapInSheet(s: PhoneScorer, label: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const g = await s.geometry()
    const node = (await s.nodes()).find(
      n => n.text === label && n.enabled !== false
    )
    if (node?.bounds == null) throw new Error(`Missing sheet row ${label}`)
    const b = node.bounds
    const top = g.field.y + 160
    const bottom = g.field.y + g.field.height - 25
    if (b.y >= top && b.y + b.height / 2 <= bottom) {
      await s.touch(center(b))
      return
    }
    const lower = bottom - 35
    const upper = top + 40
    const x = g.field.x + g.field.width / 2
    await s.gesture(
      [
        { x, y: b.y < top ? upper : lower },
        { x, y: b.y < top ? lower : upper }
      ],
      80
    )
  }
  throw new Error(`Cannot scroll to sheet row ${label}`)
}

/** Puts Player 6, 7 and 8 on first, second and third through Overrides. */
export async function loadBases(s: PhoneScorer): Promise<void> {
  await s.tap('Open scoring menu')
  await s.tap('Overrides')
  for (const [base, name] of [
    ['First base', 'Player 6'],
    ['Second base', 'Player 7'],
    ['Third base', 'Player 8']
  ]) {
    await tapInSheet(s, base)
    await tapInSheet(s, `Choose ${base} ${name}`)
  }
  await tapInSheet(s, 'Apply Override')
}
