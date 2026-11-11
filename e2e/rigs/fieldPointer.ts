/**
 * Scoring on the 3D field the way a scorer does: with a pointer. A fielder is
 * dragged to where the ball was fielded (or tapped where he stands), the
 * trajectory is dragged up or down, and a runner is dragged onto Safe or Out.
 *
 * Players are found in the live scene and projected through the live camera,
 * so a script names a position or a base, never a pixel. The page must have
 * the scene probe installed before it loads (`installSceneProbe`).
 */
import type { Page } from 'puppeteer'

import { BASES, createPlayers } from '../../src/app/field/fieldModel'

/** Where each position stands before a play, from the field's own model. */
const HOME_SPOTS = new Map(
  createPlayers().map(player => [player.id, player.position])
)

/**
 * Keeps React's fiber roots on `window.qaRoots`, through a stand-in for the
 * devtools hook, so the scene and camera can be read from the page.
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

// Page-side, as plain script: a compiled helper is not defined in the page.
// Finds the three.js state, then answers `point(x, y, z)` in page pixels.
const PROJECT = `
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
  if (three == null) throw new Error('No field scene on the page')
  const canvas = three.gl.domElement.getBoundingClientRect()
  three.scene.updateMatrixWorld(true)
  const point = (x, y, z) => {
    const v = three.camera.position.clone().set(x, y, z).project(three.camera)
    return [canvas.x + ((v.x + 1) * canvas.width) / 2, canvas.y + ((1 - v.y) * canvas.height) / 2]
  }
  const players = prefix => {
    const found = []
    three.scene.traverse(object => {
      if (!object.name.startsWith(prefix)) return
      const at = object.getWorldPosition(three.camera.position.clone())
      found.push({ name: object.name, x: at.x, z: at.z })
    })
    return found
  }
`

/** Where `[x, y, z]` in the field's world draws on the page. */
export async function fieldPoint(
  page: Page,
  x: number,
  z: number,
  y = 0
): Promise<[number, number]> {
  return (await page.evaluate(
    `(() => { ${PROJECT}; return point(${x}, ${y}, ${z}) })()`
  )) as [number, number]
}

/** The defender nearest `position`'s usual spot, on the ground and on the page. */
async function fielderNow(
  page: Page,
  position: string
): Promise<{ name: string; x: number; z: number; at: [number, number] }> {
  const spot = HOME_SPOTS.get(position)
  if (spot == null) throw new Error(`No position ${position}`)
  return (await page.evaluate(`(() => {
    ${PROJECT}
    const near = players('player-defense-')
      .map(p => ({ ...p, d: (p.x - ${spot.x}) ** 2 + (p.z - ${spot.z}) ** 2 }))
      .sort((a, b) => a.d - b.d)[0]
    if (near == null) throw new Error('No defender near ${position}')
    return { name: near.name, x: near.x, z: near.z, at: point(near.x, 1, near.z) }
  })()`)) as { name: string; x: number; z: number; at: [number, number] }
}

/**
 * The defender at `position`, once the camera has stopped: the view moves
 * after an outcome is chosen, and a press at a moving point misses him.
 */
export async function fielderAt(
  page: Page,
  position: string
): Promise<{ name: string; x: number; z: number; at: [number, number] }> {
  let last = await fielderNow(page, position)
  for (let tries = 0; tries < 50; tries++) {
    await pause(100)
    const next = await fielderNow(page, position)
    if (
      Math.abs(next.at[0] - last.at[0]) < 1 &&
      Math.abs(next.at[1] - last.at[1]) < 1
    )
      return next
    last = next
  }
  return last
}

/** The runner standing nearest base `base` (1–3), on the page. */
export async function runnerAt(
  page: Page,
  base: number
): Promise<[number, number]> {
  const { x, z } = BASES[base]
  return (await page.evaluate(`(() => {
    ${PROJECT}
    const near = players('player-offense-')
      .map(p => ({ ...p, d: (p.x - ${x}) ** 2 + (p.z - ${z}) ** 2 }))
      .sort((a, b) => a.d - b.d)[0]
    if (near == null || near.d > 36) throw new Error('No runner near base ${base}')
    return point(near.x, 1, near.z)
  })()`)) as [number, number]
}

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A mouse press at `from`, moved in steps to `to`, and released there. */
export async function drag(
  page: Page,
  from: [number, number],
  to: [number, number],
  hold = 0
): Promise<void> {
  await page.mouse.move(...from)
  await page.mouse.down()
  if (hold > 0) await pause(hold)
  await page.mouse.move(...to, { steps: 12 })
  await pause(100)
  await page.mouse.up()
}

/** A press and release at `at`, without moving. */
export async function tap(page: Page, at: [number, number]): Promise<void> {
  await page.mouse.move(...at)
  await page.mouse.down()
  await page.mouse.up()
}

/**
 * Drags the fielder at `position` to where the ball was fielded: `forward`
 * feet towards the outfield (negative is towards home), `right` feet across.
 */
export async function placeFielder(
  page: Page,
  position: string,
  forward = 3,
  right = 0
): Promise<void> {
  const fielder = await fielderAt(page, position)
  const to = await fieldPoint(page, fielder.x + right, fielder.z - forward, 1)
  await drag(page, fielder.at, to)
}

/** Taps the fielder at `position`, taking the ball where he stands. */
export async function tapFielder(page: Page, position: string): Promise<void> {
  await tap(page, (await fielderAt(page, position)).at)
}

/** The angle the trajectory control shows, from the screen's summary. */
export async function shownAngle(page: Page): Promise<number> {
  const text = (await page.evaluate(
    `[...document.querySelectorAll('[aria-live]')].map(n => n.textContent).join(' ')`
  )) as string
  const angle = /(-?\d+)°/.exec(text)
  if (angle == null) throw new Error(`No trajectory angle shown: ${text}`)
  return Number(angle[1])
}

/**
 * Drags the trajectory to `angle` and lets go, which accepts it; with no
 * angle, a tap accepts the one shown. Half a degree a pixel, up for higher.
 */
export async function setTrajectory(page: Page, angle?: number): Promise<void> {
  await page.waitForSelector(
    '[aria-label^="Drag up and down for ball trajectory."]'
  )
  const canvas = (await page.$eval('canvas', node => {
    const r = node.getBoundingClientRect()
    return [r.x + r.width / 2, r.y + r.height / 2]
  })) as [number, number]
  if (angle == null) {
    await tap(page, canvas)
    return
  }
  const up = (angle - (await shownAngle(page))) * 2
  if (up === 0) await tap(page, canvas)
  else await drag(page, canvas, [canvas[0], canvas[1] - up])
}

/**
 * Drags the runner at `base` towards the next base (`next`), back (`back`),
 * or barely at all (`stay`), and drops him on Safe or Out.
 */
export async function dropRunner(
  page: Page,
  base: number,
  decision: 'Safe' | 'Out',
  towards: 'next' | 'stay' | 'back' = 'next'
): Promise<void> {
  const from = await runnerAt(page, base)
  const next = BASES[(towards === 'back' ? base + 3 : base + 1) % 4]
  const along: [number, number] =
    towards === 'stay'
      ? [from[0], from[1] + 8]
      : await fieldPoint(page, next.x, next.z, 1)
  await page.mouse.move(...from)
  await page.mouse.down()
  await page.mouse.move(...along, { steps: 12 })
  const target = `[aria-label="${decision} drag target"]`
  await page.waitForSelector(target, { visible: true })
  const onto = (await page.$eval(target, node => {
    const r = node.getBoundingClientRect()
    return [r.x + r.width / 2, r.y + r.height / 2]
  })) as [number, number]
  await page.mouse.move(...onto, { steps: 6 })
  await pause(100)
  await page.mouse.up()
}
