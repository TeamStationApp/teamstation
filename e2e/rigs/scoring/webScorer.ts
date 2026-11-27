import type { HarnessContext, WebSession } from '../../core/spec'
import type { HTTPRequest, Page } from '../../core/web'
import {
  type FieldDriver,
  installSceneProbe,
  maestroDriver
} from '../fieldPointer'

/**
 * The web scoring screen in the runner's own browser, as a scorer works it:
 * every press, drag, key and navigation is a maestro-d command, and the page
 * is only read (where a control is, whether it is still, what the screen and
 * its requests say).
 */
export interface WebScorer {
  m: any
  page: Page
  session: WebSession
  /** Opens `path` on the stack's web build. */
  go: (path: string) => Promise<void>
  /** Presses the visible, enabled control labelled `label`, once it is still. */
  click: (label: string) => Promise<void>
  /** Presses the visible control `css` names, once it is still. */
  press: (css: string, what?: string) => Promise<void>
  /** A key, such as `Escape`, `Enter` or `Backspace`. */
  key: (key: string) => Promise<void>
  /** Types `text` into the focused field. */
  type: (text: string) => Promise<void>
  /** The field, driven through maestro-d. */
  field: () => FieldDriver
  /** Writes to the API this page has sent and not had answered. */
  writes: () => number
}

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** The selector of an enabled control labelled `label`. */
export function enabled(label: string): string {
  return `[aria-label=${JSON.stringify(label)}]:not([aria-disabled="true"]):not(:disabled)`
}

type Box = [number, number, number, number] | null

/**
 * The centre of the last visible match of `css` that a pointer at its centre
 * reaches, or null. Scrolled into view first, as a finger would scroll to it.
 */
const LOCATE = `(css) => {
  const all = Array.from(document.querySelectorAll(css)).reverse()
  for (const node of all) {
    if (!node.checkVisibility()) continue
    const r = node.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const inView = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth
    if (!inView) return 'scroll'
    if (!node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) return null
    return [r.x, r.y, r.width, r.height]
  }
  return null
}`

/** Finds, waits for and presses a control: the part of `WebScorer` under test. */
export async function pressControl(
  m: any,
  page: Pick<Page, 'evaluate'>,
  css: string,
  what: string,
  timeout = 15000
): Promise<void> {
  const end = Date.now() + timeout
  const locate = async (): Promise<Box | 'scroll'> =>
    (await page.evaluate(`(${LOCATE})(${JSON.stringify(css)})`)) as
      Box | 'scroll'
  let box: Box | 'scroll' = null
  for (let still = 0; still < 3;) {
    if (Date.now() > end) throw new Error(`${what} has no box to press`)
    const next = await locate()
    if (next === 'scroll') {
      await m.evalBrowserScript({
        script: `const all = Array.from(document.querySelectorAll(${JSON.stringify(css)})).filter(n => n.checkVisibility()); all[all.length - 1].scrollIntoView({ block: 'nearest' }); return ''`,
        output: 'scrolled'
      })
      still = 0
      box = null
    } else {
      still =
        next != null && JSON.stringify(next) === JSON.stringify(box)
          ? still + 1
          : 0
      box = next
    }
    await pause(100)
  }
  const [x, y, width, height] = box!
  await m.tapOnPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2)
  })
  // Let a sheet's transition finish before its next control is pressed.
  await pause(350)
}

/** A scorer over an open session: what `openWebScorer` hands back. */
export function webScorer(session: WebSession, origin: string): WebScorer {
  const { m, page } = session
  const open = new Set<HTTPRequest>()
  const done = (request: HTTPRequest): void => {
    open.delete(request)
  }
  page.on('request', request => {
    if (request.method() !== 'GET' && request.url().includes('/api/'))
      open.add(request)
  })
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  return {
    m,
    page,
    session,
    go: async path => {
      await m.openLink({ link: `${origin}${path}` })
    },
    click: async label => {
      await pressControl(m, page, enabled(label), label)
    },
    press: async (css, what) => {
      await pressControl(m, page, css, what ?? css)
    },
    key: async key => {
      await m.pressKey({ key })
    },
    type: async text => {
      await m.inputText({ text })
    },
    field: () => maestroDriver(m),
    writes: () => open.size
  }
}

/**
 * The stack's web build in this machine's browser at `size`, the field's
 * scene probe installed, signed in as `role` of a world the scenario
 * seeded, through the real password form.
 */
export async function openWebScorer(
  ctx: HarnessContext,
  role: string,
  size = { width: 1200, height: 900 }
): Promise<WebScorer> {
  const session = await ctx.browser(size, { observeNetwork: true })
  await installSceneProbe(session.page)
  session.page.setDefaultTimeout(15000)
  const scorer = webScorer(session, ctx.stack.origin)
  await scorer.go('/')
  await ctx.signIn(role, session.m)
  return scorer
}

/** No write has been outstanding for half a second, and the screen shows no save. */
export async function waitSaved(scorer: WebScorer): Promise<void> {
  const end = Date.now() + 30000
  for (let quiet = 0; quiet < 5;) {
    if (Date.now() > end) throw new Error('Saves outstanding after 30 s')
    await pause(100)
    quiet = scorer.writes() === 0 ? quiet + 1 : 0
  }
  await scorer.page.waitForFunction(
    () => document.querySelector('[aria-label="Save status"]') == null,
    { timeout: 30000 }
  )
}
