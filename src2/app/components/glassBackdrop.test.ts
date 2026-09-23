import { expect } from 'chai'
import { describe, it } from 'mocha'

import { gsBallpark } from '../theme/gsBallpark'
import { gsDark } from '../theme/gsDark'
import { backdropOf } from './glassBackdrop'

describe('glass backdrop on Android', function () {
  it('reads the web backdrop-filter as a radius and a saturation', function () {
    for (const theme of [gsBallpark, gsDark])
      expect(backdropOf(theme.glassBlur)).deep.equals({
        radius: 24,
        saturation: 2
      })
    expect(backdropOf('blur(12.5px)')).deep.equals({
      radius: 12.5,
      saturation: 1
    })
    expect(backdropOf('none')).deep.equals({ radius: 0, saturation: 1 })
  })
})
