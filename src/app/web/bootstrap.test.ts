import Module from 'node:module'

import { expect } from 'chai'
import { JSDOM } from 'jsdom'
import { describe, it } from 'mocha'

// Exercise the deployed entry itself with inert application modules. This
// covers the compile-time branch, lazy imports, error recovery and page exit.
describe('web entry adapters', () => {
  for (const mode of [
    'ordinary',
    'development',
    'leave',
    'unavailable'
  ] as const) {
    it('starts an ' + mode + ' page with a clean location', async () => {
      const origin = 'https://develop.teamstation.app'
      const dom = new JSDOM('<main id="root"></main>', {
        url: origin + '/password-login#auth=synthetic'
      })
      const modules = ['./index.tsx', './render.tsx', './passwordLogin.ts'].map(
        name => require.resolve(name)
      )
      const previous = modules.map(name => require.cache[name])
      const nodeEnv = process.env.NODE_ENV
      const bindings = ['window', 'document', 'TS_PASSWORD_LINK_BUILD'] as const
      const originals = bindings.map(key =>
        Object.getOwnPropertyDescriptor(globalThis, key)
      )
      try {
        const values = [dom.window, dom.window.document, mode !== 'ordinary']
        bindings.forEach((key, i) =>
          Object.defineProperty(globalThis, key, {
            configurable: true,
            value: values[i]
          })
        )
        process.env.NODE_ENV = 'development'
        const actions: string[] = []
        delete require.cache[modules[0]]
        for (const [i, exports] of [
          [1, { __esModule: true }],
          [
            2,
            {
              async openPasswordLogin(params: URLSearchParams) {
                actions.push(String(params.get('auth')))
                if (mode === 'unavailable') throw Error('synthetic')
              }
            }
          ]
        ] as const) {
          const stub = new Module(modules[i])
          stub.exports = exports
          require.cache[modules[i]] = stub
        }
        require(modules[0])
        if (mode === 'leave')
          dom.window.dispatchEvent(new dom.window.Event('pagehide'))
        await new Promise(resolve => setImmediate(resolve))
        expect(dom.window.location.href).equals(origin + '/sign-in')
        expect(actions).deep.equals(
          mode === 'development' || mode === 'unavailable' ? ['synthetic'] : []
        )
        if (mode === 'unavailable')
          expect(dom.window.document.body.textContent).includes('Reload')
      } finally {
        for (const [i, name] of modules.entries()) {
          if (previous[i]) require.cache[name] = previous[i]
          else delete require.cache[name]
        }
        if (nodeEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = nodeEnv
        bindings.forEach((key, i) => {
          if (originals[i])
            Object.defineProperty(globalThis, key, originals[i]!)
          else Reflect.deleteProperty(globalThis, key)
        })
        dom.window.close()
      }
    })
  }
})
