import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  SERVICE_WORKER_ENTRY,
  SERVICE_WORKER_FILE,
  serviceWorkerOptions
} from '../../scripts/serviceWorkerBuild.mjs'

/**
 * The service worker's build (`scripts/serviceWorkerBuild.mjs`), which
 * `src/build.mjs` runs beside the app bundle's. A unit test starts no
 * esbuild; `buildCsp.integration.test.ts` checks the `sw.js` a real build
 * writes, once and serving.
 */

/** The app bundle's chat crypto defines, as `build.mjs` writes them. */
const define = {
  TS_API_BASE_URL: JSON.stringify('/api/v1'),
  TS_CHAT_WASM_URL: JSON.stringify('/chat-crypto-0123456789abcdef.wasm'),
  TS_CHAT_WASM_INTEGRITY: JSON.stringify('sha384-test-integrity'),
  'process.env.NODE_ENV': JSON.stringify('production'),
  __DEV__: 'false',
  global: 'globalThis'
}

describe('the service worker’s build', function () {
  it('builds sw.ts to an unhashed sw.js with the app bundle’s defines', function () {
    const options = serviceWorkerOptions({ out: 'dist', serve: false, define })
    expect(options.entryPoints).deep.equals(['src/app/web/sw.ts'])
    expect(SERVICE_WORKER_ENTRY).equals('src/app/web/sw.ts')
    expect(options.outfile).equals('dist/sw.js')
    expect(SERVICE_WORKER_FILE).equals('sw.js')
    expect(options).not.have.property('entryNames')
    expect(options.format).equals('iife')
    expect(options.bundle).equals(true)
    expect(options.sourcemap).equals(true)
    expect(options.minify).equals(true)
    expect(options.define).equals(define)
    // The browser's twins first: the chat core resolves to WebAssembly.
    expect(options.resolveExtensions[0]).equals('.web.tsx')
    expect(
      serviceWorkerOptions({ out: 'served', serve: true, define })
    ).include({ outfile: 'served/sw.js', minify: false })
  })
})
