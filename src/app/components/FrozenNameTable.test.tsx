import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { Text } from 'react-native'

import { render, unmount, windowSize } from '../../test/tessTestKit'
import type { StatColumn } from '../screens/statColumns'
import { FrozenNameTable } from './FrozenNameTable'
import { type PaneFrame, PaneFrameProvider } from './useBreakpoint'

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
      <PaneFrameProvider frame={frame}>{table}</PaneFrameProvider>
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

describe('the frozen names column, with a total', () => {
  afterEach(async () => {
    await unmount()
  })

  const runs: StatColumn<Row> = { label: 'R', value: row => String(row.runs) }

  async function table(
    props: Partial<React.ComponentProps<typeof FrozenNameTable<Row>>> = {}
  ): Promise<{ names: HTMLElement[]; figures: HTMLElement[] }> {
    await render(
      <FrozenNameTable
        rows={rows}
        columns={[runs]}
        rowKey={row => row.name}
        name={row => <Text>{row.name}</Text>}
        {...props}
      />
    )
    const names = document.querySelector<HTMLElement>(
      '[data-testid="frozen-names"]'
    )!
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="frozen-figures"]'
    )!
    return {
      names: [...names.children] as HTMLElement[],
      figures: [
        ...scroller.firstElementChild!.firstElementChild!.children
      ] as HTMLElement[]
    }
  }

  it('draws the total last in both halves, its figures bold', async () => {
    const { names, figures } = await table({
      total: { row: { name: 'Total', runs: 55 }, name: <Text>Total</Text> }
    })
    expect(names.map(row => row.textContent)).deep.equals([
      'Team',
      'Demo Hawks',
      'Demo Eagles',
      'Total'
    ])
    expect(figures.map(row => row.textContent)).deep.equals([
      'R',
      '31',
      '24',
      '55'
    ])
    const weight = (row: HTMLElement): string =>
      getComputedStyle(row.firstElementChild!).fontWeight
    expect(weight(figures[3])).equals('700')
    expect(weight(figures[1])).not.equals('700')
    expect(getComputedStyle(names[3]).borderTopWidth).equals('1px')
  })

  it('makes a strong column bold in every row', async () => {
    const { figures } = await table({ columns: [{ ...runs, strong: true }] })
    expect(getComputedStyle(figures[1].firstElementChild!).fontWeight).equals(
      '700'
    )
  })

  it('measures the columns with the total, so a large total fits', async () => {
    const width = async (total?: Row): Promise<number> => {
      const { figures } = await table(
        total == null ? {} : { total: { row: total, name: <Text>Total</Text> } }
      )
      const measured = Number.parseFloat(
        (figures[0].firstElementChild as HTMLElement).style.width
      )
      await unmount()
      return measured
    }
    expect(await width({ name: 'Total', runs: 1234567 })).greaterThan(
      await width()
    )
  })

  it('takes a names width, a row height and the colours it is given', async () => {
    const { names, figures } = await table({
      nameWidth: 6.5,
      rowHeight: 2,
      headBackground: '#FFFFFF',
      nameBackground: '#F5F7F1'
    })
    const column = names[0].parentElement!
    expect(Number.parseFloat(column.style.width)).equals(6.5 * 16)
    for (const row of [...names, ...figures])
      expect(getComputedStyle(row).height).equals('32px')
    expect(getComputedStyle(names[0]).backgroundColor).equals(
      'rgb(255, 255, 255)'
    )
    expect(getComputedStyle(figures[0]).backgroundColor).equals(
      'rgb(255, 255, 255)'
    )
    expect(getComputedStyle(names[1]).backgroundColor).equals(
      'rgb(245, 247, 241)'
    )
  })

  it('hands the row key its index, for rows that share an id', async () => {
    const seen: number[] = []
    await table({
      rows: [
        { name: 'Same', runs: 1 },
        { name: 'Same', runs: 2 }
      ],
      rowKey: (row, index) => {
        seen.push(index)
        return `${row.name}-${index}`
      }
    })
    expect(seen).includes(0).and.includes(1)
    expect(
      [...document.querySelectorAll('div')].filter(
        node => node.textContent === 'Same' && node.childElementCount === 0
      )
    ).length(2)
  })
})
