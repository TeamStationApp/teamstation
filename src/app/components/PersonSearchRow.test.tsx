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
  it('draws its line through the shared affiliation line, with the test id it is given, and none when empty', async () => {
    await mount(
      <>
        <PersonSearchRow
          name="Cal Ripken"
          affiliations="Guardian of Josh S · Demo Hawks"
          affiliationTestID="candidate-affiliation-usr_ripken"
          onPress={() => {}}
        />
        <PersonSearchRow
          name="Derek Jeter"
          affiliations=""
          affiliationTestID="candidate-affiliation-usr_jeter"
          onPress={() => {}}
        />
      </>
    )
    const line = document.querySelector<HTMLElement>(
      '[data-testid="candidate-affiliation-usr_ripken"]'
    )!
    expect(line.textContent).equals('Guardian of Josh S · Demo Hawks')
    expect(Number.parseFloat(getComputedStyle(line).fontSize)).lessThan(16)
    expect(
      document.querySelector(
        '[data-testid="candidate-affiliation-usr_ripken-viewport"]'
      )
    ).not.equals(null)
    expect(
      document.querySelector('[data-testid^="candidate-affiliation-usr_jeter"]')
    ).equals(null)
  })
})
