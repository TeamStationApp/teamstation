import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  enabled,
  openWebScorer,
  pressControl,
  waitSaved,
  webScorer
} from './webScorer'

type Listener = (request: any) => void

/** A page that answers each `evaluate` from `boxes` in turn, and records listeners. */
function fakePage(boxes: unknown[]): any {
  const listeners = new Map<string, Listener[]>()
  let at = 0
  return {
    listeners,
    evaluated: [] as string[],
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    async evaluate(script: string) {
      this.evaluated.push(script)
      const box = boxes[Math.min(at, boxes.length - 1)]
      at++
      return box
    },
    async waitForFunction() {},
    async evaluateOnNewDocument() {},
    setDefaultTimeout() {}
  }
}

function fakeDevice(): { m: any; steps: unknown[] } {
  const steps: unknown[] = []
  const record =
    (name: string) =>
    async (options: unknown): Promise<void> => {
      steps.push([name, options])
    }
  return {
    steps,
    m: {
      tapOnPoint: record('tapOnPoint'),
      evalBrowserScript: record('evalBrowserScript'),
      openLink: record('openLink'),
      pressKey: record('pressKey'),
      inputText: record('inputText'),
      vars: async () => ({})
    }
  }
}

describe('webScorer', function () {
  this.timeout(10000)

  it('names an enabled control by its label', function () {
    expect(enabled('Ball')).equals(
      '[aria-label="Ball"]:not([aria-disabled="true"]):not(:disabled)'
    )
  })

  it('scrolls a control into view, waits for it to keep still and presses its centre', async function () {
    const { m, steps } = fakeDevice()
    const page = fakePage([
      'scroll',
      null,
      [10, 20, 30, 40],
      [12, 20, 30, 40],
      [12, 20, 30, 40],
      [12, 20, 30, 40],
      [12, 20, 30, 40]
    ])
    await pressControl(m, page, enabled('Ball'), 'Ball')
    expect(steps[0]).deep.include.members(['evalBrowserScript'])
    expect(steps.at(-1)).deep.equals(['tapOnPoint', { x: 27, y: 40 }])
  })

  it('gives up on a control that never shows', async function () {
    const { m } = fakeDevice()
    const error = await pressControl(m, fakePage([null]), 'x', 'Ghost', 300)
      .then(() => undefined)
      .catch((caught: unknown) => caught)
    expect(String(error)).includes('Ghost has no box to press')
  })

  it('acts through maestro-d and counts the API writes still open', async function () {
    const { m, steps } = fakeDevice()
    const page = fakePage([[0, 0, 10, 10]])
    const scorer = webScorer(
      {
        m,
        page,
        deviceClass: 'web',
        resize: async () => {},
        close: async () => {}
      },
      'https://stack.example.test'
    )
    await scorer.go('/games/g1')
    await scorer.key('Escape')
    await scorer.type('Corbin')
    await scorer.click('Ball')
    await scorer.press('[data-testid="x"]')
    await scorer.press('[data-testid="y"]', 'Y')
    expect(typeof scorer.field().tap).equals('function')
    expect(steps.slice(0, 3)).deep.equals([
      ['openLink', { link: 'https://stack.example.test/games/g1' }],
      ['pressKey', { key: 'Escape' }],
      ['inputText', { text: 'Corbin' }]
    ])
    const post = { method: () => 'POST', url: () => 'https://s/api/v1/x' }
    const get = { method: () => 'GET', url: () => 'https://s/api/v1/x' }
    for (const listener of page.listeners.get('request')) {
      listener(post)
      listener(get)
    }
    expect(scorer.writes()).equals(1)
    page.listeners.get('requestfinished')[0](post)
    expect(scorer.writes()).equals(0)
    page.listeners.get('requestfailed')[0](get)
    await waitSaved(scorer)
  })

  it('opens the stack in the runner browser and signs the role in', async function () {
    const { m, steps } = fakeDevice()
    const page = fakePage([])
    const signed: unknown[] = []
    const ctx: any = {
      stack: { origin: 'https://stack.example.test' },
      browser: async (size: unknown, emulation: unknown) => {
        signed.push(['browser', size, emulation])
        return { m, page }
      },
      signIn: async (role: string) => {
        signed.push(['signIn', role])
      }
    }
    const scorer = await openWebScorer(ctx, 'scorer')
    expect(scorer.m).equals(m)
    expect(signed).deep.equals([
      ['browser', { width: 1200, height: 900 }, { observeNetwork: true }],
      ['signIn', 'scorer']
    ])
    expect(steps).deep.equals([
      ['openLink', { link: 'https://stack.example.test/' }]
    ])
  })
})
