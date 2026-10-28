import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { StatisticsTable } from './StatisticsTable'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}

const buttons = (): string[] =>
  [...document.querySelectorAll('[role="button"]')].map(
    node => node.getAttribute('aria-label') ?? ''
  )

describe('a season’s statistics table', function () {
  it('opens a player from their name, and gives a withdrawn line nothing to open', async function () {
    interface Row {
      userId: string | null
      shortName?: string
      h: number
    }
    const opened: Array<string | null> = []
    const rows: Row[] = [
      { userId: 'usr_betts', shortName: 'Mookie B', h: 2 },
      { userId: null, shortName: 'RFlcns A', h: 1 },
      { userId: null, shortName: 'RFlcns A', h: 3 }
    ]
    const host = await mount(
      <StatisticsTable
        rows={rows}
        columns={[{ label: 'H', value: row => String(row.h) }]}
        onOpen={row => opened.push(row.userId)}
      />
    )
    expect(host.textContent).includes('RFlcns A')
    expect(buttons()).deep.equals(['Open Mookie B'])
    await act(async () => {
      document
        .querySelector<HTMLElement>('[aria-label="Open Mookie B"]')!
        .click()
    })
    expect(opened).deep.equals(['usr_betts'])
  })

  it('opens nobody without a handler', async function () {
    await mount(
      <StatisticsTable
        rows={[{ userId: 'usr_betts', shortName: 'Mookie B' }]}
        columns={[]}
      />
    )
    expect(buttons()).deep.equals([])
  })
})
