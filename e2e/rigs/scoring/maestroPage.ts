import type { Page } from '../../core/web'
import { type Point, pointer, pointerMove } from '../rosterDrag'

/**
 * A browser page as a scoring test uses it: read through puppeteer, acted
 * on only through maestro-d. A tap on a selector is maestro-d's `tapOn`, a
 * press, a move or a key is a pointer or key event `evalBrowserScript` sends
 * to the page, opening an address is `openLink`, and going offline is
 * `setNetworkConditions`. Anything else that would act on the page through
 * puppeteer throws, naming the maestro-d way.
 */

/** The parts of a maestro-d web device the page acts through. */
export interface ActingDevice {
  tapOn: (options: { css: string; timeout?: number }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  evalBrowserScript: (options: { script: string }) => Promise<unknown>
  setNetworkConditions: (options: { offline: boolean }) => Promise<unknown>
}

/** A key as puppeteer names it, as a page's keyboard event carries it. */
export function keyOf(name: string): {
  key: string
  code: string
  keyCode: number
} {
  if (name === 'Space') return { key: ' ', code: 'Space', keyCode: 32 }
  if (name === 'Enter') return { key: 'Enter', code: 'Enter', keyCode: 13 }
  if (name === 'Escape') return { key: 'Escape', code: 'Escape', keyCode: 27 }
  if (/^[a-z]$/i.test(name))
    return {
      key: name,
      code: `Key${name.toUpperCase()}`,
      keyCode: name.toUpperCase().charCodeAt(0)
    }
  return { key: name, code: name, keyCode: 0 }
}

/** The page script for one key going down or up, on what has the focus. */
export function keyScript(type: 'keydown' | 'keyup', name: string): string {
  const key = keyOf(name)
  return `(() => {
  const target = document.activeElement || document.body
  target.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, Object.assign({ bubbles: true, cancelable: true, composed: true }, ${JSON.stringify(key)})))
  return true
})()`
}

const REFUSED = [
  'setCookie',
  'setRequestInterception',
  'evaluateOnNewDocument',
  'type',
  'tap',
  'hover',
  'focus',
  'select',
  'setOfflineMode',
  'touchscreen'
]

export function maestroPage(page: Page, m: ActingDevice): Page {
  let at: Point = { x: 0, y: 0 }
  const mouse = {
    move: async (x: number, y: number, options: { steps?: number } = {}) => {
      const to = { x, y }
      await pointerMove(m, at, to, options.steps ?? 1)
      at = to
    },
    down: async () => {
      await pointer(m, 'down', at)
    },
    up: async () => {
      await pointer(m, 'up', at)
    },
    click: async (x: number, y: number) => {
      at = { x, y }
      await pointer(m, 'move', at)
      await pointer(m, 'down', at)
      await pointer(m, 'up', at)
    }
  }
  const keyboard = {
    down: async (name: string) => {
      await m.evalBrowserScript({ script: keyScript('keydown', name) })
    },
    up: async (name: string) => {
      await m.evalBrowserScript({ script: keyScript('keyup', name) })
    },
    press: async (name: string) => {
      await keyboard.down(name)
      await keyboard.up(name)
    }
  }
  const acts: Record<string, unknown> = {
    mouse,
    keyboard,
    click: async (selector: string) => {
      await m.tapOn({ css: selector })
    },
    locator: (selector: string) => ({
      click: async () => {
        await page.waitForSelector(selector)
        await m.tapOn({ css: selector })
      }
    }),
    goto: async (url: string) => {
      await m.openLink({ link: url })
      return null
    },
    offline: async (on: boolean) => {
      await m.setNetworkConditions({ offline: on })
    }
  }
  return new Proxy(page, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.hasOwn(acts, prop))
        return acts[prop]
      if (typeof prop === 'string' && REFUSED.includes(prop))
        return () => {
          throw new Error(
            `page.${prop} acts through puppeteer: act through maestro-d (or emulation.beforeLoad) instead`
          )
        }
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

/** The page's own `offline` (`setNetworkConditions`), on a page from `maestroPage`. */
export async function setOffline(page: Page, on: boolean): Promise<void> {
  await (
    page as unknown as { offline: (on: boolean) => Promise<void> }
  ).offline(on)
}

/**
 * Plays a clip into the page's fake microphone (`rigs/fakeMicrophone.ts`),
 * the person speaking: started through maestro-d, and waited for on the
 * page until it has played. Without `wav`, the clip it was installed with.
 */
export async function playClip(
  m: Pick<ActingDevice, 'evalBrowserScript'>,
  page: Page,
  wav?: string,
  timeoutMs = 60_000
): Promise<void> {
  const id = `clip${Math.random().toString(36).slice(2, 10)}`
  await m.evalBrowserScript({
    script: `(() => {
  window.__clipsPlayed = window.__clipsPlayed || {}
  window.__playClip(${wav == null ? '' : JSON.stringify(wav)}).then(
    () => { window.__clipsPlayed[${JSON.stringify(id)}] = 'played' },
    error => { window.__clipsPlayed[${JSON.stringify(id)}] = String(error) }
  )
  return true
})()`
  })
  const handle = await page.waitForFunction(
    (id: string) => {
      const played = (window as any).__clipsPlayed
      return played == null ? undefined : played[id]
    },
    { timeout: timeoutMs },
    id
  )
  const outcome = (await handle.jsonValue()) as string
  if (outcome !== 'played') throw new Error(`The clip did not play: ${outcome}`)
}
