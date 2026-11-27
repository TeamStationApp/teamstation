import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { BlockedError } from '../../core/result'
import type { HarnessContext, Surface } from '../../core/spec'
import {
  appKindOf,
  bookReader,
  flat,
  holdRequests,
  listOf,
  literal,
  named,
  type Node,
  openScorer,
  PAGE_TEXT,
  scorerOn,
  signedOut,
  textOf,
  timing,
  until,
  windowOf
} from './scorerSheets'

const box = (
  x: number,
  y: number,
  width = 40,
  height = 20
): Node['bounds'] => ({
  x,
  y,
  width,
  height
})

/** A screen of `nodes` in a window 400 by 800. */
function screen(nodes: Node[]): Node {
  return { type: 'Window', bounds: box(0, 0, 400, 800), children: nodes }
}

/** A device that records each command and shows `screens` in turn, the last kept. */
function device(screens: Node[]): { m: any; steps: unknown[][] } {
  const steps: unknown[][] = []
  let shown = 0
  const record =
    (name: string) =>
    async (...args: unknown[]): Promise<void> => {
      steps.push([name, ...args])
    }
  const m = {
    hierarchy: async () => screens[Math.min(shown++, screens.length - 1)],
    tapOn: record('tapOn'),
    swipe: record('swipe'),
    eraseText: record('eraseText'),
    inputText: record('inputText'),
    pressKey: record('pressKey'),
    openLink: record('openLink'),
    launchApp: record('launchApp'),
    stopApp: record('stopApp'),
    takeScreenshot: record('takeScreenshot'),
    waitForAnimationToEnd: record('waitForAnimationToEnd'),
    extendedWaitUntil: record('extendedWaitUntil'),
    assertVisible: async (options: { text?: string }) => {
      steps.push(['assertVisible', options])
      if (options.text === '^Open$') throw new Error('not asked')
    }
  }
  return { m, steps }
}

const artifact = (name: string): string => `/run/${name}`

describe('scorerSheets', function () {
  let step = 0
  let draw = 0
  beforeEach(function () {
    step = timing.step
    draw = timing.draw
    timing.step = 1
    timing.draw = 20
  })
  afterEach(function () {
    timing.step = step
    timing.draw = draw
  })

  it('reads nodes, names and the window', function () {
    const tree: Node = {
      text: 'a',
      children: [{ accessibilityText: 'b', children: [{ text: 'c' }] }]
    }
    expect(flat(tree).map(textOf)).deep.equals(['a', 'b', 'c'])
    expect(literal('a.b(c)')).equals('a\\.b\\(c\\)')
    expect(appKindOf('android-app')).equals('teamstation-android')
    expect(appKindOf('ios-app')).equals('teamstation-ios')
    expect(windowOf([{ bounds: box(1, 2) }])).deep.equals(box(1, 2))
    expect(windowOf([{ type: 'Window', bounds: box(0, 0, 9, 9) }])).deep.equals(
      box(0, 0, 9, 9)
    )
    expect(() => windowOf([{}])).throws('no bounds')
    const nodes: Node[] = [
      { text: 'Done', bounds: box(0, 0) },
      { id: 'MoreMenuButton', text: 'More', bounds: box(0, 0) },
      { text: 'Mookie Betts, jersey 1', bounds: box(0, 1) },
      { text: 'Undo Ball 1-0', bounds: box(0, 2) },
      { id: 'Settings', bounds: box(0, 3) },
      { text: 'Done' }
    ]
    expect(named(nodes, 'Done')?.bounds).deep.equals(box(0, 0))
    expect(named(nodes, 'More')).equals(undefined)
    expect(named(nodes, 'Mookie Betts')?.bounds).deep.equals(box(0, 1))
    expect(named(nodes, 'Undo Ball')?.bounds).deep.equals(box(0, 2))
    expect(named(nodes, 'Settings')?.bounds).deep.equals(box(0, 3))
    expect(listOf({ games: 'a,b' }, 'games')).deep.equals(['a', 'b'])
    expect(() => listOf({}, 'games')).throws('no games')
  })

  it('finds, taps and waits on what a phone browser page shows', async function () {
    const page: Node = {
      type: 'WebView',
      children: [
        { text: 'Ball', bounds: box(10, 100) },
        { text: 'Undo Ball', bounds: box(10, 200) }
      ]
    }
    const { m, steps } = device([
      screen([{ text: 'Safari' }, page]),
      screen([page])
    ])
    const s = scorerOn(
      m,
      'web-safari-ios',
      'https://stack.example.test',
      artifact
    )
    expect(s.native).equals(false)
    expect(await s.texts()).deep.equals(['Ball', 'Undo Ball'])
    await s.tap('Ball')
    expect(steps).deep.includes(['tapOn', { point: '30,110' }])
    expect(await s.tapStarts('Undo ')).equals('Undo Ball')
    await expectThrow(s.tapStarts('Nothing'), 'starts Nothing')
    await s.shown('^Ball$')
    await s.shown('Ball Undo')
    await s.shown('Undo', 5)
    await expectThrow(s.shown('Absent', 5), 'Not on screen: Absent')
    await s.gone('Absent')
    await expectThrow(s.gone('Ball', 5), 'Still on screen: Ball')
    await s.open('/games/g1/score')
    expect(steps).deep.includes([
      'openLink',
      { link: 'https://stack.example.test/games/g1/score', browser: true }
    ])
    await s.finishKeyboard()
    // Not drawn by name: maestro-d's own match, which Done is not here.
    expect(steps).deep.includes(['tapOn', { text: '^Done$', timeout: 15000 }])
    await s.menu('Settings')
    await s.capture('settings')
    expect(steps).deep.includes([
      'takeScreenshot',
      { path: '/run/web-safari-ios-settings.png' }
    ])
  })

  it('scrolls to a control, types in fields and puts the keyboard away in the app', async function () {
    const low = screen([{ text: 'Save', bounds: box(10, 760) }])
    const field = screen([
      { text: 'Save', bounds: box(10, 300) },
      { text: 'First Name', type: 'TextField', bounds: box(10, 400) },
      { type: 'Keyboard' }
    ])
    const { m, steps } = device([low, low, field])
    const s = scorerOn(m, 'ios-app', 'https://stack.example.test', artifact)
    expect(s.native).equals(true)
    await s.reach('Save')
    expect(steps.filter(row => row[0] === 'swipe')).has.length(1)
    await s.input('First Name', 'Jose')
    expect(steps).deep.includes(['inputText', { text: 'Jose' }])
    await s.input('First Name', '')
    await expectThrow(s.input('Last Name', 'x'), 'No field Last Name')
    await s.finishKeyboard()
    expect(steps.filter(row => row[0] === 'pressKey')).has.length(3)
    await s.open('games/g1/score')
    expect(steps).deep.includes([
      'openLink',
      { link: 'teamstation-develop://games/g1/score' }
    ])
    await expectThrow(s.reach('Absent'), 'Absent never came clear')
  })

  it('accepts the link prompt and finishes a keyboard that is already away', async function () {
    const { m, steps } = device([screen([{ text: 'Open', bounds: box(0, 0) }])])
    const s = scorerOn(m, 'android-app', 'https://stack.example.test', artifact)
    await s.open('games/g1')
    expect(steps).deep.includes(['tapOn', { point: '20,10' }])
    await s.finishKeyboard()
    expect(steps.filter(row => row[0] === 'pressKey')).has.length(0)
    const web = scorerOn(
      m,
      'web-chromium',
      'https://stack.example.test',
      artifact
    )
    expect((await web.nodes()).length).equals(2)
    await web.open('games/g1')
    expect(steps).deep.includes([
      'openLink',
      { link: 'https://stack.example.test/games/g1' }
    ])
  })

  it("reads a browser page's own text when the hierarchy leaves it out", async function () {
    const { m } = device([screen([{ text: 'Open', bounds: box(0, 0) }])])
    const page = {
      evaluate: async (script: string) =>
        script === PAGE_TEXT
          ? 'End Game\nThe open at-bat is saved with its pitches.\nUndo Ball'
          : ''
    }
    const s = scorerOn(
      m,
      'web-chromium',
      'https://stack.example.test',
      artifact,
      { m, page } as any
    )
    await s.shown('The open at-bat is saved with its pitches', 0)
    await s.shown('Undo Ball', 0)
    await expectThrow(s.shown('Nowhere', 0), 'Not on screen: Nowhere')
  })

  it('signs the scorer in on each surface', async function () {
    for (const surface of [
      'web-chromium',
      'web-safari-ios',
      'ios-app'
    ] as Surface[]) {
      const { m, steps } = device([screen([])])
      const signed: unknown[] = []
      const ctx = {
        surface,
        stack: {
          origin: 'https://stack.example.test',
          control: { rateLimits: async () => ({}) }
        },
        artifact,
        browser: async () => ({ m, page: {} }),
        mobileBrowser: async (role: string, url: string) => {
          steps.push(['mobileBrowser', role, url])
          return m
        },
        app: (kind: string) => `id-of-${kind}`,
        attached: () => m,
        signIn: async (role: string) => {
          signed.push(role)
        }
      } as unknown as HarnessContext
      const s = await openScorer(ctx)
      expect(s.surface).equals(surface)
      expect(signed).deep.equals(['scorer'])
      if (surface === 'web-chromium') expect(s.web).not.equals(undefined)
      if (surface === 'web-safari-ios')
        expect(steps).deep.includes([
          'mobileBrowser',
          'phone',
          'https://stack.example.test/sign-in'
        ])
      if (surface === 'ios-app')
        expect(steps).deep.includes([
          'launchApp',
          { appId: 'id-of-teamstation-ios', clearState: true }
        ])
    }
  })

  it('signs a phone browser out of an earlier session before signing in', async function () {
    const steps: unknown[] = []
    let looks = 0
    let scrolls = 0
    const m = {
      openLink: async (options: unknown) => steps.push(['openLink', options]),
      assertVisible: async () => {
        if (++looks < 3) throw new Error('signed in')
      },
      scrollUntilVisible: async () => {
        if (++scrolls === 1) throw new Error('not drawn yet')
      },
      tapOn: async (options: unknown) => steps.push(['tapOn', options])
    }
    await signedOut(m, 'https://stack.example.test')
    expect(steps).deep.equals([
      [
        'openLink',
        { link: 'https://stack.example.test/account', browser: true }
      ],
      [
        'openLink',
        { link: 'https://stack.example.test/account', browser: true }
      ],
      ['tapOn', { text: 'Sign out' }],
      [
        'openLink',
        { link: 'https://stack.example.test/account', browser: true }
      ]
    ])
    const stuck = {
      ...m,
      assertVisible: async () => {
        throw new Error('signed in')
      }
    }
    await expectThrow(
      signedOut(stuck, 'https://stack.example.test'),
      'stays signed in'
    )
  })

  it('reads a book back, holds requests and polls until a value holds', async function () {
    const realFetch = globalThis.fetch
    const asked: string[] = []
    globalThis.fetch = (async (url: URL, init: RequestInit) => {
      asked.push(
        `${String(url)} ${new Headers(init.headers).get('authorization')}`
      )
      return new Response(
        JSON.stringify({ plays: [{ gumbo: { id: 1 } }, { id: 2 }] })
      )
    }) as typeof fetch
    try {
      const ctx = {
        stack: { origin: 'https://stack.example.test' }
      } as unknown as HarnessContext
      let signIns = 0
      const read = bookReader(
        ctx,
        { email: 'scorer@example.test', password: 'x' },
        async base => {
          signIns++
          expect(base).equals('https://stack.example.test/api/v1')
          return 'token'
        }
      )
      expect(await read('g 1')).deep.equals({
        plays: [{ id: 1 }, { id: 2 }],
        currentPlay: null
      })
      await read('g2')
      expect(signIns).equals(1)
      expect(asked[0]).equals(
        'https://stack.example.test/api/v1/games/g%201/events Bearer token'
      )
    } finally {
      globalThis.fetch = realFetch
    }
    const calls: unknown[] = []
    const held = {
      stack: {
        control: {
          call: async (...args: unknown[]) => {
            calls.push(args)
          }
        }
      }
    } as unknown as HarnessContext
    await holdRequests(held, '/api/v1/games/g1/events', 9)
    await holdRequests(held, null)
    expect(calls).deep.equals([
      ['PUT', 'delay', { prefix: '/api/v1/games/g1/events', ms: 9 }],
      ['PUT', 'delay', null]
    ])
    await expectThrow(
      holdRequests({ stack: {} } as unknown as HarnessContext, null),
      'no control routes',
      BlockedError
    )
    let n = 0
    expect(
      await until(
        async () => ++n,
        value => value === 3,
        'three'
      )
    ).equals(3)
    await expectThrow(
      until(
        async () => 0,
        value => value === 1,
        'one',
        5
      ),
      'Timed out waiting for one'
    )
  })
})

async function expectThrow(
  work: Promise<unknown>,
  message: string,
  kind: new (...args: any[]) => Error = Error
): Promise<void> {
  try {
    await work
  } catch (error) {
    expect(error).instanceOf(kind)
    expect(String(error)).contains(message)
    return
  }
  expect.fail(`expected it to throw ${message}`)
}
