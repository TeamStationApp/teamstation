import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { mount, unmount } from '../../test/gameFormDom'
import { emitInitialsLayout } from '../../test/nativeInitialsTextStub'
import { FittedInitials } from './FittedInitials.native'

describe('native initials measurement state', () => {
  afterEach(unmount)
  it('waits for metrics, fits wide glyphs and converges on repeated layout events', async () => {
    await mount(<FittedInitials letters="WW" size={6} color="#FFFFFF" />)
    await act(async () => {
      emitInitialsLayout([])
    })
    await act(async () => {
      emitInitialsLayout([{ width: 190, capHeight: 72 }])
    })
    const fitted = (): number => {
      const letters = [...document.querySelectorAll<HTMLElement>('*')].filter(
        node => node.children.length === 0 && node.textContent === 'WW'
      )
      return parseFloat(letters.at(-1)!.style.fontSize)
    }
    expect(fitted()).closeTo(40.421, 0.01)
    await act(async () => {
      emitInitialsLayout([{ width: 190, capHeight: 72 }])
    })
    expect(fitted()).closeTo(40.421, 0.01)
  })
})
