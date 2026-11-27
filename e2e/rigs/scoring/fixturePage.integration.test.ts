import { expect } from 'chai'
import { describe, it } from 'mocha'

import { reportParts } from '../../../src/test/dictatedReport'
import { BlockedError } from '../../core/result'
import type { HarnessContext } from '../../core/spec'
import {
  BUNDLE_DEFINES,
  bundleWithEsbuild,
  inlineScript,
  pageOf,
  playEach,
  reportOf,
  reportsOf,
  serveFixture
} from './fixturePage'

const INDEX = `<html><head><link href="/fonts/A.ttf"><style>src: url('/fonts/A.ttf') url('/fonts/B.ttf')</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`

async function read(file: string): Promise<Buffer> {
  if (file.endsWith('index.html')) return Buffer.from(INDEX)
  if (file.endsWith('A.ttf')) return Buffer.from('a')
  if (file.endsWith('B.ttf')) return Buffer.from('b')
  throw new Error(`unexpected ${file}`)
}

/** What the page would have asked of `timeline`, for `report`. */
function asked(
  path: string,
  name: string,
  report: unknown,
  send = 's1'
): Array<{ path: string; query: string }> {
  return reportParts(name, report, send).map(url => {
    const [file, query] = url.split('?')
    return { path: `${path}${file}`, query: `?${query}` }
  })
}

describe('fixturePage', () => {
  it('puts the code in place of app.js, its fonts inline, and escapes a closing script', async () => {
    expect(inlineScript('a</script>b</SCRIPT>')).equals(
      'a<\\/script>b<\\/script>'
    )
    const html = await pageOf('let x = "</script>"', '/root', read)
    expect(html).includes('<script>let x = "<\\/script>"</script>')
    expect(html).includes(
      `data:font/ttf;base64,${Buffer.from('a').toString('base64')}`
    )
    expect(html).includes(
      `data:font/ttf;base64,${Buffer.from('b').toString('base64')}`
    )
    expect(html).not.includes('/fonts/')
    expect(html).includes('#root{display:block}')
    const noTag = async (file: string): Promise<Buffer> =>
      file.endsWith('index.html')
        ? Buffer.from('<head></head>')
        : await read(file)
    let error: unknown
    await pageOf('', '/root', noTag).catch((caught: unknown) => {
      error = caught
    })
    expect(String(error)).includes('index.html has no')
  })

  it('bundles an entry with the web build settings into the real page', async function () {
    this.timeout(120000)
    expect(Object.keys(BUNDLE_DEFINES)).deep.equals([
      '__DEV__',
      'global',
      'process.env',
      'process.env.NODE_ENV',
      'process.env.TS_SENTRY_DSN'
    ])
    const html = await bundleWithEsbuild('src/test/dictatedReport.ts')
    expect(html).includes('timeline?')
    expect(html).includes('data:font/ttf;base64,')
    expect(html).not.includes('src="/app.js"')
  })

  it('puts each report back together from its parts, the last send of a name winning', () => {
    const big = { name: 'E1', text: 'x'.repeat(4500) }
    const requests = [
      { path: '/other/timeline', query: '?name=E1&part=0&of=1&data=%7B%7D' },
      { path: '/p/timeline', query: '?part=0&of=1&data=x' },
      { path: '/p/timeline', query: '?name=E9&part=3&of=1&data=x' },
      ...asked('/p/', 'E1', big),
      ...asked('/p/', 'E2', { name: 'E2', n: 1 }).slice(0, 0),
      ...asked('/p/', 'E3', { n: 1 }, 'a'),
      ...asked('/p/', 'E3', { n: 2 }, 'b'),
      // A send with a part missing is not whole yet.
      ...asked('/p/', 'E4', { text: 'y'.repeat(4500) }).slice(1)
    ]
    const reports = reportsOf(requests, '/p/')
    expect([...reports.keys()]).deep.equals(['E1', 'E3'])
    expect(reports.get('E1')).deep.equals(big)
    expect(reports.get('E3')).deep.equals({ n: 2 })
  })

  /** A context whose pages stand-in remembers its script and answers `requests`. */
  function context(requests: unknown[] = []): {
    ctx: HarnessContext
    scripts: Array<Record<string, any>>
    requests: unknown[]
  } {
    const scripts: Array<Record<string, any>> = []
    const ctx = {
      stack: {
        pagesOrigin: 'https://pages.example.test',
        control: {
          pages: {
            script: async (pages: Record<string, any>) => {
              scripts.push(pages)
              return {}
            },
            requests: async () => ({ requests })
          }
        }
      }
    } as unknown as HarnessContext
    return { ctx, scripts, requests }
  }

  it('serves the page and its scenarios at a path of its own, and reads its reports', async () => {
    const { ctx, scripts, requests } = context()
    const page = await serveFixture(
      ctx,
      'src/test/x.fixture.tsx',
      [{ name: 'E1' }],
      async entry => `<page ${entry}>`
    )
    expect(page.path).matches(/^\/fixture-[0-9a-f]{8}\/$/)
    expect(page.url).equals(`https://pages.example.test${page.path}`)
    expect(scripts[0][page.path]).deep.equals({
      body: '<page src/test/x.fixture.tsx>'
    })
    expect(scripts[0][`${page.path}scenarios`]).deep.equals({
      type: 'application/json',
      body: '[{"name":"E1"}]'
    })
    requests.push(...asked(page.path, 'E1', { done: true }))
    expect(await reportOf(page, 'E1')).deep.equals({ done: true })
    let error: unknown
    await reportOf(page, 'E2', -1, async () => undefined).catch(
      (caught: unknown) => {
        error = caught
      }
    )
    expect(String(error)).includes('E2 did not report its timeline')
    let waited = 0
    const later = await reportOf(page, 'E5', 60000, async () => {
      waited++
      requests.push(...asked(page.path, 'E5', { late: true }))
    })
    expect(later).deep.equals({ late: true })
    expect(waited).equals(1)
  })

  it('blocks on a stack with no pages stand-in', async () => {
    for (const stack of [{}, { control: {} }]) {
      let error: unknown
      await serveFixture(
        { stack } as unknown as HarnessContext,
        'x',
        [],
        async () => ''
      ).catch((caught: unknown) => {
        error = caught
      })
      expect(error).instanceOf(BlockedError)
    }
  })
})

describe('playEach', () => {
  it('taps each play, waits for Complete and its report, then a beat', async () => {
    const steps: string[] = []
    const reports = new Map<string, any>([
      ['F1', { outs: 1 }],
      ['F2', { outs: 2 }]
    ])
    const played = await playEach(
      {
        tapOn: async ({ text }) => steps.push(`tap ${text}`),
        assertVisible: async ({ text, timeout }) =>
          steps.push(`see ${text} ${timeout}`)
      },
      { url: '', path: '/p/', reports: async () => reports },
      ['F1', 'F2'],
      2000,
      async ms => {
        steps.push(`beat ${ms}`)
      }
    )
    expect(steps).deep.equals([
      'tap ^Play F1$',
      'see ^F1 — Complete$ 60000',
      'beat 2000',
      'tap ^Play F2$',
      'see ^F2 — Complete$ 60000',
      'beat 2000'
    ])
    expect(played.get('F2').outs).equals(2)
    expect(played.get('F1').reportedAt).a('number')
  })
})
