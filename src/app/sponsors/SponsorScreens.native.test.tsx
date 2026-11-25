import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { mount, text, unmount } from '../../test/gameFormDom'
import * as screens from './SponsorScreens.native'

afterEach(async () => {
  await unmount()
})

describe('the sponsor screens on a phone', () => {
  it('says each one is set up on the web', async () => {
    const names = Object.keys(screens)
    expect(names).deep.equals(['SponsorLogosScreen'])
    for (const Each of Object.values(screens)) {
      await mount(<Each client={{}} league="lea_demo" />)
      expect(text()).equals('Sponsor features are set up on the web.')
      await unmount()
    }
  })
})
