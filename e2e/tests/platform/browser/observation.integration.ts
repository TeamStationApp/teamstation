import { randomUUID } from 'node:crypto'

import { expect } from 'chai'

import { BlockedError } from '../../../core/result'
import { defineHarness } from '../../../core/spec'

/**
 * Exercises the real Maestro/Puppeteer pair on pages the stack's `pages`
 * stand-in serves; the stack needs no service beyond it.
 */
export default defineHarness({
  id: 'platform/browser/observation',
  title:
    'Browser observations read the page without capturing network responses',
  kind: 'integration',
  covers: ['e2e/core/browserCdp.ts'],
  stack: 'isolated',
  fixtures: [],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 1,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    network: async ctx => {
      const control = ctx.stack.control
      const pagesOrigin = ctx.stack.pagesOrigin
      if (control == null || pagesOrigin == null) {
        throw new BlockedError('this stack has no pages stand-in')
      }
      // The page, its script and its payload come from the stack's pages
      // stand-in, under a folder of this run's own, reached over HTTPS.
      const folder = `/observation-${randomUUID()}`
      const origin = pagesOrigin.replace(/\/+$/, '')
      const page = `${origin}${folder}/`
      const payload = `${origin}${folder}/payload`
      const since = Date.now()
      await control.pages.script({
        [`${folder}/payload`]: {
          type: 'application/octet-stream',
          body: 'x'.repeat(65536),
          headers: { 'Cache-Control': 'no-store' }
        },
        [`${folder}/fixture.js`]: {
          type: 'text/javascript',
          body: `
            document.querySelector('#download').onclick = async () => {
              const response = await fetch('${folder}/payload');
              const bytes = await response.arrayBuffer();
              document.querySelector('#result').textContent =
                'Received ' + bytes.byteLength + ' bytes';
            };
          `,
          headers: { 'Cache-Control': 'no-store' }
        },
        [`${folder}/`]: {
          type: 'text/html',
          body: `<!doctype html><html><body>
            <h1>Browser observer</h1>
            <button id="download">Download sample</button>
            <output id="result">Ready</output>
            <script src="${folder}/fixture.js"></script>
          </body></html>`,
          headers: { 'Cache-Control': 'no-store' }
        }
      })
      const served = async (): Promise<number> => {
        const log = (await control.pages.requests(since)) as {
          requests: Array<{ method: string; path: string }>
        }
        return log.requests.filter(
          row => row.method === 'GET' && row.path === `${folder}/payload`
        ).length
      }
      const session = await ctx.browser(
        { width: 900, height: 600 },
        { h264: true }
      )
      const { m } = session
      await m.openLink({ link: page })
      let observed = 0
      session.page.on('request', request => {
        if (request.url() === payload) observed++
      })
      await m.tapOn({ id: 'download' })
      await m.assertVisible({ text: 'Received 65536 bytes' })
      const text = await session.page.evaluate(() => {
        const result = document.querySelector('#result')
        return result == null ? null : result.textContent
      })
      expect(text).equals('Received 65536 bytes')
      expect(
        await served(),
        'the browser really downloaded the response'
      ).equals(1)
      expect(
        observed,
        'the read-only observer captures no network events'
      ).equals(0)
      expect((await session.page.metrics()).JSHeapUsedSize).greaterThan(0)
      // The runner may own a precise coverage collector. Read a snapshot
      // through our own session without starting or stopping that collector.
      const profiler = await session.page.createCDPSession()
      try {
        await profiler.send('Profiler.enable')
        const { result: coverage } = await profiler.send(
          'Profiler.getBestEffortCoverage'
        )
        expect(
          coverage.some(
            entry =>
              entry.url === `${origin}${folder}/fixture.js` &&
              entry.functions.some(fn =>
                fn.ranges.some(range => range.count > 0)
              )
          ),
          'JavaScript coverage remains available'
        ).equals(true)
      } finally {
        await profiler.detach()
      }
      expect((await m.screenshot()).byteLength).greaterThan(0)
      await ctx.checkpoint('observer-download', {
        expect: [{ text: 'Received 65536 bytes' }]
      })
    }
  }
})
