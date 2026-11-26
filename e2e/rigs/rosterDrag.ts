import type { Page } from 'puppeteer'

/* The functions puppeteer runs in the page are transpiled by sucrase, which
   turns ?. and ?? into helpers the page does not have. */

/**
 * A mouse drag of the roster sheet row `source` to the boundary before or
 * after the lineup row `target`: the press is held until the row lifts, and
 * released once the insertion point shows on that edge.
 */
export async function dragLineupRow(
  page: Page,
  source: string,
  target: string,
  edge: 'before' | 'after'
): Promise<void> {
  const at = async (
    selector: string,
    where: 'top' | 'bottom' | 'middle'
  ): Promise<{ x: number; y: number }> => {
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
  const start = await at(source, 'middle')
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  const preview = '[data-testid="Roster dragged card"]'
  try {
    await page.waitForSelector(preview, { timeout: 10000 })
    // A lifted lineup row collapses. Measure the destination after the rows
    // below it have moved, just as the scorer sees them during the drag.
    await page.waitForFunction(
      selector => {
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
    const end = await at(target, edge === 'after' ? 'bottom' : 'top')
    await page.mouse.move(end.x, end.y)
    await page.waitForFunction(
      (selector, edge) => {
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
    await page.mouse.up()
  }
  await page.waitForSelector(preview, { hidden: true, timeout: 10000 })
}
