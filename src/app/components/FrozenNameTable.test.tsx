import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { Text } from 'react-native'

import { render, unmount, windowSize } from '../../test/tessTestKit'
import { FrozenNameTable } from './FrozenNameTable'
import { type PaneFrame, PaneFrameContext } from './useBreakpoint'

interface Row {
  name: string
  runs: number
}
const rows: Row[] = [
  { name: 'Demo Hawks', runs: 31 },
  { name: 'Demo Eagles', runs: 24 }
]

/** The frozen names column's width, in points. */
async function namesWidth(frame?: PaneFrame): Promise<number> {
  const table = (
    <FrozenNameTable
      rows={rows}
      columns={[{ label: 'R', value: row => String(row.runs) }]}
      rowKey={row => row.name}
      name={row => <Text>{row.name}</Text>}
    />
  )
  await render(
    frame == null ? (
      table
    ) : (
      <PaneFrameContext.Provider value={frame}>
        {table}
      </PaneFrameContext.Provider>
    )
  )
  const heading = [...document.querySelectorAll('div')].find(
    node => node.textContent === 'Team' && node.childElementCount === 0
  )
  const column = heading?.parentElement?.parentElement
  if (column == null) throw new Error('No names column')
  return Number.parseFloat(column.style.width)
}

describe('the frozen names column', () => {
  let restore: (() => Promise<void>) | undefined
  afterEach(async () => {
    await unmount()
    await restore?.()
    restore = undefined
  })

  it('is narrow below 600 and wide above it, by the window with no frame', async () => {
    restore = (await windowSize(599)).restore
    const narrow = await namesWidth()
    await unmount()
    await windowSize(600)
    const wide = await namesWidth()
    expect(wide / narrow).equals(1.5)
  })

  it("follows the pane's width, not the window's, beside Tess", async () => {
    restore = (await windowSize(1280)).restore
    const wide = await namesWidth()
    await unmount()
    const narrow = await namesWidth({ x: 400, y: 0, width: 599, height: 900 })
    await unmount()
    expect(wide / narrow).equals(1.5)
    expect(await namesWidth({ x: 400, y: 0, width: 880, height: 900 })).equals(
      wide
    )
  })
})
