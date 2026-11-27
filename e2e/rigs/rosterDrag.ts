import type { Page } from '../core/web'

/* The functions puppeteer runs in the page are transpiled by sucrase, which
   turns ?. and ?? into helpers the page does not have. */

/**
 * A press held and moved on a web page, as a mouse makes it: maestro-d's
 * `evalBrowserScript` sends each step to the element under the point, the
 * moves and the release to the element pressed, as a captured pointer's go.
 * The page is only read, for where things are and when they have moved.
 */

/** The part of a maestro-d web device a press needs. */
export interface PointerDevice {
  evalBrowserScript: (options: { script: string }) => Promise<unknown>
}

export interface Point {
  x: number
  y: number
}

export type PointerPhase = 'down' | 'move' | 'up'

/**
 * The page script for one step of a press at `at`: a pointer event and its
 * mouse event, and on release a click when it ends where it began.
 */
export function pointerScript(phase: PointerPhase, at: Point): string {
  const x = Math.round(at.x)
  const y = Math.round(at.y)
  return `(() => {
  const state = window.__e2ePointer || (window.__e2ePointer = {})
  const under = document.elementFromPoint(${x}, ${y})
  const pressed = state.target != null && state.target.isConnected ? state.target : null
  const target = ${JSON.stringify(phase)} === 'down' ? under : pressed || under || document.body
  if (target == null) throw new Error('Nothing on the page at ${x},${y}')
  const init = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: ${x}, clientY: ${y}, screenX: ${x}, screenY: ${y},
    pointerId: 1, pointerType: 'mouse', isPrimary: true,
    button: ${phase === 'move' ? -1 : 0}, buttons: ${phase === 'up' ? 0 : 1}
  }
  target.dispatchEvent(new PointerEvent('pointer${phase}', init))
  target.dispatchEvent(new MouseEvent('mouse${phase}', Object.assign({}, init, { button: 0 })))
  if (${JSON.stringify(phase)} === 'down') state.target = target
  if (${JSON.stringify(phase)} === 'up') {
    if (under != null && pressed != null && (pressed === under || pressed.contains(under)))
      pressed.dispatchEvent(new MouseEvent('click', Object.assign({}, init, { button: 0 })))
    state.target = null
  }
  return true
})()`
}

export async function pointer(
  m: PointerDevice,
  phase: PointerPhase,
  at: Point
): Promise<void> {
  await m.evalBrowserScript({ script: pointerScript(phase, at) })
}

/** Moves a held press from `from` to `to` in `steps` even steps. */
export async function pointerMove(
  m: PointerDevice,
  from: Point,
  to: Point,
  steps = 12
): Promise<void> {
  for (let step = 1; step <= steps; step++) {
    await pointer(m, 'move', {
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps
    })
  }
}

/** Where on `selector`'s box a press goes: its left, at its top, bottom or middle. */
async function pointOn(
  page: Page,
  selector: string,
  where: 'top' | 'bottom' | 'middle'
): Promise<Point> {
  await page.waitForSelector(selector)
  const r = await page.$eval(selector, node => {
    const box = node.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  })
  return {
    x: r.x + Math.min(40, r.width / 2),
    y:
      where === 'top'
        ? r.y + 8
        : where === 'bottom'
          ? r.y + r.height - 8
          : r.y + r.height / 2
  }
}

/** The centre of `selector`'s box. */
export async function centreOf(page: Page, selector: string): Promise<Point> {
  await page.waitForSelector(selector)
  return await page.$eval(selector, node => {
    const box = node.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })
}

/**
 * Presses the middle of `selector` and holds it while `during` runs, then
 * lets go: a push-to-talk button held while the clip plays.
 */
export async function holdDuring(
  m: PointerDevice,
  page: Page,
  selector: string,
  during: () => Promise<void>
): Promise<void> {
  const at = await centreOf(page, selector)
  await pointer(m, 'move', at)
  await pointer(m, 'down', at)
  try {
    await during()
  } finally {
    await pointer(m, 'up', at)
  }
}

/**
 * A mouse drag of the roster sheet row `source` to the boundary before or
 * after the lineup row `target`: the press is held until the row lifts, and
 * released once the insertion point shows on that edge.
 */
export async function dragLineupRow(
  m: PointerDevice,
  page: Page,
  source: string,
  target: string,
  edge: 'before' | 'after'
): Promise<void> {
  const start = await pointOn(page, source, 'middle')
  await pointer(m, 'move', start)
  await pointer(m, 'down', start)
  let at = start
  const preview = '[data-testid="Roster dragged card"]'
  try {
    await page.waitForSelector(preview, { timeout: 10000 })
    // A lifted lineup row collapses. Measure the destination after the rows
    // below it have moved, just as the scorer sees them during the drag.
    await page.waitForFunction(
      (selector: string) => {
        const row = document.querySelector(selector)
        return (
          row != null &&
          (!row.matches('[data-roster-target^="lineup-"]') ||
            row.getBoundingClientRect().height < 1)
        )
      },
      { timeout: 10000 },
      source
    )
    const end = await pointOn(page, target, edge === 'after' ? 'bottom' : 'top')
    await pointerMove(m, start, end, 1)
    at = end
    await page.waitForFunction(
      (selector: string, edge: string) => {
        const line = document.querySelector<HTMLElement>(
          selector + ' > [aria-label="Lineup insertion point"]'
        )
        return (
          line != null &&
          (edge === 'after' ? line.style.bottom : line.style.top) === '-2px'
        )
      },
      { timeout: 10000 },
      target,
      edge
    )
  } finally {
    await pointer(m, 'up', at)
  }
  await page.waitForSelector(preview, { hidden: true, timeout: 10000 })
}
