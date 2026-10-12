import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { watchLayout } from '../layout/watch'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameWatchLayout } from './GameWatchLayout.native'

let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(
  short: boolean,
  sideBySide: boolean
): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
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
})
