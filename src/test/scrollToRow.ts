import type { Page } from 'puppeteer'

/** A screen less a little, so that a row between two steps is not skipped. */
const STEP = 0.8
/** A list longer than this many screens is not what a test should be walking. */
const MOST_STEPS = 200

/**
 * Scrolls until `selector` is on the page and returns with it in view. Rows
 * mount near the screen, so a row a browser suite names is not in the page
 * until it has been scrolled to. Walks down from where the page is, then from
 * the top, as a row may be above.
 */
export async function scrollToRow(page: Page, selector: string): Promise<void> {
  const step = async (fromTop: boolean): Promise<boolean> =>
    await page.evaluate(
      (wanted: string, top: boolean, share: number) => {
        const row = document.querySelector(wanted)
        const scroller = [...document.querySelectorAll<HTMLElement>('*')]
          .filter(node => {
            const { overflowY } = getComputedStyle(node)
            return (
              (overflowY === 'auto' || overflowY === 'scroll') &&
              node.scrollHeight > node.clientHeight
            )
          })
          .sort((a, b) => b.clientHeight - a.clientHeight)[0]
        if (row != null) {
          row.scrollIntoView({ block: 'center' })
          return true
        }
        if (scroller == null) return false
        scroller.scrollTop = top
          ? 0
          : scroller.scrollTop + scroller.clientHeight * share
        return false
      },
      selector,
      fromTop,
      STEP
    )
  const settle = async (): Promise<void> => {
    await page.evaluate(
      async () =>
        await new Promise(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        })
    )
  }
  for (const fromTop of [false, true]) {
    if (fromTop) {
      await step(true)
      await settle()
    }
    for (let walked = 0; walked < MOST_STEPS; walked++) {
      if (await step(false)) return
      await settle()
    }
  }
  throw new Error(`No row ${selector} after scrolling the whole page`)
}
