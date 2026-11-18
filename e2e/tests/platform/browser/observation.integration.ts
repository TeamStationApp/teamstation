import { createServer } from 'node:http'

import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'

/** Exercises the real Maestro/Puppeteer pair without a database or app stack. */
export default defineE2e({
  id: 'platform/browser/observation',
  title:
    'Browser observations read the page without capturing network responses',
  kind: 'integration',
  covers: ['e2e/core/browserCdp.ts'],
  stack: 'none',
  fixtures: [],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
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
      let served = 0
      const body = Buffer.alloc(65536, 'x')
      const server = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store')
        if (request.url === '/payload') {
          served++
          response.setHeader('Content-Type', 'application/octet-stream')
          response.end(body)
        } else if (request.url === '/fixture.js') {
          response.setHeader('Content-Type', 'text/javascript')
          response.end(`
            document.querySelector('#download').onclick = async () => {
              const response = await fetch('/payload');
              const bytes = await response.arrayBuffer();
              document.querySelector('#result').textContent =
                'Received ' + bytes.byteLength + ' bytes';
            };
          `)
        } else {
          response.setHeader('Content-Type', 'text/html')
          response.end(`<!doctype html><html><body>
            <h1>Browser observer</h1>
            <button id="download">Download sample</button>
            <output id="result">Ready</output>
            <script src="/fixture.js"></script>
          </body></html>`)
        }
      })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolve)
        })
        const address = server.address()
        if (address == null || typeof address === 'string') {
          throw new Error('Fixture server has no listening port')
        }
        const origin = `http://127.0.0.1:${address.port}`
        // Use the same Chrome installation as the streaming watcher.
        const session = await ctx.browser(
          { width: 900, height: 600 },
          { h264: true }
        )
        const { page, m } = session
        await m.openLink({ link: origin })
        let observed = 0
        page.on('request', request => {
          if (request.url() === `${origin}/payload`) observed++
        })
        await m.tapOn({ id: 'download' })
        await m.assertVisible({ text: 'Received 65536 bytes' })
        const text = await page.evaluate(() => {
          const result = document.querySelector('#result')
          return result == null ? null : result.textContent
        })
        expect(text).equals('Received 65536 bytes')
        expect(served, 'the browser really downloaded the response').equals(1)
        expect(
          observed,
          'the read-only observer captures no network events'
        ).equals(0)
        expect((await page.metrics()).JSHeapUsedSize).greaterThan(0)
        // The runner may own a precise coverage collector. Read a snapshot
        // through our own session without starting or stopping that collector.
        const profiler = await page.createCDPSession()
        try {
          await profiler.send('Profiler.enable')
          const { result: coverage } = await profiler.send(
            'Profiler.getBestEffortCoverage'
          )
          expect(
            coverage.some(
              entry =>
                entry.url === `${origin}/fixture.js` &&
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
      } finally {
        // The runner closes the browser and its owned daemon in its finally.
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close(error => {
              if (error == null) resolve()
              else reject(error)
            })
          })
        }
      }
    }
  }
})
