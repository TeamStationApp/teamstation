import { expect } from 'chai'
import { describe, it } from 'mocha'

import { workerOutDir, workerUrl } from './buildWorker.mjs'

describe('the password worker build', function () {
  it("goes to dist with the variable unset, at today's URL", function () {
    expect(workerOutDir({})).equals('dist')
    expect(workerUrl('dist/password-worker-AB.js', 'dist')).equals(
      '/password-worker-AB.js'
    )
  })

  it('goes with the page when the variable is set', function () {
    expect(workerOutDir({ TS_WEB_OUT_DIR: '/tmp/stack/web' })).equals(
      '/tmp/stack/web'
    )
    expect(
      workerUrl(
        '../../tmp/stack/web/password-worker-AB.js',
        '../../tmp/stack/web'
      )
    ).equals('/password-worker-AB.js')
  })
})
