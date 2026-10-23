import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { Text } from 'react-native'

import { render, rerender, unmount, windowSize } from '../../test/tessTestKit'
import {
  TESS_COLUMN_WIDTH,
  tessIsWide,
  usePaneAtLeast,
  useTessWide
} from './tessLayout'

describe("Tess's layout", function () {
  let restore: (() => Promise<void>) | undefined
  afterEach(async () => {
    await unmount()
    await restore?.()
    restore = undefined
  })

  it('is a column beside the app above a portrait tablet, 400 points wide', function () {
    expect([1024, 1025].map(tessIsWide)).deep.equals([false, true])
    expect(TESS_COLUMN_WIDTH).equals(400)
  })

  it('redraws the Shell only when the window crosses 1024, not as it is dragged', async function () {
    restore = (await windowSize(1280)).restore
    let renders = 0
    function Shell(): React.ReactElement {
      renders += 1
      return <Text testID="wide">{String(useTessWide())}</Text>
    }
    await render(<Shell />)
    const wide = (): string =>
      document.querySelector('[data-testid="wide"]')?.textContent ?? ''
    expect(wide()).equals('true')
    const drawn = renders
    for (const width of [1279, 1200, 1100, 1025]) await windowSize(width)
    expect(renders).equals(drawn)
    await windowSize(1024)
    expect(wide()).equals('false')
    expect(renders).equals(drawn + 1)
    for (const width of [1000, 800, 390]) await windowSize(width)
    expect(renders).equals(drawn + 1)
    await windowSize(1300)
    expect(wide()).equals('true')
  })

  it('says whether the pane beside her column is wide enough, redrawing only when that changes', async function () {
    restore = (await windowSize(1280)).restore
    let renders = 0
    function Shell(props: { column: boolean }): React.ReactElement {
      renders += 1
      return (
        <Text testID="room">{String(usePaneAtLeast(960, props.column))}</Text>
      )
    }
    const room = (): string =>
      document.querySelector('[data-testid="room"]')?.textContent ?? ''
    // The whole window, then 1280 less her 400-point column.
    await render(<Shell column={false} />)
    expect(room()).equals('true')
    await rerender(<Shell column />)
    expect(room()).equals('false')
    const drawn = renders
    await windowSize(1300)
    expect(renders).equals(drawn)
    await windowSize(1400)
    expect(room()).equals('true')
    expect(renders).equals(drawn + 1)
  })
})
