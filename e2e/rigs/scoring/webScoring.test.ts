import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { BlockedError } from '../../core/result'
import type { HarnessContext } from '../../core/spec'
import {
  acts,
  addPlaceholders,
  artifactDir,
  captureScene,
  click,
  cssColor,
  dragRunner,
  fieldOf,
  game,
  gestureCommand,
  Ids,
  keyName,
  offLine,
  open,
  overrideBases,
  projectBase,
  readGuide,
  revived,
  run,
  runnerNearBase,
  scenarioName,
  scoring,
  server,
  startScoring,
  suite,
  tapSettled,
  unexpectedWrite,
  waitReady,
  waitRunnerNearBase
} from './webScoring'

const WORLD = {
  world: 'scoring-field',
  nonce: 'n1',
  accounts: {
    scorer: {
      role: 'scorer',
      email: 'scorer@example.test',
      password: 'secret',
      userId: 'usr_scorer',
      displayName: 'Alex Cora'
    }
  },
  ids: {
    game: 'gam_real',
    awayTeam: 'tea_away',
    homeTeam: 'tea_home',
    awayUser1: 'usr_a1',
    awayUser2: 'usr_a2',
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        [`away${i + 1}`, String(5000 + i + 1)],
        [`home${i + 1}`, String(6000 + i + 1)]
      ]).flat()
    )
  }
}

type Call = [string, unknown]

/** A handle the fake page answers, at a box, visible or not. */
function handle(calls: Call[], visible = true): any {
  return {
    boundingBox: async () => ({ x: 10, y: 20, width: 30, height: 40 }),
    isVisible: async () => visible,
    evaluate: async (fn: unknown) => {
      calls.push(['handle.evaluate', String(fn)])
      return 'read'
    }
  }
}

/** The page puppeteer reads: it records what it is asked, and answers. */
function fakePage(calls: Call[], answers: Record<string, unknown> = {}): any {
  const listeners: Record<string, Array<(item: any) => void>> = {}
  const page: any = {
    listeners,
    $: async (selector: string) => {
      calls.push(['$', selector])
      return answers[`$ ${selector}`] === null ? null : handle(calls)
    },
    $$: async (selector: string) => {
      calls.push(['$$', selector])
      return [handle(calls, false), handle(calls)]
    },
    $eval: async (selector: string, fn: unknown, ...args: unknown[]) => {
      calls.push(['$eval', [selector, args]])
      return answers.$eval ?? { x: 0, y: 0, width: 400, height: 300 }
    },
    $$eval: async (selector: string, _fn: unknown, ...args: unknown[]) => {
      calls.push(['$$eval', [selector, args]])
      return ['gam_real']
    },
    evaluate: async (fn: unknown, ...args: unknown[]) => {
      calls.push(['evaluate', [String(fn).slice(0, 60), args]])
      return answers.evaluate ?? '/games/gam_real/score'
    },
    waitForSelector: async (selector: string) => {
      calls.push(['waitForSelector', selector])
      return handle(calls)
    },
    waitForFunction: async (
      fn: unknown,
      _options: unknown,
      ...args: unknown[]
    ) => {
      calls.push(['waitForFunction', [String(fn).slice(0, 40), args]])
      return true
    },
    waitForResponse: async (match: (response: any) => boolean) => {
      const response = {
        url: () => 'https://stack.example.test/api/v1/games/gam_real/events',
        request: () => request('POST', '/api/v1/games/gam_real/events'),
        json: async () => ({ id: 'gam_real' })
      }
      expect(match(response)).equals(true)
      return response
    },
    waitForNavigation: async () => undefined,
    on: (event: string, listener: (item: any) => void) => {
      ;(listeners[event] ??= []).push(listener)
    },
    once: (event: string, listener: (item: any) => void) => {
      ;(listeners[event] ??= []).push(listener)
    },
    url: () => 'https://stack.example.test/games/gam_real/score',
    content: async () => '<p>gam_real</p>',
    evaluateOnNewDocument: async (script: string) => {
      calls.push(['evaluateOnNewDocument', script.slice(0, 20)])
    },
    setDefaultTimeout: (ms: number) => {
      calls.push(['setDefaultTimeout', ms])
    }
  }
  return page
}

function request(method: string, path: string, body?: string): any {
  return {
    url: () => `https://stack.example.test${path}`,
    method: () => method,
    fetchPostData: async () => body,
    headers: () => ({})
  }
}

/** A maestro-d device that records its commands; `evalBrowserScript` answers `value`. */
function fakeDevice(calls: Call[], value = 'null'): any {
  const command =
    (name: string) =>
    async (options: unknown): Promise<undefined> => {
      calls.push([name, options])
      return undefined
    }
  return {
    tapOnPoint: command('tapOnPoint'),
    dragAndDrop: command('dragAndDrop'),
    pressKey: command('pressKey'),
    inputText: command('inputText'),
    openBrowser: command('openBrowser'),
    setCookies: command('setCookies'),
    back: command('back'),
    takeScreenshot: command('takeScreenshot'),
    evalBrowserScript: command('evalBrowserScript'),
    vars: async () => ({ scoringEval: value, fieldProbe: '[1,2]' })
  }
}

interface Fixture {
  ctx: HarnessContext
  calls: Call[]
  sql: Array<[string, unknown[]]>
  faults: Array<string | null>
  degraded: string[]
  page: any
  m: any
}

function fixture(
  options: {
    answers?: Record<string, unknown>
    control?: boolean
    fault?: boolean
    value?: string
  } = {}
): Fixture {
  const calls: Call[] = []
  const sql: Array<[string, unknown[]]> = []
  const faults: Array<string | null> = []
  const degraded: string[] = []
  const page = fakePage(calls, options.answers)
  const m = fakeDevice(calls, options.value)
  const ctx = {
    runDir: '/private/tmp/agent-scratch-501/e2eInfraSplit/m6/B/run',
    stack: {
      origin: 'https://stack.example.test',
      ...(options.fault === false
        ? {}
        : {
            setFault: async (fault: string | null) => {
              faults.push(fault)
            }
          }),
      ...(options.control === false
        ? {}
        : {
            control: {
              sql: async (text: string, values: unknown[] = []) => {
                sql.push([text, values])
                return { rows: [{ gumbo_id: 4999 }], rowCount: 1 }
              },
              rateLimits: async () => ({})
            }
          })
    },
    fixture: async () => WORLD,
    browser: async () => ({
      m,
      page,
      deviceClass: 'chromium',
      resize: async (size: unknown) => {
        calls.push(['resize', size])
      },
      close: async () => {
        calls.push(['close', null])
      }
    }),
    degrade: (reason: string) => degraded.push(reason)
  } as unknown as HarnessContext
  return { ctx, calls, sql, faults, degraded, page, m }
}

const realFetch = globalThis.fetch

/** The API the scorer reads: each path's answer. */
function api(answers: Record<string, unknown>): void {
  globalThis.fetch = (async (url: URL) => {
    const path = new URL(url).pathname.replace('/api/v1', '')
    return new Response(JSON.stringify(answers[path] ?? {}), { status: 200 })
  }) as typeof fetch
}

/** Runs `body` as a scenario on the fixture, its scorer signed in by stand-in. */
async function within(f: Fixture, body: () => Promise<void>): Promise<void> {
  await run(f.ctx, async function () {
    scoring().signIn = async () => 'token-1'
    await body()
  })
}

describe('webScoring', function () {
  afterEach(function () {
    globalThis.fetch = realFetch
  })

  it('names scenarios from titles, once each', async function () {
    expect(scenarioName('Keeps “More” halves at 320px!')).equals(
      'keeps-more-halves-at-320px'
    )
    const { add, scenarios } = suite()
    let ran = 0
    add('Does a thing', async () => {
      ran++
    })
    add('does a thing', async function () {
      this.timeout(10)
      ran++
    })
    add('skips', async function () {
      this.skip()
    })
    expect(Object.keys(scenarios)).deep.equals([
      'does-a-thing',
      'does-a-thing-2',
      'skips'
    ])
    const f = fixture()
    await scenarios['does-a-thing'](f.ctx)
    await scenarios['does-a-thing-2'](f.ctx)
    expect(ran).equals(2)
    const skipped = await scenarios.skips(f.ctx as any).catch((e: unknown) => e)
    expect(skipped).instanceOf(BlockedError)
    expect(() => scoring()).throws('No scoring scenario is running')
    expect(game.awayTeamName).equals('Owls')
  })

  it('turns the tests’ ids into the world’s and back', function () {
    const ids = new Ids(WORLD, '4999')
    expect(ids.of('g1')).equals('gam_real')
    expect(ids.of('nobody')).equals('nobody')
    expect(ids.nameOf('tea_home')).equals('home')
    expect(ids.nameOf('x')).equals('x')
    expect(
      ids.in(
        `/games/g1/score '/teams/away/roster' "g1" key:100: [data-roster-player="101"] '209'`
      )
    ).equals(
      `/games/gam_real/score '/teams/tea_away/roster' "gam_real" key:4999: [data-roster-player="5001"] '6009'`
    )
    expect(
      ids.out(
        '/games/gam_real/teams/tea_home "id":5001, "5002" k:4999: tea_away'
      )
    ).equals('/games/g1/teams/home "id":101, "102" k:100: away')
    expect(ids.value('/games/gam_real')).equals('/games/g1')
    expect(ids.value({ a: ['gam_real'] })).deep.equals({ a: ['g1'] })
    expect(ids.value(3)).equals(3)
    expect(ids.value(null)).equals(null)
    const cyclic: any = {}
    cyclic.self = cyclic
    expect(ids.value(cyclic)).equals(cyclic)
    const plain = (): string => 'nothing'
    expect(revived(plain, ids)).equals(plain)
    const named = revived(() => '/games/g1', ids) as () => string
    expect(named()).equals('/games/gam_real')
    expect(revived('location.pathname', ids)).equals('location.pathname')
  })

  it('tells a page script that acts from one that reads', function () {
    expect(acts('n => n.click()')).equals(true)
    expect(acts('() => history.back()')).equals(true)
    expect(acts('n => n.getAttribute("x")')).equals(false)
  })

  it('names maestro-d keys, and blocks one it lacks', function () {
    expect(keyName('ArrowDown')).equals('arrow_down')
    expect(keyName(' ')).equals('space')
    expect(() => keyName('F13')).throws(BlockedError)
  })

  it('makes a press a tap, a long press, a straight drag, or blocks a bent one', function () {
    const at = (
      x: number,
      y: number,
      t: number
    ): { x: number; y: number; at: number } => ({ x, y, at: t })
    expect(gestureCommand([at(1.2, 2.6, 0)], 100)).deep.equals({
      tap: { x: 1, y: 3 }
    })
    expect(gestureCommand([at(1, 2, 0)], 1100)).deep.equals({
      drag: {
        from: { point: '1,2' },
        to: { point: '1,2' },
        holdDuration: 1100,
        duration: 50
      }
    })
    expect(
      gestureCommand([at(0, 0, 0), at(50, 0, 400), at(100, 0, 600)], 650)
    ).deep.equals({
      drag: {
        from: { point: '0,0' },
        to: { point: '100,0' },
        holdDuration: 400,
        duration: 250
      }
    })
    expect(() =>
      gestureCommand([at(0, 0, 0), at(50, 80, 100), at(100, 0, 200)], 300)
    ).throws(BlockedError, 'straight line')
    expect(offLine(at(5, 5, 0), at(0, 0, 0), at(0, 0, 0))).closeTo(7.07, 0.01)
  })

  it('counts only writes that are no save as unexpected', function () {
    expect(unexpectedWrite('GET', '/api/v1/games/g')).equals(false)
    expect(unexpectedWrite('POST', '/assets/x')).equals(false)
    expect(unexpectedWrite('POST', '/api/v1/games/g/events')).equals(false)
    expect(unexpectedWrite('POST', '/api/v1/analytics/events')).equals(false)
    expect(unexpectedWrite('POST', '/api/v1/teams/t/roster-players')).equals(
      false
    )
    expect(unexpectedWrite('DELETE', '/api/v1/games/g')).equals(true)
  })

  it('opens the page on a fresh world, signed in by cookie, and reads the server', async function () {
    const f = fixture()
    api({
      '/auth/me': { id: 'usr_scorer' },
      '/games/gam_real/events': {
        currentPlay: { count: { balls: 2, strikes: 0, outs: 0 } }
      },
      '/games/gam_real': { homeTeamId: 'tea_away', generation: 2 },
      '/teams/tea_away/roster': [
        { userId: 'usr_a1', shortName: 'Jordan K.' },
        { userId: 'usr_new', shortName: 'Mookie B' }
      ]
    })
    await within(f, async () => {
      server.awayTeamName('Demo Hawks')
      expect(server.awayTeamNameNow()).equals('Demo Hawks')
      server.hiddenOpponent(true)
      await server.refuseSaves(true)
      const opened = await open('/games/g1/score', 3, false, false, 'left')
      expect(f.calls).deep.include([
        'openBrowser',
        { url: 'https://stack.example.test/games/gam_real/score' }
      ])
      const cookie = f.calls.find(([name]) => name === 'setCookies')!
      expect(JSON.stringify(cookie[1])).contains('"value":"token-1"')
      expect(f.sql.map(([text]) => text.split(' ')[0])).deep.equals([
        'select',
        'update',
        'update',
        'update',
        'delete',
        'delete',
        'delete'
      ])
      expect(await opened.serverCount()).deep.equals({
        balls: 2,
        strikes: 0,
        outs: 0
      })
      expect(await opened.serverSides()).deep.equals({
        swapped: true,
        generation: 2
      })
      expect(
        (await opened.createdPlayers('away')).map(entry => entry.shortName)
      ).deep.equals(['Mookie B'])
      for (const listener of f.page.listeners.request) {
        listener(request('GET', '/assets/app.js'))
        listener(request('GET', '/api/v1/games/gam_real?x=1'))
        listener(request('DELETE', '/api/v1/teams/tea_home'))
      }
      expect(opened.requests).deep.equals([
        'GET /api/v1/games/g1?x=1',
        'DELETE /api/v1/teams/home'
      ])
      expect(opened.unexpected).deep.equals(['DELETE /api/v1/teams/home'])
      await server.refuseSaves(false)
      await server.refuseSaves(false)
      expect(f.sql.filter(([text]) => text.startsWith('insert'))).length(2)
      const missing = await open('/games/g1', false, true)
      expect(missing.page).not.equals(undefined)
      expect(f.calls).deep.include([
        'openBrowser',
        { url: 'https://stack.example.test/games/gam_missing' }
      ])
      expect(artifactDir()).equals(f.ctx.runDir)
    })
    expect(f.calls.filter(([name]) => name === 'close')).length(2)
  })

  it('blocks what the stack cannot be: a failed roster, logos, live video, no database', async function () {
    const f = fixture()
    await within(f, async () => {
      for (const args of [
        [false, false, true],
        [false, false, false, 'switch', false, 'valid'],
        [false, false, false, 'switch', false, undefined, true]
      ] as const) {
        const error = await (open as any)('/games/g1', ...args).catch(
          (caught: unknown) => caught
        )
        expect(error).instanceOf(BlockedError)
      }
    })
    const bare = fixture({ control: false, fault: false })
    await within(bare, async () => {
      expect(await open('/games/g1').catch((e: unknown) => e)).instanceOf(
        BlockedError
      )
      expect(await server.offline(true).catch((e: unknown) => e)).instanceOf(
        BlockedError
      )
      globalThis.fetch = async () => new Response('{}', { status: 500 })
      expect(
        await scoring()
          .api('/x')
          .catch((e: unknown) => e)
      ).instanceOf(Error)
    })
  })

  it('holds the API with the fault server while offline, stalled or holding saves', async function () {
    const f = fixture()
    await within(f, async () => {
      await server.offline(true)
      await server.stall(true)
      await server.offline(false)
      await server.stall(false)
      await server.holdSaves(true)
    })
    expect(f.faults).deep.equals([
      'api-hang',
      'api-hang',
      'api-hang',
      null,
      'api-hang',
      null
    ])
  })

  it('acts through maestro-d and reads through the page', async function () {
    const f = fixture({ value: '"gam_real"' })
    api({ '/auth/me': {} })
    await within(f, async () => {
      const { page } = await open('/games/g1/score')
      const p: any = page
      await p.mouse.click(5, 6)
      await p.mouse.move(10, 10)
      await p.mouse.down()
      await p.mouse.move(60, 10)
      await p.mouse.up()
      await p.mouse.up()
      await p.touchscreen.tap(1, 1)
      await p.touchscreen.touchStart(1, 1)
      await p.touchscreen.touchMove(1, 1)
      await p.touchscreen.touchEnd()
      await p.touchscreen.touchEnd()
      expect(f.degraded).length(1)
      await p.keyboard.press('Enter')
      await p.keyboard.type('Mookie')
      await p.focus('[aria-label="First"]')
      await p.click('[aria-label="Ball"]')
      await p.goto('/games/g1')
      await p.goBack()
      await p.reload()
      await p.setViewport({ width: 390, height: 844 })
      await p.addStyleTag({ content: 'a{}' })
      await p.screenshot({ path: '/elsewhere/shot.png' })
      await p.screenshot()
      await p.bringToFront()
      await p.emulateCPUThrottling(4)
      await p.close()
      expect(() => p.browserContext()).throws(BlockedError)
      expect(() => p.on('dialog', () => undefined)).throws(BlockedError)
      expect(() => p.once('dialog', () => undefined)).throws(BlockedError)
      p.once('close', () => undefined)
      const seen: string[] = []
      p.on('request', (item: any) => seen.push(item.url()))
      f.page.listeners.request.at(-1)(request('GET', '/games/gam_real'))
      expect(seen).deep.equals(['https://stack.example.test/games/g1'])
      expect(p.url()).equals('https://stack.example.test/games/g1/score')
      expect(await p.content()).equals('<p>g1</p>')
      p.setDefaultTimeout(5)
      // Reads go to the page, with the ids turned.
      expect(await p.evaluate(() => location.pathname)).equals(
        '/games/g1/score'
      )
      expect(await p.evaluate('location.pathname')).equals('/games/g1/score')
      expect(
        await p.$eval('[data-roster-player="101"]', (n: any) => n.id, '101')
      ).deep.equals({ x: 0, y: 0, width: 400, height: 300 })
      expect(f.calls).deep.include([
        '$eval',
        ['[data-roster-player="5001"]', ['5001']]
      ])
      expect(await p.$$eval('a', (nodes: any) => nodes.length)).deep.equals([
        'g1'
      ])
      // A page script that acts goes through maestro-d.
      expect(
        await p.evaluate(() => {
          history.back()
        })
      ).equals('g1')
      expect(await p.evaluate('history.back()')).equals('g1')
      expect(await p.$eval('a', (n: any) => n.click(), 1)).equals('g1')
      expect(await p.$$eval('a', (n: any) => n[0].click())).equals('g1')
      await p.waitForFunction(() => true, {}, 'g1')
      const response = await p.waitForResponse(
        (r: any) =>
          String(r.url()).endsWith('/games/g1/events') &&
          String(r.request().url()).endsWith('/games/g1/events')
      )
      expect(await response.json()).deep.equals({ id: 'g1' })
      expect(await response.request().fetchPostData()).equals(undefined)
      const handle = await p.$('[aria-label="Undo"]')
      await handle.click()
      await handle.tap()
      await handle.hover()
      await handle.focus()
      await handle.type('x')
      await handle.press('Escape')
      await handle.asLocator().click()
      expect(await handle.isVisible()).equals(true)
      expect(await handle.evaluate((n: any) => n.getAttribute('x'))).equals(
        'read'
      )
      expect(await handle.evaluate((n: any) => n.click())).equals('g1')
      expect(await p.$$('a')).length(2)
      expect(await p.waitForSelector('a')).not.equals(null)
      // A read in the middle of a drag is blocked.
      await p.mouse.down()
      for (const read of ['$', 'waitForSelector', 'evaluate']) {
        expect(await p[read]('a').catch((e: unknown) => e)).instanceOf(
          BlockedError
        )
      }
      await p.mouse.up()
      expect(fieldOf(page)).not.equals(undefined)
      expect(() => fieldOf({} as any)).throws('No scoring page')
    })
    const names = f.calls.map(([name]) => name)
    for (const name of [
      'tapOnPoint',
      'dragAndDrop',
      'pressKey',
      'inputText',
      'back',
      'resize',
      'takeScreenshot',
      'evalBrowserScript'
    ])
      expect(names).includes(name)
  })

  it('drives the scoring screen’s steps', async function () {
    const f = fixture({ value: 'null', answers: { evaluate: true } })
    api({ '/auth/me': {} })
    await within(f, async () => {
      const { page } = await open('/games/g1/score')
      await click(page, 'Create Player')
      await click(page, 'Ball')
      await startScoring(page)
      await waitReady(page)
      await tapSettled(page, 'Done')
      await overrideBases(page, [])
      await overrideBases(page, [['First base', 'Player 6']])
      await addPlaceholders(page, 16)
      await addPlaceholders(page, 1)
      const point = await projectBase(page, 1)
      expect(point[0]).a('number')
      await captureScene(page)
      expect(await runnerNearBase(page, 1)).equals(true)
      await waitRunnerNearBase(page, 1)
      await dragRunner(page, 1, 2)
      await (page as any).touchscreen.touchEnd()
      expect(cssColor('#ff8000')).equals('rgb(255, 128, 0)')
      expect(cssColor('#ff800080')).equals('rgba(255, 128, 0, 0.5)')
    })
    const guide = fixture({
      answers: { evaluate: { bearing: 3, x: 1, z: 2 } }
    })
    api({ '/auth/me': {} })
    await within(guide, async () => {
      const { page } = await open('/games/g1/score')
      expect(await readGuide(page)).deep.equals({ bearing: 3, x: 1, z: 2 })
    })
    const nobody = fixture({ answers: { evaluate: false } })
    await within(nobody, async () => {
      const { page } = await open('/games/g1/score')
      this.timeout(20000)
      expect(
        await waitRunnerNearBase(page, 2).catch(
          (e: unknown) => (e as Error).message
        )
      ).equals('runner near 2: expected true')
    })
  })
})
