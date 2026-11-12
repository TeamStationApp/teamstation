import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { View } from 'react-native'

import { mount, unmount } from '../../test/gameFormDom'
import { type Theme, useTheme } from '../theme/ThemeContext'
import { PersonAffiliationLine } from './PersonAffiliationLine'

let theme: Theme | undefined
function Probe(): null {
  theme = useTheme()
  return null
}

const line = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

/** The colour a CSS colour value computes to, to compare two spellings. */
function computed(color: string): string {
  const probe = document.createElement('span')
  probe.style.color = color
  return probe.style.color
}

describe('the person affiliation line', () => {
  afterEach(unmount)

  it('draws the line on one panning row, in the secondary colour at 0.875rem', async () => {
    await mount(
      <View>
        <Probe />
        <PersonAffiliationLine
          affiliations="Guardians: Ken G · Demo Hawks"
          testID="umpire-affiliation-usr_1"
        />
      </View>
    )
    const drawn = line('umpire-affiliation-usr_1')!
    expect(drawn.textContent).equals('Guardians: Ken G · Demo Hawks')
    // The ticker's own parts keep their test ids, which the umpire table's
    // end-to-end geometry reads.
    expect(line('umpire-affiliation-usr_1-viewport')).not.equals(null)
    expect(line('umpire-affiliation-usr_1-motion')).not.equals(null)
    expect(getComputedStyle(drawn).color).equals(
      computed(theme!.secondaryTextColor)
    )
    expect(Number.parseFloat(getComputedStyle(drawn).fontSize)).equals(
      theme!.rem(0.875)
    )
  })

  it('takes a colour of its own for a surface of its own', async () => {
    await mount(
      <PersonAffiliationLine
        affiliations="Demo Owls"
        color="#123456"
        testID="line"
      />
    )
    expect(getComputedStyle(line('line')!).color).equals(computed('#123456'))
  })

  it('draws nothing for an empty line or none', async () => {
    await mount(
      <View testID="host">
        <PersonAffiliationLine affiliations="" testID="empty" />
        <PersonAffiliationLine affiliations={undefined} testID="missing" />
      </View>
    )
    expect(line('empty')).equals(null)
    expect(line('empty-viewport')).equals(null)
    expect(line('missing')).equals(null)
    expect(line('host')!.textContent).equals('')
  })
})
