import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { mount, press, text, unmount } from '../../test/gameFormDom'
import { PersonSearchRow } from './PersonSearchRow'

describe('shared person search row', () => {
  afterEach(unmount)
  it('uses two letters for a single-word name', async () => {
    await mount(<PersonSearchRow name="Ichiro" onPress={() => {}} />)
    expect(text()).contains('IC')
  })
  it('shows two compact initials and an affiliation below the name, and selects the person', async () => {
    let selected = false
    await mount(
      <PersonSearchRow
        name="Mookie Betts"
        affiliations="Guardian of Mike T · Demo Hawks"
        onPress={() => {
          selected = true
        }}
      />
    )
    expect(text())
      .contains('MB')
      .and.contains('Mookie Betts')
      .and.contains('Guardian of Mike T · Demo Hawks')
    const initials = [...document.querySelectorAll<HTMLElement>('div')].find(
      element => element.textContent === 'MB' && element.style.fontSize !== ''
    )!
    expect(initials).not.equals(undefined)
    expect(Number.parseFloat(initials.style.fontSize)).lessThan(16)
    await press('Mookie Betts')
    expect(selected).equals(true)
  })
  it('shows the photo instead of initials and permits missing affiliations', async () => {
    await mount(
      <PersonSearchRow
        name="Mike Trout"
        avatarUrl="https://example.test/avatar.png"
        disabled
        onPress={() => {
          throw new Error('Disabled person selected')
        }}
      />
    )
    expect(document.querySelector('img')?.getAttribute('src')).contains(
      'avatar.png'
    )
    expect(text()).not.contains('MT')
    await press('Mike Trout')
  })
})
