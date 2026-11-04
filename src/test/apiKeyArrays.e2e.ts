/* eslint-disable @typescript-eslint/prefer-optional-chain -- Browser callbacks cannot capture transpiler helpers. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { recordBrowserCoverage } from '../app/browserCoverage.e2e'
import { aiSettings } from '../server/aiKeys'
import { modelsOf } from '../server/dictation/models'
import { healthRoutes } from '../server/routes/health'
import { tessRoutes } from '../server/routes/tess'
import { asServerConfig } from '../server/serverConfig'
import { sseText } from './anthropicStream'
import { groupFixture } from './groupFixtures'
import {
  type BrowserSession,
  browserSession,
  maestro
} from './refinementsMaestro.e2e'

describe('API keys in the running application', function () {
  this.timeout(180000)
  it('saves the three pools through the browser and uses the next request without restarting', async () => {
    const out = resolve(
      process.env.TS_ARTIFACTS_DIR ?? 'artifacts/apiKeyArrays'
    )
    await mkdir(out, { recursive: true })
    const config = asServerConfig({})
    const seen: string[] = []
    let failAll = false
    let origin = ''
    const fixture = await groupFixture(
      resolve('dist'),
      undefined,
      (app, { db }) => {
        app.use(
          '/api/v1',
          healthRoutes(db, 'test', {
            resolveAi: async () => {
              const ai = await aiSettings(db, config)
              return {
                tess: ai.tess != null,
                narration: ai.speech != null,
                dictation: ai.dictation != null,
                dictationModels:
                  ai.dictation == null ? [] : modelsOf(ai.dictation)
              }
            }
          })
        )
        app.use(
          '/api/v1',
          tessRoutes(db, {
            settings: null,
            resolveSettings: async () => (await aiSettings(db, config)).tess,
            origin: () => origin,
            fetch: async (url, init) => {
              if (
                (typeof url === 'string'
                  ? url
                  : url instanceof URL
                    ? url.href
                    : url.url
                ).endsWith('/count_tokens')
              )
                return Response.json({ input_tokens: 20 })
              seen.push(new Headers(init?.headers).get('x-api-key')!)
              if (seen.length % 2 === 1)
                return new Response('{}', { status: 401 })
              if (failAll) return new Response('{}', { status: 529 })
              return new Response(
                sseText({
                  content: [{ type: 'text', text: 'Key fallback succeeded.' }]
                })
              )
            }
          })
        )
      }
    )
    origin = fixture.h.origin
    const daemon = await maestro(process.env.MAESTRO_D ?? 'api-key-arrays-e2e')
    let browser: BrowserSession | undefined
    try {
      expect(
        (await (await fetch(origin + '/api/v1/health')).json()).tess
      ).equals(false)
      browser = await browserSession(
        daemon,
        'api-key-arrays-e2e-browser',
        1280,
        900,
        out,
        'chrome'
      )
      const { m, page } = browser
      await browser.browser.setCookie({
        name: 'ts_session',
        value: fixture.h.tokens.get(105)!,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true
      })
      await m.openBrowser({ url: origin + '/node' })
      await page.waitForSelector('textarea[aria-label="Anthropic chatbot"]')
      for (const [label, value] of [
        ['Anthropic chatbot', 'chat-a\nchat-b'],
        ['Anthropic scoring', 'score-a\nscore-b'],
        ['XAI voice model', 'voice-a\nvoice-b']
      ]) {
        await m.tapOn({ css: `textarea[aria-label="${label}"]` })
        const lines = value.split('\n')
        for (let index = 0; index < lines.length; index++) {
          if (index > 0) await m.pressKey({ key: 'ENTER' })
          await m.inputText({ text: lines[index] })
        }
      }
      expect(
        await page.$$eval('textarea', nodes => nodes.map(node => node.rows))
      ).deep.equals([3, 3, 3])
      await writeFile(resolve(out, 'node-keys-after.png'), await m.screenshot())
      await m.scrollUntilVisible({
        element: { text: 'Save', role: 'button' },
        direction: 'DOWN'
      })
      await m.tapOn({ text: 'Save', role: 'button' })
      await page.waitForFunction(
        () =>
          document.body.textContent !== null &&
          document.body.textContent.includes('Saved.')
      )
      await m.openBrowser({ url: origin + '/node' })
      await page.waitForFunction(() => {
        const field = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Anthropic chatbot"]'
        )
        return field !== null && field.value === 'chat-a\nchat-b'
      })
      const health = await (await fetch(origin + '/api/v1/health')).json()
      expect(health.tess).equals(true)
      expect(health.narration).equals(true)
      expect(health.dictation).equals(true)
      expect(JSON.stringify(health)).not.contains('chat-a')
      const response = await fixture.h.request(
        'POST',
        '/me/tess/messages',
        { text: 'Hello' },
        105
      )
      expect(response.status, await response.clone().text()).equals(200)
      expect(seen).length(2)
      expect(new Set(seen).size).equals(2)
      console.log('Chatbot recovered after 401 using each key once.')
      failAll = true
      const failed = await fixture.h.request(
        'POST',
        '/me/tess/messages',
        { text: 'Hello again' },
        105
      )
      expect(failed.status).equals(503)
      expect(await failed.text()).contains('529')
      expect(seen).length(4)
      console.log('Exhaustion returned the latest error, 529.')
      expect(
        (await fixture.h.request('GET', '/node/settings', undefined, 101))
          .status
      ).equals(403)
      const saved = await (
        await fixture.h.request('GET', '/node/settings', undefined, 105)
      ).json()
      await fixture.h.request(
        'PUT',
        '/node/settings',
        {
          ...saved,
          aiKeys: { anthropicChatbot: [], anthropicScoring: [], xaiVoice: [] }
        },
        105
      )
      const disabled = await (await fetch(origin + '/api/v1/health')).json()
      expect([
        disabled.tess,
        disabled.dictation,
        disabled.narration
      ]).deep.equals([false, false, false])
      console.log(
        'Three pools persisted; public health exposed no keys; empty pools disabled services without restart.'
      )
      await recordBrowserCoverage(
        [page],
        origin,
        resolve(out, 'browser-coverage.json')
      )
    } finally {
      await browser?.browser.close()
      await daemon.shutdown()
      await fixture.h.close()
    }
  })
})
