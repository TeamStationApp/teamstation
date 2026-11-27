import { expect } from 'chai'
import { JSDOM } from 'jsdom'
import { describe, it } from 'mocha'

import type { Page } from '../../core/web'
import {
  keyOf,
  keyScript,
  maestroPage,
  playClip,
  setOffline
} from './maestroPage'

function device(): { calls: string[]; m: any } {
  const calls: string[] = []
  return {
    calls,
    m: {
      tapOn: async ({ css }: { css: string }) => calls.push(`tap ${css}`),
      openLink: async ({ link }: { link: string }) =>
        calls.push(`open ${link}`),
      evalBrowserScript: async ({ script }: { script: string }) =>
        calls.push(
          `eval ${/'pointer(\w+)'|"(key\w+)"/.exec(script)?.slice(1).find(Boolean)} ${/elementFromPoint\(([^)]*)\)/.exec(script)?.[1] ?? ''}`.trim()
        ),
      setNetworkConditions: async ({ offline }: { offline: boolean }) =>
        calls.push(`offline ${offline}`)
    }
  }
}

function reading(): { page: Page; seen: string[] } {
  const seen: string[] = []
  const page = {
    title: 'kept',
    waitForSelector: async (selector: string) => {
      seen.push(`wait ${selector}`)
      return {}
    },
    evaluate: async function (this: unknown) {
      seen.push(this === page ? 'evaluate on the page' : 'evaluate elsewhere')
      return 1
    }
  }
  return { page: page as unknown as Page, seen }
}

describe('maestroPage', () => {
  it('reads through the page, bound to it', async () => {
    const { page, seen } = reading()
    const { m } = device()
    const acted = maestroPage(page, m)
    expect(await acted.evaluate(() => 1)).equals(1)
    expect(seen).deep.equals(['evaluate on the page'])
    expect((acted as any).title).equals('kept')
  })

  it('taps, opens and goes offline through maestro-d', async () => {
    const { page, seen } = reading()
    const { m, calls } = device()
    const acted = maestroPage(page, m)
    await acted.click('#a')
    await acted.locator('#b').click()
    expect(await acted.goto('https://pages.example.test/x')).equals(null)
    await setOffline(acted, true)
    await setOffline(acted, false)
    expect(calls).deep.equals([
      'tap #a',
      'tap #b',
      'open https://pages.example.test/x',
      'offline true',
      'offline false'
    ])
    expect(seen).deep.equals(['wait #b'])
  })

  it('moves, presses and clicks the mouse as pointer events', async () => {
    const { page } = reading()
    const { m, calls } = device()
    const acted = maestroPage(page, m)
    await acted.mouse.move(10, 20)
    await acted.mouse.down()
    await acted.mouse.move(10, 40, { steps: 2 })
    await acted.mouse.up()
    await acted.mouse.click(5, 6)
    expect(calls).deep.equals([
      'eval move 10, 20',
      'eval down 10, 20',
      'eval move 10, 30',
      'eval move 10, 40',
      'eval up 10, 40',
      'eval move 5, 6',
      'eval down 5, 6',
      'eval up 5, 6'
    ])
  })

  it('holds and presses keys as keyboard events on what has the focus', async () => {
    const { page } = reading()
    const { m, calls } = device()
    const acted = maestroPage(page, m)
    await acted.keyboard.down('Space')
    await acted.keyboard.up('Space')
    await acted.keyboard.press('Enter')
    expect(calls).deep.equals([
      'eval keydown',
      'eval keyup',
      'eval keydown',
      'eval keyup'
    ])
    expect(keyOf('Space')).deep.equals({ key: ' ', code: 'Space', keyCode: 32 })
    expect(keyOf('Escape').keyCode).equals(27)
    expect(keyOf('k')).deep.equals({ key: 'k', code: 'KeyK', keyCode: 75 })
    expect(keyOf('ArrowUp')).deep.equals({
      key: 'ArrowUp',
      code: 'ArrowUp',
      keyCode: 0
    })
    const dom = new JSDOM('<!doctype html><input id="i">', {
      runScripts: 'outside-only'
    })
    const window = dom.window as any
    const keys: string[] = []
    window.document.body.addEventListener('keydown', (e: any) =>
      keys.push(`${e.type} ${e.code} ${e.target.tagName}`)
    )
    window.eval(keyScript('keydown', 'Space'))
    window.document.getElementById('i').focus()
    window.eval(keyScript('keydown', 'Space'))
    expect(keys).deep.equals(['keydown Space BODY', 'keydown Space INPUT'])
  })

  it('refuses to act through puppeteer', () => {
    const { page } = reading()
    const acted = maestroPage(page, device().m) as any
    for (const name of ['setCookie', 'type', 'setRequestInterception'])
      expect(() => acted[name]()).throws(`page.${name} acts through puppeteer`)
  })
})

describe('playClip', () => {
  function page(outcome: string): { page: Page; waited: unknown[] } {
    const waited: unknown[] = []
    return {
      waited,
      page: {
        waitForFunction: async (_fn: unknown, options: unknown, id: string) => {
          waited.push(options, id)
          return { jsonValue: async () => outcome }
        }
      } as unknown as Page
    }
  }

  it('starts the clip through maestro-d and waits on the page for it to play', async () => {
    const scripts: string[] = []
    const { page: read, waited } = page('played')
    await playClip(
      { evalBrowserScript: async ({ script }) => scripts.push(script) },
      read,
      'UklGRg=='
    )
    expect(scripts[0]).includes('window.__playClip("UklGRg==")')
    const id = /__clipsPlayed\["(clip\w+)"\]/.exec(scripts[0])?.[1]
    expect(waited).deep.equals([{ timeout: 60000 }, id])
  })

  it('plays the installed clip without one, and fails a clip that did not play', async () => {
    const scripts: string[] = []
    await playClip(
      { evalBrowserScript: async ({ script }) => scripts.push(script) },
      page('played').page
    )
    expect(scripts[0]).includes('window.__playClip()')
    let error: unknown
    await playClip(
      { evalBrowserScript: async () => true },
      page('NotAllowedError').page,
      undefined,
      5
    ).catch((caught: unknown) => {
      error = caught
    })
    expect(String(error)).includes('The clip did not play: NotAllowedError')
  })
})
