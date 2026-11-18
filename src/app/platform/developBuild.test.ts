import { expect } from 'chai'
import { describe, it } from 'mocha'

import { appOrigin } from '../native/config'
import { isDevelopBuild } from '../native/serverOverride'
import { developBuild as webDevelop } from './developBuild'
import { developBuild } from './developBuild.native'

describe('a develop build', function () {
  it('is a develop phone build’s alone, by its app origin', function () {
    expect(webDevelop).equals(false)
    expect(developBuild).equals(isDevelopBuild(appOrigin))
    // These tests build no app origin: a stable build's.
    expect(developBuild).equals(false)
  })
})
