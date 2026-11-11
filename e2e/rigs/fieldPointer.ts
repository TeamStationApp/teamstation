/**
 * Scoring on the 3D field the way a scorer does: with a pointer. A fielder is
 * dragged to where the ball was fielded (or tapped where he stands), the
 * trajectory is dragged up or down, and a runner is dragged onto Safe or Out.
 *
 * A player is found by his nameplate, which names where he plays
 * (`data-position`), and the field picks the player whose plate a press
 * lands on. Puppeteer pages and maestro-d devices both drive it.
 */
import type { Page } from 'puppeteer'

import { BASES } from '../../src/app/field/fieldModel'

type Point = [number, number]

/** What the field needs of a browser: a probe, a tap and a drag. */
export interface FieldDriver {
  /** The JSON value of `expression`, evaluated in the page. */
  evaluate: <T>(expression: string) => Promise<T>
  tap: (at: Point) => Promise<void>
  drag: (from: Point, to: Point) => Promise<void>
}

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export function puppeteerDriver(page: Page): FieldDriver {
  return {
    evaluate: async <T>(expression: string) =>
      (await page.evaluate(expression)) as T,
    tap: async at => {
      await page.mouse.move(...at)
      await page.mouse.down()
      await page.mouse.up()
    },
    drag: async (from, to) => {
      await page.mouse.move(...from)
      await page.mouse.down()
      await page.mouse.move(...to, { steps: 12 })
      await pause(100)
      await page.mouse.up()
    }
  }
}

/** The parts of a maestro-d device the field uses. */
export interface MaestroField {
  evalBrowserScript: (options: {
    script: string
    output: string
  }) => Promise<unknown>
  vars: () => Promise<Record<string, string>>
  tapOnPoint: (options: { x: number; y: number }) => Promise<unknown>
  dragAndDrop: (options: {
    from: { point: string }
    to: { point: string }
    duration?: number
  }) => Promise<unknown>
}

export function maestroDriver(m: MaestroField): FieldDriver {
  const point = ([x, y]: Point): string => `${Math.round(x)},${Math.round(y)}`
  return {
    evaluate: async <T>(expression: string) => {
      await m.evalBrowserScript({
        script: `return JSON.stringify(${expression})`,
        output: 'fieldProbe'
      })
      return JSON.parse((await m.vars()).fieldProbe) as T
    },
    tap: async ([x, y]) => {
      await m.tapOnPoint({ x: Math.round(x), y: Math.round(y) })
    },
    drag: async (from, to) => {
      await m.dragAndDrop({
        from: { point: point(from) },
        to: { point: point(to) },
        duration: 600
      })
    }
  }
}

/** Polls `expression` until it is true, or fails with `what`. */
async function until(
  field: FieldDriver,
  expression: string,
  what: string,
  timeout = 15000
): Promise<void> {
  const end = Date.now() + timeout
  while (!(await field.evaluate<boolean>(expression))) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await pause(100)
  }
}

// Page-side, as plain script: the field's three.js state through the scene
// probe's fiber roots, and `project(x, y, z)` in page pixels.
const THREE_STATE = `
  const find = fiber => {
    for (let at = fiber; at != null; at = at.sibling) {
      const value = at.memoizedProps == null ? undefined : at.memoizedProps.value
      const state = value == null || value.getState == null ? undefined : value.getState()
      if (state != null && state.scene != null) return state
      const inner = find(at.child)
      if (inner != null) return inner
    }
    return undefined
  }
  let three
  for (const root of window.qaRoots || []) three = three || find(root.current)
  const project = (x, y, z) => {
    const canvas = three.gl.domElement.getBoundingClientRect()
    const v = three.camera.position.clone().set(x, y, z).project(three.camera)
    return [canvas.x + ((v.x + 1) * canvas.width) / 2, canvas.y + ((1 - v.y) * canvas.height) / 2]
  }
`

/** The pitcher's mound, where the field model stands him. */
const MOUND = { x: 0, z: -18.44 }

/**
 * The centre of the nameplate of whoever plays `position` (P … RF, or R1–R3
 * for a runner at rest), once it stays put: the
 * view moves after an outcome is chosen, and a press at a moving plate
 * misses it. The pitcher wears no plate (the scoreboard names him), so he is
 * found in the scene, on a page with the scene probe.
 */
export async function playerAt(
  field: FieldDriver,
  position: string
): Promise<Point> {
  const selector = JSON.stringify(
    `[data-nameplate][data-position="${position}"]`
  )
  const read =
    position === 'P'
      ? `(() => { ${THREE_STATE}; if (three == null) throw new Error('The pitcher has no nameplate: install the scene probe'); let best; three.scene.traverse(o => { if (!o.name.startsWith('player-defense-')) return; const at = o.getWorldPosition(three.camera.position.clone()); const d = (at.x - ${MOUND.x}) ** 2 + (at.z - ${MOUND.z}) ** 2; if (best == null || d < best.d) best = { d, at } }); return best == null ? null : project(best.at.x, 1, best.at.z) })()`
      : `(() => { const n = document.querySelector(${selector}); if (n == null || getComputedStyle(n).visibility !== 'visible') return null; const r = n.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`
  // A press while players still run to their places is lost to the motion.
  await until(
    field,
    `(() => { const f = document.querySelector('[aria-label="Baseball field"]'); return f != null && f.getAttribute('data-moving') === '' && f.getAttribute('data-presentation') === 'none' })()`,
    'the field to come to rest',
    30000
  )
  try {
    await until(field, `${read} != null`, `the ${position} nameplate`)
  } catch (error) {
    const shown = await field.evaluate<string>(
      `[...document.querySelectorAll('[data-nameplate]')].map(n => n.getAttribute('data-position') + ' ' + n.getAttribute('data-nameplate') + ' ' + getComputedStyle(n).visibility).join('; ')`
    )
    throw new Error(`${String(error)}; plates: ${shown}`)
  }
  let last = await field.evaluate<Point>(read)
  for (let tries = 0; tries < 50; tries++) {
    await pause(100)
    const next = await field.evaluate<Point>(read)
    if (Math.abs(next[0] - last[0]) < 1 && Math.abs(next[1] - last[1]) < 1)
      return next
    last = next
  }
  return last
}

/**
 * Drags the fielder at `position` to where the ball was fielded: `up` pixels
 * up the screen, towards the outfield (negative is towards home), and
 * `right` pixels across.
 */
export async function placeFielder(
  field: FieldDriver,
  position: string,
  up = 12,
  right = 0
): Promise<void> {
  const from = await playerAt(field, position)
  await field.drag(from, [from[0] + right, from[1] - up])
}

/** Taps the fielder at `position`, taking the ball where he stands. */
export async function tapFielder(
  field: FieldDriver,
  position: string
): Promise<void> {
  await field.tap(await playerAt(field, position))
}

const TRAJECTORY = `document.querySelector('[aria-label^="Drag up and down for ball trajectory."]') != null`

/** The angle the trajectory control shows, from the screen's summary. */
export async function shownAngle(field: FieldDriver): Promise<number> {
  const text = await field.evaluate<string>(
    `[...document.querySelectorAll('[aria-live]')].map(n => n.textContent).join(' ')`
  )
  const angle = /(-?\d+)°/.exec(text)
  if (angle == null) throw new Error(`No trajectory angle shown: ${text}`)
  return Number(angle[1])
}

/**
 * Drags the trajectory to `angle` and lets go, which accepts it; with no
 * angle, a tap accepts the one shown. Half a degree a pixel, up for higher.
 */
export async function setTrajectory(
  field: FieldDriver,
  angle?: number
): Promise<void> {
  await until(field, TRAJECTORY, 'the trajectory control')
  const centre = await field.evaluate<Point>(
    `(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`
  )
  const up = angle == null ? 0 : (angle - (await shownAngle(field))) * 2
  if (up === 0) await field.tap(centre)
  else await field.drag(centre, [centre[0], centre[1] - up])
}

/**
 * Keeps React's fiber roots on `window.qaRoots`, through a stand-in for the
 * devtools hook, so `dropRunner` can read where the bases draw.
 */
export async function installSceneProbe(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(`(() => {
    window.qaRoots = []
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject() { return 1 },
      onCommitFiberRoot(_id, root) {
        if (!window.qaRoots.includes(root)) window.qaRoots.push(root)
      },
      onCommitFiberUnmount() {}
    }
  })()`)
}

/** Where ground point (x, z), `y` up, draws on the page, through the live camera. */
async function groundPoint(
  page: Page,
  x: number,
  z: number,
  y = 0
): Promise<Point> {
  return (await page.evaluate(`(() => {
    ${THREE_STATE}
    if (three == null) throw new Error('No field scene: install the scene probe')
    return project(${x}, ${y}, ${z})
  })()`)) as Point
}

/** Where the runner standing nearest base `base` draws, through the scene probe. */
async function runnerAt(page: Page, base: number): Promise<Point> {
  const { x, z } = BASES[base]
  return (await page.evaluate(`(() => {
    ${THREE_STATE}
    if (three == null) throw new Error('No field scene: install the scene probe')
    let best
    three.scene.traverse(o => {
      if (!o.name.startsWith('player-offense-')) return
      const at = o.getWorldPosition(three.camera.position.clone())
      const d = (at.x - ${x}) ** 2 + (at.z - ${z}) ** 2
      if (best == null || d < best.d) best = { d, at }
    })
    if (best == null || best.d > 36) throw new Error('No runner near base ${base}')
    return project(best.at.x, 1, best.at.z)
  })()`)) as Point
}

/**
 * Drags the runner standing at `base` (1–3) towards the next base (`next`)
 * or back (`back`), or holds him where he is (`stay`), and drops him on Safe
 * or Out.
 * Runners wear no plates in a play, so the page needs the scene probe
 * (`installSceneProbe`).
 */
export async function dropRunner(
  page: Page,
  base: number,
  decision: 'Safe' | 'Out',
  towards: 'next' | 'stay' | 'back' = 'next'
): Promise<void> {
  const from = await runnerAt(page, base)
  const next = BASES[(towards === 'back' ? base + 3 : base + 1) % 4]
  await page.mouse.move(...from)
  await page.mouse.down()
  if (towards === 'stay') {
    // Held still, he is put out (or kept safe) on the base he stands on.
    await pause(500)
  } else {
    const along = await groundPoint(page, next.x, next.z)
    await page.mouse.move(...along, { steps: 12 })
  }
  const target = `[aria-label="${decision} drag target"]`
  await page.waitForSelector(target, { visible: true })
  const onto = (await page.$eval(target, node => {
    const r = node.getBoundingClientRect()
    return [r.x + r.width / 2, r.y + r.height / 2]
  })) as Point
  await page.mouse.move(...onto, { steps: 6 })
  await pause(100)
  await page.mouse.up()
}
