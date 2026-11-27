import { expect } from 'chai'
import { JSDOM } from 'jsdom'
import { describe, it } from 'mocha'

import type { Page } from '../core/web'
import {
  centreOf,
  dragLineupRow,
  holdDuring,
  pointer,
  pointerMove,
  pointerScript
} from './rosterDrag'

/** A page with a button and a list, whose `elementFromPoint` names `under`. */
function page(): {
  window: any
  events: string[]
  under: (id: string | null) => void
} {
  const dom = new JSDOM(
    '<!doctype html><body><button id="a">A</button><div id="b"><span id="c"></span></div></body>',
    { runScripts: 'outside-only' }
  )
  const window = dom.window as any
  // jsdom has MouseEvent but no PointerEvent.
  window.PointerEvent = window.MouseEvent
  const events: string[] = []
  for (const id of ['a', 'b', 'c'])
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'mousedown',
      'mousemove',
      'mouseup',
      'click'
    ])
      window.document.getElementById(id).addEventListener(type, (e: any) => {
        if (e.currentTarget === e.target)
          events.push(`${id}:${type}:${e.clientX},${e.clientY}:${e.buttons}`)
      })
  let at: string | null = 'a'
  window.document.elementFromPoint = () =>
    at == null ? null : window.document.getElementById(at)
  return {
    window,
    events,
    under: id => {
      at = id
    }
  }
}

function device(window: any): { evalBrowserScript: any; scripts: string[] } {
  const scripts: string[] = []
  return {
    scripts,
    evalBrowserScript: async ({ script }: { script: string }) => {
      scripts.push(script)
      return window.eval(script)
    }
  }
}

describe('rosterDrag', () => {
  it('presses, moves and releases on the pressed element, clicking when it ends there', async () => {
    const { window, events } = page()
    const m = device(window)
    await pointer(m, 'down', { x: 10.4, y: 20.6 })
    await pointer(m, 'up', { x: 10, y: 21 })
    expect(events).deep.equals([
      'a:pointerdown:10,21:1',
      'a:mousedown:10,21:1',
      'a:pointerup:10,21:0',
      'a:mouseup:10,21:0',
      'a:click:10,21:0'
    ])
  })

  it('sends moves and the release to the pressed element, with no click elsewhere', async () => {
    const { window, events, under } = page()
    const m = device(window)
    await pointer(m, 'down', { x: 0, y: 0 })
    under('c')
    await pointerMove(m, { x: 0, y: 0 }, { x: 0, y: 20 }, 2)
    await pointer(m, 'up', { x: 0, y: 20 })
    expect(events).deep.equals([
      'a:pointerdown:0,0:1',
      'a:mousedown:0,0:1',
      'a:pointermove:0,10:1',
      'a:mousemove:0,10:1',
      'a:pointermove:0,20:1',
      'a:mousemove:0,20:1',
      'a:pointerup:0,20:0',
      'a:mouseup:0,20:0'
    ])
    // A press ended, the next move goes where the pointer is.
    await pointer(m, 'move', { x: 1, y: 1 })
    expect(events.at(-1)).equals('c:mousemove:1,1:1')
  })

  it('moves in twelve steps by default, and fails a press on nothing', async () => {
    const { window, under } = page()
    const m = device(window)
    await pointerMove(m, { x: 0, y: 0 }, { x: 12, y: 0 })
    expect(m.scripts).length(12)
    under(null)
    expect(() => window.eval(pointerScript('down', { x: 5, y: 6 }))).throws(
      'Nothing on the page at 5,6'
    )
  })

  /** A page that answers the drag's reads, recording them. */
  function reader(): { page: Page; seen: string[] } {
    const seen: string[] = []
    const box = { x: 10, y: 100, width: 200, height: 40 }
    const read = {
      waitForSelector: async (selector: string, options?: unknown) => {
        seen.push(
          `wait ${selector}${options == null ? '' : ' ' + JSON.stringify(options)}`
        )
        return {}
      },
      $eval: async (selector: string, fn: (node: any) => unknown) => {
        seen.push(`read ${selector}`)
        return fn({ getBoundingClientRect: () => box })
      },
      waitForFunction: async (
        _fn: unknown,
        _options: unknown,
        ...args: string[]
      ) => {
        seen.push(`until ${args.join(' ')}`)
      }
    }
    return { page: read as unknown as Page, seen }
  }

  it('drags a row to after another once it has lifted, and lets go once the line shows', async () => {
    const { page: read, seen } = reader()
    const scripts: string[] = []
    await dragLineupRow(
      { evalBrowserScript: async ({ script }) => scripts.push(script) },
      read,
      '#from',
      '#to',
      'after'
    )
    expect(scripts.map(s => /'pointer(\w+)'/.exec(s)?.[1])).deep.equals([
      'move',
      'down',
      'move',
      'up'
    ])
    expect(scripts[1]).includes('elementFromPoint(50, 120)')
    expect(scripts[2]).includes('elementFromPoint(50, 132)')
    expect(seen).deep.equals([
      'wait #from',
      'read #from',
      'wait [data-testid="Roster dragged card"] {"timeout":10000}',
      'until #from',
      'wait #to',
      'read #to',
      'until #to after',
      'wait [data-testid="Roster dragged card"] {"hidden":true,"timeout":10000}'
    ])
  })

  it('lets go where it was when the row never lifts, and drags to before at the top', async () => {
    const { page: read } = reader()
    const scripts: string[] = []
    const failing = Object.assign({}, read, {
      waitForSelector: async (selector: string) => {
        if (selector.includes('dragged')) throw new Error('never lifted')
        return {}
      }
    }) as unknown as Page
    let error: unknown
    await dragLineupRow(
      { evalBrowserScript: async ({ script }) => scripts.push(script) },
      failing,
      '#from',
      '#to',
      'before'
    ).catch((caught: unknown) => {
      error = caught
    })
    expect(String(error)).includes('never lifted')
    expect(scripts.at(-1)).includes("'pointerup'")
    expect(scripts.at(-1)).includes('elementFromPoint(50, 120)')
    const top: string[] = []
    await dragLineupRow(
      { evalBrowserScript: async ({ script }) => top.push(script) },
      read,
      '#from',
      '#to',
      'before'
    )
    expect(top[2]).includes('elementFromPoint(50, 108)')
  })

  it('holds the middle of a button while the work runs, and lets go after a failure', async () => {
    const { page: read } = reader()
    const scripts: string[] = []
    const m = {
      evalBrowserScript: async ({ script }: { script: string }) =>
        scripts.push(script)
    }
    expect(await centreOf(read, '#mic')).deep.equals({ x: 110, y: 120 })
    let ran = false
    await holdDuring(m, read, '#mic', async () => {
      ran = true
      expect(scripts.map(s => /'pointer(\w+)'/.exec(s)?.[1])).deep.equals([
        'move',
        'down'
      ])
    })
    expect(ran).equals(true)
    expect(scripts.at(-1)).includes("'pointerup'")
    scripts.length = 0
    await holdDuring(m, read, '#mic', async () => {
      throw new Error('clip failed')
    }).catch(() => undefined)
    expect(scripts.at(-1)).includes("'pointerup'")
  })
})
