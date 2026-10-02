import { expect } from 'chai'
import { describe, it } from 'mocha'

import { cameraNamesOnTake, hideReplaced } from './importArchiveCameras'

describe('archive import take-down', function () {
  it('names mound as home, and ignores the primary', function () {
    expect(cameraNamesOnTake(['main', '1st', '3rd', 'mound'])).deep.equals([
      '1st',
      '3rd',
      'home'
    ])
  })

  it('does not hide a mosaic while a camera on the take is missing', function () {
    expect(
      hideReplaced({
        videoReadsAs: 'multiAngle',
        onTake: ['1st', '3rd', 'home'],
        landed: new Set(['1st', '3rd'])
      })
    ).equals(false)
  })

  it('hides a mosaic once every camera on the take is in', function () {
    expect(
      hideReplaced({
        videoReadsAs: 'multiAngle',
        onTake: ['1st', '3rd', 'home'],
        landed: new Set(['main', '1st', '3rd', 'home'])
      })
    ).equals(true)
  })

  it('does not hide live unless a primary is in', function () {
    expect(
      hideReplaced({
        videoReadsAs: 'live',
        onTake: ['1st', '3rd', 'home'],
        landed: new Set(['1st', '3rd', 'home'])
      })
    ).equals(false)
    expect(
      hideReplaced({
        videoReadsAs: 'live',
        onTake: ['1st', '3rd', 'home'],
        landed: new Set(['main', '1st', '3rd', 'home'])
      })
    ).equals(true)
  })

  it('leaves a primary in place', function () {
    expect(
      hideReplaced({
        videoReadsAs: 'main',
        onTake: ['1st', '3rd', 'home'],
        landed: new Set(['main', '1st', '3rd', 'home'])
      })
    ).equals(false)
  })
})
