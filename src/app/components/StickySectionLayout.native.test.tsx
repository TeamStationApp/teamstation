import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text, View } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { HeaderSlotProvider } from './headerSlot'
import { StickySectionLayout } from './StickySectionLayout.native'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
describe('the native season layout', () => {
  it('places its hero before its raised section strip and clears the overlay header', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <HeaderSlotProvider headerHeight={72} onHandoff={() => undefined}>
            <StickySectionLayout
              hero={
                <View>
                  <Text>Season identity</Text>
                </View>
              }
              sections={<Text>Season sections</Text>}
              onScroll={() => undefined}
            >
              <Text>Season games</Text>
            </StickySectionLayout>
          </HeaderSlotProvider>
        </ThemeProvider>
      )
    })
    const content = host.textContent!
    expect(content.indexOf('Season identity')).lessThan(
      content.indexOf('Season sections')
    )
    expect(content.indexOf('Season sections')).lessThan(
      content.indexOf('Season games')
    )
    const sticky = host.querySelector<HTMLElement>(
      '[data-testid="sticky-season-sections"]'
    )!
    expect(getComputedStyle(sticky).zIndex).equals('3')
    expect(sticky.style.transform).contains('translateY(0px)')
    expect(
      [...host.querySelectorAll<HTMLElement>('div')].some(
        node => node.style.paddingTop === '72px'
      )
    ).equals(true)
  })
})
