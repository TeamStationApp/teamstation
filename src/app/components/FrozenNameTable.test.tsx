import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { Text } from 'react-native'

import { render, unmount, windowSize } from '../../test/tessTestKit'
import type { StatColumn } from '../screens/statColumns'
import { FrozenNameTable, scaledSize } from './FrozenNameTable'
import { StatisticsTable } from './StatisticsTable'
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

  it('gives a compact table’s spare width to the names and sets its figures close, under a rule', async () => {
    await render(
      <FrozenNameTable
        compact
        nameWidth={6.5}
        rows={rows}
        columns={[
          { label: 'R', value: row => String(row.runs) },
          { label: 'H', value: () => '7' }
        ]}
        rowKey={row => row.name}
        name={row => <Text>{row.name}</Text>}
      />
    )
    const names = document.querySelector<HTMLElement>(
      '[data-testid="frozen-names"]'
    )!
    const figures = document.querySelector<HTMLElement>(
      '[data-testid="frozen-figures"]'
    )!
    expect(getComputedStyle(names).flexGrow).equals('1')
    expect(getComputedStyle(names).flexShrink).equals('0')
    expect(names.style.width).equals('')
    expect(getComputedStyle(figures).flexGrow).equals('0')
    expect(getComputedStyle(figures).flexShrink).equals('1')
    const head = figures.querySelector<HTMLElement>('div > div > div')
    const cell = (label: string): HTMLElement =>
      [...figures.querySelectorAll<HTMLElement>('*')].find(
        node => node.textContent === label && node.childElementCount === 0
      )!
    expect(getComputedStyle(cell('R')).paddingLeft).equals('0px')
    expect(getComputedStyle(cell('H')).paddingLeft).not.equals('0px')
    expect(head).not.equals(null)
    expect(getComputedStyle(cell('H').parentElement!).borderBottomWidth).equals(
      '1px'
    )
  })

  it('holds a compact table’s columns to the width it is given', async () => {
    await render(
      <FrozenNameTable
        compact
        namesGrow={false}
        nameMaxWidth={10}
        columnWidth={2}
        rows={rows}
        columns={[{ label: 'R', value: row => String(row.runs) }]}
        rowKey={row => row.name}
        name={row => <Text>{row.name}</Text>}
      />
    )
    const cell = [...document.querySelectorAll<HTMLElement>('*')].find(
      node => node.textContent === 'R' && node.childElementCount === 0
    )!
    expect(getComputedStyle(cell).paddingLeft).equals('0px')
    expect(parseFloat(getComputedStyle(cell).width)).greaterThan(20)
    // Beside its figures, not across the pane from them, with the floor for
    // the name's text clear of the row's padding.
    const names = document.querySelector<HTMLElement>(
      '[data-testid="frozen-names"]'
    )!
    expect(getComputedStyle(names).flexGrow).equals('0')
    expect(getComputedStyle(names).flexBasis).not.equals('116px')
    expect(getComputedStyle(names).minWidth).equals('116px')
    expect(getComputedStyle(names).maxWidth).equals('160px')
  })

  it('grows a row with the reader’s text, and never shrinks it', () => {
    expect(scaledSize(2, 2)).equals(4)
    expect(scaledSize(3.5, 1)).equals(3.5)
    expect(scaledSize(2, 0.8)).equals(2)
  })

  it('makes a statistics table’s name a button only when it opens someone', async () => {
    const opened: string[] = []
    await render(
      <StatisticsTable
        rows={[{ userId: 'usr_1', shortName: 'Alex L' }, { userId: 'usr_2' }]}
        columns={[{ label: 'G', value: () => '1' }]}
        onOpen={row => opened.push(row.userId)}
      />
    )
    document
      .querySelector<HTMLElement>('[role="button"][aria-label="Open Alex L"]')!
      .click()
    expect(opened).deep.equals(['usr_1'])
    expect(document.querySelector('[aria-label="Open Unknown"]')).not.equals(
      null
    )
  })

  it('tells a screen reader whose figure it is and what it counts', async () => {
    await render(
      <FrozenNameTable
        rows={rows}
        columns={[{ label: 'R', value: row => String(row.runs) }]}
        rowKey={row => row.name}
        rowLabel={row => row.name}
        name={row => <Text>{row.name}</Text>}
        total={{
          row: { name: 'Total', runs: 55 },
          name: <Text>Total</Text>,
          label: 'Total'
        }}
      />
    )
    const labelled = [...document.querySelectorAll('[aria-label]')].map(node =>
      node.getAttribute('aria-label')
    )
    expect(labelled).includes('Demo Hawks, R, 31')
    expect(labelled).includes('Total, R, 55')
  })
})
