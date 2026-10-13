import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { NAV_CLEARANCE_REM } from '../components/AppNav'
import { useScreenBottom } from '../components/Screen'
import { watchLayout } from '../layout/watch'
import { ThemeProvider, useTheme } from '../theme/ThemeContext'
import { GameWatchLayout } from './GameWatchLayout.native'

let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(
  short: boolean,
  sideBySide: boolean,
  host?: HTMLElement
): Promise<HTMLElement> {
  if (host == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <GameWatchLayout
          head={<Text>head</Text>}
          player={<Text>player</Text>}
          description={<Text>description</Text>}
          sections={<Text>sections</Text>}
          highlightList={<Text>highlights</Text>}
          footer={<Text>footer</Text>}
          layout={watchLayout({
            width: sideBySide ? 844 : 390,
            height: sideBySide ? 390 : 844,
            chromeHeight: 140,
            aspect: 16 / 9,
            previous: sideBySide ? 'sideBySide' : 'stacked'
          })}
          short={short}
          sideBySide={sideBySide}
          headerHeight={100}
          tabsHeight={40}
          height={sideBySide ? 390 : 844}
          onScroll={() => {}}
        />
      </ThemeProvider>
    )
    await delay(10)
  })
  return host
}

describe('the watch tab on a phone', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('stacks the card, the picture and the list upright, with the footer last', async function () {
    const host = await render(false, false)
    expect(host.textContent).equals('headplayerdescriptionhighlightsfooter')
  })

  it('moves the sections and the description into the column held sideways', async function () {
    const host = await render(true, true)
    expect(host.textContent).equals('playersectionsdescriptionhighlightsfooter')
  })

  it('leaves the floating capsule’s clearance under the last row, as every other screen does', async function () {
    let expected = -1
    let clearance = -1
    const Probe = (): null => {
      expected = useScreenBottom()
      clearance = useTheme().rem(NAV_CLEARANCE_REM)
      return null
    }
    const host = await render(false, false)
    await act(async () => {
      createRoot(document.createElement('div')).render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      )
      await delay(10)
    })
    // The scroller's content: the element that holds the first row.
    const content = [...host.querySelectorAll('div')].find(
      element => element.firstElementChild?.textContent === 'head'
    )
    expect(content, 'the scroll content').not.equals(undefined)
    const paddingBottom = parseFloat(getComputedStyle(content!).paddingBottom)
    // A phone's capsule needs its full clearance: the inset alone, which is
    // all an Android phone's navigation leaves, put Record video under it.
    expect(clearance).greaterThan(0)
    expect(expected).equals(clearance)
    expect(paddingBottom).equals(expected)
  })

  it('lets the list run its full length again once the phone is upright after being held sideways', async function () {
    // The streaming screen turns an Android phone sideways under the game, and
    // back. The column's cap while sideways must not outlive it: upright the
    // list does not scroll, so a cap cut off the cameras' upload rows and
    // Record video below it, with nothing able to reach them.
    // The column's scroller: the outermost element holding the list and not
    // the picture.
    const list = (host: HTMLElement): HTMLElement => {
      const column = [...host.querySelectorAll('div')].find(element => {
        const text = element.textContent ?? ''
        return text.endsWith('highlightsfooter') && !text.includes('player')
      })
      expect(column, 'the list').not.equals(undefined)
      return column!
    }
    const host = await render(true, true)
    const capped = parseFloat(getComputedStyle(list(host)).maxHeight)
    expect(capped).lessThanOrEqual(390)
    await render(false, false, host)
    const upright = getComputedStyle(list(host)).maxHeight
    expect(
      upright === '' || upright === 'none' || parseFloat(upright) > 844 * 100,
      `max-height ${upright}`
    ).equals(true)
  })
})
