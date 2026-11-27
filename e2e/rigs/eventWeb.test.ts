import { expect } from 'chai'
import { describe, it } from 'mocha'

import { SCORING_FEATURES } from '../../src/common/scoring/teamRecord'
import {
  api,
  at,
  dismissNotificationAsk,
  hierarchyReady,
  inMapFrame,
  mapFrameOf,
  mapTileHost,
  openEventWeb,
  pointInMapFrame,
  SESSION_COOKIE,
  sql,
  tokenOf,
  waitInMapFrame
} from './eventWeb'

const noSleep = async (): Promise<void> => {}

/** A map frame whose script answers `answer(expression)`. */
function frame(
  answer: (expression: string) => unknown,
  options: { url?: string; visible?: boolean; box?: unknown } = {}
): any {
  return {
    url: () => options.url ?? 'https://e2e.example.test/mapFrame.html',
    frameElement: async () => ({
      evaluate: async () => options.visible ?? true,
      boundingBox: async () =>
        options.box === undefined ? { x: 10, y: 20 } : options.box
    }),
    evaluate: async (expression: string) => {
      const inner = /^JSON\.stringify\(\((.*)\)\?\?null\)$/s.exec(expression)
      if (inner != null) return JSON.stringify(answer(inner[1]) ?? null)
      return answer(expression)
    }
  }
}

function pageOf(frames: any[]): any {
  const handlers: Record<string, (value: unknown) => void> = {}
  return {
    frames: () => frames,
    on: (event: string, handler: (value: unknown) => void) => {
      handlers[event] = handler
    },
    emit: (event: string, value: unknown) => {
      handlers[event](value)
    }
  }
}

interface Fake {
  ctx: any
  calls: Array<[string, unknown]>
  page: any
}

function harness(
  answers: Record<string, unknown> = {},
  vars?: Record<string, string>
): Fake {
  const calls: Array<[string, unknown]> = []
  const page = pageOf([])
  const m = new Proxy(
    {},
    {
      get: (_target, name: string) => async (body: any) => {
        calls.push([name, body])
        if (name === 'evalBrowserScript') {
          if (vars != null) return {}
          const expression = /^return JSON\.stringify\((.*)\)$/s.exec(
            String(body.script)
          )?.[1]
          return { data: JSON.stringify(answers[expression ?? ''] ?? null) }
        }
        if (name === 'vars') return vars
        return undefined
      }
    }
  )
  const ctx = {
    stack: {
      origin: 'https://e2e.example.test',
      control: {
        rateLimits: async (body: unknown) => {
          calls.push(['rateLimits', body])
        },
        sql: async (text: string, values: unknown[]) => {
          calls.push(['sql', { text, values }])
          return { rows: [{ id: 'row' }], rowCount: 1 }
        }
      }
    },
    browser: async (size: unknown, emulation: unknown) => {
      calls.push(['browser', { size, emulation }])
      return { m, page }
    },
    artifact: (name: string) => `/run/${name}`
  }
  return { ctx, calls, page }
}

const deps = {
  signIn: async (_base: string, account: { email: string }) =>
    `token-${account.email}`,
  sleep: noSleep
}

describe('eventWeb', function () {
  it('opens the stack signed in by cookie, reads and waits through maestro-d', async function () {
    const fake = harness({ '1+1': 2, ready: true })
    const web = await openEventWeb(
      fake.ctx,
      { email: 'a@example.test', password: 'p' },
      { width: 10, height: 20 },
      { timeZone: 'UTC' },
      deps
    )
    expect(fake.calls[0]).to.deep.equal([
      'rateLimits',
      { clear: ['password', 'passwordParameters'] }
    ])
    expect(fake.calls[1]).to.deep.equal([
      'browser',
      { size: { width: 10, height: 20 }, emulation: { timeZone: 'UTC' } }
    ])
    expect(fake.calls[2]).to.deep.equal([
      'openBrowser',
      { url: 'https://e2e.example.test' }
    ])
    expect(fake.calls[3]).to.deep.equal([
      'setCookies',
      {
        cookies: [
          {
            name: SESSION_COOKIE,
            value: 'token-a@example.test',
            domain: 'e2e.example.test',
            path: '/'
          }
        ]
      }
    ])
    expect(await web.evaluate('1+1')).to.equal(2)
    await web.wait('ready')
    await web.go('/games/g')
    await web.shot('a.png')
    expect(fake.calls.slice(-2)).to.deep.equal([
      ['openBrowser', { url: 'https://e2e.example.test/games/g' }],
      ['takeScreenshot', { path: '/run/a.png' }]
    ])
    fake.page.emit('pageerror', new Error('boom'))
    expect(web.errors).to.deep.equal(['Error: boom'])
    let failed: unknown
    try {
      await web.wait('never', 0)
    } catch (error) {
      failed = error
    }
    expect(String(failed)).to.include('Never held in the page: never')
  })

  it('reads a probe from the session variables when the reply carries none', async function () {
    const fake = harness({}, { eventProbe: '"from vars"' })
    const web = await openEventWeb(
      fake.ctx,
      { email: 'b@example.test', password: 'p' },
      { width: 1, height: 1 },
      {},
      deps
    )
    expect(await web.evaluate('anything')).to.equal('from vars')
    const empty = harness({}, {})
    const blank = await openEventWeb(
      empty.ctx,
      { email: 'c@example.test', password: 'p' },
      { width: 1, height: 1 },
      {},
      deps
    )
    expect(await blank.evaluate('anything')).to.equal(undefined)
  })

  it('signs each account in once per stack and asks the API with its token', async function () {
    const fake = harness()
    let signIns = 0
    const counted = {
      signIn: async () => {
        signIns++
        return 'tok'
      }
    }
    const who = { email: 'once@example.test', password: 'p' }
    expect(await tokenOf(fake.ctx, who, counted)).to.equal('tok')
    expect(await tokenOf(fake.ctx, who, counted)).to.equal('tok')
    expect(signIns).to.equal(1)
    const seen: Array<[string, any]> = []
    const replies = ['{"a":1}', '', 'not json']
    const fetcher = (async (url: string, init: any) => {
      seen.push([url, init])
      return {
        status: 200,
        text: async () => replies.shift()
      }
    }) as unknown as typeof fetch
    const json = await api(
      fake.ctx,
      who,
      'PUT',
      '/x',
      { b: 2 },
      {
        ...counted,
        fetch: fetcher
      }
    )
    expect(json).to.deep.equal({ status: 200, body: { a: 1 } })
    expect(seen[0][0]).to.equal('https://e2e.example.test/api/v1/x')
    expect(seen[0][1]).to.deep.equal({
      method: 'PUT',
      headers: {
        authorization: 'Bearer tok',
        'x-teamstation-protocol': '6',
        'x-teamstation-scoring': SCORING_FEATURES,
        'content-type': 'application/json'
      },
      body: '{"b":2}'
    })
    expect(
      await api(fake.ctx, who, 'GET', '/y', undefined, { fetch: fetcher })
    ).to.deep.equal({ status: 200, body: null })
    expect(seen[1][1]).to.deep.equal({
      method: 'GET',
      headers: {
        authorization: 'Bearer tok',
        'x-teamstation-protocol': '6',
        'x-teamstation-scoring': SCORING_FEATURES
      }
    })
    expect(
      (await api(fake.ctx, who, 'GET', '/z', undefined, { fetch: fetcher }))
        .body
    ).to.equal('not json')
  })

  it('runs setup statements on the stack and answers their rows', async function () {
    const fake = harness()
    expect(await sql(fake.ctx, 'select 1', [1])).to.deep.equal([{ id: 'row' }])
    expect(fake.calls.at(-1)).to.deep.equal([
      'sql',
      { text: 'select 1', values: [1] }
    ])
    expect(await sql(fake.ctx, 'select 2')).to.deep.equal([{ id: 'row' }])
    await hierarchyReady(fake.ctx)
    const ready = fake.calls.at(-1) as [string, { text: string }]
    expect(ready[0]).to.equal('sql')
    expect(ready[1].text).to.include("'creation.hierarchyReady', 'true'")
  })

  it('finds the map frame on show and reads inside it', async function () {
    const hidden = frame(() => 0, { visible: false })
    const other = frame(() => 0, { url: 'https://e2e.example.test/other' })
    const shown = frame(expression => {
      if (expression === 'window.eventMap.getCenter()')
        return { lat: 1, lng: 2 }
      if (expression.endsWith('.src'))
        return 'https://tiles.example.test/1/2/3.png'
      if (expression.includes('!=null')) return true
      if (expression.includes('getBoundingClientRect')) return { x: 3, y: 4 }
      return false
    })
    const page = pageOf([other, hidden, shown])
    expect(await mapFrameOf(page, 1000, noSleep)).to.equal(shown)
    expect(await inMapFrame(page, 'window.eventMap.getCenter()')).to.deep.equal(
      {
        lat: 1,
        lng: 2
      }
    )
    await waitInMapFrame(page, 'x!=null', 1000, noSleep)
    expect(await mapTileHost(page)).to.equal('tiles.example.test')
    expect(await pointInMapFrame(page, '#retry')).to.deep.equal({
      x: 13,
      y: 24
    })
  })

  it('names what never held in the map frame, and a frame that never shows', async function () {
    let reads = 0
    const flaky = frame(() => {
      reads++
      if (reads === 1) throw new Error('between documents')
      return false
    })
    const page = pageOf([flaky])
    let failed: unknown
    try {
      await waitInMapFrame(page, 'done', 5, async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
      })
    } catch (error) {
      failed = error
    }
    expect(String(failed)).to.include('Never held in the map frame: done')
    let thrown: unknown
    try {
      await waitInMapFrame(
        pageOf([
          frame(() => {
            throw new Error('gone')
          })
        ]),
        'x',
        1,
        async () => {
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      )
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).to.include('(gone)')
    let missing: unknown
    try {
      await mapFrameOf(pageOf([]), 0, noSleep)
    } catch (error) {
      missing = error
    }
    expect(String(missing)).to.include('The map frame never appeared')
    let sleeps = 0
    const late = await mapFrameOf(pageOf([]), 5, async () => {
      sleeps++
      await new Promise(resolve => setTimeout(resolve, 5))
    }).catch((error: unknown) => error)
    expect(String(late)).to.include('never appeared')
    expect(sleeps).to.be.greaterThan(0)
    let boxless: unknown
    try {
      await pointInMapFrame(pageOf([frame(() => 0, { box: null })]), '#a')
    } catch (error) {
      boxless = error
    }
    expect(String(boxless)).to.include('The map frame has no box')
  })

  it('answers the notification ask when it comes up, and not when it does not', async function () {
    const taps: unknown[] = []
    const asked = {
      assertVisible: async () => undefined,
      tapOn: async (body: unknown) => {
        taps.push(body)
      }
    }
    expect(await dismissNotificationAsk(asked, 10, noSleep)).to.equal(true)
    expect(taps).to.deep.equal([
      { id: 'notification-ask-not-now', timeout: 5000 }
    ])
    const quiet = {
      assertVisible: async () => {
        throw new Error('not shown')
      }
    }
    expect(await dismissNotificationAsk(quiet, 10, noSleep)).to.equal(false)
    expect(at(1.4, 2.6)).to.equal('1,3')
  })
})
