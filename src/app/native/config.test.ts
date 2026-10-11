import { expect } from 'chai'
import { describe, it } from 'mocha'

import { appOriginOf } from './config'

describe('the installed app’s link host', function () {
  it('is the origin the build inlined', function () {
    expect(appOriginOf('https://app1.example.test')).equals(
      'https://app1.example.test'
    )
  })

  it('is absent from a build that was given none', function () {
    expect(appOriginOf(undefined)).equals(undefined)
    expect(appOriginOf('')).equals(undefined)
  })
})
